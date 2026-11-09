import { sql } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import {
  DRAFT_DOCUMENT_COVERAGE_LOCK,
  enableDraftDocumentPruning,
  mailDraftDocumentLog,
  requestDraftDocumentPrune,
  stopDraftDocumentPruning,
} from "./draft-document-log";

const log = logger("mail:draft-document-log-policy");
const PAGE_SIZE = 200;
let migrated = false;

/**
 * Explicit startup step that runs before Mail prunes the draft log.
 *
 * The platform changes an old log (discard oldest, seven-day age) in place to
 * keep every event, so stored cursors stay valid. Events the old age limit
 * already removed stay removed: a draft whose SQL snapshot is older than the
 * retained window and that has later events may have lost some of them, so it
 * goes to recovery instead of the gap tolerance that pruning relies on. This
 * runs once per database, before any process prunes; a crash before the
 * checkpoint repeats it.
 */
export const migrateDraftDocumentLogPolicy = async (): Promise<boolean> => {
  migrated = false;
  await stopDraftDocumentPruning();
  try {
    const topic = mailDraftDocumentLog.topic();
    await topic.ready();
    await sql.begin(async (db) => {
      await db`SELECT pg_advisory_xact_lock(${DRAFT_DOCUMENT_COVERAGE_LOCK})`;
      const [done] = await db`SELECT 1 FROM mail.draft_document_log_policy WHERE log_id = ${mailDraftDocumentLog.id}`;
      if (done) return;
      const first = await mailDraftDocumentLog.firstSequence();
      let last: string | null = null;
      for (;;) {
        const rows: { id: string; doc_seq: string | null }[] = await db`
          SELECT id, doc_seq FROM mail.drafts
          WHERE state NOT IN ('sent', 'discarded') AND (doc_state IS NOT NULL OR edit_mode = 'shared')
            AND doc_history_complete AND COALESCE(doc_seq, 0) + 1 < ${first}
            AND (${last}::uuid IS NULL OR id > ${last}::uuid)
          ORDER BY id LIMIT ${PAGE_SIZE}
        `;
        for (const row of rows) {
          const latest = await topic.latestCursor({ tenantId: row.id });
          if (latest && topic.cursorSequence(latest) > Number(row.doc_seq ?? 0))
            await db`UPDATE mail.drafts SET doc_history_complete = false WHERE id = ${row.id}::uuid`;
        }
        if (rows.length < PAGE_SIZE) break;
        last = rows.at(-1)?.id ?? null;
      }
      await db`INSERT INTO mail.draft_document_log_policy (log_id) VALUES (${mailDraftDocumentLog.id})`;
    });
    migrated = true;
    enableDraftDocumentPruning();
    requestDraftDocumentPrune();
    return true;
  } catch (error) {
    log.error("Shared drafts remain unsupported: the draft document log could not be prepared", { error });
    return false;
  }
};

/** True once this process prepared a log that keeps every event until Mail prunes it. */
export const sharedDraftsSupported = async (): Promise<boolean> => migrated;
