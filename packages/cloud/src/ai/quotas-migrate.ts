import { sql } from "bun";
export async function migrateAiQuotas() {
  await sql.begin(async (db) => {
    await db`CREATE TABLE IF NOT EXISTS ai.quota_config (
      singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton), enabled BOOLEAN NOT NULL DEFAULT false,
      revision INTEGER NOT NULL DEFAULT 0, rules JSONB NOT NULL DEFAULT '[]'
    )`;
    await db`INSERT INTO ai.quota_config(singleton) VALUES(true) ON CONFLICT DO NOTHING`;
    await db`CREATE TABLE IF NOT EXISTS ai.quota_calls (
      id UUID PRIMARY KEY, user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
      service_account_id UUID REFERENCES auth.service_accounts(id) ON DELETE CASCADE,
      model_profile_id TEXT NOT NULL, turn_id UUID, turn_attempt INTEGER, started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      finished_at TIMESTAMPTZ, input BIGINT, output BIGINT,
      CHECK(num_nonnulls(user_id,service_account_id)=1),
      CHECK(input IS NULL OR input>=0), CHECK(output IS NULL OR output>=0)
    )`;
    await db`ALTER TABLE ai.quota_calls ADD COLUMN IF NOT EXISTS estimated BOOLEAN NOT NULL DEFAULT false`;
    await db`CREATE INDEX IF NOT EXISTS quota_calls_started ON ai.quota_calls(started_at)`;
    await db`CREATE INDEX IF NOT EXISTS quota_calls_user ON ai.quota_calls(user_id,started_at)`;
    await db`CREATE INDEX IF NOT EXISTS quota_calls_service ON ai.quota_calls(service_account_id,started_at)`;
    await db`CREATE TABLE IF NOT EXISTS ai.quota_resets (
      request_id UUID PRIMARY KEY, user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
      service_account_id UUID REFERENCES auth.service_accounts(id) ON DELETE CASCADE,
      scope TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      CHECK(num_nonnulls(user_id,service_account_id)=1)
    )`;
    await db`CREATE INDEX IF NOT EXISTS quota_resets_user ON ai.quota_resets(user_id,service_account_id,scope,created_at)`;
    await db`CREATE TABLE IF NOT EXISTS ai.quota_changes (
      revision INTEGER PRIMARY KEY, actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), config JSONB NOT NULL
    )`;
  });
}
