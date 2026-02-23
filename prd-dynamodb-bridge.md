# PRD: PostgreSQL-to-DynamoDB Bridge via Supabase Edge Functions

## Overview

A general-purpose bridge allowing Supabase customers to query Amazon DynamoDB tables using idiomatic SQL. The bridge consists of a thin authentication proxy implemented as a Supabase Edge Function, a family of PL/pgSQL primitive functions using `pg_http`, and ergonomic PL/pgSQL wrapper functions for common access patterns.

Writes (PutItem, UpdateItem, DeleteItem) are explicitly out of scope for this version.

---

## Architecture

```
PL/pgSQL wrapper functions (ergonomic layer)
    → PL/pgSQL primitive functions (pg_http)
        → Supabase Edge Function (SigV4 auth, type unmarshalling, error normalization)
            → Amazon DynamoDB API
```

---

## Components

### 1. Supabase Edge Function (Auth Proxy)

**Responsibilities**
- Verify the caller's Supabase JWT before proxying any request to DynamoDB
- Construct and sign AWS Signature V4 requests using `crypto.subtle` (Web Crypto API, no external dependencies)
- Fully unmarshal DynamoDB's typed response format (`{"S": "hello"}`, `{"N": "42"}`, etc.) into plain JSON for maximum convenience to SQL consumers
- Normalize all errors — DynamoDB errors, timeout errors, credential errors — into a consistent structured JSON error format
- Return paginated results including a `next_token` when DynamoDB's `LastEvaluatedKey` is present

**AWS credentials** stored as Edge Function secrets, never in database configuration.

**Timeout configuration** via Edge Function environment variables with the following recommended defaults:

| Boundary | Default | Notes |
|---|---|---|
| DynamoDB call | 5s | Innermost, fails first |
| Edge Function execution | 10s | Wraps DynamoDB timeout |
| pg_http request timeout | 15s | Outermost, largest margin |

Timeouts are nested in descending order so the innermost layer fails first and propagates a clean error outward rather than causing an outer timeout with no structured error payload. All timeout values are configurable via environment variables and can be adjusted per deployment without redeployment of the database layer.

**Error response format**

```json
{
  "error": true,
  "code": "THROUGHPUT_EXCEEDED",
  "message": "ProvisionedThroughputExceededException from DynamoDB",
  "source": "dynamodb"
}
```

`source` is one of `dynamodb`, `edge_function`, or `network`.

---

### 2. PL/pgSQL Primitive Functions

Three primitives mapping directly onto DynamoDB's API surface. All return `(item jsonb, next_token text)` — `next_token` is NULL on the final page, identical across all rows within a single page.

```sql
-- Maps to DynamoDB GetItem
dynamodb_get_item(
  table_name   text,
  pk_value     text,
  sk_value     text
) RETURNS TABLE (item jsonb, next_token text)

-- Maps to DynamoDB Query
dynamodb_query_index(
  table_name          text,
  index_name          text,
  pk_value            text,
  sk_condition        jsonb DEFAULT NULL,
  continuation_token  text DEFAULT NULL
) RETURNS TABLE (item jsonb, next_token text)

-- Maps to DynamoDB Scan (use sparingly)
dynamodb_scan(
  table_name          text,
  filter_expression   text,   -- required, no default, forces intentionality
  expression_attrs    jsonb,  -- required, no default, forces intentionality
  limit               int,    -- required, no default, forces intentionality
  continuation_token  text DEFAULT NULL
) RETURNS TABLE (item jsonb, next_token text)
```

All three are declared `STABLE COST 10000` with realistic `ROWS` hints to inform the planner when results are joined against local tables. `dynamodb_scan` carries `COST 50000` to strongly discourage the planner from preferring it in joined queries.

Errors from the Edge Function are inspected by the primitive and re-raised as PostgreSQL exceptions with a meaningful `SQLSTATE` and message, rather than returned as data rows.

---

### 3. PL/pgSQL Wrapper Functions (Ergonomic Layer)

Safe, paginating wrappers over the primitives for common access patterns. These are the recommended default calling convention for application code.

**Design**
- Explicit loop driving pagination internally
- `max_pages` parameter with a default of 10 as a mandatory safety bailout
- `RAISE NOTICE` emitted on completion with: page count fetched, total rows returned, total elapsed time
- `RAISE WARNING` emitted — and partial results returned — when `max_pages` is hit before pagination exhausts, so callers are never silently handed a truncated result set

Example signature:

```sql
dynamodb_query_all(
  table_name     text,
  index_name     text,
  pk_value       text,
  sk_condition   jsonb DEFAULT NULL,
  max_pages      int   DEFAULT 10
) RETURNS TABLE (item jsonb)
```

---

## Calling Conventions

Two supported conventions, both documented:

**Default — use the ergonomic wrapper:**
```sql
SELECT item FROM dynamodb_query_all('users', 'status-index', 'ACTIVE');
```

**Power user — drive pagination manually via primitive, including recursive CTE:**
```sql
WITH RECURSIVE pages AS (
  SELECT item, next_token, 1 AS page_num
  FROM dynamodb_query_index('users', 'status-index', 'ACTIVE')
  UNION ALL
  SELECT d.item, d.next_token, p.page_num + 1
  FROM pages p,
  LATERAL dynamodb_query_index('users', 'status-index', 'ACTIVE', NULL, p.next_token) d
  WHERE p.next_token IS NOT NULL AND p.page_num < 10
)
SELECT item FROM pages;
```

---

## Observability

- Edge Function logs capture DynamoDB request/response timing and error details
- PL/pgSQL wrappers emit `RAISE NOTICE` with page count, row count, and elapsed time on every call
- `RAISE WARNING` on truncation distinguishes "complete result" from "stopped at max_pages"

---

## Security

- All requests to the Edge Function must carry a valid Supabase JWT
- AWS credentials are stored exclusively as Edge Function secrets
- No row-level filtering based on caller identity (v1)
- IAM policy for the AWS credentials should be scoped to the minimum necessary permissions: `dynamodb:GetItem`, `dynamodb:Query`, `dynamodb:Scan`

---

## Out of Scope (v1)

- Write operations (PutItem, UpdateItem, DeleteItem, BatchWriteItem)
- Row-level filtering based on caller identity
- Predicate pushdown (acknowledged limitation; callers encode access patterns in function parameters)
- DynamoDB Streams or change data capture
