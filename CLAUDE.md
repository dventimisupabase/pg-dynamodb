# pg-dynamodb

PostgreSQL-to-DynamoDB bridge for Supabase. Lets Supabase customers query DynamoDB tables using SQL via a three-layer architecture:

```
SQL wrappers → PL/pgSQL primitives (pg_http) → Deno Edge Function (SigV4 + unmarshal) → DynamoDB
```

Read-only (GetItem, Query, Scan). Writes are out of scope for v1.

## Tech Stack

- **Edge Function**: Deno / TypeScript (Supabase Edge Functions)
- **Database**: PL/pgSQL with `pg_http` extension
- **Crypto**: `crypto.subtle` for SigV4 signing and JWT verification — no external dependencies
- **Testing**: `Deno.test` with `@std/assert`
- **Tooling**: mise (deno version management)

## Project Structure

```
sql/                              # PL/pgSQL migrations (NN_name.sql)
  00_config.sql                   #   pg_http extension + config table
  01_http_helper.sql              #   _dynamodb_http_post() shared helper
  02_get_item.sql                 #   dynamodb_get_item() primitive
  03_query_index.sql              #   dynamodb_query_index() primitive
  04_scan.sql                     #   dynamodb_scan() primitive
  05_query_all.sql                #   dynamodb_query_all() ergonomic wrapper
  06_scan_all.sql                 #   dynamodb_scan_all() ergonomic wrapper
supabase/functions/
  dynamodb-bridge/
    index.ts                      # Request handler (JWT → parse → SigV4 → call → unmarshal)
    types.ts                      # TypeScript types (DynamoDB attributes, requests, responses)
    errors.ts                     # Error normalization with source attribution
    sigv4.ts                      # AWS SigV4 signing (crypto.subtle)
    unmarshal.ts                  # Recursive DynamoDB type unmarshalling
  tests/
    dynamodb-bridge-test.ts       # Integration tests for the handler
    sigv4-test.ts                 # SigV4 signing unit tests
    unmarshal-test.ts             # Unmarshalling unit tests
prd-dynamodb-bridge.md            # Product requirements document
tech-spec-dynamodb-bridge.md      # Technical specification
```

## Development

```sh
# Run all tests
deno test supabase/functions/tests/*-test.ts

# Or via task
deno task test
```

## Conventions

- **SQL migrations**: Named `NN_name.sql` in `sql/`, numbered sequentially
- **SQL primitives** return `TABLE (item jsonb, next_token text)`, marked `STABLE` with cost hints
- **SQL wrappers** (e.g. `dynamodb_query_all`) loop with `max_pages` and emit `RAISE NOTICE/WARNING` diagnostics
- **Tests** live in `supabase/functions/tests/*-test.ts` (Supabase convention)
- **Edge Function** uses dependency injection (`envGet`, `fetchFn`) for testability
- **Errors** use PostgreSQL SQLSTATE `FDW01` and structured JSON with `source` attribution (`dynamodb`, `edge_function`, `network`)

## Key Design Decisions

- **JWT verification**: Manual HS256 via `crypto.subtle` (no library dependency)
- **next_token**: Base64-encoded `LastEvaluatedKey` for opaque pagination
- **Timeout boundaries**: DynamoDB 5s < Edge Function 10s < pg_http 15s (innermost fails first)
- **No external deps**: All crypto is `crypto.subtle`; only test dependency is `@std/assert`
