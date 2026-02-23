import type { BridgeErrorResponse } from "./types.ts";

// Map DynamoDB error types to bridge error codes
const DYNAMODB_ERROR_MAP: Record<string, string> = {
  "ProvisionedThroughputExceededException": "THROUGHPUT_EXCEEDED",
  "ResourceNotFoundException": "TABLE_NOT_FOUND",
  "ValidationException": "VALIDATION_ERROR",
  "ConditionalCheckFailedException": "CONDITION_FAILED",
  "ItemCollectionSizeLimitExceededException": "COLLECTION_SIZE_EXCEEDED",
  "RequestLimitExceeded": "REQUEST_LIMIT_EXCEEDED",
  "InternalServerError": "DYNAMODB_INTERNAL_ERROR",
  "ServiceUnavailable": "DYNAMODB_UNAVAILABLE",
};

/**
 * Normalize a DynamoDB error response into a structured bridge error.
 */
export function normalizeDynamoDBError(
  errorType: string,
  errorMessage: string,
): BridgeErrorResponse {
  const code = DYNAMODB_ERROR_MAP[errorType] ?? "DYNAMODB_ERROR";
  return {
    error: true,
    code,
    message: `${errorType}: ${errorMessage}`,
    source: "dynamodb",
  };
}

/**
 * Create an edge function error response.
 */
export function edgeFunctionError(
  code: string,
  message: string,
): BridgeErrorResponse {
  return {
    error: true,
    code,
    message,
    source: "edge_function",
  };
}

/**
 * Create a network error response (e.g., timeout).
 */
export function networkError(
  code: string,
  message: string,
): BridgeErrorResponse {
  return {
    error: true,
    code,
    message,
    source: "network",
  };
}

/**
 * Map a bridge error to the appropriate HTTP status code.
 */
export function errorToHttpStatus(error: BridgeErrorResponse): number {
  if (error.code === "UNAUTHORIZED") return 401;
  if (error.source === "edge_function") return 400;
  if (error.code === "TIMEOUT") return 504;
  if (error.source === "network") return 504;
  return 502; // DynamoDB errors
}
