import { toPgTextArray } from "@k2b/cloud/services";
import type { sql } from "bun";
import type { AttachmentView } from "./contracts";

export type AttachmentRow = {
  id: string;
  short_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  kind: "image" | "file";
  width: number | null;
  height: number | null;
  created_at: Date;
};
export const projectAttachment = (row: AttachmentRow, conversationId: string): AttachmentView => ({
  id: row.short_id,
  name: row.filename,
  mimeType: row.mime_type,
  size: Number(row.size_bytes),
  kind: row.kind,
  ...(row.width === null ? {} : { width: row.width }),
  ...(row.height === null ? {} : { height: row.height }),
  href: `/api/chat/conversations/${conversationId}/attachments/${row.short_id}`,
});

/** Only call with already authorized message rows. Never load attachment bytes for a projection. */
export const messageAttachments = async (db: typeof sql, messageIds: string[], conversationId: string) => {
  const rows = messageIds.length
    ? await db<(AttachmentRow & { message: string })[]>`
    SELECT a.id, a.short_id, a.filename, a.mime_type, a.size_bytes, a.kind, a.width, a.height, a.created_at, m.short_id AS message
    FROM chat.attachments a JOIN chat.messages m ON m.id = a.message_id
    JOIN chat.conversations c ON c.id = m.conversation_id
    WHERE m.short_id = ANY(${toPgTextArray(messageIds)}::text[]) AND c.short_id = ${conversationId}
    ORDER BY a.created_at, a.id`
    : [];
  const grouped = new Map<string, AttachmentView[]>();
  for (const row of rows) {
    const list = grouped.get(row.message) ?? [];
    list.push(projectAttachment(row, conversationId));
    grouped.set(row.message, list);
  }
  return grouped;
};
