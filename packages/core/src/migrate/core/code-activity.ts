import type { SQL } from "bun";

/** Invoked by the Code migration after runs/calls exist. No estimates or historical backfill. */
export async function migrateCodeActivity(tx: SQL): Promise<void> {
  await tx`ALTER TABLE code.calls ADD COLUMN IF NOT EXISTS replayed BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS confirmed_effect BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS code_id TEXT`.simple();
  await tx`ALTER TABLE code.runs ADD COLUMN IF NOT EXISTS effects_recorded BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS confirmed_effects JSONB NOT NULL DEFAULT '{}'::jsonb`.simple();
  await tx`CREATE TABLE IF NOT EXISTS code.activity_weeks (
    code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
    entrypoint TEXT NOT NULL, week TIMESTAMPTZ NOT NULL,
    counts JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY(code_id,entrypoint,week)
  )`.simple();
  // Existing history has no authoritative confirmation flags. Never invent historical effects.
  await tx`UPDATE code.runs SET effects_recorded=TRUE WHERE ended_at IS NOT NULL AND NOT effects_recorded`.simple();
  // The run UPDATE owns the snapshot and the single aggregate-row write. Retries of settlement do nothing.
  // UTC weeks give one durable definition regardless of the reader's display time zone.
  await tx`CREATE OR REPLACE FUNCTION code.record_activity() RETURNS TRIGGER AS $$
  DECLARE effects JSONB;
  BEGIN
    IF NOT NEW.effects_recorded AND NEW.ended_at IS NOT NULL THEN
      SELECT COALESCE(jsonb_object_agg(operation,n),'{}'::jsonb) INTO effects FROM (
        SELECT call->>'capability' AS operation,count(*)::bigint AS n FROM code.calls
        WHERE run_id=NEW.id AND confirmed_effect AND NOT replayed AND state='succeeded'
        GROUP BY call->>'capability'
      ) observed;
      NEW.confirmed_effects := effects;
      NEW.effects_recorded := TRUE;
      IF effects = OLD.confirmed_effects THEN RETURN NEW; END IF;
      INSERT INTO code.activity_weeks(code_id,entrypoint,week,counts)
      VALUES(NEW.code_id,NEW.entrypoint,date_trunc('week',NEW.ended_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',(SELECT COALESCE(jsonb_object_agg(key,n),'{}'::jsonb) FROM (SELECT key,sum(value::bigint) AS n FROM (SELECT key,value FROM jsonb_each_text(effects) UNION ALL SELECT key,(-value::bigint)::text FROM jsonb_each_text(OLD.confirmed_effects)) delta GROUP BY key) summed))
      ON CONFLICT(code_id,entrypoint,week) DO UPDATE SET counts=(
        SELECT COALESCE(jsonb_object_agg(key,n),'{}'::jsonb) FROM (
          SELECT key,sum(value::bigint) AS n FROM (
            SELECT key,value FROM jsonb_each_text(code.activity_weeks.counts)
            UNION ALL SELECT key,value FROM jsonb_each_text(EXCLUDED.counts)
          ) values_by_operation GROUP BY key
        ) combined
      );
    END IF;
    RETURN NEW;
  END $$ LANGUAGE plpgsql`.simple();
  await tx`CREATE OR REPLACE TRIGGER record_activity BEFORE UPDATE ON code.runs
    FOR EACH ROW WHEN (NEW.ended_at IS NOT NULL AND NOT NEW.effects_recorded) EXECUTE FUNCTION code.record_activity()`.simple();
  await tx`CREATE INDEX IF NOT EXISTS calls_recent_effects ON code.calls(code_id,ended_at DESC,run_id,ordinal)
    WHERE confirmed_effect AND NOT replayed AND state='succeeded'`.simple();
  await tx`CREATE INDEX IF NOT EXISTS calls_confirmed_effects ON code.calls(run_id,ended_at DESC)
    WHERE confirmed_effect AND NOT replayed AND state='succeeded'`.simple();
}
