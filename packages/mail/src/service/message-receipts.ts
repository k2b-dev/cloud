import type { sql } from "bun";
import type { MailActivityChange } from "./live";

type SqlClient = typeof sql;

const MAX_REPORT_SOURCE_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ParsedMessageReceipt = {
  kind: "delivery" | "read";
  status: "delivered" | "delayed" | "failed" | "relayed" | "expanded" | "displayed" | "deleted" | "denied" | "other";
  originalEnvelopeId: string | null;
  originalMessageId: string | null;
};

const uniqueValue = (values: string[]): string | null => {
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return unique.length === 1 ? unique[0]! : null;
};

const fieldValues = (source: string, name: string): string[] => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(?:^|\\n)${escapedName}[ \\t]*:[ \\t]*([^\\n]*(?:\\n[ \\t]+[^\\n]*)*)`, "giu");
  return [...source.matchAll(pattern)].flatMap((match) => {
    const value = match[1]?.replace(/\n[ \t]+/gu, " ").trim();
    return value ? [value] : [];
  });
};

const normalizeMessageId = (value: string): string | null => {
  const normalized = value.trim().replace(/^<|>$/gu, "").trim().toLowerCase();
  return normalized.length >= 3 && normalized.length <= 998 && !/[\s<>]/u.test(normalized) ? normalized : null;
};

const deliveryStatus = (source: string): ParsedMessageReceipt["status"] => {
  const statuses = fieldValues(source, "Action").map((value) => value.toLowerCase());
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("delayed")) return "delayed";
  if (statuses.includes("delivered")) return "delivered";
  if (statuses.includes("relayed")) return "relayed";
  if (statuses.includes("expanded")) return "expanded";
  return "other";
};

const readStatus = (source: string): ParsedMessageReceipt["status"] => {
  const dispositions = fieldValues(source, "Disposition").map((value) => value.toLowerCase());
  if (dispositions.some((value) => /(?:^|;)\s*displayed(?:\s|$)/u.test(value))) return "displayed";
  if (dispositions.some((value) => /(?:^|;)\s*deleted(?:\s|$)/u.test(value))) return "deleted";
  if (dispositions.some((value) => /(?:^|;)\s*denied(?:\s|$)/u.test(value))) return "denied";
  return "other";
};

export const parseMessageReceiptSource = (source: string): ParsedMessageReceipt | null => {
  if (Buffer.byteLength(source) > MAX_REPORT_SOURCE_BYTES) return null;
  const rootHeaderEnd = source.search(/\r?\n\r?\n/u);
  const rootHeaders = rootHeaderEnd < 0 ? source : source.slice(0, rootHeaderEnd);
  const contentTypes = fieldValues(rootHeaders, "Content-Type").map((value) => value.toLowerCase());
  const kind = contentTypes.some((value) => /report-type\s*=\s*["']?delivery-status\b/u.test(value))
    ? "delivery"
    : contentTypes.some((value) => /report-type\s*=\s*["']?disposition-notification\b/u.test(value))
      ? "read"
      : null;
  if (!kind) return null;

  const envelopeValue = uniqueValue(fieldValues(source, "Original-Envelope-Id").map((value) => value.toLowerCase()));
  const originalEnvelopeId = envelopeValue && UUID.test(envelopeValue) ? envelopeValue : null;
  const messageValues = fieldValues(source, "Original-Message-ID")
    .map(normalizeMessageId)
    .filter((value): value is string => value !== null);
  const originalMessageId = uniqueValue(messageValues);
  if (!originalEnvelopeId && !originalMessageId) return null;
  return {
    kind,
    status: kind === "delivery" ? deliveryStatus(source) : readStatus(source),
    originalEnvelopeId,
    originalMessageId,
  };
};

export const recordMessageReceipt = async (params: {
  db: SqlClient;
  mailboxId: string;
  reportMessageId: string;
  receipt: ParsedMessageReceipt;
}): Promise<MailActivityChange | null> => {
  await params.db`
    SELECT pg_advisory_xact_lock(hashtextextended('mail-receipt:' || ${params.reportMessageId}, 0))
  `;
  const [existing] = await params.db<{ report_message_id: string }[]>`
    SELECT report_message_id
    FROM mail.message_receipt_reports
    WHERE report_message_id = ${params.reportMessageId}::uuid
  `;
  if (existing) return null;
  const candidates = await params.db<{ id: string; conversation_id: string | null; stable_message_id: string }[]>`
    SELECT submission.id, draft.conversation_id, submission.stable_message_id
    FROM mail.outbox_submissions submission
    JOIN mail.drafts draft ON draft.id = submission.draft_id
    WHERE submission.mailbox_id = ${params.mailboxId}::uuid
      AND (
        (${params.receipt.originalEnvelopeId}::uuid IS NOT NULL
          AND submission.id = ${params.receipt.originalEnvelopeId}::uuid)
        OR
        (${params.receipt.originalMessageId}::text IS NOT NULL
          AND lower(trim(both '<>' from submission.stable_message_id)) = ${params.receipt.originalMessageId})
      )
    ORDER BY submission.id
    LIMIT 2
  `;
  const [candidate, duplicateCandidate] = candidates;
  if (!candidate || duplicateCandidate) return null;
  const conversationId = candidate.conversation_id;
  if (!conversationId) return null;

  const [activity] = await params.db<{ id: string | number }[]>`
    INSERT INTO mail.activity_events (
      mailbox_id,
      conversation_id,
      actor_kind,
      action,
      outcome,
      target_type,
      target_id,
      metadata
    )
    SELECT
      ${params.mailboxId}::uuid,
      ${conversationId}::uuid,
      'system',
      ${params.receipt.kind === "delivery" ? "message.delivery_receipt_received" : "message.read_receipt_received"},
      ${
        params.receipt.status === "failed" || params.receipt.status === "denied"
          ? "failed"
          : params.receipt.status === "delayed" || params.receipt.status === "other"
            ? "reconciled"
            : "confirmed"
      },
      'message',
      ${params.reportMessageId}::uuid,
      ${{
        kind: params.receipt.kind,
        status: params.receipt.status,
        outboxSubmissionId: candidate.id,
        originalMessageId: candidate.stable_message_id,
      }}::jsonb
    WHERE NOT EXISTS (
      SELECT 1
      FROM mail.message_receipt_reports report
      WHERE report.report_message_id = ${params.reportMessageId}::uuid
    )
    RETURNING id
  `;
  if (!activity) return null;
  await params.db`
    INSERT INTO mail.message_receipt_reports (
      report_message_id,
      mailbox_id,
      conversation_id,
      outbox_submission_id,
      activity_id,
      kind,
      status,
      original_envelope_id,
      original_message_id
    )
    VALUES (
      ${params.reportMessageId}::uuid,
      ${params.mailboxId}::uuid,
      ${conversationId}::uuid,
      ${candidate.id}::uuid,
      ${String(activity.id)}::bigint,
      ${params.receipt.kind},
      ${params.receipt.status},
      ${params.receipt.originalEnvelopeId}::uuid,
      ${params.receipt.originalMessageId}
    )
  `;
  return {
    mailboxId: params.mailboxId,
    conversationId,
    reason: "outbound",
    targetId: params.reportMessageId,
    activityId: String(activity.id),
  };
};
