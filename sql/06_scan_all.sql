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
