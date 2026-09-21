import { afterAll, beforeAll, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import {
  enqueueAttachmentExtraction,
  extractMailAttachmentBlob,
  loadAttachmentExtraction,
  MAIL_ATTACHMENT_EXTRACTOR_VERSION,
} from "./attachment-extraction";
import { storeReadableBlob } from "./message-blobs";

const suite = suiteFor("database", "nats");

suite("Mail attachment document extraction", () => {
  const mailboxId = crypto.randomUUID();
  const messageIds: string[] = [];
  const blobIds: string[] = [];

  const addAttachment = async (params: { bytes: Buffer; filename: string; contentType: string; contentHash: string }) => {
    const blob = await storeReadableBlob(Readable.from([params.bytes]), params.bytes.byteLength);
    if (!blobIds.includes(blob.id)) blobIds.push(blob.id);
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (
        short_id, mailbox_id, message_id, subject, internal_date, size_bytes,
        content_hash, hydration_status, plain_text, normalized_subject
      ) VALUES (
        ${newShortId()}, ${mailboxId}::uuid, ${`<attachment-extraction-${crypto.randomUUID()}@example.com>`},
        'Attachment extraction', now(), ${params.bytes.byteLength}, ${params.contentHash},
        'complete', 'Message body', 'attachment extraction'
      )
      RETURNING id
    `;
    if (!message) throw new Error("Failed to create extraction test message");
    messageIds.push(message.id);
    const [part] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_parts (
        message_id, part_path, content_type, disposition, filename, size_bytes, blob_id, hydration_status
      ) VALUES (
        ${message.id}::uuid, ${`attachment-${crypto.randomUUID()}`}, ${params.contentType}, 'attachment',
        ${params.filename}, ${params.bytes.byteLength}, ${blob.id}::uuid, 'complete'
      )
      RETURNING id
    `;
    const [attachment] = await sql<{ id: string }[]>`
      INSERT INTO mail.attachments (
        short_id, message_id, part_id, filename, content_type, disposition, checksum, size_bytes, blob_id
      ) VALUES (
        ${newShortId()}, ${message.id}::uuid, ${part!.id}::uuid, ${params.filename}, ${params.contentType},
        'attachment', ${blob.contentHash}, ${params.bytes.byteLength}, ${blob.id}::uuid
      )
      RETURNING id
    `;
    if (!attachment) throw new Error("Failed to create extraction test attachment");
    return { blob, message, attachment };
  };

  beforeAll(async () => {
    await migrate();
    await sql`
      INSERT INTO mail.mailboxes (id, short_id, name)
      VALUES (${mailboxId}::uuid, ${newShortId()}, 'Attachment extraction tests')
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (blobIds.length > 0) {
      await sql`DELETE FROM mail.message_part_blobs WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${blobIds}::jsonb))`;
    }
  });

  test("extracts once per blob and projects searchable chunks for every attachment", async () => {
    const bytes = Buffer.from("{\\rtf1\\ansi Quarterly attachment says cobalt roadmap milestone.}");
    const first = await addAttachment({
      bytes,
      filename: "roadmap.rtf",
      contentType: "application/rtf",
      contentHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
    });

    const extracted = await extractMailAttachmentBlob(first.blob.id, new AbortController().signal);
    expect(extracted).toMatchObject({ status: "complete", reused: false });
    const [projection] = await sql<{ status: string; markdown: string; attempt_count: number }[]>`
      SELECT status, markdown, attempt_count
      FROM mail.attachment_extractions
      WHERE blob_id = ${first.blob.id}::uuid AND extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
    `;
    expect(projection?.status).toBe("complete");
    expect(projection?.markdown).toContain("cobalt roadmap milestone");
    expect(projection?.attempt_count).toBe(1);
    expect(await loadAttachmentExtraction(first.attachment.id)).toMatchObject({
      status: "complete",
      format: "rtf",
      markdown: expect.stringContaining("cobalt roadmap milestone"),
      truncated: false,
    });
    const originalChunkIds = await sql<{ id: string }[]>`
      SELECT id::text AS id
      FROM mail.message_search_chunks
      WHERE attachment_id = ${first.attachment.id}::uuid
        AND extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
      ORDER BY position
    `;
    expect(originalChunkIds.length).toBeGreaterThan(0);

    const duplicate = await addAttachment({
      bytes,
      filename: "copy.rtf",
      contentType: "application/rtf",
      contentHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
    });
    expect(duplicate.blob.id).toBe(first.blob.id);
    await enqueueAttachmentExtraction(first.blob.id);
    const preservedChunkIds = await sql<{ id: string }[]>`
      SELECT id::text AS id
      FROM mail.message_search_chunks
      WHERE attachment_id = ${first.attachment.id}::uuid
        AND extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
      ORDER BY position
    `;
    expect(preservedChunkIds).toEqual(originalChunkIds);
    const [indexed] = await sql<{ attachments: number; blobs: number; matches: number }[]>`
      SELECT
        COUNT(DISTINCT attachment_id)::int AS attachments,
        COUNT(DISTINCT blob_id)::int AS blobs,
        COUNT(*) FILTER (
          WHERE search_document @@ plainto_tsquery('simple', 'cobalt milestone')
        )::int AS matches
      FROM mail.message_search_chunks
      WHERE source_kind = 'attachment'
        AND blob_id = ${first.blob.id}::uuid
        AND extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
    `;
    expect(indexed).toEqual({ attachments: 2, blobs: 1, matches: 2 });
  });

  test("uses a canonical CSV hint for a deduplicated blob regardless of attachment order", async () => {
    const bytes = Buffer.from("name,status\nAtlas,ready\n");
    const first = await addAttachment({
      bytes,
      filename: "upload.bin",
      contentType: "application/octet-stream",
      contentHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
    });
    const second = await addAttachment({
      bytes,
      filename: "status.csv ",
      contentType: "text/csv",
      contentHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
    });
    expect(second.blob.id).toBe(first.blob.id);

    const result = await extractMailAttachmentBlob(first.blob.id, new AbortController().signal);
    expect(result).toMatchObject({ status: "complete", reused: false });
    expect(await loadAttachmentExtraction(second.attachment.id)).toMatchObject({
      status: "complete",
      format: "csv",
      markdown: expect.stringContaining("Atlas"),
    });
  });

  test("persists unsupported files as terminal safe outcomes", async () => {
    const unsupported = await addAttachment({
      bytes: Buffer.from([0, 1, 2, 3, 4, 5]),
      filename: "unknown.bin",
      contentType: "application/octet-stream",
      contentHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
    });
    const result = await extractMailAttachmentBlob(unsupported.blob.id, new AbortController().signal);
    expect(result).toMatchObject({ status: "unsupported", reused: false, chunks: 0 });
    const [projection] = await sql<{ status: string; markdown: string | null; error_code: string }[]>`
      SELECT status, markdown, error_code
      FROM mail.attachment_extractions
      WHERE blob_id = ${unsupported.blob.id}::uuid AND extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
    `;
    expect(projection).toEqual({ status: "unsupported", markdown: null, error_code: "unsupported" });
  });
});
