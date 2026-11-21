import type { SQL } from "bun";
import { sql } from "../runtime/clients";
import { logger } from "../services/logging";

const log = logger("ai:quotas");

const readTurnIndex = async (db: SQL) => {
  const [state] = await db<{ present: boolean; valid: boolean; building: boolean }[]>`
    SELECT to_regclass('ai.inference_calls_all_turn') IS NOT NULL AS present,
      EXISTS (SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid = to_regclass('ai.inference_calls_all_turn')
        AND indisvalid AND indisready AND indislive) AS valid,
      EXISTS (SELECT 1 FROM pg_catalog.pg_stat_progress_create_index progress
        WHERE progress.datname = pg_catalog.current_database()
          AND (progress.relid = to_regclass('ai.inference_calls') OR progress.relid IS NULL)) AS building`;
  return state ?? { present: false, valid: false, building: false };
};

const dropTurnIndex = (db: SQL) => db`DROP INDEX CONCURRENTLY IF EXISTS ai.inference_calls_all_turn`.simple();

/** Outside transactions, on a reserved connection so snapshot waits cannot trap
 * ordinary pool queries. Interrupted builds are replaced; active builds are
 * left alone. Failure is logged and retried at the next migration, never thrown. */
export async function ensureAiInferenceTurnIndex(db: SQL = sql): Promise<boolean> {
  try {
    const build = await db.reserve();
    try {
      const before = await readTurnIndex(build);
      if (before.valid) return true;
      if (before.building) return false;
      if (before.present) await dropTurnIndex(build);
      try {
        await build`CREATE INDEX CONCURRENTLY IF NOT EXISTS inference_calls_all_turn ON ai.inference_calls(turn_id)`.simple();
      } catch (error) {
        const after = await readTurnIndex(build);
        log.warn("Inference turn index build failed; retrying at the next migration", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (after.present && !after.valid && !after.building) await dropTurnIndex(build);
        return after.valid;
      }
      return (await readTurnIndex(build)).valid;
    } finally {
      build.release();
    }
  } catch (error) {
    log.warn("Inference turn index unavailable; retrying at the next migration", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

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
      kind TEXT NOT NULL CHECK(kind IN ('chat','background','live-transcription')), task TEXT NOT NULL,
      provider_model TEXT NOT NULL, app_id TEXT, conversation_id UUID, workflow_run_id UUID,
      step_key TEXT, trace_id TEXT, workflow_id UUID, workflow_name TEXT, workflow_version INTEGER, pricing JSONB, cost NUMERIC(30,12), reserved NUMERIC(30,12) NOT NULL DEFAULT 0,
      lease_expires_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL DEFAULT 'running', error_code TEXT,
      CHECK(cost IS NULL OR cost>=0), CHECK(reserved>=0),
      CHECK(input IS NULL OR input>=0), CHECK(output IS NULL OR output>=0)
    )`;
    await db`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai.inference_calls'::regclass
        AND conname = 'inference_calls_kind_check' AND position('''live-transcription''' in pg_get_constraintdef(oid)) = 0) THEN
        ALTER TABLE ai.inference_calls DROP CONSTRAINT inference_calls_kind_check;
        ALTER TABLE ai.inference_calls ADD CONSTRAINT inference_calls_kind_check CHECK(kind IN ('chat','background','live-transcription'));
      END IF;
    END $$`;
    await db`ALTER TABLE ai.inference_calls ADD COLUMN IF NOT EXISTS audio_ms INTEGER`;
    await db`ALTER TABLE ai.inference_calls ADD COLUMN IF NOT EXISTS credential_id UUID`;
    await db`ALTER TABLE ai.inference_calls ADD COLUMN IF NOT EXISTS estimated BOOLEAN NOT NULL DEFAULT false`;
    await db`ALTER TABLE ai.inference_calls ADD COLUMN IF NOT EXISTS cache_read BIGINT CHECK(cache_read IS NULL OR (cache_read>=0 AND cache_read<=input))`;
    await db`ALTER TABLE ai.inference_calls ADD COLUMN IF NOT EXISTS error TEXT`;
    await db`ALTER TABLE ai.inference_calls ADD COLUMN IF NOT EXISTS cancelled BOOLEAN NOT NULL DEFAULT false`;
    await db`ALTER TABLE ai.inference_calls ADD COLUMN IF NOT EXISTS request_started_at TIMESTAMPTZ`;
    await db`ALTER TABLE ai.inference_calls ADD COLUMN IF NOT EXISTS headers_ms INTEGER`;
    await db`ALTER TABLE ai.inference_calls ADD COLUMN IF NOT EXISTS first_byte_ms INTEGER`;
    await db`ALTER TABLE ai.inference_calls ADD COLUMN IF NOT EXISTS first_block_ms INTEGER`;
    // Stable Code attribution survives chat, turn and Code deletion; no Code schema dependency.
    await db`ALTER TABLE ai.inference_calls ADD COLUMN IF NOT EXISTS code_id TEXT`;
    await db`CREATE INDEX IF NOT EXISTS inference_calls_workflow ON ai.inference_calls(workflow_run_id,started_at)`;
    await db`CREATE INDEX IF NOT EXISTS inference_calls_started ON ai.inference_calls(started_at)`;
    await db`CREATE INDEX IF NOT EXISTS inference_calls_turn ON ai.inference_calls(turn_id,started_at,id) WHERE kind='chat'`;
    await db`CREATE INDEX IF NOT EXISTS inference_calls_compaction_turn ON ai.inference_calls(turn_id) WHERE task='chat-compaction'`;
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
  await ensureAiInferenceTurnIndex();
}
