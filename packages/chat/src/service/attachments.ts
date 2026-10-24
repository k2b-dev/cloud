import { err, fail, ok, type Result, ratelimit } from "@k2b/cloud/server";
import { audit } from "@k2b/cloud/services";
import { ImageMetadataError } from "@k2b/cloud/services/image-metadata";
import { crypto } from "@k2b/stdlib";
import { sql } from "bun";
import { auditActor, type ChatContext, messages, requireConversation, subjectPrincipal } from "./access";
import { prepareAttachmentContent } from "./attachment-content";
import { type AttachmentRow, projectAttachment } from "./attachment-store";
import {
  type AttachmentView,
  MAX_ATTACHMENT_BYTES,
  MAX_UNSENT_ATTACHMENTS,
  ThreadIdSchema,
  UPLOAD_LIMIT,
  UPLOAD_WINDOW_SECONDS,
} from "./contracts";
import { canReadThread } from "./thread-access";
import { findThread, threadNotFound } from "./threads";
import type { RateLimited } from "./write-rate";

const uploadLimit = ratelimit({ id: "chat.attachment.upload", limit: UPLOAD_LIMIT, windowSecs: UPLOAD_WINDOW_SECONDS });
type Input = ChatContext & { conversationId: string };
const notFound = (input: ChatContext) => fail({ code: "NOT_FOUND", status: 404, message: messages(input).attachmentNotFound });
type UploadError = { ok: false; error: string; code: "ATTACHMENT_TOO_LARGE" | "MALFORMED_IMAGE"; status: 413 | 422 };
const upload = async (
  input: Input & {
    filename: string;
    mimeType: string;
    content: Uint8Array;
    thread?: string;
  },
): Promise<Result<AttachmentView> | RateLimited | UploadError> => {
  const allowed = await requireConversation({ ...input, required: "write" });
  if (!allowed.ok) return allowed;
  if (input.content.byteLength > MAX_ATTACHMENT_BYTES)
    return { ok: false, code: "ATTACHMENT_TOO_LARGE", status: 413, error: messages(input).attachmentTooLarge };
  const filename = input.filename.trim();
  const mimeType = input.mimeType.split(";", 1)[0]!.trim().toLowerCase() || "application/octet-stream";
  if (
    !filename ||
    filename.length > 255 ||
    !filename.isWellFormed() ||
    /[\x00-\x1f\x7f]/.test(filename) ||
    mimeType.length > 255 ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType) ||
    (input.thread !== undefined && !ThreadIdSchema.safeParse(input.thread).success)
  )
    return fail(err.badInput(messages(input).attachmentInvalid));
  const subject = subjectPrincipal(input.accessSubject);
  const [pending] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM chat.attachments
    WHERE conversation_id = ${allowed.data.id}::uuid AND uploader_type = ${subject.type} AND uploader_id = ${subject.id}::uuid
      AND message_id IS NULL`;
  if (pending!.count >= MAX_UNSENT_ATTACHMENTS)
    return fail({ code: "ATTACHMENT_LIMIT", status: 409, message: messages(input).attachmentLimit });
  const limited = await uploadLimit.check(`${subject.type}:${subject.id}`);
  if (limited.limited)
    return {
      ok: false,
      error: messages(input).attachmentRateLimited,
      code: "RATE_LIMITED",
      status: 429,
      retryAfter: Math.max(1, Math.ceil(limited.resetIn / 1000)),
    };
  input.caller?.signal?.throwIfAborted();
  let prepared: Awaited<ReturnType<typeof prepareAttachmentContent>>;
  try {
    prepared = await prepareAttachmentContent(input.content, mimeType);
  } catch (error) {
    if (error instanceof ImageMetadataError) return { ok: false, code: error.code, status: 422, error: messages(input).malformedImage };
    throw error;
  }
  if (prepared.content.byteLength > MAX_ATTACHMENT_BYTES)
    return { ok: false, code: "ATTACHMENT_TOO_LARGE", status: 413, error: messages(input).attachmentTooLarge };
  return sql.begin(async (db): Promise<Result<AttachmentView>> => {
    await db`SELECT id FROM chat.conversations WHERE id = ${allowed.data.id}::uuid FOR UPDATE`;
    const current = await requireConversation({ ...input, required: "write" }, db);
    if (!current.ok) return current;
    if (input.thread) {
      const thread = await findThread(db, current.data.id, input.thread, input);
      if (!thread) return threadNotFound(input);
      if (thread.archived_at) return fail({ code: "THREAD_ARCHIVED", status: 409, message: messages(input).threadArchived });
    }
    const [count] = await db<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM chat.attachments
      WHERE conversation_id = ${current.data.id}::uuid AND uploader_type = ${subject.type} AND uploader_id = ${subject.id}::uuid
        AND message_id IS NULL`;
    if (count!.count >= MAX_UNSENT_ATTACHMENTS)
      return fail({ code: "ATTACHMENT_LIMIT", status: 409, message: messages(input).attachmentLimit });
    input.caller?.signal?.throwIfAborted();
    let row: AttachmentRow | undefined;
    for (let attempt = 0; attempt < 10 && !row; attempt++) {
      [row] = await db<AttachmentRow[]>`INSERT INTO chat.attachments
        (short_id, conversation_id, uploader_type, uploader_id, filename, mime_type, size_bytes, kind, width, height, content)
        VALUES (${crypto.common.readableId(6)}, ${current.data.id}::uuid, ${subject.type}, ${subject.id}::uuid,
          ${filename}, ${prepared.mimeType}, ${prepared.content.byteLength}, ${prepared.kind}, ${prepared.width}, ${prepared.height}, ${prepared.content})
        ON CONFLICT (short_id) DO NOTHING RETURNING id, short_id, filename, mime_type, size_bytes, kind, width, height, created_at`;
    }
    if (!row) throw new Error("Chat attachment ID could not be allocated");
    await audit.record(
      {
        action: "chat.attachment.upload",
        outcome: "allowed",
        actor: auditActor(input.actor),
        target: { type: "chat_conversation", id: input.conversationId },
        metadata: { attachmentId: row.short_id, uploaderType: subject.type, uploaderId: subject.id, requestId: input.requestId },
      },
      db,
    );
    return ok(projectAttachment(row, input.conversationId));
  });
};

const SLICE_BYTES = 256 * 1024;
const download = async (input: Input & { attachmentId: string }) => {
  const allowed = await requireConversation({ ...input, required: "read" });
  if (!allowed.ok) return allowed;
  const [row] = await sql<
    (AttachmentRow & {
      message_id: string | null;
      thread_id: string | null;
      uploader_type: string;
      uploader_id: string;
    })[]
  >`SELECT a.id, a.short_id, a.filename, a.mime_type, a.size_bytes, a.kind, a.width, a.height, a.created_at,
      a.message_id, a.uploader_type, a.uploader_id, m.thread_id
    FROM chat.attachments a LEFT JOIN chat.messages m ON m.id = a.message_id
    WHERE a.conversation_id = ${allowed.data.id}::uuid AND a.short_id = ${input.attachmentId}`;
  if (!row) return notFound(input);
  const subject = subjectPrincipal(input.accessSubject);
  if (
    row.message_id === null
      ? row.uploader_type !== subject.type || row.uploader_id !== subject.id
      : !(await canReadThread(sql, input, row.thread_id))
  )
    return notFound(input);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      async pull(controller) {
        if (offset >= row.size_bytes) {
          controller.close();
          return;
        }
        const [part] = await sql<
          { content: Uint8Array }[]
        >`SELECT substring(content FROM ${offset + 1}::int FOR ${SLICE_BYTES}::int) AS content
        FROM chat.attachments WHERE id = ${row.id}::uuid`;
        if (!part?.content.byteLength) {
          controller.error(new Error("Chat attachment is no longer available"));
          return;
        }
        const bytes = new Uint8Array(part.content);
        offset += bytes.byteLength;
        controller.enqueue(bytes);
        if (offset >= row.size_bytes) controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return ok({ attachment: projectAttachment(row, input.conversationId), stream });
};
export const attachments = { upload, download };
