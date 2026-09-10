import type { Readable } from "node:stream";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import {
  type CreateDraftAttachmentUpload,
  createDraftAttachmentUploadSchema,
  type DraftAttachmentUpload,
  MAX_DRAFT_ATTACHMENT_BYTES,
  type MailDraft,
} from "../contracts";
import { withShortIdDb } from "../lib/short-id";
import { requireMailboxPermission } from "./access";
import { actorRefFromRequest, type MailRequestContext } from "./auth";
import { sha256Text } from "./canonical";
import { draftAttachmentCapacity, getDraft, sanitizeContentType, sanitizeFilename } from "./drafts";

export const DRAFT_UPLOAD_CHUNK_BYTES = 1024 * 1024;
const DRAFT_UPLOAD_TTL_HOURS = 24;
const CANCELLED_UPLOAD_RETENTION_DAYS = 7;

type UploadActor = { kind: "user" | "service_account"; id: string };

type DbUpload = {
  id: string;
  draft_id: string;
  blob_id: string | null;
  filename: string;
  content_type: string;
  byte_length: string | number;
  received_bytes: string | number;
  next_position: number;
  state: DraftAttachmentUpload["state"];
  attachment_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const uploadColumns = sql`
  upload.id,
  upload.draft_id,
  upload.blob_id,
  upload.filename,
  upload.content_type,
  upload.byte_length,
  upload.received_bytes,
  upload.next_position,
  upload.state,
  upload.attachment_id,
  upload.created_at,
  upload.updated_at
`;

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

const mapUploads = (rows: DbUpload[]): DraftAttachmentUpload[] =>
  rows.map((row) => ({
    id: row.id,
    draftId: row.draft_id,
    filename: row.filename,
    contentType: row.content_type,
    byteLength: Number(row.byte_length),
    receivedBytes: Number(row.received_bytes),
    chunkSize: DRAFT_UPLOAD_CHUNK_BYTES,
    state: row.state,
    attachmentId: row.attachment_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }));

const mapUpload = (row: DbUpload): DraftAttachmentUpload => mapUploads([row])[0]!;

const uploadActor = (context: MailRequestContext): UploadActor | null => {
  const actor = actorRefFromRequest(context);
  if (actor.kind === "user") return { kind: actor.kind, id: actor.userId };
  if (actor.kind === "service_account") return { kind: actor.kind, id: actor.serviceAccountId };
  return null;
};

const conflict = (message: string): Result<never> => fail({ code: "CONFLICT", message, status: 409 });

const validateSize = (value: number): Result<void> => {
  if (!Number.isSafeInteger(value) || value < 0) return fail(err.badInput("Attachment byte length is invalid"));
  if (value > MAX_DRAFT_ATTACHMENT_BYTES) return fail(err.badInput("Draft attachments cannot exceed 100 MiB"));
  return ok();
};

export const createDraftAttachmentUpload = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  input: CreateDraftAttachmentUpload;
}): Promise<Result<DraftAttachmentUpload>> => {
  const parsed = createDraftAttachmentUploadSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid attachment upload"));
  const size = validateSize(parsed.data.byteLength);
  if (!size.ok) return size;
  const actor = uploadActor(params.context);
  if (!actor) return fail(err.forbidden("Draft upload actor is invalid"));
  try {
    return await sql.begin(async (tx) => {
      const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write", tx);
      if (!allowed.ok) return allowed;
      const draftId = params.draftId;
      const [draft] = await tx<{ id: string; state: string }[]>`
        SELECT id, state FROM mail.drafts
        WHERE id = ${draftId}::uuid AND mailbox_id = ${params.mailboxId}::uuid AND origin = 'user'
        FOR SHARE
      `;
      if (!draft) return fail(err.notFound("Draft"));
      if (draft.state !== "draft") return fail(err.badInput("Draft can no longer accept attachments"));

      const temporaryHash = sha256Text(`pending-upload:${crypto.randomUUID()}`);
      const [blob] = await tx<{ id: string }[]>`
        INSERT INTO mail.message_part_blobs (content_hash, byte_length, chunk_size, chunk_count, complete)
        VALUES (${temporaryHash}, 0, ${DRAFT_UPLOAD_CHUNK_BYTES}, 0, false)
        RETURNING id
      `;
      if (!blob) return fail(err.internal("Attachment upload allocation failed"));
      const [upload] = await tx<DbUpload[]>`
        INSERT INTO mail.draft_attachment_uploads AS upload (
          draft_id, blob_id, filename, content_type, byte_length, state, creator_kind, creator_id
        ) VALUES (
          ${draftId}::uuid,
          ${blob.id}::uuid,
          ${sanitizeFilename(parsed.data.filename)},
          ${sanitizeContentType(parsed.data.contentType)},
          ${parsed.data.byteLength},
          ${parsed.data.byteLength === 0 ? "uploaded" : "uploading"},
          ${actor.kind},
          ${actor.id}::uuid
        )
        RETURNING ${uploadColumns}
      `;
      return upload ? ok(mapUpload(upload)) : fail(err.internal("Attachment upload insert returned no row"));
    });
  } catch {
    return fail(err.internal("Failed to create attachment upload"));
  }
};

export const listDraftAttachmentUploads = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
}): Promise<Result<DraftAttachmentUpload[]>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const draftId = params.draftId;
  const rows = await sql<DbUpload[]>`
    SELECT ${uploadColumns}
    FROM mail.draft_attachment_uploads upload
    JOIN mail.drafts draft ON draft.id = upload.draft_id
    WHERE upload.draft_id = ${draftId}::uuid
      AND draft.mailbox_id = ${params.mailboxId}::uuid
      AND draft.origin = 'user'
      AND upload.state IN ('uploading', 'uploaded', 'attached')
    ORDER BY upload.created_at, upload.id
  `;
  return ok(mapUploads(rows));
};

export const getDraftAttachmentUpload = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  uploadId: string;
}): Promise<Result<DraftAttachmentUpload>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const draftId = params.draftId;
  const [upload] = await sql<DbUpload[]>`
    SELECT ${uploadColumns}
    FROM mail.draft_attachment_uploads upload
    JOIN mail.drafts draft ON draft.id = upload.draft_id
    WHERE upload.id = ${params.uploadId}::uuid
      AND upload.draft_id = ${draftId}::uuid
      AND draft.mailbox_id = ${params.mailboxId}::uuid
      AND draft.origin = 'user'
  `;
  return upload ? ok(mapUpload(upload)) : fail(err.notFound("Draft attachment upload"));
};

export const appendDraftAttachmentUpload = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  uploadId: string;
  offset: number;
  bytes: Uint8Array;
}): Promise<Result<DraftAttachmentUpload>> => {
  if (!Number.isSafeInteger(params.offset) || params.offset < 0) return fail(err.badInput("Attachment upload offset is invalid"));
  if (params.bytes.byteLength < 1 || params.bytes.byteLength > DRAFT_UPLOAD_CHUNK_BYTES) {
    return fail(err.badInput("Attachment upload chunks must contain between 1 byte and 1 MiB"));
  }
  try {
    return await sql.begin(async (tx) => {
      const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write", tx);
      if (!allowed.ok) return allowed;
      const draftId = params.draftId;
      const [upload] = await tx<(DbUpload & { draft_state: string })[]>`
        SELECT ${uploadColumns}, draft.state AS draft_state
        FROM mail.draft_attachment_uploads upload
        JOIN mail.drafts draft ON draft.id = upload.draft_id
        WHERE upload.id = ${params.uploadId}::uuid
          AND upload.draft_id = ${draftId}::uuid
          AND draft.mailbox_id = ${params.mailboxId}::uuid
          AND draft.origin = 'user'
        FOR UPDATE OF upload, draft
      `;
      if (!upload) return fail(err.notFound("Draft attachment upload"));
      if (upload.draft_state !== "draft") return fail(err.badInput("Draft can no longer accept attachments"));
      if (upload.state !== "uploading") return conflict("Attachment upload is not accepting more chunks");
      if (!upload.blob_id) return fail(err.internal("Attachment upload has no writable blob"));
      const received = Number(upload.received_bytes);
      const expected = Number(upload.byte_length);
      if (params.offset !== received) return conflict(`Attachment upload expects offset ${received}`);
      if (received + params.bytes.byteLength > expected) return fail(err.badInput("Attachment chunk exceeds the declared byte length"));
      if (received + params.bytes.byteLength < expected && params.bytes.byteLength !== DRAFT_UPLOAD_CHUNK_BYTES) {
        return fail(err.badInput("Non-final attachment chunks must contain exactly 1 MiB"));
      }

      await tx`
        INSERT INTO mail.message_part_chunks (blob_id, position, bytes)
        VALUES (${upload.blob_id}::uuid, ${upload.next_position}, ${Buffer.from(params.bytes)})
      `;
      const nextReceived = received + params.bytes.byteLength;
      const [updated] = await tx<DbUpload[]>`
        UPDATE mail.draft_attachment_uploads upload
        SET
          received_bytes = ${nextReceived},
          next_position = next_position + 1,
          state = CASE WHEN ${nextReceived} = byte_length THEN 'uploaded' ELSE 'uploading' END
        WHERE upload.id = ${params.uploadId}::uuid
        RETURNING ${uploadColumns}
      `;
      await tx`
        UPDATE mail.message_part_blobs
        SET byte_length = ${nextReceived}, chunk_count = ${upload.next_position + 1}
        WHERE id = ${upload.blob_id}::uuid AND complete = false
      `;
      return updated ? ok(mapUpload(updated)) : fail(err.internal("Attachment upload update returned no row"));
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "23505") return conflict("Attachment upload chunk was already accepted");
    return fail(err.internal("Failed to append attachment upload"));
  }
};

const hashUpload = async (blobId: string, chunkCount: number, expectedBytes: number): Promise<Result<string>> => {
  const hasher = new Bun.CryptoHasher("sha256");
  let total = 0;
  for (let start = 0; start < chunkCount; start += 8) {
    const chunks = await sql<{ position: number; bytes: Uint8Array }[]>`
      SELECT position, bytes
      FROM mail.message_part_chunks
      WHERE blob_id = ${blobId}::uuid AND position BETWEEN ${start} AND ${Math.min(start + 7, chunkCount - 1)}
      ORDER BY position
    `;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk || chunk.position !== start + index) return fail(err.internal("Attachment upload is missing a chunk"));
      total += chunk.bytes.byteLength;
      hasher.update(chunk.bytes);
    }
    if (chunks.length !== Math.min(8, chunkCount - start)) return fail(err.internal("Attachment upload is missing a chunk"));
  }
  if (total !== expectedBytes) return fail(err.internal("Attachment upload byte length is inconsistent"));
  return ok(hasher.digest("hex"));
};

export const finalizeDraftAttachmentUpload = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  uploadId: string;
  expectedRevision: number;
}): Promise<Result<MailDraft>> => {
  if (!Number.isInteger(params.expectedRevision) || params.expectedRevision < 1) return fail(err.badInput("Invalid draft revision"));
  const actor = uploadActor(params.context);
  if (!actor) return fail(err.forbidden("Draft upload actor is invalid"));
  const permission = await requireMailboxPermission(params.context, params.mailboxId, "write");
  if (!permission.ok) return permission;
  const draftId = params.draftId;
  const [candidate] = await sql<(DbUpload & { mailbox_id: string })[]>`
    SELECT ${uploadColumns}, draft.mailbox_id
    FROM mail.draft_attachment_uploads upload
    JOIN mail.drafts draft ON draft.id = upload.draft_id
    WHERE upload.id = ${params.uploadId}::uuid
      AND upload.draft_id = ${draftId}::uuid
      AND draft.origin = 'user'
  `;
  if (!candidate || candidate.mailbox_id !== params.mailboxId) return fail(err.notFound("Draft attachment upload"));
  if (candidate.state === "attached") return getDraft(params.context, params.mailboxId, params.draftId);
  if (candidate.state !== "uploaded") return conflict("Attachment upload is not complete");
  if (!candidate.blob_id) return fail(err.internal("Attachment upload has no blob to finalize"));
  const contentHash = await hashUpload(candidate.blob_id, candidate.next_position, Number(candidate.byte_length));
  if (!contentHash.ok) return contentHash;

  try {
    const result = await sql.begin(async (tx): Promise<Result<void>> => {
      const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write", tx);
      if (!allowed.ok) return allowed;
      const [upload] = await tx<
        (DbUpload & { draft_revision: string | number; draft_state: string; draft_conversation_id: string | null })[]
      >`
        SELECT ${uploadColumns}, draft.revision AS draft_revision, draft.state AS draft_state, draft.conversation_id AS draft_conversation_id
        FROM mail.draft_attachment_uploads upload
        JOIN mail.drafts draft ON draft.id = upload.draft_id
        WHERE upload.id = ${params.uploadId}::uuid
          AND upload.draft_id = ${draftId}::uuid
          AND draft.mailbox_id = ${params.mailboxId}::uuid
          AND draft.origin = 'user'
        FOR UPDATE OF upload, draft
      `;
      if (!upload) return fail(err.notFound("Draft attachment upload"));
      if (upload.state === "attached") return ok();
      if (upload.state !== "uploaded") return conflict("Attachment upload is not complete");
      if (!upload.blob_id) return fail(err.internal("Attachment upload has no blob to finalize"));
      if (upload.draft_state !== "draft") return fail(err.badInput("Draft can no longer accept attachments"));
      if (Number(upload.draft_revision) !== params.expectedRevision) return conflict("Draft changed before the upload could be attached");
      const [totals] = await tx<{ count: string | number; bytes: string | number }[]>`
        SELECT count(*) AS count, COALESCE(sum(byte_length), 0) AS bytes
        FROM mail.draft_attachments
        WHERE draft_id = ${draftId}::uuid AND removed_at IS NULL
      `;
      const capacity = draftAttachmentCapacity({
        count: Number(totals?.count ?? 0) + 1,
        bytes: Number(totals?.bytes ?? 0) + Number(upload.byte_length),
      });
      if (!capacity.ok) return capacity;

      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${contentHash.data}, 0))`;
      const [existing] = await tx<{ id: string; byte_length: string | number }[]>`
        SELECT id, byte_length
        FROM mail.message_part_blobs
        WHERE content_hash = ${contentHash.data} AND complete = true
        LIMIT 1
      `;
      let blobId = upload.blob_id;
      if (existing) {
        if (Number(existing.byte_length) !== Number(upload.byte_length))
          return fail(err.internal("Attachment hash metadata is inconsistent"));
        blobId = existing.id;
        await tx`UPDATE mail.draft_attachment_uploads SET blob_id = ${blobId}::uuid WHERE id = ${upload.id}::uuid`;
        await tx`DELETE FROM mail.message_part_blobs WHERE id = ${upload.blob_id}::uuid AND complete = false`;
      } else {
        const finalized = await tx`
          UPDATE mail.message_part_blobs
          SET content_hash = ${contentHash.data}, complete = true, completed_at = now()
          WHERE id = ${upload.blob_id}::uuid
            AND complete = false
            AND byte_length = ${Number(upload.byte_length)}
            AND chunk_count = ${upload.next_position}
        `;
        if (finalized.count !== 1) return fail(err.internal("Attachment blob finalization failed"));
      }

      const [position] = await tx<{ position: number }[]>`
        SELECT COALESCE(MAX(position), -1)::int + 1 AS position
        FROM mail.draft_attachments
        WHERE draft_id = ${draftId}::uuid
      `;
      const attachmentRows = await withShortIdDb(
        tx,
        "draftAttachment",
        (db, shortId) => db<{ id: string }[]>`
        INSERT INTO mail.draft_attachments (short_id, draft_id, blob_id, filename, content_type, byte_length, content_hash, position)
        VALUES (
          ${shortId},
          ${draftId}::uuid,
          ${blobId}::uuid,
          ${upload.filename},
          ${upload.content_type},
          ${Number(upload.byte_length)},
          ${contentHash.data},
          ${position?.position ?? 0}
        )
        RETURNING id
      `,
      );
      const [attachment] = attachmentRows;
      if (!attachment) return fail(err.internal("Draft attachment insert returned no row"));
      const [updated] = await tx<{ revision: string | number }[]>`
        UPDATE mail.drafts
        SET
          revision = revision + 1,
          last_editor_kind = ${actor.kind},
          last_editor_id = ${actor.id}::uuid
        WHERE id = ${draftId}::uuid AND origin = 'user'
        RETURNING revision
      `;
      if (!updated) return fail(err.internal("Draft attachment update returned no row"));
      await tx`
        UPDATE mail.draft_attachment_uploads
        SET state = 'attached', attachment_id = ${attachment.id}::uuid, finalized_revision = ${Number(updated.revision)}, blob_id = ${blobId}::uuid
        WHERE id = ${upload.id}::uuid
      `;
      await tx`
        INSERT INTO mail.activity_events (
          mailbox_id, conversation_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
        ) VALUES (
          ${params.mailboxId}::uuid,
          ${upload.draft_conversation_id}::uuid,
          ${actor.kind},
          ${actor.id}::uuid,
          'draft.attachment_added',
          'confirmed',
          'draft_attachment',
          ${attachment.id}::uuid,
          ${{
            draftId,
            uploadId: upload.id,
            filename: upload.filename,
            byteLength: Number(upload.byte_length),
            contentHash: contentHash.data,
            revision: Number(updated.revision),
          }}::jsonb
        )
      `;
      return ok();
    });
    if (!result.ok) return result;
    return getDraft(params.context, params.mailboxId, params.draftId);
  } catch {
    return fail(err.internal("Failed to finalize attachment upload"));
  }
};

export const cancelDraftAttachmentUpload = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  uploadId: string;
}): Promise<Result<DraftAttachmentUpload>> => {
  try {
    return await sql.begin(async (tx) => {
      const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write", tx);
      if (!allowed.ok) return allowed;
      const draftId = params.draftId;
      const [upload] = await tx<DbUpload[]>`
        SELECT ${uploadColumns}
        FROM mail.draft_attachment_uploads upload
        JOIN mail.drafts draft ON draft.id = upload.draft_id
        WHERE upload.id = ${params.uploadId}::uuid
          AND upload.draft_id = ${draftId}::uuid
          AND draft.mailbox_id = ${params.mailboxId}::uuid
          AND draft.origin = 'user'
        FOR UPDATE OF upload
      `;
      if (!upload) return fail(err.notFound("Draft attachment upload"));
      if (upload.state === "attached") return conflict("An attached upload cannot be cancelled");
      if (upload.state === "cancelled") return ok(mapUpload(upload));
      const blobId = upload.blob_id;
      const [cancelled] = await tx<DbUpload[]>`
        UPDATE mail.draft_attachment_uploads upload
        SET state = 'cancelled', blob_id = NULL
        WHERE upload.id = ${upload.id}::uuid
        RETURNING ${uploadColumns}
      `;
      if (blobId) await tx`DELETE FROM mail.message_part_blobs WHERE id = ${blobId}::uuid AND complete = false`;
      return cancelled ? ok(mapUpload(cancelled)) : fail(err.internal("Attachment upload cancellation returned no row"));
    });
  } catch {
    return fail(err.internal("Failed to cancel attachment upload"));
  }
};

export const deleteAbandonedDraftAttachmentUploads = async (): Promise<number> => {
  return sql.begin(async (tx) => {
    const purged = await tx`
      DELETE FROM mail.draft_attachment_uploads
      WHERE id IN (
        SELECT id
        FROM mail.draft_attachment_uploads
        WHERE state = 'cancelled'
          AND updated_at < now() - (${CANCELLED_UPLOAD_RETENTION_DAYS}::text || ' days')::interval
        ORDER BY updated_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 500
      )
    `;
    const abandoned = await tx<{ id: string; blob_id: string | null }[]>`
      SELECT id, blob_id
      FROM mail.draft_attachment_uploads
      WHERE state IN ('uploading', 'uploaded')
        AND updated_at < now() - (${DRAFT_UPLOAD_TTL_HOURS}::text || ' hours')::interval
      FOR UPDATE SKIP LOCKED
      LIMIT 500
    `;
    if (abandoned.length === 0) return purged.count;
    const ids = abandoned.map((upload) => upload.id);
    await tx`
      UPDATE mail.draft_attachment_uploads
      SET state = 'cancelled', blob_id = NULL
      WHERE id = ANY(${sql.array(ids, "UUID")})
    `;
    const blobIds = abandoned.flatMap((upload) => (upload.blob_id ? [upload.blob_id] : []));
    if (blobIds.length === 0) return purged.count + abandoned.length;
    await tx`
      DELETE FROM mail.message_part_blobs
      WHERE id = ANY(${sql.array(blobIds, "UUID")})
        AND complete = false
    `;
    return purged.count + abandoned.length;
  });
};

const cancelUploadBestEffort = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  uploadId: string;
}): Promise<void> => {
  await cancelDraftAttachmentUpload(params).catch(() => undefined);
};

export const uploadDraftAttachmentStream = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  expectedRevision: number;
  filename: string;
  contentType: string;
  byteLength: number;
  stream: Readable;
}): Promise<Result<MailDraft>> => {
  const created = await createDraftAttachmentUpload({
    context: params.context,
    mailboxId: params.mailboxId,
    draftId: params.draftId,
    input: { filename: params.filename, contentType: params.contentType, byteLength: params.byteLength },
  });
  if (!created.ok) {
    params.stream.destroy();
    return created;
  }

  let upload = created.data;
  const cancel = () =>
    cancelUploadBestEffort({
      context: params.context,
      mailboxId: params.mailboxId,
      draftId: params.draftId,
      uploadId: upload.id,
    });
  try {
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    for await (const value of params.stream) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      let offset = 0;
      if (pending.byteLength > 0) {
        const required = DRAFT_UPLOAD_CHUNK_BYTES - pending.byteLength;
        if (bytes.byteLength < required) {
          pending = Buffer.concat([pending, bytes]);
          continue;
        }
        const appended = await appendDraftAttachmentUpload({
          context: params.context,
          mailboxId: params.mailboxId,
          draftId: params.draftId,
          uploadId: upload.id,
          offset: upload.receivedBytes,
          bytes: Buffer.concat([pending, bytes.subarray(0, required)]),
        });
        if (!appended.ok) {
          await cancel();
          return fail(appended.error);
        }
        upload = appended.data;
        pending = Buffer.alloc(0);
        offset = required;
      }
      while (bytes.byteLength - offset >= DRAFT_UPLOAD_CHUNK_BYTES) {
        const appended = await appendDraftAttachmentUpload({
          context: params.context,
          mailboxId: params.mailboxId,
          draftId: params.draftId,
          uploadId: upload.id,
          offset: upload.receivedBytes,
          bytes: bytes.subarray(offset, offset + DRAFT_UPLOAD_CHUNK_BYTES),
        });
        if (!appended.ok) {
          await cancel();
          return fail(appended.error);
        }
        upload = appended.data;
        offset += DRAFT_UPLOAD_CHUNK_BYTES;
      }
      if (offset < bytes.byteLength) pending = Buffer.from(bytes.subarray(offset));
    }
    if (pending.byteLength > 0) {
      if (upload.receivedBytes + pending.byteLength !== upload.byteLength) {
        await cancel();
        return fail(err.badInput("Attachment byte count did not match Content-Length"));
      }
      const appended = await appendDraftAttachmentUpload({
        context: params.context,
        mailboxId: params.mailboxId,
        draftId: params.draftId,
        uploadId: upload.id,
        offset: upload.receivedBytes,
        bytes: pending,
      });
      if (!appended.ok) {
        await cancel();
        return fail(appended.error);
      }
      upload = appended.data;
    }
    if (upload.receivedBytes !== upload.byteLength) {
      await cancel();
      return fail(err.badInput("Attachment byte count did not match Content-Length"));
    }
    const finalized = await finalizeDraftAttachmentUpload({
      context: params.context,
      mailboxId: params.mailboxId,
      draftId: params.draftId,
      uploadId: upload.id,
      expectedRevision: params.expectedRevision,
    });
    if (!finalized.ok) await cancel();
    return finalized;
  } catch {
    params.stream.destroy();
    await cancel();
    return fail(err.internal("Failed to stream draft attachment"));
  }
};
