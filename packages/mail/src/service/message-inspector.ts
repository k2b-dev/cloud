import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import { type MessageInspector, type MessageSourcePreview, messageInspectorSchema, messageSourcePreviewSchema } from "../contracts";
import { requireMailboxAccess, requireVisibleMessages } from "./access";
import type { MailRequestContext } from "./auth";
import { mailingListMetadata } from "./list-subscriptions";
import { getStoredBlob, readStoredBlobPrefix } from "./message-blobs";
import { parseMessageProtocolFacts } from "./message-protocol";
import type { AttachmentDownload } from "./messages";

export const MESSAGE_HEADER_LIMIT_BYTES = 2 * 1024 * 1024;
export const MESSAGE_HEADER_FIELD_LIMIT = 10_000;
export const MESSAGE_INSPECTOR_ATTACHMENT_LIMIT = 10_000;
export const MESSAGE_INSPECTOR_PART_LIMIT = 10_000;
export const MESSAGE_INSPECTOR_PLACEMENT_LIMIT = 1000;
export const MESSAGE_SOURCE_PREVIEW_LIMIT_BYTES = 256 * 1024;

const internalMessageInspectorSchema = messageInspectorSchema.extend({
  id: z.string().uuid(),
  placements: messageInspectorSchema.shape.placements.element.extend({ folderId: z.string().uuid() }).array().max(1000),
  attachments: messageInspectorSchema.shape.attachments.element.extend({ id: z.string().uuid() }).array().max(10_000),
});
const internalMessageSourcePreviewSchema = messageSourcePreviewSchema.extend({ messageId: z.string().uuid() });

type InspectorMessageRow = {
  id: string;
  short_id: string;
  message_id: string | null;
  in_reply_to: string | null;
  reference_ids: string[];
  subject: string;
  internal_date: Date | string;
  sent_at: Date | string | null;
  size_bytes: string | number;
  hydration_status: string;
  hydration_error_code: string | null;
  content_hash: string;
  source_hash: string | null;
  source_blob_id: string | null;
  source_byte_length: string | number | null;
  source_content_hash: string | null;
  protocol_facts: Record<string, unknown> | string;
};

type PlacementRow = {
  folder_id: string;
  folder_name: string;
  remote_path: string | null;
  uid_validity: string | number | bigint;
  uid: string | number | bigint;
  modseq: string | number | bigint | null;
  flags: string[];
  keywords: string[];
};

type PartRow = {
  id: string;
  part_path: string;
  content_type: string;
  charset: string | null;
  transfer_encoding: string | null;
  disposition: string | null;
  content_id: string | null;
  filename: string | null;
  size_bytes: string | number;
  hydration_status: string;
};

type AttachmentRow = {
  id: string;
  short_id: string;
  part_id: string;
  filename: string | null;
  content_type: string;
  disposition: string | null;
  content_id: string | null;
  size_bytes: string | number;
};

type ParsedHeaders = {
  headers: MessageInspector["headers"];
  rawHeaders: string;
  complete: boolean;
  fieldLimitReached: boolean;
  malformedLines: number;
};

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

const toSafeNonNegativeInteger = (value: string | number, label: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is outside the supported range`);
  return parsed;
};

const parseJsonObject = (value: Record<string, unknown> | string): Record<string, unknown> => {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const findHeaderBoundary = (bytes: Uint8Array): { index: number; delimiterLength: number } | null => {
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (
      index + 3 < bytes.byteLength &&
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return { index, delimiterLength: 4 };
    }
    if (index + 1 < bytes.byteLength && bytes[index] === 10 && bytes[index + 1] === 10) {
      return { index, delimiterLength: 2 };
    }
  }
  return null;
};

export const parseMessageHeaderBlock = (bytes: Uint8Array): ParsedHeaders => {
  const boundary = findHeaderBoundary(bytes);
  const headerBytes = boundary ? bytes.subarray(0, boundary.index) : bytes;
  const rawHeaders = new TextDecoder("utf-8", { fatal: false }).decode(headerBytes);
  const headers: MessageInspector["headers"] = [];
  let fieldLimitReached = false;
  let malformedLines = 0;

  for (const line of rawHeaders.split(/\r\n|\n|\r/)) {
    if (/^[ \t]/.test(line)) {
      const previous = headers.at(-1);
      if (!previous) {
        malformedLines += 1;
        continue;
      }
      previous.value = `${previous.value} ${line.trim()}`.trim();
      continue;
    }
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      malformedLines += 1;
      continue;
    }
    const name = line.slice(0, separator).trim();
    if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) {
      malformedLines += 1;
      continue;
    }
    if (headers.length >= MESSAGE_HEADER_FIELD_LIMIT) {
      fieldLimitReached = true;
      continue;
    }
    headers.push({
      name,
      value: line.slice(separator + 1).trim(),
    });
  }

  return {
    headers,
    rawHeaders,
    complete: boundary !== null,
    fieldLimitReached,
    malformedLines,
  };
};

const loadMessage = async (mailboxId: string, messageId: string): Promise<InspectorMessageRow | null> => {
  const [message] = await sql<InspectorMessageRow[]>`
    SELECT
      message.id,
      message.short_id,
      message.message_id,
      message.in_reply_to,
      message.reference_ids,
      message.subject,
      message.internal_date,
      message.sent_at,
      message.size_bytes,
      message.hydration_status,
      message.hydration_error_code,
      message.content_hash,
      message.source_hash,
      message.source_blob_id,
      source_blob.byte_length AS source_byte_length,
      source_blob.content_hash AS source_content_hash,
      message.protocol_facts
    FROM mail.message_contents message
    LEFT JOIN mail.message_part_blobs source_blob
      ON source_blob.id = message.source_blob_id
     AND source_blob.complete = true
    WHERE message.id = ${messageId}::uuid
      AND message.mailbox_id = ${mailboxId}::uuid
  `;
  return message ?? null;
};

const requireMessageRead = async (
  context: MailRequestContext,
  mailboxId: string,
  messageId: string,
): Promise<Result<InspectorMessageRow>> => {
  const access = await requireMailboxAccess(context, mailboxId, "read");
  if (!access.ok) return access;
  const visible = await requireVisibleMessages(access.data, [messageId]);
  if (!visible.ok) return visible;
  const message = await loadMessage(mailboxId, messageId);
  return message ? ok(message) : fail(err.notFound("Message"));
};

export const inspectMessage = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  messageId: string;
}): Promise<Result<MessageInspector>> => {
  const loaded = await requireMessageRead(params.context, params.mailboxId, params.messageId);
  if (!loaded.ok) return loaded;
  const message = loaded.data;

  const [placements, parts, attachments] = await Promise.all([
    sql<PlacementRow[]>`
      SELECT
        folder.id AS folder_id,
        folder.name AS folder_name,
        folder_ref.remote_path,
        remote_ref.uid_validity,
        remote_ref.uid,
        remote_ref.modseq,
        placement.flags,
        placement.keywords
      FROM mail.message_placements placement
      JOIN mail.remote_message_refs remote_ref ON remote_ref.id = placement.remote_message_ref_id
      JOIN mail.folders folder ON folder.id = placement.folder_id
      LEFT JOIN LATERAL (
        SELECT ref.remote_path
        FROM mail.binding_folder_refs ref
        WHERE ref.folder_id = folder.id
        ORDER BY (ref.missing_since IS NULL) DESC, ref.updated_at DESC, ref.id
        LIMIT 1
      ) folder_ref ON true
      WHERE placement.message_id = ${params.messageId}::uuid
        AND placement.deleted_at IS NULL
      ORDER BY folder.name, remote_ref.uid
      LIMIT ${MESSAGE_INSPECTOR_PLACEMENT_LIMIT + 1}
    `,
    sql<PartRow[]>`
      SELECT
        id,
        part_path,
        content_type,
        charset,
        transfer_encoding,
        disposition,
        content_id,
        filename,
        size_bytes,
        hydration_status
      FROM mail.message_parts
      WHERE message_id = ${params.messageId}::uuid
      ORDER BY part_path, id
      LIMIT ${MESSAGE_INSPECTOR_PART_LIMIT + 1}
    `,
    sql<AttachmentRow[]>`
      SELECT id, short_id, part_id, filename, content_type, disposition, content_id, size_bytes
      FROM mail.attachments
      WHERE message_id = ${params.messageId}::uuid
      ORDER BY id
      LIMIT ${MESSAGE_INSPECTOR_ATTACHMENT_LIMIT + 1}
    `,
  ]);

  let parsedHeaders: ParsedHeaders = {
    headers: [],
    rawHeaders: "",
    complete: false,
    fieldLimitReached: false,
    malformedLines: 0,
  };
  const warnings: string[] = [];
  if (placements.length > MESSAGE_INSPECTOR_PLACEMENT_LIMIT) {
    warnings.push(`Only the first ${MESSAGE_INSPECTOR_PLACEMENT_LIMIT} provider placements are shown.`);
  }
  if (parts.length > MESSAGE_INSPECTOR_PART_LIMIT) {
    warnings.push(`Only the first ${MESSAGE_INSPECTOR_PART_LIMIT} MIME parts are shown.`);
  }
  if (attachments.length > MESSAGE_INSPECTOR_ATTACHMENT_LIMIT) {
    warnings.push(`Only the first ${MESSAGE_INSPECTOR_ATTACHMENT_LIMIT} attachments are shown.`);
  }
  const sourceAvailable = message.source_blob_id !== null && message.source_byte_length !== null && message.source_content_hash !== null;
  if (sourceAvailable && message.source_blob_id) {
    try {
      const prefix = await readStoredBlobPrefix(message.source_blob_id, MESSAGE_HEADER_LIMIT_BYTES);
      parsedHeaders = parseMessageHeaderBlock(prefix.bytes);
      const currentAccess = await requireMessageRead(params.context, params.mailboxId, params.messageId);
      if (!currentAccess.ok) return currentAccess;
    } catch (error) {
      warnings.push(error instanceof Error ? `Stored source could not be read: ${error.message}` : "Stored source could not be read.");
    }
  } else {
    warnings.push("The exact original message source is unavailable.");
  }
  if (!parsedHeaders.complete && sourceAvailable) {
    warnings.push(`The header block exceeds ${MESSAGE_HEADER_LIMIT_BYTES} bytes or has no valid header boundary.`);
  }
  if (parsedHeaders.malformedLines > 0) {
    warnings.push(
      `${parsedHeaders.malformedLines} malformed header line${parsedHeaders.malformedLines === 1 ? " was" : "s were"} ignored.`,
    );
  }
  if (parsedHeaders.fieldLimitReached) {
    warnings.push(`Only the first ${MESSAGE_HEADER_FIELD_LIMIT} header fields are shown.`);
  }
  if (message.hydration_status === "failed") {
    warnings.push(
      message.hydration_error_code ? `Message hydration failed (${message.hydration_error_code}).` : "Message hydration failed.",
    );
  }
  if (message.source_hash && message.source_content_hash && message.source_hash !== message.source_content_hash) {
    warnings.push("The stored source hash does not match the message source hash.");
  }

  const currentAccess = await requireMessageRead(params.context, params.mailboxId, params.messageId);
  if (!currentAccess.ok) return currentAccess;

  const protocolFacts = parseMessageProtocolFacts(parseJsonObject(message.protocol_facts));
  const mailingList = mailingListMetadata(protocolFacts);
  const value = {
    id: message.id,
    messageId: message.message_id,
    inReplyTo: message.in_reply_to,
    referenceIds: message.reference_ids,
    subject: message.subject,
    internalDate: toIso(message.internal_date),
    sentAt: message.sent_at ? toIso(message.sent_at) : null,
    sizeBytes: toSafeNonNegativeInteger(message.size_bytes, "Message size"),
    hydrationStatus: message.hydration_status,
    hydrationErrorCode: message.hydration_error_code,
    contentHash: message.content_hash,
    sourceHash: message.source_hash,
    contentType: protocolFacts.contentType,
    source: {
      available: sourceAvailable,
      exact: sourceAvailable,
      byteLength: message.source_byte_length === null ? null : toSafeNonNegativeInteger(message.source_byte_length, "Message source size"),
      contentHash: message.source_content_hash,
    },
    headers: parsedHeaders.headers,
    rawHeaders: parsedHeaders.rawHeaders,
    headersComplete: parsedHeaders.complete,
    placements: placements.slice(0, MESSAGE_INSPECTOR_PLACEMENT_LIMIT).map((placement) => ({
      folderId: placement.folder_id,
      folderName: placement.folder_name,
      remotePath: placement.remote_path ?? placement.folder_name,
      uidValidity: String(placement.uid_validity),
      uid: String(placement.uid),
      modseq: placement.modseq === null ? null : String(placement.modseq),
      flags: placement.flags,
      keywords: placement.keywords,
    })),
    parts: parts.slice(0, MESSAGE_INSPECTOR_PART_LIMIT).map((part) => ({
      partPath: part.part_path,
      contentType: part.content_type,
      charset: part.charset,
      transferEncoding: part.transfer_encoding,
      disposition: part.disposition,
      contentId: part.content_id,
      filename: part.filename,
      sizeBytes: toSafeNonNegativeInteger(part.size_bytes, "MIME part size"),
      hydrationStatus: part.hydration_status,
    })),
    attachments: attachments.slice(0, MESSAGE_INSPECTOR_ATTACHMENT_LIMIT).map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.content_type,
      disposition: attachment.disposition,
      contentId: attachment.content_id,
      sizeBytes: toSafeNonNegativeInteger(attachment.size_bytes, "Attachment size"),
    })),
    mailingList: mailingList
      ? {
          listKey: mailingList.listKey,
          name: mailingList.name,
          address: mailingList.address,
          postHref: mailingList.postHref,
          helpHref: mailingList.helpHref,
          archiveHref: mailingList.archiveHref,
        }
      : null,
    spam: protocolFacts.spam,
    warnings,
  };
  const parsed = internalMessageInspectorSchema.safeParse(value);
  return parsed.success ? ok(parsed.data) : fail(err.internal("Message inspection data is invalid"));
};

export const previewMessageSource = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  messageId: string;
}): Promise<Result<MessageSourcePreview>> => {
  const loaded = await requireMessageRead(params.context, params.mailboxId, params.messageId);
  if (!loaded.ok) return loaded;
  if (!loaded.data.source_blob_id) return fail(err.notFound("Exact message source"));

  let prefix: Awaited<ReturnType<typeof readStoredBlobPrefix>>;
  try {
    prefix = await readStoredBlobPrefix(loaded.data.source_blob_id, MESSAGE_SOURCE_PREVIEW_LIMIT_BYTES);
  } catch {
    return fail(err.notFound("Exact message source"));
  }
  const currentAccess = await requireMessageRead(params.context, params.mailboxId, params.messageId);
  if (!currentAccess.ok) return currentAccess;

  const parsed = internalMessageSourcePreviewSchema.safeParse({
    messageId: loaded.data.id,
    exact: true,
    text: new TextDecoder("utf-8", { fatal: false }).decode(prefix.bytes),
    byteLength: prefix.blob.byteLength,
    previewByteLength: prefix.bytes.byteLength,
    truncated: prefix.truncated,
  });
  return parsed.success ? ok(parsed.data) : fail(err.internal("Message source preview is invalid"));
};

export type MessageSourceDownload = AttachmentDownload & {
  messageId: string;
};

export const openMessageSource = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  messageId: string;
}): Promise<Result<MessageSourceDownload>> => {
  const loaded = await requireMessageRead(params.context, params.mailboxId, params.messageId);
  if (!loaded.ok) return loaded;
  if (!loaded.data.source_blob_id) return fail(err.notFound("Exact message source"));
  try {
    const blob = await getStoredBlob(loaded.data.source_blob_id);
    if (
      !Number.isSafeInteger(blob.byteLength) ||
      blob.byteLength < 0 ||
      !Number.isSafeInteger(blob.chunkSize) ||
      blob.chunkSize <= 0 ||
      !Number.isSafeInteger(blob.chunkCount) ||
      blob.chunkCount < 0 ||
      (blob.byteLength === 0 ? blob.chunkCount !== 0 : blob.chunkCount === 0)
    ) {
      return fail(err.internal("Message source metadata is invalid"));
    }
    return ok({
      messageId: loaded.data.id,
      blobId: blob.id,
      total: blob.byteLength,
      chunkSize: blob.chunkSize,
      chunkCount: blob.chunkCount,
      contentHash: blob.contentHash,
      contentType: "message/rfc822",
      filename: `${loaded.data.subject.trim() || "message"}.eml`,
    });
  } catch {
    return fail(err.notFound("Exact message source"));
  }
};
