-- Enable pg_http extension for making HTTP requests from SQL
CREATE EXTENSION IF NOT EXISTS http;

-- Configuration table for the DynamoDB bridge
CREATE TABLE IF NOT EXISTS dynamodb_bridge_config (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- Seed with the edge function URL (update this for your deployment)
INSERT INTO dynamodb_bridge_config VALUES
  ('edge_function_url', 'https://<project-ref>.supabase.co/functions/v1/dynamodb-bridge')
ON CONFLICT (key) DO NOTHING;
