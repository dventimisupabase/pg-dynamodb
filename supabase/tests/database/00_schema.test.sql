-- Test: DynamoDB bridge schema objects (extension, config table, seed data)
begin;
select plan(7);

-- ---------------------------------------------------------------------------
-- Extension
-- ---------------------------------------------------------------------------

select has_extension('http', 'pg_http extension should be installed');

-- ---------------------------------------------------------------------------
-- Config table
-- ---------------------------------------------------------------------------

select has_table('public', 'dynamodb_bridge_config', 'config table should exist');

select has_column('public', 'dynamodb_bridge_config', 'key',
  'config table should have a key column');

select col_type_is('public', 'dynamodb_bridge_config', 'key', 'text',
  'key column should be text');

select has_column('public', 'dynamodb_bridge_config', 'value',
  'config table should have a value column');

select col_type_is('public', 'dynamodb_bridge_config', 'value', 'text',
  'value column should be text');

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------

select is(
  (select value from dynamodb_bridge_config where key = 'edge_function_url'),
  'https://<project-ref>.supabase.co/functions/v1/dynamodb-bridge',
  'default edge_function_url should be seeded'
);

select * from finish();
rollback;
