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
- **Testing**: `Deno.test` with `@std/assert` (Edge Function); pgTAP via `supabase test db` (SQL)
- **Tooling**: mise (deno version management)

## Project Structure

```
supabase/
  config.toml                     # Supabase CLI configuration
  migrations/
    <timestamp>_dynamodb_bridge.sql  # All PL/pgSQL objects in one migration
  tests/
    database/
      00_schema.test.sql            # pgTAP: extension, config table, seed data
      01_functions.test.sql         # pgTAP: function signatures and properties
  functions/
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
# Run Edge Function tests
deno test supabase/functions/tests/*-test.ts

# Or via task
deno task test

# Run SQL tests (pgTAP, requires local Supabase)
supabase test db
```

## Conventions

- **SQL migrations**: Timestamped files in `supabase/migrations/`, managed by the Supabase CLI
- **SQL primitives** return `TABLE (item jsonb, next_token text)`, marked `STABLE` with cost hints
- **SQL wrappers** (e.g. `dynamodb_query_all`) loop with `max_pages` and emit `RAISE NOTICE/WARNING` diagnostics
- **Edge Function tests** live in `supabase/functions/tests/*-test.ts` (Deno)
- **SQL tests** live in `supabase/tests/database/*.test.sql` (pgTAP)
- **Edge Function** uses dependency injection (`envGet`, `fetchFn`) for testability
- **Errors** use PostgreSQL SQLSTATE `FDW01` and structured JSON with `source` attribution (`dynamodb`, `edge_function`, `network`)

## Key Design Decisions

- **JWT verification**: Manual HS256 via `crypto.subtle` (no library dependency)
- **next_token**: Base64-encoded `LastEvaluatedKey` for opaque pagination
- **Timeout boundaries**: DynamoDB 5s < Edge Function 10s < pg_http 15s (innermost fails first)
- **No external deps**: All crypto is `crypto.subtle`; only test dependency is `@std/assert`
