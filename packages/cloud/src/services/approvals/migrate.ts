import { sql } from "bun";

export const migrateApprovals = async (): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS approvals`.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS approvals.requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      app_id TEXT NOT NULL,
      action TEXT NOT NULL,
      approval_scope TEXT,
      requester_kind TEXT NOT NULL CHECK (requester_kind IN ('assistant_turn','studio_app')),
      requester_ref TEXT NOT NULL,
      requester_app_id TEXT NOT NULL,
      requester_title TEXT,
      subject_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      approver_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      assurance TEXT NOT NULL CHECK (assurance IN ('standard','confirm')),
      sentence TEXT NOT NULL,
      details JSONB,
      args_digest TEXT NOT NULL,
      review_digest TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','cancelled','consumed')),
      decided_via TEXT CHECK (decided_via IS NULL OR decided_via IN ('web_session','app_session','oauth','api_key','invocation','acp_bridge','cloud_login')),
      decided_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      UNIQUE (requester_kind, requester_ref)
    )
  `.simple();
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='approvals.requests'::regclass
      AND conname='requests_decided_via_check' AND position('cloud_login' in pg_get_constraintdef(oid))=0) THEN
      ALTER TABLE approvals.requests DROP CONSTRAINT requests_decided_via_check;
      ALTER TABLE approvals.requests ADD CONSTRAINT requests_decided_via_check
        CHECK (decided_via IS NULL OR decided_via IN ('web_session','app_session','oauth','api_key','invocation','acp_bridge','cloud_login'));
    END IF;
  END $$`.simple();
  await sql`CREATE INDEX IF NOT EXISTS approvals_requests_pending ON approvals.requests(approver_user_id, created_at) WHERE status='pending'`.simple();
  await sql`CREATE INDEX IF NOT EXISTS approvals_requests_expiry ON approvals.requests(expires_at)`.simple();
  await sql`ALTER TABLE approvals.requests ADD COLUMN IF NOT EXISTS decided_device_id UUID`.simple();
  await sql`ALTER TABLE approvals.requests ADD COLUMN IF NOT EXISTS approver_auth_epoch BIGINT`.simple();
  // Stay nullable for rollback writes; backfill every start to repair open rows written by an older release.
  await sql`UPDATE approvals.requests r SET approver_auth_epoch=u.auth_epoch FROM auth.users u
    WHERE u.id=r.approver_user_id AND r.approver_auth_epoch IS NULL AND r.status IN ('pending','approved')`.simple();
};
