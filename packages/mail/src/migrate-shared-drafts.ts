import { sql } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import { sharedDraftsSupported } from "./service/draft-document-log-policy";
import { setMailboxDraftEditMode } from "./service/draft-edit-mode";

export const SHARED_DRAFTS_MIGRATION_VERSION = 5;
export const SHARED_DRAFTS_MIGRATION_NAME = "shared_drafts_default";
// Match the existing reply-draft startup migration's 100-row transaction budget.
export const SHARED_DRAFTS_BATCH_SIZE = 100;
const log = logger("mail:migrate");
type Progress = { afterId: string; mailboxes: number; batches: number; completed: boolean };

/**
 * Runs after log preparation, outside schema DDL. The cursor commits with each setting update, so a
 * crash or another node resumes after completed work, including an administrator's later rollback.
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
      await tx`INSERT INTO mail.schema_migrations (version, name, details)
        VALUES (${SHARED_DRAFTS_MIGRATION_VERSION}, ${SHARED_DRAFTS_MIGRATION_NAME},
          '{"afterId":"00000000-0000-0000-0000-000000000000","mailboxes":0,"batches":0,"completed":false}')
        ON CONFLICT (version) DO NOTHING`;
      const [marker] = await tx<{ details: Progress }[]>`SELECT details FROM mail.schema_migrations
        WHERE version = ${SHARED_DRAFTS_MIGRATION_VERSION} FOR UPDATE`;
      if (!marker) throw new Error("Shared draft migration marker is missing");
      if (marker.details.completed) return marker.details;
      const rows = await tx<{ id: string }[]>`SELECT id FROM mail.mailboxes
        WHERE id > ${marker.details.afterId}::uuid ORDER BY id LIMIT ${SHARED_DRAFTS_BATCH_SIZE} FOR UPDATE`;
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
      await tx`UPDATE mail.schema_migrations SET details = ${progress}::jsonb
        WHERE version = ${SHARED_DRAFTS_MIGRATION_VERSION}`;
      return progress;
    });
    if (result.completed) {
      log.info("Shared draft default migration completed", result);
      return result;
    }
  }
};
