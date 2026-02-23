// DynamoDB operations supported by the bridge
export type DynamoDBOperation = "GetItem" | "Query" | "Scan";

// DynamoDB typed attribute value (recursive for M and L)
export type DynamoDBAttributeValue =
  | { S: string }
  | { N: string }
  | { BOOL: boolean }
  | { NULL: true }
  | { L: DynamoDBAttributeValue[] }
  | { M: Record<string, DynamoDBAttributeValue> }
  | { SS: string[] }
  | { NS: string[] }
  | { B: string }
  | { BS: string[] };

// A DynamoDB item is a map of attribute names to typed values
export type DynamoDBItem = Record<string, DynamoDBAttributeValue>;

// Incoming request body to the Edge Function
export interface BridgeRequest {
  operation: DynamoDBOperation;
  payload: Record<string, unknown>;
}

// Successful response from the Edge Function
export interface BridgeSuccessResponse {
  items: Record<string, unknown>[];
  next_token: string | null;
}

// Error response from the Edge Function
export interface BridgeErrorResponse {
  error: true;
  code: string;
  message: string;
  source: "dynamodb" | "edge_function" | "network";
}

// DynamoDB raw response for GetItem
export interface DynamoDBGetItemResponse {
  Item?: DynamoDBItem;
}

// DynamoDB raw response for Query and Scan
export interface DynamoDBQueryScanResponse {
  Items?: DynamoDBItem[];
  Count?: number;
  ScannedCount?: number;
  LastEvaluatedKey?: DynamoDBItem;
}

// SigV4 signing parameters
export interface SignRequestParams {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  datetime: string;
}
