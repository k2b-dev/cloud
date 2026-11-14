import { sql } from "../../runtime/clients";

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
  // Add a role recipient without rewriting any existing Action request or Assistant data.
  await sql`ALTER TABLE approvals.requests ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'action'`.simple();
  await sql`ALTER TABLE approvals.requests ADD COLUMN IF NOT EXISTS approver_role TEXT`.simple();
  await sql`ALTER TABLE approvals.requests ADD COLUMN IF NOT EXISTS author_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL`.simple();
  await sql`ALTER TABLE approvals.requests ADD COLUMN IF NOT EXISTS decided_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL`.simple();
  await sql`ALTER TABLE approvals.requests ADD COLUMN IF NOT EXISTS requester_href TEXT`.simple();
  await sql`ALTER TABLE approvals.requests ADD COLUMN IF NOT EXISTS sole_admin BOOLEAN NOT NULL DEFAULT false`.simple();
  await sql`ALTER TABLE approvals.requests ALTER COLUMN approver_user_id DROP NOT NULL`.simple();
  await sql`ALTER TABLE approvals.requests ALTER COLUMN subject_id DROP NOT NULL`.simple();
  await sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='approvals.requests'::regclass AND conname='requests_recipient_check') THEN
      ALTER TABLE approvals.requests ADD CONSTRAINT requests_recipient_check CHECK (
        (kind='action' AND subject_id IS NOT NULL AND approver_user_id IS NOT NULL AND approver_role IS NULL)
        OR (kind='code_version' AND subject_id IS NULL AND approver_user_id IS NULL AND approver_role IS NOT NULL AND approver_role='admin' AND assurance='confirm')
      );
      ALTER TABLE approvals.requests DROP CONSTRAINT requests_requester_kind_check;
      ALTER TABLE approvals.requests ADD CONSTRAINT requests_requester_kind_check
        CHECK ((kind='action' AND requester_kind IN ('assistant_turn','studio_app')) OR (kind='code_version' AND requester_kind='code_version'));
    END IF;
  END $$`.simple();
  await sql`CREATE INDEX IF NOT EXISTS approvals_requests_role_pending ON approvals.requests(approver_role, created_at) WHERE status='pending'`.simple();
  await sql`CREATE INDEX IF NOT EXISTS approvals_requests_expiry ON approvals.requests(expires_at)`.simple();
  await sql`ALTER TABLE approvals.requests ADD COLUMN IF NOT EXISTS decided_device_id UUID`.simple();
  // Backfill pending rows once at column creation; approved rows and older-release rows keep NULL and count as ended.
  await sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='approvals' AND table_name='requests' AND column_name='approver_auth_epoch') THEN
      ALTER TABLE approvals.requests ADD COLUMN approver_auth_epoch BIGINT;
      UPDATE approvals.requests r SET approver_auth_epoch=u.auth_epoch FROM auth.users u
        WHERE u.id=r.approver_user_id AND r.status='pending';
    END IF;
  END $$`.simple();
};
