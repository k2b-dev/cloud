import { randomUUID } from "node:crypto";
import type { JobContext, Worker } from "@k2b/sync";
import { lazySync } from "@valentinkolb/cloud";
import {
  createRuntimeLifecycle,
  createRuntimeTaskTracker,
  logger,
  stopRuntimeJobs,
  stopRuntimeResources,
  syncOps,
} from "@valentinkolb/cloud/services";
import { toPgTextArray, toPgUuidArray } from "@valentinkolb/cloud/services/postgres";
import type { WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import { evaluateWorkflowTriggerInputs } from "@valentinkolb/cloud/workflows/runtime";
import { emitWorkflowEvent } from "@valentinkolb/cloud/workflows/store";
import { sql } from "bun";
import { withShortIdDb } from "../lib/short-id";
import { MAIL_WORKFLOW_APP_ID, MAIL_WORKFLOW_EVENT } from "../workflows/events";
import { normalizeEmailAddress } from "./address-normalization";
import { cleanupPublicAttachmentLinks } from "./attachment-links";
import { type BindingRediscoveryResult, rediscoverProviderBinding } from "./bindings";
import { sha256Json } from "./canonical";
import { releaseDueSnoozes } from "./collaboration";
import type { ConnectorEnvelope, FlagChange } from "./connectors";
import { imapSmtpConnector } from "./connectors";
import { isAutomaticSubmission } from "./conversation-work-state";
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
import { hydrateMessageFromSource } from "./message-hydration";
import { parseMessageProtocolFacts } from "./message-protocol";
import { normalizeMailSubject } from "./message-threading";
import { loadProviderConnectionRuntimeSnapshot } from "./provider-connections";
import { isConcurrentCredentialRefresh, isProviderAuthenticationFailure, providerErrorCode, providerErrorMessage } from "./provider-errors";
import { cleanupProviderOAuthFlows } from "./provider-oauth-cleanup";
import { mailProviderOperationMutex, withProviderOperationBarrier } from "./provider-operation-lock";
import { waitForMailProviderSlot } from "./provider-pacer";
import { cleanupMailRuntimeHistory } from "./runtime-history-retention";
import { reconcileMailStorageUsage } from "./storage-observability";
import { getWorkflowSnapshot, mailWorkflowEventContext } from "./workflow-data";

const unregisterSyncOps: Array<() => void> = [];

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
  imported: number;
  flagsUpdated: number;
  removed: number;
};

type SyncLock = NonNullable<Awaited<ReturnType<ReturnType<typeof mailProviderOperationMutex>["acquire"]>>>;

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
});

export const claimFence = async (resourceId: string, bindingId: string, kind: string): Promise<FenceClaim> =>
  sql.begin(async (tx) => {
    const [resource] = await tx<{ token: string | number; generation: string | number }[]>`
      UPDATE mail.remote_resources resource
      SET current_fence_token = resource.current_fence_token + 1
      FROM mail.mailboxes mailbox
      WHERE resource.id = ${resourceId}::uuid
        AND mailbox.id = resource.mailbox_id
        AND resource.status = 'active'
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
      normalized_email: normalizeEmailAddress(address.address) ?? address.address.trim().toLowerCase(),
    })),
  );
  if (rows.length > 0) {
    await db`
      INSERT INTO mail.message_addresses ${sql(rows, "message_id", "role", "position", "display_name", "email", "normalized_email")}
    `;
  }
};

const findConversation = async (params: {
  db: typeof sql;
  mailboxId: string;
  messageId: string;
  message: ConnectorEnvelope;
  normalizedSubject: string;
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

  const replyIds = [
    ...new Set([params.message.inReplyTo, ...params.message.references].filter((value): value is string => Boolean(value))),
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

  if (!params.normalizedSubject || participants.length === 0) return null;
  const [fallback] = await params.db<{ conversation_id: string }[]>`
    SELECT cm.conversation_id
    FROM mail.message_contents mc
    JOIN mail.conversation_messages cm ON cm.message_id = mc.id
    WHERE mc.mailbox_id = ${params.mailboxId}::uuid
      AND mc.id <> ${params.messageId}::uuid
      AND mc.normalized_subject = ${params.normalizedSubject}
      AND mc.internal_date BETWEEN ${params.message.internalDate}::timestamptz - interval '30 days'
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
  if (!params.message.providerMessageId) return null;
  const candidates = await params.db<{ message_id: string }[]>`
    SELECT DISTINCT remote_ref.message_id
    FROM mail.remote_message_refs remote_ref
    JOIN mail.folders folder ON folder.id = remote_ref.folder_id
    WHERE folder.remote_resource_id = ${params.remoteResourceId}::uuid
      AND remote_ref.connector_ref ->> 'providerMessageId' = ${params.message.providerMessageId}
    ORDER BY remote_ref.message_id
    LIMIT 2
  `;
  return candidates.length === 1 ? candidates[0]!.message_id : null;
};

export const ingestEnvelope = async (params: {
  db: typeof sql;
  mailboxId: string;
  remoteResourceId: string;
  folderId: string;
  message: ConnectorEnvelope;
  captureWorkflowTriggers?: boolean;
}): Promise<string> => {
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
    }));
  const outbound = await params.db<{ outbound: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM mail.sender_identities si
      WHERE si.mailbox_id = ${params.mailboxId}::uuid
        AND lower(si.from_address) = ANY(${toPgTextArray(params.message.addresses.from.map((item) => item.address))}::text[])
    ) AS outbound
  `;
  const participantLabels = counterpartyLabels(params.message, Boolean(outbound[0]?.outbound));
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
        ${outbound[0]?.outbound ? null : params.message.internalDate},
        ${outbound[0]?.outbound ? params.message.internalDate : null},
        ${params.message.internalDate},
        ${
          outbound[0]?.outbound &&
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
  const [linked] = await params.db<{ message_id: string }[]>`
    INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
    VALUES (
      ${conversationId}::uuid,
      ${messageContentId}::uuid,
      ${params.message.internalDate.getTime()},
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
  if (params.captureWorkflowTriggers && !outbound[0]?.outbound) {
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
  let updated = 0;
  for (const change of params.changes) {
    const result = await params.db`
      UPDATE mail.message_placements mp
      SET flags = ${toPgTextArray(change.flags)}::text[], keywords = ${toPgTextArray(change.labels)}::text[], updated_at = now()
      FROM mail.remote_message_refs rmr
      WHERE mp.remote_message_ref_id = rmr.id
        AND rmr.folder_id = ${params.folderId}::uuid
        AND rmr.uid_validity = ${params.uidValidity}::numeric
        AND rmr.uid = ${change.uid}::numeric
    `;
    updated += result.count;
    await params.db`
      UPDATE mail.remote_message_refs
      SET modseq = ${change.modseq}::numeric, last_seen_at = now()
      WHERE folder_id = ${params.folderId}::uuid
        AND uid_validity = ${params.uidValidity}::numeric
        AND uid = ${change.uid}::numeric
    `;
  }
  return updated;
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
  oauthTokenRevision: number | null;
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
              AND (
                ${params.oauthTokenRevision}::bigint IS NULL
                OR pc.oauth_token_revision = ${params.oauthTokenRevision}::bigint
              )
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
                AND (
                  ${params.oauthTokenRevision}::bigint IS NULL
                  OR pc.oauth_token_revision = ${params.oauthTokenRevision}::bigint
                )
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
            OR (
              ${params.oauthTokenRevision}::bigint IS NOT NULL
              AND pc.oauth_token_revision <> ${params.oauthTokenRevision}::bigint
            )
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
      await tx`
      UPDATE mail.mailboxes
      SET
        health = ${authFailure ? "auth_required" : code === "NO_SYNC_BINDING" ? "connection_required" : "degraded"},
        health_reason = ${message}
      WHERE id = ${folder.mailbox_id}::uuid
    `;
    })
    .catch(() => undefined);
};

type SyncRuntime = Awaited<ReturnType<typeof loadResolvedRuntime>>;
type FolderStatus = Awaited<ReturnType<typeof imapSmtpConnector.getFolderStatus>>;
type EnvelopeBatch = Awaited<ReturnType<typeof imapSmtpConnector.fetchEnvelopeBatch>>;
type ReconcileWindow = { low: number; high: number; uids: number[] };

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

const fetchReconcileStep = async (params: {
  cursor: EnvelopeCursor;
  currentHighUid: number;
  runtime: SyncRuntime;
  folderPath: string;
  uidValidity: string;
  signal: AbortSignal;
}): Promise<ReconcileWindow | null> => {
  const due =
    params.cursor.backfillComplete &&
    (!params.cursor.lastFullReconcileAt || Date.now() - new Date(params.cursor.lastFullReconcileAt).getTime() >= 6 * 60 * 60_000);
  if (!due && params.cursor.reconcileNextLow == null) return null;

  const low = params.cursor.reconcileNextLow ?? 1;
  if (low > params.currentHighUid) {
    params.cursor.reconcileNextLow = null;
    params.cursor.lastFullReconcileAt = new Date().toISOString();
    return null;
  }
  const high = Math.min(params.currentHighUid, low + RECONCILE_WINDOW_SIZE - 1);
  const uids = await imapSmtpConnector.fetchUidWindow(params.runtime, params.folderPath, params.uidValidity, low, high, params.signal);
  params.cursor.reconcileNextLow = high < params.currentHighUid ? high + 1 : null;
  if (params.cursor.reconcileNextLow == null) params.cursor.lastFullReconcileAt = new Date().toISOString();
  return { low, high, uids };
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
    const [lockedFolder] = await tx<{ id: string }[]>`
      SELECT id FROM mail.folders WHERE id = ${params.folderId}::uuid FOR UPDATE
    `;
    if (!lockedFolder) throw new Error("Folder disappeared during sync");
    const [effectiveRole] = await tx<{ is_drafts: boolean }[]>`
      SELECT (
        EXISTS (
          SELECT 1
          FROM mail.folder_role_overrides override
          WHERE override.mailbox_id = ${params.folder.mailbox_id}::uuid
            AND override.role = 'drafts'
            AND override.folder_id = ${params.folderId}::uuid
        )
        OR (
          ${params.folder.role} = 'drafts'
          AND NOT EXISTS (
            SELECT 1
            FROM mail.folder_role_overrides override
            WHERE override.mailbox_id = ${params.folder.mailbox_id}::uuid
              AND override.role = 'drafts'
          )
        )
      ) AS is_drafts
    `;
    const isDraftFolder = effectiveRole?.is_drafts === true;
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
        envelopes: params.envelopeBatch?.messages ?? [],
        reconcileWindow: params.reconcileWindow,
      });
      draftImportSnapshotIds = projection.importSnapshotIds;
      draftExportSnapshotIds = projection.exportSnapshotIds;
      draftRemoved = projection.removed;
    } else {
      for (const message of params.envelopeBatch?.messages ?? []) {
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
    }
    const flagsUpdated = isDraftFolder
      ? 0
      : await applyFlagChanges({
          db: tx,
          folderId: params.folderId,
          uidValidity: params.status.uidValidity,
          changes: params.flagChanges,
        });
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
  if (result.liveInvalidated) await notifyMailInvalidations();
  return result;
};

const syncFolderBatch = async (folderId: string, jobHeartbeat: () => Promise<void>): Promise<SyncBatchResult> => {
  const folder = await loadSyncFolder(folderId);
  if (!folder) return { hasMore: false, imported: 0, flagsUpdated: 0, removed: 0 };

  const lock = await mailProviderOperationMutex().acquire({ resource: folder.remote_resource_id, ttlMs: SYNC_LEASE_MS });
  if (!lock) throw Object.assign(new Error("Mail sync resource is busy"), { code: "SYNC_BUSY" });
  let runId: string | null = null;
  let selectedBindingId: string | null = null;
  let selectedSecretRevision: number | null = null;
  let selectedOAuthTokenRevision: number | null = null;
  let activeFence: FenceClaim | null = null;
  try {
    return await withLeaseHeartbeat({
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
        if (!refreshedFolder) return { hasMore: false, imported: 0, flagsUpdated: 0, removed: 0 };
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
        selectedOAuthTokenRevision = runtimeSnapshot.oauthTokenRevision;
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
          runtime,
          folderPath: folderExecution.path,
          uidValidity: status.uidValidity,
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

        for (const messageId of result.hydratedIds) {
          await submitHydrationJob(messageId);
        }
        await enqueueDraftImports(result.draftImportSnapshotIds);
        await Promise.all(result.draftExportSnapshotIds.map((snapshotId) => enqueueDraftProjectionSnapshot(snapshotId)));
        const hasMore =
          cursor.incrementalNextHigh != null || !cursor.backfillComplete || cursor.flagNextLow != null || cursor.reconcileNextLow != null;
        return { hasMore, imported: result.hydratedIds.length, flagsUpdated: result.flagsUpdated, removed: result.removed };
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
      code !== "MAILBOX_TRANSPORT_CHANGED" &&
      !isConcurrentCredentialRefresh(error)
    ) {
      await recordSyncFailure({
        folderId,
        bindingId: selectedBindingId,
        secretRevision: selectedSecretRevision,
        oauthTokenRevision: selectedOAuthTokenRevision,
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
};

const normalizeSyncErrorCode = (error: unknown): string => {
  return providerErrorCode(error, "MAIL_SYNC_FAILED");
};

const syncFolderJob = lazySync((sync) =>
  sync.job<{ folderId: string }>({
    id: "mail:sync-folder",
    delivery: { ackWaitMs: 3 * 60_000, maxAttempts: 5, backoffMs: [5_000, 10_000, 20_000, 40_000] },
  }),
);
let syncFolderJobWorker: Worker | undefined;
const startSyncFolderJob = async (): Promise<void> => {
  unregisterSyncOps.push(syncOps.registerDeadLetters({ name: "mail:sync-folder", kind: "job", store: syncFolderJob().deadLetters }));
  syncFolderJobWorker = await syncFolderJob().process(
    {
      onError: async ({ context, error }) => {
        if (context.attempt >= 5) {
          await sql`UPDATE mail.folders SET sync_status = 'degraded' WHERE id = ${context.input.folderId}::uuid`;
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
    async (ctx) => {
      try {
        const data = await syncTasks.run(() => syncFolderBatch(ctx.input.folderId, () => ctx.heartbeat()));
        if (data?.hasMore) ctx.resubmit({ delayMs: 0 });
      } catch (error) {
        if (normalizeSyncErrorCode(error) === "MAILBOX_TRANSPORT_CHANGED") return;
        if (isConcurrentCredentialRefresh(error)) {
          ctx.resubmit({ delayMs: 2_000 });
          return;
        }
        if (normalizeSyncErrorCode(error) === "MAIL_RATE_LIMITED") {
          ctx.resubmit({ delayMs: retryAfterMs(error, 5_000) });
          return;
        }
        throw error;
      }
    },
  );
};

export const hydrateMessageBatch = async (ctx: JobContext<{ messageId: string }>): Promise<{ hydrated: boolean }> => {
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
      const [message] = await sql<
        {
          mailbox_id: string;
          folder_id: string;
          remote_resource_id: string;
        }[]
      >`
        SELECT mc.mailbox_id, rmr.folder_id, f.remote_resource_id
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
        WHERE mc.id = ${ctx.input.messageId}::uuid
          AND mc.hydration_status <> 'complete'
          AND mc.hydration_attempt < 5
        ORDER BY f.role = 'inbox' DESC, rmr.last_seen_at DESC
        LIMIT 1
      `;
      if (!message) return { hydrated: false };
      const lock = await mailProviderOperationMutex().acquire({ resource: message.remote_resource_id, ttlMs: SYNC_LEASE_MS });
      if (!lock) throw Object.assign(new Error("Mail remote resource is busy"), { code: "SYNC_BUSY" });
      try {
        return await withLeaseHeartbeat({
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
        ORDER BY (mc.id = ${ctx.input.messageId}::uuid) DESC, mc.internal_date DESC, mc.id DESC
        LIMIT ${HYDRATION_BATCH_SIZE}
      `;
            if (candidates.length === 0) return { hydrated: false };

            let hydrated = false;
            let requestedMessageError: unknown = null;
            await assertProviderLeaseActive();
            await assertMailboxTransportFence(transportFence);
            await imapSmtpConnector.downloadSourceBatch(
              runtime,
              folder.path,
              candidates.map((candidate) => ({
                key: candidate.id,
                uidValidity: String(candidate.uid_validity),
                uid: Number(candidate.uid),
              })),
              async (source) => {
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
                    log.warn("Mail message hydration failed within a source batch", { messageId: source.key, code });
                    if (source.key === ctx.input.messageId) requestedMessageError = error;
                  }
                } finally {
                  activeClaim = null;
                }
              },
              signal,
            );
            await assertProviderLeaseActive();
            await assertMailboxTransportFence(transportFence);
            if (requestedMessageError) throw requestedMessageError;
            return { hydrated };
          },
        });
      } finally {
        await mailProviderOperationMutex()
          .release(lock)
          .catch(() => false);
      }
    },
  });
};

const hydrationJob = lazySync((sync) =>
  sync.job<{ messageId: string }>({
    id: "mail:hydrate-message",
    delivery: { ackWaitMs: 5 * 60_000, maxAttempts: 5, backoffMs: [10_000, 20_000, 40_000, 80_000] },
  }),
);
let hydrationJobWorker: Worker | undefined;
const startHydrationJob = async (): Promise<void> => {
  unregisterSyncOps.push(syncOps.registerDeadLetters({ name: "mail:hydrate-message", kind: "job", store: hydrationJob().deadLetters }));
  hydrationJobWorker = await hydrationJob().process({}, async (ctx) => {
    try {
      await (syncTasks.run(async () => {
        try {
          return await hydrateMessageBatch(ctx);
        } catch (error) {
          if (normalizeSyncErrorCode(error) !== "MAIL_RATE_LIMITED" && ctx.attempt >= 5) {
            log.error("Mail message hydration exhausted retries", {
              messageId: ctx.input.messageId,
              failureCount: ctx.failureCount,
              code: normalizeSyncErrorCode(error),
            });
          }
          throw error;
        }
      }) ?? Promise.resolve(null));
    } catch (error) {
      if (normalizeSyncErrorCode(error) === "MAILBOX_TRANSPORT_CHANGED") return;
      if (normalizeSyncErrorCode(error) === "MAIL_RATE_LIMITED") {
        ctx.resubmit({ delayMs: retryAfterMs(error, 10_000) });
        return;
      }
      throw error;
    }
  });
};

export const enqueueMessageHydration = async (messageId: string): Promise<void> => {
  await submitHydrationJob(messageId);
};

export const executeBindingRediscovery = async (
  bindingId: string,
  allowCredentialRevision: boolean,
  jobHeartbeat: () => Promise<void>,
): Promise<BindingRediscoveryResult> => {
  const [binding] = await sql<{ remote_resource_id: string }[]>`
    SELECT remote_resource_id
    FROM mail.provider_bindings
    WHERE id = ${bindingId}::uuid
      AND (state IN ('active', 'degraded') OR (${allowCredentialRevision} AND state = 'pending'))
  `;
  if (!binding) throw Object.assign(new Error("Provider binding is unavailable for rediscovery"), { code: "BINDING_UNAVAILABLE" });
  const lock = await mailProviderOperationMutex().acquire({ resource: binding.remote_resource_id, ttlMs: SYNC_LEASE_MS });
  if (!lock) throw Object.assign(new Error("Mail remote resource is busy"), { code: "SYNC_BUSY" });
  try {
    return await withLeaseHeartbeat({
      intervalMs: 30_000,
      heartbeat: async () => {
        await extendSyncLease(lock, "during provider rediscovery");
        await jobHeartbeat();
      },
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

const rediscoveryJob = lazySync((sync) =>
  sync.job<{ bindingId: string; allowCredentialRevision: boolean }>({
    id: "mail:rediscover-binding",
    delivery: { ackWaitMs: 5 * 60_000, maxAttempts: 5, backoffMs: [15_000, 30_000, 60_000, 120_000] },
  }),
);
let rediscoveryJobWorker: Worker | undefined;
const startRediscoveryJob = async (): Promise<void> => {
  unregisterSyncOps.push(
    syncOps.registerDeadLetters({ name: "mail:rediscover-binding", kind: "job", store: rediscoveryJob().deadLetters }),
  );
  rediscoveryJobWorker = await rediscoveryJob().process({}, async (ctx) => {
    try {
      await (syncTasks.run(async () => {
        try {
          return await executeBindingRediscovery(ctx.input.bindingId, ctx.input.allowCredentialRevision, () => ctx.heartbeat());
        } catch (error) {
          if (normalizeSyncErrorCode(error) !== "MAIL_RATE_LIMITED" && ctx.attempt >= 5) {
            log.error("Mail provider rediscovery exhausted retries", {
              bindingId: ctx.input.bindingId,
              failureCount: ctx.failureCount,
              code: normalizeSyncErrorCode(error),
            });
          }
          throw error;
        }
      }) ?? Promise.resolve(null));
    } catch (error) {
      if (normalizeSyncErrorCode(error) === "MAILBOX_TRANSPORT_CHANGED") return;
      if (normalizeSyncErrorCode(error) === "MAIL_RATE_LIMITED") {
        ctx.resubmit({ delayMs: retryAfterMs(error, 15_000) });
        return;
      }
      throw error;
    }
  });
};

const submitSyncFolderJob = async (folderId: string): Promise<void> => {
  await (syncTasks.run(() => syncFolderJob().submit({ coalesce: true, key: `folder:${folderId}`, input: { folderId } })) ??
    Promise.resolve());
};

const submitHydrationJob = async (messageId: string): Promise<void> => {
  await (syncTasks.run(() => hydrationJob().submit({ coalesce: true, key: `message:${messageId}`, input: { messageId } })) ??
    Promise.resolve());
};

const submitRediscoveryJob = async (bindingId: string, allowCredentialRevision: boolean): Promise<void> => {
  await (syncTasks.run(() =>
    rediscoveryJob().submit({ coalesce: true, key: `binding:${bindingId}`, input: { bindingId, allowCredentialRevision } }),
  ) ?? Promise.resolve());
};

let mailSchedulerWorker: Worker | undefined;

const submitDueWork = async (): Promise<{
  bindings: number;
  folders: number;
  messages: number;
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
    ORDER BY
      CASE f.role WHEN 'inbox' THEN 0 ELSE 1 END,
      COALESCE(f.last_reconciled_at, '-infinity'::timestamptz),
      f.id
    LIMIT 500
  `;
  for (const folder of folders) {
    await submitSyncFolderJob(folder.id);
  }

  const messages = await sql<{ id: string }[]>`
    SELECT mc.id
      FROM mail.message_contents mc
      JOIN mail.mailboxes m ON m.id = mc.mailbox_id
      WHERE mc.hydration_status IN ('envelope', 'headers', 'body', 'failed')
        AND mc.hydration_attempt < 5
        AND m.sync_enabled = true
        AND m.deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM mail.remote_message_refs remote_ref
          WHERE remote_ref.message_id = mc.id
            AND remote_ref.stale_at IS NULL
        )
    ORDER BY mc.internal_date DESC, mc.id DESC
    LIMIT 500
  `;
  for (const message of messages) {
    await submitHydrationJob(message.id);
  }
  const draftProjection = await submitDueDraftProjectionWork();
  return {
    bindings: bindings.length,
    folders: folders.length,
    messages: messages.length,
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
  const boundedUid = Math.max(1, Number.isSafeInteger(fromUid) ? fromUid : 1);
  const reconcileWindowStart = Math.floor((boundedUid - 1) / RECONCILE_WINDOW_SIZE) * RECONCILE_WINDOW_SIZE + 1;
  const [folder] = await sql<{ remote_resource_id: string }[]>`
    SELECT remote_resource_id
    FROM mail.folders
    WHERE id = ${folderId}::uuid
      AND selected_for_sync = true
      AND discovery_state = 'active'
      AND sync_status <> 'excluded'
  `;
  if (!folder) return;
  const barrier = await withProviderOperationBarrier([folder.remote_resource_id], async (assertLeaseActive) => {
    await assertLeaseActive();
    await sql`
      UPDATE mail.folders
      SET
        envelope_cursor = jsonb_set(
          envelope_cursor,
          '{reconcileNextLow}',
          to_jsonb(
            LEAST(
              COALESCE((envelope_cursor ->> 'reconcileNextLow')::int, ${reconcileWindowStart}),
              ${reconcileWindowStart}
            )
          ),
          true
        ),
        last_reconciled_at = NULL
      WHERE id = ${folderId}::uuid
        AND envelope_cursor ->> 'version' = '1'
    `;
    await assertLeaseActive();
  });
  if (!barrier.acquired) {
    throw Object.assign(new Error("Mail sync resource is busy while requesting reconciliation"), {
      code: "SYNC_BUSY",
    });
  }
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
    unregisterSyncOps.push(syncOps.registerScheduler({ name: "mail", scheduler: mailScheduler() }));
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
      id: "mail:oauth-flow-cleanup",
      cron: "37 * * * *",
      meta: { appId: "mail", family: "mail:oauth", label: "Mail OAuth flow cleanup" },
      process: async () => {
        await cleanupProviderOAuthFlows();
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
    ]).finally(() => {
      for (const unregister of unregisterSyncOps.splice(0)) unregister();
    });
  },
});

export const mailRuntime = {
  start: mailRuntimeLifecycle.start,
  stop: mailRuntimeLifecycle.stop,
};
