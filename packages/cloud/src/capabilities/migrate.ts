import { sql } from "bun";

/**
 * Platform-owned capability execution history.
 *
 * Every capability invocation that leaves Cloud goes through
 * `dispatchCapability`, and that dispatcher is the only writer of this table.
 * The row records shape and outcome, never payloads, and shares `request_id`
 * with the invocation token and the owning app's audit rows.
 */
export const migrateCloudCapabilities = async (): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS capabilities`.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS capabilities.executions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      app_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      kind TEXT NOT NULL,
      destructive BOOLEAN NOT NULL DEFAULT false,
      actor_kind TEXT,
      actor_id UUID,
      user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      access_subject_type TEXT,
      access_subject_id UUID,
      status TEXT NOT NULL,
      error_code TEXT,
      input_meta JSONB,
      output_meta JSONB,
      idempotency_key TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER NOT NULL DEFAULT 0,
      CONSTRAINT capabilities_executions_origin_check CHECK (origin IN ('assistant', 'mcp', 'http', 'app')),
      CONSTRAINT capabilities_executions_kind_check CHECK (kind IN ('query', 'action')),
      CONSTRAINT capabilities_executions_actor_kind_check CHECK (actor_kind IS NULL OR actor_kind IN ('user', 'service_account')),
      CONSTRAINT capabilities_executions_subject_check CHECK (access_subject_type IS NULL OR access_subject_type IN ('user', 'service_account')),
      CONSTRAINT capabilities_executions_status_check CHECK (status IN ('succeeded', 'failed', 'denied', 'invalid_input', 'timed_out', 'rejected'))
    )
  `.simple();

  await sql`CREATE INDEX IF NOT EXISTS idx_capabilities_executions_started ON capabilities.executions(started_at DESC, id DESC)`.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_capabilities_executions_app_started
    ON capabilities.executions(app_id, started_at DESC, id DESC)
  `.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_capabilities_executions_request ON capabilities.executions(request_id)`.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_capabilities_executions_user_started
    ON capabilities.executions(user_id, started_at DESC, id DESC)
    WHERE user_id IS NOT NULL
  `.simple();

  console.log("  ✓ capability execution history");
};
