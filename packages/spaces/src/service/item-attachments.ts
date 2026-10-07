import { sql } from "bun";
import {
  attachmentMediaType,
  MAX_TASK_ATTACHMENT_SIZE_BYTES,
  MAX_TASK_ATTACHMENTS,
  type MutationResult,
  type SpaceItemAttachment,
} from "@/contracts";
import { withShortId } from "../lib/short-id";
import { publishSpaceChange, spacesLive } from "./live";

const INLINE_IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

type AttachmentRow = {
  short_id: string;
  item_id: string;
  filename: string;
  mime_type: string;
  size_bytes: string | number;
  kind: "image" | "file";
  created_at: Date;
};

export type StoredSpaceItemAttachment = SpaceItemAttachment & { itemId: string };

const mapAttachment = (row: AttachmentRow): SpaceItemAttachment => ({
  id: row.short_id,
  filename: row.filename,
  mimeType: row.mime_type,
  sizeBytes: Number(row.size_bytes),
  kind: row.kind,
  createdAt: row.created_at.toISOString(),
});

export const list = async (params: { itemId: string }): Promise<SpaceItemAttachment[]> => {
  const rows = await sql<AttachmentRow[]>`
    SELECT short_id, item_id, filename, mime_type, size_bytes, kind, created_at
    FROM spaces.item_attachments
    WHERE item_id = ${params.itemId}::uuid
    ORDER BY created_at, id
  `;
  return rows.map(mapAttachment);
};

export const upload = async (params: {
  itemId: string;
  spaceId: string;
  filename: string;
  mimeType: string;
  content: Uint8Array;
  userId: string | null;
}): Promise<MutationResult<SpaceItemAttachment>> => {
  const filename = params.filename.trim();
  const mimeType = attachmentMediaType(filename, params.mimeType);
  if (!filename || filename.length > 255 || mimeType.length > 255) {
    return { ok: false, error: "Attachment metadata is invalid", status: 400 };
  }
  if (params.content.byteLength > MAX_TASK_ATTACHMENT_SIZE_BYTES) {
    return { ok: false, error: "File exceeds 10 MB limit", status: 400 };
  }

  const result = await withShortId("attachment", (shortId) =>
    sql.begin(async (tx): Promise<MutationResult<AttachmentRow>> => {
      const [item] = await tx<{ id: string; space_id: string; starts_at: Date | null; ends_at: Date | null }[]>`
        SELECT id, space_id, starts_at, ends_at
        FROM spaces.items
        WHERE id = ${params.itemId}::uuid
        FOR UPDATE
      `;
      if (!item || item.space_id !== params.spaceId) return { ok: false, error: "Task not found", status: 404 };
      if (item.starts_at || item.ends_at) return { ok: false, error: "Attachments are only available for tasks", status: 400 };

      const [count] = await tx<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM spaces.item_attachments
        WHERE item_id = ${params.itemId}::uuid
      `;
      if ((count?.count ?? 0) >= MAX_TASK_ATTACHMENTS) {
        return { ok: false, error: `A task can have at most ${MAX_TASK_ATTACHMENTS} attachments`, status: 409 };
      }

      const [created] = await tx<AttachmentRow[]>`
        INSERT INTO spaces.item_attachments
          (short_id, item_id, filename, mime_type, size_bytes, kind, content, created_by)
        VALUES
          (${shortId}, ${params.itemId}::uuid, ${filename}, ${mimeType}, ${params.content.byteLength},
           ${INLINE_IMAGE_TYPES.has(mimeType) ? "image" : "file"}, ${params.content}, ${params.userId}::uuid)
        RETURNING short_id, item_id, filename, mime_type, size_bytes, kind, created_at
      `;
      await publishSpaceChange(tx, { type: "item.updated", spaceId: params.spaceId, itemId: params.itemId });
      return { ok: true, data: created! };
    }),
  );

  if (!result.ok) return result;
  spacesLive.wake();
  return { ok: true, data: mapAttachment(result.data) };
};

export const getByShortId = async (params: { shortId: string }): Promise<StoredSpaceItemAttachment | null> => {
  const [row] = await sql<AttachmentRow[]>`
    SELECT short_id, item_id, filename, mime_type, size_bytes, kind, created_at
    FROM spaces.item_attachments
    WHERE short_id = ${params.shortId}
  `;
  return row ? { ...mapAttachment(row), itemId: row.item_id } : null;
};

/**
 * Content leaves the database in slices of this size, read while the client keeps reading. A client that stops early,
 * as a video tile does once it has its first frame, costs one or two slices instead of the whole attachment, and an
 * answer holds no more than this in memory.
 */
const CONTENT_SLICE_BYTES = 256 * 1024;

const readSlice = async (shortId: string, start: number, length: number): Promise<Uint8Array<ArrayBuffer> | null> => {
  const [row] = await sql<{ content: Uint8Array }[]>`
    SELECT substring(content FROM ${start + 1}::int FOR ${length}::int) AS content
    FROM spaces.item_attachments
    WHERE short_id = ${shortId}
  `;
  return row ? new Uint8Array(row.content) : null;
};

/**
 * Streams the content from `start` to `endExclusive` in slices; null when the attachment does not exist. An
 * attachment deleted while it streams ends the stream with an error, so the client sees a broken answer instead of a
 * short one.
 */
export const streamContent = async (params: {
  shortId: string;
  start: number;
  endExclusive: number;
}): Promise<ReadableStream<Uint8Array<ArrayBuffer>> | null> => {
  const slice = (offset: number) => readSlice(params.shortId, offset, Math.min(CONTENT_SLICE_BYTES, params.endExclusive - offset));
  const first = await slice(params.start);
  if (!first) return null;
  let offset = params.start + first.byteLength;
  return new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      start(controller) {
        if (first.byteLength > 0) controller.enqueue(first);
        if (offset >= params.endExclusive) controller.close();
      },
      async pull(controller) {
        const next = await slice(offset);
        if (!next?.byteLength) return controller.error(new Error("The attachment was deleted while it was read"));
        offset += next.byteLength;
        controller.enqueue(next);
        if (offset >= params.endExclusive) controller.close();
      },
    },
    // Read the next slice only once the client has taken the last one.
    { highWaterMark: 0 },
  );
};

export const remove = async (params: { shortId: string; itemId: string; spaceId: string }): Promise<MutationResult<void>> => {
  const deleted = await sql.begin(async (tx) => {
    const result = await tx`
      DELETE FROM spaces.item_attachments
      WHERE short_id = ${params.shortId}
        AND item_id = ${params.itemId}::uuid
    `;
    if (result.count > 0) await publishSpaceChange(tx, { type: "item.updated", spaceId: params.spaceId, itemId: params.itemId });
    return result.count > 0;
  });
  if (!deleted) return { ok: false, error: "Attachment not found", status: 404 };
  spacesLive.wake();
  return { ok: true, data: undefined };
};
