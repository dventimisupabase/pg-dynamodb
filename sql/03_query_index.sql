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
