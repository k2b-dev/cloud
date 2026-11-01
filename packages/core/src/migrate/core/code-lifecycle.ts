import { sql } from "@k2b/cloud";
import type { SQL } from "bun";

/** Add lifecycle delivery to the platform outbox and retain Code until cleanup has completed. */
export async function migrate(db: SQL = sql): Promise<void> {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.code.lifecycle.migrate',0))`;
    // Core consumes this kind across producers, while existing live/event indexes stay app-scoped.
    await tx`CREATE INDEX IF NOT EXISTS idx_events_outbox_core_sequence ON events.outbox(kind,seq)`.simple();
    await tx`CREATE INDEX IF NOT EXISTS idx_events_outbox_core_busy ON events.outbox(kind,ordering_key)
      WHERE claimed_until IS NOT NULL OR attempts>0`.simple();
    await tx`CREATE INDEX IF NOT EXISTS idx_events_outbox_code_owner ON events.outbox((payload->>'type'),(payload->>'id'))
      WHERE kind='code_owner_deleted'`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.cleanup_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
      code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('code.access.rm','code.delete')),
      grant_id UUID UNIQUE, target JSONB,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_until TIMESTAMPTZ, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK((kind='code.access.rm') = (grant_id IS NOT NULL AND target IS NOT NULL))
    )`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS cleanup_jobs_delete ON code.cleanup_jobs(code_id) WHERE kind='code.delete'`.simple();
    await tx`CREATE INDEX IF NOT EXISTS cleanup_jobs_sequence ON code.cleanup_jobs(kind,sequence)`.simple();
    await tx`CREATE INDEX IF NOT EXISTS cleanup_jobs_busy ON code.cleanup_jobs(kind,id) WHERE claimed_until IS NOT NULL OR attempts>0`.simple();
    await tx`CREATE INDEX IF NOT EXISTS cleanup_jobs_code ON code.cleanup_jobs(code_id,kind)`.simple();
    // A personal owner's ID remains an immutable tombstone until external cleanup finishes.
    // Attribution still uses SET NULL; deleting an activator must never delete resource Code.
    await tx`ALTER TABLE code.codes DROP CONSTRAINT IF EXISTS codes_owner_user_id_fkey`.simple();
    await tx`ALTER TABLE code.codes ALTER COLUMN created_at SET DEFAULT clock_timestamp()`.simple();
    // Replace FK admission while deferring deletion to durable cleanup. The key-share
    // lock serializes creation with user deletion, including previously absent Code.
    await tx`CREATE OR REPLACE FUNCTION code.guard_person_owner() RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.owner_kind='person' THEN
        PERFORM id FROM auth.users WHERE id=NEW.owner_user_id FOR KEY SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Code owner not found' USING ERRCODE='23503'; END IF;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`.simple();
    await tx`CREATE OR REPLACE TRIGGER valid_person_owner BEFORE INSERT ON code.codes
      FOR EACH ROW EXECUTE FUNCTION code.guard_person_owner()`.simple();
    await tx`CREATE OR REPLACE FUNCTION code.personal_owner_deleted() RETURNS TRIGGER AS $$
    DECLARE report_id UUID := gen_random_uuid();
    BEGIN
      -- Always report: a repeatable-read deletion snapshot may not see Code
      -- committed while it waited for the person's row lock.
      PERFORM events.enqueue(report_id,'core','code_owner_deleted',
        'person:' || OLD.id::text,jsonb_build_object('type','core.user','id',OLD.id::text));
      UPDATE events.outbox SET created_at=clock_timestamp() WHERE id=report_id;
      RETURN OLD;
    END $$ LANGUAGE plpgsql`.simple();
    await tx`CREATE OR REPLACE TRIGGER code_personal_owner_deleted BEFORE DELETE ON auth.users
      FOR EACH ROW EXECUTE FUNCTION code.personal_owner_deleted()`.simple();
  });
}
