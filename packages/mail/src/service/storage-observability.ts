import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { type MailStorageSummary, mailStorageSummarySchema } from "../contracts";
import { isCurrentPlatformAdmin } from "./access";
import type { MailRequestContext } from "./auth";
import { mailScheduler } from "./mail-scheduler";

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

export const reconcileMailStorageUsage = async (): Promise<{ mailboxes: number }> => {
  return sql.begin(async (tx) => {
    const [claimed] = await tx<{ claimed: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended('cloud.mail.storage-usage', 0)) AS claimed
    `;
    if (!claimed?.claimed) return { mailboxes: 0 };

    const rows = await tx<
      {
        mailbox_id: string;
        message_count: string | number;
        message_bytes: string | number;
        received_attachment_bytes: string | number;
        draft_attachment_bytes: string | number;
        external_link_bytes: string | number;
      }[]
    >`
      WITH message_usage AS (
        SELECT mailbox_id, COUNT(*)::bigint AS message_count, COALESCE(SUM(size_bytes), 0)::bigint AS message_bytes
        FROM mail.message_contents
        GROUP BY mailbox_id
      ),
      attachment_usage AS (
        SELECT message.mailbox_id, COALESCE(SUM(attachment.size_bytes), 0)::bigint AS received_attachment_bytes
        FROM mail.attachments attachment
        JOIN mail.message_contents message ON message.id = attachment.message_id
        GROUP BY message.mailbox_id
      ),
      draft_usage AS (
        SELECT draft.mailbox_id, COALESCE(SUM(attachment.byte_length), 0)::bigint AS draft_attachment_bytes
        FROM mail.draft_attachments attachment
        JOIN mail.drafts draft ON draft.id = attachment.draft_id
        WHERE attachment.removed_at IS NULL
        GROUP BY draft.mailbox_id
      ),
      draft_upload_usage AS (
        SELECT draft.mailbox_id, COALESCE(SUM(upload.received_bytes), 0)::bigint AS active_upload_bytes
        FROM mail.draft_attachment_uploads upload
        JOIN mail.drafts draft ON draft.id = upload.draft_id
        WHERE upload.state IN ('uploading', 'uploaded')
        GROUP BY draft.mailbox_id
      ),
      link_usage AS (
        SELECT mailbox_id, COALESCE(SUM(byte_length), 0)::bigint AS external_link_bytes
        FROM mail.attachment_links
        WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
        GROUP BY mailbox_id
      )
      SELECT
        mailbox.id AS mailbox_id,
        COALESCE(message_usage.message_count, 0)::bigint AS message_count,
        COALESCE(message_usage.message_bytes, 0)::bigint AS message_bytes,
        COALESCE(attachment_usage.received_attachment_bytes, 0)::bigint AS received_attachment_bytes,
        (
          COALESCE(draft_usage.draft_attachment_bytes, 0)
          + COALESCE(draft_upload_usage.active_upload_bytes, 0)
        )::bigint AS draft_attachment_bytes,
        COALESCE(link_usage.external_link_bytes, 0)::bigint AS external_link_bytes
      FROM mail.mailboxes mailbox
      LEFT JOIN message_usage ON message_usage.mailbox_id = mailbox.id
      LEFT JOIN attachment_usage ON attachment_usage.mailbox_id = mailbox.id
      LEFT JOIN draft_usage ON draft_usage.mailbox_id = mailbox.id
      LEFT JOIN draft_upload_usage ON draft_upload_usage.mailbox_id = mailbox.id
      LEFT JOIN link_usage ON link_usage.mailbox_id = mailbox.id
      WHERE mailbox.deleted_at IS NULL
      ORDER BY mailbox.id
    `;

    for (const row of rows) {
      const messageBytes = Number(row.message_bytes);
      const receivedAttachmentBytes = Number(row.received_attachment_bytes);
      const draftAttachmentBytes = Number(row.draft_attachment_bytes);
      const externalLinkBytes = Number(row.external_link_bytes);
      await tx`
        INSERT INTO mail.storage_usage_snapshots (
          mailbox_id, message_count, message_bytes, received_attachment_bytes,
          draft_attachment_bytes, external_link_bytes, logical_total_bytes, calculated_at
        )
        VALUES (
          ${row.mailbox_id}::uuid,
          ${Number(row.message_count)},
          ${messageBytes},
          ${receivedAttachmentBytes},
          ${draftAttachmentBytes},
          ${externalLinkBytes},
          ${messageBytes + draftAttachmentBytes},
          now()
        )
        ON CONFLICT (mailbox_id) DO UPDATE SET
          message_count = EXCLUDED.message_count,
          message_bytes = EXCLUDED.message_bytes,
          received_attachment_bytes = EXCLUDED.received_attachment_bytes,
          draft_attachment_bytes = EXCLUDED.draft_attachment_bytes,
          external_link_bytes = EXCLUDED.external_link_bytes,
          logical_total_bytes = EXCLUDED.logical_total_bytes,
          calculated_at = EXCLUDED.calculated_at
      `;
    }
    await tx`
      DELETE FROM mail.storage_usage_snapshots snapshot
      WHERE NOT EXISTS (
        SELECT 1 FROM mail.mailboxes mailbox WHERE mailbox.id = snapshot.mailbox_id AND mailbox.deleted_at IS NULL
      )
    `;
    const [physical] = await tx<{ database_bytes: string | number; blob_bytes: string | number }[]>`
      SELECT
        COALESCE((
          SELECT SUM(pg_total_relation_size(class.oid))::bigint
          FROM pg_class class
          JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
          WHERE namespace.nspname = 'mail' AND class.relkind IN ('r', 'm')
        ), 0)::bigint AS database_bytes,
        COALESCE((SELECT SUM(blob.byte_length)::bigint FROM mail.message_part_blobs blob WHERE blob.complete), 0)::bigint AS blob_bytes
    `;
    await tx`
      INSERT INTO mail.storage_system_snapshot (singleton, physical_database_bytes, physical_blob_bytes, calculated_at)
      VALUES (true, ${Number(physical?.database_bytes ?? 0)}, ${Number(physical?.blob_bytes ?? 0)}, now())
      ON CONFLICT (singleton) DO UPDATE SET
        physical_database_bytes = EXCLUDED.physical_database_bytes,
        physical_blob_bytes = EXCLUDED.physical_blob_bytes,
        calculated_at = EXCLUDED.calculated_at
    `;
    return { mailboxes: rows.length };
  });
};

export const getMailStorageSummary = async (context: MailRequestContext): Promise<Result<MailStorageSummary>> => {
  if (!(await isCurrentPlatformAdmin(context))) return fail(err.forbidden("Cloud administration access is required"));
  const rows = await sql<
    {
      mailbox_id: string;
      mailbox_short_id: string;
      mailbox_name: string;
      message_count: string | number;
      message_bytes: string | number;
      received_attachment_bytes: string | number;
      draft_attachment_bytes: string | number;
      external_link_bytes: string | number;
      logical_total_bytes: string | number;
      calculated_at: Date | string;
    }[]
  >`
    SELECT
      snapshot.mailbox_id,
      mailbox.short_id AS mailbox_short_id,
      mailbox.name AS mailbox_name,
      snapshot.message_count,
      snapshot.message_bytes,
      snapshot.received_attachment_bytes,
      snapshot.draft_attachment_bytes,
      snapshot.external_link_bytes,
      snapshot.logical_total_bytes,
      snapshot.calculated_at
    FROM mail.storage_usage_snapshots snapshot
    JOIN mail.mailboxes mailbox ON mailbox.id = snapshot.mailbox_id AND mailbox.deleted_at IS NULL
    ORDER BY snapshot.logical_total_bytes DESC, mailbox.name, mailbox.id
  `;
  const [physical] = await sql<
    { physical_database_bytes: string | number; physical_blob_bytes: string | number; calculated_at: Date | string }[]
  >`
    SELECT physical_database_bytes, physical_blob_bytes, calculated_at
    FROM mail.storage_system_snapshot
    WHERE singleton
  `;
  try {
    return ok(
      mailStorageSummarySchema.parse({
        mailboxes: rows.map((row) => ({
          mailboxId: row.mailbox_short_id,
          mailboxName: row.mailbox_name,
          messageCount: Number(row.message_count),
          messageBytes: Number(row.message_bytes),
          receivedAttachmentBytes: Number(row.received_attachment_bytes),
          draftAttachmentBytes: Number(row.draft_attachment_bytes),
          externalLinkBytes: Number(row.external_link_bytes),
          logicalTotalBytes: Number(row.logical_total_bytes),
          calculatedAt: toIso(row.calculated_at),
        })),
        physicalDatabaseBytes: Number(physical?.physical_database_bytes ?? 0),
        physicalBlobBytes: Number(physical?.physical_blob_bytes ?? 0),
        calculatedAt: physical ? toIso(physical.calculated_at) : null,
      }),
    );
  } catch {
    return fail(err.internal("Mail storage snapshot is invalid"));
  }
};

export const requestMailStorageReconciliation = async (context: MailRequestContext): Promise<Result<{ queued: true }>> => {
  if (!(await isCurrentPlatformAdmin(context))) return fail(err.forbidden("Cloud administration access is required"));
  try {
    await mailScheduler().runNow({ id: "mail:storage-usage", requestId: context.requestId ?? crypto.randomUUID() });
    return ok({ queued: true });
  } catch {
    return fail(err.internal("Mail storage reconciliation is temporarily unavailable"));
  }
};
