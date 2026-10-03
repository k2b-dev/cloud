import { randomUUID } from "node:crypto";
import { lazySync } from "@k2b/cloud";
import { createRuntimeLifecycle, createRuntimeTaskTracker, logger, stopRuntimeJobs, stopRuntimeResources } from "@k2b/cloud/services";
import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services/postgres";
import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import { evaluateWorkflowTriggerInputs } from "@k2b/cloud/workflows/runtime";
import { emitWorkflowEvent, notifyWorkflowWorker } from "@k2b/cloud/workflows/store";
import type { JobContext, Worker } from "@k2b/sync";
import { redis, sql } from "bun";
import { withShortIdDb } from "../lib/short-id";
import { truncateUtf8 } from "../lib/utf8";
import { MAIL_WORKFLOW_APP_ID, MAIL_WORKFLOW_EVENT } from "../workflows/events";
import { isStorableMessageAddress, normalizeEmailAddress } from "./address-normalization";
import { cleanupPublicAttachmentLinks } from "./attachment-links";
import { type BindingRediscoveryResult, rediscoverProviderBinding } from "./bindings";
import { sha256Json } from "./canonical";
import { releaseDueSnoozes } from "./collaboration";
import type { ConnectorEnvelope, FlagChange } from "./connectors";
import { imapSmtpConnector } from "./connectors";
import { isAutomaticSubmission } from "./conversation-work-state";
import { databaseErrorCode, databaseErrorConstraint, isPermanentDataError } from "./database-errors";
import {
  enqueueDraftImports,
  enqueueDraftProjectionSnapshot,
  recordDraftFolderSyncInTransaction,
  startDraftProjectionRuntime,
  stopDraftProjectionRuntime,
  submitDueDraftProjectionWork,
} from "./draft-provider-projection";
import { deleteAbandonedDraftAttachmentUploads } from "./draft-uploads";
import { enqueueMailInvalidation, notifyMailInvalidations } from "./events";
import { resolveMailExecution } from "./execution";
import { withLeaseHeartbeat } from "./lease-heartbeat";
import { mailScheduler } from "./mail-scheduler";
import { assertMailboxTransportFence, loadMailboxTransportFence } from "./mailbox-transport-fence";
import { deleteAbandonedBlobUploads, deleteOrphanedBlobs } from "./message-blobs";
import { hydrateMessageFromSource, recordMissingMessageSources } from "./message-hydration";
import { parseMessageProtocolFacts } from "./message-protocol";
import { hasReplySubjectPrefix, normalizeMailSubject } from "./message-threading";
import { reopenUnprovenSendWithSentCopy } from "./outbound-message-projection";
import { loadProviderConnectionRuntimeSnapshot } from "./provider-connections";
import { isProviderAuthenticationFailure, providerErrorCode, providerErrorMessage } from "./provider-errors";
import {
  acquireProviderLease,
  mailProviderOperationMutex,
  type ProviderLeasePriority,
  providerBusyRetryAfterMs,
} from "./provider-operation-lock";
import { waitForMailProviderSlot } from "./provider-pacer";
import { cleanupMailRuntimeHistory } from "./runtime-history-retention";
import { reconcileMailStorageUsage } from "./storage-observability";
import { getWorkflowSnapshot, mailWorkflowEventContext } from "./workflow-data";

const log = logger("mail:sync");
const ENVELOPE_BATCH_SIZE = 200;
const FLAG_WINDOW_SIZE = 5_000;
const RECONCILE_WINDOW_SIZE = 5_000;
const HYDRATION_BATCH_SIZE = 20;
const SYNC_LEASE_MS = 2 * 60_000;
const syncTasks = createRuntimeTaskTracker();

type EnvelopeCursor = {
  version: 1;
  uidValidity: string;
  highestSeenUid: number;
  backfillNextHigh: number | null;
  backfillComplete: boolean;
  incrementalTargetHigh: number | null;
  incrementalNextHigh: number | null;
  highestModseq: string | null;
  flagTargetModseq: string | null;
  flagNextLow: number | null;
  flagMaxUid: number | null;
  reconcileNextLow: number | null;
  lastFullReconcileAt: string | null;
  // The fields below arrived after the first cursors were stored, so a stored cursor can lack them.
  /** High UID of the next newest-first reconcile window below the newest one; null starts again at the newest message. */
  sweepNextHigh?: number | null;
  /** The next batch continues with the older window at sweepNextHigh; see fetchReconcileStep. */
  sweepOlderDue?: boolean;
  /** The folder's message count shows that messages left it; the newest-first windows look for them. */
  vanishedSearch?: boolean;
  /** The current search retired a message; see checkVanishedMessages. */
  searchRetired?: boolean;
  /** Live local UIDs plus uncounted remote messages minus STATUS MESSAGES while nothing is missing; 0 on a consistent server. */
  countOffset?: number;
  /** Remote messages the local count leaves out: outside Drafts, the drafts Mail never imports. */
  remoteUncounted?: number;
  /** STATUS MESSAGES of the latest batch after which Mail held every UID it covers, up to highestSeenUid. */
  countedMessages?: number | null;
};

type FolderSyncRow = {
  folder_id: string;
  mailbox_id: string;
  remote_resource_id: string;
  sync_generation: string | number;
  envelope_cursor: EnvelopeCursor | string;
  role: string;
};

type FenceClaim = {
  token: number;
  generation: number;
  runId: string;
};

type SyncBatchResult = {
  hasMore: boolean;
  /**
   * New mail or flag changes still wait for the next batch, so it ranks as a folder sync;
   * otherwise only older mail or reconciliation windows remain.
   */
  syncPending: boolean;
  imported: number;
  flagsUpdated: number;
  removed: number;
};

type SyncLock = NonNullable<Awaited<ReturnType<ReturnType<typeof mailProviderOperationMutex>["acquire"]>>>;

const hydrationJobKey = (input: HydrationInput): string =>
  "mailboxId" in input ? `mailbox:${input.mailboxId}` : `message:${input.messageId}`;

const retryAfterMs = (error: unknown, fallback: number): number => {
  const value = Number((error as { retryAfterMs?: unknown } | null)?.retryAfterMs);
  return Number.isFinite(value) && value > 0 ? Math.max(1_000, Math.min(value, 60_000)) : fallback;
};

const extendSyncLease = async (lock: SyncLock, phase: string): Promise<void> => {
  if (await mailProviderOperationMutex().extend(lock, { ttlMs: SYNC_LEASE_MS })) return;
  throw Object.assign(new Error(`Mail sync lease was lost ${phase}`), { code: "SYNC_LEASE_LOST" });
};

const loadResolvedRuntimeSnapshot = async (connectionId: string, secretRevision: number | null) => {
  if (secretRevision == null)
    throw Object.assign(new Error("Resolved provider credential revision is missing"), { code: "CREDENTIAL_REVISION_MISSING" });
  const snapshot = await loadProviderConnectionRuntimeSnapshot(connectionId);
  if (snapshot.secretRevision !== secretRevision) {
    throw Object.assign(new Error("Provider credentials changed after binding selection"), { code: "CREDENTIAL_REVISION_CHANGED" });
  }
  return snapshot;
};

const loadResolvedRuntime = async (connectionId: string, secretRevision: number | null) =>
  (await loadResolvedRuntimeSnapshot(connectionId, secretRevision)).runtime;

const parseCursor = (value: EnvelopeCursor | string): EnvelopeCursor | null => {
  const parsed = typeof value === "string" ? (JSON.parse(value) as Partial<EnvelopeCursor>) : value;
  return parsed?.version === 1 ? (parsed as EnvelopeCursor) : null;
};

const initialCursor = (uidValidity: string, currentHighUid: number, highestModseq: string | null): EnvelopeCursor => ({
  version: 1,
  uidValidity,
  highestSeenUid: currentHighUid,
  backfillNextHigh: currentHighUid > 0 ? currentHighUid : null,
  backfillComplete: currentHighUid === 0,
  incrementalTargetHigh: null,
  incrementalNextHigh: null,
  highestModseq,
  flagTargetModseq: null,
  flagNextLow: null,
  flagMaxUid: null,
  reconcileNextLow: null,
  lastFullReconcileAt: null,
  sweepNextHigh: null,
  vanishedSearch: false,
  countOffset: 0,
  remoteUncounted: 0,
  countedMessages: null,
});

// `degraded` only records a failed sync whose binding and credentials stayed
// valid, so the next attempt may claim the resource and its committed batch
// makes it active again. `pending`, `paused`, and `connection_required` stay
// excluded, and the mailbox and binding checks still fence pause, credential
// changes, and revocation.
export const claimFence = async (resourceId: string, bindingId: string, kind: string): Promise<FenceClaim> =>
  sql.begin(async (tx) => {
    const [resource] = await tx<{ token: string | number; generation: string | number }[]>`
      UPDATE mail.remote_resources resource
      SET current_fence_token = resource.current_fence_token + 1
      FROM mail.mailboxes mailbox
      WHERE resource.id = ${resourceId}::uuid
        AND mailbox.id = resource.mailbox_id
        AND resource.status IN ('active', 'degraded')
        AND mailbox.sync_enabled = true
        AND mailbox.deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM mail.provider_bindings binding
          JOIN mail.provider_connections connection ON connection.id = binding.connection_id
          WHERE binding.id = ${bindingId}::uuid
            AND binding.remote_resource_id = resource.id
            AND binding.state = 'active'
            AND binding.verified_scope_fingerprint = resource.scope_fingerprint
            AND binding.verified_secret_revision = connection.secret_revision
            AND connection.status = 'active'
            AND connection.encrypted_secret IS NOT NULL
        )
      RETURNING resource.current_fence_token AS token, resource.sync_generation AS generation
    `;
    if (!resource)
      throw Object.assign(new Error("Mailbox transport changed before sync fence claim"), { code: "MAILBOX_TRANSPORT_CHANGED" });
    await tx`
      UPDATE mail.sync_runs
      SET state = 'stale_fence', finished_at = now(), error_code = 'STALE_SYNC_FENCE'
      WHERE remote_resource_id = ${resourceId}::uuid AND state = 'running'
    `;
    const [run] = await tx<{ id: string }[]>`
      INSERT INTO mail.sync_runs (remote_resource_id, binding_id, fence_token, generation, kind, state)
      VALUES (
        ${resourceId}::uuid,
        ${bindingId}::uuid,
        ${Number(resource.token)},
        ${Number(resource.generation)},
        ${kind},
        'running'
      )
      RETURNING id
    `;
    if (!run) throw new Error("Sync run insert returned no row");
    return { token: Number(resource.token), generation: Number(resource.generation), runId: run.id };
  });

const allParticipantEmails = (message: ConnectorEnvelope): string[] => [
  ...new Set(
    Object.values(message.addresses)
      .flat()
      .map((address) => address.address.toLowerCase()),
  ),
];

/** The form `mail.message_addresses.normalized_email` stores. */
const storedAddress = (address: string): string => normalizeEmailAddress(address) ?? address.trim().toLowerCase();

/** The message's From addresses in their stored form, to compare with a stored message's. */
const senderSet = (message: ConnectorEnvelope): string[] => [
  ...new Set(message.addresses.from.map((address) => storedAddress(address.address))),
];

const counterpartyLabels = (message: ConnectorEnvelope, outbound: boolean): string[] => {
  const addresses = outbound ? [...message.addresses.to, ...message.addresses.cc, ...message.addresses.bcc] : message.addresses.from;
  const labels = new Map<string, string>();
  for (const address of addresses) {
    const normalized = address.address.toLowerCase();
    if (!labels.has(normalized)) labels.set(normalized, address.name?.trim() || address.address);
  }
  return [...labels.values()];
};

const upsertAddresses = async (db: typeof sql, messageId: string, message: ConnectorEnvelope): Promise<void> => {
  await db`DELETE FROM mail.message_addresses WHERE message_id = ${messageId}::uuid`;
  const rows = Object.entries(message.addresses).flatMap(([role, addresses]) =>
    addresses.map((address, position) => ({
      message_id: messageId,
      role: role === "replyTo" ? "reply_to" : role,
      position,
      display_name: address.name,
      email: address.address,
      normalized_email: storedAddress(address.address),
    })),
  );
  if (rows.length > 0) {
    await db`
      INSERT INTO mail.message_addresses ${sql(rows, "message_id", "role", "position", "display_name", "email", "normalized_email")}
    `;
  }
};

// RFC 5322 caps a header line at 998 characters. Counted in bytes, the lowercased value also
// fits a Postgres B-tree entry (at most 2704 bytes) in message_contents_message_id_idx.
const MESSAGE_ID_MAX_BYTES = 998;

const findConversation = async (params: {
  db: typeof sql;
  mailboxId: string;
  messageId: string;
  message: ConnectorEnvelope;
  normalizedSubject: string;
  /** The other side of the message: its recipients when the mailbox sent it, otherwise its sender and Reply-To, without the mailbox's own addresses. */
  counterparties: string[];
}): Promise<string | null> => {
  if (params.message.providerThreadId) {
    const [native] = await params.db<{ conversation_id: string }[]>`
      SELECT cm.conversation_id
      FROM mail.message_contents mc
      JOIN mail.conversation_messages cm ON cm.message_id = mc.id
      WHERE mc.mailbox_id = ${params.mailboxId}::uuid
        AND mc.id <> ${params.messageId}::uuid
        AND mc.provider_thread_id = ${params.message.providerThreadId}
      ORDER BY mc.internal_date DESC, mc.id DESC
      LIMIT 1
    `;
    if (native) return native.conversation_id;
  }

  // A copy whose envelope matches but whose size cannot prove it the same message (see
  // findCanonicalMessageContent), such as a second delivery with other transport headers, joins
  // the conversation of its twin; hydration merges the two once their sources match. A Message-ID
  // alone proves nothing: a sender can reuse it, even for all of its mail, so the twin also has
  // the sender, subject, and Date header, and the lookup reads at most one envelope batch of
  // messages with the Message-ID.
  if (params.message.messageId) {
    const senders = senderSet(params.message);
    const [twin] = await params.db<{ conversation_id: string }[]>`
      SELECT cm.conversation_id
      FROM (
        SELECT mc.id, mc.subject, mc.sent_at
        FROM mail.message_contents mc
        WHERE mc.mailbox_id = ${params.mailboxId}::uuid
          AND mc.id <> ${params.messageId}::uuid
          AND mc.message_id IS NOT NULL
          AND lower(mc.message_id) = lower(${params.message.messageId})
        LIMIT ${ENVELOPE_BATCH_SIZE}
      ) candidate
      JOIN mail.conversation_messages cm ON cm.message_id = candidate.id
      WHERE candidate.subject = ${params.message.subject}
        AND candidate.sent_at IS NOT DISTINCT FROM ${params.message.sentAt}::timestamptz
        AND ARRAY(
          SELECT sender.normalized_email FROM mail.message_addresses sender WHERE sender.message_id = candidate.id AND sender.role = 'from'
        ) <@ ${toPgTextArray(senders)}::text[]
        AND ${toPgTextArray(senders)}::text[] <@ ARRAY(
          SELECT sender.normalized_email FROM mail.message_addresses sender WHERE sender.message_id = candidate.id AND sender.role = 'from'
        )
      LIMIT 1
    `;
    if (twin) return twin.conversation_id;
  }

  // Stored Message-IDs are shortened to MESSAGE_ID_MAX_BYTES; a reply quotes the full value.
  const replyIds = [
    ...new Set(
      [params.message.inReplyTo, ...params.message.references]
        .filter((value): value is string => Boolean(value))
        .map((value) => truncateUtf8(value, MESSAGE_ID_MAX_BYTES)),
    ),
  ];
  const participants = allParticipantEmails(params.message);
  if (replyIds.length > 0 && participants.length > 0) {
    const [referenced] = await params.db<{ conversation_id: string }[]>`
      SELECT cm.conversation_id
      FROM mail.message_contents mc
      JOIN mail.conversation_messages cm ON cm.message_id = mc.id
      WHERE mc.mailbox_id = ${params.mailboxId}::uuid
        AND mc.id <> ${params.messageId}::uuid
        AND lower(mc.message_id) = ANY(${toPgTextArray(replyIds.map((value) => value.toLowerCase()))}::text[])
        AND mc.internal_date BETWEEN ${params.message.internalDate}::timestamptz - interval '2 years'
          AND ${params.message.internalDate}::timestamptz + interval '1 day'
        AND EXISTS (
          SELECT 1
          FROM mail.message_addresses ma
          WHERE ma.message_id = mc.id
            AND ma.normalized_email = ANY(${toPgTextArray(participants)}::text[])
        )
      ORDER BY mc.internal_date DESC, mc.id DESC
      LIMIT 1
    `;
    if (referenced) return referenced.conversation_id;
  }

  if (!params.normalizedSubject) return null;

  // Sync does not import in conversation order: the initial sync runs newest first and every
  // folder syncs on its own, so a reply can arrive before the message it answers, and two replies
  // to a message Mail does not hold yet arrive without it. A message therefore also joins a
  // conversation whose messages reference it or share a referenced message with it. Replies keep
  // the subject, so the lookup reads at most one envelope batch of the closest messages with that
  // subject on each side: a subject that repeats thousands of times, such as a daily report,
  // cannot make every import of the initial sync read all of them.
  const threadIds = [
    ...new Set(
      [params.message.messageId, params.message.inReplyTo, ...params.message.references]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase()),
    ),
  ];
  if (threadIds.length > 0 && participants.length > 0) {
    const [related] = await params.db<{ conversation_id: string }[]>`
      SELECT cm.conversation_id
      FROM (
        (
          SELECT mc.id, mc.internal_date, mc.in_reply_to, mc.reference_ids
          FROM mail.message_contents mc
          WHERE mc.mailbox_id = ${params.mailboxId}::uuid
            AND mc.id <> ${params.messageId}::uuid
            AND mc.normalized_subject <> ''
            AND mc.normalized_subject = ${params.normalizedSubject}
            AND mc.internal_date >= ${params.message.internalDate}::timestamptz
            AND mc.internal_date <= ${params.message.internalDate}::timestamptz + interval '2 years'
          ORDER BY mc.internal_date, mc.id
          LIMIT ${ENVELOPE_BATCH_SIZE}
        )
        UNION ALL
        (
          SELECT mc.id, mc.internal_date, mc.in_reply_to, mc.reference_ids
          FROM mail.message_contents mc
          WHERE mc.mailbox_id = ${params.mailboxId}::uuid
            AND mc.id <> ${params.messageId}::uuid
            AND mc.normalized_subject <> ''
            AND mc.normalized_subject = ${params.normalizedSubject}
            AND mc.internal_date >= ${params.message.internalDate}::timestamptz - interval '2 years'
            AND mc.internal_date < ${params.message.internalDate}::timestamptz
          ORDER BY mc.internal_date DESC, mc.id DESC
          LIMIT ${ENVELOPE_BATCH_SIZE}
        )
      ) candidate
      JOIN mail.conversation_messages cm ON cm.message_id = candidate.id
      WHERE (
          lower(candidate.in_reply_to) = ANY(${toPgTextArray(threadIds)}::text[])
          OR EXISTS (
            SELECT 1 FROM unnest(candidate.reference_ids) AS reference(id) WHERE lower(reference.id) = ANY(${toPgTextArray(threadIds)}::text[])
          )
        )
        AND EXISTS (
          SELECT 1
          FROM mail.message_addresses ma
          WHERE ma.message_id = candidate.id
            AND ma.normalized_email = ANY(${toPgTextArray(participants)}::text[])
        )
      ORDER BY candidate.internal_date, candidate.id
      LIMIT 1
    `;
    if (related) return related.conversation_id;
  }

  // A subject alone links only a message that presents itself as a reply or forward but whose
  // referenced message is unknown, and only to mail with the same counterparty. Every inbound
  // message carries the mailbox's own address, so that address proves no relation: two
  // unrelated senders that both write "Invoice" stay two conversations. Like the lookup above, it
  // reads at most one envelope batch of the closest mail with the subject.
  const replyLike =
    Boolean(params.message.inReplyTo) || params.message.references.length > 0 || hasReplySubjectPrefix(params.message.subject);
  if (!replyLike || params.counterparties.length === 0) return null;
  const [fallback] = await params.db<{ conversation_id: string }[]>`
    SELECT cm.conversation_id
    FROM (
      SELECT mc.id, mc.internal_date
      FROM mail.message_contents mc
      WHERE mc.mailbox_id = ${params.mailboxId}::uuid
        AND mc.id <> ${params.messageId}::uuid
        AND mc.normalized_subject <> ''
        AND mc.normalized_subject = ${params.normalizedSubject}
        AND mc.internal_date BETWEEN ${params.message.internalDate}::timestamptz - interval '30 days'
          AND ${params.message.internalDate}::timestamptz + interval '1 day'
      ORDER BY mc.internal_date DESC, mc.id DESC
      LIMIT ${ENVELOPE_BATCH_SIZE}
    ) candidate
    JOIN mail.conversation_messages cm ON cm.message_id = candidate.id
    WHERE EXISTS (
      SELECT 1
      FROM mail.message_addresses ma
      WHERE ma.message_id = candidate.id
        AND ma.normalized_email = ANY(${toPgTextArray(params.counterparties)}::text[])
    )
    ORDER BY candidate.internal_date DESC, candidate.id DESC
    LIMIT 1
  `;
  return fallback?.conversation_id ?? null;
};

const findManualConversationOverride = async (params: { db: typeof sql; mailboxId: string; messageId: string }): Promise<string | null> => {
  const [override] = await params.db<{ conversation_id: string }[]>`
    SELECT thread_override.conversation_id
    FROM mail.conversation_thread_overrides thread_override
    JOIN mail.conversations conversation ON conversation.id = thread_override.conversation_id
    WHERE thread_override.message_id = ${params.messageId}::uuid
      AND thread_override.mailbox_id = ${params.mailboxId}::uuid
      AND conversation.mailbox_id = ${params.mailboxId}::uuid
  `;
  return override?.conversation_id ?? null;
};

const findCanonicalMessageContent = async (params: {
  db: typeof sql;
  mailboxId: string;
  remoteResourceId: string;
  message: ConnectorEnvelope;
}): Promise<string | null> => {
  if (params.message.messageId) {
    const [outbound] = await params.db<{ message_id: string }[]>`
      SELECT outbox.message_id
      FROM mail.outbox_submissions outbox
      WHERE outbox.mailbox_id = ${params.mailboxId}::uuid
        AND outbox.message_id IS NOT NULL
        AND lower(btrim(outbox.stable_message_id)) = lower(btrim(${params.message.messageId}))
      ORDER BY outbox.created_at DESC
      LIMIT 1
    `;
    if (outbound) return outbound.message_id;
  }
  if (params.message.providerMessageId) {
    const candidates = await params.db<{ message_id: string }[]>`
      SELECT DISTINCT remote_ref.message_id
      FROM mail.remote_message_refs remote_ref
      JOIN mail.folders folder ON folder.id = remote_ref.folder_id
      WHERE folder.remote_resource_id = ${params.remoteResourceId}::uuid
        AND remote_ref.connector_ref ->> 'providerMessageId' = ${params.message.providerMessageId}
      ORDER BY remote_ref.message_id
      LIMIT 2
    `;
    if (candidates.length === 1) return candidates[0]!.message_id;
    if (candidates.length > 1) return null;
  }
  if (!params.message.messageId) return null;
  // Most IMAP servers report no provider id, and a provider id differs between the copy in Sent
  // and the delivered copy of the same mail. A message keeps its identity across folders through
  // its Message-ID, sender, subject, and Date header instead, so a move or copy in another client
  // stays one message and is not received again. A sender can reuse a Message-ID for different
  // mail, so the copy must also have the same size, as a move or copy keeps the bytes. Only one's
  // own mail may differ in size: the copy in Sent and the one delivered back through a Bcc, a
  // list, or a team address carry different transport headers. Without a Date header, only a
  // copy with the same size and INTERNALDATE matches. Like the twin lookup in findConversation,
  // it reads at most one envelope batch of messages with the Message-ID.
  const senders = senderSet(params.message);
  const [sameMessage] = await params.db<{ id: string }[]>`
    SELECT candidate.id
    FROM (
      SELECT mc.id, mc.subject, mc.sent_at, mc.size_bytes, mc.internal_date
      FROM mail.message_contents mc
      WHERE mc.mailbox_id = ${params.mailboxId}::uuid
        AND mc.message_id IS NOT NULL
        AND lower(mc.message_id) = lower(${params.message.messageId})
      LIMIT ${ENVELOPE_BATCH_SIZE}
    ) candidate
    WHERE candidate.subject = ${params.message.subject}
      AND candidate.sent_at IS NOT DISTINCT FROM ${params.message.sentAt}::timestamptz
      AND (
        (
          candidate.size_bytes = ${params.message.sizeBytes}
          AND (${params.message.sentAt}::timestamptz IS NOT NULL OR candidate.internal_date = ${params.message.internalDate}::timestamptz)
        )
        OR (
          ${params.message.sentAt}::timestamptz IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM mail.sender_identities identity
            WHERE identity.mailbox_id = ${params.mailboxId}::uuid
              AND lower(btrim(identity.from_address)) = ANY(${toPgTextArray(senders)}::text[])
          )
        )
      )
      AND ARRAY(
        SELECT sender.normalized_email
        FROM mail.message_addresses sender
        WHERE sender.message_id = candidate.id AND sender.role = 'from'
      ) <@ ${toPgTextArray(senders)}::text[]
      AND ${toPgTextArray(senders)}::text[] <@ ARRAY(
        SELECT sender.normalized_email
        FROM mail.message_addresses sender
        WHERE sender.message_id = candidate.id AND sender.role = 'from'
      )
    LIMIT 1
  `;
  return sameMessage?.id ?? null;
};

/**
 * A message flagged `\Draft` is still being composed. Gmail lists every draft in All Mail too,
 * including the ones Mail projects into Drafts; the Drafts folder owns drafts, so no other
 * folder turns one into a conversation message. IMAP system flags ignore letter case.
 */
const isProviderDraft = (message: Pick<ConnectorEnvelope, "flags" | "labels">): boolean =>
  [...message.flags, ...message.labels].some((flag) => flag.toLowerCase() === "\\draft");

type IngestEnvelopeParams = {
  db: typeof sql;
  mailboxId: string;
  remoteResourceId: string;
  folderId: string;
  message: ConnectorEnvelope;
  captureWorkflowTriggers?: boolean;
};

type AddressRole = keyof ConnectorEnvelope["addresses"];

/**
 * Bounds the envelope values the store cannot hold as received. One unusable header must not
 * reject the whole sync batch: the message stays importable without an address outside the
 * `mail.message_addresses` bounds and with a shortened Message-ID, and the raw headers remain
 * in the message source.
 */
const storableEnvelope = (
  message: ConnectorEnvelope,
): { message: ConnectorEnvelope; skipped: { role: AddressRole; length: number }[]; messageIdShortened: boolean } => {
  const skipped: { role: AddressRole; length: number }[] = [];
  const keep = (role: AddressRole) =>
    message.addresses[role].filter((address) => {
      if (isStorableMessageAddress(address.address)) return true;
      skipped.push({ role, length: [...address.address].length });
      return false;
    });
  const addresses = { from: keep("from"), replyTo: keep("replyTo"), to: keep("to"), cc: keep("cc"), bcc: keep("bcc") };
  const messageId = message.messageId && truncateUtf8(message.messageId, MESSAGE_ID_MAX_BYTES);
  const messageIdShortened = messageId !== message.messageId;
  if (skipped.length === 0 && !messageIdShortened) return { message, skipped, messageIdShortened };
  return { message: { ...message, messageId, addresses }, skipped, messageIdShortened };
};

export const ingestEnvelope = async (params: IngestEnvelopeParams): Promise<string> => {
  const { message, skipped, messageIdShortened } = storableEnvelope(params.message);
  if (skipped.length > 0 || messageIdShortened) {
    // Lengths only: the rejected values are untrusted header text from the message.
    log.warn("Mail adjusted envelope values it cannot store", {
      folderId: params.folderId,
      uidValidity: message.remoteRef.uidValidity,
      uid: message.remoteRef.uid,
      skippedAddresses: skipped,
      messageIdShortened,
    });
  }
  return ingestStorableEnvelope({ ...params, message });
};

const ingestStorableEnvelope = async (params: IngestEnvelopeParams): Promise<string> => {
  const protocolFacts = parseMessageProtocolFacts(params.message.protocolFacts);
  const contentHash = sha256Json({
    remoteResourceId: params.remoteResourceId,
    folderId: params.folderId,
    uidValidity: params.message.remoteRef.uidValidity,
    uid: params.message.remoteRef.uid,
  });
  const normalizedSubject = normalizeMailSubject(params.message.subject);
  const [knownRemoteRef] = await params.db<{ message_id: string }[]>`
    SELECT message_id
    FROM mail.remote_message_refs
    WHERE folder_id = ${params.folderId}::uuid
      AND uid_validity = ${params.message.remoteRef.uidValidity}::numeric
      AND uid = ${params.message.remoteRef.uid}::numeric
  `;
  let messageContentId =
    knownRemoteRef?.message_id ??
    (await findCanonicalMessageContent({
      db: params.db,
      mailboxId: params.mailboxId,
      remoteResourceId: params.remoteResourceId,
      message: params.message,
    }));
  const copyOfKnownMessage = !knownRemoteRef && messageContentId !== null;
  // A copy in the sender's Sent folder proves a send whose outcome Mail could not prove. This
  // locks such a delivery before the message is written, in the order the send itself uses.
  if (messageContentId) {
    await reopenUnprovenSendWithSentCopy(params.db, { messageId: messageContentId, sentCopyFolderId: params.folderId });
  }
  if (!messageContentId) {
    const messageRows = await withShortIdDb(
      params.db,
      "message",
      (db, shortId) => db<{ id: string }[]>`
      INSERT INTO mail.message_contents (
        short_id,
        mailbox_id,
        message_id,
        in_reply_to,
        reference_ids,
        provider_thread_id,
        subject,
        normalized_subject,
        internal_date,
        sent_at,
        size_bytes,
        mime_structure,
        protocol_facts,
        content_hash,
        hydration_status
      )
      VALUES (
        ${shortId},
        ${params.mailboxId}::uuid,
        ${params.message.messageId},
        ${params.message.inReplyTo},
        ${toPgTextArray(params.message.references)}::text[],
        ${params.message.providerThreadId},
        ${params.message.subject},
        ${normalizedSubject},
        ${params.message.internalDate},
        ${params.message.sentAt},
        ${params.message.sizeBytes},
        ${params.message.mimeStructure}::jsonb,
        ${protocolFacts}::jsonb,
        ${contentHash},
        'envelope'
      )
      ON CONFLICT (mailbox_id, content_hash) DO UPDATE SET
        message_id = EXCLUDED.message_id,
        in_reply_to = EXCLUDED.in_reply_to,
        reference_ids = EXCLUDED.reference_ids,
        provider_thread_id = EXCLUDED.provider_thread_id,
        subject = EXCLUDED.subject,
        normalized_subject = EXCLUDED.normalized_subject,
        internal_date = EXCLUDED.internal_date,
        sent_at = EXCLUDED.sent_at,
        size_bytes = EXCLUDED.size_bytes,
        mime_structure = EXCLUDED.mime_structure,
        protocol_facts = EXCLUDED.protocol_facts
      RETURNING id
    `,
    );
    const [messageRow] = messageRows;
    if (!messageRow) throw new Error("Message envelope insert returned no row");
    messageContentId = messageRow.id;
  }

  const [remoteRef] = await params.db<{ id: string; message_id: string }[]>`
    INSERT INTO mail.remote_message_refs (
      folder_id, message_id, uid_validity, uid, modseq, connector_ref, last_seen_at, stale_at
    )
    VALUES (
      ${params.folderId}::uuid,
      ${messageContentId}::uuid,
      ${params.message.remoteRef.uidValidity}::numeric,
      ${params.message.remoteRef.uid}::numeric,
      ${params.message.remoteRef.modseq}::numeric,
      ${{ providerMessageId: params.message.providerMessageId }}::jsonb,
      now(),
      NULL
    )
    ON CONFLICT (folder_id, uid_validity, uid) DO UPDATE SET
      modseq = EXCLUDED.modseq,
      connector_ref = EXCLUDED.connector_ref,
      last_seen_at = now(),
      stale_at = NULL
    RETURNING id, message_id
  `;
  if (!remoteRef) throw new Error("Remote message reference insert returned no row");
  if (remoteRef.message_id !== messageContentId) {
    await params.db`
      DELETE FROM mail.message_contents candidate
      WHERE candidate.id = ${messageContentId}::uuid
        AND NOT EXISTS (SELECT 1 FROM mail.remote_message_refs ref WHERE ref.message_id = candidate.id)
        AND NOT EXISTS (SELECT 1 FROM mail.conversation_messages link WHERE link.message_id = candidate.id)
    `;
    messageContentId = remoteRef.message_id;
  }
  // The body of a message whose source went missing, for example because another client moved
  // it before Mail loaded it, loads again from this new copy.
  if (copyOfKnownMessage) {
    await params.db`
      UPDATE mail.message_contents
      SET
        hydration_status = CASE WHEN hydration_status = 'failed' THEN 'envelope' ELSE hydration_status END,
        hydration_attempt = 0,
        hydration_error_code = NULL
      WHERE id = ${messageContentId}::uuid AND hydration_error_code = 'MESSAGE_SOURCE_MISSING'
    `;
  }
  await params.db`
    UPDATE mail.message_contents
    SET
      message_id = ${params.message.messageId},
      in_reply_to = ${params.message.inReplyTo},
      reference_ids = ${toPgTextArray(params.message.references)}::text[],
      provider_thread_id = ${params.message.providerThreadId},
      subject = ${params.message.subject},
      normalized_subject = ${normalizedSubject},
      internal_date = ${params.message.internalDate},
      sent_at = ${params.message.sentAt},
      size_bytes = ${params.message.sizeBytes},
      mime_structure = ${params.message.mimeStructure}::jsonb,
      protocol_facts = ${protocolFacts}::jsonb
    WHERE id = ${messageContentId}::uuid
  `;
  await upsertAddresses(params.db, messageContentId, params.message);
  await params.db`
    INSERT INTO mail.message_placements (
      remote_message_ref_id, folder_id, message_id, flags, keywords, deleted_at
    )
    VALUES (
      ${remoteRef.id}::uuid,
      ${params.folderId}::uuid,
      ${messageContentId}::uuid,
      ${toPgTextArray(params.message.flags)}::text[],
      ${toPgTextArray(params.message.labels)}::text[],
      NULL
    )
    ON CONFLICT (remote_message_ref_id) DO UPDATE SET
      folder_id = EXCLUDED.folder_id,
      message_id = EXCLUDED.message_id,
      flags = EXCLUDED.flags,
      keywords = EXCLUDED.keywords,
      deleted_at = NULL,
      updated_at = now()
  `;

  const [existingConversation] = await params.db<{ conversation_id: string }[]>`
    SELECT conversation_id
    FROM mail.conversation_messages
    WHERE message_id = ${messageContentId}::uuid
  `;
  if (existingConversation) return messageContentId;

  const ownAddresses = await params.db<{ address: string; sender_identity: boolean }[]>`
    SELECT from_address AS address, true AS sender_identity
    FROM mail.sender_identities
    WHERE mailbox_id = ${params.mailboxId}::uuid
    UNION ALL
    SELECT email AS address, false AS sender_identity
    FROM mail.provider_connections
    WHERE owner_mailbox_id = ${params.mailboxId}::uuid
  `;
  const senderIdentities = new Set(ownAddresses.filter((row) => row.sender_identity).map((row) => storedAddress(row.address)));
  const mailboxAddresses = new Set(ownAddresses.map((row) => storedAddress(row.address)));
  const isOutbound = params.message.addresses.from.some((address) => senderIdentities.has(storedAddress(address.address)));
  const { addresses } = params.message;
  const counterparties = [
    ...new Set(
      (isOutbound ? [...addresses.to, ...addresses.cc, ...addresses.bcc] : [...addresses.from, ...addresses.replyTo]).map((address) =>
        storedAddress(address.address),
      ),
    ),
  ].filter((address) => !mailboxAddresses.has(address));
  const manualConversationId = await findManualConversationOverride({
    db: params.db,
    mailboxId: params.mailboxId,
    messageId: messageContentId,
  });
  let conversationId =
    manualConversationId ??
    (await findConversation({
      db: params.db,
      mailboxId: params.mailboxId,
      messageId: messageContentId,
      message: params.message,
      normalizedSubject,
      counterparties,
    }));
  const participantLabels = counterpartyLabels(params.message, isOutbound);
  if (!conversationId) {
    const conversationRows = await withShortIdDb(
      params.db,
      "conversation",
      (db, shortId) => db<{ id: string }[]>`
      INSERT INTO mail.conversations (
        short_id,
        mailbox_id,
        subject,
        participant_summary,
        latest_inbound_at,
        latest_outbound_at,
        latest_message_at,
        work_status
      )
      VALUES (
        ${shortId},
        ${params.mailboxId}::uuid,
        ${params.message.subject},
        ${participantLabels.slice(0, 20).join(", ")},
        ${isOutbound ? null : params.message.internalDate},
        ${isOutbound ? params.message.internalDate : null},
        ${params.message.internalDate},
        ${
          isOutbound &&
          (params.message.inReplyTo || params.message.references.length > 0) &&
          !isAutomaticSubmission(params.message.protocolFacts?.autoSubmitted)
            ? "waiting"
            : "needs_action"
        }
      )
      RETURNING id
    `,
    );
    const [conversation] = conversationRows;
    if (!conversation) throw new Error("Conversation insert returned no row");
    conversationId = conversation.id;
  }
  // The position only orders a conversation and must not be negative; a server can report an
  // INTERNALDATE before 1970.
  const position = Math.max(0, params.message.internalDate.getTime());
  const [linked] = await params.db<{ message_id: string }[]>`
    INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
    VALUES (
      ${conversationId}::uuid,
      ${messageContentId}::uuid,
      ${position},
      ${
        manualConversationId
          ? "manual"
          : params.message.providerThreadId
            ? "provider"
            : params.message.inReplyTo || params.message.references.length
              ? "headers"
              : "heuristic"
      }
    )
    ON CONFLICT (message_id) DO NOTHING
    RETURNING message_id
  `;
  if (!linked) return messageContentId;
  if (params.captureWorkflowTriggers && !isOutbound) {
    const deliveryKey = `message:${remoteRef.id}`;
    const snapshot = await getWorkflowSnapshot({
      mailboxId: params.mailboxId,
      remoteMessageRefId: remoteRef.id,
      db: params.db,
    });
    if (!snapshot) throw new Error("Received message workflow snapshot could not be loaded");
    const occurredAt = params.message.internalDate.toISOString();
    const workflowIds = await params.db<{ workflow_id: string }[]>`
      SELECT workflow.id::text AS workflow_id
      FROM mail.workflow_profile profile
      JOIN workflows.workflow workflow ON workflow.id = profile.id
      WHERE profile.mailbox_id = ${params.mailboxId}::uuid
        AND profile.enabled
        AND workflow.active_version_id IS NOT NULL
      ORDER BY profile.priority, workflow.id
    `;
    const activations =
      workflowIds.length === 0
        ? []
        : await params.db<{ workflow_id: string; trigger_config: Record<string, WorkflowJsonValue> | string }[]>`
      SELECT
        activation.workflow_id::text,
        activation.config AS trigger_config
      FROM workflows.activation activation
      JOIN workflows.workflow workflow
        ON workflow.id = activation.workflow_id
       AND workflow.active_version_id = activation.workflow_version_id
      JOIN mail.workflow_profile profile
        ON profile.id = workflow.id
       AND profile.enabled
      WHERE activation.workflow_id = ANY(${toPgUuidArray(workflowIds.map((row) => row.workflow_id))}::uuid[])
        AND profile.mailbox_id = ${params.mailboxId}::uuid
        AND activation.event_type = ${MAIL_WORKFLOW_EVENT.messageReceived}
        AND activation.enabled
      ORDER BY
        array_position(${toPgUuidArray(workflowIds.map((row) => row.workflow_id))}::uuid[], activation.workflow_id),
        activation.id
    `;
    const triggerValues = {
      message: snapshot.source.message,
      conversation: snapshot.source.conversation,
      occurredAt,
    };
    for (const activation of activations) {
      const config = typeof activation.trigger_config === "string" ? JSON.parse(activation.trigger_config) : activation.trigger_config;
      const withValues =
        config.with !== null && typeof config.with === "object" && !Array.isArray(config.with)
          ? (config.with as Record<string, WorkflowJsonValue>)
          : {};
      await emitWorkflowEvent(
        {
          appId: MAIL_WORKFLOW_APP_ID,
          scopeId: params.mailboxId,
          type: MAIL_WORKFLOW_EVENT.messageReceived,
          targetWorkflowId: activation.workflow_id,
          data: evaluateWorkflowTriggerInputs(triggerValues, withValues, occurredAt),
          context: mailWorkflowEventContext(snapshot),
          dedupeKey: `${deliveryKey}:${activation.workflow_id}`,
          occurredAt: new Date(occurredAt),
        },
        { db: params.db },
      );
    }
  }
  return messageContentId;
};

const applyFlagChanges = async (params: {
  db: typeof sql;
  folderId: string;
  uidValidity: string;
  changes: FlagChange[];
}): Promise<number> => {
  if (params.changes.length === 0) return 0;
  const [result] = await params.db<{ count: number }[]>`
    WITH incoming AS (
      SELECT
        (entry ->> 'uid')::numeric AS uid,
        (entry ->> 'modseq')::numeric AS modseq,
        ARRAY(SELECT jsonb_array_elements_text(entry -> 'flags')) AS flags,
        ARRAY(SELECT jsonb_array_elements_text(entry -> 'labels')) AS labels
      FROM jsonb_array_elements(${params.changes}::jsonb) AS entry
    ),
    matched AS (
      SELECT rmr.id, incoming.modseq, incoming.flags, incoming.labels
      FROM incoming
      JOIN mail.remote_message_refs rmr
        ON rmr.folder_id = ${params.folderId}::uuid
       AND rmr.uid_validity = ${params.uidValidity}::numeric
       AND rmr.uid = incoming.uid
    ),
    -- A reconcile window lists every message it covers, on a server without CONDSTORE once a
    -- minute: only a reference whose modseq changed is written.
    refreshed AS (
      UPDATE mail.remote_message_refs rmr
      SET modseq = matched.modseq, last_seen_at = now()
      FROM matched
      WHERE rmr.id = matched.id
        AND rmr.modseq IS DISTINCT FROM matched.modseq
      RETURNING rmr.id
    ),
    changed AS (
      UPDATE mail.message_placements mp
      SET flags = matched.flags, keywords = matched.labels, updated_at = now()
      FROM matched
      WHERE mp.remote_message_ref_id = matched.id
        AND (mp.flags IS DISTINCT FROM matched.flags OR mp.keywords IS DISTINCT FROM matched.labels)
      RETURNING mp.remote_message_ref_id
    )
    SELECT (SELECT count(*) FROM changed)::int AS count
  `;
  return result?.count ?? 0;
};

const markMissingUids = async (params: {
  db: typeof sql;
  folderId: string;
  uidValidity: string;
  lowUid: number;
  highUid: number;
  existingUids: number[];
}): Promise<number> => {
  const result = await params.db`
    WITH missing AS (
      UPDATE mail.remote_message_refs rmr
      SET stale_at = now()
      WHERE rmr.folder_id = ${params.folderId}::uuid
        AND rmr.uid_validity = ${params.uidValidity}::numeric
        AND rmr.uid BETWEEN ${params.lowUid}::numeric AND ${params.highUid}::numeric
        AND rmr.stale_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(${params.existingUids}::jsonb) AS remote(uid)
          WHERE remote.uid::numeric = rmr.uid
        )
      RETURNING rmr.id
    )
    UPDATE mail.message_placements mp
    SET deleted_at = now(), updated_at = now()
    FROM missing
    WHERE mp.remote_message_ref_id = missing.id
  `;
  return result.count;
};

const finishFailedRun = async (runId: string, code: string): Promise<void> => {
  await sql`
    UPDATE mail.sync_runs
    SET state = 'failed', error_code = ${code}, error_message = 'Mail synchronization failed', finished_at = now()
    WHERE id = ${runId}::uuid AND state = 'running'
  `.catch(() => undefined);
};

const recordSyncFailure = async (params: {
  folderId: string;
  bindingId: string | null;
  secretRevision: number | null;
  fence: FenceClaim | null;
  error: unknown;
}): Promise<void> => {
  const code = normalizeSyncErrorCode(params.error);
  const authFailure = isProviderAuthenticationFailure(params.error, code);
  const message = providerErrorMessage(params.error, "Mail synchronization failed");
  await sql
    .begin(async (tx) => {
      const [folder] = await tx<{ remote_resource_id: string; mailbox_id: string }[]>`
      SELECT f.remote_resource_id, rr.mailbox_id
      FROM mail.folders f
      JOIN mail.remote_resources rr ON rr.id = f.remote_resource_id
      WHERE f.id = ${params.folderId}::uuid
        AND (
          ${params.fence?.token ?? null}::bigint IS NULL
          OR (
            rr.current_fence_token = ${params.fence?.token ?? null}::bigint
            AND rr.sync_generation = ${params.fence?.generation ?? null}::bigint
          )
        )
      FOR UPDATE OF rr
    `;
      if (!folder) return;
      if (params.bindingId) {
        await tx`
        UPDATE mail.provider_bindings pb
        SET
          state = CASE WHEN ${authFailure} THEN 'degraded' ELSE state END,
          last_error_code = ${code},
          last_error_message = ${message}
        FROM mail.provider_connections pc
        WHERE pb.id = ${params.bindingId}::uuid
          AND pc.id = pb.connection_id
          AND pb.state <> 'revoked'
          AND (
            ${params.secretRevision}::integer IS NULL
            OR (
              pc.secret_revision = ${params.secretRevision}::integer
              AND pb.verified_secret_revision = ${params.secretRevision}::integer
            )
          )
      `;
        if (authFailure) {
          await tx`
          UPDATE mail.provider_connections pc
          SET status = 'degraded', last_error_code = ${code}, last_error_message = ${message}
          FROM mail.provider_bindings pb
          WHERE pb.id = ${params.bindingId}::uuid
            AND pc.id = pb.connection_id
            AND pc.status <> 'revoked'
            AND (
              ${params.secretRevision}::integer IS NULL
              OR (
                pc.secret_revision = ${params.secretRevision}::integer
                AND pb.verified_secret_revision = ${params.secretRevision}::integer
              )
            )
        `;
        }
      }
      const [alternative] = await tx<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM mail.provider_bindings pb
        JOIN mail.provider_connections pc ON pc.id = pb.connection_id
        WHERE pb.remote_resource_id = ${folder.remote_resource_id}::uuid
          AND pb.state = 'active'
          AND pb.verified_scope_fingerprint = (
            SELECT scope_fingerprint FROM mail.remote_resources WHERE id = ${folder.remote_resource_id}::uuid
          )
          AND pb.verified_secret_revision = pc.secret_revision
          AND pc.status = 'active'
          AND pc.encrypted_secret IS NOT NULL
          AND (
            ${params.bindingId}::uuid IS NULL
            OR pb.id <> ${params.bindingId}::uuid
            OR ${params.secretRevision}::integer IS NULL
            OR pc.secret_revision <> ${params.secretRevision}::integer
          )
      ) AS exists
    `;
      if (alternative?.exists) return;
      await tx`
      UPDATE mail.remote_resources
      SET
        status = ${authFailure || code === "NO_SYNC_BINDING" ? "connection_required" : "degraded"},
        last_error_code = ${code},
        last_error_message = ${message}
      WHERE id = ${folder.remote_resource_id}::uuid
    `;
      // Pausing does not fence a running sync; a late failure must not hide the pause.
      await tx`
      UPDATE mail.mailboxes
      SET
        health = CASE
          WHEN sync_enabled = false THEN 'paused'
          ELSE ${authFailure ? "auth_required" : code === "NO_SYNC_BINDING" ? "connection_required" : "degraded"}
        END,
        health_reason = CASE WHEN sync_enabled = false THEN 'Synchronization paused by a mailbox administrator' ELSE ${message} END
      WHERE id = ${folder.mailbox_id}::uuid
    `;
    })
    .catch(() => undefined);
};

type SyncRuntime = Awaited<ReturnType<typeof loadResolvedRuntime>>;
type FolderStatus = Awaited<ReturnType<typeof imapSmtpConnector.getFolderStatus>>;
type EnvelopeBatch = Awaited<ReturnType<typeof imapSmtpConnector.fetchEnvelopeBatch>>;
type ReconcileWindow = {
  low: number;
  high: number;
  uids: number[];
  /** Remote flag state for the window, so reconciliation also works without CONDSTORE. */
  flags: FlagChange[];
  /** Envelopes for window UIDs that have no live local reference; re-imported through the backfill path. */
  imports: ConnectorEnvelope[];
  /** The window ends a walk through the folder's UIDs up to its newest one. */
  completesWalk?: boolean;
};

const loadSyncFolder = async (folderId: string): Promise<FolderSyncRow | null> => {
  const [folder] = await sql<FolderSyncRow[]>`
    SELECT
      f.id AS folder_id,
      rr.mailbox_id,
      rr.id AS remote_resource_id,
      rr.sync_generation,
      f.envelope_cursor,
      f.role
    FROM mail.folders f
    JOIN mail.remote_resources rr ON rr.id = f.remote_resource_id
    JOIN mail.mailboxes m ON m.id = rr.mailbox_id
    WHERE f.id = ${folderId}::uuid
      AND f.selected_for_sync = true
      AND f.discovery_state = 'active'
      AND f.sync_status <> 'excluded'
      AND m.sync_enabled = true
      AND m.deleted_at IS NULL
  `;
  return folder ?? null;
};

const fetchEnvelopeStep = async (params: {
  cursor: EnvelopeCursor;
  currentHighUid: number;
  runtime: SyncRuntime;
  folderPath: string;
  folderId: string;
  uidValidity: string;
  signal: AbortSignal;
}): Promise<{ batch: EnvelopeBatch | null; kind: "incremental" | "backfill" | null }> => {
  const { cursor } = params;
  if (cursor.incrementalNextHigh == null && params.currentHighUid > cursor.highestSeenUid) {
    cursor.incrementalTargetHigh = params.currentHighUid;
    cursor.incrementalNextHigh = params.currentHighUid;
  }
  if (cursor.incrementalNextHigh != null) {
    const lowUid = cursor.highestSeenUid + 1;
    const batch = await imapSmtpConnector.fetchEnvelopeBatch(
      params.runtime,
      {
        folderPath: params.folderPath,
        folderStableKey: params.folderId,
        uidValidity: params.uidValidity,
        highUid: cursor.incrementalNextHigh,
        lowUid,
        limit: ENVELOPE_BATCH_SIZE,
      },
      params.signal,
    );
    if (batch.nextHighUid == null || batch.nextHighUid < lowUid) {
      cursor.highestSeenUid = cursor.incrementalTargetHigh ?? params.currentHighUid;
      cursor.incrementalNextHigh = null;
      cursor.incrementalTargetHigh = null;
    } else {
      cursor.incrementalNextHigh = batch.nextHighUid;
    }
    return { batch, kind: "incremental" };
  }
  if (!cursor.backfillComplete && cursor.backfillNextHigh != null) {
    const batch = await imapSmtpConnector.fetchEnvelopeBatch(
      params.runtime,
      {
        folderPath: params.folderPath,
        folderStableKey: params.folderId,
        uidValidity: params.uidValidity,
        highUid: cursor.backfillNextHigh,
        limit: ENVELOPE_BATCH_SIZE,
      },
      params.signal,
    );
    cursor.backfillNextHigh = batch.nextHighUid;
    cursor.backfillComplete = batch.nextHighUid == null;
    return { batch, kind: "backfill" };
  }
  return { batch: null, kind: null };
};

const fetchFlagStep = async (params: {
  cursor: EnvelopeCursor;
  currentHighUid: number;
  runtime: SyncRuntime;
  folderPath: string;
  uidValidity: string;
  highestModseq: string | null;
  signal: AbortSignal;
}): Promise<FlagChange[]> => {
  const { cursor } = params;
  if (!params.highestModseq) return [];
  if (!cursor.highestModseq) {
    cursor.highestModseq = params.highestModseq;
    return [];
  }
  if (BigInt(params.highestModseq) <= BigInt(cursor.highestModseq)) return [];
  if (!cursor.flagTargetModseq) {
    cursor.flagTargetModseq = params.highestModseq;
    cursor.flagNextLow = 1;
    cursor.flagMaxUid = params.currentHighUid;
  }
  if (cursor.flagNextLow == null || cursor.flagMaxUid == null || cursor.flagNextLow > cursor.flagMaxUid) return [];

  const highUid = Math.min(cursor.flagMaxUid, cursor.flagNextLow + FLAG_WINDOW_SIZE - 1);
  const changes = await imapSmtpConnector.fetchFlagChanges(
    params.runtime,
    params.folderPath,
    params.uidValidity,
    cursor.highestModseq,
    cursor.flagNextLow,
    highUid,
    params.signal,
  );
  cursor.flagNextLow = highUid + 1;
  if (cursor.flagNextLow > cursor.flagMaxUid) {
    cursor.highestModseq = cursor.flagTargetModseq;
    cursor.flagTargetModseq = null;
    cursor.flagNextLow = null;
    cursor.flagMaxUid = null;
  }
  return changes;
};

/**
 * One UID window of the folder: the remote flags, the UIDs the provider still lists, and the
 * envelopes of listed UIDs Mail has no live local record for. A window with more of those gaps
 * than one envelope batch carries ends at the last gap it imports, so the next window continues
 * behind it instead of repeating it.
 */
const fetchReconcileWindow = async (params: {
  low: number;
  high: number;
  newestFirst: boolean;
  currentHighUid: number;
  remoteMessages: number;
  runtime: SyncRuntime;
  folderPath: string;
  folderId: string;
  uidValidity: string;
  draftsFolder: boolean;
  fetchedUids: ReadonlySet<number>;
  signal: AbortSignal;
}): Promise<ReconcileWindow> => {
  const flags = await imapSmtpConnector.fetchUidWindow(
    params.runtime,
    params.folderPath,
    params.uidValidity,
    params.low,
    params.high,
    params.signal,
  );
  // A window that spans the whole folder and still reports nothing contradicts
  // the folder status: never let that silence retire local messages.
  if (flags.length === 0 && params.remoteMessages > 0 && params.low === 1 && params.high >= params.currentHighUid) {
    throw Object.assign(new Error("Reconciliation window reported no remote messages while the folder is not empty"), {
      code: "RECONCILE_WINDOW_UNTRUSTED",
    });
  }
  const imports = await fetchReconcileImports({
    // The Drafts folder imports its drafts; every other folder never fetches them. This batch
    // imports the UIDs its envelope step fetched already; see fetchReconcileStep.
    uids: (params.draftsFolder ? flags : flags.filter((entry) => !isProviderDraft(entry)))
      .map((entry) => entry.uid)
      .filter((uid) => !params.fetchedUids.has(uid)),
    newestFirst: params.newestFirst,
    runtime: params.runtime,
    folderPath: params.folderPath,
    folderId: params.folderId,
    uidValidity: params.uidValidity,
    // A draft never gets a message reference, so a walk hands every draft to the draft projection
    // again, which re-checks one without a usable modseq. A newest-first window only looks for
    // removed messages, so it fetches just the drafts Mail does not track yet.
    trackedDrafts: params.draftsFolder && params.newestFirst,
    signal: params.signal,
  });
  const low = imports.truncated && params.newestFirst ? imports.uids[0]! : params.low;
  const high = imports.truncated && !params.newestFirst ? imports.uids.at(-1)! : params.high;
  const covered = flags.filter((entry) => entry.uid >= low && entry.uid <= high);
  return { low, high, uids: covered.map((entry) => entry.uid), flags: covered, imports: imports.messages };
};

export const fetchReconcileStep = async (params: {
  cursor: EnvelopeCursor;
  currentHighUid: number;
  remoteMessages: number;
  /** STATUS HIGHESTMODSEQ; without it, no flag change reaches Mail between reconcile windows. */
  highestModseq: string | null;
  runtime: SyncRuntime;
  folderPath: string;
  folderId: string;
  uidValidity: string;
  /** The Drafts folder imports its drafts; every other folder never fetches them. */
  draftsFolder: boolean;
  /**
   * UIDs this batch imports from its envelope step: they have no local record until the batch
   * commits. Outside Drafts that leaves out the drafts it skips: should another client send one
   * meanwhile, the window finds it without its draft flag and imports it.
   */
  fetchedUids: ReadonlySet<number>;
  signal: AbortSignal;
}): Promise<ReconcileWindow | null> => {
  const { cursor } = params;
  const due =
    cursor.backfillComplete &&
    (!cursor.lastFullReconcileAt || Date.now() - new Date(cursor.lastFullReconcileAt).getTime() >= 6 * 60 * 60_000);
  if (due || cursor.reconcileNextLow != null) {
    const low = cursor.reconcileNextLow ?? 1;
    if (low > params.currentHighUid) {
      cursor.reconcileNextLow = null;
      cursor.lastFullReconcileAt = new Date().toISOString();
      return null;
    }
    const window = await fetchReconcileWindow({
      ...params,
      low,
      high: Math.min(params.currentHighUid, low + RECONCILE_WINDOW_SIZE - 1),
      newestFirst: false,
    });
    cursor.reconcileNextLow = window.high < params.currentHighUid ? window.high + 1 : null;
    if (cursor.reconcileNextLow == null) cursor.lastFullReconcileAt = new Date().toISOString();
    return { ...window, completesWalk: cursor.reconcileNextLow == null };
  }
  // Newest first, one window per batch. While messages are known to have left the folder, the
  // windows search for them until the counts match. A server without CONDSTORE reports flag
  // changes no other way, so once backfill finished every sync reconciles the newest window, where
  // most changes happen, and a continuation batch then reconciles the next older window: the
  // older windows take turns. Mail keeps no flags of drafts, so the Drafts folder needs no sweep.
  let high: number;
  if (cursor.vanishedSearch) {
    if (cursor.sweepNextHigh == null) return null;
    high = Math.min(cursor.sweepNextHigh, cursor.highestSeenUid);
  } else if (cursor.backfillComplete && params.highestModseq == null && !params.draftsFolder) {
    high = cursor.sweepOlderDue ? Math.min(cursor.sweepNextHigh ?? 0, cursor.highestSeenUid) : cursor.highestSeenUid;
  } else {
    cursor.sweepOlderDue = false;
    return null;
  }
  if (high < 1) {
    cursor.sweepNextHigh = null;
    cursor.sweepOlderDue = false;
    return null;
  }
  const low = await newestFirstWindowLow({
    folderId: params.folderId,
    uidValidity: params.uidValidity,
    draftsFolder: params.draftsFolder,
    high,
    remoteMessages: params.remoteMessages,
    skippedDrafts: params.draftsFolder ? 0 : (cursor.remoteUncounted ?? 0),
  });
  const window = await fetchReconcileWindow({ ...params, low, high, newestFirst: true });
  if (cursor.vanishedSearch || cursor.sweepOlderDue || window.low === 1) {
    cursor.sweepNextHigh = window.low > 1 ? window.low - 1 : null;
    cursor.sweepOlderDue = false;
  } else {
    // The newest window: the older windows' turn continues below it.
    if (cursor.sweepNextHigh == null || cursor.sweepNextHigh >= window.low) cursor.sweepNextHigh = window.low - 1;
    cursor.sweepOlderDue = true;
  }
  return window;
};

/**
 * Low UID of the newest-first window that ends at `high`: the window reaches down to the
 * RECONCILE_WINDOW_SIZE-th live local UID, or to the first UID when fewer are left. A window
 * spans messages rather than UIDs, so a folder whose UIDs are spread thin, such as an Inbox that
 * is emptied regularly, needs no more windows than its message count requires.
 *
 * The provider also lists the messages Mail keeps no record of: the drafts it skips outside the
 * Drafts folder, and any other surplus of the remote count. While either reaches a window's size,
 * a window spans RECONCILE_WINDOW_SIZE UIDs instead, so one window never lists much more than two
 * windows' worth of messages.
 */
const newestFirstWindowLow = async (params: {
  folderId: string;
  uidValidity: string;
  draftsFolder: boolean;
  high: number;
  remoteMessages: number;
  skippedDrafts: number;
}): Promise<number> => {
  const local = await countLiveUids(sql, params.folderId, params.uidValidity, params.draftsFolder, Number.MAX_SAFE_INTEGER);
  if (Math.max(params.skippedDrafts, params.remoteMessages - local) >= RECONCILE_WINDOW_SIZE) {
    return Math.max(1, params.high - RECONCILE_WINDOW_SIZE + 1);
  }
  const [row] = params.draftsFolder
    ? await sql<{ uid: string }[]>`
        SELECT live.uid::text AS uid
        FROM (
          SELECT DISTINCT snapshot.uid
          FROM mail.draft_provider_snapshots snapshot
          WHERE snapshot.folder_id = ${params.folderId}::uuid
            AND snapshot.uid_validity = ${params.uidValidity}::numeric
            AND snapshot.uid <= ${params.high}::numeric
            AND snapshot.state IN ('active', 'appending', 'external', 'importing', 'retiring')
        ) AS live
        ORDER BY live.uid DESC
        OFFSET ${RECONCILE_WINDOW_SIZE - 1}
        LIMIT 1
      `
    : await sql<{ uid: string }[]>`
        SELECT rmr.uid::text AS uid
        FROM mail.remote_message_refs rmr
        WHERE rmr.folder_id = ${params.folderId}::uuid
          AND rmr.uid_validity = ${params.uidValidity}::numeric
          AND rmr.stale_at IS NULL
          AND rmr.uid <= ${params.high}::numeric
        ORDER BY rmr.uid DESC
        OFFSET ${RECONCILE_WINDOW_SIZE - 1}
        LIMIT 1
      `;
  return row ? Number(row.uid) : 1;
};

// UIDs the provider still lists but that have no live local record: a gap left
// by a lost batch or a wrongly retired message. Re-import them through the same
// envelope path backfill uses, at most one envelope batch at a time, starting at
// the side the window walks from.
const fetchReconcileImports = async (params: {
  uids: number[];
  newestFirst: boolean;
  runtime: SyncRuntime;
  folderPath: string;
  folderId: string;
  uidValidity: string;
  /** Whether a draft snapshot in the folder counts as a live local record. */
  trackedDrafts: boolean;
  signal: AbortSignal;
}): Promise<{ messages: ConnectorEnvelope[]; uids: number[]; truncated: boolean }> => {
  if (params.uids.length === 0) return { messages: [], uids: [], truncated: false };
  const missing = await sql<{ uid: string }[]>`
    SELECT remote.uid
    FROM jsonb_array_elements_text(${params.uids}::jsonb) AS remote(uid)
    WHERE NOT EXISTS (
      SELECT 1
      FROM mail.remote_message_refs rmr
      WHERE NOT ${params.trackedDrafts}::boolean
        AND rmr.folder_id = ${params.folderId}::uuid
        AND rmr.uid_validity = ${params.uidValidity}::numeric
        AND rmr.uid = remote.uid::numeric
        AND rmr.stale_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM mail.draft_provider_snapshots snapshot
      WHERE ${params.trackedDrafts}::boolean
        AND snapshot.folder_id = ${params.folderId}::uuid
        AND snapshot.uid_validity = ${params.uidValidity}::numeric
        AND snapshot.uid = remote.uid::numeric
    )
    ORDER BY CASE WHEN ${params.newestFirst}::boolean THEN -remote.uid::numeric ELSE remote.uid::numeric END
    LIMIT ${ENVELOPE_BATCH_SIZE + 1}
  `;
  if (missing.length === 0) return { messages: [], uids: [], truncated: false };
  const truncated = missing.length > ENVELOPE_BATCH_SIZE;
  const uids = missing
    .slice(0, ENVELOPE_BATCH_SIZE)
    .map((row) => Number(row.uid))
    .sort((left, right) => left - right);
  const batch = await imapSmtpConnector.fetchEnvelopeBatch(
    params.runtime,
    {
      folderPath: params.folderPath,
      folderStableKey: params.folderId,
      uidValidity: params.uidValidity,
      highUid: uids.at(-1)!,
      lowUid: uids[0]!,
      limit: ENVELOPE_BATCH_SIZE,
      uids,
    },
    params.signal,
  );
  return { messages: batch.messages, uids, truncated };
};

/**
 * Live local UIDs of the folder: message references, or in the Drafts folder the drafts Mail
 * tracks there, in the states a reconcile window can retire. A retiring draft is still on the
 * server until Mail removes it.
 */
const countLiveUids = async (
  db: typeof sql,
  folderId: string,
  uidValidity: string,
  draftsFolder: boolean,
  maxUid: number,
): Promise<number> => {
  const [row] = draftsFolder
    ? await db<{ count: number }[]>`
        SELECT count(DISTINCT uid)::int AS count
        FROM mail.draft_provider_snapshots
        WHERE folder_id = ${folderId}::uuid
          AND uid_validity = ${uidValidity}::numeric
          AND uid <= ${maxUid}::numeric
          AND state IN ('active', 'appending', 'external', 'importing', 'retiring')
      `
    : await db<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM mail.remote_message_refs
        WHERE folder_id = ${folderId}::uuid
          AND uid_validity = ${uidValidity}::numeric
          AND uid <= ${maxUid}::numeric
          AND stale_at IS NULL
      `;
  return row?.count ?? 0;
};

/**
 * An IMAP server reports a removed message only to a client that has the folder open, so the
 * folder's message count shows that messages left it: a delete or a move in another client.
 * Once every UID is imported, the live local UIDs plus the drafts Mail skips outside the Drafts
 * folder match STATUS MESSAGES up to the folder's offset. More local UIDs start a newest-first
 * search through the reconcile windows, which ends as soon as the counts match again.
 *
 * Only a recount changes the skipped drafts, and only the counts themselves move the offset:
 * a higher remote count lowers it at once, a difference a complete search leaves raises it. A
 * message that leaves while a search runs, or before the next count check, is no such
 * difference: a search that retired a message and still leaves one searches again, so only a
 * search that found nothing to retire raises the offset. Should a removal still race such a
 * search, the next full reconciliation retires the message and lowers the offset again.
 *
 * New mail Mail has not imported yet is in this batch's count but not in Mail's, so a folder that
 * receives mail before every sync is compared with the count of the batch that imported the UIDs
 * up to highestSeenUid. That count is at most one batch old and can only show fewer removals than
 * happened; Mail's own changes since can make it look lower, so it never lowers the offset.
 */
const checkVanishedMessages = async (params: {
  cursor: EnvelopeCursor;
  status: Pick<FolderStatus, "uidValidity" | "uidNext" | "messages">;
  folderId: string;
  draftsFolder: boolean;
  countDrafts: (maxUid: number) => Promise<number>;
}): Promise<void> => {
  const { cursor, status } = params;
  if (!cursor.backfillComplete || cursor.incrementalNextHigh != null || cursor.reconcileNextLow != null) return;
  const current = status.uidNext - 1 === cursor.highestSeenUid;
  const messages = current ? status.messages : cursor.countedMessages;
  if (messages == null) return;
  const local = await countLiveUids(sql, params.folderId, status.uidValidity, params.draftsFolder, cursor.highestSeenUid);
  const offset = cursor.countOffset ?? 0;
  let uncounted = params.draftsFolder ? 0 : (cursor.remoteUncounted ?? 0);
  let gap = local + uncounted - messages;
  let draftsCounted = params.draftsFolder;
  if (gap !== offset && !params.draftsFolder && !(cursor.vanishedSearch && cursor.sweepNextHigh != null)) {
    // A skipped draft may have left or lost its flag: count the drafts before the counts decide.
    // Without that count the search still runs; it only costs more windows.
    const counted = await params.countDrafts(cursor.highestSeenUid).catch((error: unknown) => {
      log.warn("Mail could not count a folder's drafts and searches it for removed messages", {
        folderId: params.folderId,
        code: providerErrorCode(error, "DRAFT_COUNT_FAILED"),
      });
      return null;
    });
    if (counted != null) uncounted = counted;
    draftsCounted = counted != null;
    gap = local + uncounted - messages;
  }
  cursor.remoteUncounted = uncounted;
  // The provider lists more messages than Mail counts: the folder's count runs that much higher.
  if (gap < offset && current) cursor.countOffset = gap;
  if (gap <= offset) {
    cursor.vanishedSearch = false;
    return;
  }
  if (cursor.vanishedSearch && cursor.sweepNextHigh != null) return;
  // A search that retired a message and still leaves a difference missed a message that left
  // meanwhile, in a window it had already searched or after it ended: it searches again.
  if (!cursor.vanishedSearch || cursor.searchRetired) {
    cursor.vanishedSearch = true;
    cursor.searchRetired = false;
    cursor.sweepNextHigh = cursor.highestSeenUid;
    cursor.sweepOlderDue = false;
    return;
  }
  // Every window was searched, none retired a message, and the counts still differ: this server
  // counts differently. A draft count the server refused may still include drafts that left, so
  // the offset then takes over the skipped drafts instead of counting on them.
  if (draftsCounted) {
    cursor.countOffset = gap;
  } else {
    cursor.countOffset = local - messages;
    cursor.remoteUncounted = 0;
  }
  cursor.vanishedSearch = false;
};

const reconcileWindowStart = (uid: number): number => {
  const boundedUid = Math.max(1, Number.isSafeInteger(uid) ? uid : 1);
  return Math.floor((boundedUid - 1) / RECONCILE_WINDOW_SIZE) * RECONCILE_WINDOW_SIZE + 1;
};

/**
 * A message the sync skipped as a draft has no local reference. When the provider reports it
 * without `\Draft` at the same UID, the folder reconciles from that UID's window to import it.
 */
const reconcileRevealedDrafts = async (params: {
  db: typeof sql;
  folderId: string;
  uidValidity: string;
  changes: FlagChange[];
  cursor: EnvelopeCursor;
}): Promise<void> => {
  const uids = params.changes.filter((change) => !isProviderDraft(change)).map((change) => change.uid);
  if (uids.length === 0) return;
  const [revealed] = await params.db<{ uid: string | null }[]>`
    SELECT min(remote.uid::numeric)::text AS uid
    FROM jsonb_array_elements_text(${uids}::jsonb) AS remote(uid)
    WHERE NOT EXISTS (
      SELECT 1
      FROM mail.remote_message_refs ref
      WHERE ref.folder_id = ${params.folderId}::uuid
        AND ref.uid_validity = ${params.uidValidity}::numeric
        AND ref.uid = remote.uid::numeric
        AND ref.stale_at IS NULL
    )
  `;
  if (revealed?.uid == null) return;
  const start = reconcileWindowStart(Number(revealed.uid));
  params.cursor.reconcileNextLow = Math.min(params.cursor.reconcileNextLow ?? start, start);
};

/** Whether the folder is the mailbox's Drafts folder: the one configured for drafts, else the provider's. */
const isEffectiveDraftsFolder = async (db: typeof sql, folder: Pick<FolderSyncRow, "mailbox_id" | "role">, folderId: string) => {
  const [effectiveRole] = await db<{ is_drafts: boolean }[]>`
    SELECT (
      EXISTS (
        SELECT 1
        FROM mail.folder_role_overrides override
        WHERE override.mailbox_id = ${folder.mailbox_id}::uuid
          AND override.role = 'drafts'
          AND override.folder_id = ${folderId}::uuid
      )
      OR (
        ${folder.role} = 'drafts'
        AND NOT EXISTS (
          SELECT 1
          FROM mail.folder_role_overrides override
          WHERE override.mailbox_id = ${folder.mailbox_id}::uuid
            AND override.role = 'drafts'
        )
      )
    ) AS is_drafts
  `;
  return effectiveRole?.is_drafts === true;
};

export const commitSyncBatch = async (params: {
  folder: FolderSyncRow;
  folderId: string;
  bindingId: string;
  secretRevision: number;
  fence: FenceClaim;
  status: FolderStatus;
  beforeCursor: EnvelopeCursor | null;
  cursor: EnvelopeCursor;
  uidValidityChanged: boolean;
  envelopeBatch: EnvelopeBatch | null;
  envelopeKind: "incremental" | "backfill" | null;
  flagChanges: FlagChange[];
  reconcileWindow: ReconcileWindow | null;
}): Promise<{
  hydratedIds: string[];
  draftImportSnapshotIds: string[];
  draftExportSnapshotIds: string[];
  flagsUpdated: number;
  removed: number;
  liveInvalidated: boolean;
}> => {
  const result = await sql.begin(async (tx) => {
    const [resource] = await tx<{ id: string }[]>`
      SELECT id
      FROM mail.remote_resources
      WHERE id = ${params.folder.remote_resource_id}::uuid
        AND current_fence_token = ${params.fence.token}
        AND sync_generation = ${params.fence.generation}
        AND EXISTS (
          SELECT 1
          FROM mail.mailboxes m
          WHERE m.id = ${params.folder.mailbox_id}::uuid
            AND m.sync_enabled = true
            AND m.deleted_at IS NULL
        )
      FOR UPDATE
    `;
    if (!resource) throw Object.assign(new Error("Stale mail sync fence"), { code: "STALE_SYNC_FENCE" });
    const [lockedFolder] = await tx<{ id: string; reconcile_next_low: string | null }[]>`
      SELECT id, envelope_cursor ->> 'reconcileNextLow' AS reconcile_next_low
      FROM mail.folders
      WHERE id = ${params.folderId}::uuid
      FOR UPDATE
    `;
    if (!lockedFolder) throw new Error("Folder disappeared during sync");
    // A reconcile request (push EXPUNGE, reconnect) may have rewound the stored
    // cursor while this batch ran; the batch result must not overwrite it.
    const storedReconcileLow = lockedFolder.reconcile_next_low == null ? null : Number(lockedFolder.reconcile_next_low);
    if (storedReconcileLow != null && storedReconcileLow !== (params.beforeCursor?.reconcileNextLow ?? null)) {
      params.cursor.reconcileNextLow = Math.min(storedReconcileLow, params.cursor.reconcileNextLow ?? storedReconcileLow);
    }
    const isDraftFolder = await isEffectiveDraftsFolder(tx, params.folder, params.folderId);
    if (params.uidValidityChanged && !isDraftFolder) {
      await tx`
        WITH stale AS (
          UPDATE mail.remote_message_refs
          SET stale_at = now()
          WHERE folder_id = ${params.folderId}::uuid AND stale_at IS NULL
          RETURNING id
        )
        UPDATE mail.message_placements mp
        SET deleted_at = now(), updated_at = now()
        FROM stale
        WHERE mp.remote_message_ref_id = stale.id
      `;
    }

    const hydratedIds: string[] = [];
    let draftImportSnapshotIds: string[] = [];
    let draftExportSnapshotIds: string[] = [];
    let draftRemoved = 0;
    if (isDraftFolder) {
      const projection = await recordDraftFolderSyncInTransaction({
        db: tx,
        mailboxId: params.folder.mailbox_id,
        remoteResourceId: params.folder.remote_resource_id,
        bindingId: params.bindingId,
        folderId: params.folderId,
        uidValidity: params.status.uidValidity,
        uidValidityChanged: params.uidValidityChanged,
        envelopes: [...(params.envelopeBatch?.messages ?? []), ...(params.reconcileWindow?.imports ?? [])],
        reconcileWindow: params.reconcileWindow,
      });
      draftImportSnapshotIds = projection.importSnapshotIds;
      draftExportSnapshotIds = projection.exportSnapshotIds;
      draftRemoved = projection.removed;
    } else {
      for (const message of params.envelopeBatch?.messages ?? []) {
        if (isProviderDraft(message)) {
          // The folder's message count includes it; see checkVanishedMessages.
          params.cursor.remoteUncounted = (params.cursor.remoteUncounted ?? 0) + 1;
          continue;
        }
        hydratedIds.push(
          await ingestEnvelope({
            db: tx,
            mailboxId: params.folder.mailbox_id,
            remoteResourceId: params.folder.remote_resource_id,
            folderId: params.folderId,
            message,
            captureWorkflowTriggers: params.envelopeKind === "incremental",
          }),
        );
      }
      for (const message of params.reconcileWindow?.imports ?? []) {
        if (isProviderDraft(message)) continue;
        hydratedIds.push(
          await ingestEnvelope({
            db: tx,
            mailboxId: params.folder.mailbox_id,
            remoteResourceId: params.folder.remote_resource_id,
            folderId: params.folderId,
            message,
            captureWorkflowTriggers: false,
          }),
        );
      }
    }
    const flagsUpdated = isDraftFolder
      ? 0
      : await applyFlagChanges({
          db: tx,
          folderId: params.folderId,
          uidValidity: params.status.uidValidity,
          changes: [...params.flagChanges, ...(params.reconcileWindow?.flags ?? [])],
        });
    if (!isDraftFolder) {
      await reconcileRevealedDrafts({
        db: tx,
        folderId: params.folderId,
        uidValidity: params.status.uidValidity,
        changes: params.flagChanges,
        cursor: params.cursor,
      });
    }
    const removed = isDraftFolder
      ? draftRemoved
      : params.reconcileWindow
        ? await markMissingUids({
            db: tx,
            folderId: params.folderId,
            uidValidity: params.status.uidValidity,
            lowUid: params.reconcileWindow.low,
            highUid: params.reconcileWindow.high,
            existingUids: params.reconcileWindow.uids,
          })
        : 0;
    if (params.cursor.vanishedSearch && removed > 0) params.cursor.searchRetired = true;
    // A completed walk leaves Mail's messages in line with the provider's, but for removals while
    // it ran, so the gap it leaves is at most the folder's offset. An offset above it holds a
    // message removed during an earlier search, and a removal right after this walk would hide
    // behind it.
    if (
      params.reconcileWindow?.completesWalk &&
      params.cursor.backfillComplete &&
      params.status.uidNext - 1 === params.cursor.highestSeenUid
    ) {
      const local = await countLiveUids(tx, params.folderId, params.status.uidValidity, isDraftFolder, params.cursor.highestSeenUid);
      const gap = local + (isDraftFolder ? 0 : (params.cursor.remoteUncounted ?? 0)) - params.status.messages;
      if (gap < (params.cursor.countOffset ?? 0)) params.cursor.countOffset = gap;
    }
    await tx`
      UPDATE mail.folders
      SET
        envelope_cursor = ${params.cursor}::jsonb,
        sync_status = ${params.cursor.backfillComplete ? "current" : "syncing"},
        last_reconciled_at = CASE WHEN ${params.reconcileWindow != null} THEN now() ELSE last_reconciled_at END
      WHERE id = ${params.folderId}::uuid
    `;
    await tx`
      UPDATE mail.binding_folder_refs
      SET
        uid_validity = ${params.status.uidValidity}::numeric,
        uid_next = ${params.status.uidNext}::numeric,
        highest_modseq = ${params.status.highestModseq}::numeric,
        last_verified_at = now()
      WHERE binding_id = ${params.bindingId}::uuid AND folder_id = ${params.folderId}::uuid
    `;
    const [binding] = await tx<{ connection_id: string }[]>`
      UPDATE mail.provider_bindings
      SET last_used_at = now(), last_error_code = NULL, last_error_message = NULL
      WHERE id = ${params.bindingId}::uuid
        AND state = 'active'
        AND verified_secret_revision = ${params.secretRevision}
        AND verified_scope_fingerprint = (
          SELECT scope_fingerprint FROM mail.remote_resources WHERE id = ${params.folder.remote_resource_id}::uuid
        )
      RETURNING connection_id
    `;
    if (!binding) throw Object.assign(new Error("Sync binding changed before commit"), { code: "STALE_SYNC_BINDING" });
    const [connection] = await tx<{ id: string }[]>`
      UPDATE mail.provider_connections
      SET last_error_code = NULL, last_error_message = NULL
      WHERE id = ${binding.connection_id}::uuid
        AND status = 'active'
        AND secret_revision = ${params.secretRevision}
      RETURNING id
    `;
    if (!connection) throw Object.assign(new Error("Sync credentials changed before commit"), { code: "STALE_SYNC_BINDING" });
    await tx`
      UPDATE mail.remote_resources
      SET status = 'active', last_sync_at = now(), last_error_code = NULL, last_error_message = NULL
      WHERE id = ${params.folder.remote_resource_id}::uuid
    `;
    await tx`
      UPDATE mail.mailboxes
      SET
        health = CASE
          WHEN sync_enabled = false THEN 'paused'
          WHEN EXISTS (
            SELECT 1
            FROM mail.provider_bindings binding
            JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
            WHERE resource.mailbox_id = ${params.folder.mailbox_id}::uuid AND binding.state = 'degraded'
          ) THEN 'degraded'
          ELSE ${params.cursor.backfillComplete ? "active" : "bootstrapping"}
        END,
        health_reason = CASE
          WHEN sync_enabled = false THEN 'Synchronization paused by a mailbox administrator'
          WHEN EXISTS (
            SELECT 1
            FROM mail.provider_bindings binding
            JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
            WHERE resource.mailbox_id = ${params.folder.mailbox_id}::uuid AND binding.state = 'degraded'
          ) THEN 'One or more provider bindings require attention'
          ELSE ${params.cursor.backfillComplete ? null : "Historical synchronization in progress"}
        END
      WHERE id = ${params.folder.mailbox_id}::uuid
    `;
    await tx`
      UPDATE mail.sync_runs
      SET
        state = 'completed',
        cursor_before = ${params.beforeCursor ?? {}}::jsonb,
        cursor_after = ${params.cursor}::jsonb,
        stats = ${{
          envelopeKind: params.envelopeKind,
          imported: hydratedIds.length,
          draftImportsQueued: draftImportSnapshotIds.length,
          flagsUpdated,
          removed,
        }}::jsonb,
        finished_at = now()
      WHERE id = ${params.fence.runId}::uuid
    `;
    const liveInvalidated = hydratedIds.length > 0 || flagsUpdated > 0 || removed > 0;
    if (liveInvalidated) {
      await enqueueMailInvalidation(tx, { mailboxId: params.folder.mailbox_id });
    }
    return { hydratedIds, draftImportSnapshotIds, draftExportSnapshotIds, flagsUpdated, removed, liveInvalidated };
  });
  if (result.hydratedIds.length > 0) notifyWorkflowWorker(MAIL_WORKFLOW_APP_ID);
  if (result.liveInvalidated) await notifyMailInvalidations();
  return result;
};

/**
 * Imports one batch of the folder. A sync that checks for new mail goes before commands and
 * hydration of the same mailbox; a batch that continues with older mail is `background` work.
 */
export const syncFolderBatch = async (
  folderId: string,
  jobHeartbeat: () => Promise<void>,
  priority: Extract<ProviderLeasePriority, "sync" | "background"> = "sync",
): Promise<SyncBatchResult> => {
  const folder = await loadSyncFolder(folderId);
  if (!folder) return { hasMore: false, syncPending: false, imported: 0, flagsUpdated: 0, removed: 0 };

  const { lock, retryAfterMs: busyRetryAfterMs } = await acquireProviderLease({
    resource: folder.remote_resource_id,
    waiter: `sync-folder:${folderId}`,
    priority,
    ttlMs: SYNC_LEASE_MS,
  });
  if (!lock) throw Object.assign(new Error("Mail sync resource is busy"), { code: "SYNC_BUSY", retryAfterMs: busyRetryAfterMs });
  let runId: string | null = null;
  let selectedBindingId: string | null = null;
  let selectedSecretRevision: number | null = null;
  let activeFence: FenceClaim | null = null;
  let batch: SyncBatchResult;
  try {
    batch = await withLeaseHeartbeat<SyncBatchResult>({
      intervalMs: 30_000,
      heartbeat: async () => {
        await extendSyncLease(lock, "during background work");
        try {
          await jobHeartbeat();
        } catch (cause) {
          throw Object.assign(new Error("Mail sync job lease was lost during background work"), {
            code: "SYNC_JOB_LEASE_LOST",
            cause,
          });
        }
      },
      work: async (_assertLeaseActive, signal) => {
        const refreshedFolder = await loadSyncFolder(folderId);
        if (!refreshedFolder) return { hasMore: false, syncPending: false, imported: 0, flagsUpdated: 0, removed: 0 };
        Object.assign(folder, refreshedFolder);
        await waitForMailProviderSlot(folder.remote_resource_id, signal);
        const execution = await resolveMailExecution({
          mailboxId: folder.mailbox_id,
          operation: "backgroundSync",
          folderRequirements: [{ folderId, rights: ["read"] }],
        });
        if (!execution.ok || !execution.data.bindingId || !execution.data.connectionId) {
          throw Object.assign(new Error("No eligible sync binding"), { code: "NO_SYNC_BINDING" });
        }
        const secretRevision = execution.data.secretRevision;
        if (secretRevision == null) {
          throw Object.assign(new Error("Selected sync binding has no credential revision"), { code: "CREDENTIAL_REVISION_MISSING" });
        }
        selectedBindingId = execution.data.bindingId;
        selectedSecretRevision = secretRevision;
        const folderExecution = execution.data.folders[folderId];
        if (!folderExecution) throw Object.assign(new Error("Selected sync binding has no folder locator"), { code: "NO_FOLDER_LOCATOR" });
        const fence = await claimFence(folder.remote_resource_id, execution.data.bindingId, "incremental");
        activeFence = fence;
        runId = fence.runId;
        const runtimeSnapshot = await loadResolvedRuntimeSnapshot(execution.data.connectionId, secretRevision);
        const runtime = runtimeSnapshot.runtime;
        const status = await imapSmtpConnector.getFolderStatus(runtime, folderExecution.path, signal);
        await extendSyncLease(lock, "after status refresh");
        const currentHighUid = Math.max(0, status.uidNext - 1);
        const beforeCursor = parseCursor(folder.envelope_cursor);
        const uidValidityChanged = Boolean(beforeCursor && beforeCursor.uidValidity !== status.uidValidity);
        const cursor =
          !beforeCursor || uidValidityChanged
            ? initialCursor(status.uidValidity, currentHighUid, status.highestModseq)
            : structuredClone(beforeCursor);
        const draftsFolder = await isEffectiveDraftsFolder(sql, folder, folderId);

        await checkVanishedMessages({
          cursor,
          status,
          folderId,
          draftsFolder,
          countDrafts: (maxUid) => imapSmtpConnector.countDraftMessages(runtime, folderExecution.path, status.uidValidity, maxUid, signal),
        });

        const envelope = await fetchEnvelopeStep({
          cursor,
          currentHighUid,
          runtime,
          folderPath: folderExecution.path,
          folderId,
          uidValidity: status.uidValidity,
          signal,
        });
        const envelopeBatch = envelope.batch;
        if (envelopeBatch) await extendSyncLease(lock, "after envelope fetch");
        // Once this batch commits, Mail holds every UID this count covers; see checkVanishedMessages.
        cursor.countedMessages = cursor.backfillComplete && cursor.highestSeenUid === currentHighUid ? status.messages : null;

        const flagChanges = await fetchFlagStep({
          cursor,
          currentHighUid,
          runtime,
          folderPath: folderExecution.path,
          uidValidity: status.uidValidity,
          highestModseq: status.highestModseq,
          signal,
        });
        if (flagChanges.length > 0) await extendSyncLease(lock, "after flag fetch");

        const reconcileWindow = await fetchReconcileStep({
          cursor,
          currentHighUid,
          remoteMessages: status.messages,
          highestModseq: status.highestModseq,
          runtime,
          folderPath: folderExecution.path,
          folderId,
          uidValidity: status.uidValidity,
          draftsFolder,
          fetchedUids: new Set(
            (envelopeBatch?.messages ?? [])
              .filter((message) => draftsFolder || !isProviderDraft(message))
              .map((message) => Number(message.remoteRef.uid)),
          ),
          signal,
        });
        if (reconcileWindow) await extendSyncLease(lock, "after UID reconciliation");

        await extendSyncLease(lock, "before commit");
        const result = await commitSyncBatch({
          folder,
          folderId,
          bindingId: execution.data.bindingId,
          secretRevision,
          fence,
          status,
          beforeCursor,
          cursor,
          uidValidityChanged,
          envelopeBatch,
          envelopeKind: envelope.kind,
          flagChanges,
          reconcileWindow,
        });

        await enqueueDraftImports(result.draftImportSnapshotIds);
        await Promise.all(result.draftExportSnapshotIds.map((snapshotId) => enqueueDraftProjectionSnapshot(snapshotId)));
        const hasMore =
          cursor.incrementalNextHigh != null ||
          !cursor.backfillComplete ||
          cursor.flagNextLow != null ||
          cursor.reconcileNextLow != null ||
          (cursor.vanishedSearch === true && cursor.sweepNextHigh != null) ||
          cursor.sweepOlderDue === true;
        return {
          hasMore,
          syncPending: cursor.incrementalNextHigh != null || cursor.flagNextLow != null,
          imported: result.hydratedIds.length,
          flagsUpdated: result.flagsUpdated,
          removed: result.removed,
        };
      },
    });
  } catch (error) {
    const code = normalizeSyncErrorCode(error);
    if (runId) await finishFailedRun(runId, code);
    if (
      code !== "MAIL_RATE_LIMITED" &&
      code !== "SYNC_LEASE_LOST" &&
      code !== "SYNC_JOB_LEASE_LOST" &&
      code !== "STALE_SYNC_FENCE" &&
      code !== "STALE_SYNC_BINDING" &&
      code !== "MAILBOX_TRANSPORT_CHANGED"
    ) {
      await recordSyncFailure({
        folderId,
        bindingId: selectedBindingId,
        secretRevision: selectedSecretRevision,
        fence: activeFence,
        error,
      });
    }
    throw error;
  } finally {
    await mailProviderOperationMutex()
      .release(lock)
      .catch(() => false);
  }
  // Queued only after the provider lease is released: a hydration job that starts while this
  // sync still holds it finds the resource busy and has to try again.
  if (batch.imported > 0) await submitHydrationJob({ mailboxId: folder.mailbox_id });
  return batch;
};

const normalizeSyncErrorCode = (error: unknown): string => {
  return providerErrorCode(error, "MAIL_SYNC_FAILED");
};

const SYNC_FOLDER_MAX_ATTEMPTS = 5;
// Data the database rejects fails the same way on every attempt. The folder waits as long as an
// errored binding waits for its next verification instead of repeating the failure every minute.
const SYNC_FOLDER_DATA_ERROR_RECHECK_MS = 15 * 60_000;

const markFolderDegraded = async (folderId: string): Promise<void> => {
  await sql`UPDATE mail.folders SET sync_status = 'degraded' WHERE id = ${folderId}::uuid`.catch((cause: Error) =>
    log.error("Failed to mark a Mail folder as degraded", { folderId, error: cause.message }),
  );
};

/** `backfill` marks a continuation that only imports older mail or reconciliation windows. */
type SyncFolderJobInput = { folderId: string; backfill?: boolean };

// A sync requested while the folder's job continues with older mail joins that job and keeps its
// input. This marker lets the job's next batch rank as a folder sync again; it outlasts a long
// batch and a few retries.
const SYNC_REQUEST_MARKER_MS = 10 * 60_000;
const syncRequestKey = (folderId: string): string => `mail:sync-requested:${folderId}`;

const syncFolderJob = lazySync((sync) =>
  sync.job<SyncFolderJobInput>({
    id: "mail:sync-folder",
    delivery: { ackWaitMs: 3 * 60_000, maxAttempts: SYNC_FOLDER_MAX_ATTEMPTS, backoffMs: [5_000, 10_000, 20_000, 40_000] },
  }),
);

/** Runs one `mail:sync-folder` attempt; exported so tests can drive the job's failure handling. */
export const runSyncFolderJob = async (ctx: Pick<JobContext<SyncFolderJobInput>, "input" | "heartbeat" | "resubmit">): Promise<void> => {
  const { folderId } = ctx.input;
  let backfill = ctx.input.backfill === true;
  try {
    // A sync requested meanwhile joined this job. Its next batch checks for new mail before it
    // continues with older mail, so it ranks as a folder sync.
    if ((await redis.send("GETDEL", [syncRequestKey(folderId)])) != null) backfill = false;
    const data = await syncFolderBatch(folderId, () => ctx.heartbeat(), backfill ? "background" : "sync");
    if (data.hasMore) ctx.resubmit({ delayMs: 0, input: { folderId, backfill: !data.syncPending } });
  } catch (error) {
    const code = normalizeSyncErrorCode(error);
    if (code === "MAILBOX_TRANSPORT_CHANGED") return;
    if (code === "MAIL_RATE_LIMITED") {
      ctx.resubmit({ delayMs: retryAfterMs(error, 5_000), input: { folderId, backfill } });
      return;
    }
    // A sibling job holds the remote resource: routine contention, not a failed attempt.
    if (code === "SYNC_BUSY") {
      ctx.resubmit({ delayMs: providerBusyRetryAfterMs(error), input: { folderId, backfill } });
      return;
    }
    // The failed run and the resource error are already recorded; retries and dead letters
    // would only repeat them, because the scheduler queues a degraded folder again.
    if (isPermanentDataError(error)) {
      await markFolderDegraded(ctx.input.folderId);
      log.error("Mail folder sync stopped on data the database rejected", {
        folderId: ctx.input.folderId,
        sqlState: databaseErrorCode(error),
        constraint: databaseErrorConstraint(error),
        recheckInMs: SYNC_FOLDER_DATA_ERROR_RECHECK_MS,
      });
      ctx.resubmit({ delayMs: SYNC_FOLDER_DATA_ERROR_RECHECK_MS });
      return;
    }
    throw error;
  }
};

let syncFolderJobWorker: Worker | undefined;
const startSyncFolderJob = async (): Promise<void> => {
  syncFolderJobWorker = await syncFolderJob().process(
    {
      onError: async ({ context, error }) => {
        if (context.attempt >= SYNC_FOLDER_MAX_ATTEMPTS) {
          await markFolderDegraded(context.input.folderId);
          log.error("Mail folder sync exhausted retries", {
            folderId: context.input.folderId,
            attempt: context.attempt,
            code: normalizeSyncErrorCode(error),
          });
          return { action: "dead_letter", reason: error.message };
        }
        return { action: "retry" };
      },
    },
    runSyncFolderJob,
  );
};

// An open reader may hold an envelope-only snapshot of a message in this batch.
// One invalidation per affected conversation, committed after the whole batch,
// lets it show the body or a terminal failure (a retryable failure stays
// pending) and keeps a bulk backfill at one workspace refresh per batch.
const invalidateSettledConversations = async (mailboxId: string, messageIds: ReadonlySet<string>): Promise<void> => {
  if (messageIds.size === 0) return;
  try {
    const invalidated = await sql.begin(async (tx) => {
      const conversations = await tx<{ conversation_id: string }[]>`
        SELECT DISTINCT link.conversation_id
        FROM mail.conversation_messages link
        JOIN mail.message_contents message ON message.id = link.message_id
        WHERE link.message_id = ANY(${toPgUuidArray([...messageIds])}::uuid[])
          AND (message.hydration_status = 'complete' OR (message.hydration_status = 'failed' AND message.hydration_attempt >= 5))
      `;
      for (const conversation of conversations) {
        await enqueueMailInvalidation(tx, { mailboxId, conversationId: conversation.conversation_id });
      }
      return conversations.length;
    });
    if (invalidated > 0) await notifyMailInvalidations();
  } catch (error) {
    log.warn("Mail hydration live invalidation failed", { mailboxId, code: normalizeSyncErrorCode(error) });
  }
};

/**
 * A hydration job either works through one mailbox (`mailboxId`) or fetches one requested
 * message (`messageId`). A mailbox job hydrates one source batch per run and then queues again
 * behind every other mailbox's job, so the single worker slot takes turns between mailboxes
 * instead of draining one mailbox's backlog first.
 */
type HydrationInput = { mailboxId: string } | { messageId: string };

type HydrationTarget = {
  id: string;
  hydration_attempt: number;
  mailbox_id: string;
  folder_id: string;
  remote_resource_id: string;
};

type HydrationBatch = { hydrated: boolean; settled: number; missingFromUid: number | null; targetError: unknown };

const requestedHydrationTarget = async (messageId: string): Promise<HydrationTarget | null> => {
  const [target] = await sql<HydrationTarget[]>`
    SELECT mc.id, mc.hydration_attempt, mc.mailbox_id, rmr.folder_id, f.remote_resource_id
    FROM mail.message_contents mc
    JOIN mail.remote_message_refs rmr ON rmr.message_id = mc.id AND rmr.stale_at IS NULL
    JOIN mail.folders f
      ON f.id = rmr.folder_id
     AND f.selected_for_sync = true
     AND f.discovery_state = 'active'
     AND f.sync_status <> 'excluded'
    JOIN mail.mailboxes mailbox
      ON mailbox.id = mc.mailbox_id
     AND mailbox.sync_enabled = true
     AND mailbox.deleted_at IS NULL
    WHERE mc.id = ${messageId}::uuid
      AND mc.hydration_status <> 'complete'
      AND mc.hydration_attempt < 5
    ORDER BY f.role = 'inbox' DESC, rmr.last_seen_at DESC
    LIMIT 1
  `;
  return target ?? null;
};

/**
 * The newest body of the mailbox that a batch can fetch: a fresh one, or with `retry` one that
 * was already tried and failed or came back without a source. The folder must be readable
 * through the mailbox's binding at the reference's UIDVALIDITY, as the batch requires, so a
 * body no batch can fetch never becomes the mailbox's target.
 *
 * One index probe per hydration status keeps this cheap for any backlog; the status condition
 * repeats the predicate of `message_contents_hydration_queue_idx` so Postgres can use it.
 */
const newestPendingBody = async (mailboxId: string, retry: boolean): Promise<HydrationTarget | null> => {
  const [target] = await sql<HydrationTarget[]>`
    SELECT newest.id, newest.hydration_attempt, newest.mailbox_id, newest.folder_id, newest.remote_resource_id
    FROM mail.mailboxes mailbox
    CROSS JOIN unnest(ARRAY['envelope', 'headers', 'body', 'failed']::text[]) AS status(value)
    CROSS JOIN LATERAL (
      SELECT mc.id, mc.hydration_attempt, mc.internal_date, mc.mailbox_id, rmr.folder_id, f.remote_resource_id
      FROM mail.message_contents mc
      JOIN mail.remote_message_refs rmr ON rmr.message_id = mc.id AND rmr.stale_at IS NULL
      JOIN mail.folders f
        ON f.id = rmr.folder_id
       AND f.selected_for_sync = true
       AND f.discovery_state = 'active'
       AND f.sync_status <> 'excluded'
      WHERE mc.mailbox_id = mailbox.id
        AND mc.hydration_status = status.value
        AND (mc.hydration_status IN ('envelope', 'headers', 'body') OR (mc.hydration_status = 'failed' AND mc.hydration_attempt < 5))
        AND mc.hydration_attempt < 5
        AND (mc.hydration_attempt > 0) = ${retry}
        AND EXISTS (
          SELECT 1
          FROM mail.binding_folder_refs bfr
          JOIN mail.provider_bindings binding ON binding.id = bfr.binding_id AND binding.state IN ('active', 'degraded')
          WHERE bfr.folder_id = rmr.folder_id
            AND bfr.uid_validity = rmr.uid_validity
            AND 'read' = ANY(bfr.effective_rights)
        )
      ORDER BY mc.internal_date DESC, mc.id, f.role = 'inbox' DESC, rmr.last_seen_at DESC
      LIMIT 1
    ) newest
    WHERE mailbox.id = ${mailboxId}::uuid
      AND mailbox.sync_enabled = true
      AND mailbox.deleted_at IS NULL
    ORDER BY newest.internal_date DESC, newest.id
    LIMIT 1
  `;
  return target ?? null;
};

// Fresh bodies first, newest first. A body that was already tried comes only after every fresh
// one, so a failing or vanished message cannot take the mailbox's turn again and again.
const nextMailboxHydrationTarget = async (mailboxId: string): Promise<HydrationTarget | null> =>
  (await newestPendingBody(mailboxId, false)) ?? (await newestPendingBody(mailboxId, true));

export const hydrateMessageBatch = async (
  ctx: Pick<JobContext<HydrationInput>, "input" | "heartbeat" | "resubmit">,
): Promise<{ hydrated: boolean }> => {
  let activeClaim: { messageId: string; claimId: string } | null = null;
  return withLeaseHeartbeat({
    intervalMs: 60_000,
    heartbeat: async () => {
      await ctx.heartbeat();
      if (!activeClaim) return;
      await sql`
        UPDATE mail.message_contents
        SET hydration_claimed_at = now()
        WHERE id = ${activeClaim.messageId}::uuid
          AND hydration_status = 'hydrating'
          AND hydration_claim_id = ${activeClaim.claimId}::uuid
      `;
    },
    work: async () => {
      const message =
        "mailboxId" in ctx.input
          ? await nextMailboxHydrationTarget(ctx.input.mailboxId)
          : await requestedHydrationTarget(ctx.input.messageId);
      if (!message) return { hydrated: false };
      // A mailbox's pending bodies wait for its folder syncs and commands. A body someone waits
      // for, such as one a workflow step needs, ranks with commands.
      const { lock, retryAfterMs: busyRetryAfterMs } = await acquireProviderLease({
        resource: message.remote_resource_id,
        waiter: `hydrate:${hydrationJobKey(ctx.input)}`,
        priority: "messageId" in ctx.input ? "command" : "background",
        ttlMs: SYNC_LEASE_MS,
      });
      if (!lock) throw Object.assign(new Error("Mail remote resource is busy"), { code: "SYNC_BUSY", retryAfterMs: busyRetryAfterMs });
      let batch: HydrationBatch;
      try {
        batch = await withLeaseHeartbeat<HydrationBatch>({
          intervalMs: 30_000,
          heartbeat: () => extendSyncLease(lock, "during message hydration"),
          work: async (assertProviderLeaseActive, signal) => {
            const execution = await resolveMailExecution({
              mailboxId: message.mailbox_id,
              operation: "backgroundSync",
              folderRequirements: [{ folderId: message.folder_id, rights: ["read"] }],
            });
            if (!execution.ok || !execution.data.bindingId || !execution.data.connectionId) {
              throw Object.assign(new Error("No hydration binding"), { code: "NO_HYDRATION_BINDING" });
            }
            const folder = execution.data.folders[message.folder_id];
            if (!folder) throw Object.assign(new Error("No hydration folder locator"), { code: "NO_FOLDER_LOCATOR" });
            const runtime = await loadResolvedRuntime(execution.data.connectionId, execution.data.secretRevision);
            const transportFence = await loadMailboxTransportFence(message.remote_resource_id);
            if (!transportFence) {
              throw Object.assign(new Error("Mailbox transport changed before hydration"), { code: "MAILBOX_TRANSPORT_CHANGED" });
            }
            await waitForMailProviderSlot(message.remote_resource_id, signal);
            // A mailbox job's batch led by a fresh body takes only fresh ones, so a body that was
            // already tried is retried only by a batch that starts from it, after every fresh one.
            const takesRetries = "messageId" in ctx.input || message.hydration_attempt > 0;
            const candidates = await sql<{ id: string; uid: string | number; uid_validity: string | number }[]>`
        SELECT mc.id, rmr.uid, rmr.uid_validity
        FROM mail.message_contents mc
        JOIN mail.remote_message_refs rmr
          ON rmr.message_id = mc.id
         AND rmr.folder_id = ${message.folder_id}::uuid
         AND rmr.stale_at IS NULL
        JOIN mail.binding_folder_refs bfr
          ON bfr.folder_id = rmr.folder_id
         AND bfr.binding_id = ${execution.data.bindingId}::uuid
         AND bfr.uid_validity = rmr.uid_validity
        WHERE mc.mailbox_id = ${message.mailbox_id}::uuid
          AND mc.hydration_status <> 'complete'
          AND mc.hydration_attempt < 5
          AND (
            mc.hydration_status <> 'hydrating'
            OR mc.hydration_claimed_at < now() - interval '15 minutes'
          )
          AND (mc.hydration_attempt = 0 OR ${takesRetries})
        ORDER BY (mc.id = ${message.id}::uuid) DESC, mc.hydration_attempt > 0, mc.internal_date DESC, mc.id DESC
        LIMIT ${HYDRATION_BATCH_SIZE}
      `;
            if (candidates.length === 0) return { hydrated: false, settled: 0, missingFromUid: null, targetError: null };

            let hydrated = false;
            // Only a job for one requested message fails with its message and retries; a mailbox job
            // has recorded the failure on the message and moves on to the next fresh body.
            let targetError: unknown = null;
            const settled = new Set<string>();
            const delivered = new Set<string>();
            let missing: typeof candidates = [];
            await assertProviderLeaseActive();
            await assertMailboxTransportFence(transportFence);
            try {
              await imapSmtpConnector.downloadSourceBatch(
                runtime,
                folder.path,
                candidates.map((candidate) => ({
                  key: candidate.id,
                  uidValidity: String(candidate.uid_validity),
                  uid: Number(candidate.uid),
                })),
                async (source) => {
                  delivered.add(source.key);
                  await assertProviderLeaseActive();
                  await assertMailboxTransportFence(transportFence);
                  const claimId = randomUUID();
                  activeClaim = { messageId: source.key, claimId };
                  try {
                    const result = await hydrateMessageFromSource({
                      messageId: source.key,
                      source: source.stream,
                      expectedSize: source.expectedSize,
                      claimId,
                      transportFence,
                    });
                    if (result.status !== "already_complete") settled.add(result.canonicalMessageId ?? source.key);
                    const available =
                      result.status === "hydrated" || result.status === "already_complete" || result.status === "deduplicated";
                    hydrated ||= available;
                    await assertProviderLeaseActive();
                    await assertMailboxTransportFence(transportFence);
                    await assertProviderLeaseActive();
                    await assertMailboxTransportFence(transportFence);
                  } catch (error) {
                    const code = normalizeSyncErrorCode(error);
                    if (code === "SYNC_LEASE_LOST" || code === "MAILBOX_TRANSPORT_CHANGED") throw error;
                    if (code !== "HYDRATION_NOT_CLAIMED") {
                      settled.add(source.key);
                      log.warn("Mail message hydration failed within a source batch", { messageId: source.key, code });
                      if (source.key === message.id && "messageId" in ctx.input) targetError = error;
                    }
                  } finally {
                    activeClaim = null;
                  }
                },
                signal,
              );
              // The live connection returned no source for these UIDs. Each such fetch uses one
              // attempt, so a message the provider keeps listing without a source ends as failed.
              missing = candidates.filter((candidate) => !delivered.has(candidate.id));
              if (missing.length > 0) {
                await assertProviderLeaseActive();
                const recorded = await recordMissingMessageSources(
                  missing.map((candidate) => candidate.id),
                  transportFence,
                );
                for (const messageId of recorded) settled.add(messageId);
              }
            } finally {
              await invalidateSettledConversations(message.mailbox_id, settled);
            }
            await assertProviderLeaseActive();
            await assertMailboxTransportFence(transportFence);
            const missingUids = missing.map((candidate) => Number(candidate.uid));
            return {
              hydrated,
              settled: settled.size,
              missingFromUid: missingUids.length > 0 ? Math.min(...missingUids) : null,
              targetError,
            };
          },
        });
      } finally {
        await mailProviderOperationMutex()
          .release(lock)
          .catch(() => false);
      }
      // Folder reconciliation retires the references of messages the provider deleted.
      if (batch.missingFromUid !== null) await enqueueFolderReconciliation(message.folder_id, batch.missingFromUid);
      if (batch.targetError) throw batch.targetError;
      // A batch that settled nothing must not requeue itself, and bodies that were already tried
      // wait for the next `mail:sync-due` tick instead of being retried back to back.
      if ("mailboxId" in ctx.input && batch.settled > 0 && (await newestPendingBody(ctx.input.mailboxId, false))) {
        ctx.resubmit({ delayMs: 0 });
      }
      return { hydrated: batch.hydrated };
    },
  });
};

const HYDRATION_MAX_ATTEMPTS = 5;
const hydrationJob = lazySync((sync) =>
  sync.job<HydrationInput>({
    id: "mail:hydrate-message",
    delivery: { ackWaitMs: 5 * 60_000, maxAttempts: HYDRATION_MAX_ATTEMPTS, backoffMs: [10_000, 20_000, 40_000, 80_000] },
  }),
);
let hydrationJobWorker: Worker | undefined;
const startHydrationJob = async (): Promise<void> => {
  hydrationJobWorker = await hydrationJob().process({}, async (ctx) => {
    try {
      await hydrateMessageBatch(ctx);
    } catch (error) {
      const code = normalizeSyncErrorCode(error);
      if (code === "MAILBOX_TRANSPORT_CHANGED") return;
      if (code === "MAIL_RATE_LIMITED") {
        ctx.resubmit({ delayMs: retryAfterMs(error, 10_000) });
        return;
      }
      if (code === "SYNC_BUSY") {
        ctx.resubmit({ delayMs: providerBusyRetryAfterMs(error) });
        return;
      }
      // A mailbox job does not wait out a retry backoff: its coalesced key would absorb the job
      // that the next sync queues for new mail. That sync or the `mail:sync-due` tick queues the
      // mailbox again.
      if ("mailboxId" in ctx.input) {
        log.warn("Mail mailbox hydration failed", { mailboxId: ctx.input.mailboxId, code });
        return;
      }
      if (ctx.attempt >= HYDRATION_MAX_ATTEMPTS) {
        log.error("Mail message hydration exhausted retries", { messageId: ctx.input.messageId, failureCount: ctx.failureCount, code });
      }
      throw error;
    }
  });
};

/** Queues one message's body on its own, for a caller that waits for exactly that message. */
export const enqueueMessageHydration = async (messageId: string): Promise<void> => {
  await submitHydrationJob({ messageId });
};

/** Hydrates every pending body of the mailbox, one batch per turn of the shared worker. */
export const enqueueMailboxHydration = async (mailboxId: string): Promise<void> => {
  await submitHydrationJob({ mailboxId });
};

/** Starts only the hydration worker and its submissions, without the Mail schedulers, for integration tests. */
export const startHydrationRuntime = async (): Promise<void> => {
  syncTasks.open();
  await startHydrationJob();
};

export const stopHydrationRuntime = async (): Promise<void> => {
  await stopRuntimeJobs(syncTasks, hydrationJobWorker ? [hydrationJobWorker] : []);
  hydrationJobWorker = undefined;
};

// One rediscovery attempt must fit the job's delivery window, which is also the
// 300-second wait documented for `cld mail rediscover`. Heartbeats keep a working
// attempt's leases alive inside that window; they must never keep a stuck
// attempt, its provider lease, and the job's worker slot alive indefinitely.
const REDISCOVERY_DEADLINE_MS = 5 * 60_000;

const rediscoveryTimeout = (deadlineMs: number): Error =>
  Object.assign(new Error(`Provider rediscovery did not finish within ${deadlineMs / 1_000} seconds and was cancelled`), {
    code: "PROVIDER_REDISCOVERY_TIMEOUT",
  });

export const executeBindingRediscovery = async (
  bindingId: string,
  allowCredentialRevision: boolean,
  jobHeartbeat: () => Promise<void>,
  deadlineMs = REDISCOVERY_DEADLINE_MS,
): Promise<BindingRediscoveryResult> => {
  const [binding] = await sql<{ remote_resource_id: string }[]>`
    SELECT remote_resource_id
    FROM mail.provider_bindings
    WHERE id = ${bindingId}::uuid
      AND (state IN ('active', 'degraded') OR (${allowCredentialRevision} AND state = 'pending'))
  `;
  if (!binding) throw Object.assign(new Error("Provider binding is unavailable for rediscovery"), { code: "BINDING_UNAVAILABLE" });
  // Rediscovery decides which folders sync at all, so it ranks with folder syncs.
  const { lock, retryAfterMs: busyRetryAfterMs } = await acquireProviderLease({
    resource: binding.remote_resource_id,
    waiter: `rediscover:${bindingId}`,
    priority: "sync",
    ttlMs: SYNC_LEASE_MS,
  });
  if (!lock) throw Object.assign(new Error("Mail remote resource is busy"), { code: "SYNC_BUSY", retryAfterMs: busyRetryAfterMs });
  try {
    return await withLeaseHeartbeat({
      intervalMs: 30_000,
      heartbeat: async () => {
        await extendSyncLease(lock, "during provider rediscovery");
        await jobHeartbeat();
      },
      deadline: { ms: deadlineMs, error: () => rediscoveryTimeout(deadlineMs) },
      work: async (_assertLeaseActive, signal) => {
        await waitForMailProviderSlot(binding.remote_resource_id, signal);
        return rediscoverProviderBinding({ bindingId, allowCredentialRevision, signal });
      },
    });
  } finally {
    await mailProviderOperationMutex()
      .release(lock)
      .catch(() => false);
  }
};

const REDISCOVERY_MAX_ATTEMPTS = 5;
const rediscoveryJob = lazySync((sync) =>
  sync.job<{ bindingId: string; allowCredentialRevision: boolean }>({
    id: "mail:rediscover-binding",
    delivery: { ackWaitMs: REDISCOVERY_DEADLINE_MS, maxAttempts: REDISCOVERY_MAX_ATTEMPTS, backoffMs: [15_000, 30_000, 60_000, 120_000] },
  }),
);
let rediscoveryJobWorker: Worker | undefined;
const startRediscoveryJob = async (): Promise<void> => {
  rediscoveryJobWorker = await rediscoveryJob().process({}, async (ctx) => {
    try {
      await executeBindingRediscovery(ctx.input.bindingId, ctx.input.allowCredentialRevision, () => ctx.heartbeat());
    } catch (error) {
      const code = normalizeSyncErrorCode(error);
      if (code === "MAILBOX_TRANSPORT_CHANGED") return;
      if (code === "MAIL_RATE_LIMITED") {
        ctx.resubmit({ delayMs: retryAfterMs(error, 15_000) });
        return;
      }
      if (code === "SYNC_BUSY") {
        ctx.resubmit({ delayMs: providerBusyRetryAfterMs(error) });
        return;
      }
      if (ctx.attempt >= REDISCOVERY_MAX_ATTEMPTS) {
        log.error("Mail provider rediscovery exhausted retries", { bindingId: ctx.input.bindingId, failureCount: ctx.failureCount, code });
      } else if (code === "PROVIDER_REDISCOVERY_TIMEOUT") {
        log.warn("Mail provider rediscovery was cancelled at its deadline and will retry", {
          bindingId: ctx.input.bindingId,
          attempt: ctx.attempt,
          maxAttempts: REDISCOVERY_MAX_ATTEMPTS,
        });
      }
      throw error;
    }
  });
};

const submitSyncFolderJob = async (folderId: string): Promise<void> => {
  await (syncTasks.run(async () => {
    await redis.send("SET", [syncRequestKey(folderId), "1", "PX", String(SYNC_REQUEST_MARKER_MS)]);
    await syncFolderJob().submit({ coalesce: true, key: `folder:${folderId}`, input: { folderId } });
  }) ?? Promise.resolve());
};

const submitHydrationJob = async (input: HydrationInput): Promise<void> => {
  await (syncTasks.run(() => hydrationJob().submit({ coalesce: true, key: hydrationJobKey(input), input })) ?? Promise.resolve());
};

const submitRediscoveryJob = async (bindingId: string, allowCredentialRevision: boolean): Promise<void> => {
  await (syncTasks.run(() =>
    rediscoveryJob().submit({ coalesce: true, key: `binding:${bindingId}`, input: { bindingId, allowCredentialRevision } }),
  ) ?? Promise.resolve());
};

let mailSchedulerWorker: Worker | undefined;

/**
 * Queues the coalesced hydration job of every mailbox with a body left to fetch, including
 * retries of bodies that were already tried. Returns how many mailboxes it queued.
 */
export const submitDueHydrationWork = async (): Promise<number> => {
  // The status condition repeats the predicate of `message_contents_hydration_queue_idx`, so each
  // mailbox costs one index probe instead of a scan of every pending body in the installation.
  const mailboxes = await sql<{ id: string }[]>`
    SELECT mailbox.id
    FROM mail.mailboxes mailbox
    WHERE mailbox.sync_enabled = true
      AND mailbox.deleted_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM mail.message_contents mc
        WHERE mc.mailbox_id = mailbox.id
          AND (mc.hydration_status IN ('envelope', 'headers', 'body') OR (mc.hydration_status = 'failed' AND mc.hydration_attempt < 5))
          AND mc.hydration_attempt < 5
          AND EXISTS (
            SELECT 1
            FROM mail.remote_message_refs remote_ref
            WHERE remote_ref.message_id = mc.id
              AND remote_ref.stale_at IS NULL
          )
      )
    ORDER BY mailbox.id
    LIMIT 500
  `;
  for (const mailbox of mailboxes) {
    await submitHydrationJob({ mailboxId: mailbox.id });
  }
  return mailboxes.length;
};

// Each minute queues at most this many folder syncs. Every Inbox goes first; the other folders
// take the remaining places in turn by folder id, so with more eligible folders every folder
// still gets a sync every few minutes.
const DUE_FOLDER_SYNCS_PER_RUN = 500;
const DUE_FOLDER_CURSOR_KEY = "mail:sync-due:folder-cursor";

/**
 * Queues every eligible Inbox, then the next eligible folders after the one the previous run
 * stopped at, wrapping around to the first folder. Returns the queued folder ids in that order.
 */
export const submitDueFolderSyncs = async (limit = DUE_FOLDER_SYNCS_PER_RUN): Promise<string[]> => {
  const after = (await redis.get(DUE_FOLDER_CURSOR_KEY)) ?? "00000000-0000-0000-0000-000000000000";
  const folders = await sql<{ id: string }[]>`
    SELECT f.id
    FROM mail.folders f
    JOIN mail.remote_resources rr ON rr.id = f.remote_resource_id
    JOIN mail.mailboxes m ON m.id = rr.mailbox_id
    WHERE f.selected_for_sync = true
      AND f.discovery_state = 'active'
      AND f.sync_status <> 'excluded'
      AND m.sync_enabled = true
      AND m.deleted_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM mail.provider_bindings pb
        JOIN mail.provider_connections pc ON pc.id = pb.connection_id
        WHERE pb.remote_resource_id = rr.id
          AND pb.state = 'active'
          AND pb.verified_scope_fingerprint = rr.scope_fingerprint
          AND pb.verified_secret_revision = pc.secret_revision
          AND pc.status = 'active'
          AND pc.encrypted_secret IS NOT NULL
      )
    ORDER BY f.role <> 'inbox', f.id <= ${after}::uuid, f.id
    LIMIT ${limit}
  `;
  const last = folders.at(-1);
  if (last) await redis.set(DUE_FOLDER_CURSOR_KEY, last.id);
  for (const folder of folders) await submitSyncFolderJob(folder.id);
  return folders.map((folder) => folder.id);
};

const submitDueWork = async (): Promise<{
  bindings: number;
  folders: number;
  hydrationMailboxes: number;
  draftExports: number;
  draftImports: number;
}> => {
  const bindings = await sql<{ id: string }[]>`
    SELECT binding.id
    FROM mail.provider_bindings binding
    JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
    JOIN mail.mailboxes mailbox ON mailbox.id = resource.mailbox_id
    JOIN mail.provider_connections connection ON connection.id = binding.connection_id
    WHERE binding.state IN ('active', 'degraded')
      AND connection.status IN ('active', 'degraded')
      AND connection.encrypted_secret IS NOT NULL
      AND mailbox.sync_enabled = true
      AND mailbox.deleted_at IS NULL
      AND (
        binding.last_verified_at IS NULL
        OR binding.last_verified_at < now() - interval '15 minutes'
      )
      AND (
        binding.last_error_code IS NULL
        OR binding.updated_at < now() - interval '15 minutes'
      )
    ORDER BY binding.last_verified_at NULLS FIRST, binding.id
    LIMIT 100
  `;
  for (const binding of bindings) {
    await submitRediscoveryJob(binding.id, false);
  }

  const folders = await submitDueFolderSyncs();
  const hydrationMailboxes = await submitDueHydrationWork();
  const draftProjection = await submitDueDraftProjectionWork();
  return {
    bindings: bindings.length,
    folders: folders.length,
    hydrationMailboxes,
    draftExports: draftProjection.exports,
    draftImports: draftProjection.imports,
  };
};

export const enqueueMailboxSync = async (mailboxId: string): Promise<number> => {
  const folders = await sql<{ id: string }[]>`
    SELECT f.id
    FROM mail.folders f
    JOIN mail.remote_resources rr ON rr.id = f.remote_resource_id
    JOIN mail.mailboxes m ON m.id = rr.mailbox_id
    WHERE rr.mailbox_id = ${mailboxId}::uuid
      AND f.selected_for_sync = true
      AND f.discovery_state = 'active'
      AND f.sync_status <> 'excluded'
      AND m.sync_enabled = true
      AND m.deleted_at IS NULL
    ORDER BY CASE f.role WHEN 'inbox' THEN 0 ELSE 1 END, f.id
  `;
  for (const folder of folders) {
    await submitSyncFolderJob(folder.id);
  }
  return folders.length;
};

export const enqueueFolderSync = async (folderId: string): Promise<void> => {
  await submitSyncFolderJob(folderId);
};

export const enqueueFolderReconciliation = async (folderId: string, fromUid: number): Promise<void> => {
  const windowStart = reconcileWindowStart(fromUid);
  // Only a cursor rewind: a running sync batch may hold the provider mutex, and
  // the request must survive that contention.
  await sql`
    UPDATE mail.folders
    SET
      envelope_cursor = jsonb_set(
        envelope_cursor,
        '{reconcileNextLow}',
        to_jsonb(
          LEAST(
            COALESCE((envelope_cursor ->> 'reconcileNextLow')::numeric, ${windowStart}::numeric),
            ${windowStart}::numeric
          )
        ),
        true
      )
    WHERE id = ${folderId}::uuid
      AND selected_for_sync = true
      AND discovery_state = 'active'
      AND sync_status <> 'excluded'
      AND envelope_cursor ->> 'version' = '1'
  `;
  await submitSyncFolderJob(folderId);
};

export const enqueueBindingRediscovery = async (bindingId: string, allowCredentialRevision = false): Promise<void> => {
  await submitRediscoveryJob(bindingId, allowCredentialRevision);
};

const mailRuntimeLifecycle = createRuntimeLifecycle({
  start: async () => {
    syncTasks.open();
    await startSyncFolderJob();
    await startHydrationJob();
    await startRediscoveryJob();
    await startDraftProjectionRuntime();

    await mailScheduler().create({
      id: "mail:sync-due",
      cron: "* * * * *",
      misfire: "latest",
      meta: { appId: "mail", family: "mail:sync", label: "Mail synchronization" },
      process: async () => {
        await submitDueWork();
      },
    });
    await mailScheduler().create({
      id: "mail:snooze-wake",
      cron: "* * * * *",
      misfire: "latest",
      meta: { appId: "mail", family: "mail:collaboration", label: "Mail snooze wake-up" },
      process: async () => {
        await releaseDueSnoozes();
      },
    });
    await mailScheduler().create({
      id: "mail:blob-upload-cleanup",
      cron: "17 * * * *",
      meta: { appId: "mail", family: "mail:storage", label: "Mail blob upload cleanup" },
      process: async () => {
        await deleteAbandonedDraftAttachmentUploads();
        await deleteAbandonedBlobUploads();
        await deleteOrphanedBlobs();
      },
    });
    await mailScheduler().create({
      id: "mail:attachment-link-cleanup",
      cron: "29 * * * *",
      meta: { appId: "mail", family: "mail:storage", label: "Mail attachment link cleanup" },
      process: async () => {
        await cleanupPublicAttachmentLinks();
      },
    });
    await mailScheduler().create({
      id: "mail:runtime-history-cleanup",
      cron: "43 * * * *",
      meta: { appId: "mail", family: "mail:runtime", label: "Mail runtime history cleanup" },
      process: async () => {
        await cleanupMailRuntimeHistory();
      },
    });
    await mailScheduler().create({
      id: "mail:storage-usage",
      cron: "23 * * * *",
      meta: { appId: "mail", family: "mail:storage", label: "Mail storage usage reconciliation" },
      process: async () => {
        await reconcileMailStorageUsage();
      },
    });
    mailSchedulerWorker = await mailScheduler().process();
    await submitDueWork();
  },
  stop: async () => {
    for (const worker of [rediscoveryJobWorker, syncFolderJobWorker, hydrationJobWorker]) worker?.stop();
    syncTasks.close();
    await stopRuntimeResources([
      () =>
        mailSchedulerWorker?.drain().then(() => {
          mailSchedulerWorker = undefined;
        }),
      () => stopDraftProjectionRuntime(),
      () =>
        stopRuntimeJobs(
          syncTasks,
          [rediscoveryJobWorker, syncFolderJobWorker, hydrationJobWorker].filter((worker): worker is Worker => worker !== undefined),
        ),
    ]);
  },
});

export const mailRuntime = {
  start: mailRuntimeLifecycle.start,
  stop: mailRuntimeLifecycle.stop,
};
