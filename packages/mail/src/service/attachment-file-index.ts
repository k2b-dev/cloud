import { sql } from "@k2b/cloud";
import { backgroundWork, logger, startRuntimeInterval } from "@k2b/cloud/services";
import { MIN_LIST_IMAGE_BYTES } from "../attachment-preview-policy";

type SqlClient = typeof sql;
type SqlFragment = Bun.SQL.Query<unknown>;

/**
 * Mail offers its attachments to the shared file chooser as one read-only source. This index holds one row per
 * attachment a person would pick: mailbox, date, sender and file facts, so every folder of the source is one indexed
 * query. Rows follow their attachment (`ON DELETE CASCADE`), so hydration, which replaces a message's attachments,
 * replaces their rows too. Months are UTC: capabilities know no person's time zone, and a stored bucket needs one zone.
 * Every statement is idempotent and runs on each start.
 */
export const migrateAttachmentFiles = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE IF NOT EXISTS mail.attachment_files (
      attachment_id uuid PRIMARY KEY REFERENCES mail.attachments(id) ON DELETE CASCADE,
      mailbox_id uuid NOT NULL,
      message_id uuid NOT NULL,
      internal_date timestamptz NOT NULL,
      month date GENERATED ALWAYS AS ((date_trunc('month', internal_date AT TIME ZONE 'UTC'))::date) STORED,
      sender_email text NOT NULL,
      sender_name text,
      filename text,
      size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
      content_type text NOT NULL,
      blob_id uuid NOT NULL,
      disposition text
    )
  `.simple();
  // Years, months and senders group in this order; a sender's files read it newest first.
  await db`
    CREATE INDEX IF NOT EXISTS attachment_files_folder_idx
    ON mail.attachment_files (mailbox_id, month DESC, sender_email, internal_date DESC, attachment_id DESC)
  `.simple();
  // A message whose date moves updates its rows by message.
  await db`CREATE INDEX IF NOT EXISTS attachment_files_message_idx ON mail.attachment_files (message_id)`.simple();
  await db`
    CREATE TABLE IF NOT EXISTS mail.attachment_files_backfill (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      after_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
      indexed bigint NOT NULL DEFAULT 0,
      completed_at timestamptz
    )
  `.simple();
};

/**
 * Inline parts that the body references by Content-ID, and images below the list's signature-logo threshold, belong
 * to the message's look, not to the files someone passes on. The list's image previews leave out the same parts.
 */
const pickable = () => sql`
  NOT (a.disposition = 'inline' AND a.content_id IS NOT NULL)
  AND NOT (lower(btrim(split_part(a.content_type, ';', 1))) LIKE 'image/%' AND a.size_bytes < ${MIN_LIST_IMAGE_BYTES})
`;

/** One statement: the index rows of the attachments that `attachments` selects (a subquery of `id`). */
const insertAttachmentFiles = (db: SqlClient, attachments: SqlFragment) => db<{ attachment_id: string }[]>`
  INSERT INTO mail.attachment_files (
    attachment_id, mailbox_id, message_id, internal_date, sender_email, sender_name,
    filename, size_bytes, content_type, blob_id, disposition
  )
  SELECT a.id, mc.mailbox_id, mc.id, mc.internal_date, COALESCE(sender.normalized_email, ''),
    NULLIF(btrim(sender.display_name), ''), a.filename, a.size_bytes, a.content_type, a.blob_id, a.disposition
  FROM mail.attachments a
  JOIN mail.message_contents mc ON mc.id = a.message_id
  LEFT JOIN LATERAL (
    SELECT address.normalized_email, address.display_name
    FROM mail.message_addresses address
    WHERE address.message_id = mc.id AND address.role = 'from'
    ORDER BY address.position
    LIMIT 1
  ) sender ON true
  WHERE a.id IN (${attachments}) AND ${pickable()}
  ON CONFLICT (attachment_id) DO NOTHING
  RETURNING attachment_id
`;

/** Ingest calls this in the transaction that stores the message's attachments, after them and its addresses. */
export const indexMessageAttachments = async (db: SqlClient, messageId: string): Promise<void> => {
  await insertAttachmentFiles(db, sql`SELECT id FROM mail.attachments WHERE message_id = ${messageId}::uuid`);
};

// Match the existing startup migrations' 100-row transaction budget (shared drafts, reply drafts).
export const ATTACHMENT_FILES_BACKFILL_BATCH = 100;
const BACKFILL_INTERVAL_MS = 10 * 60_000;
const log = logger("mail:attachment-files");

export type AttachmentFileBackfill = { afterId: string; indexed: number; completed: boolean };

/**
 * Indexes the attachments stored before the index existed, one batch per transaction in attachment order. The cursor
 * commits with each batch, so a crash or another process resumes after finished work, and rows ingest already wrote
 * stay as they are. A batch holds its attachments `FOR KEY SHARE SKIP LOCKED`: only a delete locks an attachment row,
 * so a skipped one is on its way out (hydration's replacement indexes itself), and the batch never waits on, or
 * deadlocks with, a cascade that locks a message's attachments in another order. In maintenance „Ruhe“ it stops between
 * batches and answers `null` before the first; the next run resumes from the cursor.
 */
export const backfillAttachmentFiles = async (signal?: AbortSignal): Promise<AttachmentFileBackfill | null> => {
  let progress: AttachmentFileBackfill | null = null;
  for (;;) {
    signal?.throwIfAborted();
    if (backgroundWork.paused()) return progress;
    progress = await sql.begin(async (tx): Promise<AttachmentFileBackfill> => {
      await tx`SET LOCAL lock_timeout = '10s'`;
      await tx`INSERT INTO mail.attachment_files_backfill (singleton) VALUES (true) ON CONFLICT DO NOTHING`;
      const [marker] = await tx<{ after_id: string; indexed: string | number; completed_at: Date | null }[]>`
        SELECT after_id, indexed, completed_at FROM mail.attachment_files_backfill WHERE singleton FOR UPDATE
      `;
      if (!marker) throw new Error("Attachment file backfill marker is missing");
      if (marker.completed_at) return { afterId: marker.after_id, indexed: Number(marker.indexed), completed: true };
      const [batch] = await tx<{ last_id: string | null; scanned: number; indexed: number }[]>`
        WITH batch AS (
          SELECT id FROM mail.attachments WHERE id > ${marker.after_id}::uuid ORDER BY id LIMIT ${ATTACHMENT_FILES_BACKFILL_BATCH}
          FOR KEY SHARE SKIP LOCKED
        ), indexed AS (
          ${insertAttachmentFiles(tx, sql`SELECT id FROM batch`)}
        )
        SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS last_id,
          (SELECT count(*) FROM batch)::int AS scanned,
          (SELECT count(*) FROM indexed)::int AS indexed
      `;
      const next: AttachmentFileBackfill = {
        afterId: batch?.last_id ?? marker.after_id,
        indexed: Number(marker.indexed) + (batch?.indexed ?? 0),
        completed: (batch?.scanned ?? 0) < ATTACHMENT_FILES_BACKFILL_BATCH,
      };
      await tx`
        UPDATE mail.attachment_files_backfill
        SET after_id = ${next.afterId}::uuid, indexed = ${next.indexed},
          completed_at = CASE WHEN ${next.completed} THEN now() ELSE NULL END
        WHERE singleton
      `;
      return next;
    });
    if (progress.completed) return progress;
  }
};

let backfill: { stop(): Promise<void> } | undefined;

/** Runs the backfill after start and again after a failure or maintenance „Ruhe“; once finished, a run is one read. */
export const startAttachmentFileBackfill = (): void => {
  backfill ??= startRuntimeInterval({
    intervalMs: BACKFILL_INTERVAL_MS,
    run: async (signal) => {
      const progress = await backfillAttachmentFiles(signal);
      if (progress?.completed) log.debug("Mail attachment file index is complete", progress);
    },
    onError: (error) => log.warn("Mail attachment file backfill paused; the next run resumes it", { error: String(error) }),
  });
};

export const stopAttachmentFileBackfill = async (): Promise<void> => {
  const running = backfill;
  backfill = undefined;
  await running?.stop();
};
