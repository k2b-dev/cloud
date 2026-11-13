import { sql } from "@k2b/cloud";
import { invalidateDraftLeaseAfterSend } from "./draft-leases";
import { retireDraftProjectionInTransaction } from "./draft-provider-projection";
import { mailLive } from "./live";

/** Shared retirement boundary for discard and F6. Provider copies retire through the existing sweep. */
export const retireDraftInTransaction = async (db: typeof sql, draftId: string): Promise<string | null> => {
  // Marking the lifecycle first fences every document, upload, send and lease writer.
  await db`UPDATE mail.drafts SET state = 'discarded' WHERE id = ${draftId}::uuid AND state <> 'discarded'`;
  return retireDraftProjectionInTransaction({ db, draftId });
};

/** F6 is irreversible. Keep only the lifecycle tombstone required by outbox/provider audit references. */
export const eraseRetiredDraftInTransaction = async (db: typeof sql, draftId: string): Promise<void> => {
  await db`DELETE FROM mail.draft_attachment_uploads WHERE draft_id = ${draftId}::uuid`;
  await db`DELETE FROM mail.draft_attachments WHERE draft_id = ${draftId}::uuid`;
  await db`DELETE FROM mail.draft_recovery_copies WHERE draft_id = ${draftId}::uuid`;
  await db`DELETE FROM mail.draft_document_revisions WHERE draft_id = ${draftId}::uuid`;
  await db`DELETE FROM mail.draft_document_freezes WHERE draft_id = ${draftId}::uuid`;
  await db`DELETE FROM mail.draft_document_rests WHERE source_draft_id = ${draftId}::uuid OR rest_draft_id = ${draftId}::uuid`;
  await db`DELETE FROM mail.draft_suggestion_requests WHERE draft_id = ${draftId}::uuid`;
  await db`UPDATE mail.drafts SET body_markdown = '', subject = '', to_addresses = '[]', cc_addresses = '[]', bcc_addresses = '[]',
    doc_state = NULL, doc_cursor = NULL, doc_seq = NULL, doc_idle_through = NULL,
    doc_frozen_state = NULL, doc_frozen_cursor = NULL, doc_frozen_generation = NULL, doc_frozen_revision = NULL,
    doc_generation = doc_generation + 1, revision = revision + 1, consolidated_count = 0
    WHERE id = ${draftId}::uuid AND state = 'discarded'`;
  // Immutable copies are no longer needed for retrying export. Keep transport coordinates for remote retirement.
  await db`UPDATE mail.draft_provider_snapshots SET content_snapshot = '{}', mime_blob_id = NULL,
    state = CASE WHEN direction = 'export' AND state IN ('active', 'appending', 'retiring') THEN 'retiring' ELSE 'retired' END
    WHERE draft_id = ${draftId}::uuid`;
};

/** Sync is available only after setup. The SQL queue survives a restart between erase and lease invalidation. */
export const finishReplyDraftRetirements = async (): Promise<void> => {
  for (;;) {
    const rows = await sql<{ draft_id: string }[]>`SELECT draft_id FROM mail.reply_draft_retirements ORDER BY draft_id LIMIT 100`;
    if (!rows.length) break;
    for (const row of rows) {
      const invalidated = await invalidateDraftLeaseAfterSend(row.draft_id);
      if (!invalidated.ok) throw new Error(invalidated.error.message);
      await sql`DELETE FROM mail.reply_draft_retirements WHERE draft_id = ${row.draft_id}::uuid`;
    }
  }
  mailLive.wake();
};
