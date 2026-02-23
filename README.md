# pg-dynamodb

Query DynamoDB tables from SQL in Supabase.

```
SQL wrappers → PL/pgSQL primitives (pg_http) → Deno Edge Function (SigV4 + unmarshal) → DynamoDB
```

## What

A read-only PostgreSQL-to-DynamoDB bridge for Supabase. It supports **GetItem**, **Query**, and **Scan** operations, letting you access DynamoDB data without leaving SQL. The bridge handles JWT authentication, AWS SigV4 signing, DynamoDB type unmarshalling, pagination, and error normalization — so callers just write SQL.

## Why

Supabase customers sometimes need to read data that lives in DynamoDB. Rather than building custom integration code in every application, this bridge moves that complexity into the database layer: a Deno Edge Function handles AWS auth and marshalling, PL/pgSQL primitives call it via `pg_http`, and ergonomic SQL wrappers add pagination and diagnostics on top.

## How

**1. Apply the SQL migrations** in `sql/` (numbered `00` through `06`) to your Supabase database. These create a config table, an HTTP helper, three DynamoDB primitives (`dynamodb_get_item`, `dynamodb_query_index`, `dynamodb_scan`), and two convenience wrappers (`dynamodb_query_all`, `dynamodb_scan_all`).

**2. Deploy the Edge Function** from `supabase/functions/dynamodb-bridge/`. It receives requests from `pg_http`, signs them with SigV4, calls DynamoDB, unmarshals the response, and returns plain JSON.

**3. Query from SQL:**

```sql
SELECT * FROM dynamodb_query_all(
  'my-table',
  'my-index',
  'pk_field = :pk',
  '{"pk_field": {"S": "some-value"}}'
);
```

## Development

```sh
deno task test
```

See [prd-dynamodb-bridge.md](prd-dynamodb-bridge.md) and [tech-spec-dynamodb-bridge.md](tech-spec-dynamodb-bridge.md) for full details.
