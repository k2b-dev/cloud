import { sql } from "@k2b/cloud";
import type { SQL } from "bun";

/** Additive C8 evidence; executable versions remain immutable and pending versions never replace active_version_id. */
export async function migrate(db: SQL = sql): Promise<void> {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.code.versions.migrate',0))`;
    await tx`CREATE TABLE IF NOT EXISTS code.version_submissions (
      version_id UUID PRIMARY KEY, code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
      binding JSONB NOT NULL, approval_id UUID, review_digest TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY(version_id,code_id) REFERENCES code.versions(id,code_id) ON DELETE CASCADE
    )`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS version_submission_approval ON code.version_submissions(approval_id) WHERE approval_id IS NOT NULL`.simple();
    // What Core saw at submission; null on versions submitted before it recorded this.
    await tx`ALTER TABLE code.version_submissions ADD COLUMN IF NOT EXISTS evidence JSONB`.simple();
    // No FK to approvals.requests: pruning transient questions must not erase durable decision evidence.
    await tx`CREATE TABLE IF NOT EXISTS code.version_decisions (
      version_id UUID PRIMARY KEY REFERENCES code.version_submissions(version_id) ON DELETE CASCADE,
      binding JSONB NOT NULL, approved BOOLEAN NOT NULL, sole_admin BOOLEAN NOT NULL,
      decided_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      decided_at TIMESTAMPTZ NOT NULL DEFAULT now(), decided_via TEXT NOT NULL,
      decided_device_id UUID, auth_epoch BIGINT NOT NULL
    )`.simple();
    // Last approved OR successfully self-activated snapshot, independent of whether it is still running.
    await tx`CREATE TABLE IF NOT EXISTS code.version_baselines (
      code_id TEXT PRIMARY KEY REFERENCES code.codes(id) ON DELETE CASCADE,
      version_id UUID NOT NULL, FOREIGN KEY(version_id,code_id) REFERENCES code.versions(id,code_id) ON DELETE CASCADE
    )`.simple();
    // A generated hint for reviewers, one per version and language; not evidence, so it stays out of the immutable rows.
    await tx`CREATE TABLE IF NOT EXISTS code.version_explanations (
      version_id UUID NOT NULL REFERENCES code.versions(id) ON DELETE CASCADE, locale TEXT NOT NULL, text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(version_id,locale)
    )`.simple();
    await tx`CREATE OR REPLACE FUNCTION code.guard_version_evidence() RETURNS TRIGGER AS $$
    BEGIN
      IF TG_TABLE_NAME='version_decisions' AND NEW.decided_by IS NULL
        AND (to_jsonb(NEW)-'decided_by')=(to_jsonb(OLD)-'decided_by') THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'code version evidence is immutable' USING ERRCODE='55000';
    END $$ LANGUAGE plpgsql`.simple();
    await tx`CREATE OR REPLACE TRIGGER immutable_submission BEFORE UPDATE ON code.version_submissions
      FOR EACH ROW EXECUTE FUNCTION code.guard_version_evidence();
      CREATE OR REPLACE TRIGGER immutable_decision BEFORE UPDATE ON code.version_decisions
      FOR EACH ROW EXECUTE FUNCTION code.guard_version_evidence();`.simple();
  });
}
