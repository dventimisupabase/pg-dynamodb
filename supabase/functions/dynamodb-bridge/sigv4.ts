import type { SignRequestParams } from "./types.ts";

const encoder = new TextEncoder();

/**
 * Format a Date into AMZ date format: YYYYMMDD'T'HHMMSS'Z' and datestamp: YYYYMMDD
 */
export function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const amzDate = iso; // e.g. "20240115T093000Z"
  const dateStamp = iso.slice(0, 8); // e.g. "20240115"
  return { amzDate, dateStamp };
}

/**
 * SHA-256 hash of a string, returned as lowercase hex.
 */
export async function sha256Hash(data: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  return arrayToHex(new Uint8Array(hash));
}

/**
 * HMAC-SHA256 of a message using a key (as raw bytes).
 */
export async function hmacSha256(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key).buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return new Uint8Array(sig);
}

/**
 * Derive the SigV4 signing key: HMAC chain of date, region, service, "aws4_request".
 */
export async function deriveSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = await hmacSha256(encoder.encode("AWS4" + secretKey), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, "aws4_request");
  return kSigning;
}

/**
 * Build the canonical request string for SigV4.
 */
export async function buildCanonicalRequest(
  method: string,
  path: string,
  queryString: string,
  headers: Record<string, string>,
  body: string,
): Promise<string> {
  const sortedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaders
    .map((k) => `${k}:${headers[k]}`)
    .join("\n");
  const signedHeaders = sortedHeaders.join(";");
  const payloadHash = await sha256Hash(body);

  return [
    method,
    path,
    queryString,
    canonicalHeaders,
    "", // blank line after headers
    signedHeaders,
    payloadHash,
  ].join("\n");
}

/**
 * Build the string to sign for SigV4.
 */
export function buildStringToSign(
  amzDate: string,
  dateStamp: string,
  region: string,
  service: string,
  canonicalRequestHash: string,
): string {
  return [
    "AWS4-HMAC-SHA256",
    amzDate,
    `${dateStamp}/${region}/${service}/aws4_request`,
    canonicalRequestHash,
  ].join("\n");
}

/**
 * Sign a request using AWS SigV4 and return the Authorization header value.
 */
export async function signRequest(params: SignRequestParams): Promise<string> {
  const { method, headers, body, region, service, accessKeyId, secretAccessKey, datetime } = params;
  const dateStamp = datetime.slice(0, 8);

  const canonicalRequest = await buildCanonicalRequest(method, "/", "", headers, body);
  const canonicalRequestHash = await sha256Hash(canonicalRequest);
  const stringToSign = buildStringToSign(datetime, dateStamp, region, service, canonicalRequestHash);
  const signingKey = await deriveSigningKey(secretAccessKey, dateStamp, region, service);
  const signatureBytes = await hmacSha256(signingKey, stringToSign);
  const signature = arrayToHex(signatureBytes);

  const sortedHeaders = Object.keys(headers).sort();
  const signedHeaders = sortedHeaders.join(";");
  const credential = `${accessKeyId}/${dateStamp}/${region}/${service}/aws4_request`;

  return `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function arrayToHex(arr: Uint8Array): string {
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
