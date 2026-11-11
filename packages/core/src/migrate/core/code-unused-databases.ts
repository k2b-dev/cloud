import type { SQL } from "bun";

/** Run inside the Code migration transaction. Existing unused databases get a full grace period. */
export async function migrateUnusedCodeDatabases(tx: SQL): Promise<void> {
  await tx`ALTER TABLE code.databases
    ADD COLUMN IF NOT EXISTS unused_since TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS unused_notice_key TEXT,
    ADD COLUMN IF NOT EXISTS last_access_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_size_bytes BIGINT CHECK(last_size_bytes>=0)`.simple();
  // Old mappings retain their namespace. Every new mapping has an immutable incarnation suffix.
  await tx`ALTER TABLE code.databases DROP CONSTRAINT IF EXISTS databases_namespace_check`.simple();
  await tx`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='code.databases'::regclass AND conname='databases_namespace_incarnation') THEN
      ALTER TABLE code.databases ADD CONSTRAINT databases_namespace_incarnation
        CHECK(namespace ~ ('^code_' || code_id || '(_[0-9a-f]{32})?$'));
    END IF;
  END $$`.simple();
  await tx`CREATE TABLE IF NOT EXISTS code.database_deletions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
    code_id TEXT NOT NULL, namespace TEXT NOT NULL UNIQUE, server_url TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_until TIMESTAMPTZ, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  await tx`CREATE INDEX IF NOT EXISTS database_deletions_sequence ON code.database_deletions(sequence)`.simple();
  await tx`CREATE INDEX IF NOT EXISTS database_deletions_busy ON code.database_deletions(code_id)
    WHERE claimed_until IS NOT NULL OR attempts>0`.simple();
  await tx`CREATE INDEX IF NOT EXISTS databases_unused ON code.databases(unused_since,code_id) WHERE unused_since IS NOT NULL`.simple();
  await tx`CREATE OR REPLACE FUNCTION code.database_is_unused(cid TEXT) RETURNS BOOLEAN AS $$
  DECLARE unused BOOLEAN;
  BEGIN
    SELECT EXISTS(SELECT 1 FROM code.codes c WHERE c.id=cid AND c.state IN ('draft','paused')
      AND NOT EXISTS(SELECT 1 FROM code.versions v WHERE v.code_id=c.id AND
        (v.id=c.active_version_id OR v.number=(SELECT max(number) FROM code.versions WHERE code_id=c.id))
        AND v.manifest->'database'='true'::jsonb)) INTO unused;
    IF NOT unused THEN RETURN FALSE; END IF;
    -- Activation has its own later migration. A pending rollback also protects its database.
    IF to_regclass('code.activations') IS NOT NULL THEN
      RETURN NOT EXISTS(SELECT 1 FROM code.activations a JOIN code.versions v ON v.id=a.version_id
        WHERE a.code_id=cid AND a.state IN ('pending','preflight','applying','waiting','rolling_back')
          AND v.manifest->'database'='true'::jsonb);
    END IF;
    RETURN TRUE;
  END $$ LANGUAGE plpgsql`.simple();
  await tx`CREATE OR REPLACE FUNCTION code.refresh_database_unused() RETURNS TRIGGER AS $$
  DECLARE cid TEXT; is_unused BOOLEAN;
  BEGIN
    IF TG_TABLE_NAME='codes' THEN cid := NEW.id; ELSE cid := NEW.code_id; END IF;
    -- Version saves serialize against deletion at the owning Code row. Activation writers
    -- already hold it before touching activations; the trigger must not reverse that order.
    IF TG_TABLE_NAME='versions' THEN PERFORM id FROM code.codes WHERE id=cid FOR UPDATE; END IF;
    is_unused := code.database_is_unused(cid);
    -- Unchanged status must not wait behind remote provisioning's mapping lock.
    UPDATE code.databases SET unused_since=CASE WHEN is_unused THEN clock_timestamp() ELSE NULL END,
      unused_notice_key=CASE WHEN is_unused THEN unused_notice_key ELSE NULL END
      WHERE code_id=cid AND (unused_since IS NULL)=is_unused;
    RETURN NEW;
  END $$ LANGUAGE plpgsql`.simple();
  await tx`CREATE OR REPLACE TRIGGER database_unused_code AFTER UPDATE OF state,active_version_id ON code.codes
    FOR EACH ROW EXECUTE FUNCTION code.refresh_database_unused();
    CREATE OR REPLACE TRIGGER database_unused_version AFTER INSERT ON code.versions
    FOR EACH ROW EXECUTE FUNCTION code.refresh_database_unused();
    CREATE OR REPLACE TRIGGER database_unused_mapping AFTER INSERT ON code.databases
    FOR EACH ROW EXECUTE FUNCTION code.refresh_database_unused()`.simple();
  await tx`UPDATE code.databases SET unused_since=clock_timestamp()
    WHERE unused_since IS NULL AND code.database_is_unused(code_id)`;
}
