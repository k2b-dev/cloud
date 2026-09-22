import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { logger } from "@k2b/cloud/services";
import type { Headers } from "@zone-eu/mailsplit";
import { sql } from "bun";
import { type AttachmentStream, MailParser, type MessageText } from "mailparser";
import sanitizeHtml from "sanitize-html";
import { withShortIdDb } from "../lib/short-id";
import { enqueueAttachmentExtractionsForMessage, logAttachmentExtractionEnqueueFailure } from "./attachment-extraction";
import { MAX_IMAP_LITERAL_BYTES } from "./connectors";
import { deriveConversationWorkState, isAutomaticSubmission } from "./conversation-work-state";
import { allowedEmailInlineStyles } from "./email-inline-style-policy";
import { type MailCollaborationEvent, publishMailCollaborationEvent } from "./events";
import { assertMailboxTransportFence, type MailboxTransportFence } from "./mailbox-transport-fence";
import { createBlobReadable, type StoredBlob, storeReadableBlob } from "./message-blobs";
import { extractMessageProtocolFacts, parseMessageProtocolFacts, readMessageRootHeaders } from "./message-protocol";
import { parseMessageReceiptSource, recordMessageReceipt } from "./message-receipts";
import { assessMessageSourceSize } from "./message-source-size";
import { splitSearchText } from "./search-chunks";
import { publishMailWorkflowDependency } from "./workflow-dependencies";

type HydratedPart = {
  partPath: string;
  contentType: string;
  charset: string | null;
  transferEncoding: string | null;
  disposition: string | null;
  contentId: string | null;
  filename: string | null;
  blob: StoredBlob;
  attachment: boolean;
};

const log = logger("mail:hydration");

// Hydration stops retrying at this attempt count; a permanent failure jumps to it.
const MAX_HYDRATION_ATTEMPTS = 5;

type ClaimedMessage = {
  id: string;
  mailbox_id: string;
  size_bytes: string | number;
  mime_structure: Record<string, unknown> | string;
  resume_hydration_status: "envelope" | "headers" | "body" | "failed";
  resume_hydration_attempt: number;
  resume_hydration_error_code: string | null;
};

type MessageIdentityProjection = {
  id: string;
  conversation_id: string | null;
  override_conversation_id: string | null;
};

type VerifiedConversationProjection = {
  conversation_id: string;
  mailbox_id: string;
  work_status: "needs_action" | "waiting" | "done";
  snoozed_until: Date | string | null;
  in_reply_to: string | null;
  reference_ids: string[];
  protocol_facts: Record<string, unknown> | string;
  outbound: boolean;
  is_latest_verified: boolean;
  message_count: number;
};

type VerifiedDuplicateResult = {
  canonicalMessageId: string | null;
  duplicateFound: boolean;
};

const incomingAllowedTags = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
] as const;

const incomingAllowedAttributes: Record<string, string[]> = {
  ...Object.fromEntries(incomingAllowedTags.map((tag) => [tag, ["style"]])),
  a: ["href", "title", "target", "rel", "style"],
  blockquote: ["class", "type", "style"],
  div: ["class", "style"],
  img: ["src", "alt", "title", "width", "height", "data-mail-remote-image", "style"],
  table: ["cellpadding", "cellspacing", "width", "align", "border", "style"],
  td: ["width", "align", "valign", "colspan", "rowspan", "style"],
  th: ["width", "align", "valign", "colspan", "rowspan", "style"],
  tr: ["align", "valign", "style"],
};

const MAX_REMOTE_IMAGE_COUNT = 64;
const MAX_REMOTE_IMAGE_URL_BYTES = 128 * 1024;
const MAX_REMOTE_IMAGE_URL_LENGTH = 8_192;

export type SanitizedRemoteImage = {
  id: string;
  position: number;
  sourceUrl: string;
  sourceHost: string;
};

export type SanitizedIncomingMailHtml = {
  html: string;
  remoteImages: SanitizedRemoteImage[];
};

const normalizedRemoteImageUrl = (value: string): URL | null => {
  if (value.length > MAX_REMOTE_IMAGE_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
};

export const sanitizeIncomingMailHtmlWithRemoteImages = (html: string): SanitizedIncomingMailHtml => {
  const remoteImages: SanitizedRemoteImage[] = [];
  let remoteUrlBytes = 0;
  const sanitized = sanitizeHtml(html, {
    allowedTags: [...incomingAllowedTags],
    allowedAttributes: incomingAllowedAttributes,
    allowedStyles: allowedEmailInlineStyles(incomingAllowedTags),
    allowedClasses: {
      blockquote: ["gmail_quote", "yahoo_quoted"],
      div: ["gmail_quote", "yahoo_quoted", "moz-cite-prefix"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["cid"] },
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: "a",
        attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow" },
      }),
      img: (_tagName, attribs) => {
        const source = attribs.src;
        const safeAttributes = { ...attribs };
        delete safeAttributes["data-mail-remote-image"];
        if (!source || source.toLowerCase().startsWith("cid:")) return { tagName: "img", attribs: safeAttributes };
        const url = normalizedRemoteImageUrl(source);
        const sourceUrl = url?.toString();
        const sourceBytes = sourceUrl ? Buffer.byteLength(sourceUrl) : 0;
        delete safeAttributes.src;
        if (
          !url ||
          !sourceUrl ||
          remoteImages.length >= MAX_REMOTE_IMAGE_COUNT ||
          remoteUrlBytes + sourceBytes > MAX_REMOTE_IMAGE_URL_BYTES
        ) {
          return { tagName: "img", attribs: safeAttributes };
        }
        const id = randomUUID();
        remoteUrlBytes += sourceBytes;
        remoteImages.push({
          id,
          position: remoteImages.length,
          sourceUrl,
          sourceHost: url.hostname.toLowerCase(),
        });
        return {
          tagName: "img",
          attribs: { ...safeAttributes, "data-mail-remote-image": id },
        };
      },
    },
  });
  return { html: sanitized, remoteImages };
};

export const sanitizeIncomingMailHtml = (html: string): string => sanitizeIncomingMailHtmlWithRemoteImages(html).html;

const selectedHeaders = (headers: Headers | null): Record<string, unknown> => {
  if (!headers) return {};
  const names = [
    "message-id",
    "in-reply-to",
    "references",
    "date",
    "from",
    "reply-to",
    "to",
    "cc",
    "bcc",
    "subject",
    "return-path",
    "auto-submitted",
    "precedence",
    "list-id",
    "list-unsubscribe",
    "list-unsubscribe-post",
    "list-post",
    "list-help",
    "list-archive",
    "x-auto-response-suppress",
    "content-type",
    "importance",
    "priority",
    "x-priority",
    "disposition-notification-to",
    "x-spam-flag",
    "x-spam-status",
    "x-spam-score",
    "authentication-results",
    "arc-authentication-results",
    "received-spf",
  ];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = headers.getFirst(name);
      return value ? [[name, value]] : [];
    }),
  );
};

const findPartPath = (structure: Record<string, unknown>, contentType: string): string | null => {
  if (typeof structure["type"] === "string" && structure["type"].toLowerCase() === contentType) {
    return typeof structure["part"] === "string" ? structure["part"] : null;
  }
  const children = Array.isArray(structure["childNodes"]) ? structure["childNodes"] : [];
  for (const child of children) {
    if (!child || typeof child !== "object") continue;
    const found = findPartPath(child as Record<string, unknown>, contentType);
    if (found) return found;
  }
  return null;
};

const normalizeErrorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? code : "MIME_HYDRATION_FAILED";
};

const readableFromText = (value: string): Readable => Readable.from([Buffer.from(value, "utf8")]);

const storeMessageSource = async (messageId: string, source: Readable, expectedSize?: number | null): Promise<StoredBlob> => {
  const blob = await storeReadableBlob(source);
  const verdict = assessMessageSourceSize(blob.byteLength, expectedSize);
  if (verdict.kind === "advisory_mismatch") {
    log.warn("Mail message source size differs from the advertised RFC822.SIZE", {
      messageId,
      expectedSize: verdict.expectedSize,
      byteLength: verdict.byteLength,
    });
  }
  return blob;
};

const readReceiptSource = async (blob: StoredBlob): Promise<string | null> => {
  if (blob.byteLength > 2 * 1024 * 1024) return null;
  const source = createBlobReadable(blob.id);
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    source.destroy();
  }
};

const claimMessage = async (messageId: string, claimId: string): Promise<ClaimedMessage | "complete" | null> => {
  const [claimed] = await sql<ClaimedMessage[]>`
    WITH candidate AS (
      SELECT id, hydration_status, hydration_attempt, hydration_error_code
      FROM mail.message_contents
      WHERE id = ${messageId}::uuid
        AND hydration_status <> 'complete'
        AND hydration_attempt < ${MAX_HYDRATION_ATTEMPTS}
        AND (
          hydration_status <> 'hydrating'
          OR hydration_claimed_at < now() - interval '15 minutes'
        )
      FOR UPDATE
    )
    UPDATE mail.message_contents message
    SET
      hydration_status = 'hydrating',
      hydration_attempt = message.hydration_attempt + 1,
      hydration_claim_id = ${claimId}::uuid,
      hydration_claimed_at = now(),
      hydration_error_code = NULL
    FROM candidate
    WHERE message.id = candidate.id
    RETURNING
      message.id,
      message.mailbox_id,
      message.size_bytes,
      message.mime_structure,
      CASE WHEN candidate.hydration_status = 'hydrating' THEN 'headers' ELSE candidate.hydration_status END AS resume_hydration_status,
      candidate.hydration_attempt AS resume_hydration_attempt,
      candidate.hydration_error_code AS resume_hydration_error_code
  `;
  if (claimed) return claimed;
  const [current] = await sql<{ hydration_status: string }[]>`
    SELECT hydration_status FROM mail.message_contents WHERE id = ${messageId}::uuid
  `;
  if (!current) return null;
  return current.hydration_status === "complete" ? "complete" : null;
};

const mergeVerifiedDuplicate = async (params: {
  db: typeof sql;
  messageId: string;
  sourceHash: string;
}): Promise<VerifiedDuplicateResult> => {
  await params.db`
    SELECT pg_advisory_xact_lock(hashtextextended(message.mailbox_id::text || ':' || ${params.sourceHash}, 0))
    FROM mail.message_contents message
    WHERE message.id = ${params.messageId}::uuid
  `;
  const canonicalIdentities = await params.db<{ id: string }[]>`
    SELECT candidate.id
    FROM mail.message_contents current_message
    JOIN mail.message_contents candidate
      ON candidate.mailbox_id = current_message.mailbox_id
     AND candidate.id <> current_message.id
     AND candidate.source_hash = ${params.sourceHash}
     AND candidate.hydration_status = 'complete'
    WHERE current_message.id = ${params.messageId}::uuid
    ORDER BY EXISTS (
      SELECT 1 FROM mail.conversation_thread_overrides thread_override WHERE thread_override.message_id = candidate.id
    ) DESC, candidate.created_at, candidate.id
    FOR UPDATE OF candidate
  `;
  if (canonicalIdentities.length === 0) return { canonicalMessageId: null, duplicateFound: false };
  const identityIds = [params.messageId, ...canonicalIdentities.map((candidate) => candidate.id)].sort();
  await params.db`
    SELECT message_id
    FROM mail.conversation_messages
    WHERE message_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${identityIds}::jsonb))
    ORDER BY message_id
    FOR UPDATE
  `;
  await params.db`
    SELECT message_id
    FROM mail.conversation_thread_overrides
    WHERE message_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${identityIds}::jsonb))
    ORDER BY message_id
    FOR UPDATE
  `;
  const projections = await params.db<MessageIdentityProjection[]>`
    SELECT
      message.id,
      link.conversation_id,
      thread_override.conversation_id AS override_conversation_id
    FROM mail.message_contents message
    LEFT JOIN mail.conversation_messages link ON link.message_id = message.id
    LEFT JOIN mail.conversation_thread_overrides thread_override ON thread_override.message_id = message.id
    WHERE message.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${identityIds}::jsonb))
  `;
  const current = projections.find((projection) => projection.id === params.messageId);
  if (!current) return { canonicalMessageId: null, duplicateFound: true };

  const currentConversationId = current.override_conversation_id ?? current.conversation_id;
  const canonical = canonicalIdentities
    .map((candidate) => projections.find((projection) => projection.id === candidate.id))
    .find((candidate) => {
      if (!candidate) return false;
      const candidateConversationId = candidate.override_conversation_id ?? candidate.conversation_id;
      return !currentConversationId || !candidateConversationId || currentConversationId === candidateConversationId;
    });
  if (!canonical) return { canonicalMessageId: null, duplicateFound: true };

  if (current.override_conversation_id && !canonical.override_conversation_id) {
    await params.db`
      INSERT INTO mail.conversation_thread_overrides (
        message_id, mailbox_id, conversation_id, reason, actor_kind, actor_id, revision, created_at, updated_at
      )
      SELECT
        ${canonical.id}::uuid,
        mailbox_id,
        conversation_id,
        reason,
        actor_kind,
        actor_id,
        revision,
        created_at,
        updated_at
      FROM mail.conversation_thread_overrides
      WHERE message_id = ${params.messageId}::uuid
      ON CONFLICT (message_id) DO NOTHING
    `;
  }
  if (current.conversation_id && !canonical.conversation_id) {
    await params.db`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by, created_at)
      SELECT conversation_id, ${canonical.id}::uuid, position, added_by, created_at
      FROM mail.conversation_messages
      WHERE message_id = ${params.messageId}::uuid
      ON CONFLICT DO NOTHING
    `;
  }
  await params.db`
    UPDATE mail.conversation_comments
    SET referenced_message_id = ${canonical.id}::uuid
    WHERE referenced_message_id = ${params.messageId}::uuid
  `;
  await params.db`
    UPDATE mail.message_placements
    SET message_id = ${canonical.id}::uuid, updated_at = now()
    WHERE message_id = ${params.messageId}::uuid
  `;
  await params.db`
    UPDATE mail.remote_message_refs
    SET message_id = ${canonical.id}::uuid
    WHERE message_id = ${params.messageId}::uuid
  `;
  await params.db`
    UPDATE mail.drafts
    SET source_message_id = ${canonical.id}::uuid
    WHERE source_message_id = ${params.messageId}::uuid
  `;
  await params.db`
    UPDATE mail.automatic_reply_effects
    SET message_id = ${canonical.id}::uuid
    WHERE message_id = ${params.messageId}::uuid
  `;
  await params.db`
    UPDATE mail.outbox_submissions
    SET message_id = ${canonical.id}::uuid
    WHERE message_id = ${params.messageId}::uuid
  `;
  await params.db`
    UPDATE mail.message_contents canonical_message
    SET
      source_blob_id = COALESCE(canonical_message.source_blob_id, current_message.source_blob_id),
      source_hash = COALESCE(canonical_message.source_hash, current_message.source_hash)
    FROM mail.message_contents current_message
    WHERE canonical_message.id = ${canonical.id}::uuid
      AND current_message.id = ${params.messageId}::uuid
  `;
  await params.db`DELETE FROM mail.message_contents WHERE id = ${params.messageId}::uuid`;
  return { canonicalMessageId: canonical.id, duplicateFound: true };
};

const applyVerifiedConversationTransition = async (params: {
  db: typeof sql;
  messageId: string;
}): Promise<Omit<MailCollaborationEvent, "type" | "at"> | null> => {
  const [lockedConversation] = await params.db<{ id: string }[]>`
    SELECT conversation.id
    FROM mail.message_contents message
    JOIN mail.conversation_messages link ON link.message_id = message.id
    JOIN mail.conversations conversation ON conversation.id = link.conversation_id
    WHERE message.id = ${params.messageId}::uuid
    FOR UPDATE OF conversation
  `;
  if (!lockedConversation) return null;

  const [projection] = await params.db<VerifiedConversationProjection[]>`
    SELECT
      conversation.id AS conversation_id,
      conversation.mailbox_id,
      conversation.work_status,
      conversation.snoozed_until,
      message.in_reply_to,
      message.reference_ids,
      message.protocol_facts,
      EXISTS (
        SELECT 1
        FROM mail.message_addresses sender
        JOIN mail.sender_identities identity
          ON identity.mailbox_id = conversation.mailbox_id
         AND lower(identity.from_address) = sender.normalized_email
        WHERE sender.message_id = message.id AND sender.role = 'from'
      ) AS outbound,
      NOT EXISTS (
        SELECT 1
        FROM mail.conversation_messages newer_link
        JOIN mail.message_contents newer_message ON newer_message.id = newer_link.message_id
        WHERE newer_link.conversation_id = conversation.id
          AND (
            newer_message.hydration_status = 'complete'
            OR EXISTS (
              SELECT 1
              FROM mail.outbox_submissions newer_outbox
              WHERE newer_outbox.message_id = newer_message.id
                AND newer_outbox.state <> 'cancelled'
            )
          )
          AND (newer_message.internal_date, newer_message.id) > (message.internal_date, message.id)
      ) AS is_latest_verified,
      (
        SELECT COUNT(*)::int
        FROM mail.conversation_messages conversation_link
        WHERE conversation_link.conversation_id = conversation.id
      ) AS message_count
    FROM mail.message_contents message
    JOIN mail.conversation_messages link ON link.message_id = message.id
    JOIN mail.conversations conversation ON conversation.id = link.conversation_id
    WHERE message.id = ${params.messageId}::uuid
  `;
  if (!projection) return null;

  const protocolFacts = parseMessageProtocolFacts(
    typeof projection.protocol_facts === "string" ? JSON.parse(projection.protocol_facts) : projection.protocol_facts,
  );
  const transition = projection.is_latest_verified
    ? deriveConversationWorkState(projection.work_status, {
        direction: projection.outbound ? "outbound" : "inbound",
        intent:
          projection.outbound && (projection.in_reply_to || projection.reference_ids.length > 0) ? "observed_reply" : "observed_message",
        automatic: isAutomaticSubmission(protocolFacts.autoSubmitted),
      })
    : { workStatus: projection.work_status, clearSnooze: false };
  const nextWorkStatus = transition.workStatus;
  const nextSnoozedUntil = transition.clearSnooze ? null : projection.snoozed_until;
  const changed =
    projection.work_status !== nextWorkStatus ||
    (projection.snoozed_until ? new Date(projection.snoozed_until).toISOString() : null) !==
      (nextSnoozedUntil ? new Date(nextSnoozedUntil).toISOString() : null);
  await params.db`
    WITH classified AS (
      SELECT
        message.id AS message_id,
        message.subject,
        message.internal_date,
        EXISTS (
          SELECT 1
          FROM mail.message_addresses sender
          JOIN mail.sender_identities identity
            ON identity.mailbox_id = conversation.mailbox_id
           AND lower(identity.from_address) = sender.normalized_email
          WHERE sender.message_id = message.id AND sender.role = 'from'
        ) AS outbound
      FROM mail.conversations conversation
      JOIN mail.conversation_messages link ON link.conversation_id = conversation.id
      JOIN mail.message_contents message ON message.id = link.message_id
      WHERE conversation.id = ${projection.conversation_id}::uuid
        AND (
          message.hydration_status = 'complete'
          OR EXISTS (
            SELECT 1
            FROM mail.outbox_submissions outbox
            WHERE outbox.message_id = message.id
              AND outbox.state <> 'cancelled'
          )
        )
    ),
    timeline AS (
      SELECT
        MAX(internal_date) AS latest_message_at,
        MAX(internal_date) FILTER (WHERE NOT outbound) AS latest_inbound_at,
        MAX(internal_date) FILTER (WHERE outbound) AS latest_outbound_at
      FROM classified
    ),
    latest AS (
      SELECT message_id, subject, outbound
      FROM classified
      ORDER BY internal_date DESC, message_id DESC
      LIMIT 1
    ),
    participant_labels AS (
      SELECT DISTINCT ON (address.normalized_email)
        address.normalized_email,
        COALESCE(NULLIF(address.display_name, ''), address.email) AS label
      FROM mail.message_addresses address
      JOIN latest ON latest.message_id = address.message_id
      WHERE (latest.outbound AND address.role IN ('to', 'cc', 'bcc'))
         OR (NOT latest.outbound AND address.role = 'from')
      ORDER BY address.normalized_email, address.position
    ),
    participants AS (
      SELECT COALESCE(string_agg(label, ', ' ORDER BY label), '') AS summary
      FROM participant_labels
    )
    UPDATE mail.conversations conversation
    SET
      subject = latest.subject,
      participant_summary = participants.summary,
      latest_message_at = timeline.latest_message_at,
      latest_inbound_at = timeline.latest_inbound_at,
      latest_outbound_at = timeline.latest_outbound_at,
      work_status = ${nextWorkStatus},
      snoozed_until = ${nextSnoozedUntil},
      revision = conversation.revision + CASE WHEN ${projection.message_count > 1 || changed} THEN 1 ELSE 0 END
    FROM timeline, latest, participants
    WHERE conversation.id = ${projection.conversation_id}::uuid
  `;
  if (!changed || !projection.is_latest_verified) return null;

  const [activity] = await params.db<{ id: string | number }[]>`
    INSERT INTO mail.activity_events (
      mailbox_id, conversation_id, actor_kind, action, outcome, target_type, target_id, metadata
    ) VALUES (
      ${projection.mailbox_id}::uuid,
      ${projection.conversation_id}::uuid,
      'system',
      'conversation.work_state_changed',
      'reconciled',
      'conversation',
      ${projection.conversation_id}::uuid,
      ${{
        messageId: params.messageId,
        before: {
          workStatus: projection.work_status,
          snoozedUntil: projection.snoozed_until ? new Date(projection.snoozed_until).toISOString() : null,
        },
        after: {
          workStatus: nextWorkStatus,
          snoozedUntil: nextSnoozedUntil ? new Date(nextSnoozedUntil).toISOString() : null,
        },
      }}::jsonb
    )
    RETURNING id
  `;
  if (!activity) throw new Error("Conversation work-state activity insert returned no row");
  return {
    mailboxId: projection.mailbox_id,
    conversationId: projection.conversation_id,
    reason: projection.outbound ? "outbound" : "inbound",
    targetId: params.messageId,
    activityId: String(activity.id),
  };
};

export const hydrateMessageFromSource = async (params: {
  messageId: string;
  source: Readable;
  expectedSize?: number | null;
  claimId?: string;
  transportFence?: MailboxTransportFence;
}): Promise<{ status: "hydrated" | "already_complete" | "deduplicated"; sourceHash?: string; canonicalMessageId?: string }> => {
  const claimId = params.claimId ?? randomUUID();
  const claimed = await claimMessage(params.messageId, claimId);
  if (claimed === "complete") {
    params.source.destroy();
    return { status: "already_complete" };
  }
  if (!claimed) {
    params.source.destroy();
    throw Object.assign(new Error("Message hydration is already running or the message does not exist"), {
      code: "HYDRATION_NOT_CLAIMED",
    });
  }

  // A source the connector cannot even fetch must not be parsed into memory.
  if (Number(claimed.size_bytes) > MAX_IMAP_LITERAL_BYTES) {
    params.source.destroy();
    await sql`
      UPDATE mail.message_contents
      SET
        hydration_status = 'failed',
        hydration_error_code = 'MESSAGE_TOO_LARGE',
        hydration_attempt = ${MAX_HYDRATION_ATTEMPTS},
        hydration_claim_id = NULL,
        hydration_claimed_at = NULL
      WHERE id = ${params.messageId}::uuid AND hydration_claim_id = ${claimId}::uuid
    `;
    throw Object.assign(new Error("Message source is too large to hydrate"), { code: "MESSAGE_TOO_LARGE" });
  }

  const mimeStructure =
    typeof claimed.mime_structure === "string" ? (JSON.parse(claimed.mime_structure) as Record<string, unknown>) : claimed.mime_structure;
  const parser = new MailParser({
    skipHtmlToText: false,
    skipTextToHtml: true,
    skipImageLinks: true,
    keepCidLinks: true,
    maxHtmlLengthToParse: 10 * 1024 * 1024,
    checksumAlgo: "sha256",
  });
  const parts: HydratedPart[] = [];
  let plainText = "";
  let originalHtml: string | null = null;
  let attachmentIndex = 0;
  let sourceBlob: StoredBlob | null = null;
  let parseSource: Readable | null = null;
  let parsePipeline: Promise<void> | null = null;

  try {
    const storedSource = await storeMessageSource(params.messageId, params.source, params.expectedSize);
    sourceBlob = storedSource;
    await sql.begin(async (tx) => {
      const [current] = await tx<{ id: string }[]>`
        SELECT id
        FROM mail.message_contents
        WHERE id = ${params.messageId}::uuid
          AND hydration_status = 'hydrating'
          AND hydration_claim_id = ${claimId}::uuid
        FOR UPDATE
      `;
      if (!current) throw Object.assign(new Error("Message hydration claim was lost"), { code: "HYDRATION_CLAIM_LOST" });
      if (params.transportFence) await assertMailboxTransportFence(params.transportFence, tx);
      await tx`
        UPDATE mail.message_contents
        SET source_blob_id = ${storedSource.id}::uuid, source_hash = ${storedSource.contentHash}
        WHERE id = ${params.messageId}::uuid AND hydration_claim_id = ${claimId}::uuid
      `;
    });

    const headers = await readMessageRootHeaders(createBlobReadable(storedSource.id));
    parseSource = createBlobReadable(storedSource.id);
    parsePipeline = pipeline(parseSource, parser);
    for await (const value of parser as AsyncIterable<AttachmentStream | MessageText>) {
      if (value.type === "attachment") {
        const attachment = value as AttachmentStream & { partId?: string };
        attachmentIndex += 1;
        try {
          const blob = await storeReadableBlob(attachment.content as Readable, attachment.size || null);
          parts.push({
            partPath: attachment.partId || `attachment-${attachmentIndex}`,
            contentType: attachment.contentType || "application/octet-stream",
            charset: null,
            transferEncoding: null,
            disposition: attachment.contentDisposition || "attachment",
            contentId: attachment.contentId ?? null,
            filename: attachment.filename ?? null,
            blob,
            attachment: true,
          });
        } finally {
          attachment.release();
        }
      } else {
        plainText = value.text ?? "";
        originalHtml = typeof value.html === "string" ? value.html : null;
      }
    }
    await parsePipeline;

    if (plainText) {
      const blob = await storeReadableBlob(readableFromText(plainText), Buffer.byteLength(plainText));
      parts.push({
        partPath: findPartPath(mimeStructure, "text/plain") ?? "normalized-plain",
        contentType: "text/plain",
        charset: "utf-8",
        transferEncoding: null,
        disposition: "inline",
        contentId: null,
        filename: null,
        blob,
        attachment: false,
      });
    }
    if (originalHtml) {
      const blob = await storeReadableBlob(readableFromText(originalHtml), Buffer.byteLength(originalHtml));
      parts.push({
        partPath: findPartPath(mimeStructure, "text/html") ?? "original-html",
        contentType: "text/html",
        charset: "utf-8",
        transferEncoding: null,
        disposition: "inline",
        contentId: null,
        filename: null,
        blob,
        attachment: false,
      });
    }

    const sourceHash = storedSource.contentHash;
    const protocolFacts = extractMessageProtocolFacts((name) => headers.getFirst(name));
    const receiptSource =
      protocolFacts.deliveryStatus || /(?:^|;)\s*report-type\s*=\s*["']?disposition-notification\b/iu.test(protocolFacts.contentType ?? "")
        ? await readReceiptSource(storedSource)
        : null;
    const receipt = receiptSource ? parseMessageReceiptSource(receiptSource) : null;
    const sanitized = originalHtml ? sanitizeIncomingMailHtmlWithRemoteImages(originalHtml) : null;
    const sanitizedHtml = sanitized?.html ?? null;
    let canonicalMessageId: string | null = null;
    let collaborationEvent: Omit<MailCollaborationEvent, "type" | "at"> | null = null;
    let receiptEvent: Omit<MailCollaborationEvent, "type" | "at"> | null = null;
    await sql.begin(async (tx) => {
      const [current] = await tx<{ id: string }[]>`
        SELECT id
        FROM mail.message_contents
        WHERE id = ${params.messageId}::uuid
          AND hydration_status = 'hydrating'
          AND hydration_claim_id = ${claimId}::uuid
        FOR UPDATE
      `;
      if (!current) throw Object.assign(new Error("Message hydration claim was lost"), { code: "HYDRATION_CLAIM_LOST" });
      if (params.transportFence) await assertMailboxTransportFence(params.transportFence, tx);
      const duplicate = await mergeVerifiedDuplicate({ db: tx, messageId: params.messageId, sourceHash });
      canonicalMessageId = duplicate.canonicalMessageId;
      if (canonicalMessageId) return;
      await tx`DELETE FROM mail.message_parts WHERE message_id = ${params.messageId}::uuid`;
      await tx`
        DELETE FROM mail.message_search_chunks
        WHERE message_id = ${params.messageId}::uuid
          AND source_kind = 'body'
      `;
      await tx`DELETE FROM mail.message_remote_images WHERE message_id = ${params.messageId}::uuid`;
      for (const part of parts) {
        const [partRow] = await tx<{ id: string }[]>`
          INSERT INTO mail.message_parts (
            message_id,
            part_path,
            content_type,
            charset,
            transfer_encoding,
            disposition,
            content_id,
            filename,
            size_bytes,
            blob_id,
            hydration_status
          )
          VALUES (
            ${params.messageId}::uuid,
            ${part.partPath},
            ${part.contentType},
            ${part.charset},
            ${part.transferEncoding},
            ${part.disposition},
            ${part.contentId},
            ${part.filename},
            ${part.blob.byteLength},
            ${part.blob.id}::uuid,
            'complete'
          )
          RETURNING id
        `;
        if (!partRow) throw new Error("Message part insert returned no row");
        if (part.attachment) {
          await withShortIdDb(
            tx,
            "attachment",
            (db, shortId) => db`
            INSERT INTO mail.attachments (
              short_id,
              message_id,
              part_id,
              filename,
              content_type,
              disposition,
              content_id,
              checksum,
              size_bytes,
              blob_id
            )
            VALUES (
              ${shortId},
              ${params.messageId}::uuid,
              ${partRow.id}::uuid,
              ${part.filename},
              ${part.contentType},
              ${part.disposition},
              ${part.contentId},
              ${part.blob.contentHash},
              ${part.blob.byteLength},
              ${part.blob.id}::uuid
            )
          `,
          );
        }
      }
      const searchChunks = splitSearchText(plainText);
      for (let position = 0; position < searchChunks.length; position += 1) {
        await tx`
          INSERT INTO mail.message_search_chunks (message_id, mailbox_id, position, search_document)
          VALUES (
            ${params.messageId}::uuid,
            ${claimed.mailbox_id}::uuid,
            ${position},
            to_tsvector('simple'::regconfig, ${searchChunks[position]!})
          )
        `;
      }
      for (const remoteImage of sanitized?.remoteImages ?? []) {
        await tx`
          INSERT INTO mail.message_remote_images (
            id,
            message_id,
            position,
            source_url,
            source_host
          )
          VALUES (
            ${remoteImage.id}::uuid,
            ${params.messageId}::uuid,
            ${remoteImage.position},
            ${remoteImage.sourceUrl},
            ${remoteImage.sourceHost}
          )
        `;
      }
      await tx`
        UPDATE mail.message_contents
        SET
          plain_text = ${plainText || null},
          sanitized_html = ${sanitizedHtml},
          selected_headers = selected_headers || ${selectedHeaders(headers)}::jsonb,
          protocol_facts = ${protocolFacts}::jsonb,
          source_hash = ${sourceHash},
          hydration_status = 'complete',
          hydration_error_code = NULL,
          hydration_claim_id = NULL,
          hydration_claimed_at = NULL,
          hydrated_at = now()
        WHERE id = ${params.messageId}::uuid AND hydration_claim_id = ${claimId}::uuid
      `;
      if (!duplicate.duplicateFound) {
        collaborationEvent = await applyVerifiedConversationTransition({ db: tx, messageId: params.messageId });
        if (receipt) {
          receiptEvent = await recordMessageReceipt({
            db: tx,
            mailboxId: claimed.mailbox_id,
            reportMessageId: params.messageId,
            receipt,
          });
        }
      }
    });
    if (collaborationEvent) await publishMailCollaborationEvent(collaborationEvent);
    if (receiptEvent) await publishMailCollaborationEvent(receiptEvent);
    await publishMailWorkflowDependency({
      mailboxId: claimed.mailbox_id,
      dependency: { kind: "mail.hydration", key: params.messageId },
    });
    if (canonicalMessageId) return { status: "deduplicated", sourceHash, canonicalMessageId };
    await enqueueAttachmentExtractionsForMessage(params.messageId).catch((error) => {
      logAttachmentExtractionEnqueueFailure(params.messageId, error);
    });
    return { status: "hydrated", sourceHash };
  } catch (error) {
    params.source.destroy();
    parseSource?.destroy();
    await parsePipeline?.catch(() => undefined);
    const transportChanged = normalizeErrorCode(error) === "MAILBOX_TRANSPORT_CHANGED";
    if (transportChanged) {
      await sql`
        UPDATE mail.message_contents
        SET
          source_blob_id = CASE
            WHEN source_blob_id = ${sourceBlob?.id ?? null}::uuid THEN NULL
            ELSE source_blob_id
          END,
          source_hash = CASE
            WHEN source_blob_id = ${sourceBlob?.id ?? null}::uuid THEN NULL
            ELSE source_hash
          END,
          hydration_status = ${claimed.resume_hydration_status},
          hydration_attempt = ${claimed.resume_hydration_attempt},
          hydration_error_code = ${claimed.resume_hydration_error_code},
          hydration_claim_id = NULL,
          hydration_claimed_at = NULL
        WHERE id = ${params.messageId}::uuid AND hydration_claim_id = ${claimId}::uuid
      `;
    } else {
      const [failed] = await sql<{ mailbox_id: string; hydration_attempt: number }[]>`
        UPDATE mail.message_contents
        SET
          hydration_status = 'failed',
          hydration_error_code = ${normalizeErrorCode(error)},
          hydration_claim_id = NULL,
          hydration_claimed_at = NULL
        WHERE id = ${params.messageId}::uuid AND hydration_claim_id = ${claimId}::uuid
        RETURNING mailbox_id, hydration_attempt
      `.catch(() => []);
      if (failed && failed.hydration_attempt >= MAX_HYDRATION_ATTEMPTS) {
        await publishMailWorkflowDependency({
          mailboxId: failed.mailbox_id,
          dependency: { kind: "mail.hydration", key: params.messageId },
        });
      }
    }
    throw error;
  }
};
