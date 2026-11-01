import { sql } from "@k2b/cloud";
import type { SQL } from "bun";
/** Credential-free authoring work shares dispatch, capacity and wakeups with production runs. */
export async function migrate(db: SQL = sql) {
  await db.begin(async (tx) => {
    await tx`CREATE TABLE IF NOT EXISTS code.jobs(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),kind TEXT NOT NULL CHECK(kind IN('check','test','simulate')),
      owner_id UUID NOT NULL,state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN('queued','running','succeeded','failed','cancelled')),
      input TEXT,input_bytes INTEGER NOT NULL,output_bytes INTEGER NOT NULL,result JSONB,
      generation INTEGER NOT NULL DEFAULT 0,lease_key_hash TEXT,runner_instance_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),deadline_at TIMESTAMPTZ NOT NULL,
      lease_expires_at TIMESTAMPTZ)`;
    await tx`CREATE INDEX IF NOT EXISTS jobs_pending ON code.jobs(created_at,id) WHERE state='queued'`;
    await tx`CREATE INDEX IF NOT EXISTS jobs_owner ON code.jobs(owner_id) WHERE state IN('queued','running')`;
    await tx`CREATE TABLE IF NOT EXISTS code.dispatch_turn(singleton BOOLEAN PRIMARY KEY CHECK(singleton),job_last BOOLEAN NOT NULL DEFAULT FALSE)`;
    await tx`INSERT INTO code.dispatch_turn(singleton) VALUES(TRUE) ON CONFLICT DO NOTHING`;
    await tx`CREATE TABLE IF NOT EXISTS code.job_outbox(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
      job_id UUID NOT NULL UNIQUE REFERENCES code.jobs(id) ON DELETE CASCADE,
      attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),claimed_until TIMESTAMPTZ,last_error TEXT)`;
    await tx`CREATE OR REPLACE FUNCTION code.wake_job() RETURNS TRIGGER AS $$ BEGIN
      IF NEW.state='queued' THEN INSERT INTO code.job_outbox(job_id) VALUES(NEW.id) ON CONFLICT DO NOTHING; END IF;
      RETURN NEW; END $$ LANGUAGE plpgsql`;
    await tx`CREATE OR REPLACE TRIGGER wake_job AFTER INSERT OR UPDATE OF state ON code.jobs FOR EACH ROW EXECUTE FUNCTION code.wake_job()`;
  });
}
