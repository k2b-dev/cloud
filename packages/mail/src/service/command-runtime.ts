import type { Worker } from "@k2b/sync";
import { expBackoff } from "@k2b/sync/retry";
import { lazySync } from "@valentinkolb/cloud";
import {
  createRuntimeLifecycle,
  createRuntimeTaskTracker,
  logger,
  stopRuntimeJobs,
  stopRuntimeResources,
} from "@valentinkolb/cloud/services";
import { toPgTextArray } from "@valentinkolb/cloud/services/postgres";
import { sql } from "bun";
import { z } from "zod";
import type { CommandState, MailCommand, RemoteMessagePrecondition } from "../contracts";
import { remoteMessagePreconditionSchema } from "../contracts";
import { rediscoverProviderBinding } from "./bindings";
import { commandStillAuthorized } from "./command-authorization";
import { imapSmtpConnector, type RemoteMessageState, type RemoteMutationTarget } from "./connectors";
import type { SmtpConnectionConfig } from "./connectors/contract";
import { deriveConversationWorkState } from "./conversation-work-state";
import { notifyMailInvalidations, publishMailCollaborationEvent, publishMailMailboxEvent } from "./events";
import { withLeaseHeartbeat } from "./lease-heartbeat";
import {
  enqueueMaintenanceCommand,
  startMaintenanceRuntime,
  stopMaintenanceRuntime,
  submitDueMaintenanceCommands,
} from "./maintenance-runtime";
import { createBlobReadable, getStoredBlob, storeReadableBlob } from "./message-blobs";
import { isOperatorMaintenanceKind } from "./operator-actions";
import { OUTBOX_MAX_ATTEMPTS } from "./outbound-delivery";
import { loadOutboundProjectionByOutbox } from "./outbound-message-projection";
import { buildMimeStream, outboundDraftSnapshotSchema, outboundRecipients } from "./outbound-mime";
import { type loadProviderConnectionRuntime, loadProviderConnectionRuntimeSnapshot } from "./provider-connections";
import { activeSmtpMessageLimit, assertProviderMessageSize, loadBindingProviderLimits } from "./provider-limits";
import { MAIL_PROVIDER_OPERATION_LEASE_MS, mailProviderOperationMutex, providerBusyRetryDelayMs } from "./provider-operation-lock";
import { waitForMailProviderSlot } from "./provider-pacer";
import { loadSenderIdentityTransportRuntimeById } from "./sender-identity-transports";
import { publishMailWorkflowDependency } from "./workflow-dependencies";

const log = logger("mail:commands");
const STALE_EXECUTION_MINUTES = 10;
const MUTATION_JOB_LEASE_MS = 3 * 60_000;
const OUTBOX_JOB_LEASE_MS = 4 * 60_000;
/**
 * Longest broker-side delay an outbox job is scheduled with. Sends due later
 * are left to the `commands-due` cron, which submits them once
 * `scheduled_at <= now()`, so a far-future send never keeps polling.
 */
const OUTBOX_SCHEDULE_WINDOW_MS = 6 * 24 * 60 * 60_000;
const JOB_HEARTBEAT_INTERVAL_MS = 30_000;
const commandTasks = createRuntimeTaskTracker();

type JsonRecord = Record<string, unknown>;
type SqlClient = typeof sql;

type DbCommandExecution = {
  id: string;
  mailbox_id: string;
  kind: MailCommand["kind"];
  state: MailCommand["state"];
  actor_kind: "user" | "service_account" | "workflow" | "system";
  actor_id: string | null;
  correlation_id: string | null;
  workflow_execution_generation: string | number | null;
  initiator_actor_kind: "user" | "service_account" | null;
  initiator_actor_id: string | null;
  access_subject_kind: "user" | "service_account" | "system";
  access_subject_id: string | null;
  credential_scopes: string[] | null;
  credential_id: string | null;
  credential_expires_at: Date | string | null;
  target: JsonRecord | string;
  payload: JsonRecord | string;
  transport_metadata: JsonRecord | string;
  selected_binding_id: string;
  selected_secret_revision: number;
  attempt: number;
};

type DbPinnedBinding = {
  remote_resource_id: string;
  connection_id: string;
  capabilities: JsonRecord | string;
  verified_secret_revision: number;
};

type DbRemoteMessage = {
  remote_message_ref_id: string;
  message_content_id: string;
  message_id: string | null;
  folder_id: string;
  folder_path: string;
  uid_validity: string | number;
  uid: string | number;
  effective_rights: string[];
};

type DbDestinationFolder = {
  folder_id: string;
  folder_path: string;
  uid_validity: string | number | null;
  effective_rights: string[];
};

const parseJsonRecord = (value: JsonRecord | string): JsonRecord => (typeof value === "string" ? (JSON.parse(value) as JsonRecord) : value);

const localStateProjectionSchema = z
  .object({
    remoteMessageRefId: z.string().uuid(),
    previousFlags: z.array(z.string().min(1).max(100)).max(100),
    previousKeywords: z.array(z.string().min(1).max(100)).max(100),
    projectedFlags: z.array(z.string().min(1).max(100)).max(100),
    projectedKeywords: z.array(z.string().min(1).max(100)).max(100),
  })
  .strict();

const normalizeCode = (error: unknown, fallback: string): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? code : fallback;
};

const errorMessage = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : fallback;
  return message.slice(0, 1_000);
};

const loadPinnedBinding = async (command: DbCommandExecution): Promise<DbPinnedBinding> => {
  const [binding] = await sql<DbPinnedBinding[]>`
    SELECT
      pb.remote_resource_id,
      pb.connection_id,
      pb.capabilities,
      pb.verified_secret_revision
    FROM mail.provider_bindings pb
    JOIN mail.remote_resources rr ON rr.id = pb.remote_resource_id
    JOIN mail.mailboxes m ON m.id = rr.mailbox_id
    JOIN mail.provider_connections pc ON pc.id = pb.connection_id
    WHERE pb.id = ${command.selected_binding_id}::uuid
      AND rr.mailbox_id = ${command.mailbox_id}::uuid
      AND rr.status IN ('active', 'degraded')
      AND pb.state IN ('active', 'degraded')
      AND pb.verified_scope_fingerprint = rr.scope_fingerprint
      AND pb.verified_secret_revision = ${command.selected_secret_revision}
      AND pc.secret_revision = ${command.selected_secret_revision}
      AND pc.status IN ('active', 'degraded')
      AND pc.encrypted_secret IS NOT NULL
      AND pc.owner_mailbox_id = ${command.mailbox_id}::uuid
      AND m.sync_enabled = true
      AND m.health NOT IN ('auth_required', 'connection_required', 'paused')
      AND m.deleted_at IS NULL
  `;
  if (!binding) throw Object.assign(new Error("Pinned provider binding is no longer active"), { code: "BINDING_UNAVAILABLE" });
  return binding;
};

const loadPinnedRuntime = async (binding: DbPinnedBinding) => {
  const snapshot = await loadProviderConnectionRuntimeSnapshot(binding.connection_id);
  if (snapshot.secretRevision !== binding.verified_secret_revision) {
    throw Object.assign(new Error("Pinned provider credentials changed before execution"), {
      code: "CREDENTIAL_REVISION_CHANGED",
    });
  }
  return snapshot.runtime;
};

const sourceTargetSchema = z.object({
  remoteMessageRefId: z.string().uuid(),
  folderId: z.string().uuid().optional(),
  sourceFolderId: z.string().uuid().optional(),
  destinationFolderId: z.string().uuid().optional(),
  expectedRemoteState: remoteMessagePreconditionSchema.optional(),
});

const hasEarlierActiveMessageMutation = async (commandId: string): Promise<boolean> => {
  const [predecessor] = await sql<{ id: string }[]>`
    SELECT predecessor.id
    FROM mail.commands current_command
    JOIN mail.commands predecessor
      ON predecessor.mailbox_id = current_command.mailbox_id
     AND predecessor.id <> current_command.id
     AND predecessor.kind IN ('set_flags', 'change_message_state', 'move', 'copy', 'delete')
     AND predecessor.state IN ('queued', 'executing', 'ambiguous')
     AND predecessor.target->>'remoteMessageRefId' = current_command.target->>'remoteMessageRefId'
     AND (predecessor.created_at, predecessor.id) < (current_command.created_at, current_command.id)
    WHERE current_command.id = ${commandId}::uuid
      AND current_command.target ? 'remoteMessageRefId'
    LIMIT 1
  `;
  return Boolean(predecessor);
};

const loadRemoteMessage = async (command: DbCommandExecution, target: z.infer<typeof sourceTargetSchema>): Promise<DbRemoteMessage> => {
  const folderId = target.folderId ?? target.sourceFolderId;
  if (!folderId) throw Object.assign(new Error("Command source folder is missing"), { code: "INVALID_COMMAND_TARGET" });
  const [message] = await sql<DbRemoteMessage[]>`
    SELECT
      rmr.id AS remote_message_ref_id,
      rmr.message_id AS message_content_id,
      mc.message_id,
      rmr.folder_id,
      bfr.remote_path AS folder_path,
      rmr.uid_validity,
      rmr.uid,
      bfr.effective_rights
    FROM mail.remote_message_refs rmr
    JOIN mail.message_contents mc ON mc.id = rmr.message_id
    JOIN mail.folders f ON f.id = rmr.folder_id
    JOIN mail.remote_resources rr ON rr.id = f.remote_resource_id
    JOIN mail.binding_folder_refs bfr
      ON bfr.folder_id = rmr.folder_id
     AND bfr.binding_id = ${command.selected_binding_id}::uuid
    WHERE rmr.id = ${target.remoteMessageRefId}::uuid
      AND rmr.folder_id = ${folderId}::uuid
      AND rr.mailbox_id = ${command.mailbox_id}::uuid
      AND rmr.stale_at IS NULL
      AND bfr.uid_validity = rmr.uid_validity
  `;
  if (!message) throw Object.assign(new Error("Remote message reference is no longer current"), { code: "REMOTE_MESSAGE_STALE" });
  return message;
};

const loadDestinationFolder = async (command: DbCommandExecution, folderId: string): Promise<DbDestinationFolder> => {
  const [folder] = await sql<DbDestinationFolder[]>`
    SELECT
      bfr.folder_id,
      bfr.remote_path AS folder_path,
      bfr.uid_validity,
      bfr.effective_rights
    FROM mail.binding_folder_refs bfr
    JOIN mail.folders f ON f.id = bfr.folder_id
    JOIN mail.remote_resources rr ON rr.id = f.remote_resource_id
    WHERE bfr.binding_id = ${command.selected_binding_id}::uuid
      AND bfr.folder_id = ${folderId}::uuid
      AND rr.mailbox_id = ${command.mailbox_id}::uuid
  `;
  if (!folder)
    throw Object.assign(new Error("Destination folder is unavailable on the pinned binding"), { code: "DESTINATION_UNAVAILABLE" });
  return folder;
};

const requireRights = (rights: readonly string[], required: readonly string[]): void => {
  if (required.every((right) => rights.includes(right))) return;
  throw Object.assign(new Error("Provider rights changed before command execution"), { code: "PROVIDER_RIGHTS_CHANGED" });
};

const remoteTarget = (message: DbRemoteMessage): RemoteMutationTarget => ({
  folderPath: message.folder_path,
  uidValidity: String(message.uid_validity),
  uid: Number(message.uid),
});

const commandState = async (
  command: Pick<DbCommandExecution, "id" | "attempt">,
  state: CommandState,
  error?: unknown,
): Promise<boolean> => {
  const code = error ? normalizeCode(error, "MAIL_COMMAND_FAILED") : null;
  const message = error ? errorMessage(error, "Mail command failed") : null;
  const updated = await sql.begin(async (tx) => {
    const [updated] = await tx<
      {
        mailbox_id: string;
        actor_kind: string;
        actor_id: string | null;
        transport_metadata: JsonRecord | string;
      }[]
    >`
      UPDATE mail.commands
      SET
        state = ${state},
        finished_at = CASE WHEN ${state} IN ('confirmed', 'failed', 'cancelled', 'reconciled', 'needs_attention') THEN now() ELSE NULL END,
        worker_heartbeat_at = NULL,
        last_error_code = ${code},
        last_error_message = ${message},
        updated_at = now()
      WHERE id = ${command.id}::uuid
        AND attempt = ${command.attempt}
        AND state = 'executing'
      RETURNING mailbox_id, actor_kind, actor_id, transport_metadata
    `;
    if (!updated) return null;
    if (state === "failed" || state === "cancelled") {
      const projection = localStateProjectionSchema.safeParse(parseJsonRecord(updated.transport_metadata).localStateProjection);
      if (projection.success) {
        await tx`
          UPDATE mail.message_placements
          SET
            flags = ${toPgTextArray(projection.data.previousFlags)}::text[],
            keywords = ${toPgTextArray(projection.data.previousKeywords)}::text[],
            updated_at = now()
          WHERE remote_message_ref_id = ${projection.data.remoteMessageRefId}::uuid
            AND flags @> ${toPgTextArray(projection.data.projectedFlags)}::text[]
            AND flags <@ ${toPgTextArray(projection.data.projectedFlags)}::text[]
            AND keywords @> ${toPgTextArray(projection.data.projectedKeywords)}::text[]
            AND keywords <@ ${toPgTextArray(projection.data.projectedKeywords)}::text[]
        `;
      }
    }
    await tx`
      INSERT INTO mail.activity_events (
        mailbox_id, command_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
      )
      VALUES (
        ${updated.mailbox_id}::uuid,
        ${command.id}::uuid,
        ${updated.actor_kind},
        ${updated.actor_id}::uuid,
        'command.execute',
        ${state === "confirmed" || state === "reconciled" ? "confirmed" : state === "ambiguous" ? "requested" : "failed"},
        'command',
        ${command.id}::uuid,
        ${{ state, code }}::jsonb
      )
    `;
    return updated;
  });
  if (!updated) return false;
  await notifyMailInvalidations();
  if (["confirmed", "failed", "cancelled", "reconciled", "needs_attention"].includes(state)) {
    await publishMailWorkflowDependency({
      mailboxId: updated.mailbox_id,
      dependency: { kind: "mail.command", key: command.id },
    });
  }
  return true;
};

const claimCommand = async (
  commandId: string,
  allowedKinds: string[],
): Promise<{ command: DbCommandExecution; previousState: string } | null> =>
  sql.begin(async (tx) => {
    const [current] = await tx<DbCommandExecution[]>`
      SELECT
        id, mailbox_id, kind, state, actor_kind, actor_id, correlation_id, workflow_execution_generation,
        initiator_actor_kind, initiator_actor_id,
        access_subject_kind, access_subject_id,
        credential_scopes, credential_id, credential_expires_at, target, payload, transport_metadata,
        selected_binding_id, selected_secret_revision, attempt
      FROM mail.commands
      WHERE id = ${commandId}::uuid
      FOR UPDATE
    `;
    if (!current || !allowedKinds.includes(current.kind) || !["queued", "ambiguous"].includes(current.state)) return null;
    if (current.actor_kind === "workflow") {
      const [run] = await tx<{ id: string }[]>`
        SELECT run.id
        FROM workflows.run run
        WHERE run.id::text = ${current.correlation_id}
          AND run.workflow_version_id = ${current.actor_id}::uuid
          AND run.execution_generation = ${current.workflow_execution_generation}
          AND (
            (run.state = 'running' AND run.lease_expires_at >= now())
            OR run.state = 'waiting'
          )
          AND run.cancel_requested_at IS NULL
        FOR UPDATE OF run
      `;
      if (!run) {
        await tx`
          UPDATE mail.commands
          SET
            state = 'cancelled',
            finished_at = now(),
            last_error_code = 'WORKFLOW_CANCELED',
            last_error_message = 'The workflow run was canceled before command execution',
            updated_at = now()
          WHERE id = ${current.id}::uuid AND state IN ('queued', 'ambiguous')
        `;
        return null;
      }
    }
    const previousState = current.state;
    const [claimed] = await tx<DbCommandExecution[]>`
      UPDATE mail.commands
      SET
        state = 'executing',
        attempt = attempt + 1,
        started_at = now(),
        worker_heartbeat_at = now(),
        finished_at = NULL,
        updated_at = now()
      WHERE id = ${commandId}::uuid
      RETURNING
        id, mailbox_id, kind, state, actor_kind, actor_id, correlation_id, workflow_execution_generation,
        initiator_actor_kind, initiator_actor_id,
        access_subject_kind, access_subject_id,
        credential_scopes, credential_id, credential_expires_at, target, payload, transport_metadata,
        selected_binding_id, selected_secret_revision, attempt
    `;
    return claimed ? { command: claimed, previousState } : null;
  });

const updateMutationProjection = async (params: {
  command: DbCommandExecution;
  source: DbRemoteMessage;
  destination?: DbDestinationFolder | null;
  destinationUidValidity?: string | null;
  destinationUid?: number | null;
  flags?: string[];
  keywords?: string[];
}): Promise<boolean> => {
  return sql.begin(async (tx) => {
    const [active] = await tx<{ id: string }[]>`
      SELECT id
      FROM mail.commands
      WHERE id = ${params.command.id}::uuid
        AND attempt = ${params.command.attempt}
        AND state = 'executing'
      FOR UPDATE
    `;
    if (!active) return false;
    if (params.flags) {
      await tx`
        UPDATE mail.message_placements
        SET flags = ${toPgTextArray(params.flags)}::text[], updated_at = now()
        WHERE remote_message_ref_id = ${params.source.remote_message_ref_id}::uuid
      `;
    }
    if (params.keywords) {
      await tx`
        UPDATE mail.message_placements
        SET keywords = ${toPgTextArray(params.keywords)}::text[], updated_at = now()
        WHERE remote_message_ref_id = ${params.source.remote_message_ref_id}::uuid
      `;
    }
    if ((params.command.kind === "copy" || params.command.kind === "move") && params.destination) {
      if (params.destinationUidValidity && params.destinationUid) {
        const [remoteRef] = await tx<{ id: string }[]>`
          INSERT INTO mail.remote_message_refs (
            folder_id, message_id, uid_validity, uid, connector_ref, first_seen_at, last_seen_at
          )
          VALUES (
            ${params.destination.folder_id}::uuid,
            ${params.source.message_content_id}::uuid,
            ${params.destinationUidValidity},
            ${params.destinationUid},
            ${{ source: "command", commandId: params.command.id }}::jsonb,
            now(),
            now()
          )
          ON CONFLICT (folder_id, uid_validity, uid) DO UPDATE SET
            message_id = EXCLUDED.message_id,
            last_seen_at = now(),
            stale_at = NULL
          RETURNING id
        `;
        if (remoteRef) {
          await tx`
            INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
            SELECT
              ${remoteRef.id}::uuid,
              ${params.destination.folder_id}::uuid,
              ${params.source.message_content_id}::uuid,
              mp.flags,
              mp.keywords
            FROM mail.message_placements mp
            WHERE mp.remote_message_ref_id = ${params.source.remote_message_ref_id}::uuid
            ON CONFLICT (remote_message_ref_id) DO UPDATE SET
              folder_id = EXCLUDED.folder_id,
              message_id = EXCLUDED.message_id,
              flags = EXCLUDED.flags,
              keywords = EXCLUDED.keywords,
              deleted_at = NULL,
              updated_at = now()
          `;
        }
      }
    }
    if (params.command.kind === "move" || params.command.kind === "delete") {
      await tx`
        UPDATE mail.remote_message_refs
        SET stale_at = now(), last_seen_at = now()
        WHERE id = ${params.source.remote_message_ref_id}::uuid
      `;
      await tx`
        UPDATE mail.message_placements
        SET deleted_at = now(), updated_at = now()
        WHERE remote_message_ref_id = ${params.source.remote_message_ref_id}::uuid
      `;
    }
    return true;
  });
};

const storeMutationBaseline = async (command: DbCommandExecution, uids: number[]): Promise<void> => {
  await sql`
    UPDATE mail.commands
    SET transport_metadata = transport_metadata || ${{ destinationBaselineUids: uids }}::jsonb
    WHERE id = ${command.id}::uuid AND attempt = ${command.attempt} AND state = 'executing'
  `;
};

const baselineUids = (command: DbCommandExecution): number[] => {
  const metadata = parseJsonRecord(command.transport_metadata);
  const values = metadata.destinationBaselineUids;
  return Array.isArray(values) ? values.filter((value): value is number => Number.isInteger(value) && value > 0) : [];
};

const isAmbiguousTransportError = (error: unknown): boolean => {
  const code = normalizeCode(error, "");
  return [
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNABORTED",
    "EPIPE",
    "ESOCKET",
    "ECONNECTION",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "IMAP_CONNECTION_CLOSED",
  ].includes(code);
};

const RETRYABLE_CONNECTION_CODES = new Set(["ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND"]);

const PARTIAL_MUTATION_CODES = new Set([
  "DELETE_RECONCILIATION_FAILED",
  "FLAG_RECONCILIATION_FAILED",
  "MOVE_RECONCILIATION_FAILED",
  "MOVE_SOURCE_DELETE_MARK_FAILED",
  "REMOTE_DELETE_FAILED",
  "REMOTE_MOVE_FAILED",
]);

const AMBIGUOUS_COMMAND_CODES = new Set([
  "AMBIGUOUS_LOCAL_PERSISTENCE",
  "COMMAND_JOB_LEASE_LOST",
  "REMOTE_CREATE_SUBSCRIBE_PARTIAL",
  "REMOTE_FLAGS_UNCONFIRMED",
  "REMOTE_STATE_PARTIAL",
  "REMOTE_STATE_UNCONFIRMED",
  "REMOTE_SUBSCRIPTION_UNCONFIRMED",
  "STATE_RECONCILIATION_FAILED",
  "STALE_COMMAND_FENCE",
]);

export const mutationFailureState = (error: unknown, providerEffectStarted = true): CommandState => {
  const code = normalizeCode(error, "");
  if (PARTIAL_MUTATION_CODES.has(code)) return "needs_attention";
  if (AMBIGUOUS_COMMAND_CODES.has(code)) return "ambiguous";
  if (RETRYABLE_CONNECTION_CODES.has(code)) return providerEffectStarted ? "ambiguous" : "queued";
  return isAmbiguousTransportError(error) ? "ambiguous" : "failed";
};

const providerEffectStartedForAttempt = async (command: Pick<DbCommandExecution, "id" | "attempt">): Promise<boolean> => {
  const [state] = await sql<{ started: boolean }[]>`
    SELECT COALESCE(provider_effect_attempt = ${command.attempt}, false) AS started
    FROM mail.commands
    WHERE id = ${command.id}::uuid
  `;
  // Missing state is treated conservatively because replay safety can no longer be proven.
  return state?.started ?? true;
};

const persistMutationOutcome = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (cause) {
    throw Object.assign(new Error("Provider mutation completed but its local outcome could not be persisted"), {
      code: "AMBIGUOUS_LOCAL_PERSISTENCE",
      cause,
    });
  }
};

type LeaseAssertion = () => Promise<void>;
const noLeaseAssertion: LeaseAssertion = async () => undefined;

const providerEffectPermission = (kind: DbCommandExecution["kind"]): "write" | "admin" =>
  ["create_folder", "rename_folder", "delete_folder", "set_folder_subscription"].includes(kind) ? "admin" : "write";

const beginProviderEffect = async (
  command: DbCommandExecution,
  senderIdentityId?: string,
  identityTransportRevision?: number | null,
): Promise<void> =>
  sql.begin(async (tx) => {
    const [mailbox] = await tx<{ id: string }[]>`
      SELECT id
      FROM mail.mailboxes
      WHERE id = ${command.mailbox_id}::uuid AND deleted_at IS NULL
      FOR UPDATE
    `;
    if (!mailbox) {
      throw Object.assign(new Error("Mailbox access was revoked before the provider effect"), { code: "ACCESS_REVOKED" });
    }
    const [current] = await tx<{ id: string }[]>`
      SELECT command.id
      FROM mail.commands command
      JOIN mail.provider_bindings binding ON binding.id = command.selected_binding_id
      JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
      JOIN mail.provider_connections connection ON connection.id = binding.connection_id
      JOIN mail.mailboxes mailbox ON mailbox.id = command.mailbox_id
      WHERE command.id = ${command.id}::uuid
        AND command.state = 'executing'
        AND command.attempt = ${command.attempt}
        AND command.selected_secret_revision = ${command.selected_secret_revision}
        AND binding.state IN ('active', 'degraded')
        AND binding.verified_scope_fingerprint = resource.scope_fingerprint
        AND binding.verified_secret_revision = command.selected_secret_revision
        AND connection.secret_revision = command.selected_secret_revision
        AND connection.status IN ('active', 'degraded')
        AND connection.encrypted_secret IS NOT NULL
        AND resource.status IN ('active', 'degraded')
        AND mailbox.sync_enabled = true
        AND mailbox.health NOT IN ('auth_required', 'connection_required', 'paused')
        AND mailbox.deleted_at IS NULL
      FOR UPDATE OF command
    `;
    if (!current) {
      throw Object.assign(new Error("Mail command lease was lost before the provider effect"), { code: "COMMAND_JOB_LEASE_LOST" });
    }
    if (command.actor_kind === "workflow") {
      const [run] = await tx<{ id: string }[]>`
        SELECT run.id
        FROM workflows.run run
        WHERE run.id::text = ${command.correlation_id}
          AND run.workflow_version_id = ${command.actor_id}::uuid
          AND run.execution_generation = ${command.workflow_execution_generation}
          AND (
            (run.state = 'running' AND run.lease_expires_at >= now())
            OR run.state = 'waiting'
          )
          AND run.cancel_requested_at IS NULL
        FOR UPDATE OF run
      `;
      if (!run) {
        throw Object.assign(new Error("Workflow run was canceled before the provider effect"), { code: "WORKFLOW_CANCELED" });
      }
    }
    if (command.kind === "send") {
      if (!senderIdentityId) {
        throw Object.assign(new Error("Send command is missing its sender identity"), { code: "SENDER_IDENTITY_UNAVAILABLE" });
      }
      const [sender] = await tx<{ id: string }[]>`
        SELECT identity.id
        FROM mail.sender_identities identity
        JOIN mail.sender_identity_bindings sender_binding
          ON sender_binding.sender_identity_id = identity.id
         AND sender_binding.binding_id = ${command.selected_binding_id}::uuid
         AND sender_binding.verified_secret_revision = ${command.selected_secret_revision}
         AND sender_binding.revoked_at IS NULL
        WHERE identity.id = ${senderIdentityId}::uuid
          AND identity.mailbox_id = ${command.mailbox_id}::uuid
          AND identity.status = 'verified'
          AND (${command.actor_kind} <> 'workflow' OR identity.automation_policy = 'mailbox')
        FOR SHARE OF identity, sender_binding
      `;
      if (!sender) {
        throw Object.assign(new Error("Sender identity authorization was revoked before the provider effect"), {
          code: command.actor_kind === "workflow" ? "AUTOMATION_SENDER_DISABLED" : "SENDER_IDENTITY_UNAVAILABLE",
        });
      }
      if (identityTransportRevision !== null && identityTransportRevision !== undefined) {
        const [transport] = await tx<{ sender_identity_id: string }[]>`
          SELECT sender_identity_id
          FROM mail.sender_identity_transports
          WHERE sender_identity_id = ${senderIdentityId}::uuid
            AND mailbox_id = ${command.mailbox_id}::uuid
            AND revision = ${identityTransportRevision}
            AND status = 'active'
            AND encrypted_secret IS NOT NULL
          FOR SHARE
        `;
        if (!transport) {
          throw Object.assign(new Error("The selected identity SMTP transport changed before sending"), {
            code: "IDENTITY_TRANSPORT_CHANGED",
          });
        }
      }
    }
    const requiredPermission = providerEffectPermission(command.kind);
    if (!(await commandStillAuthorized(command, requiredPermission, tx))) {
      throw Object.assign(new Error(`Mailbox ${requiredPermission} access was revoked before the provider effect`), {
        code: "ACCESS_REVOKED",
      });
    }
    const updated = await tx`
      UPDATE mail.commands
      SET
        provider_effect_started_at = COALESCE(provider_effect_started_at, now()),
        provider_effect_attempt = ${command.attempt}
      WHERE id = ${command.id}::uuid
        AND state = 'executing'
        AND attempt = ${command.attempt}
      RETURNING id
    `;
    if (updated.length === 0) {
      throw Object.assign(new Error("Mail command lease was lost before the provider effect"), { code: "COMMAND_JOB_LEASE_LOST" });
    }
  });

const recordCommandTransportMetadata = async (command: DbCommandExecution, metadata: JsonRecord): Promise<void> => {
  await sql`
    UPDATE mail.commands
    SET transport_metadata = transport_metadata || ${metadata}::jsonb
    WHERE id = ${command.id}::uuid AND attempt = ${command.attempt} AND state = 'executing'
  `;
};

type MutationRuntime = Awaited<ReturnType<typeof loadPinnedRuntime>>;
type MutationTarget = z.infer<typeof sourceTargetSchema>;

const flagsPayloadSchema = z.object({ flags: z.array(z.string().min(1).max(100)).max(100) });
const messageStatePayloadSchema = z.object({
  addFlags: z.array(z.enum(["seen", "answered", "flagged", "draft"])).max(4),
  removeFlags: z.array(z.enum(["seen", "answered", "flagged", "draft"])).max(4),
  addKeywords: z.array(z.string().min(1).max(100)).max(100),
  removeKeywords: z.array(z.string().min(1).max(100)).max(100),
});

const IMAP_SYSTEM_FLAGS = {
  seen: "\\Seen",
  answered: "\\Answered",
  flagged: "\\Flagged",
  draft: "\\Draft",
} as const;

const remoteStateChange = (payload: z.infer<typeof messageStatePayloadSchema>) => ({
  addFlags: payload.addFlags.map((flag) => IMAP_SYSTEM_FLAGS[flag]),
  removeFlags: payload.removeFlags.map((flag) => IMAP_SYSTEM_FLAGS[flag]),
  addKeywords: payload.addKeywords,
  removeKeywords: payload.removeKeywords,
});

const stateChangeMatches = (
  state: { exists: boolean; flags: string[]; keywords: string[] },
  change: ReturnType<typeof remoteStateChange>,
): boolean => {
  if (!state.exists) return false;
  const flags = new Set(state.flags.map((value) => value.toLowerCase()));
  const keywords = new Set(state.keywords.map((value) => value.toLowerCase()));
  return (
    change.addFlags.every((value) => flags.has(value.toLowerCase())) &&
    change.removeFlags.every((value) => !flags.has(value.toLowerCase())) &&
    change.addKeywords.every((value) => keywords.has(value.toLowerCase())) &&
    change.removeKeywords.every((value) => !keywords.has(value.toLowerCase()))
  );
};

const assertRemoteMessageIdentity = async (
  runtime: MutationRuntime,
  source: DbRemoteMessage,
  target: RemoteMutationTarget,
): Promise<RemoteMessageState> => {
  const current = await imapSmtpConnector.getMessageState(runtime, target);
  if (!current.exists) throw Object.assign(new Error("Remote message no longer exists"), { code: "REMOTE_MESSAGE_MISSING" });
  if (source.message_id && current.messageId?.trim().toLowerCase() !== source.message_id.trim().toLowerCase()) {
    throw Object.assign(new Error("Remote UID no longer identifies the expected message"), { code: "REMOTE_IDENTITY_MISMATCH" });
  }
  return current;
};

const normalizedStandardFlags = (flags: readonly string[]): string[] => {
  const standard: Record<string, string> = {
    "\\answered": "answered",
    answered: "answered",
    "\\draft": "draft",
    draft: "draft",
    "\\flagged": "flagged",
    flagged: "flagged",
    "\\seen": "seen",
    seen: "seen",
  };
  return [...new Set(flags.map((flag) => standard[flag.toLowerCase()]).filter((flag): flag is string => Boolean(flag)))].sort();
};

const normalizedKeywords = (keywords: readonly string[]): string[] => [...new Set(keywords.map((keyword) => keyword.toLowerCase()))].sort();

const assertRemoteMessagePrecondition = (current: RemoteMessageState, expected?: RemoteMessagePrecondition): void => {
  if (!expected) return;
  const modseqChanged = expected.modseq != null && current.modseq !== expected.modseq;
  const flagsChanged =
    expected.flags !== undefined &&
    JSON.stringify(normalizedStandardFlags(current.flags)) !== JSON.stringify(normalizedStandardFlags(expected.flags));
  const keywordsChanged =
    expected.keywords !== undefined &&
    JSON.stringify(normalizedKeywords(current.keywords)) !== JSON.stringify(normalizedKeywords(expected.keywords));
  if (modseqChanged || flagsChanged || keywordsChanged) {
    throw Object.assign(new Error("Remote message state changed after workflow preview"), { code: "REMOTE_STATE_CHANGED" });
  }
};

const executeSetFlagsMutation = async (params: {
  command: DbCommandExecution;
  runtime: MutationRuntime;
  source: DbRemoteMessage;
  target: RemoteMutationTarget;
  assertLeaseActive: LeaseAssertion;
  assertAuthorized: LeaseAssertion;
  beginEffect: LeaseAssertion;
}): Promise<void> => {
  requireRights(params.source.effective_rights, ["write_flags"]);
  const payload = flagsPayloadSchema.parse(parseJsonRecord(params.command.payload));
  await params.assertAuthorized();
  await params.beginEffect();
  await imapSmtpConnector.setFlags(params.runtime, params.target, payload.flags);
  await params.assertLeaseActive();
  const verified = await imapSmtpConnector.getMessageState(params.runtime, params.target);
  const actual = [...verified.flags].sort();
  const expected = [...payload.flags].sort();
  if (!verified.exists || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw Object.assign(new Error("Provider did not confirm the requested flags"), { code: "FLAG_RECONCILIATION_FAILED" });
  }
  await persistMutationOutcome(async () => {
    if (!(await updateMutationProjection({ command: params.command, source: params.source, flags: expected }))) return;
    await commandState(params.command, "confirmed");
  });
};

const executeMessageStateMutation = async (params: {
  command: DbCommandExecution;
  runtime: MutationRuntime;
  source: DbRemoteMessage;
  target: RemoteMutationTarget;
  assertLeaseActive: LeaseAssertion;
  assertAuthorized: LeaseAssertion;
  beginEffect: LeaseAssertion;
}): Promise<void> => {
  requireRights(params.source.effective_rights, ["write_flags"]);
  const payload = messageStatePayloadSchema.parse(parseJsonRecord(params.command.payload));
  const change = remoteStateChange(payload);
  await params.assertAuthorized();
  await params.beginEffect();
  const state = await imapSmtpConnector.changeMessageState(params.runtime, params.target, change);
  await params.assertLeaseActive();
  if (!stateChangeMatches(state, change)) {
    throw Object.assign(new Error("Provider did not confirm the requested message state"), { code: "STATE_RECONCILIATION_FAILED" });
  }
  await persistMutationOutcome(async () => {
    if (!(await updateMutationProjection({ command: params.command, source: params.source, flags: state.flags, keywords: state.keywords })))
      return;
    await commandState(params.command, "confirmed");
  });
};

const executeDeleteMutation = async (params: {
  command: DbCommandExecution;
  runtime: MutationRuntime;
  source: DbRemoteMessage;
  target: RemoteMutationTarget;
  assertLeaseActive: LeaseAssertion;
  assertAuthorized: LeaseAssertion;
  beginEffect: LeaseAssertion;
}): Promise<void> => {
  requireRights(params.source.effective_rights, ["delete_messages"]);
  await params.assertAuthorized();
  await params.beginEffect();
  await imapSmtpConnector.delete(params.runtime, params.target);
  await params.assertLeaseActive();
  const verified = await imapSmtpConnector.getMessageState(params.runtime, params.target);
  if (verified.exists) {
    throw Object.assign(new Error("Provider did not confirm message deletion"), { code: "DELETE_RECONCILIATION_FAILED" });
  }
  await persistMutationOutcome(async () => {
    if (!(await updateMutationProjection({ command: params.command, source: params.source }))) return;
    await commandState(params.command, "confirmed");
  });
};

const resolveTransferDestination = async (params: {
  runtime: MutationRuntime;
  source: DbRemoteMessage;
  destination: DbDestinationFolder;
  baseline: number[];
  result: { destinationUid: number | null; destinationUidValidity: string | null };
}): Promise<{ destinationUid: number | null; destinationUidValidity: string | null }> => {
  if ((params.result.destinationUid && params.result.destinationUidValidity) || !params.source.message_id) return params.result;
  const matches = await imapSmtpConnector.findMessageById(params.runtime, params.destination.folder_path, params.source.message_id);
  const destinationUid = matches.find((uid) => !params.baseline.includes(uid)) ?? null;
  return {
    destinationUid,
    destinationUidValidity: destinationUid ? String(params.destination.uid_validity ?? "") || null : null,
  };
};

const verifyMoveSource = async (params: {
  runtime: MutationRuntime;
  target: RemoteMutationTarget;
  expungePending: boolean;
}): Promise<boolean> => {
  const sourceAfter = await imapSmtpConnector.getMessageState(params.runtime, params.target);
  if (params.expungePending) {
    if (sourceAfter.exists && !sourceAfter.flags.includes("\\Deleted")) {
      throw Object.assign(new Error("Provider did not retain the source deletion marker after move"), {
        code: "MOVE_RECONCILIATION_FAILED",
      });
    }
    return sourceAfter.exists;
  }
  if (sourceAfter.exists) {
    throw Object.assign(new Error("Provider did not confirm source removal after move"), { code: "MOVE_RECONCILIATION_FAILED" });
  }
  return false;
};

const executeTransferMutation = async (params: {
  command: DbCommandExecution;
  runtime: MutationRuntime;
  source: DbRemoteMessage;
  target: MutationTarget;
  remoteTarget: RemoteMutationTarget;
  assertLeaseActive: LeaseAssertion;
  assertAuthorized: LeaseAssertion;
  beginEffect: LeaseAssertion;
}): Promise<void> => {
  const { command, runtime, source, target } = params;
  if (command.kind !== "copy" && command.kind !== "move") {
    throw Object.assign(new Error("Unsupported actor command kind"), { code: "UNSUPPORTED_COMMAND" });
  }
  if (!target.destinationFolderId) throw Object.assign(new Error("Destination folder is missing"), { code: "INVALID_COMMAND_TARGET" });
  requireRights(source.effective_rights, command.kind === "move" ? ["read", "move"] : ["read"]);
  const destination = await loadDestinationFolder(command, target.destinationFolderId);
  requireRights(destination.effective_rights, ["insert"]);

  await params.assertAuthorized();
  const baseline = source.message_id ? await imapSmtpConnector.findMessageById(runtime, destination.folder_path, source.message_id) : [];
  await storeMutationBaseline(command, baseline);
  await params.assertAuthorized();
  await params.beginEffect();
  const result =
    command.kind === "copy"
      ? await imapSmtpConnector.copy(runtime, params.remoteTarget, destination.folder_path)
      : await imapSmtpConnector.move(runtime, params.remoteTarget, destination.folder_path);
  await params.assertLeaseActive();
  const { destinationUid, destinationUidValidity } = await resolveTransferDestination({
    runtime,
    source,
    destination,
    baseline,
    result,
  });
  const expungePending =
    command.kind === "move"
      ? await verifyMoveSource({ runtime, target: params.remoteTarget, expungePending: result.expungePending })
      : result.expungePending;
  await persistMutationOutcome(async () => {
    if (!(await updateMutationProjection({ command, source, destination, destinationUid, destinationUidValidity }))) return;
    if (expungePending) {
      await recordCommandTransportMetadata(command, {
        expungePending: true,
        expungePendingFolderId: source.folder_id,
        expungePendingUid: Number(source.uid),
      });
    }
    await commandState(command, "confirmed");
  });
};

const executeFreshMutation = async (command: DbCommandExecution, assertLeaseActive: LeaseAssertion): Promise<void> => {
  if (!(await commandStillAuthorized(command, "write"))) {
    await commandState(
      command,
      "failed",
      Object.assign(new Error("Mailbox write access was revoked before execution"), { code: "ACCESS_REVOKED" }),
    );
    return;
  }
  const runtime = await loadPinnedRuntime(await loadPinnedBinding(command));
  const target = sourceTargetSchema.parse(parseJsonRecord(command.target));
  const source = await loadRemoteMessage(command, target);
  const remote = remoteTarget(source);
  const assertAuthorized = async (): Promise<void> => {
    await assertLeaseActive();
    if (!(await commandStillAuthorized(command, "write"))) {
      throw Object.assign(new Error("Mailbox write access was revoked before provider execution"), { code: "ACCESS_REVOKED" });
    }
    const current = await assertRemoteMessageIdentity(runtime, source, remote);
    assertRemoteMessagePrecondition(current, target.expectedRemoteState);
    await assertLeaseActive();
    if (!(await commandStillAuthorized(command, "write"))) {
      throw Object.assign(new Error("Mailbox write access was revoked before provider execution"), { code: "ACCESS_REVOKED" });
    }
  };
  const params = {
    command,
    runtime,
    source,
    target: remote,
    assertLeaseActive,
    assertAuthorized,
    beginEffect: () => beginProviderEffect(command),
  };
  if (command.kind === "set_flags") return executeSetFlagsMutation(params);
  if (command.kind === "change_message_state") return executeMessageStateMutation(params);
  if (command.kind === "delete") return executeDeleteMutation(params);
  return executeTransferMutation({ ...params, target, remoteTarget: remote });
};

const loadReconciliationSource = async (command: DbCommandExecution, target: MutationTarget): Promise<DbRemoteMessage> => {
  try {
    return await loadRemoteMessage(command, target);
  } catch (error) {
    if (command.kind !== "delete" && command.kind !== "move") throw error;
    const [stale] = await sql<DbRemoteMessage[]>`
      SELECT
        rmr.id AS remote_message_ref_id,
        rmr.message_id AS message_content_id,
        mc.message_id,
        rmr.folder_id,
        bfr.remote_path AS folder_path,
        rmr.uid_validity,
        rmr.uid,
        bfr.effective_rights
      FROM mail.remote_message_refs rmr
      JOIN mail.message_contents mc ON mc.id = rmr.message_id
      JOIN mail.binding_folder_refs bfr
        ON bfr.folder_id = rmr.folder_id
       AND bfr.binding_id = ${command.selected_binding_id}::uuid
      WHERE rmr.id = ${target.remoteMessageRefId}::uuid
    `;
    if (stale) return stale;
    throw error;
  }
};

const reconcileSetFlagsMutation = async (params: {
  command: DbCommandExecution;
  runtime: MutationRuntime;
  source: DbRemoteMessage;
  target: RemoteMutationTarget;
}): Promise<void> => {
  const payload = flagsPayloadSchema.parse(parseJsonRecord(params.command.payload));
  const state = await imapSmtpConnector.getMessageState(params.runtime, params.target);
  const matches = state.exists && JSON.stringify([...state.flags].sort()) === JSON.stringify([...payload.flags].sort());
  if (matches) {
    if (!(await updateMutationProjection({ command: params.command, source: params.source, flags: payload.flags }))) return;
    await commandState(params.command, "reconciled");
    return;
  }
  await sql`
    UPDATE mail.commands
    SET state = 'queued', worker_heartbeat_at = NULL, updated_at = now()
    WHERE id = ${params.command.id}::uuid AND attempt = ${params.command.attempt} AND state = 'executing'
  `;
};

const reconcileMessageStateMutation = async (params: {
  command: DbCommandExecution;
  runtime: MutationRuntime;
  source: DbRemoteMessage;
  target: RemoteMutationTarget;
}): Promise<void> => {
  const change = remoteStateChange(messageStatePayloadSchema.parse(parseJsonRecord(params.command.payload)));
  const state = await imapSmtpConnector.getMessageState(params.runtime, params.target);
  if (stateChangeMatches(state, change)) {
    if (!(await updateMutationProjection({ command: params.command, source: params.source, flags: state.flags, keywords: state.keywords })))
      return;
    await commandState(params.command, "reconciled");
    return;
  }
  await sql`
    UPDATE mail.commands
    SET state = 'queued', worker_heartbeat_at = NULL, updated_at = now()
    WHERE id = ${params.command.id}::uuid AND attempt = ${params.command.attempt} AND state = 'executing'
  `;
};

const reconcileDeleteMutation = async (params: {
  command: DbCommandExecution;
  source: DbRemoteMessage;
  sourceExists: boolean;
}): Promise<void> => {
  if (!params.sourceExists) {
    if (!(await updateMutationProjection({ command: params.command, source: params.source }))) return;
    await commandState(params.command, "reconciled");
    return;
  }
  await commandState(
    params.command,
    "needs_attention",
    Object.assign(new Error("Deletion outcome is ambiguous"), { code: "AMBIGUOUS_DELETE" }),
  );
};

const reconcileTransferMutation = async (params: {
  command: DbCommandExecution;
  runtime: MutationRuntime;
  target: MutationTarget;
  source: DbRemoteMessage;
  sourceState: Awaited<ReturnType<typeof imapSmtpConnector.getMessageState>>;
}): Promise<boolean> => {
  const { command, runtime, target, source, sourceState } = params;
  if ((command.kind !== "copy" && command.kind !== "move") || !target.destinationFolderId || !source.message_id) return false;
  const destination = await loadDestinationFolder(command, target.destinationFolderId);
  const matches = await imapSmtpConnector.findMessageById(runtime, destination.folder_path, source.message_id);
  const newUid = matches.find((uid) => !baselineUids(command).includes(uid)) ?? null;
  const expungePending = command.kind === "move" && Boolean(newUid && sourceState.exists && sourceState.flags.includes("\\Deleted"));
  const successful = command.kind === "copy" ? Boolean(newUid) : Boolean(newUid && (!sourceState.exists || expungePending));
  if (!successful) return false;
  if (
    !(await updateMutationProjection({
      command,
      source,
      destination,
      destinationUid: newUid,
      destinationUidValidity: newUid ? String(destination.uid_validity ?? "") || null : null,
    }))
  ) {
    return true;
  }
  if (expungePending) {
    await recordCommandTransportMetadata(command, {
      expungePending: true,
      expungePendingFolderId: source.folder_id,
      expungePendingUid: Number(source.uid),
    });
  }
  await commandState(command, "reconciled");
  return true;
};

const reconcileMutation = async (command: DbCommandExecution): Promise<void> => {
  if (!(await commandStillAuthorized(command, "write"))) {
    await commandState(
      command,
      "needs_attention",
      Object.assign(new Error("Access was revoked before ambiguous command reconciliation"), { code: "ACCESS_REVOKED" }),
    );
    return;
  }
  const runtime = await loadPinnedRuntime(await loadPinnedBinding(command));
  const target = sourceTargetSchema.parse(parseJsonRecord(command.target));
  const source = await loadReconciliationSource(command, target);
  const remote = remoteTarget(source);
  if (command.kind === "set_flags") {
    await reconcileSetFlagsMutation({ command, runtime, source, target: remote });
    return;
  }
  if (command.kind === "change_message_state") {
    await reconcileMessageStateMutation({ command, runtime, source, target: remote });
    return;
  }
  const sourceState = await imapSmtpConnector.getMessageState(runtime, remote);
  if (command.kind === "delete") return reconcileDeleteMutation({ command, source, sourceExists: sourceState.exists });
  if (await reconcileTransferMutation({ command, runtime, target, source, sourceState })) return;
  await commandState(
    command,
    "needs_attention",
    Object.assign(new Error("Remote mutation outcome could not be proven"), { code: "AMBIGUOUS_MUTATION" }),
  );
};

const FOLDER_COMMAND_KINDS = ["create_folder", "rename_folder", "delete_folder", "set_folder_subscription"] as const;
type FolderCommandKind = (typeof FOLDER_COMMAND_KINDS)[number];

const isFolderCommandKind = (kind: string): kind is FolderCommandKind => FOLDER_COMMAND_KINDS.includes(kind as FolderCommandKind);

type DbFolderCommandTarget = {
  folder_id: string;
  parent_id: string | null;
  role: string;
  selectable: boolean;
  remote_path: string;
  delimiter: string | null;
  subscribed: boolean;
  effective_rights: string[];
  rights_source: "acl" | "select" | "probe" | "unknown";
};

const folderTargetSchema = z.object({
  folderId: z.string().uuid().optional(),
  parentFolderId: z.string().uuid().nullable().optional(),
});
const createFolderPayloadSchema = z.object({
  name: z.string().min(1).max(255),
  subscribe: z.boolean(),
  showInSidebar: z.boolean().default(true),
});
const renameFolderPayloadSchema = z.object({ name: z.string().min(1).max(255) });
const subscriptionPayloadSchema = z.object({ subscribed: z.boolean() });

const loadFolderCommandTarget = async (command: DbCommandExecution, folderId: string): Promise<DbFolderCommandTarget> => {
  const [folder] = await sql<DbFolderCommandTarget[]>`
    SELECT
      folder.id AS folder_id,
      folder.parent_id,
      folder.role,
      folder.selectable,
      ref.remote_path,
      ref.delimiter,
      ref.subscribed,
      ref.effective_rights,
      ref.rights_source
    FROM mail.folders folder
    JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
    JOIN mail.binding_folder_refs ref
      ON ref.folder_id = folder.id
     AND ref.binding_id = ${command.selected_binding_id}::uuid
     AND ref.missing_since IS NULL
    WHERE folder.id = ${folderId}::uuid
      AND resource.mailbox_id = ${command.mailbox_id}::uuid
      AND folder.discovery_state = 'active'
  `;
  if (!folder) throw Object.assign(new Error("Folder is unavailable on the pinned binding"), { code: "FOLDER_UNAVAILABLE" });
  return folder;
};

const assertFolderAclRight = (folder: DbFolderCommandTarget, right: "create_children" | "delete_folder"): void => {
  if (folder.rights_source !== "acl" || folder.effective_rights.includes(right)) return;
  throw Object.assign(new Error("Provider ACL does not allow this folder operation"), { code: "PROVIDER_RIGHTS_CHANGED" });
};

const leafPath = (parentPath: string, delimiter: string | null, name: string): string => {
  if (delimiter && name.includes(delimiter)) {
    throw Object.assign(new Error("Folder name contains the provider hierarchy delimiter"), { code: "INVALID_FOLDER_NAME" });
  }
  if (!parentPath) return name;
  if (!delimiter)
    throw Object.assign(new Error("Provider does not expose a folder hierarchy delimiter"), { code: "FOLDER_HIERARCHY_UNAVAILABLE" });
  return `${parentPath}${delimiter}${name}`;
};

const replacementPath = (folder: DbFolderCommandTarget, name: string): string => {
  if (!folder.delimiter) return name;
  if (name.includes(folder.delimiter)) {
    throw Object.assign(new Error("Folder name contains the provider hierarchy delimiter"), { code: "INVALID_FOLDER_NAME" });
  }
  const separator = folder.remote_path.lastIndexOf(folder.delimiter);
  return separator < 0 ? name : `${folder.remote_path.slice(0, separator)}${folder.delimiter}${name}`;
};

const defaultBindingNamespace = async (
  bindingId: string,
  runtime: MutationRuntime,
): Promise<{ path: string; delimiter: string | null }> => {
  const [[namespace], [folder]] = await Promise.all([
    sql<{ prefix: string; delimiter: string | null }[]>`
      SELECT prefix, delimiter
      FROM mail.remote_namespaces
      WHERE binding_id = ${bindingId}::uuid AND kind = 'personal'
      ORDER BY char_length(prefix), prefix
      LIMIT 1
    `,
    sql<{ delimiter: string | null }[]>`
      SELECT delimiter
      FROM mail.binding_folder_refs
      WHERE binding_id = ${bindingId}::uuid AND delimiter IS NOT NULL AND missing_since IS NULL
      ORDER BY char_length(remote_path), remote_path
      LIMIT 1
    `,
  ]);
  let delimiter = namespace?.delimiter ?? folder?.delimiter ?? null;
  if (!delimiter) {
    const remoteFolders = await imapSmtpConnector.discoverFolders(runtime);
    delimiter = remoteFolders.find((remoteFolder) => remoteFolder.delimiter)?.delimiter ?? null;
  }
  const prefix = namespace?.prefix ?? "";
  const path = delimiter && prefix.endsWith(delimiter) ? prefix.slice(0, -delimiter.length) : prefix;
  return { path, delimiter };
};

const requeueCommand = async (command: DbCommandExecution, code: string, message: string): Promise<void> => {
  await sql`
    UPDATE mail.commands
    SET
      state = 'queued',
      worker_heartbeat_at = NULL,
      last_error_code = ${code},
      last_error_message = ${message.slice(0, 1_000)},
      updated_at = now()
    WHERE id = ${command.id}::uuid AND attempt = ${command.attempt} AND state = 'executing'
  `;
};

const recordCommandResult = async (command: DbCommandExecution, result: JsonRecord): Promise<void> => {
  await sql`
    UPDATE mail.commands
    SET result = ${result}::jsonb, updated_at = now()
    WHERE id = ${command.id}::uuid AND attempt = ${command.attempt} AND state = 'executing'
  `;
};

type PreparedFolderOperation = {
  binding: DbPinnedBinding;
  runtime: MutationRuntime;
  path: string;
  newPath: string | null;
  subscribed: boolean | null;
  showInSidebar: boolean | null;
  folder: DbFolderCommandTarget | null;
};

const prepareFolderOperation = async (command: DbCommandExecution): Promise<PreparedFolderOperation> => {
  const binding = await loadPinnedBinding(command);
  const runtime = await loadPinnedRuntime(binding);
  const target = folderTargetSchema.parse(parseJsonRecord(command.target));
  if (command.kind === "create_folder") {
    const payload = createFolderPayloadSchema.parse(parseJsonRecord(command.payload));
    const parent = target.parentFolderId ? await loadFolderCommandTarget(command, target.parentFolderId) : null;
    if (parent) assertFolderAclRight(parent, "create_children");
    const namespace = parent ? null : await defaultBindingNamespace(command.selected_binding_id, runtime);
    const delimiter = parent?.delimiter ?? namespace?.delimiter ?? null;
    const path = leafPath(parent?.remote_path ?? namespace?.path ?? "", delimiter, payload.name);
    return {
      binding,
      runtime,
      path,
      newPath: null,
      subscribed: payload.subscribe,
      showInSidebar: payload.showInSidebar,
      folder: parent,
    };
  }
  if (!target.folderId) throw Object.assign(new Error("Folder command target is missing"), { code: "INVALID_COMMAND_TARGET" });
  const folder = await loadFolderCommandTarget(command, target.folderId);
  if (command.kind === "rename_folder") {
    assertFolderAclRight(folder, "delete_folder");
    if (folder.parent_id) {
      const parent = await loadFolderCommandTarget(command, folder.parent_id);
      assertFolderAclRight(parent, "create_children");
    }
    const payload = renameFolderPayloadSchema.parse(parseJsonRecord(command.payload));
    return {
      binding,
      runtime,
      path: folder.remote_path,
      newPath: replacementPath(folder, payload.name),
      subscribed: null,
      showInSidebar: null,
      folder,
    };
  }
  if (command.kind === "delete_folder") {
    if (["inbox", "all"].includes(folder.role)) {
      throw Object.assign(new Error("Protected provider folders cannot be deleted"), { code: "PROTECTED_FOLDER" });
    }
    assertFolderAclRight(folder, "delete_folder");
    return { binding, runtime, path: folder.remote_path, newPath: null, subscribed: null, showInSidebar: null, folder };
  }
  const payload = subscriptionPayloadSchema.parse(parseJsonRecord(command.payload));
  return {
    binding,
    runtime,
    path: folder.remote_path,
    newPath: null,
    subscribed: payload.subscribed,
    showInSidebar: null,
    folder,
  };
};

const remoteFolderByPath = async (operation: PreparedFolderOperation) => {
  const folders = await imapSmtpConnector.discoverFolders(operation.runtime);
  return {
    current: folders.find((folder) => folder.path === operation.path) ?? null,
    replacement: operation.newPath ? (folders.find((folder) => folder.path === operation.newPath) ?? null) : null,
  };
};

const verifyEmptyFolderDelete = async (command: DbCommandExecution, operation: PreparedFolderOperation): Promise<void> => {
  if (!operation.folder?.selectable)
    throw Object.assign(new Error("Only selectable folders can be deleted"), { code: "FOLDER_NOT_SELECTABLE" });
  const [children] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM mail.folders child
    WHERE child.parent_id = ${operation.folder.folder_id}::uuid AND child.discovery_state = 'active'
  `;
  if ((children?.count ?? 0) > 0) throw Object.assign(new Error("Folder has child folders"), { code: "FOLDER_NOT_EMPTY" });
  const status = await imapSmtpConnector.getFolderStatus(operation.runtime, operation.path);
  if (status.messages > 0) throw Object.assign(new Error("Folder contains remote messages"), { code: "FOLDER_NOT_EMPTY" });
  await recordCommandTransportMetadata(command, { emptyFolderVerifiedAt: new Date().toISOString(), uidValidity: status.uidValidity });
};

const finishFolderOperation = async (
  command: DbCommandExecution,
  operation: PreparedFolderOperation,
  state: "confirmed" | "reconciled",
): Promise<void> => {
  let folderId: string | null = null;
  await persistMutationOutcome(async () => {
    const discovery = await rediscoverProviderBinding({ bindingId: command.selected_binding_id });
    if (command.kind !== "delete_folder") {
      const resolvedPath = operation.newPath ?? operation.path;
      const [resolvedFolder] = await sql<{ folder_id: string }[]>`
        SELECT ref.folder_id
        FROM mail.binding_folder_refs ref
        WHERE ref.binding_id = ${command.selected_binding_id}::uuid
          AND ref.remote_path = ${resolvedPath}
          AND ref.missing_since IS NULL
      `;
      folderId = resolvedFolder?.folder_id ?? null;
      if (command.kind === "create_folder" && folderId && operation.showInSidebar !== null) {
        await sql`
          UPDATE mail.folders
          SET show_in_sidebar = ${operation.showInSidebar}, updated_at = now()
          WHERE id = ${folderId}::uuid
        `;
      }
    }
    await recordCommandResult(command, {
      folderId,
      path: operation.path,
      newPath: operation.newPath,
      subscribed: operation.subscribed,
      showInSidebar: operation.showInSidebar,
      discoveryGeneration: discovery.discoveryGeneration,
    });
    await commandState(command, state);
  });
  await publishMailMailboxEvent({
    mailboxId: command.mailbox_id,
    conversationId: null,
    reason: "folder",
    targetId: folderId ?? operation.folder?.folder_id ?? null,
    activityId: `folder-command:${command.id}:${state}`,
  });
};

const executeFreshFolderOperation = async (
  command: DbCommandExecution,
  operation: PreparedFolderOperation,
  assertLeaseActive: LeaseAssertion,
  assertAuthorized: LeaseAssertion,
): Promise<void> => {
  await assertAuthorized();
  const before = await remoteFolderByPath(operation);
  if (command.kind === "create_folder") {
    if (before.current) throw Object.assign(new Error("A remote folder with this name already exists"), { code: "FOLDER_ALREADY_EXISTS" });
    await assertAuthorized();
    await beginProviderEffect(command);
    await imapSmtpConnector.createFolder(operation.runtime, operation.path, operation.subscribed === true);
  } else if (command.kind === "rename_folder") {
    if (!before.current) throw Object.assign(new Error("Remote folder no longer exists"), { code: "FOLDER_UNAVAILABLE" });
    if (before.replacement)
      throw Object.assign(new Error("A remote folder with the new name already exists"), { code: "FOLDER_ALREADY_EXISTS" });
    await assertAuthorized();
    await beginProviderEffect(command);
    await imapSmtpConnector.renameFolder(operation.runtime, operation.path, operation.newPath!);
  } else if (command.kind === "delete_folder") {
    if (!before.current) throw Object.assign(new Error("Remote folder no longer exists"), { code: "FOLDER_UNAVAILABLE" });
    await assertAuthorized();
    await verifyEmptyFolderDelete(command, operation);
    await assertAuthorized();
    await beginProviderEffect(command);
    await imapSmtpConnector.deleteFolder(operation.runtime, operation.path);
  } else {
    if (!before.current) throw Object.assign(new Error("Remote folder no longer exists"), { code: "FOLDER_UNAVAILABLE" });
    await assertAuthorized();
    await beginProviderEffect(command);
    await imapSmtpConnector.setFolderSubscription(operation.runtime, operation.path, operation.subscribed === true);
  }
  await recordCommandTransportMetadata(command, {
    remoteApplied: true,
    path: operation.path,
    newPath: operation.newPath,
    subscribed: operation.subscribed,
  });
  await assertLeaseActive();
  await finishFolderOperation(command, operation, "confirmed");
};

const reconcileFolderOperation = async (
  command: DbCommandExecution,
  operation: PreparedFolderOperation,
  assertLeaseActive: LeaseAssertion,
  assertAuthorized: LeaseAssertion,
): Promise<void> => {
  await assertAuthorized();
  let remote = await remoteFolderByPath(operation);
  if (command.kind === "create_folder" && remote.current && operation.subscribed === true && !remote.current.subscribed) {
    await assertAuthorized();
    await imapSmtpConnector.setFolderSubscription(operation.runtime, operation.path, true);
    await assertLeaseActive();
    remote = await remoteFolderByPath(operation);
  }
  const applied =
    command.kind === "create_folder"
      ? Boolean(remote.current) && (operation.subscribed !== true || remote.current?.subscribed === true)
      : command.kind === "rename_folder"
        ? !remote.current && Boolean(remote.replacement)
        : command.kind === "delete_folder"
          ? !remote.current
          : remote.current?.subscribed === operation.subscribed;
  if (applied) return finishFolderOperation(command, operation, "reconciled");
  const safelyRetryable =
    (command.kind === "create_folder" && !remote.current) ||
    (command.kind === "rename_folder" && Boolean(remote.current) && !remote.replacement) ||
    (command.kind === "delete_folder" && Boolean(remote.current)) ||
    (command.kind === "set_folder_subscription" && Boolean(remote.current));
  if (safelyRetryable) {
    await requeueCommand(
      command,
      "FOLDER_OPERATION_NOT_APPLIED",
      "Provider state shows that the idempotent folder operation can be retried",
    );
    return;
  }
  await commandState(
    command,
    "needs_attention",
    Object.assign(new Error("Remote folder outcome could not be proven"), { code: "AMBIGUOUS_FOLDER_OPERATION" }),
  );
};

const runFolderOperation = async (
  claimed: { command: DbCommandExecution; previousState: string },
  assertJobLeaseActive: LeaseAssertion,
): Promise<void> => {
  const { command } = claimed;
  if (!(await commandStillAuthorized(command, "admin"))) {
    await commandState(
      command,
      claimed.previousState === "ambiguous" ? "needs_attention" : "failed",
      Object.assign(new Error("Mailbox administration access was revoked before folder execution"), { code: "ACCESS_REVOKED" }),
    );
    return;
  }
  const operation = await prepareFolderOperation(command);
  const lock = await mailProviderOperationMutex().acquire({
    resource: operation.binding.remote_resource_id,
    ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS,
  });
  if (!lock) {
    await requeueCommand(command, "REMOTE_RESOURCE_BUSY", "Remote mailbox is currently being synchronized or administered");
    return;
  }
  try {
    await withLeaseHeartbeat({
      intervalMs: JOB_HEARTBEAT_INTERVAL_MS,
      heartbeat: async () => {
        await assertJobLeaseActive();
        if (!(await mailProviderOperationMutex().extend(lock, { ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS }))) {
          throw Object.assign(new Error("Remote mailbox operation lease was lost"), { code: "COMMAND_JOB_LEASE_LOST" });
        }
      },
      work: async (assertHeartbeatActive, signal) => {
        const assertLeaseActive = async (): Promise<void> => {
          await assertHeartbeatActive();
          await assertJobLeaseActive();
          if (!(await mailProviderOperationMutex().extend(lock, { ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS }))) {
            throw Object.assign(new Error("Remote mailbox operation lease was lost"), { code: "COMMAND_JOB_LEASE_LOST" });
          }
        };
        const assertAuthorized = async (): Promise<void> => {
          await assertLeaseActive();
          if (!(await commandStillAuthorized(command, "admin"))) {
            throw Object.assign(new Error("Mailbox administration access was revoked before provider execution"), {
              code: "ACCESS_REVOKED",
            });
          }
        };
        await waitForMailProviderSlot(operation.binding.remote_resource_id, signal);
        await assertLeaseActive();
        if (claimed.previousState === "ambiguous") {
          await reconcileFolderOperation(command, operation, assertLeaseActive, assertAuthorized);
        } else {
          await executeFreshFolderOperation(command, operation, assertLeaseActive, assertAuthorized);
        }
      },
    });
  } finally {
    await mailProviderOperationMutex()
      .release(lock)
      .catch(() => false);
  }
};

const runMessageMutation = async (
  claimed: { command: DbCommandExecution; previousState: string },
  assertJobLeaseActive: LeaseAssertion,
): Promise<void> => {
  if (await hasEarlierActiveMessageMutation(claimed.command.id)) {
    await requeueCommand(claimed.command, "MESSAGE_MUTATION_PREDECESSOR_ACTIVE", "An earlier change to this message is still pending");
    return;
  }
  const binding = await loadPinnedBinding(claimed.command);
  const lock = await mailProviderOperationMutex().acquire({
    resource: binding.remote_resource_id,
    ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS,
  });
  if (!lock) {
    await requeueCommand(claimed.command, "REMOTE_RESOURCE_BUSY", "Remote mailbox is currently being synchronized or changed");
    return;
  }
  try {
    await withLeaseHeartbeat({
      intervalMs: JOB_HEARTBEAT_INTERVAL_MS,
      heartbeat: async () => {
        await assertJobLeaseActive();
        if (!(await mailProviderOperationMutex().extend(lock, { ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS }))) {
          throw Object.assign(new Error("Remote mailbox operation lease was lost"), { code: "COMMAND_JOB_LEASE_LOST" });
        }
      },
      work: async (assertMutexLeaseActive, signal) => {
        const assertLeaseActive = async (): Promise<void> => {
          await assertJobLeaseActive();
          await assertMutexLeaseActive();
        };
        await waitForMailProviderSlot(binding.remote_resource_id, signal);
        await assertLeaseActive();
        if (claimed.previousState === "ambiguous") await reconcileMutation(claimed.command);
        else await executeFreshMutation(claimed.command, assertLeaseActive);
      },
    });
  } finally {
    await mailProviderOperationMutex()
      .release(lock)
      .catch(() => false);
  }
};

const runClaimedMutation = async (
  claimed: { command: DbCommandExecution; previousState: string },
  assertLeaseActive: LeaseAssertion,
): Promise<CommandState | null> => {
  try {
    if (claimed.previousState === "ambiguous" && claimed.command.attempt >= 5) {
      await commandState(
        claimed.command,
        "needs_attention",
        Object.assign(new Error("Remote mutation outcome could not be reconciled after repeated attempts"), {
          code: "AMBIGUOUS_RECONCILIATION_EXHAUSTED",
        }),
      );
    } else if (isFolderCommandKind(claimed.command.kind)) {
      await runFolderOperation(claimed, assertLeaseActive);
    } else {
      await runMessageMutation(claimed, assertLeaseActive);
    }
  } catch (error) {
    const providerEffectStarted = await providerEffectStartedForAttempt(claimed.command).catch(() => true);
    await commandState(claimed.command, mutationFailureState(error, providerEffectStarted), error);
  }
  const [state] = await sql<{ state: CommandState }[]>`
    SELECT state FROM mail.commands WHERE id = ${claimed.command.id}::uuid
  `;
  return state?.state ?? null;
};

const executeMutationCommandWithHeartbeat = async (
  commandId: string,
  heartbeat?: (fence: { id: string; attempt: number }) => Promise<void>,
): Promise<CommandState | null> => {
  const claimed = await claimCommand(commandId, ["set_flags", "change_message_state", "move", "copy", "delete", ...FOLDER_COMMAND_KINDS]);
  if (!claimed) return null;
  const work = (assertLeaseActive: LeaseAssertion) => runClaimedMutation(claimed, assertLeaseActive);
  if (!heartbeat) return work(noLeaseAssertion);
  return withLeaseHeartbeat({
    intervalMs: JOB_HEARTBEAT_INTERVAL_MS,
    heartbeat: () => heartbeat(claimed.command),
    work,
  });
};

export const executeMutationCommand = async (commandId: string): Promise<CommandState | null> =>
  executeMutationCommandWithHeartbeat(commandId);

type DbOutboxExecution = {
  id: string;
  mailbox_id: string;
  draft_id: string;
  command_id: string;
  sender_identity_id: string;
  selected_binding_id: string;
  selected_identity_transport_revision: number | null;
  stable_message_id: string;
  state: string;
  scheduled_at: Date | string;
  undo_until: Date | string | null;
  draft_snapshot: JsonRecord | string;
  mime_blob_id: string | null;
  mime_date: Date | string;
  attempt: number;
  created_at: Date | string;
};

type DbOutboxExecutionRow = DbOutboxExecution & {
  command_mailbox_id: string;
  command_kind: DbCommandExecution["kind"];
  command_state: DbCommandExecution["state"];
  command_actor_kind: DbCommandExecution["actor_kind"];
  command_actor_id: string | null;
  command_correlation_id: string | null;
  command_workflow_execution_generation: string | number | null;
  command_initiator_actor_kind: DbCommandExecution["initiator_actor_kind"];
  command_initiator_actor_id: string | null;
  command_access_subject_kind: DbCommandExecution["access_subject_kind"];
  command_access_subject_id: string | null;
  command_credential_scopes: string[] | null;
  command_credential_id: string | null;
  command_credential_expires_at: Date | string | null;
  command_target: JsonRecord | string;
  command_payload: JsonRecord | string;
  command_transport_metadata: JsonRecord | string;
  command_selected_binding_id: string;
  command_selected_secret_revision: number;
  command_attempt: number;
};

type DbSenderBinding = {
  saves_sent_automatically: boolean;
  automation_policy: "disabled" | "mailbox";
  sent_folder_id: string | null;
  sent_path: string | null;
  sent_rights: string[] | null;
};

const loadOutbox = async (outboxId: string): Promise<{ outbox: DbOutboxExecution; command: DbCommandExecution } | null> => {
  const [row] = await sql<DbOutboxExecutionRow[]>`
    SELECT
      o.id,
      o.mailbox_id,
      o.draft_id,
      o.command_id,
      o.sender_identity_id,
      o.selected_binding_id,
      o.selected_identity_transport_revision,
      o.stable_message_id,
      o.state,
      o.scheduled_at,
      o.undo_until,
      o.draft_snapshot,
      o.mime_blob_id,
      o.mime_date,
      o.attempt,
      o.created_at,
      c.mailbox_id AS command_mailbox_id,
      c.kind AS command_kind,
      c.state AS command_state,
      c.actor_kind AS command_actor_kind,
      c.actor_id AS command_actor_id,
      c.correlation_id AS command_correlation_id,
      c.workflow_execution_generation AS command_workflow_execution_generation,
      c.initiator_actor_kind AS command_initiator_actor_kind,
      c.initiator_actor_id AS command_initiator_actor_id,
      c.access_subject_kind AS command_access_subject_kind,
      c.access_subject_id AS command_access_subject_id,
      c.credential_scopes AS command_credential_scopes,
      c.credential_id AS command_credential_id,
      c.credential_expires_at AS command_credential_expires_at,
      c.target AS command_target,
      c.payload AS command_payload,
      c.transport_metadata AS command_transport_metadata,
      c.selected_binding_id AS command_selected_binding_id,
      c.selected_secret_revision AS command_selected_secret_revision,
      c.attempt AS command_attempt
    FROM mail.outbox_submissions o
    JOIN mail.commands c
      ON c.id = o.command_id
     AND c.mailbox_id = o.mailbox_id
     AND c.selected_binding_id = o.selected_binding_id
    WHERE o.id = ${outboxId}::uuid
  `;
  if (!row) return null;
  return {
    outbox: {
      id: row.id,
      mailbox_id: row.mailbox_id,
      draft_id: row.draft_id,
      command_id: row.command_id,
      sender_identity_id: row.sender_identity_id,
      selected_binding_id: row.selected_binding_id,
      selected_identity_transport_revision: row.selected_identity_transport_revision,
      stable_message_id: row.stable_message_id,
      state: row.state,
      scheduled_at: row.scheduled_at,
      undo_until: row.undo_until,
      draft_snapshot: row.draft_snapshot,
      mime_blob_id: row.mime_blob_id,
      mime_date: row.mime_date,
      attempt: row.attempt,
      created_at: row.created_at,
    },
    command: {
      id: row.command_id,
      mailbox_id: row.command_mailbox_id,
      kind: row.command_kind,
      state: row.command_state,
      actor_kind: row.command_actor_kind,
      actor_id: row.command_actor_id,
      correlation_id: row.command_correlation_id,
      workflow_execution_generation: row.command_workflow_execution_generation,
      initiator_actor_kind: row.command_initiator_actor_kind,
      initiator_actor_id: row.command_initiator_actor_id,
      access_subject_kind: row.command_access_subject_kind,
      access_subject_id: row.command_access_subject_id,
      credential_scopes: row.command_credential_scopes,
      credential_id: row.command_credential_id,
      credential_expires_at: row.command_credential_expires_at,
      target: row.command_target,
      payload: row.command_payload,
      transport_metadata: row.command_transport_metadata,
      selected_binding_id: row.command_selected_binding_id,
      selected_secret_revision: row.command_selected_secret_revision,
      attempt: Number(row.command_attempt),
    },
  };
};

const lockOutboxFence = async (db: SqlClient, outbox: DbOutboxExecution, command: DbCommandExecution): Promise<boolean> => {
  const [active] = await db<{ id: string }[]>`
    SELECT o.id
    FROM mail.outbox_submissions o
    JOIN mail.commands c ON c.id = o.command_id
    WHERE o.id = ${outbox.id}::uuid
      AND o.attempt = ${outbox.attempt}
      AND o.state = ${outbox.state}
      AND c.id = ${command.id}::uuid
      AND c.attempt = ${command.attempt}
      AND c.state = ${command.state}
    FOR UPDATE OF o, c
  `;
  return Boolean(active);
};

const staleWorkerFence = (): Error => Object.assign(new Error("Mail worker execution fence is stale"), { code: "STALE_COMMAND_FENCE" });

const heartbeatCommandFence = async (fence: { id: string; attempt: number }): Promise<void> => {
  await sql.begin(async (tx) => {
    const [current] = await tx<{ attempt: number; state: string }[]>`
      SELECT attempt, state
      FROM mail.commands
      WHERE id = ${fence.id}::uuid
      FOR UPDATE
    `;
    if (!current || current.attempt !== fence.attempt || current.state !== "executing") throw staleWorkerFence();
    await tx`
      UPDATE mail.commands
      SET worker_heartbeat_at = now(), updated_at = now()
      WHERE id = ${fence.id}::uuid
    `;
  });
};

const heartbeatOutboxFence = async (loaded: { outbox: DbOutboxExecution; command: DbCommandExecution }): Promise<void> => {
  await sql.begin(async (tx) => {
    const [current] = await tx<
      {
        outbox_attempt: number;
        outbox_state: string;
        command_attempt: number;
        command_state: string;
      }[]
    >`
      SELECT
        o.attempt AS outbox_attempt,
        o.state AS outbox_state,
        c.attempt AS command_attempt,
        c.state AS command_state
      FROM mail.outbox_submissions o
      JOIN mail.commands c ON c.id = o.command_id
      WHERE o.id = ${loaded.outbox.id}::uuid
        AND c.id = ${loaded.command.id}::uuid
      FOR UPDATE OF o, c
    `;
    if (!current || current.outbox_attempt !== loaded.outbox.attempt || current.command_attempt !== loaded.command.attempt) {
      throw staleWorkerFence();
    }
    if (current.outbox_state !== loaded.outbox.state || current.command_state !== loaded.command.state) throw staleWorkerFence();
    if (current.command_state === "executing") {
      await tx`
        UPDATE mail.commands
        SET worker_heartbeat_at = now(), updated_at = now()
        WHERE id = ${loaded.command.id}::uuid
      `;
    }
    await tx`
      UPDATE mail.outbox_submissions
      SET updated_at = now()
      WHERE id = ${loaded.outbox.id}::uuid
    `;
  });
};

type OutboxClaim = {
  previousOutboxState: string;
  previousOutboxAttempt: number;
  previousOutboxErrorCode: string | null;
  previousOutboxErrorMessage: string | null;
  claimedOutboxState: string;
  claimedOutboxAttempt: number;
  previousCommandState: string;
  previousCommandAttempt: number;
  previousCommandStartedAt: Date | string | null;
  previousCommandFinishedAt: Date | string | null;
  previousCommandHeartbeatAt: Date | string | null;
  previousCommandErrorCode: string | null;
  previousCommandErrorMessage: string | null;
  claimedCommandState: string;
  claimedCommandAttempt: number;
  draftId: string;
  previousDraftState: string;
};

const claimOutbox = async (outboxId: string): Promise<OutboxClaim | null> =>
  sql.begin(async (tx) => {
    const [current] = await tx<
      {
        state: string;
        attempt: number;
        last_error_code: string | null;
        last_error_message: string | null;
        command_id: string;
        command_state: string;
        command_attempt: number;
        command_started_at: Date | string | null;
        command_finished_at: Date | string | null;
        command_heartbeat_at: Date | string | null;
        command_error_code: string | null;
        command_error_message: string | null;
        draft_id: string;
        draft_state: string;
        due: boolean;
      }[]
    >`
      SELECT
        o.state,
        o.attempt,
        o.last_error_code,
        o.last_error_message,
        o.command_id,
        c.state AS command_state,
        c.attempt AS command_attempt,
        c.started_at AS command_started_at,
        c.finished_at AS command_finished_at,
        c.worker_heartbeat_at AS command_heartbeat_at,
        c.last_error_code AS command_error_code,
        c.last_error_message AS command_error_message,
        d.id AS draft_id,
        d.state AS draft_state,
        GREATEST(o.scheduled_at, COALESCE(o.undo_until, o.scheduled_at)) <= now() AS due
      FROM mail.outbox_submissions o
      JOIN mail.commands c ON c.id = o.command_id
      JOIN mail.drafts d ON d.id = o.draft_id
      WHERE o.id = ${outboxId}::uuid
      FOR UPDATE OF o, c, d
    `;
    if (!current || !["scheduled", "undo_window", "unknown", "sent_sync_pending"].includes(current.state)) return null;
    if (
      ((current.state === "scheduled" || current.state === "undo_window") && current.command_state !== "queued") ||
      (current.state === "unknown" && current.command_state !== "ambiguous") ||
      (current.state === "sent_sync_pending" && current.command_state !== "confirmed")
    ) {
      return null;
    }
    if ((current.state === "scheduled" || current.state === "undo_window") && !current.due) return null;
    const previousOutboxState = current.state;
    const claimedOutboxState = current.state === "sent_sync_pending" ? "accepted" : current.state === "unknown" ? "unknown" : "sending";
    const claimedCommandState = current.state === "sent_sync_pending" ? current.command_state : "executing";
    const claimedOutboxAttempt = current.attempt + 1;
    const claimedCommandAttempt = current.command_attempt + (current.state === "sent_sync_pending" ? 0 : 1);
    if (current.state === "scheduled" || current.state === "undo_window") {
      await tx`
        UPDATE mail.outbox_submissions
        SET state = 'sending', attempt = attempt + 1, last_error_code = NULL, last_error_message = NULL, updated_at = now()
        WHERE id = ${outboxId}::uuid
      `;
      await tx`
        UPDATE mail.commands
        SET
          state = 'executing',
          attempt = attempt + 1,
          started_at = now(),
          worker_heartbeat_at = now(),
          finished_at = NULL,
          updated_at = now()
        WHERE id = ${current.command_id}::uuid AND state = 'queued'
      `;
      await tx`UPDATE mail.drafts SET state = 'sending' WHERE id = (SELECT draft_id FROM mail.outbox_submissions WHERE id = ${outboxId}::uuid)`;
    } else if (current.state === "unknown") {
      await tx`
        UPDATE mail.outbox_submissions
        SET attempt = attempt + 1, updated_at = now()
        WHERE id = ${outboxId}::uuid AND state = 'unknown'
      `;
      await tx`
        UPDATE mail.commands
        SET
          state = 'executing',
          attempt = attempt + 1,
          started_at = now(),
          worker_heartbeat_at = now(),
          finished_at = NULL,
          updated_at = now()
        WHERE id = ${current.command_id}::uuid AND state = 'ambiguous'
      `;
    } else if (current.state === "sent_sync_pending") {
      await tx`
        UPDATE mail.outbox_submissions
        SET state = 'accepted', attempt = attempt + 1, last_error_code = NULL, last_error_message = NULL, updated_at = now()
        WHERE id = ${outboxId}::uuid AND state = 'sent_sync_pending'
      `;
    }
    return {
      previousOutboxState,
      previousOutboxAttempt: current.attempt,
      previousOutboxErrorCode: current.last_error_code,
      previousOutboxErrorMessage: current.last_error_message,
      claimedOutboxState,
      claimedOutboxAttempt,
      previousCommandState: current.command_state,
      previousCommandAttempt: current.command_attempt,
      previousCommandStartedAt: current.command_started_at,
      previousCommandFinishedAt: current.command_finished_at,
      previousCommandHeartbeatAt: current.command_heartbeat_at,
      previousCommandErrorCode: current.command_error_code,
      previousCommandErrorMessage: current.command_error_message,
      claimedCommandState,
      claimedCommandAttempt,
      draftId: current.draft_id,
      previousDraftState: current.draft_state,
    };
  });

const resetUnstartedOutboxClaim = async (outboxId: string, claim: OutboxClaim): Promise<boolean> =>
  sql.begin(async (tx) => {
    const [current] = await tx<{ provider_effect_attempt: number | null }[]>`
      SELECT c.provider_effect_attempt
      FROM mail.outbox_submissions o
      JOIN mail.commands c ON c.id = o.command_id
      JOIN mail.drafts d ON d.id = o.draft_id
      WHERE o.id = ${outboxId}::uuid
        AND o.state = ${claim.claimedOutboxState}
        AND o.attempt = ${claim.claimedOutboxAttempt}
        AND c.state = ${claim.claimedCommandState}
        AND c.attempt = ${claim.claimedCommandAttempt}
        AND d.id = ${claim.draftId}::uuid
      FOR UPDATE OF o, c, d
    `;
    if (!current) return false;
    if (
      (claim.previousOutboxState === "scheduled" || claim.previousOutboxState === "undo_window") &&
      current.provider_effect_attempt === claim.claimedCommandAttempt
    ) {
      return false;
    }
    await tx`
      UPDATE mail.outbox_submissions
      SET
        state = ${claim.previousOutboxState},
        attempt = ${claim.previousOutboxAttempt},
        last_error_code = ${claim.previousOutboxErrorCode},
        last_error_message = ${claim.previousOutboxErrorMessage},
        updated_at = now()
      WHERE id = ${outboxId}::uuid
    `;
    await tx`
      UPDATE mail.commands
      SET
        state = ${claim.previousCommandState},
        attempt = ${claim.previousCommandAttempt},
        started_at = ${claim.previousCommandStartedAt},
        finished_at = ${claim.previousCommandFinishedAt},
        worker_heartbeat_at = ${claim.previousCommandHeartbeatAt},
        last_error_code = ${claim.previousCommandErrorCode},
        last_error_message = ${claim.previousCommandErrorMessage},
        updated_at = now()
      WHERE id = (SELECT command_id FROM mail.outbox_submissions WHERE id = ${outboxId}::uuid)
    `;
    await tx`
      UPDATE mail.drafts
      SET state = ${claim.previousDraftState}, updated_at = now()
      WHERE id = ${claim.draftId}::uuid
    `;
    return true;
  });

const publishOutboundSubmissionChange = async (params: {
  outboxId: string;
  state: string;
  attempt: number;
  activityId?: string | null;
}): Promise<void> => {
  try {
    const projection = await loadOutboundProjectionByOutbox(sql, params.outboxId);
    if (!projection) return;
    await publishMailCollaborationEvent({
      mailboxId: projection.mailboxId,
      conversationId: projection.conversationId,
      reason: "outbound",
      targetId: projection.messageId,
      activityId: params.activityId ?? `outbound-state:${params.outboxId}:${params.attempt}:${params.state}`,
    });
  } catch (error) {
    log.warn("Failed to publish outbound message state", {
      outboxId: params.outboxId,
      state: params.state,
      code: normalizeCode(error, "OUTBOUND_STATE_EVENT_FAILED"),
    });
  }
};

const loadSenderBinding = async (command: DbCommandExecution, senderIdentityId: string): Promise<DbSenderBinding> => {
  const [sender] = await sql<DbSenderBinding[]>`
    SELECT
      sib.saves_sent_automatically,
      si.automation_policy,
      si.sent_folder_id,
      sent_ref.remote_path AS sent_path,
      sent_ref.effective_rights AS sent_rights
    FROM mail.sender_identities si
    JOIN mail.sender_identity_bindings sib
      ON sib.sender_identity_id = si.id
     AND sib.binding_id = ${command.selected_binding_id}::uuid
     AND sib.verified_secret_revision = ${command.selected_secret_revision}
     AND sib.revoked_at IS NULL
    LEFT JOIN mail.binding_folder_refs sent_ref
      ON sent_ref.binding_id = sib.binding_id
     AND sent_ref.folder_id = si.sent_folder_id
    WHERE si.id = ${senderIdentityId}::uuid
      AND si.mailbox_id = ${command.mailbox_id}::uuid
      AND si.status = 'verified'
  `;
  if (!sender)
    throw Object.assign(new Error("Sender identity is no longer verified on the pinned binding"), { code: "SENDER_IDENTITY_UNAVAILABLE" });
  if (command.actor_kind === "workflow" && sender.automation_policy !== "mailbox") {
    throw Object.assign(new Error("Sender identity no longer permits mailbox automation"), { code: "AUTOMATION_SENDER_DISABLED" });
  }
  if (!sender.saves_sent_automatically) {
    if (!sender.sent_folder_id || !sender.sent_path || !sender.sent_rights?.includes("insert")) {
      throw Object.assign(new Error("Sent folder append rights are no longer available"), { code: "SENT_FOLDER_UNAVAILABLE" });
    }
  }
  return sender;
};

const ensureMimeBlob = async (
  outbox: DbOutboxExecution,
): Promise<{ blobId: string; byteLength: number; snapshot: z.infer<typeof outboundDraftSnapshotSchema> }> => {
  const snapshot = outboundDraftSnapshotSchema.parse(parseJsonRecord(outbox.draft_snapshot));
  if (outbox.mime_blob_id) {
    const blob = await getStoredBlob(outbox.mime_blob_id);
    return { blobId: blob.id, byteLength: blob.byteLength, snapshot };
  }
  const source = buildMimeStream({
    snapshot,
    messageId: outbox.stable_message_id,
    date: new Date(outbox.mime_date),
    openAttachment: createBlobReadable,
  });
  const blob = await storeReadableBlob(source);
  const [updated] = await sql<{ mime_blob_id: string }[]>`
    UPDATE mail.outbox_submissions
    SET mime_blob_id = COALESCE(mime_blob_id, ${blob.id}::uuid), updated_at = now()
    WHERE id = ${outbox.id}::uuid
      AND attempt = ${outbox.attempt}
      AND state = ${outbox.state}
    RETURNING mime_blob_id
  `;
  if (!updated) throw Object.assign(new Error("Outbox execution fence is stale"), { code: "STALE_COMMAND_FENCE" });
  const selected = updated.mime_blob_id === blob.id ? blob : await getStoredBlob(updated.mime_blob_id);
  return { blobId: selected.id, byteLength: selected.byteLength, snapshot };
};

type ConfirmedSendWorkStateEvent = { conversationId: string; activityId: string };

const applyConfirmedSendWorkState = async (params: {
  db: SqlClient;
  outbox: DbOutboxExecution;
  command: DbCommandExecution;
}): Promise<ConfirmedSendWorkStateEvent | null> => {
  const [draft] = await params.db<
    {
      conversation_id: string | null;
      intent: "new" | "reply" | "reply_all" | "forward";
      delivery_class: "standard" | "automatic_reply";
      work_status: "needs_action" | "waiting" | "done" | null;
    }[]
  >`
    SELECT draft.conversation_id, draft.intent, draft.delivery_class, conversation.work_status
    FROM mail.drafts draft
    JOIN mail.conversations conversation ON conversation.id = draft.conversation_id
    WHERE draft.id = ${params.outbox.draft_id}::uuid
    FOR UPDATE OF conversation
  `;
  if (!draft?.conversation_id || !draft.work_status) return null;

  const transition = deriveConversationWorkState(draft.work_status, {
    direction: "outbound",
    intent: draft.intent,
    automatic: draft.delivery_class === "automatic_reply" || params.command.actor_kind === "workflow",
  });
  if (transition.workStatus === draft.work_status) return null;

  const [conversation] = await params.db<{ revision: string | number }[]>`
    UPDATE mail.conversations
    SET work_status = ${transition.workStatus}, revision = revision + 1, updated_at = now()
    WHERE id = ${draft.conversation_id}::uuid AND mailbox_id = ${params.command.mailbox_id}::uuid
    RETURNING revision
  `;
  if (!conversation) throw new Error("Sent draft conversation disappeared during state transition");
  const [activity] = await params.db<{ id: string | number }[]>`
    INSERT INTO mail.activity_events (
      mailbox_id, conversation_id, command_id, actor_kind, actor_id,
      action, outcome, target_type, target_id, metadata
    ) VALUES (
      ${params.command.mailbox_id}::uuid,
      ${draft.conversation_id}::uuid,
      ${params.command.id}::uuid,
      ${params.command.actor_kind},
      ${params.command.actor_id}::uuid,
      'conversation.work_state_changed',
      'confirmed',
      'conversation',
      ${draft.conversation_id}::uuid,
      ${{
        source: "confirmed_send",
        intent: draft.intent,
        before: { workStatus: draft.work_status },
        after: { workStatus: transition.workStatus, revision: Number(conversation.revision) },
      }}::jsonb
    )
    RETURNING id
  `;
  if (!activity) throw new Error("Sent draft state transition activity insert returned no row");
  return { conversationId: draft.conversation_id, activityId: String(activity.id) };
};

const finishOutbox = async (params: {
  outbox: DbOutboxExecution;
  command: DbCommandExecution;
  outboxState: string;
  commandState: CommandState;
  draftState: "draft" | "sent";
  providerResponse?: JsonRecord;
  error?: unknown;
}): Promise<boolean> => {
  const code = params.error ? normalizeCode(params.error, "MAIL_SEND_FAILED") : null;
  const message = params.error ? errorMessage(params.error, "Mail send failed") : null;
  const result = await sql.begin(async (tx) => {
    if (!(await lockOutboxFence(tx, params.outbox, params.command))) return { updated: false, transition: null };
    await tx`
      UPDATE mail.outbox_submissions
      SET
        state = ${params.outboxState},
        accepted_at = CASE WHEN ${params.outboxState} IN ('accepted', 'sent_sync_pending', 'sent', 'reconciled_accepted') THEN COALESCE(accepted_at, now()) ELSE accepted_at END,
        provider_response = provider_response || ${params.providerResponse ?? {}}::jsonb,
        last_error_code = ${code},
        last_error_message = ${message},
        updated_at = now()
      WHERE id = ${params.outbox.id}::uuid
    `;
    await tx`
      UPDATE mail.commands
      SET
        state = ${params.commandState},
        finished_at = CASE WHEN ${params.commandState} IN ('confirmed', 'failed', 'cancelled', 'reconciled', 'needs_attention') THEN now() ELSE NULL END,
        worker_heartbeat_at = NULL,
        last_error_code = ${code},
        last_error_message = ${message},
        updated_at = now()
      WHERE id = ${params.outbox.command_id}::uuid
    `;
    await tx`UPDATE mail.drafts SET state = ${params.draftState} WHERE id = ${params.outbox.draft_id}::uuid`;
    await tx`
      UPDATE mail.automatic_reply_effects
      SET
        state = CASE
          WHEN ${params.commandState} IN ('confirmed', 'reconciled') THEN 'confirmed'
          WHEN ${params.commandState} IN ('ambiguous', 'needs_attention') THEN 'needs_attention'
          ELSE 'failed'
        END,
        confirmed_at = CASE
          WHEN ${params.commandState} IN ('confirmed', 'reconciled') THEN COALESCE(confirmed_at, now())
          ELSE confirmed_at
        END
      WHERE command_id = ${params.outbox.command_id}::uuid
    `;
    await tx`
      INSERT INTO mail.activity_events (
        mailbox_id, command_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
      )
      SELECT
        c.mailbox_id,
        c.id,
        c.actor_kind,
        c.actor_id,
        'command.send',
        ${params.commandState === "confirmed" || params.commandState === "reconciled" ? "confirmed" : "failed"},
        'outbox_submission',
        ${params.outbox.id}::uuid,
        ${{
          outboxState: params.outboxState,
          commandState: params.commandState,
          code,
          scheduledAt: parseJsonRecord(params.command.payload).scheduledAt ?? null,
        }}::jsonb
      FROM mail.commands c
      WHERE c.id = ${params.outbox.command_id}::uuid
    `;
    if (params.commandState !== "confirmed" && params.commandState !== "reconciled") {
      return { updated: true, transition: null };
    }

    return {
      updated: true,
      transition: await applyConfirmedSendWorkState({ db: tx, outbox: params.outbox, command: params.command }),
    };
  });
  if (result.updated) {
    await publishOutboundSubmissionChange({
      outboxId: params.outbox.id,
      state: params.outboxState,
      attempt: params.outbox.attempt,
      activityId: result.transition?.activityId,
    });
  }
  if (result.updated && typeof parseJsonRecord(params.command.payload).scheduledAt === "string") {
    await publishMailMailboxEvent({
      mailboxId: params.command.mailbox_id,
      conversationId: null,
      reason: "scheduled_send",
      targetId: params.outbox.id,
      activityId: `scheduled-send-state:${params.outbox.id}:${params.outbox.attempt}:${params.outboxState}`,
    });
  }
  if (result.updated && ["confirmed", "failed", "cancelled", "reconciled", "needs_attention"].includes(params.commandState)) {
    await publishMailWorkflowDependency({
      mailboxId: params.command.mailbox_id,
      dependency: { kind: "mail.command", key: params.command.id },
    });
  }
  return result.updated;
};

const isRetryablePreDispatchError = (error: unknown): boolean => {
  if (isAmbiguousTransportError(error)) return true;
  const code = normalizeCode(error, "");
  return code.startsWith("08") || ["40001", "40P01", "53300", "57P01", "57P03", "COMMAND_JOB_LEASE_LOST"].includes(code);
};

const scheduleOutboxRetry = async (params: {
  outbox: DbOutboxExecution;
  command: DbCommandExecution;
  error: unknown;
  code: string;
  fallbackMessage: string;
}): Promise<void> => {
  const delaySeconds = Math.min(15 * 60, 15 * 2 ** Math.max(0, params.outbox.attempt));
  const updated = await sql.begin(async (tx) => {
    if (!(await lockOutboxFence(tx, params.outbox, params.command))) return false;
    await tx`
      UPDATE mail.outbox_submissions
      SET
        state = 'scheduled',
        scheduled_at = now() + (${delaySeconds}::text || ' seconds')::interval,
        undo_until = NULL,
        last_error_code = ${params.code},
        last_error_message = ${errorMessage(params.error, params.fallbackMessage)},
        updated_at = now()
      WHERE id = ${params.outbox.id}::uuid
    `;
    await tx`
      UPDATE mail.commands
      SET
        state = 'queued',
        worker_heartbeat_at = NULL,
        last_error_code = ${params.code},
        last_error_message = ${errorMessage(params.error, params.fallbackMessage)},
        updated_at = now()
      WHERE id = ${params.command.id}::uuid
    `;
    await tx`UPDATE mail.drafts SET state = 'scheduled' WHERE id = ${params.outbox.draft_id}::uuid`;
    return true;
  });
  if (updated) {
    await publishOutboundSubmissionChange({
      outboxId: params.outbox.id,
      state: "scheduled",
      attempt: params.outbox.attempt,
    });
  }
  if (updated && typeof parseJsonRecord(params.command.payload).scheduledAt === "string") {
    await publishMailMailboxEvent({
      mailboxId: params.command.mailbox_id,
      conversationId: null,
      reason: "scheduled_send",
      targetId: params.outbox.id,
      activityId: `scheduled-send-retry:${params.outbox.id}:${params.outbox.attempt}`,
    });
  }
};

const sentMatches = async (params: {
  runtime: Awaited<ReturnType<typeof loadProviderConnectionRuntime>>;
  sentPath: string | null;
  messageId: string;
  signal?: AbortSignal;
}): Promise<number[]> =>
  params.sentPath ? imapSmtpConnector.findMessageById(params.runtime, params.sentPath, params.messageId, params.signal) : [];

const appendSentCopy = async (params: {
  outbox: DbOutboxExecution;
  sender: DbSenderBinding;
  runtime: Awaited<ReturnType<typeof loadProviderConnectionRuntime>>;
  mimeBlobId: string;
  mimeByteLength: number;
  assertLeaseActive: LeaseAssertion;
  signal: AbortSignal;
}): Promise<boolean> => {
  if (params.sender.saves_sent_automatically) return true;
  if (!params.sender.sent_path) return false;
  const existing = await sentMatches({
    runtime: params.runtime,
    sentPath: params.sender.sent_path,
    messageId: params.outbox.stable_message_id,
    signal: params.signal,
  });
  if (existing.length > 0) return true;
  await params.assertLeaseActive();
  try {
    await imapSmtpConnector.appendSource(
      params.runtime,
      params.sender.sent_path,
      createBlobReadable(params.mimeBlobId),
      params.mimeByteLength,
      ["\\Seen"],
      new Date(params.outbox.created_at),
      params.signal,
    );
    await params.assertLeaseActive();
  } catch (error) {
    const reconciled = await sentMatches({
      runtime: params.runtime,
      sentPath: params.sender.sent_path,
      messageId: params.outbox.stable_message_id,
    }).catch(() => []);
    if (reconciled.length > 0) return true;
    log.warn("Sent copy append remains pending", { outboxId: params.outbox.id, code: normalizeCode(error, "SENT_APPEND_FAILED") });
    return false;
  }
  const confirmed = await sentMatches({
    runtime: params.runtime,
    sentPath: params.sender.sent_path,
    messageId: params.outbox.stable_message_id,
    signal: params.signal,
  });
  return confirmed.length > 0;
};

const prepareFreshOutbox = async (
  outbox: DbOutboxExecution,
  command: DbCommandExecution,
  assertLeaseActive: LeaseAssertion,
  signal: AbortSignal,
): Promise<{
  sender: DbSenderBinding;
  mailboxRuntime: Awaited<ReturnType<typeof loadProviderConnectionRuntime>>;
  sendRuntime: SmtpConnectionConfig;
  mimeBlobId: string;
  mimeByteLength: number;
  snapshot: z.infer<typeof outboundDraftSnapshotSchema>;
  alreadySent: boolean;
}> => {
  const sender = await loadSenderBinding(command, outbox.sender_identity_id);
  const mailboxRuntime = await loadPinnedRuntime(await loadPinnedBinding(command));
  const customTransport =
    outbox.selected_identity_transport_revision === null
      ? null
      : await loadSenderIdentityTransportRuntimeById({
          mailboxId: outbox.mailbox_id,
          senderIdentityId: outbox.sender_identity_id,
          expectedRevision: outbox.selected_identity_transport_revision,
        });
  if (outbox.selected_identity_transport_revision !== null && !customTransport) {
    throw Object.assign(new Error("The selected identity SMTP transport is no longer available"), {
      code: "IDENTITY_TRANSPORT_CHANGED",
    });
  }
  const sendRuntime = customTransport?.runtime ?? mailboxRuntime;
  const mime = await ensureMimeBlob(outbox);
  const providerLimits = await loadBindingProviderLimits(sql, outbox.selected_binding_id);
  const smtpLimit =
    customTransport === null
      ? providerLimits
        ? activeSmtpMessageLimit(providerLimits)
        : null
      : customTransport.capabilities.maxMessageBytes;
  assertProviderMessageSize(mime.byteLength, smtpLimit);
  if (mime.snapshot.requestDeliveryReceipt) {
    const supportsDsn = customTransport?.capabilities.dsn ?? providerLimits?.smtp.dsn === true;
    if (!supportsDsn) {
      throw Object.assign(new Error("Delivery receipts are not supported by the selected SMTP server"), {
        code: "SMTP_DSN_UNSUPPORTED",
      });
    }
  }
  await assertLeaseActive();
  await beginProviderEffect(command, outbox.sender_identity_id, outbox.selected_identity_transport_revision);
  const beforeSend = await sentMatches({
    runtime: mailboxRuntime,
    sentPath: sender.sent_path,
    messageId: outbox.stable_message_id,
    signal,
  });
  return {
    sender,
    mailboxRuntime,
    sendRuntime,
    mimeBlobId: mime.blobId,
    mimeByteLength: mime.byteLength,
    snapshot: mime.snapshot,
    alreadySent: beforeSend.length > 0,
  };
};

type PreparedFreshOutbox = Awaited<ReturnType<typeof prepareFreshOutbox>>;

const prepareFreshOutboxOrFinish = async (
  outbox: DbOutboxExecution,
  command: DbCommandExecution,
  assertLeaseActive: LeaseAssertion,
  signal: AbortSignal,
): Promise<PreparedFreshOutbox | null> => {
  try {
    return await prepareFreshOutbox(outbox, command, assertLeaseActive, signal);
  } catch (error) {
    if (outbox.attempt < OUTBOX_MAX_ATTEMPTS && isRetryablePreDispatchError(error)) {
      await scheduleOutboxRetry({
        outbox,
        command,
        error,
        code: "OUTBOX_PREDISPATCH_RETRY",
        fallbackMessage: "Mail provider was temporarily unavailable before dispatch",
      });
    } else {
      await finishOutbox({ outbox, command, outboxState: "failed", commandState: "failed", draftState: "draft", error });
    }
    return null;
  }
};

const persistSmtpResult = async (params: {
  outbox: DbOutboxExecution;
  command: DbCommandExecution;
  prepared: PreparedFreshOutbox;
  result: Awaited<ReturnType<typeof imapSmtpConnector.sendSource>>;
  assertLeaseActive: LeaseAssertion;
  signal: AbortSignal;
}): Promise<void> => {
  const { outbox, command, prepared, result } = params;
  const response = { accepted: result.accepted, rejected: result.rejected, response: result.response, messageId: result.messageId };
  if (result.accepted.length === 0) {
    await finishOutbox({
      outbox,
      command,
      outboxState: "failed",
      commandState: "failed",
      draftState: "draft",
      providerResponse: response,
      error: Object.assign(new Error("SMTP provider accepted no recipients"), { code: "SMTP_NO_RECIPIENTS_ACCEPTED" }),
    });
    return;
  }
  if (result.rejected.length > 0) {
    await finishOutbox({
      outbox,
      command,
      outboxState: "needs_attention",
      commandState: "needs_attention",
      draftState: "sent",
      providerResponse: response,
      error: Object.assign(new Error("SMTP provider accepted only some recipients"), { code: "SMTP_PARTIAL_ACCEPTANCE" }),
    });
    return;
  }
  const sentStored = await appendSentCopy({
    outbox,
    sender: prepared.sender,
    runtime: prepared.mailboxRuntime,
    mimeBlobId: prepared.mimeBlobId,
    mimeByteLength: prepared.mimeByteLength,
    assertLeaseActive: params.assertLeaseActive,
    signal: params.signal,
  });
  await finishOutbox({
    outbox,
    command,
    outboxState: sentStored ? "sent" : "sent_sync_pending",
    commandState: "confirmed",
    draftState: "sent",
    providerResponse: response,
  });
};

const persistSmtpFailure = async (params: {
  outbox: DbOutboxExecution;
  command: DbCommandExecution;
  prepared: PreparedFreshOutbox;
  error: unknown;
}): Promise<void> => {
  const { outbox, command, prepared, error } = params;
  const responseCode = Number((error as { responseCode?: unknown } | null)?.responseCode);
  if (Number.isInteger(responseCode) && responseCode >= 400 && responseCode < 500 && outbox.attempt < OUTBOX_MAX_ATTEMPTS) {
    await scheduleOutboxRetry({
      outbox,
      command,
      error,
      code: "SMTP_TRANSIENT_REJECTION",
      fallbackMessage: "SMTP temporarily rejected the message",
    });
    return;
  }
  if (Number.isInteger(responseCode) && responseCode >= 400) {
    await finishOutbox({ outbox, command, outboxState: "failed", commandState: "failed", draftState: "draft", error });
    return;
  }
  const reconciled = await sentMatches({
    runtime: prepared.mailboxRuntime,
    sentPath: prepared.sender.sent_path,
    messageId: outbox.stable_message_id,
  }).catch(() => []);
  if (reconciled.length > 0) {
    await finishOutbox({ outbox, command, outboxState: "reconciled_accepted", commandState: "reconciled", draftState: "sent", error });
    return;
  }
  await finishOutbox({ outbox, command, outboxState: "unknown", commandState: "ambiguous", draftState: "sent", error });
};

const executeFreshOutbox = async (
  outbox: DbOutboxExecution,
  command: DbCommandExecution,
  assertLeaseActive: LeaseAssertion,
  signal: AbortSignal,
): Promise<void> => {
  if (!(await commandStillAuthorized(command, "write"))) {
    await finishOutbox({
      outbox,
      command,
      outboxState: "failed",
      commandState: "failed",
      draftState: "draft",
      error: Object.assign(new Error("Mailbox write access was revoked before sending"), { code: "ACCESS_REVOKED" }),
    });
    return;
  }
  const prepared = await prepareFreshOutboxOrFinish(outbox, command, assertLeaseActive, signal);
  if (!prepared) return;
  if (prepared.alreadySent) {
    await finishOutbox({ outbox, command, outboxState: "reconciled_accepted", commandState: "reconciled", draftState: "sent" });
    return;
  }
  await assertLeaseActive();
  if (!(await commandStillAuthorized(command, "write"))) {
    await finishOutbox({
      outbox,
      command,
      outboxState: "failed",
      commandState: "failed",
      draftState: "draft",
      error: Object.assign(new Error("Mailbox write access was revoked before sending"), { code: "ACCESS_REVOKED" }),
    });
    return;
  }

  await assertLeaseActive();
  try {
    await beginProviderEffect(command, outbox.sender_identity_id, outbox.selected_identity_transport_revision);
  } catch (error) {
    await finishOutbox({ outbox, command, outboxState: "failed", commandState: "failed", draftState: "draft", error });
    return;
  }

  try {
    const result = await imapSmtpConnector.sendSource(prepared.sendRuntime, {
      source: createBlobReadable(prepared.mimeBlobId),
      envelopeFrom: prepared.snapshot.useNullEnvelopeSender ? null : (prepared.snapshot.envelopeFrom ?? prepared.snapshot.from.address),
      recipients: outboundRecipients(prepared.snapshot),
      messageId: outbox.stable_message_id,
      deliveryStatusNotification:
        prepared.snapshot.requestDeliveryReceipt && prepared.snapshot.receiptAddress ? { id: outbox.id } : undefined,
      signal,
    });
    await assertLeaseActive();
    await persistSmtpResult({ outbox, command, prepared, result, assertLeaseActive, signal });
  } catch (error) {
    await persistSmtpFailure({ outbox, command, prepared, error });
  }
};

const reconcileUnknownOutbox = async (outbox: DbOutboxExecution, command: DbCommandExecution, signal: AbortSignal): Promise<void> => {
  const binding = await loadPinnedBinding(command);
  const sender = await loadSenderBinding(command, outbox.sender_identity_id);
  const runtime = await loadPinnedRuntime(binding);
  const matches = await sentMatches({ runtime, sentPath: sender.sent_path, messageId: outbox.stable_message_id, signal });
  if (matches.length > 0) {
    await finishOutbox({ outbox, command, outboxState: "reconciled_accepted", commandState: "reconciled", draftState: "sent" });
  } else {
    await finishOutbox({
      outbox,
      command,
      outboxState: "needs_attention",
      commandState: "needs_attention",
      draftState: "sent",
      error: Object.assign(new Error("SMTP outcome could not be proven; the message was not resent"), { code: "AMBIGUOUS_SMTP_OUTCOME" }),
    });
  }
};

const reconcileSentCopy = async (
  outbox: DbOutboxExecution,
  command: DbCommandExecution,
  assertLeaseActive: LeaseAssertion,
  signal: AbortSignal,
): Promise<void> => {
  const binding = await loadPinnedBinding(command);
  const sender = await loadSenderBinding(command, outbox.sender_identity_id);
  const runtime = await loadPinnedRuntime(binding);
  const mime = await ensureMimeBlob(outbox);
  const stored = await appendSentCopy({
    outbox,
    sender,
    runtime,
    mimeBlobId: mime.blobId,
    mimeByteLength: mime.byteLength,
    assertLeaseActive,
    signal,
  });
  if (stored) {
    await sql`
      UPDATE mail.outbox_submissions
      SET state = 'sent', last_error_code = NULL, last_error_message = NULL, updated_at = now()
      WHERE id = ${outbox.id}::uuid
        AND attempt = ${outbox.attempt}
        AND state = ${outbox.state}
    `;
  } else {
    await deferSentCopy(outbox);
  }
};

const deferSentCopy = async (outbox: DbOutboxExecution, error?: unknown): Promise<void> => {
  const exhausted = outbox.attempt >= 5;
  await sql`
    UPDATE mail.outbox_submissions
    SET
      state = ${exhausted ? "needs_attention" : "sent_sync_pending"},
      last_error_code = ${error ? normalizeCode(error, "SENT_APPEND_FAILED") : "SENT_APPEND_FAILED"},
      last_error_message = ${errorMessage(error, "Message was delivered but could not be stored in Sent")},
      updated_at = now()
    WHERE id = ${outbox.id}::uuid
      AND attempt = ${outbox.attempt}
      AND state = ${outbox.state}
  `;
};

const runClaimedOutbox = async (
  outboxId: string,
  claim: OutboxClaim,
  loaded: { outbox: DbOutboxExecution; command: DbCommandExecution },
  assertLeaseActive: LeaseAssertion,
  signal: AbortSignal,
): Promise<string | null> => {
  try {
    if (claim.previousOutboxState === "unknown") await reconcileUnknownOutbox(loaded.outbox, loaded.command, signal);
    else if (claim.previousOutboxState === "sent_sync_pending") {
      await reconcileSentCopy(loaded.outbox, loaded.command, assertLeaseActive, signal);
    } else await executeFreshOutbox(loaded.outbox, loaded.command, assertLeaseActive, signal);
  } catch (error) {
    if (claim.previousOutboxState === "sent_sync_pending") {
      log.warn("Sent copy reconciliation failed", { outboxId, code: normalizeCode(error, "SENT_RECONCILIATION_FAILED") });
      await deferSentCopy(loaded.outbox, error);
    } else {
      await finishOutbox({
        outbox: loaded.outbox,
        command: loaded.command,
        outboxState: claim.previousOutboxState === "unknown" ? "needs_attention" : "unknown",
        commandState: claim.previousOutboxState === "unknown" ? "needs_attention" : "ambiguous",
        draftState: "sent",
        error,
      });
    }
  }
  const [state] = await sql<{ state: string }[]>`SELECT state FROM mail.outbox_submissions WHERE id = ${outboxId}::uuid`;
  return state?.state ?? null;
};

const loadOutboxRemoteResourceId = async (outboxId: string): Promise<string | null> => {
  const [resource] = await sql<{ id: string }[]>`
    SELECT resource.id
    FROM mail.outbox_submissions outbox
    JOIN mail.provider_bindings binding ON binding.id = outbox.selected_binding_id
    JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
    WHERE outbox.id = ${outboxId}::uuid
  `;
  return resource?.id ?? null;
};

export const executeOutboxSubmissionWithHeartbeat = async (
  outboxId: string,
  heartbeat?: (fence: { outbox: DbOutboxExecution; command: DbCommandExecution }) => Promise<void>,
): Promise<string | null> => {
  const remoteResourceId = await loadOutboxRemoteResourceId(outboxId);
  if (!remoteResourceId) return null;
  const lock = await mailProviderOperationMutex().acquire({ resource: remoteResourceId, ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS });
  if (!lock) throw Object.assign(new Error("Remote mailbox is currently being synchronized or changed"), { code: "REMOTE_RESOURCE_BUSY" });
  let claim: OutboxClaim | null = null;
  try {
    claim = await claimOutbox(outboxId);
    if (!claim) return null;
    const activeClaim = claim;
    await publishOutboundSubmissionChange({
      outboxId,
      state: activeClaim.claimedOutboxState,
      attempt: activeClaim.claimedOutboxAttempt,
    });
    const loaded = await loadOutbox(outboxId);
    if (!loaded) throw Object.assign(new Error("Claimed outbox submission is unavailable"), { code: "OUTBOX_UNAVAILABLE" });
    return await withLeaseHeartbeat({
      intervalMs: JOB_HEARTBEAT_INTERVAL_MS,
      heartbeat: async () => {
        if (!(await mailProviderOperationMutex().extend(lock, { ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS }))) {
          throw Object.assign(new Error("Remote mailbox operation lease was lost"), { code: "COMMAND_JOB_LEASE_LOST" });
        }
        await heartbeat?.(loaded);
      },
      work: async (assertLeaseActive, signal) => {
        await waitForMailProviderSlot(remoteResourceId, signal);
        await assertLeaseActive();
        return runClaimedOutbox(outboxId, activeClaim, loaded, assertLeaseActive, signal);
      },
    });
  } catch (error) {
    if (claim) {
      const reset = await resetUnstartedOutboxClaim(outboxId, claim).catch((rollbackError: unknown) => {
        log.warn("Failed to reset an unstarted outbox claim", {
          outboxId,
          code: normalizeCode(rollbackError, "OUTBOX_CLAIM_RESET_FAILED"),
        });
        return false;
      });
      if (reset) {
        await publishOutboundSubmissionChange({
          outboxId,
          state: claim.previousOutboxState,
          attempt: claim.previousOutboxAttempt,
        });
      }
    }
    throw error;
  } finally {
    await mailProviderOperationMutex()
      .release(lock)
      .catch(() => false);
  }
};

export const executeOutboxSubmission = async (outboxId: string): Promise<string | null> => executeOutboxSubmissionWithHeartbeat(outboxId);

const recoverStaleExecutions = async (): Promise<number> => {
  const result = await sql.begin(async (tx) => {
    const staleOutboxes = await tx<{ id: string; command_id: string }[]>`
      WITH stale AS MATERIALIZED (
        SELECT o.id AS outbox_id, c.id AS command_id
        FROM mail.outbox_submissions o
        JOIN mail.commands c ON c.id = o.command_id
        WHERE o.state = 'sending'
          AND c.state = 'executing'
          AND c.kind = 'send'
          AND COALESCE(c.worker_heartbeat_at, c.started_at) < now() - (${STALE_EXECUTION_MINUTES}::text || ' minutes')::interval
        ORDER BY c.id, o.id
        FOR UPDATE OF o, c SKIP LOCKED
        LIMIT 500
      ), recovered_commands AS (
        UPDATE mail.commands c
        SET
          state = 'ambiguous',
          worker_heartbeat_at = NULL,
          last_error_code = 'WORKER_LEASE_EXPIRED',
          last_error_message = 'Worker stopped before the SMTP outcome was persisted',
          updated_at = now()
        FROM stale
        WHERE c.id = stale.command_id
        RETURNING c.id
      )
      UPDATE mail.outbox_submissions o
      SET
        state = 'unknown',
        last_error_code = 'WORKER_LEASE_EXPIRED',
        last_error_message = 'Send worker stopped before the SMTP outcome was persisted',
        updated_at = now()
      FROM stale
      JOIN recovered_commands c ON c.id = stale.command_id
      WHERE o.id = stale.outbox_id
      RETURNING o.id, o.command_id
    `;
    const staleMutations = await tx<{ id: string }[]>`
      WITH stale AS MATERIALIZED (
        SELECT id
        FROM mail.commands
        WHERE state = 'executing'
          AND kind IN (
            'set_flags', 'change_message_state', 'move', 'copy', 'delete',
            'create_folder', 'rename_folder', 'delete_folder', 'set_folder_subscription'
          )
          AND COALESCE(worker_heartbeat_at, started_at) < now() - (${STALE_EXECUTION_MINUTES}::text || ' minutes')::interval
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 500
      )
      UPDATE mail.commands c
      SET
        state = 'ambiguous',
        worker_heartbeat_at = NULL,
        last_error_code = 'WORKER_LEASE_EXPIRED',
        last_error_message = 'Worker stopped before the IMAP outcome was persisted',
        updated_at = now()
      FROM stale
      WHERE c.id = stale.id
      RETURNING c.id
    `;
    const staleSentCopies = await tx<{ id: string }[]>`
      WITH stale AS MATERIALIZED (
        SELECT id
        FROM mail.outbox_submissions
        WHERE state = 'accepted'
          AND updated_at < now() - (${STALE_EXECUTION_MINUTES}::text || ' minutes')::interval
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 500
      )
      UPDATE mail.outbox_submissions o
      SET
        state = CASE WHEN attempt >= 5 THEN 'needs_attention' ELSE 'sent_sync_pending' END,
        last_error_code = 'SENT_COPY_LEASE_EXPIRED',
        last_error_message = 'Sent copy worker stopped before completion',
        updated_at = now()
      FROM stale
      WHERE o.id = stale.id
      RETURNING o.id
    `;
    return staleOutboxes.length + staleMutations.length + staleSentCopies.length;
  });
  return result;
};

const mutationJob = lazySync((sync) =>
  sync.job<{ commandId: string }>({
    id: "mail:execute-command",
    delivery: { ackWaitMs: MUTATION_JOB_LEASE_MS, maxAttempts: 5, backoffMs: [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000] },
  }),
);
let mutationJobWorker: Worker | undefined;
const startMutationJob = async (): Promise<void> => {
  mutationJobWorker = await mutationJob().process({}, async (ctx) => {
    const state = await executeMutationCommandWithHeartbeat(ctx.input.commandId, async (fence) => {
      try {
        await ctx.heartbeat();
      } catch (cause) {
        throw Object.assign(new Error("Mail command job lease was lost"), { code: "COMMAND_JOB_LEASE_LOST", cause });
      }
      await heartbeatCommandFence(fence);
    });
    if (state === "ambiguous") ctx.resubmit({ delayMs: 2_000 });
    else if (state === "queued") ctx.resubmit({ delayMs: 30_000 });
  });
};

const outboxJob = lazySync((sync) =>
  sync.job<{ outboxId: string; continuationAttempt?: number }>({
    id: "mail:execute-outbox",
    delivery: { ackWaitMs: OUTBOX_JOB_LEASE_MS, maxAttempts: 5, backoffMs: [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000] },
  }),
);
let outboxJobWorker: Worker | undefined;
const startOutboxJob = async (): Promise<void> => {
  outboxJobWorker = await outboxJob().process({}, async (ctx) => {
    let state: string | null;
    try {
      state = await executeOutboxSubmissionWithHeartbeat(ctx.input.outboxId, async (loaded) => {
        try {
          await ctx.heartbeat();
        } catch (cause) {
          throw Object.assign(new Error("Mail outbox job lease was lost"), { code: "COMMAND_JOB_LEASE_LOST", cause });
        }
        await heartbeatOutboxFence(loaded);
      });
    } catch (error) {
      // A sibling job holds the remote resource: routine contention, not a failed attempt.
      if ((error as { code?: unknown } | null)?.code === "REMOTE_RESOURCE_BUSY") {
        ctx.resubmit({ delayMs: providerBusyRetryDelayMs() });
        return;
      }
      throw error;
    }
    const [pending] = await sql<{ state: string; delay_ms: string | number }[]>`
    SELECT
      state,
      GREATEST(
        0,
        EXTRACT(EPOCH FROM (GREATEST(scheduled_at, COALESCE(undo_until, scheduled_at)) - now())) * 1000
      )::bigint AS delay_ms
    FROM mail.outbox_submissions
    WHERE id = ${ctx.input.outboxId}::uuid
      AND state IN ('scheduled', 'undo_window')
    `;
    if (pending) {
      // Still scheduled or inside the undo window: sleep until it is due. Beyond
      // the schedule window the commands-due cron submits it again when due.
      const remainingMs = Number(pending.delay_ms);
      if (remainingMs <= OUTBOX_SCHEDULE_WINDOW_MS) ctx.resubmit({ delayMs: Math.max(1_000, remainingMs) });
      else log.debug("Scheduled send handed to the commands-due cron", { outboxId: ctx.input.outboxId, remainingMs });
      return;
    }
    if (state === "unknown") {
      ctx.resubmit({ delayMs: 2_000 });
      return;
    }
    if (state === "sent_sync_pending") {
      // Sync continuations are fresh deliveries; carry the logical attempt across them.
      const attempt = (ctx.input.continuationAttempt ?? 0) + ctx.attempt;
      ctx.resubmit({
        delayMs: expBackoff(attempt, { baseMs: 10_000, maxMs: 10 * 60_000 }),
        input: { ...ctx.input, continuationAttempt: attempt },
      });
    }
  });
};

const submitMutationJob = async (commandId: string): Promise<void> => {
  await (commandTasks.run(() => mutationJob().submit({ coalesce: true, key: `command:${commandId}`, input: { commandId } })) ??
    Promise.resolve());
};

const submitOutboxJob = async (outboxId: string, at?: number): Promise<void> => {
  await (commandTasks.run(() =>
    outboxJob().submit({
      coalesce: true,
      key: `outbox:${outboxId}`,
      input: { outboxId },
      ...(at === undefined ? {} : { at: new Date(Math.min(at, Date.now() + OUTBOX_SCHEDULE_WINDOW_MS)) }),
    }),
  ) ?? Promise.resolve());
};

export const enqueueMailCommand = async (commandId: string, kind: MailCommand["kind"]): Promise<void> => {
  if (kind === "send") {
    const [outbox] = await sql<{ id: string; due_at: Date | string }[]>`
      SELECT id, GREATEST(scheduled_at, COALESCE(undo_until, scheduled_at)) AS due_at
      FROM mail.outbox_submissions
      WHERE command_id = ${commandId}::uuid
    `;
    if (outbox) {
      await submitOutboxJob(outbox.id, new Date(outbox.due_at).getTime());
    }
    return;
  }
  if (["set_flags", "change_message_state", "move", "copy", "delete", ...FOLDER_COMMAND_KINDS].includes(kind)) {
    await submitMutationJob(commandId);
    return;
  }
  if (isOperatorMaintenanceKind(kind)) {
    await enqueueMaintenanceCommand(commandId);
  }
};

const submitDueCommands = async (): Promise<{ commands: number; maintenance: number; outbox: number; recovered: number }> => {
  const recovered = await recoverStaleExecutions();
  const maintenance = await submitDueMaintenanceCommands();
  const commands = await sql<{ id: string; kind: MailCommand["kind"] }[]>`
    SELECT id, kind
    FROM mail.commands
    WHERE state IN ('queued', 'ambiguous')
      AND kind IN (
        'set_flags', 'change_message_state', 'move', 'copy', 'delete',
        'create_folder', 'rename_folder', 'delete_folder', 'set_folder_subscription'
      )
    ORDER BY created_at, id
    LIMIT 500
  `;
  for (const command of commands) {
    await submitMutationJob(command.id);
  }
  const outboxes = await sql<{ id: string }[]>`
    SELECT id
    FROM mail.outbox_submissions
    WHERE (
      state IN ('scheduled', 'undo_window')
      AND GREATEST(scheduled_at, COALESCE(undo_until, scheduled_at)) <= now()
    ) OR state IN ('unknown', 'sent_sync_pending')
    ORDER BY scheduled_at, id
    LIMIT 500
  `;
  for (const outbox of outboxes) {
    await submitOutboxJob(outbox.id);
  }
  return {
    commands: commands.length,
    maintenance: maintenance.queued,
    outbox: outboxes.length,
    recovered: recovered + maintenance.recovered,
  };
};

const commandScheduler = lazySync((sync) =>
  sync.scheduler({ id: "mail-commands", delivery: { maxAttempts: 5, backoffMs: [5_000, 20_000, 60_000, 120_000] } }),
);
let commandSchedulerWorker: Worker | undefined;

const stopCommandJobs = async (): Promise<void> => {
  await stopRuntimeJobs(
    commandTasks,
    [mutationJobWorker, outboxJobWorker].filter((worker): worker is Worker => worker !== undefined),
  );
  mutationJobWorker = undefined;
  outboxJobWorker = undefined;
};

const commandRuntimeLifecycle = createRuntimeLifecycle({
  start: async () => {
    commandTasks.open();
    await startMutationJob();
    await startOutboxJob();
    await startMaintenanceRuntime();

    await commandScheduler().create({
      id: "mail:commands-due",
      cron: "* * * * *",
      misfire: "latest",
      meta: { appId: "mail", family: "mail:commands", label: "Mail command dispatch" },
      process: async () => {
        await submitDueCommands();
      },
    });
    commandSchedulerWorker = await commandScheduler().process();
    await submitDueCommands();
  },
  stop: async () => {
    // Stop every command delivery before a scheduler drain can yield with the tracker closed.
    mutationJobWorker?.stop();
    outboxJobWorker?.stop();
    commandSchedulerWorker?.stop();
    commandTasks.close();
    await stopRuntimeResources([
      () =>
        commandSchedulerWorker?.drain().then(() => {
          commandSchedulerWorker = undefined;
        }),
      stopMaintenanceRuntime,
      stopCommandJobs,
    ]);
  },
});

export const commandRuntime = {
  start: commandRuntimeLifecycle.start,
  stop: commandRuntimeLifecycle.stop,
};
