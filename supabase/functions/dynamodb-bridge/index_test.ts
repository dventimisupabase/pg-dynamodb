import { assertEquals } from "jsr:@std/assert";
import { handleRequest } from "./index.ts";

// Helper to create a valid HS256 JWT
async function createJWT(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const headerB64 = enc(header);
  const payloadB64 = enc(payload);
  const data = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${data}.${sigB64}`;
}

const TEST_SECRET = "super-secret-jwt-token-with-at-least-32-characters";
const TEST_ENV = {
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  AWS_REGION: "us-east-1",
  SUPABASE_JWT_SECRET: TEST_SECRET,
  DYNAMODB_TIMEOUT_MS: "5000",
};

function mockEnvGet(env: Record<string, string>) {
  return (key: string) => env[key] ?? "";
}

// Helper: build a Request for the edge function
function buildRequest(
  body: Record<string, unknown>,
  token: string,
): Request {
  return new Request("http://localhost/functions/v1/dynamodb-bridge", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

Deno.test("returns 401 for missing Authorization header", async () => {
  const req = new Request("http://localhost/functions/v1/dynamodb-bridge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "GetItem", payload: {} }),
  });

  const res = await handleRequest(req, mockEnvGet(TEST_ENV), globalThis.fetch);
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, true);
  assertEquals(body.code, "UNAUTHORIZED");
});

Deno.test("returns 401 for invalid JWT", async () => {
  const req = buildRequest(
    { operation: "GetItem", payload: {} },
    "invalid.jwt.token",
  );

  const res = await handleRequest(req, mockEnvGet(TEST_ENV), globalThis.fetch);
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, true);
  assertEquals(body.code, "UNAUTHORIZED");
});

Deno.test("returns 401 for expired JWT", async () => {
  const token = await createJWT(
    { sub: "user1", exp: Math.floor(Date.now() / 1000) - 3600 },
    TEST_SECRET,
  );
  const req = buildRequest({ operation: "GetItem", payload: {} }, token);

  const res = await handleRequest(req, mockEnvGet(TEST_ENV), globalThis.fetch);
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, true);
  assertEquals(body.code, "UNAUTHORIZED");
});

Deno.test("returns 400 for unknown operation", async () => {
  const token = await createJWT(
    { sub: "user1", exp: Math.floor(Date.now() / 1000) + 3600 },
    TEST_SECRET,
  );
  const req = buildRequest(
    { operation: "DeleteItem", payload: {} },
    token,
  );

  const mockFetch = () => Promise.resolve(new Response("unused"));
  const res = await handleRequest(req, mockEnvGet(TEST_ENV), mockFetch);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, true);
  assertEquals(body.code, "INVALID_OPERATION");
});

Deno.test("returns 400 for missing operation field", async () => {
  const token = await createJWT(
    { sub: "user1", exp: Math.floor(Date.now() / 1000) + 3600 },
    TEST_SECRET,
  );
  const req = buildRequest({ payload: {} }, token);

  const mockFetch = () => Promise.resolve(new Response("unused"));
  const res = await handleRequest(req, mockEnvGet(TEST_ENV), mockFetch);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, true);
});

Deno.test("GetItem: returns unmarshalled item on success", async () => {
  const token = await createJWT(
    { sub: "user1", exp: Math.floor(Date.now() / 1000) + 3600 },
    TEST_SECRET,
  );
  const req = buildRequest(
    {
      operation: "GetItem",
      payload: {
        TableName: "users",
        Key: { pk: "USER#1", sk: "PROFILE" },
      },
    },
    token,
  );

  const dynamoResponse = {
    Item: {
      pk: { S: "USER#1" },
      sk: { S: "PROFILE" },
      name: { S: "Alice" },
      score: { N: "42" },
    },
  };

  const mockFetch = (_url: string | URL | Request, _init?: RequestInit) => {
    return Promise.resolve(
      new Response(JSON.stringify(dynamoResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const res = await handleRequest(req, mockEnvGet(TEST_ENV), mockFetch);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.items, [
    { pk: "USER#1", sk: "PROFILE", name: "Alice", score: 42 },
  ]);
  assertEquals(body.next_token, null);
});

Deno.test("GetItem: returns empty items when item not found", async () => {
  const token = await createJWT(
    { sub: "user1", exp: Math.floor(Date.now() / 1000) + 3600 },
    TEST_SECRET,
  );
  const req = buildRequest(
    {
      operation: "GetItem",
      payload: {
        TableName: "users",
        Key: { pk: "NONEXISTENT", sk: "PROFILE" },
      },
    },
    token,
  );

  // DynamoDB returns empty object when item not found
  const mockFetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

  const res = await handleRequest(req, mockEnvGet(TEST_ENV), mockFetch);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.items, []);
  assertEquals(body.next_token, null);
});

Deno.test("Query: returns unmarshalled items with next_token", async () => {
  const token = await createJWT(
    { sub: "user1", exp: Math.floor(Date.now() / 1000) + 3600 },
    TEST_SECRET,
  );
  const req = buildRequest(
    {
      operation: "Query",
      payload: {
        TableName: "users",
        IndexName: "status-index",
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: "ACTIVE" } },
      },
    },
    token,
  );

  const lastKey = { pk: { S: "ACTIVE" }, sk: { S: "user#50" } };
  const dynamoResponse = {
    Items: [
      { pk: { S: "ACTIVE" }, name: { S: "Alice" } },
      { pk: { S: "ACTIVE" }, name: { S: "Bob" } },
    ],
    Count: 2,
    LastEvaluatedKey: lastKey,
  };

  const mockFetch = () =>
    Promise.resolve(
      new Response(JSON.stringify(dynamoResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

  const res = await handleRequest(req, mockEnvGet(TEST_ENV), mockFetch);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.items.length, 2);
  assertEquals(body.items[0].name, "Alice");
  assertEquals(body.items[1].name, "Bob");
  // next_token should be base64-encoded LastEvaluatedKey
  assertEquals(body.next_token, btoa(JSON.stringify(lastKey)));
});

Deno.test("Query: null next_token when no LastEvaluatedKey", async () => {
  const token = await createJWT(
    { sub: "user1", exp: Math.floor(Date.now() / 1000) + 3600 },
    TEST_SECRET,
  );
  const req = buildRequest(
    {
      operation: "Query",
      payload: {
        TableName: "users",
        IndexName: "status-index",
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: "ACTIVE" } },
      },
    },
    token,
  );

  const dynamoResponse = {
    Items: [{ pk: { S: "ACTIVE" }, name: { S: "Alice" } }],
    Count: 1,
  };

  const mockFetch = () =>
    Promise.resolve(
      new Response(JSON.stringify(dynamoResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

  const res = await handleRequest(req, mockEnvGet(TEST_ENV), mockFetch);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.next_token, null);
});

Deno.test("returns 502 for DynamoDB errors", async () => {
  const token = await createJWT(
    { sub: "user1", exp: Math.floor(Date.now() / 1000) + 3600 },
    TEST_SECRET,
  );
  const req = buildRequest(
    {
      operation: "GetItem",
      payload: { TableName: "users", Key: { pk: "USER#1", sk: "PROFILE" } },
    },
    token,
  );

  const dynamoError = {
    __type: "com.amazonaws.dynamodb.v20120810#ResourceNotFoundException",
    message: "Requested resource not found",
  };

  const mockFetch = () =>
    Promise.resolve(
      new Response(JSON.stringify(dynamoError), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

  const res = await handleRequest(req, mockEnvGet(TEST_ENV), mockFetch);
  assertEquals(res.status, 502);
  const body = await res.json();
  assertEquals(body.error, true);
  assertEquals(body.code, "TABLE_NOT_FOUND");
  assertEquals(body.source, "dynamodb");
});

Deno.test({ name: "returns 504 on timeout", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const token = await createJWT(
    { sub: "user1", exp: Math.floor(Date.now() / 1000) + 3600 },
    TEST_SECRET,
  );
  const req = buildRequest(
    {
      operation: "GetItem",
      payload: { TableName: "users", Key: { pk: "USER#1", sk: "PROFILE" } },
    },
    token,
  );

  // Use very short timeout
  const envWithShortTimeout = { ...TEST_ENV, DYNAMODB_TIMEOUT_MS: "1" };

  const mockFetch = (_url: string | URL | Request, init?: RequestInit) => {
    // Simulate a slow response by checking abort signal
    return new Promise<Response>((resolve, reject) => {
      const signal = (init as RequestInit | undefined)?.signal;
      const timerId = setTimeout(() => resolve(new Response("")), 60000);
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timerId);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }
    });
  };

  const res = await handleRequest(
    req,
    mockEnvGet(envWithShortTimeout),
    mockFetch,
  );
  assertEquals(res.status, 504);
  const body = await res.json();
  assertEquals(body.error, true);
  assertEquals(body.code, "TIMEOUT");
  assertEquals(body.source, "network");
}});

Deno.test("Scan: returns items correctly", async () => {
  const token = await createJWT(
    { sub: "user1", exp: Math.floor(Date.now() / 1000) + 3600 },
    TEST_SECRET,
  );
  const req = buildRequest(
    {
      operation: "Scan",
      payload: {
        TableName: "users",
        FilterExpression: "attribute_exists(email)",
        ExpressionAttributeValues: {},
        Limit: 10,
      },
    },
    token,
  );

  const dynamoResponse = {
    Items: [
      { pk: { S: "USER#1" }, email: { S: "alice@test.com" } },
    ],
    Count: 1,
    ScannedCount: 5,
  };

  const mockFetch = () =>
    Promise.resolve(
      new Response(JSON.stringify(dynamoResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

  const res = await handleRequest(req, mockEnvGet(TEST_ENV), mockFetch);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.items.length, 1);
  assertEquals(body.items[0].email, "alice@test.com");
  assertEquals(body.next_token, null);
});

Deno.test("passes ExclusiveStartKey when next_token provided", async () => {
  const token = await createJWT(
    { sub: "user1", exp: Math.floor(Date.now() / 1000) + 3600 },
    TEST_SECRET,
  );

  const lastKey = { pk: { S: "ACTIVE" }, sk: { S: "user#50" } };
  const encodedToken = btoa(JSON.stringify(lastKey));

  const req = buildRequest(
    {
      operation: "Query",
      payload: {
        TableName: "users",
        IndexName: "status-index",
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: "ACTIVE" } },
        ExclusiveStartKey: encodedToken,
      },
    },
    token,
  );

  let capturedBody: Record<string, unknown> | null = null;
  const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse((init as RequestInit).body as string);
    return new Response(
      JSON.stringify({ Items: [], Count: 0 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const res = await handleRequest(req, mockEnvGet(TEST_ENV), mockFetch);
  assertEquals(res.status, 200);
  // Verify that ExclusiveStartKey was decoded from the token
  assertEquals(
    (capturedBody as unknown as Record<string, unknown>).ExclusiveStartKey,
    lastKey,
  );
});

Deno.test("sends correct x-amz-target header for each operation", async () => {
  const token = await createJWT(
    { sub: "user1", exp: Math.floor(Date.now() / 1000) + 3600 },
    TEST_SECRET,
  );

  for (const op of ["GetItem", "Query", "Scan"] as const) {
    let capturedHeaders: Headers | null = null;
    const mockFetch = (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = new Headers((init as RequestInit).headers);
      const responseBody = op === "GetItem"
        ? JSON.stringify({})
        : JSON.stringify({ Items: [], Count: 0 });
      return Promise.resolve(
        new Response(responseBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    const payload = op === "GetItem"
      ? { TableName: "t", Key: { pk: "a", sk: "b" } }
      : op === "Query"
        ? { TableName: "t", KeyConditionExpression: "pk=:pk", ExpressionAttributeValues: {} }
        : { TableName: "t", FilterExpression: "a=b", Limit: 10 };

    const req = buildRequest({ operation: op, payload }, token);
    await handleRequest(req, mockEnvGet(TEST_ENV), mockFetch);
    assertEquals(
      capturedHeaders!.get("x-amz-target"),
      `DynamoDB_20120810.${op}`,
    );
  }
});
