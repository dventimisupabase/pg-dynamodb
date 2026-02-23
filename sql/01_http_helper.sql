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
