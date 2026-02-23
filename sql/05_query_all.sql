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
