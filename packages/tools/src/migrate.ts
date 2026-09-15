import { sql } from "bun";

export const migrate = async () => {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.simple();
  await sql`CREATE SCHEMA IF NOT EXISTS tools`.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS tools.webhook_endpoints (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at TIMESTAMPTZ
    )
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS tools.webhook_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      endpoint_id UUID REFERENCES tools.webhook_endpoints(id) ON DELETE CASCADE,
      owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      query TEXT NOT NULL DEFAULT '',
      request_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
      request_body TEXT,
      request_content_type TEXT,
      response_status INTEGER,
      response_headers JSONB,
      response_body TEXT,
      duration_ms INTEGER,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();

  // Historical header strings are disposable logs; endpoint configuration is retained.
  await sql`
    DELETE FROM tools.webhook_logs
    WHERE jsonb_typeof(request_headers) <> 'object'
       OR (response_headers IS NOT NULL AND jsonb_typeof(response_headers) <> 'object')
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_tools_webhook_endpoints_owner
      ON tools.webhook_endpoints(owner_user_id, deleted_at, created_at DESC)
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_tools_webhook_logs_endpoint
      ON tools.webhook_logs(endpoint_id, created_at DESC)
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_tools_webhook_logs_owner
      ON tools.webhook_logs(owner_user_id, direction, created_at DESC)
  `.simple();
};
