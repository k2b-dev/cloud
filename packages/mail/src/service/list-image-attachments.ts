import { sql } from "@k2b/cloud";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { attachmentPreviewKind, IMAGE_PREVIEW_CONTENT_TYPES, MAX_IMAGE_PREVIEW_BYTES } from "../attachment-preview-policy";
import { messageVisibleTo } from "./access";
import { attachmentMimeOrder } from "./attachment-order";
import type { MailRequestContext } from "./auth";
import { resolveMailExecution } from "./execution";

const MIN_LIST_IMAGE_BYTES = 4096;

/** SQL below applies the same rule before ranking, deduplication and counting. */
export const isListImageAttachment = (attachment: {
  contentType: string;
  sizeBytes: number;
  disposition: string | null;
  contentId: string | null;
}): boolean =>
  attachmentPreviewKind(attachment.contentType, attachment.sizeBytes) === "image" &&
  attachment.sizeBytes >= MIN_LIST_IMAGE_BYTES &&
  !(attachment.disposition === "inline" && attachment.contentId !== null);

type RowImages = {
  imageAttachments: { messageId: string; attachmentId: string }[];
  imageAttachmentCount: number;
};

/** One page, at most the listing's 100 rows; SQL returns at most three references per row. */
export const listRowImageAttachments = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  rows: { id: string; selectionKind: "conversation" | "message" }[];
}): Promise<Result<Map<string, RowImages>>> => {
  if (params.rows.length > 100) return fail(err.badInput("Too many Mail list rows"));
  if (!params.rows.length) return ok(new Map());
  const access = await resolveMailExecution({
    mailboxId: params.mailboxId,
    operation: "actorRead",
    conversationScoped: true,
    context: params.context,
  });
  if (!access.ok) return access;
  const visibility = access.data.access;
  if (!visibility) return fail(err.forbidden("Access denied"));

  const rows = await sql<{ id: string; images: RowImages["imageAttachments"] | string; count: number }[]>`
    WITH requested AS (
      SELECT DISTINCT id, "selectionKind" AS kind
      FROM jsonb_to_recordset(${params.rows}::jsonb) AS requested_row(id uuid, "selectionKind" text)
    ), target_messages AS (
      SELECT id AS row_id, kind, id AS message_id FROM requested WHERE kind = 'message'
      UNION ALL
      SELECT requested.id, requested.kind, cm.message_id
      FROM requested
      JOIN mail.conversation_messages cm ON cm.conversation_id = requested.id
      WHERE requested.kind = 'conversation'
    ), eligible AS (
      SELECT target.row_id, mc.id AS message_id, attachment.id AS attachment_id,
        row_number() OVER (
          PARTITION BY target.row_id
          ORDER BY mc.internal_date DESC, mc.id DESC, ${attachmentMimeOrder()}
        ) AS ordinal,
        CASE WHEN target.kind = 'conversation' THEN COALESCE(attachment.checksum, attachment.id::text)
          ELSE attachment.id::text END AS dedup_key
      FROM target_messages target
      JOIN mail.message_contents mc ON mc.id = target.message_id AND mc.mailbox_id = ${params.mailboxId}::uuid
      JOIN mail.attachments attachment ON attachment.message_id = mc.id
      JOIN mail.message_parts part ON part.id = attachment.part_id
      WHERE ${messageVisibleTo(visibility, sql`mc.id`)}
        AND lower(regexp_replace(split_part(attachment.content_type, ';', 1), '^[[:space:]]+|[[:space:]]+$', '', 'g')) IN (
          SELECT jsonb_array_elements_text(${IMAGE_PREVIEW_CONTENT_TYPES}::jsonb)
        )
        AND attachment.size_bytes BETWEEN ${MIN_LIST_IMAGE_BYTES} AND ${MAX_IMAGE_PREVIEW_BYTES}
        AND (attachment.disposition IS DISTINCT FROM 'inline' OR attachment.content_id IS NULL)
    ), unique_images AS (
      SELECT DISTINCT ON (row_id, dedup_key) * FROM eligible ORDER BY row_id, dedup_key, ordinal
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY row_id ORDER BY ordinal) AS rank FROM unique_images
    )
    SELECT row_id AS id, count(*)::int AS count,
      jsonb_agg(jsonb_build_object('messageId', message_id, 'attachmentId', attachment_id) ORDER BY ordinal)
        FILTER (WHERE rank <= 3) AS images
    FROM ranked GROUP BY row_id
  `;
  return ok(
    new Map(
      rows.map((row) => [
        row.id,
        {
          imageAttachments: typeof row.images === "string" ? JSON.parse(row.images) : row.images,
          imageAttachmentCount: row.count,
        },
      ]),
    ),
  );
};
