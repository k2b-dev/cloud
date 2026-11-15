import { sql } from "@k2b/cloud";
import type { SQL } from "bun";

/**
 * Members report a Code page to the Cloud's admins (concept gustav-ui-neu 3n). A report stays open until an admin
 * resolves it and goes with its Code. One open report per person and page; the key makes a resend file nothing twice.
 * Notices go out after commit through the outbox, to the admins page by page and back to the reporter.
 */
export async function migrate(db: SQL = sql): Promise<void> {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.code.page_reports.migrate',0))`;
    await tx`CREATE TABLE IF NOT EXISTS code.page_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
      reporter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      path TEXT NOT NULL CHECK (left(path,1)='/' AND char_length(path)<=2048 AND strpos(path,'?')=0),
      reason TEXT CHECK (reason IN ('security','suspicious','false_information','illegal','other')),
      text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
      locale TEXT NOT NULL,
      idempotency_key UUID NOT NULL,
      state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      resolved_at TIMESTAMPTZ,
      CHECK ((state='open') = (resolved_at IS NULL)),
      UNIQUE (reporter_id, idempotency_key)
    )`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS page_reports_open_once ON code.page_reports(reporter_id,code_id,path) WHERE state='open'`.simple();
    await tx`CREATE INDEX IF NOT EXISTS page_reports_code ON code.page_reports(code_id,state,created_at DESC,id DESC)`.simple();
    // The Administration count and the retention sweep each read one side of the state.
    await tx`CREATE INDEX IF NOT EXISTS page_reports_open ON code.page_reports(created_at) WHERE state='open'`.simple();
    await tx`CREATE INDEX IF NOT EXISTS page_reports_resolved ON code.page_reports(resolved_at,id) WHERE state='resolved'`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.page_report_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      report_id UUID NOT NULL REFERENCES code.page_reports(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('reported','resolved')),
      recipient_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
      recipient_cursor UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
      sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), claimed_until TIMESTAMPTZ, last_error TEXT
    )`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS page_report_notice_once ON code.page_report_outbox(report_id,kind,recipient_cursor,COALESCE(recipient_id,'00000000-0000-0000-0000-000000000000'::uuid))`.simple();
    await tx`CREATE INDEX IF NOT EXISTS page_report_notice_order ON code.page_report_outbox(report_id,sequence)`.simple();
    await tx`CREATE INDEX IF NOT EXISTS page_report_notice_busy ON code.page_report_outbox(report_id,sequence) WHERE claimed_until IS NOT NULL OR attempts>0`.simple();
  });
}
