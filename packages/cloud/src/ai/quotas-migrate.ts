import { sql } from "bun";
export async function migrateAiQuotas() {
  await sql.begin(async (db) => {
    await db`CREATE TABLE IF NOT EXISTS ai.cost_config (
      singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton), enabled BOOLEAN NOT NULL DEFAULT false,
      revision INTEGER NOT NULL DEFAULT 0, rules JSONB NOT NULL DEFAULT '[]',
      unit TEXT NOT NULL DEFAULT 'EUR', background JSONB, background_stopped_at TIMESTAMPTZ, background_warned BOOLEAN NOT NULL DEFAULT false
    )`;
    await db`CREATE TABLE IF NOT EXISTS ai.cost_alerts (
      id UUID PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('warning','stop')), cost NUMERIC(30,12) NOT NULL,
      unit TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`;
    await db`INSERT INTO ai.cost_config(singleton) VALUES(true) ON CONFLICT DO NOTHING`;
    await db`CREATE TABLE IF NOT EXISTS ai.inference_calls (
      id UUID PRIMARY KEY, user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      service_account_id UUID REFERENCES auth.service_accounts(id) ON DELETE SET NULL,
      model_profile_id TEXT NOT NULL, turn_id UUID, turn_attempt INTEGER, started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      finished_at TIMESTAMPTZ, input BIGINT, output BIGINT,
      kind TEXT NOT NULL CHECK(kind IN ('chat','background')), task TEXT NOT NULL,
      provider_model TEXT NOT NULL, app_id TEXT, conversation_id UUID, workflow_run_id UUID,
      step_key TEXT, trace_id TEXT, workflow_id UUID, workflow_name TEXT, workflow_version INTEGER, pricing JSONB, cost NUMERIC(30,12), reserved NUMERIC(30,12) NOT NULL DEFAULT 0,
      lease_expires_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL DEFAULT 'running', error_code TEXT,
      CHECK(cost IS NULL OR cost>=0), CHECK(reserved>=0),
      CHECK(input IS NULL OR input>=0), CHECK(output IS NULL OR output>=0)
    )`;
    await db`ALTER TABLE ai.inference_calls ADD COLUMN IF NOT EXISTS estimated BOOLEAN NOT NULL DEFAULT false`;
    await db`CREATE INDEX IF NOT EXISTS inference_calls_workflow ON ai.inference_calls(workflow_run_id,started_at)`;
    await db`CREATE INDEX IF NOT EXISTS inference_calls_started ON ai.inference_calls(started_at)`;
    await db`CREATE INDEX IF NOT EXISTS inference_calls_turn ON ai.inference_calls(turn_id,started_at,id) WHERE kind='chat'`;
    await db`CREATE INDEX IF NOT EXISTS inference_calls_user ON ai.inference_calls(user_id,started_at)`;
    await db`CREATE INDEX IF NOT EXISTS inference_calls_service ON ai.inference_calls(service_account_id,started_at)`;
    await db`CREATE TABLE IF NOT EXISTS ai.cost_resets (
      request_id UUID PRIMARY KEY, user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
      service_account_id UUID REFERENCES auth.service_accounts(id) ON DELETE CASCADE,
      scope TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      CHECK(num_nonnulls(user_id,service_account_id)=1)
    )`;
    await db`CREATE INDEX IF NOT EXISTS cost_resets_user ON ai.cost_resets(user_id,service_account_id,scope,created_at)`;
    await db`CREATE TABLE IF NOT EXISTS ai.cost_changes (
      revision INTEGER PRIMARY KEY, actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), config JSONB NOT NULL
    )`;
  });
}
