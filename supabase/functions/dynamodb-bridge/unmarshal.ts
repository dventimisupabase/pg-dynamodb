import type { DynamoDBAttributeValue, DynamoDBItem } from "./types.ts";

/**
 * Recursively unmarshal a single DynamoDB typed attribute value into a plain JS value.
 */
export function unmarshalValue(attr: DynamoDBAttributeValue): unknown {
  if ("S" in attr) return attr.S;
  if ("N" in attr) return Number(attr.N);
  if ("BOOL" in attr) return attr.BOOL;
  if ("NULL" in attr) return null;
  if ("L" in attr) return attr.L.map(unmarshalValue);
  if ("M" in attr) return unmarshalItem(attr.M);
  if ("SS" in attr) return attr.SS;
  if ("NS" in attr) return attr.NS.map(Number);
  if ("B" in attr) return attr.B;
  if ("BS" in attr) return attr.BS;

  throw new Error(`Unknown DynamoDB attribute type: ${JSON.stringify(attr)}`);
}

/**
 * Unmarshal a full DynamoDB item (map of attribute name to typed value) into a plain object.
 */
export function unmarshalItem(
  item: DynamoDBItem,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    result[key] = unmarshalValue(value as DynamoDBAttributeValue);
  }
  return result;
}
