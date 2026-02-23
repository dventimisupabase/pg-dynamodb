-- =============================================================================
-- 00_config: pg_http extension + config table
-- =============================================================================

-- Enable pg_http extension for making HTTP requests from SQL
CREATE EXTENSION IF NOT EXISTS http;

-- Configuration table for the DynamoDB bridge
CREATE TABLE IF NOT EXISTS dynamodb_bridge_config (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- Seed with the edge function URL (update this for your deployment)
INSERT INTO dynamodb_bridge_config VALUES
  ('edge_function_url', 'https://<project-ref>.supabase.co/functions/v1/dynamodb-bridge')
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
-- 01_http_helper: _dynamodb_http_post() shared helper
-- =============================================================================

-- Shared helper: POST a JSON body to the DynamoDB bridge Edge Function.
-- Reads the URL from config, attaches the caller's JWT, and raises exceptions on errors.
CREATE OR REPLACE FUNCTION _dynamodb_http_post(body jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  url      text;
  response http_response;
  result   jsonb;
BEGIN
  SELECT value INTO url FROM dynamodb_bridge_config WHERE key = 'edge_function_url';

  response := http((
    'POST',
    url,
    ARRAY[
      http_header('Authorization', 'Bearer ' || current_setting('request.jwt.claim', true)),
      http_header('Content-Type', 'application/json')
    ],
    'application/json',
    body::text
  )::http_request);

  result := response.content::jsonb;

  -- Propagate structured errors as PostgreSQL exceptions
  IF (result->>'error')::boolean THEN
    RAISE EXCEPTION 'DynamoDB bridge error [%] from %: %',
      result->>'code',
      result->>'source',
      result->>'message'
      USING ERRCODE = 'FDW01';
  END IF;

  RETURN result;
END;
$$;

-- =============================================================================
-- 02_get_item: dynamodb_get_item() primitive
-- =============================================================================

-- Primitive: maps to DynamoDB GetItem.
-- Returns zero or one row with the unmarshalled item.
CREATE OR REPLACE FUNCTION dynamodb_get_item(
  p_table_name  text,
  p_pk_value    text,
  p_sk_value    text
)
RETURNS TABLE (item jsonb, next_token text)
LANGUAGE plpgsql STABLE COST 10000 ROWS 1 AS $$
DECLARE
  result jsonb;
BEGIN
  result := _dynamodb_http_post(jsonb_build_object(
    'operation', 'GetItem',
    'payload', jsonb_build_object(
      'TableName', p_table_name,
      'Key', jsonb_build_object('pk', p_pk_value, 'sk', p_sk_value)
    )
  ));

  RETURN QUERY
  SELECT value, NULL::text
  FROM jsonb_array_elements(result->'items');
END;
$$;

-- =============================================================================
-- 03_query_index: dynamodb_query_index() primitive
-- =============================================================================

-- Primitive: maps to DynamoDB Query.
-- Returns items from the specified index matching the partition key,
-- with optional sort key condition and pagination token.
CREATE OR REPLACE FUNCTION dynamodb_query_index(
  p_table_name          text,
  p_index_name          text,
  p_pk_value            text,
  p_sk_condition        jsonb DEFAULT NULL,
  p_continuation_token  text DEFAULT NULL
)
RETURNS TABLE (item jsonb, next_token text)
LANGUAGE plpgsql STABLE COST 10000 ROWS 100 AS $$
DECLARE
  result      jsonb;
  page_token  text;
BEGIN
  result := _dynamodb_http_post(jsonb_build_object(
    'operation', 'Query',
    'payload', jsonb_build_object(
      'TableName',              p_table_name,
      'IndexName',              p_index_name,
      'KeyConditionExpression', 'pk = :pk',
      'ExpressionAttributeValues', jsonb_build_object(':pk', p_pk_value),
      'FilterExpression',       p_sk_condition,
      'ExclusiveStartKey',      p_continuation_token
    )
  ));

  page_token := result->>'next_token';

  RETURN QUERY
  SELECT value, page_token
  FROM jsonb_array_elements(result->'items');
END;
$$;

-- =============================================================================
-- 04_scan: dynamodb_scan() primitive
-- =============================================================================

-- Primitive: maps to DynamoDB Scan.
-- All parameters except continuation_token are required to force intentionality.
-- Carries COST 50000 to strongly discourage the planner from preferring it in joined queries.
CREATE OR REPLACE FUNCTION dynamodb_scan(
  p_table_name          text,
  p_filter_expression   text,        -- no default: intentionally required
  p_expression_attrs    jsonb,       -- no default: intentionally required
  p_limit               int,         -- no default: intentionally required
  p_continuation_token  text DEFAULT NULL
)
RETURNS TABLE (item jsonb, next_token text)
LANGUAGE plpgsql STABLE COST 50000 ROWS 100 AS $$
DECLARE
  result      jsonb;
  page_token  text;
BEGIN
  result := _dynamodb_http_post(jsonb_build_object(
    'operation', 'Scan',
    'payload', jsonb_build_object(
      'TableName',             p_table_name,
      'FilterExpression',      p_filter_expression,
      'ExpressionAttributeValues', p_expression_attrs,
      'Limit',                 p_limit,
      'ExclusiveStartKey',     p_continuation_token
    )
  ));

  page_token := result->>'next_token';

  RETURN QUERY
  SELECT value, page_token
  FROM jsonb_array_elements(result->'items');
END;
$$;

-- =============================================================================
-- 05_query_all: dynamodb_query_all() ergonomic wrapper
-- =============================================================================

-- Ergonomic wrapper: paginating query that loops until all pages are fetched
-- or max_pages is reached. Emits NOTICE diagnostics and WARNING on truncation.
CREATE OR REPLACE FUNCTION dynamodb_query_all(
  p_table_name    text,
  p_index_name    text,
  p_pk_value      text,
  p_sk_condition  jsonb DEFAULT NULL,
  p_max_pages     int   DEFAULT 10
)
RETURNS TABLE (item jsonb)
LANGUAGE plpgsql STABLE COST 100000 AS $$
DECLARE
  v_token       text        := NULL;
  v_page        int         := 0;
  v_row_count   int         := 0;
  v_start       timestamptz := clock_timestamp();
  r             record;
BEGIN
  LOOP
    FOR r IN
      SELECT q.item, q.next_token
      FROM dynamodb_query_index(p_table_name, p_index_name, p_pk_value, p_sk_condition, v_token) q
    LOOP
      item := r.item;
      RETURN NEXT;
      v_row_count := v_row_count + 1;
      v_token     := r.next_token;
    END LOOP;

    v_page := v_page + 1;

    EXIT WHEN v_token IS NULL;

    IF v_page >= p_max_pages THEN
      RAISE WARNING 'dynamodb_query_all: max_pages (%) reached, result set is truncated. table=%, index=%, pk=%',
        p_max_pages, p_table_name, p_index_name, p_pk_value;
      EXIT;
    END IF;
  END LOOP;

  RAISE NOTICE 'dynamodb_query_all: pages=%, rows=%, elapsed=%ms, table=%, index=%, pk=%',
    v_page,
    v_row_count,
    round(extract(epoch from (clock_timestamp() - v_start)) * 1000),
    p_table_name,
    p_index_name,
    p_pk_value;
END;
$$;

-- =============================================================================
-- 06_scan_all: dynamodb_scan_all() ergonomic wrapper
-- =============================================================================

-- Ergonomic wrapper: paginating scan that loops until all pages are fetched
-- or max_pages is reached. Emits NOTICE diagnostics and WARNING on truncation.
-- All parameters except max_pages remain non-defaulted to preserve intentionality.
CREATE OR REPLACE FUNCTION dynamodb_scan_all(
  p_table_name          text,
  p_filter_expression   text,        -- no default: intentionally required
  p_expression_attrs    jsonb,       -- no default: intentionally required
  p_limit               int,         -- no default: intentionally required
  p_max_pages           int DEFAULT 10
)
RETURNS TABLE (item jsonb)
LANGUAGE plpgsql STABLE COST 100000 AS $$
DECLARE
  v_token       text        := NULL;
  v_page        int         := 0;
  v_row_count   int         := 0;
  v_start       timestamptz := clock_timestamp();
  r             record;
BEGIN
  LOOP
    FOR r IN
      SELECT s.item, s.next_token
      FROM dynamodb_scan(p_table_name, p_filter_expression, p_expression_attrs, p_limit, v_token) s
    LOOP
      item := r.item;
      RETURN NEXT;
      v_row_count := v_row_count + 1;
      v_token     := r.next_token;
    END LOOP;

    v_page := v_page + 1;

    EXIT WHEN v_token IS NULL;

    IF v_page >= p_max_pages THEN
      RAISE WARNING 'dynamodb_scan_all: max_pages (%) reached, result set is truncated. table=%, filter=%',
        p_max_pages, p_table_name, p_filter_expression;
      EXIT;
    END IF;
  END LOOP;

  RAISE NOTICE 'dynamodb_scan_all: pages=%, rows=%, elapsed=%ms, table=%, filter=%',
    v_page,
    v_row_count,
    round(extract(epoch from (clock_timestamp() - v_start)) * 1000),
    p_table_name,
    p_filter_expression;
END;
$$;
