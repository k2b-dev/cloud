import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { sql } from "bun";
import { sha256Text } from "./canonical";

const DEFAULT_CHUNK_SIZE = 1024 * 1024;

export type StoredBlob = {
  id: string;
  contentHash: string;
  byteLength: number;
  chunkSize: number;
  chunkCount: number;
};

export const getStoredBlob = async (blobId: string): Promise<StoredBlob> => {
  const [blob] = await sql<
    {
      id: string;
      content_hash: string;
      byte_length: string | number;
      chunk_size: number;
      chunk_count: number;
    }[]
  >`
    SELECT id, content_hash, byte_length, chunk_size, chunk_count
    FROM mail.message_part_blobs
    WHERE id = ${blobId}::uuid AND complete = true
  `;
  if (!blob) throw Object.assign(new Error("Stored mail blob is unavailable"), { code: "MAIL_BLOB_MISSING" });
  return {
    id: blob.id,
    contentHash: blob.content_hash,
    byteLength: Number(blob.byte_length),
    chunkSize: blob.chunk_size,
    chunkCount: blob.chunk_count,
  };
};

export const createBlobReadable = (blobId: string): Readable =>
  Readable.from(
    (async function* () {
      const blob = await getStoredBlob(blobId);
      let byteLength = 0;
      for (let position = 0; position < blob.chunkCount; position += 1) {
        const [chunk] = await sql<{ bytes: Uint8Array }[]>`
          SELECT bytes
          FROM mail.message_part_chunks
          WHERE blob_id = ${blobId}::uuid AND position = ${position}
        `;
        if (!chunk) throw Object.assign(new Error("Stored mail blob is incomplete"), { code: "MAIL_BLOB_INCOMPLETE" });
        const bytes = Buffer.from(chunk.bytes.buffer, chunk.bytes.byteOffset, chunk.bytes.byteLength);
        byteLength += bytes.length;
        yield bytes;
      }
      if (byteLength !== blob.byteLength) {
        throw Object.assign(new Error("Stored mail blob length does not match its metadata"), { code: "MAIL_BLOB_INCOMPLETE" });
      }
    })(),
    // Read ahead at most one 1 MiB chunk (Readable.from defaults to 16 objects).
    { highWaterMark: 1 },
  );

export const readStoredBlobPrefix = async (
  blobId: string,
  maxBytes: number,
): Promise<{ blob: StoredBlob; bytes: Uint8Array; truncated: boolean }> => {
  const boundedMaxBytes = Math.min(Math.max(Math.floor(maxBytes), 1), 4 * 1024 * 1024);
  const blob = await getStoredBlob(blobId);
  if (blob.byteLength === 0) return { blob, bytes: new Uint8Array(), truncated: false };

  const requiredBytes = Math.min(blob.byteLength, boundedMaxBytes);
  const requiredChunks = Math.ceil(requiredBytes / blob.chunkSize);
  const chunks = await sql<{ position: number; bytes: Uint8Array }[]>`
    SELECT position, bytes
    FROM mail.message_part_chunks
    WHERE blob_id = ${blobId}::uuid
      AND position >= 0
      AND position < ${requiredChunks}
    ORDER BY position
  `;
  const bytes = new Uint8Array(requiredBytes);
  let offset = 0;
  for (let position = 0; position < requiredChunks; position += 1) {
    const chunk = chunks[position];
    if (!chunk || chunk.position !== position) {
      throw Object.assign(new Error("Stored mail blob is incomplete"), { code: "MAIL_BLOB_INCOMPLETE" });
    }
    const available = Math.min(chunk.bytes.byteLength, requiredBytes - offset);
    bytes.set(chunk.bytes.subarray(0, available), offset);
    offset += available;
  }
  if (offset !== requiredBytes) {
    throw Object.assign(new Error("Stored mail blob is incomplete"), { code: "MAIL_BLOB_INCOMPLETE" });
  }
  return { blob, bytes, truncated: blob.byteLength > requiredBytes };
};

const insertChunk = async (blobId: string, position: number, bytes: Buffer): Promise<void> => {
  await sql`
    INSERT INTO mail.message_part_chunks (blob_id, position, bytes)
    VALUES (${blobId}::uuid, ${position}, ${bytes})
  `;
};

export const storeReadableBlob = async (stream: Readable, expectedSize?: number | null): Promise<StoredBlob> => {
  const temporaryHash = sha256Text(`pending:${randomUUID()}`);
  const [created] = await sql<{ id: string }[]>`
    INSERT INTO mail.message_part_blobs (content_hash, byte_length, chunk_size, chunk_count, complete)
    VALUES (${temporaryHash}, 0, ${DEFAULT_CHUNK_SIZE}, 0, false)
    RETURNING id
  `;
  if (!created) throw new Error("Blob allocation failed");

  const hasher = new Bun.CryptoHasher("sha256");
  let pending = Buffer.allocUnsafe(DEFAULT_CHUNK_SIZE);
  let filled = 0;
  let byteLength = 0;
  let chunkCount = 0;
  try {
    for await (const value of stream) {
      if (typeof value !== "string" && !(value instanceof Uint8Array)) {
        throw new TypeError("Mail blob stream chunks must be strings or bytes");
      }
      const chunk = typeof value === "string" ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      hasher.update(chunk);
      byteLength += chunk.length;
      let offset = 0;
      while (offset < chunk.length) {
        const copied = chunk.copy(pending, filled, offset, Math.min(chunk.length, offset + DEFAULT_CHUNK_SIZE - filled));
        filled += copied;
        offset += copied;
        if (filled === DEFAULT_CHUNK_SIZE) {
          await insertChunk(created.id, chunkCount, pending);
          chunkCount += 1;
          // A fresh buffer per stored chunk: nothing has to know when the driver let go of the last one.
          pending = Buffer.allocUnsafe(DEFAULT_CHUNK_SIZE);
          filled = 0;
        }
      }
    }
    if (filled > 0) {
      await insertChunk(created.id, chunkCount, pending.subarray(0, filled));
      chunkCount += 1;
    }
    if (expectedSize != null && expectedSize >= 0 && byteLength !== expectedSize) {
      throw Object.assign(new Error("Stream ended before the advertised byte count"), {
        code: "BLOB_SIZE_MISMATCH",
        expectedSize,
        byteLength,
      });
    }
    const contentHash = hasher.digest("hex");
    try {
      const finalized = await sql.begin(async (tx) => {
        const [temporary] = await tx<{ id: string }[]>`
          SELECT id FROM mail.message_part_blobs WHERE id = ${created.id}::uuid AND complete = false FOR UPDATE
        `;
        if (!temporary) throw new Error("Blob upload claim was lost");
        const [existing] = await tx<{ id: string; byte_length: string | number; chunk_size: number; chunk_count: number }[]>`
          SELECT id, byte_length, chunk_size, chunk_count
          FROM mail.message_part_blobs
          WHERE content_hash = ${contentHash} AND complete = true
          LIMIT 1
        `;
        if (existing) {
          await tx`DELETE FROM mail.message_part_blobs WHERE id = ${created.id}::uuid`;
          return {
            id: existing.id,
            contentHash,
            byteLength: Number(existing.byte_length),
            chunkSize: existing.chunk_size,
            chunkCount: existing.chunk_count,
          };
        }
        const [row] = await tx<{ id: string }[]>`
          UPDATE mail.message_part_blobs
          SET
            content_hash = ${contentHash},
            byte_length = ${byteLength},
            chunk_count = ${chunkCount},
            complete = true,
            completed_at = now()
          WHERE id = ${created.id}::uuid
          RETURNING id
        `;
        if (!row) throw new Error("Blob finalization returned no row");
        return { id: row.id, contentHash, byteLength, chunkSize: DEFAULT_CHUNK_SIZE, chunkCount };
      });
      return finalized;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "23505") throw error;
      const [existing] = await sql<{ id: string; byte_length: string | number; chunk_size: number; chunk_count: number }[]>`
        SELECT id, byte_length, chunk_size, chunk_count
        FROM mail.message_part_blobs
        WHERE content_hash = ${contentHash} AND complete = true
        LIMIT 1
      `;
      if (!existing) throw error;
      await sql`DELETE FROM mail.message_part_blobs WHERE id = ${created.id}::uuid AND complete = false`;
      return {
        id: existing.id,
        contentHash,
        byteLength: Number(existing.byte_length),
        chunkSize: existing.chunk_size,
        chunkCount: existing.chunk_count,
      };
    }
  } catch (error) {
    await sql`DELETE FROM mail.message_part_blobs WHERE id = ${created.id}::uuid AND complete = false`.catch(() => undefined);
    stream.destroy();
    throw error;
  }
};

export const deleteAbandonedBlobUploads = async (olderThanMinutes = 30): Promise<number> => {
  const boundedMinutes = Math.min(Math.max(Math.floor(olderThanMinutes), 5), 24 * 60);
  const result = await sql`
    DELETE FROM mail.message_part_blobs
    WHERE complete = false
      AND created_at < now() - (${boundedMinutes}::text || ' minutes')::interval
      AND NOT EXISTS (
        SELECT 1
        FROM mail.draft_attachment_uploads upload
        WHERE upload.blob_id = message_part_blobs.id
          AND upload.state IN ('uploading', 'uploaded')
      )
  `;
  return result.count;
};

export const deleteOrphanedBlobs = async (olderThanMinutes = 60): Promise<number> => {
  const boundedMinutes = Math.min(Math.max(Math.floor(olderThanMinutes), 5), 24 * 60);
  const result = await sql`
    DELETE FROM mail.message_part_blobs blob
    WHERE blob.complete = true
      AND blob.completed_at < now() - (${boundedMinutes}::text || ' minutes')::interval
      AND NOT EXISTS (
        SELECT 1 FROM mail.message_parts part WHERE part.blob_id = blob.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM mail.message_contents message WHERE message.source_blob_id = blob.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM mail.attachments attachment WHERE attachment.blob_id = blob.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM mail.outbox_submissions outbox WHERE outbox.mime_blob_id = blob.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM mail.draft_attachments draft_attachment WHERE draft_attachment.blob_id = blob.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM mail.draft_recovery_attachments recovery_attachment WHERE recovery_attachment.blob_id = blob.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM mail.draft_provider_snapshots snapshot WHERE snapshot.mime_blob_id = blob.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM mail.draft_attachment_uploads upload
        WHERE upload.blob_id = blob.id
          AND upload.state <> 'cancelled'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM mail.attachment_links link
        WHERE link.blob_id = blob.id
          AND link.revoked_at IS NULL
          AND (link.expires_at IS NULL OR link.expires_at > now())
      )
  `;
  return result.count;
};
