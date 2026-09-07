import type { Worker } from "@k2b/sync";
import { lazySync } from "@valentinkolb/cloud";
import {
  createRuntimeLifecycle,
  createRuntimeTaskTracker,
  logger,
  stopRuntimeJobs,
  stopRuntimeResources,
  syncOps,
  trace,
} from "@valentinkolb/cloud/services";
import {
  DOCUMENT_EXTRACTION_MAX_INPUT_BYTES,
  DocumentExtractionError,
  extractDocumentMarkdown,
} from "@valentinkolb/cloud/services/document-extraction";
import { sql } from "bun";
import { MAIL_ATTACHMENT_EXTRACTOR_VERSION } from "./attachment-extraction-contract";
import { sha256Text } from "./canonical";
import { createBlobReadable, getStoredBlob } from "./message-blobs";
import { splitSearchText } from "./search-chunks";

const unregisterSyncOps: Array<() => void> = [];

export { MAIL_ATTACHMENT_EXTRACTOR_VERSION } from "./attachment-extraction-contract";

const RECOVERY_BATCH_SIZE = 100;
const MAX_ATTEMPTS = 5;
const log = logger("mail:attachment-extraction");
const extractionTasks = createRuntimeTaskTracker();

export type MailAttachmentExtractionStatus =
  | "pending"
  | "complete"
  | "unsupported"
  | "encrypted"
  | "ocr_required"
  | "resource_limit"
  | "malformed"
  | "failed";

export type MailAttachmentExtraction = {
  status: MailAttachmentExtractionStatus;
  format: string | null;
  markdown: string | null;
  inputBytes: number | null;
  outputBytes: number | null;
  truncated: boolean;
  errorCode: string | null;
  updatedAt: string;
};

export type MailAttachmentExtractionMetadata = Omit<MailAttachmentExtraction, "markdown"> & {
  available: boolean;
  extractorVersion: string;
};

export type Utf8TextPage = {
  text: string;
  offset: number;
  length: number;
  totalBytes: number;
  nextOffset: number | null;
};

export class InvalidUtf8PageOffsetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUtf8PageOffsetError";
  }
}

type ExtractionResult = {
  status: Exclude<MailAttachmentExtractionStatus, "pending" | "failed">;
  reused: boolean;
  chunks: number;
};

type ExtractionRow = {
  status: MailAttachmentExtractionStatus;
  markdown: string | null;
  format: string | null;
  input_bytes: string | number | null;
  output_bytes: string | number | null;
  truncated: boolean;
};

const isUtf8ContinuationByte = (value: number | undefined): boolean => value !== undefined && (value & 0xc0) === 0x80;

export const sliceUtf8Text = (value: string, requestedOffset: number, requestedLength: number): Utf8TextPage => {
  const bytes = new TextEncoder().encode(value);
  const offset = Math.max(Math.floor(requestedOffset), 0);
  if (offset > bytes.byteLength) throw new InvalidUtf8PageOffsetError("Offset exceeds the extracted content length");
  if (offset < bytes.byteLength && isUtf8ContinuationByte(bytes[offset])) {
    throw new InvalidUtf8PageOffsetError("Offset must point to a UTF-8 character boundary");
  }
  let end = Math.min(offset + Math.max(Math.floor(requestedLength), 1), bytes.byteLength);
  while (end > offset && end < bytes.byteLength && isUtf8ContinuationByte(bytes[end])) end -= 1;
  if (end === offset && end < bytes.byteLength) {
    end += 1;
    while (end < bytes.byteLength && isUtf8ContinuationByte(bytes[end])) end += 1;
  }
  return {
    text: new TextDecoder().decode(bytes.subarray(offset, end)),
    offset,
    length: end - offset,
    totalBytes: bytes.byteLength,
    nextOffset: end < bytes.byteLength ? end : null,
  };
};

export const loadAttachmentExtractionMetadata = async (attachmentId: string): Promise<MailAttachmentExtractionMetadata | null> => {
  const [row] = await sql<
    {
      status: MailAttachmentExtractionStatus;
      format: string | null;
      input_bytes: string | number | null;
      output_bytes: string | number | null;
      truncated: boolean;
      error_code: string | null;
      updated_at: Date | string;
    }[]
  >`
    SELECT
      extraction.status,
      extraction.format,
      extraction.input_bytes,
      extraction.output_bytes,
      extraction.truncated,
      extraction.error_code,
      extraction.updated_at
    FROM mail.attachments attachment
    JOIN mail.attachment_extractions extraction
      ON extraction.blob_id = attachment.blob_id
     AND extraction.extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
    WHERE attachment.id = ${attachmentId}::uuid
  `;
  return row
    ? {
        status: row.status,
        format: row.format,
        inputBytes: row.input_bytes === null ? null : Number(row.input_bytes),
        outputBytes: row.output_bytes === null ? null : Number(row.output_bytes),
        truncated: row.truncated,
        errorCode: row.error_code,
        updatedAt: new Date(row.updated_at).toISOString(),
        available: row.status === "complete",
        extractorVersion: MAIL_ATTACHMENT_EXTRACTOR_VERSION,
      }
    : null;
};

export const loadAttachmentExtraction = async (attachmentId: string): Promise<MailAttachmentExtraction | null> => {
  const [row] = await sql<
    {
      status: MailAttachmentExtractionStatus;
      format: string | null;
      markdown: string | null;
      input_bytes: string | number | null;
      output_bytes: string | number | null;
      truncated: boolean;
      error_code: string | null;
      updated_at: Date | string;
    }[]
  >`
    SELECT
      extraction.status,
      extraction.format,
      extraction.markdown,
      extraction.input_bytes,
      extraction.output_bytes,
      extraction.truncated,
      extraction.error_code,
      extraction.updated_at
    FROM mail.attachments attachment
    JOIN mail.attachment_extractions extraction
      ON extraction.blob_id = attachment.blob_id
     AND extraction.extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
    WHERE attachment.id = ${attachmentId}::uuid
  `;
  return row
    ? {
        status: row.status,
        format: row.format,
        markdown: row.markdown,
        inputBytes: row.input_bytes === null ? null : Number(row.input_bytes),
        outputBytes: row.output_bytes === null ? null : Number(row.output_bytes),
        truncated: row.truncated,
        errorCode: row.error_code,
        updatedAt: new Date(row.updated_at).toISOString(),
      }
    : null;
};

export const attachmentExtractionStatusForError = (
  error: DocumentExtractionError,
): Exclude<MailAttachmentExtractionStatus, "pending" | "complete" | "failed"> | null => {
  if (error.code === "input_too_large") return "resource_limit";
  if (
    error.code === "unsupported" ||
    error.code === "encrypted" ||
    error.code === "ocr_required" ||
    error.code === "resource_limit" ||
    error.code === "malformed"
  ) {
    return error.code;
  }
  return null;
};

const readBlobBytes = async (blobId: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; inputBytes: number }> => {
  const blob = await getStoredBlob(blobId);
  if (blob.byteLength > DOCUMENT_EXTRACTION_MAX_INPUT_BYTES) {
    throw new DocumentExtractionError("input_too_large", "The attachment exceeds the document extraction limit.");
  }
  const bytes = new Uint8Array(blob.byteLength);
  let offset = 0;
  for await (const value of createBlobReadable(blobId)) {
    if (signal.aborted) throw new DocumentExtractionError("cancelled", "Document extraction was cancelled.");
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== blob.byteLength) throw Object.assign(new Error("Stored mail blob is incomplete"), { code: "MAIL_BLOB_INCOMPLETE" });
  return { bytes, inputBytes: blob.byteLength };
};

const filenameForBlob = async (blobId: string): Promise<string | null> => {
  const [attachment] = await sql<{ filename: string | null }[]>`
    SELECT filename
    FROM mail.attachments
    WHERE blob_id = ${blobId}::uuid
    ORDER BY
      CASE WHEN lower(btrim(COALESCE(filename, ''))) LIKE '%.csv' THEN 0 ELSE 1 END,
      lower(btrim(COALESCE(filename, ''))),
      id
    LIMIT 1
  `;
  return attachment?.filename ?? null;
};

const isCsvFilename = (filename: string | null): boolean => filename?.trim().toLowerCase().endsWith(".csv") ?? false;

const ATTACHMENT_PROJECTION_BATCH_SIZE = 100;

const projectCompleteExtraction = async (params: {
  blobId: string;
  markdown: string;
  format: string;
  inputBytes: number;
  outputBytes: number;
  truncated: boolean;
}): Promise<number> => {
  const stored = await sql.begin(async (tx) => {
    const [blob] = await tx<{ id: string }[]>`
      SELECT id FROM mail.message_part_blobs
      WHERE id = ${params.blobId}::uuid AND complete = true
      FOR SHARE
    `;
    if (!blob) return false;
    await tx`
      INSERT INTO mail.attachment_extractions (
        blob_id, extractor_version, status, format, markdown,
        input_bytes, output_bytes, truncated, error_code,
        attempt_count, next_attempt_at, updated_at, completed_at
      )
      VALUES (
        ${params.blobId}::uuid, ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}, 'complete', ${params.format}, ${params.markdown},
        ${params.inputBytes}, ${params.outputBytes}, ${params.truncated}, NULL,
        0, NULL, now(), now()
      )
      ON CONFLICT (blob_id, extractor_version) DO UPDATE SET
        status = 'complete',
        format = EXCLUDED.format,
        markdown = EXCLUDED.markdown,
        input_bytes = EXCLUDED.input_bytes,
        output_bytes = EXCLUDED.output_bytes,
        truncated = EXCLUDED.truncated,
        error_code = NULL,
        next_attempt_at = NULL,
        updated_at = now(),
        completed_at = now()
    `;
    return true;
  });
  if (!stored) return 0;

  const chunks = splitSearchText(params.markdown);
  if (chunks.length === 0) return 0;
  const attachments = await sql<{ id: string; message_id: string; mailbox_id: string }[]>`
    SELECT attachment.id, attachment.message_id, message.mailbox_id
    FROM mail.attachments attachment
    JOIN mail.message_contents message ON message.id = attachment.message_id
    WHERE attachment.blob_id = ${params.blobId}::uuid
      AND NOT EXISTS (
        SELECT 1
        FROM mail.message_search_chunks projected
        WHERE projected.source_kind = 'attachment'
          AND projected.attachment_id = attachment.id
          AND projected.extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
      )
    ORDER BY attachment.id
    LIMIT ${ATTACHMENT_PROJECTION_BATCH_SIZE}
  `;
  return sql.begin(async (tx) => {
    let insertedCount = 0;
    for (const attachment of attachments) {
      for (const [position, chunk] of chunks.entries()) {
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO mail.message_search_chunks (
            message_id, mailbox_id, position, search_document,
            source_kind, attachment_id, blob_id, extractor_version
          )
          VALUES (
            ${attachment.message_id}::uuid,
            ${attachment.mailbox_id}::uuid,
            ${position},
            to_tsvector('simple'::regconfig, ${chunk}),
            'attachment',
            ${attachment.id}::uuid,
            ${params.blobId}::uuid,
            ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
          )
          ON CONFLICT DO NOTHING
          RETURNING id
        `;
        insertedCount += inserted.length;
      }
    }
    return insertedCount;
  });
};

const persistTerminalStatus = async (
  blobId: string,
  status: Exclude<MailAttachmentExtractionStatus, "pending" | "complete" | "failed">,
): Promise<void> => {
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO mail.attachment_extractions (
        blob_id, extractor_version, status, error_code, completed_at, updated_at
      )
      VALUES (${blobId}::uuid, ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}, ${status}, ${status}, now(), now())
      ON CONFLICT (blob_id, extractor_version) DO UPDATE SET
        status = EXCLUDED.status,
        format = NULL,
        markdown = NULL,
        input_bytes = NULL,
        output_bytes = NULL,
        truncated = false,
        error_code = EXCLUDED.error_code,
        next_attempt_at = NULL,
        updated_at = now(),
        completed_at = now()
    `;
    await tx`
      DELETE FROM mail.message_search_chunks
      WHERE source_kind = 'attachment'
        AND blob_id = ${blobId}::uuid
        AND extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
    `;
  });
};

const markAttempt = async (blobId: string): Promise<void> => {
  await sql`
    INSERT INTO mail.attachment_extractions (blob_id, extractor_version, status, attempt_count, updated_at)
    VALUES (${blobId}::uuid, ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}, 'pending', 1, now())
    ON CONFLICT (blob_id, extractor_version) DO UPDATE SET
      status = 'pending',
      attempt_count = mail.attachment_extractions.attempt_count + 1,
      error_code = NULL,
      next_attempt_at = NULL,
      updated_at = now(),
      completed_at = NULL
  `;
};

const markTransientFailure = async (blobId: string): Promise<void> => {
  await sql`
    UPDATE mail.attachment_extractions
    SET
      status = 'failed',
      error_code = 'internal',
      next_attempt_at = now() + interval '15 minutes',
      updated_at = now(),
      completed_at = now()
    WHERE blob_id = ${blobId}::uuid AND extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
  `;
};

export const extractMailAttachmentBlob = async (blobId: string, signal: AbortSignal): Promise<ExtractionResult> => {
  const [existing] = await sql<ExtractionRow[]>`
    SELECT status, markdown, format, input_bytes, output_bytes, truncated
    FROM mail.attachment_extractions
    WHERE blob_id = ${blobId}::uuid AND extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
  `;
  if (existing?.status === "complete" && existing.markdown !== null && existing.format !== null) {
    const chunks = await projectCompleteExtraction({
      blobId,
      markdown: existing.markdown,
      format: existing.format,
      inputBytes: Number(existing.input_bytes ?? 0),
      outputBytes: Number(existing.output_bytes ?? 0),
      truncated: existing.truncated,
    });
    return { status: "complete", reused: true, chunks };
  }
  const filename = await filenameForBlob(blobId);
  if (
    existing &&
    existing.status !== "pending" &&
    existing.status !== "failed" &&
    !(existing.status === "unsupported" && isCsvFilename(filename))
  ) {
    return { status: existing.status, reused: true, chunks: 0 };
  }

  await markAttempt(blobId);
  try {
    const { bytes } = await readBlobBytes(blobId, signal);
    const extracted = await extractDocumentMarkdown({ bytes, filename, signal });
    const chunks = await projectCompleteExtraction({
      blobId,
      markdown: extracted.markdown,
      format: extracted.format,
      inputBytes: extracted.inputBytes,
      outputBytes: extracted.outputBytes,
      truncated: extracted.truncated,
    });
    return { status: "complete", reused: false, chunks };
  } catch (error) {
    if (error instanceof DocumentExtractionError) {
      const status = attachmentExtractionStatusForError(error);
      if (status) {
        await persistTerminalStatus(blobId, status);
        return { status, reused: false, chunks: 0 };
      }
    }
    await markTransientFailure(blobId).catch(() => undefined);
    throw error;
  }
};

const extractionJob = lazySync((sync) =>
  sync.job<{ blobId: string }>({
    id: "mail:extract-attachment",
    delivery: { ackWaitMs: 5 * 60_000, maxAttempts: MAX_ATTEMPTS, backoffMs: [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000] },
  }),
);
let extractionJobWorker: Worker | undefined;
const startExtractionJob = async (): Promise<void> => {
  unregisterSyncOps.push(syncOps.registerDeadLetters({ name: "mail:extract-attachment", kind: "job", store: extractionJob().deadLetters }));
  extractionJobWorker = await extractionJob().process({}, async (ctx) => {
    const spanKey = trace.syncSpanKey("job", "mail:extract-attachment", ctx.jobId);
    await trace.start({
      name: "Mail attachment extraction",
      source: "mail:extract-attachment",
      appId: "mail",
      category: "job",
      spanKey,
      attributes: { "cloud.mail.extractor_version": MAIL_ATTACHMENT_EXTRACTOR_VERSION },
    });
    const result = await extractionTasks.run(() => extractMailAttachmentBlob(ctx.input.blobId, ctx.signal));
    if (result) await trace.end({ spanKey, summary: result });
  });
};

export const attachmentExtractionJobKey = (blobId: string, extractionHint = "detected"): string =>
  `blob:${sha256Text(`${blobId}:${MAIL_ATTACHMENT_EXTRACTOR_VERSION}:${extractionHint}`)}`;

const reprojectCompleteExtraction = async (blobId: string): Promise<boolean> => {
  const [existing] = await sql<ExtractionRow[]>`
    SELECT status, markdown, format, input_bytes, output_bytes, truncated
    FROM mail.attachment_extractions
    WHERE blob_id = ${blobId}::uuid AND extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
  `;
  if (existing?.status !== "complete" || existing.markdown === null || existing.format === null) return false;
  await projectCompleteExtraction({
    blobId,
    markdown: existing.markdown,
    format: existing.format,
    inputBytes: Number(existing.input_bytes ?? 0),
    outputBytes: Number(existing.output_bytes ?? 0),
    truncated: existing.truncated,
  });
  return true;
};

export const enqueueAttachmentExtraction = async (blobId: string): Promise<void> => {
  if (await reprojectCompleteExtraction(blobId)) return;
  const filename = await filenameForBlob(blobId);
  await (extractionTasks.run(() =>
    extractionJob().submit({
      coalesce: true,
      key: attachmentExtractionJobKey(blobId, isCsvFilename(filename) ? "csv" : "detected"),
      input: { blobId },
    }),
  ) ?? Promise.resolve());
};

export const enqueueAttachmentExtractionsForMessage = async (messageId: string): Promise<number> => {
  const blobs = await sql<{ blob_id: string }[]>`
    SELECT DISTINCT blob_id
    FROM mail.attachments
    WHERE message_id = ${messageId}::uuid
    ORDER BY blob_id
  `;
  await Promise.all(blobs.map((blob) => enqueueAttachmentExtraction(blob.blob_id)));
  return blobs.length;
};

export const recoverAttachmentExtractions = async (): Promise<number> => {
  const blobs = await sql<{ blob_id: string }[]>`
    SELECT DISTINCT attachment.blob_id
    FROM mail.attachments attachment
    LEFT JOIN mail.attachment_extractions extraction
      ON extraction.blob_id = attachment.blob_id
     AND extraction.extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
    WHERE extraction.blob_id IS NULL
       OR (
         extraction.status = 'pending'
         AND extraction.updated_at < now() - interval '10 minutes'
       )
       OR (
         extraction.status = 'failed'
         AND extraction.attempt_count < ${MAX_ATTEMPTS}
         AND extraction.next_attempt_at <= now()
       )
       OR (
         extraction.status = 'complete'
         AND NOT EXISTS (
           SELECT 1
           FROM mail.message_search_chunks chunk
           WHERE chunk.source_kind = 'attachment'
             AND chunk.attachment_id = attachment.id
             AND chunk.extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
         )
         AND extraction.markdown <> ''
       )
    ORDER BY attachment.blob_id
    LIMIT ${RECOVERY_BATCH_SIZE}
  `;
  await Promise.all(blobs.map((blob) => enqueueAttachmentExtraction(blob.blob_id)));
  return blobs.length;
};

const extractionScheduler = lazySync((sync) =>
  sync.scheduler({ id: "mail:attachment-extraction", delivery: { maxAttempts: 5, backoffMs: [5_000, 20_000, 60_000, 120_000] } }),
);
let extractionSchedulerWorker: Worker | undefined;

const extractionRuntimeLifecycle = createRuntimeLifecycle({
  start: async () => {
    extractionTasks.open();
    await startExtractionJob();
    unregisterSyncOps.push(syncOps.registerScheduler({ name: "mail:attachment-extraction", scheduler: extractionScheduler() }));
    await extractionScheduler().create({
      id: "mail:attachment-extraction:recover",
      cron: "*/5 * * * *",
      meta: { appId: "mail", family: "mail:search", label: "Mail attachment extraction recovery" },
      process: async () => {
        await recoverAttachmentExtractions();
      },
    });
    extractionSchedulerWorker = await extractionScheduler().process();
    await recoverAttachmentExtractions();
  },
  stop: async () => {
    extractionJobWorker?.stop();
    extractionTasks.close();
    await stopRuntimeResources([
      () =>
        extractionSchedulerWorker?.drain().then(() => {
          extractionSchedulerWorker = undefined;
        }),
      () =>
        stopRuntimeJobs(
          extractionTasks,
          [extractionJobWorker].filter((worker): worker is Worker => worker !== undefined),
        ),
    ]).finally(() => {
      for (const unregister of unregisterSyncOps.splice(0)) unregister();
    });
  },
});

export const attachmentExtractionRuntime = {
  start: extractionRuntimeLifecycle.start,
  stop: extractionRuntimeLifecycle.stop,
};

export const logAttachmentExtractionEnqueueFailure = (messageId: string, error: unknown): void => {
  log.warn("Could not enqueue Mail attachment extraction", {
    messageId,
    code: error instanceof Error && "code" in error ? String(error.code) : "ATTACHMENT_EXTRACTION_ENQUEUE_FAILED",
  });
};
