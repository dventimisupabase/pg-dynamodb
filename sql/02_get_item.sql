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
