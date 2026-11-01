import { sql } from "@k2b/cloud";
import type { SQL } from "bun";

/** Additive Core migration. Existing AI/Assistant and workflow data are untouched. */
export const migrate = async (db: SQL = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.code.migrate', 0))`;
    await tx`CREATE SCHEMA IF NOT EXISTS code`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.codes (
      id TEXT PRIMARY KEY CHECK (id ~ '^c_[a-z0-9]{4,16}$'),
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('person','resource','app')),
      owner_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
      owner_type TEXT, owner_id TEXT, owner_app_id TEXT,
      title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
      service_account_id UUID UNIQUE REFERENCES auth.service_accounts(id) ON DELETE RESTRICT,
      state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','active','paused','deleting')),
      active_version_id UUID,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((owner_kind = 'person' AND owner_user_id IS NOT NULL AND owner_type IS NULL AND owner_id IS NULL AND owner_app_id IS NULL AND service_account_id IS NULL)
        OR (owner_kind = 'resource' AND owner_user_id IS NULL AND owner_type IS NOT NULL AND owner_id IS NOT NULL AND owner_app_id IS NULL AND service_account_id IS NOT NULL)
        OR (owner_kind = 'app' AND owner_user_id IS NULL AND owner_type IS NULL AND owner_id IS NULL AND owner_app_id IS NOT NULL AND service_account_id IS NOT NULL))
    )`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS codes_resource_owner ON code.codes(owner_type,owner_id) WHERE owner_kind = 'resource'`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS codes_app_owner ON code.codes(owner_app_id) WHERE owner_kind = 'app'`.simple();
    await tx`CREATE INDEX IF NOT EXISTS codes_person_owner ON code.codes(owner_user_id,id) WHERE owner_kind = 'person'`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.shares (
      code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
      access_id UUID NOT NULL UNIQUE REFERENCES auth.access(id) ON DELETE CASCADE,
      PRIMARY KEY (code_id,access_id)
    )`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
      number INTEGER NOT NULL CHECK (number > 0), source_files JSONB NOT NULL CHECK (jsonb_typeof(source_files) = 'object'),
      bundle TEXT NOT NULL, source_hash TEXT NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
      bundle_hash TEXT NOT NULL CHECK (bundle_hash ~ '^[a-f0-9]{64}$'),
      manifest JSONB CHECK (manifest IS NULL OR jsonb_typeof(manifest) = 'object'),
      source_bytes INTEGER NOT NULL CHECK (source_bytes >= 0), bundle_bytes INTEGER NOT NULL CHECK (bundle_bytes >= 0),
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (code_id,number), UNIQUE (id,code_id)
    )`.simple();
    await tx`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'code.codes'::regclass AND conname = 'codes_active_version_fk') THEN
        ALTER TABLE code.codes ADD CONSTRAINT codes_active_version_fk FOREIGN KEY(active_version_id,id)
          REFERENCES code.versions(id,code_id) ON DELETE SET NULL (active_version_id) DEFERRABLE INITIALLY DEFERRED;
      END IF;
    END $$`.simple();
    // The owner's title at its last check; history in other apps keeps naming the Code after this.
    await tx`ALTER TABLE code.codes ADD COLUMN IF NOT EXISTS owner_title TEXT`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
      version_id UUID NOT NULL, trigger TEXT NOT NULL CHECK (trigger IN ('manual','schedule','event','path')),
      entrypoint TEXT NOT NULL CHECK (char_length(entrypoint) BETWEEN 1 AND 512),
      state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed','cancelled','skipped')),
      outcome TEXT CHECK (outcome IS NULL OR outcome ~ '^[a-z][a-z0-9_]{0,127}$'),
      input JSONB NOT NULL DEFAULT 'null'::jsonb, output JSON,
      payload_bytes INTEGER NOT NULL CHECK (payload_bytes BETWEEN 1 AND 32768),
      calls_limit INTEGER NOT NULL CHECK (calls_limit BETWEEN 1 AND 1000),
      generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0), lease_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ,
      FOREIGN KEY (version_id,code_id) REFERENCES code.versions(id,code_id) ON DELETE CASCADE,
      CHECK ((state IN ('succeeded','failed','cancelled','skipped')) = (ended_at IS NOT NULL)),
      CHECK (ended_at IS NULL OR ended_at >= created_at),
      CHECK (octet_length(input::text) <= payload_bytes AND (output IS NULL OR octet_length(output::text) <= 262144))
    )`.simple();
    await tx`CREATE INDEX IF NOT EXISTS runs_code_history ON code.runs(code_id,created_at DESC,id DESC)`.simple();
    await tx`CREATE INDEX IF NOT EXISTS runs_retention ON code.runs(ended_at,id) WHERE ended_at IS NOT NULL`.simple();
    // json preserves exact result text: no exponent expansion or separator whitespace beyond CAPABILITY_MAX_RESULT_BYTES.
    await tx`CREATE TABLE IF NOT EXISTS code.calls (
      run_id UUID NOT NULL REFERENCES code.runs(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      kind TEXT NOT NULL CHECK (kind IN ('query','action')), call JSONB NOT NULL CHECK (jsonb_typeof(call) = 'object'), result JSON,
      state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','succeeded','failed')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(), ended_at TIMESTAMPTZ,
      PRIMARY KEY(run_id,ordinal), CHECK ((state = 'running') = (ended_at IS NULL))
    )`.simple();
    // These are observations, not steps: no replay keys or resume positions.
    await tx`CREATE OR REPLACE FUNCTION code.guard_call() RETURNS TRIGGER AS $$
    DECLARE run code.runs;
    BEGIN
      SELECT * INTO run FROM code.runs WHERE id = NEW.run_id FOR UPDATE;
      IF NEW.ordinal > run.calls_limit OR octet_length(NEW.call::text) > run.payload_bytes OR COALESCE(octet_length(NEW.result::text),0) > 262144 THEN
        RAISE EXCEPTION 'code call storage limit' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`.simple();
    await tx`CREATE OR REPLACE FUNCTION code.guard_version_update() RETURNS TRIGGER AS $$
    BEGIN
      -- FK erasure of attribution is the sole allowed update; the executable snapshot never changes.
      IF NEW.created_by IS NULL AND (to_jsonb(NEW) - 'created_by') = (to_jsonb(OLD) - 'created_by') THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'code versions are immutable' USING ERRCODE = '55000';
    END $$ LANGUAGE plpgsql`.simple();
    await tx`CREATE OR REPLACE FUNCTION code.guard_identity() RETURNS TRIGGER AS $$
    BEGIN
      IF (NEW.id,NEW.owner_kind,NEW.owner_user_id,NEW.owner_type,NEW.owner_id,NEW.owner_app_id,NEW.service_account_id)
        IS DISTINCT FROM (OLD.id,OLD.owner_kind,OLD.owner_user_id,OLD.owner_type,OLD.owner_id,OLD.owner_app_id,OLD.service_account_id) THEN
        RAISE EXCEPTION 'code identity is immutable' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`.simple();
    await tx`CREATE OR REPLACE FUNCTION code.guard_account() RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.service_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.service_accounts WHERE id = NEW.service_account_id
        AND kind = 'code' AND name = CASE WHEN NEW.owner_kind = 'app' THEN 'code:app:' || NEW.owner_app_id ELSE 'code:' || NEW.owner_type || ':' || NEW.owner_id END) THEN
        RAISE EXCEPTION 'invalid code account' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`.simple();
    await tx`CREATE OR REPLACE FUNCTION code.cleanup_deleted_code() RETURNS TRIGGER AS $$
    BEGIN
      DELETE FROM auth.service_accounts WHERE id = OLD.service_account_id;
      RETURN OLD;
    END $$ LANGUAGE plpgsql`.simple();
    // A removed junction erases its owned access entry; the code AFTER DELETE trigger erases its account.
    await tx`CREATE OR REPLACE FUNCTION code.cleanup_access() RETURNS TRIGGER AS $$
    BEGIN DELETE FROM auth.access WHERE id = OLD.access_id; RETURN OLD; END $$ LANGUAGE plpgsql`.simple();
    await tx`CREATE OR REPLACE FUNCTION code.guard_version_delete() RETURNS TRIGGER AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM code.codes WHERE id = OLD.code_id) THEN
        RAISE EXCEPTION 'delete the owning code instead of an immutable version' USING ERRCODE = '55000';
      END IF;
      RETURN OLD;
    END $$ LANGUAGE plpgsql`.simple();
    await tx`
        CREATE OR REPLACE TRIGGER immutable_version BEFORE UPDATE ON code.versions FOR EACH ROW EXECUTE FUNCTION code.guard_version_update();
        CREATE OR REPLACE TRIGGER immutable_identity BEFORE UPDATE ON code.codes FOR EACH ROW EXECUTE FUNCTION code.guard_identity();
        CREATE OR REPLACE TRIGGER valid_account BEFORE INSERT ON code.codes FOR EACH ROW EXECUTE FUNCTION code.guard_account();
        CREATE OR REPLACE TRIGGER deleted_code AFTER DELETE ON code.codes FOR EACH ROW EXECUTE FUNCTION code.cleanup_deleted_code();
        CREATE OR REPLACE TRIGGER deleted_access AFTER DELETE ON code.shares FOR EACH ROW EXECUTE FUNCTION code.cleanup_access();
        CREATE OR REPLACE TRIGGER bounded_call BEFORE INSERT OR UPDATE ON code.calls FOR EACH ROW EXECUTE FUNCTION code.guard_call();
        CREATE OR REPLACE TRIGGER immutable_version_delete BEFORE DELETE ON code.versions FOR EACH ROW EXECUTE FUNCTION code.guard_version_delete();
    `.simple();
  });
};
