import { assertEquals } from "jsr:@std/assert";
import {
  formatAmzDate,
  sha256Hash,
  hmacSha256,
  deriveSigningKey,
  buildCanonicalRequest,
  buildStringToSign,
  signRequest,
} from "../dynamodb-bridge/sigv4.ts";

Deno.test("formatAmzDate: formats date as ISO8601 basic", () => {
  const date = new Date("2024-01-15T09:30:00Z");
  const { amzDate, dateStamp } = formatAmzDate(date);
  assertEquals(amzDate, "20240115T093000Z");
  assertEquals(dateStamp, "20240115");
});

Deno.test("formatAmzDate: handles midnight", () => {
  const date = new Date("2024-12-31T00:00:00Z");
  const { amzDate, dateStamp } = formatAmzDate(date);
  assertEquals(amzDate, "20241231T000000Z");
  assertEquals(dateStamp, "20241231");
});

Deno.test("sha256Hash: produces correct hex digest", async () => {
  const hash = await sha256Hash("");
  // SHA-256 of empty string
  assertEquals(
    hash,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

Deno.test("sha256Hash: produces correct hash for 'hello'", async () => {
  const hash = await sha256Hash("hello");
  assertEquals(
    hash,
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

Deno.test("hmacSha256: produces correct HMAC bytes", async () => {
  const key = new TextEncoder().encode("key");
  const result = await hmacSha256(key, "message");
  // Verify it returns a Uint8Array of 32 bytes (SHA-256 output)
  assertEquals(result.byteLength, 32);
});

Deno.test("deriveSigningKey: returns 32-byte key", async () => {
  const key = await deriveSigningKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20240101", "us-east-1", "dynamodb");
  assertEquals(key.byteLength, 32);
});

Deno.test("buildCanonicalRequest: formats correctly", async () => {
  const canonical = await buildCanonicalRequest(
    "POST",
    "/",
    "",
    {
      "content-type": "application/x-amz-json-1.0",
      "host": "dynamodb.us-east-1.amazonaws.com",
      "x-amz-date": "20240115T093000Z",
      "x-amz-target": "DynamoDB_20120810.GetItem",
    },
    '{"TableName":"test"}',
  );
  // Verify it contains the expected structure
  const lines = canonical.split("\n");
  assertEquals(lines[0], "POST");
  assertEquals(lines[1], "/");
  assertEquals(lines[2], ""); // empty query string
  // Headers should be sorted and lowercased
  assertEquals(lines[3], "content-type:application/x-amz-json-1.0");
  assertEquals(lines[4], "host:dynamodb.us-east-1.amazonaws.com");
  assertEquals(lines[5], "x-amz-date:20240115T093000Z");
  assertEquals(lines[6], "x-amz-target:DynamoDB_20120810.GetItem");
  assertEquals(lines[7], ""); // blank line after headers
  assertEquals(lines[8], "content-type;host;x-amz-date;x-amz-target");
  // Line 9 should be the SHA-256 hash of the body
});

Deno.test("buildStringToSign: formats correctly", () => {
  const stringToSign = buildStringToSign(
    "20240115T093000Z",
    "20240115",
    "us-east-1",
    "dynamodb",
    "canonical-request-hash",
  );
  const lines = stringToSign.split("\n");
  assertEquals(lines[0], "AWS4-HMAC-SHA256");
  assertEquals(lines[1], "20240115T093000Z");
  assertEquals(lines[2], "20240115/us-east-1/dynamodb/aws4_request");
  assertEquals(lines[3], "canonical-request-hash");
});

Deno.test("signRequest: produces complete Authorization header", async () => {
  const result = await signRequest({
    method: "POST",
    url: "https://dynamodb.us-east-1.amazonaws.com/",
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "host": "dynamodb.us-east-1.amazonaws.com",
      "x-amz-date": "20240115T093000Z",
      "x-amz-target": "DynamoDB_20120810.GetItem",
    },
    body: '{"TableName":"test","Key":{"pk":{"S":"USER#1"}}}',
    region: "us-east-1",
    service: "dynamodb",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    datetime: "20240115T093000Z",
  });

  // Verify the Authorization header format
  assertEquals(result.startsWith("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20240115/us-east-1/dynamodb/aws4_request,"), true);
  assertEquals(result.includes("SignedHeaders=content-type;host;x-amz-date;x-amz-target,"), true);
  assertEquals(result.includes("Signature="), true);
  // Signature should be 64 hex characters
  const sig = result.split("Signature=")[1];
  assertEquals(sig.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(sig), true);
});

Deno.test("signRequest: different bodies produce different signatures", async () => {
  const params = {
    method: "POST",
    url: "https://dynamodb.us-east-1.amazonaws.com/",
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "host": "dynamodb.us-east-1.amazonaws.com",
      "x-amz-date": "20240115T093000Z",
      "x-amz-target": "DynamoDB_20120810.GetItem",
    },
    region: "us-east-1",
    service: "dynamodb",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    datetime: "20240115T093000Z",
  };

  const sig1 = await signRequest({ ...params, body: '{"body":"one"}' });
  const sig2 = await signRequest({ ...params, body: '{"body":"two"}' });
  assertEquals(sig1 !== sig2, true);
});
