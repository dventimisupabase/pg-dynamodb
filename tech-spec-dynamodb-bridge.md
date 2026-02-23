# Technical Specification: PostgreSQL-to-DynamoDB Bridge

**Status:** Draft  
**Companion to:** PRD: PostgreSQL-to-DynamoDB Bridge via Supabase Edge Functions

---

## 1. Edge Function

### 1.1 Runtime and Dependencies

- Deno runtime (Supabase Edge Functions standard)
- No external npm or JSR dependencies
- AWS SigV4 signing implemented using `crypto.subtle` (Web Crypto API, available natively in Deno)
- JWT verification using Supabase's built-in `supabaseClient` or manual JWT decode against the project's JWT secret

### 1.2 Environment Variables

| Variable | Description | Required |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | AWS credential | Yes |
| `AWS_SECRET_ACCESS_KEY` | AWS credential | Yes |
| `AWS_REGION` | DynamoDB region (e.g. `us-east-1`) | Yes |
| `DYNAMODB_TIMEOUT_MS` | DynamoDB call timeout in ms | No (default: 5000) |
| `SUPABASE_JWT_SECRET` | For JWT verification | Yes |

The IAM identity associated with the credentials should have the minimum necessary DynamoDB permissions: `dynamodb:GetItem`, `dynamodb:Query`, `dynamodb:Scan`.

### 1.3 Request Interface

The Edge Function accepts a single `POST` endpoint. All DynamoDB operations are distinguished by an `operation` field in the request body, avoiding the need for multiple routes.

**Request headers**

```
Authorization: Bearer <supabase_jwt>
Content-Type: application/json
```

**Request body**

```typescript
{
  operation: "GetItem" | "Query" | "Scan",
  payload: object   // operation-specific parameters, see 1.4
}
```

### 1.4 Operation Payloads

**GetItem**
```json
{
  "TableName": "users",
  "Key": {
    "pk": "USER#123",
    "sk": "PROFILE"
  }
}
```

**Query**
```json
{
  "TableName": "users",
  "IndexName": "status-index",
  "KeyConditionExpression": "pk = :pk",
  "ExpressionAttributeValues": { ":pk": "ACTIVE" },
  "FilterExpression": null,
  "ExclusiveStartKey": null
}
```

**Scan**
```json
{
  "TableName": "users",
  "FilterExpression": "attribute_exists(email)",
  "ExpressionAttributeValues": {},
  "Limit": 100,
  "ExclusiveStartKey": null
}
```

### 1.5 Response Format

**Success**
```json
{
  "items": [ { "id": "123", "name": "Alice", "score": 42 } ],
  "next_token": "<base64-encoded-LastEvaluatedKey or null>"
}
```

`items` is always an array. For GetItem it contains zero or one element. `next_token` is `null` when there are no further pages.

**Error**
```json
{
  "error": true,
  "code": "THROUGHPUT_EXCEEDED",
  "message": "ProvisionedThroughputExceededException: ...",
  "source": "dynamodb"
}
```

HTTP status codes: `200` for success, `400` for caller errors (bad payload, unknown operation), `401` for auth failures, `502` for DynamoDB errors, `504` for timeout.

### 1.6 Type Unmarshalling

DynamoDB's typed attribute format must be fully unmarshalled before the response is returned. The unmarshaller must handle:

| DynamoDB type | JSON output |
|---|---|
| `{"S": "hello"}` | `"hello"` |
| `{"N": "42"}` | `42` (numeric) |
| `{"BOOL": true}` | `true` |
| `{"NULL": true}` | `null` |
| `{"L": [...]}` | `[...]` (recursively unmarshalled) |
| `{"M": {...}}` | `{...}` (recursively unmarshalled) |
| `{"SS": [...]}` | `[...]` (array of strings) |
| `{"NS": [...]}` | `[...]` (array of numbers) |
| `{"B": "..."}` | Base64 string (documented limitation) |
| `{"BS": [...]}` | Array of Base64 strings (documented limitation) |

Binary types (`B`, `BS`) are returned as Base64 strings with no further conversion. This is a known limitation to document for callers.

### 1.7 SigV4 Implementation Notes

The canonical request construction must follow AWS's specification exactly. Key implementation points:

- Hash algorithm: `AWS4-HMAC-SHA256`
- Signed headers must include at minimum: `content-type`, `host`, `x-amz-date`, `x-amz-target`
- `x-amz-target` header values: `DynamoDB_20120810.GetItem`, `DynamoDB_20120810.Query`, `DynamoDB_20120810.Scan`
- Datetime format: ISO8601 basic format (`20240101T120000Z`)
- `crypto.subtle.sign` with `HMAC` algorithm for each signing step

### 1.8 next_token Encoding

`LastEvaluatedKey` from DynamoDB is a JSON object whose keys and values are themselves typed DynamoDB attributes. It must be:

1. JSON-serialized
2. Base64-encoded for safe transport as a string
3. Base64-decoded and JSON-parsed on the way back in before passing to DynamoDB as `ExclusiveStartKey`

The PL/pgSQL layer treats `next_token` as an opaque string and never inspects its contents.

---

## 2. PL/pgSQL Primitive Functions

### 2.1 Shared Infrastructure

**Edge Function URL** stored in a configuration table:

```sql
CREATE TABLE IF NOT EXISTS dynamodb_bridge_config (
  key   text PRIMARY KEY,
  value text NOT NULL
);

INSERT INTO dynamodb_bridge_config VALUES
  ('edge_function_url', 'https://<project-ref>.supabase.co/functions/v1/dynamodb-bridge');
```

A shared helper function retrieves the URL, attaches the caller's JWT, and propagates structured errors as PostgreSQL exceptions:

```sql
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
```

### 2.2 dynamodb_get_item

```sql
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
```

### 2.3 dynamodb_query_index

```sql
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
```

### 2.4 dynamodb_scan

```sql
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
```

`dynamodb_scan` carries `COST 50000` — five times the Query cost — to strongly discourage the planner from preferring it in joined queries.

---

## 3. PL/pgSQL Wrapper Functions

### 3.1 Design Pattern

All wrappers share the same structure:

```
initialize timing, counters
loop
  call primitive with current continuation_token
  accumulate rows via RETURN NEXT
  check next_token: if NULL, exit loop
  check page_count >= max_pages: if so, emit WARNING and exit loop
  update continuation_token
end loop
emit RAISE NOTICE with diagnostics
```

### 3.2 dynamodb_query_all

```sql
CREATE OR REPLACE FUNCTION dynamodb_query_all(
  p_table_name    text,
  p_index_name    text,
  p_pk_value      text,
  p_sk_condition  jsonb DEFAULT NULL,
  p_max_pages     int   DEFAULT 10
)
RETURNS TABLE (item jsonb)
LANGUAGE plpgsql STABLE COST 100000 AS $$
DECLARE
  v_token       text        := NULL;
  v_page        int         := 0;
  v_row_count   int         := 0;
  v_start       timestamptz := clock_timestamp();
  r             record;
BEGIN
  LOOP
    FOR r IN
      SELECT q.item, q.next_token
      FROM dynamodb_query_index(p_table_name, p_index_name, p_pk_value, p_sk_condition, v_token) q
    LOOP
      item := r.item;
      RETURN NEXT;
      v_row_count := v_row_count + 1;
      v_token     := r.next_token;
    END LOOP;

    v_page := v_page + 1;

    EXIT WHEN v_token IS NULL;

    IF v_page >= p_max_pages THEN
      RAISE WARNING 'dynamodb_query_all: max_pages (%) reached, result set is truncated. table=%, index=%, pk=%',
        p_max_pages, p_table_name, p_index_name, p_pk_value;
      EXIT;
    END IF;
  END LOOP;

  RAISE NOTICE 'dynamodb_query_all: pages=%, rows=%, elapsed=%ms, table=%, index=%, pk=%',
    v_page,
    v_row_count,
    round(extract(epoch from (clock_timestamp() - v_start)) * 1000),
    p_table_name,
    p_index_name,
    p_pk_value;
END;
$$;
```

### 3.3 dynamodb_scan_all

Follows the identical pattern, wrapping `dynamodb_scan`. The `p_filter_expression`, `p_expression_attrs`, and `p_limit` parameters remain non-defaulted to preserve intentionality.

---

## 4. Error Handling Summary

| Layer | Error condition | Behavior |
|---|---|---|
| Edge Function | DynamoDB error | Returns structured JSON error body, HTTP 502 |
| Edge Function | JWT invalid | Returns HTTP 401, no DynamoDB call made |
| Edge Function | Timeout | Returns structured JSON error body, HTTP 504 |
| `_dynamodb_http_post` | Structured error in response | `RAISE EXCEPTION` with code and message |
| `_dynamodb_http_post` | Non-JSON response | `RAISE EXCEPTION` with raw content |
| Wrapper functions | `max_pages` exceeded | `RAISE WARNING`, return partial results |
| Wrapper functions | Any exception from primitive | Propagates uncaught to caller |

---

## 5. Testing Plan

### Unit level
- Edge Function: mock DynamoDB responses for each operation type, verify unmarshalling for all attribute types including nested `M` and `L`
- Edge Function: verify SigV4 signatures against AWS's published test vectors
- Edge Function: verify JWT rejection returns 401 before any DynamoDB call

### Integration level
- GetItem against a real DynamoDB table: hit, miss, malformed key
- Query: single page, multi-page, empty result
- Scan: verify `max_pages` truncation path is exercised and WARNING is emitted
- Timeout: verify nested timeout ordering (DynamoDB times out before Edge Function before pg_http)

### SQL level
- `SELECT * FROM dynamodb_get_item(...)` returns expected shape
- `SELECT * FROM dynamodb_query_all(...) WHERE (item->>'status') = 'active'` — verify post-fetch filtering works correctly
- Join against a local table — verify planner cost hints produce sensible query plans via `EXPLAIN`

---

## 6. Known Limitations and Future Considerations

**Predicate pushdown** is not possible without a native FDW. Callers must encode access patterns in function parameters rather than WHERE clauses against the function result.

**Binary DynamoDB types** (`B`, `BS`) are returned as Base64 strings with no further conversion.

**Key schema is partially hardcoded** in the current primitive signatures (`pk`, `sk`). A future version could accept key schema as parameters or read it from a configuration table.

**Writes are out of scope** for v1. A future `dynamodb_put_item`, `dynamodb_update_item`, and `dynamodb_delete_item` primitive family would follow the same pattern but must not be declared `STABLE` and require careful transaction boundary consideration since DynamoDB writes are not part of the PostgreSQL transaction.

**Cold start latency** on the Edge Function affects the first call after a period of inactivity. Not mitigated in v1.
