-- Test: DynamoDB bridge function signatures and properties
begin;
select plan(30);

-- ===========================================================================
-- _dynamodb_http_post(jsonb)
-- ===========================================================================

select has_function('public', '_dynamodb_http_post', ARRAY['jsonb'],
  '_dynamodb_http_post should exist');

select function_lang_is('public', '_dynamodb_http_post', ARRAY['jsonb'],
  'plpgsql', '_dynamodb_http_post should be plpgsql');

select function_returns('public', '_dynamodb_http_post', ARRAY['jsonb'],
  'jsonb', '_dynamodb_http_post should return jsonb');

select volatility_is('public', '_dynamodb_http_post', ARRAY['jsonb'],
  'stable', '_dynamodb_http_post should be STABLE');

select is_definer('public', '_dynamodb_http_post', ARRAY['jsonb'],
  '_dynamodb_http_post should be SECURITY DEFINER');

-- ===========================================================================
-- dynamodb_get_item(text, text, text)
-- ===========================================================================

select has_function('public', 'dynamodb_get_item', ARRAY['text', 'text', 'text'],
  'dynamodb_get_item should exist');

select function_lang_is('public', 'dynamodb_get_item', ARRAY['text', 'text', 'text'],
  'plpgsql', 'dynamodb_get_item should be plpgsql');

select function_returns('public', 'dynamodb_get_item', ARRAY['text', 'text', 'text'],
  'setof record', 'dynamodb_get_item should return setof record');

select volatility_is('public', 'dynamodb_get_item', ARRAY['text', 'text', 'text'],
  'stable', 'dynamodb_get_item should be STABLE');

select isnt_definer('public', 'dynamodb_get_item', ARRAY['text', 'text', 'text'],
  'dynamodb_get_item should not be SECURITY DEFINER');

-- ===========================================================================
-- dynamodb_query_index(text, text, text, jsonb, text)
-- ===========================================================================

select has_function('public', 'dynamodb_query_index',
  ARRAY['text', 'text', 'text', 'jsonb', 'text'],
  'dynamodb_query_index should exist');

select function_lang_is('public', 'dynamodb_query_index',
  ARRAY['text', 'text', 'text', 'jsonb', 'text'],
  'plpgsql', 'dynamodb_query_index should be plpgsql');

select function_returns('public', 'dynamodb_query_index',
  ARRAY['text', 'text', 'text', 'jsonb', 'text'],
  'setof record', 'dynamodb_query_index should return setof record');

select volatility_is('public', 'dynamodb_query_index',
  ARRAY['text', 'text', 'text', 'jsonb', 'text'],
  'stable', 'dynamodb_query_index should be STABLE');

select isnt_definer('public', 'dynamodb_query_index',
  ARRAY['text', 'text', 'text', 'jsonb', 'text'],
  'dynamodb_query_index should not be SECURITY DEFINER');

-- ===========================================================================
-- dynamodb_scan(text, text, jsonb, integer, text)
-- ===========================================================================

select has_function('public', 'dynamodb_scan',
  ARRAY['text', 'text', 'jsonb', 'integer', 'text'],
  'dynamodb_scan should exist');

select function_lang_is('public', 'dynamodb_scan',
  ARRAY['text', 'text', 'jsonb', 'integer', 'text'],
  'plpgsql', 'dynamodb_scan should be plpgsql');

select function_returns('public', 'dynamodb_scan',
  ARRAY['text', 'text', 'jsonb', 'integer', 'text'],
  'setof record', 'dynamodb_scan should return setof record');

select volatility_is('public', 'dynamodb_scan',
  ARRAY['text', 'text', 'jsonb', 'integer', 'text'],
  'stable', 'dynamodb_scan should be STABLE');

select isnt_definer('public', 'dynamodb_scan',
  ARRAY['text', 'text', 'jsonb', 'integer', 'text'],
  'dynamodb_scan should not be SECURITY DEFINER');

-- ===========================================================================
-- dynamodb_query_all(text, text, text, jsonb, integer)
-- ===========================================================================

select has_function('public', 'dynamodb_query_all',
  ARRAY['text', 'text', 'text', 'jsonb', 'integer'],
  'dynamodb_query_all should exist');

select function_lang_is('public', 'dynamodb_query_all',
  ARRAY['text', 'text', 'text', 'jsonb', 'integer'],
  'plpgsql', 'dynamodb_query_all should be plpgsql');

select function_returns('public', 'dynamodb_query_all',
  ARRAY['text', 'text', 'text', 'jsonb', 'integer'],
  'setof record', 'dynamodb_query_all should return setof record');

select volatility_is('public', 'dynamodb_query_all',
  ARRAY['text', 'text', 'text', 'jsonb', 'integer'],
  'stable', 'dynamodb_query_all should be STABLE');

select isnt_definer('public', 'dynamodb_query_all',
  ARRAY['text', 'text', 'text', 'jsonb', 'integer'],
  'dynamodb_query_all should not be SECURITY DEFINER');

-- ===========================================================================
-- dynamodb_scan_all(text, text, jsonb, integer, integer)
-- ===========================================================================

select has_function('public', 'dynamodb_scan_all',
  ARRAY['text', 'text', 'jsonb', 'integer', 'integer'],
  'dynamodb_scan_all should exist');

select function_lang_is('public', 'dynamodb_scan_all',
  ARRAY['text', 'text', 'jsonb', 'integer', 'integer'],
  'plpgsql', 'dynamodb_scan_all should be plpgsql');

select function_returns('public', 'dynamodb_scan_all',
  ARRAY['text', 'text', 'jsonb', 'integer', 'integer'],
  'setof record', 'dynamodb_scan_all should return setof record');

select volatility_is('public', 'dynamodb_scan_all',
  ARRAY['text', 'text', 'jsonb', 'integer', 'integer'],
  'stable', 'dynamodb_scan_all should be STABLE');

select isnt_definer('public', 'dynamodb_scan_all',
  ARRAY['text', 'text', 'jsonb', 'integer', 'integer'],
  'dynamodb_scan_all should not be SECURITY DEFINER');

select * from finish();
rollback;
