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
