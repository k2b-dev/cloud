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
    await tx`ALTER TABLE code.version_submissions ADD COLUMN IF NOT EXISTS origin JSONB NOT NULL DEFAULT '{"kind":"cli"}'::jsonb`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.version_withdrawals (
      version_id UUID PRIMARY KEY REFERENCES code.version_submissions(version_id) ON DELETE CASCADE,
      withdrawn_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      withdrawn_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`.simple();
    // No FK to approvals.requests: pruning transient questions must not erase durable decision evidence.
    await tx`CREATE TABLE IF NOT EXISTS code.version_decisions (
      version_id UUID PRIMARY KEY REFERENCES code.version_submissions(version_id) ON DELETE CASCADE,
      binding JSONB NOT NULL, approved BOOLEAN NOT NULL, sole_admin BOOLEAN NOT NULL,
      decided_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      decided_at TIMESTAMPTZ NOT NULL DEFAULT now(), decided_via TEXT NOT NULL,
      decided_device_id UUID, auth_epoch BIGINT NOT NULL
    )`.simple();
    // Backfill once before reinstalling the immutable-evidence guard.
    await tx`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='code' AND table_name='version_decisions' AND column_name='outcome') THEN
        DROP TRIGGER IF EXISTS immutable_decision ON code.version_decisions;
        ALTER TABLE code.version_decisions ADD COLUMN outcome TEXT, ADD COLUMN comment TEXT;
        UPDATE code.version_decisions SET outcome=CASE WHEN approved THEN 'approved' ELSE 'rejected' END;
        ALTER TABLE code.version_decisions ALTER COLUMN outcome SET NOT NULL;
        ALTER TABLE code.version_decisions ADD CONSTRAINT version_decision_outcome CHECK (
          outcome IN ('approved','changes_requested','rejected') AND approved=(outcome='approved'));
      END IF;
    END $$`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.version_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      version_id UUID NOT NULL REFERENCES code.version_submissions(version_id) ON DELETE CASCADE,
      author_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      path TEXT NOT NULL, line INTEGER NOT NULL CHECK(line>0), body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 5000),
      parent_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(id,version_id), FOREIGN KEY(parent_id,version_id) REFERENCES code.version_comments(id,version_id)
    )`.simple();
    await tx`CREATE INDEX IF NOT EXISTS version_comments_page ON code.version_comments(version_id,created_at DESC,id DESC)`.simple();
    await tx`ALTER TABLE code.version_submissions ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'en'`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.review_notification_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), version_id UUID NOT NULL REFERENCES code.version_submissions(version_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('submitted','decided')),
      recipient_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
      recipient_cursor UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000', sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), claimed_until TIMESTAMPTZ, last_error TEXT
    )`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS review_notice_once ON code.review_notification_outbox(version_id,kind,recipient_cursor,COALESCE(recipient_id,'00000000-0000-0000-0000-000000000000'::uuid))`.simple();
    await tx`CREATE INDEX IF NOT EXISTS review_notice_order ON code.review_notification_outbox(version_id,sequence)`.simple();
    await tx`CREATE INDEX IF NOT EXISTS review_notice_busy ON code.review_notification_outbox(version_id,sequence) WHERE claimed_until IS NOT NULL OR attempts>0`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.review_chat_work (
      version_id UUID PRIMARY KEY REFERENCES code.version_submissions(version_id) ON DELETE CASCADE,
      code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
      conversation_id UUID NOT NULL, user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      state TEXT NOT NULL DEFAULT 'none' CHECK(state IN ('none','queued','running','submitted','completed','stopped','skipped')),
      reason TEXT, turn_id UUID, submitted_version_id UUID REFERENCES code.versions(id) ON DELETE SET NULL,
      decision_message_id UUID, activation_message_id UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`.simple();
    await tx`ALTER TABLE code.review_chat_work ADD COLUMN IF NOT EXISTS decision_suppressed BOOLEAN NOT NULL DEFAULT FALSE`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS review_chat_turn ON code.review_chat_work(turn_id) WHERE turn_id IS NOT NULL`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.review_chat_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), version_id UUID NOT NULL REFERENCES code.review_chat_work(version_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('decision','activation','revision')), sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), claimed_until TIMESTAMPTZ, last_error TEXT,
      UNIQUE(version_id,kind)
    )`.simple();
    await tx`CREATE INDEX IF NOT EXISTS review_chat_order ON code.review_chat_outbox(kind,version_id,sequence)`.simple();
    await tx`CREATE INDEX IF NOT EXISTS review_chat_sequence ON code.review_chat_outbox(kind,sequence)`.simple();
    await tx`CREATE INDEX IF NOT EXISTS review_chat_busy ON code.review_chat_outbox(kind,version_id,sequence) WHERE claimed_until IS NOT NULL OR attempts>0`.simple();
    await tx`CREATE OR REPLACE FUNCTION code.review_chat_live() RETURNS TRIGGER AS $$
    BEGIN
      IF to_regprocedure('ai.enqueue_live_for_user(uuid,uuid,text,text,text[])') IS NOT NULL THEN
        PERFORM ai.enqueue_live_for_user(gen_random_uuid(),NEW.user_id,NULL,NULL,ARRAY['code-versions','conversation-detail']::text[]);
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`.simple();
    await tx`CREATE OR REPLACE TRIGGER review_chat_live AFTER INSERT OR UPDATE ON code.review_chat_work
      FOR EACH ROW EXECUTE FUNCTION code.review_chat_live()`.simple();
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
    // Version evidence invalidates the submitting person's card in its own transaction,
    // independently of chat receipt delivery. A database without AI has no such viewers.
    await tx`CREATE OR REPLACE FUNCTION code.version_card_live() RETURNS TRIGGER AS $$
    BEGIN
      IF to_regprocedure('ai.enqueue_live_for_user(uuid,uuid,text,text,text[])') IS NULL THEN RETURN NEW; END IF;
      PERFORM ai.enqueue_live_for_user(gen_random_uuid(), (SELECT created_by FROM code.versions WHERE id=NEW.version_id),
        NULL, NULL, ARRAY['code-versions']::text[]);
      RETURN NEW;
    END $$ LANGUAGE plpgsql`.simple();
    await tx`CREATE OR REPLACE TRIGGER decision_live AFTER INSERT ON code.version_decisions
      FOR EACH ROW EXECUTE FUNCTION code.version_card_live();
      CREATE OR REPLACE TRIGGER withdrawal_live AFTER INSERT ON code.version_withdrawals
      FOR EACH ROW EXECUTE FUNCTION code.version_card_live();
      DROP FUNCTION IF EXISTS code.version_decision_live();`.simple();
  });
}
