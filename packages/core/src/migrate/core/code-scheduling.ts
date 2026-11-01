import { sql } from "@k2b/cloud";
import type { SQL } from "bun";

/** Durable admission, outbox and fleet telemetry. No ownership lives in a Core process. */
export async function migrate(db: SQL = sql): Promise<void> {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.code.scheduling.migrate',0))`;
    await tx`ALTER TABLE code.codes ADD COLUMN IF NOT EXISTS last_dispatched_at TIMESTAMPTZ`;
    await tx`ALTER TABLE code.runs ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS runner_instance_id UUID,
      ADD COLUMN IF NOT EXISTS effect_started BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS schedule_key TEXT, ADD COLUMN IF NOT EXISTS wake_at TIMESTAMPTZ`;
    await tx`CREATE INDEX IF NOT EXISTS runs_dispatch ON code.runs(code_id,created_at,id) WHERE state='queued'`;
    await tx`CREATE INDEX IF NOT EXISTS runs_running_code ON code.runs(code_id) WHERE state='running'`;
    await tx`CREATE INDEX IF NOT EXISTS runs_leases ON code.runs(lease_expires_at,id) WHERE state='running'`;
    await tx`CREATE INDEX IF NOT EXISTS runs_schedule ON code.runs(schedule_key) WHERE state IN ('queued','running')`;
    // Receipts deliberately outlive the 30-day run detail retention; they contain no input or result.
    await tx`CREATE TABLE IF NOT EXISTS code.run_requests (
      code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
      request_key TEXT NOT NULL CHECK(octet_length(request_key)<=256), run_id UUID NOT NULL,
      PRIMARY KEY(code_id,request_key)
    )`;
    await tx`CREATE TABLE IF NOT EXISTS code.run_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
      run_id UUID NOT NULL UNIQUE REFERENCES code.runs(id) ON DELETE CASCADE,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_until TIMESTAMPTZ, last_error TEXT
    )`;
    await tx`CREATE INDEX IF NOT EXISTS run_outbox_busy ON code.run_outbox(run_id,sequence)
      WHERE claimed_until IS NOT NULL OR attempts>0`;
    await tx`CREATE TABLE IF NOT EXISTS code.runner_instances (
      instance_id UUID PRIMARY KEY, free_slots INTEGER NOT NULL CHECK(free_slots>=0),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await tx`CREATE OR REPLACE FUNCTION code.wake_run() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.state='queued' THEN
          INSERT INTO code.run_outbox(run_id) VALUES(NEW.id) ON CONFLICT DO NOTHING;
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`;
    await tx`CREATE OR REPLACE TRIGGER wake_run AFTER INSERT OR UPDATE OF state ON code.runs
      FOR EACH ROW EXECUTE FUNCTION code.wake_run()`;
  });
}
