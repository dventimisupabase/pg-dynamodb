import type {
  BridgeRequest,
  DynamoDBGetItemResponse,
  DynamoDBItem,
  DynamoDBOperation,
  DynamoDBQueryScanResponse,
} from "./types.ts";
import { unmarshalItem } from "./unmarshal.ts";
import { formatAmzDate, signRequest } from "./sigv4.ts";
import {
  edgeFunctionError,
  errorToHttpStatus,
  networkError,
  normalizeDynamoDBError,
} from "./errors.ts";

const VALID_OPERATIONS: Set<string> = new Set(["GetItem", "Query", "Scan"]);
const AMZ_TARGET_PREFIX = "DynamoDB_20120810";

type FetchFn = typeof globalThis.fetch;
type EnvGetFn = (key: string) => string;

/**
 * Verify a JWT using HS256 (manual verification via crypto.subtle).
 * Returns the decoded payload on success, null on failure.
 */
async function verifyJWT(
  token: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;

    // Verify signature
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    // Decode base64url signature
    const sigStr = signatureB64.replace(/-/g, "+").replace(/_/g, "/");
    const sigBin = Uint8Array.from(atob(sigStr), (c) => c.charCodeAt(0));

    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const valid = await crypto.subtle.verify("HMAC", key, sigBin, data);
    if (!valid) return null;

    // Decode payload
    const payloadStr = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(payloadStr));

    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Decode a base64-encoded next_token back into ExclusiveStartKey.
 */
function decodeNextToken(token: string): DynamoDBItem {
  return JSON.parse(atob(token));
}

/**
 * Encode a DynamoDB LastEvaluatedKey as a base64 next_token.
 */
function encodeNextToken(lastEvaluatedKey: DynamoDBItem): string {
  return btoa(JSON.stringify(lastEvaluatedKey));
}

/**
 * Handle an incoming request to the Edge Function.
 * Exported for testability; accepts injected fetch and env.get functions.
 */
export async function handleRequest(
  req: Request,
  envGet: EnvGetFn,
  fetchFn: FetchFn,
): Promise<Response> {
  // 1. Verify JWT
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    const err = edgeFunctionError("UNAUTHORIZED", "Missing or invalid Authorization header");
    return jsonResponse(err, 401);
  }

  const token = authHeader.slice(7);
  const jwtSecret = envGet("SUPABASE_JWT_SECRET");
  const jwtPayload = await verifyJWT(token, jwtSecret);
  if (!jwtPayload) {
    const err = edgeFunctionError("UNAUTHORIZED", "Invalid or expired JWT");
    return jsonResponse(err, 401);
  }

  // 2. Parse request body
  let body: BridgeRequest;
  try {
    body = await req.json();
  } catch {
    const err = edgeFunctionError("INVALID_REQUEST", "Invalid JSON body");
    return jsonResponse(err, 400);
  }

  if (!body.operation || !VALID_OPERATIONS.has(body.operation)) {
    const err = edgeFunctionError(
      "INVALID_OPERATION",
      `Unknown operation: ${body.operation ?? "undefined"}. Valid operations: GetItem, Query, Scan`,
    );
    return jsonResponse(err, 400);
  }

  // 3. Build DynamoDB request
  const operation = body.operation as DynamoDBOperation;
  const payload = { ...body.payload };

  // Decode ExclusiveStartKey from base64 next_token if present
  if (
    typeof payload.ExclusiveStartKey === "string" &&
    payload.ExclusiveStartKey
  ) {
    payload.ExclusiveStartKey = decodeNextToken(
      payload.ExclusiveStartKey as string,
    );
  }

  const region = envGet("AWS_REGION");
  const accessKeyId = envGet("AWS_ACCESS_KEY_ID");
  const secretAccessKey = envGet("AWS_SECRET_ACCESS_KEY");
  const timeoutMs = parseInt(envGet("DYNAMODB_TIMEOUT_MS") || "5000", 10);

  const dynamoUrl = `https://dynamodb.${region}.amazonaws.com/`;
  const amzTarget = `${AMZ_TARGET_PREFIX}.${operation}`;
  const now = new Date();
  const { amzDate } = formatAmzDate(now);
  const requestBody = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.0",
    "host": `dynamodb.${region}.amazonaws.com`,
    "x-amz-date": amzDate,
    "x-amz-target": amzTarget,
  };

  const authorization = await signRequest({
    method: "POST",
    url: dynamoUrl,
    headers,
    body: requestBody,
    region,
    service: "dynamodb",
    accessKeyId,
    secretAccessKey,
    datetime: amzDate,
  });

  // 4. Call DynamoDB with timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let dynamoResponse: Response;
  try {
    dynamoResponse = await fetchFn(dynamoUrl, {
      method: "POST",
      headers: {
        ...headers,
        Authorization: authorization,
      },
      body: requestBody,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e instanceof DOMException && e.name === "AbortError") {
      const err = networkError("TIMEOUT", `DynamoDB call timed out after ${timeoutMs}ms`);
      return jsonResponse(err, 504);
    }
    const err = networkError("NETWORK_ERROR", `Failed to reach DynamoDB: ${(e as Error).message}`);
    return jsonResponse(err, 504);
  } finally {
    clearTimeout(timeoutId);
  }

  // 5. Parse DynamoDB response
  const dynamoBody = await dynamoResponse.text();
  let dynamoJson: Record<string, unknown>;
  try {
    dynamoJson = JSON.parse(dynamoBody);
  } catch {
    const err = networkError("INVALID_RESPONSE", "Non-JSON response from DynamoDB");
    return jsonResponse(err, 502);
  }

  // 6. Handle DynamoDB errors
  if (!dynamoResponse.ok) {
    const errorType = extractDynamoErrorType(dynamoJson);
    const errorMessage = (dynamoJson.message ?? dynamoJson.Message ?? "Unknown error") as string;
    const err = normalizeDynamoDBError(errorType, errorMessage);
    return jsonResponse(err, errorToHttpStatus(err));
  }

  // 7. Unmarshal and respond
  if (operation === "GetItem") {
    const getResponse = dynamoJson as unknown as DynamoDBGetItemResponse;
    const items = getResponse.Item
      ? [unmarshalItem(getResponse.Item)]
      : [];
    return jsonResponse({ items, next_token: null }, 200);
  }

  // Query or Scan
  const queryResponse = dynamoJson as unknown as DynamoDBQueryScanResponse;
  const items = (queryResponse.Items ?? []).map(unmarshalItem);
  const nextToken = queryResponse.LastEvaluatedKey
    ? encodeNextToken(queryResponse.LastEvaluatedKey)
    : null;

  return jsonResponse({ items, next_token: nextToken }, 200);
}

/**
 * Extract the DynamoDB error type from the __type field.
 * DynamoDB returns types like "com.amazonaws.dynamodb.v20120810#ResourceNotFoundException"
 */
function extractDynamoErrorType(body: Record<string, unknown>): string {
  const rawType = (body.__type ?? "UnknownError") as string;
  const hashIdx = rawType.lastIndexOf("#");
  return hashIdx >= 0 ? rawType.slice(hashIdx + 1) : rawType;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Deno.serve entry point — only runs when executed directly, not when imported for tests
if (import.meta.main) {
  Deno.serve((req: Request) =>
    handleRequest(
      req,
      (key: string) => Deno.env.get(key) ?? "",
      globalThis.fetch,
    )
  );
}
