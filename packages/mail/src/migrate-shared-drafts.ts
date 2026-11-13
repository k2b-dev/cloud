import { sql } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import { sharedDraftsSupported } from "./service/draft-document-log-policy";
import { setMailboxDraftEditMode } from "./service/draft-edit-mode";

export const SHARED_DRAFTS_MIGRATION_NAME = "shared_drafts_default";
// Match the existing reply-draft startup migration's 100-row transaction budget.
export const SHARED_DRAFTS_BATCH_SIZE = 100;
const log = logger("mail:migrate");
type Progress = { afterId: string; mailboxes: number; batches: number; completed: boolean };

/**
 * Runs after log preparation, outside schema DDL. The cursor commits with each setting update, so a
 * crash or another node resumes after completed work, including an administrator's later rollback.
 * Explicit administrator choices are excluded even before the cursor reaches them.
 * Only mailbox rows are locked; existing drafts are never visited or converted (the PATCH contract).
 */
export const migrateSharedDrafts = async (signal?: AbortSignal): Promise<Progress | null> => {
  if (!(await sharedDraftsSupported())) {
    log.warn("Shared draft default migration deferred: draft log preparation has not completed");
    return null;
  }
  for (;;) {
    signal?.throwIfAborted();
    const result = await sql.begin(async (tx): Promise<Progress> => {
      await tx`SET LOCAL lock_timeout = '10s'`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('cloud.mail.migrations', 0))`;
      await tx`INSERT INTO mail.shared_drafts_default_migration (name, details)
        VALUES (${SHARED_DRAFTS_MIGRATION_NAME},
          '{"afterId":"00000000-0000-0000-0000-000000000000","mailboxes":0,"batches":0,"completed":false}')
        ON CONFLICT (name) DO NOTHING`;
      const [marker] = await tx<{ details: Progress }[]>`SELECT details FROM mail.shared_drafts_default_migration
        WHERE name = ${SHARED_DRAFTS_MIGRATION_NAME} FOR UPDATE`;
      if (!marker) throw new Error("Shared draft migration marker is missing");
      if (marker.details.completed) return marker.details;
      const rows = await tx<{ id: string }[]>`SELECT id FROM mail.mailboxes
        WHERE id > ${marker.details.afterId}::uuid AND NOT draft_edit_mode_explicit ORDER BY id LIMIT ${SHARED_DRAFTS_BATCH_SIZE} FOR UPDATE`;
      if (rows.length)
        await setMailboxDraftEditMode(
          tx,
          rows.map((row) => row.id),
          "shared",
        );
      const progress: Progress = {
        afterId: rows.at(-1)?.id ?? marker.details.afterId,
        mailboxes: marker.details.mailboxes + rows.length,
        batches: marker.details.batches + (rows.length ? 1 : 0),
        completed: rows.length < SHARED_DRAFTS_BATCH_SIZE,
      };
      await tx`UPDATE mail.shared_drafts_default_migration SET details = ${progress}::jsonb
        WHERE name = ${SHARED_DRAFTS_MIGRATION_NAME}`;
      return progress;
    });
    if (result.completed) {
      log.info("Shared draft default migration completed", result);
      return result;
    }
  }
};
