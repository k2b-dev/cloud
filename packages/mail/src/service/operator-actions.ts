import { sql } from "bun";
import type {
  CommandKind,
  MaintenanceCommandInput,
  OperatorActionEligibility,
  OperatorActionKind,
  OperatorActionSafety,
} from "../contracts";
import { withShortIdDb } from "../lib/short-id";
import { SEARCH_CHUNK_CHARACTERS, SEARCH_CHUNK_OVERLAP_CHARACTERS } from "./search-chunks";

type SqlClient = typeof sql;
type JsonRecord = Record<string, unknown>;

export const BASE_MAINTENANCE_KINDS = [
  "sync_mailbox",
  "sync_folder",
  "discover_folders",
  "verify_binding",
  "rebuild_folder",
  "hydrate_missing",
] as const satisfies readonly CommandKind[];

export const OPERATOR_MAINTENANCE_KINDS = [
  ...BASE_MAINTENANCE_KINDS,
  "rebuild_search",
  "rebuild_threads",
  "reconcile_effect",
  "retry_command",
  "cancel_command",
] as const satisfies readonly OperatorActionKind[];

const RECONCILABLE_COMMAND_KINDS = [
  "set_flags",
  "change_message_state",
  "move",
  "copy",
  "delete",
  "create_folder",
  "rename_folder",
  "delete_folder",
  "set_folder_subscription",
  "send",
] as const satisfies readonly CommandKind[];

const safetyFor = (kind: OperatorActionKind): OperatorActionSafety => {
  if (["rebuild_search", "rebuild_threads"].includes(kind)) return "local_projection";
  if (kind === "reconcile_effect") return "reconcile_only";
  if (kind === "retry_command" || kind === "cancel_command") return "state_transition";
  return "remote_read";
};

const targetFor = (input: MaintenanceCommandInput): Record<string, string> => {
  if ("folderId" in input) return { folderId: input.folderId };
  if ("bindingId" in input && input.bindingId) return { bindingId: input.bindingId };
  if ("commandId" in input) return { commandId: input.commandId };
  return {};
};

const persistedTargetFor = (input: MaintenanceCommandInput): Record<string, unknown> =>
  input.kind === "discover_folders" ? { bindingId: input.bindingId ?? null } : targetFor(input);

const eligibility = (input: MaintenanceCommandInput, eligible: boolean, reason: string | null = null): OperatorActionEligibility => ({
  kind: input.kind,
  target: targetFor(input),
  safety: safetyFor(input.kind),
  eligible,
  reason,
});

export type OperatorTargetCommandState = {
  id: string;
  kind: CommandKind;
  state: string;
  provider_effect_started_at: Date | string | null;
};

export const operatorActionForCommand = (
  input: Extract<MaintenanceCommandInput, { commandId: string }>,
  command: OperatorTargetCommandState | null,
  duplicate = false,
): OperatorActionEligibility => {
  if (duplicate) return eligibility(input, false, "An equivalent operator action is already pending");
  if (!command) return eligibility(input, false, "The target command is unavailable");
  if (input.kind === "reconcile_effect") {
    if (!RECONCILABLE_COMMAND_KINDS.includes(command.kind as (typeof RECONCILABLE_COMMAND_KINDS)[number])) {
      return eligibility(input, false, "This command has no provider effect to reconcile");
    }
    return command.state === "ambiguous" || command.state === "needs_attention"
      ? eligibility(input, true)
      : eligibility(input, false, "Only an ambiguous or exhausted provider effect can be reconciled");
  }
  if (!BASE_MAINTENANCE_KINDS.includes(command.kind as (typeof BASE_MAINTENANCE_KINDS)[number])) {
    return eligibility(input, false, "Only provider-read maintenance work can be retried or cancelled here");
  }
  if (command.provider_effect_started_at) {
    return eligibility(input, false, "The provider effect started and must not be retried blindly");
  }
  if (input.kind === "retry_command") {
    return command.state === "failed" ? eligibility(input, true) : eligibility(input, false, "Only failed maintenance work can be retried");
  }
  return command.state === "queued" || command.state === "failed"
    ? eligibility(input, true)
    : eligibility(input, false, "Only queued or failed maintenance work can be cancelled");
};

export const operatorActionForFolder = (
  input: Extract<MaintenanceCommandInput, { folderId: string }>,
  folder: { discovery_state: string; selected_for_sync: boolean } | null,
  duplicate = false,
): OperatorActionEligibility => {
  if (duplicate) return eligibility(input, false, "An equivalent operator action is already pending");
  if (!folder || folder.discovery_state !== "active") return eligibility(input, false, "The folder is not active");
  if (input.kind === "sync_folder" && !folder.selected_for_sync) {
    return eligibility(input, false, "The folder is excluded from synchronization");
  }
  return eligibility(input, true);
};

export const getOperatorActionEligibility = async (params: {
  db?: SqlClient;
  mailboxId: string;
  input: MaintenanceCommandInput;
  excludeCommandId?: string;
  lockTarget?: boolean;
}): Promise<OperatorActionEligibility> => {
  const db = params.db ?? sql;
  const target = persistedTargetFor(params.input);
  const [duplicate] = await db<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM mail.commands
      WHERE mailbox_id = ${params.mailboxId}::uuid
        AND kind = ${params.input.kind}
        AND target = ${target}::jsonb
        AND state IN ('queued', 'executing')
        AND (${params.excludeCommandId ?? null}::uuid IS NULL OR id <> ${params.excludeCommandId ?? null}::uuid)
    ) AS exists
  `;
  if (duplicate?.exists) return eligibility(params.input, false, "An equivalent operator action is already pending");

  if ("commandId" in params.input) {
    const rows = await db<OperatorTargetCommandState[]>`
      SELECT id, kind, state, provider_effect_started_at
      FROM mail.commands
      WHERE id = ${params.input.commandId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
      ${params.lockTarget ? sql`FOR UPDATE` : sql``}
    `;
    return operatorActionForCommand(params.input, rows[0] ?? null);
  }

  if (params.input.kind === "sync_mailbox") {
    const [state] = await db<{ sync_enabled: boolean; ready: boolean }[]>`
      SELECT mailbox.sync_enabled, EXISTS (
        SELECT 1
        FROM mail.folders folder
        JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
        JOIN mail.provider_bindings binding ON binding.remote_resource_id = resource.id
        WHERE resource.mailbox_id = mailbox.id
          AND binding.state = 'active'
          AND folder.discovery_state = 'active'
          AND folder.selected_for_sync
          AND folder.sync_status <> 'excluded'
      ) AS ready
      FROM mail.mailboxes mailbox
      WHERE mailbox.id = ${params.mailboxId}::uuid AND mailbox.deleted_at IS NULL
    `;
    if (!state?.sync_enabled) return eligibility(params.input, false, "Mailbox synchronization is paused");
    return state.ready ? eligibility(params.input, true) : eligibility(params.input, false, "No active synchronized folder is available");
  }

  if (params.input.kind === "sync_folder" || params.input.kind === "rebuild_folder") {
    const [folder] = await db<{ discovery_state: string; selected_for_sync: boolean }[]>`
      SELECT folder.discovery_state, folder.selected_for_sync
      FROM mail.folders folder
      JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
      WHERE folder.id = ${params.input.folderId}::uuid AND resource.mailbox_id = ${params.mailboxId}::uuid
    `;
    return operatorActionForFolder(params.input, folder ?? null);
  }

  if (params.input.kind === "discover_folders" || params.input.kind === "verify_binding") {
    const bindingId = params.input.bindingId ?? null;
    const [bindings] = await db<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM mail.provider_bindings binding
      JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
      WHERE resource.mailbox_id = ${params.mailboxId}::uuid
        AND (${bindingId}::uuid IS NULL OR binding.id = ${bindingId}::uuid)
        AND binding.state IN ('pending', 'active', 'degraded')
    `;
    return Number(bindings?.count ?? 0) > 0
      ? eligibility(params.input, true)
      : eligibility(params.input, false, "No eligible provider binding is available");
  }

  if (params.input.kind === "hydrate_missing") {
    const [messages] = await db<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM mail.message_contents
      WHERE mailbox_id = ${params.mailboxId}::uuid
        AND hydration_status IN ('envelope', 'headers', 'body', 'failed')
    `;
    return Number(messages?.count ?? 0) > 0
      ? eligibility(params.input, true)
      : eligibility(params.input, false, "No message bodies require hydration");
  }

  const [mailbox] = await db<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM mail.mailboxes WHERE id = ${params.mailboxId}::uuid AND deleted_at IS NULL) AS exists
  `;
  return mailbox?.exists ? eligibility(params.input, true) : eligibility(params.input, false, "The mailbox is unavailable");
};

const rebuildSearchProjection = async (db: SqlClient, mailboxId: string): Promise<JsonRecord> => {
  const stride = SEARCH_CHUNK_CHARACTERS - SEARCH_CHUNK_OVERLAP_CHARACTERS;
  await db`SELECT id FROM mail.message_contents WHERE mailbox_id = ${mailboxId}::uuid ORDER BY id FOR SHARE`;
  const removed = await db<{ message_id: string }[]>`
    DELETE FROM mail.message_search_chunks chunk
    USING mail.message_contents message
    WHERE chunk.message_id = message.id
      AND chunk.source_kind = 'body'
      AND message.mailbox_id = ${mailboxId}::uuid
    RETURNING chunk.message_id
  `;
  const inserted = await db<{ message_id: string }[]>`
    INSERT INTO mail.message_search_chunks (message_id, mailbox_id, position, search_document)
    SELECT
      message.id,
      message.mailbox_id,
      chunk.position,
      to_tsvector(
        'simple'::regconfig,
        substring(message.plain_text FROM chunk.position * ${stride}::int + 1 FOR ${SEARCH_CHUNK_CHARACTERS}::int)
      )
    FROM mail.message_contents message
    CROSS JOIN LATERAL generate_series(0, (char_length(message.plain_text) - 1) / ${stride}::int) AS chunk(position)
    WHERE message.mailbox_id = ${mailboxId}::uuid AND message.plain_text IS NOT NULL AND message.plain_text <> ''
    RETURNING message_id
  `;
  return { removedChunks: removed.length, insertedChunks: inserted.length };
};

const rebuildThreadProjection = async (db: SqlClient, mailboxId: string): Promise<JsonRecord> => {
  // Drafts Mail projected to the provider are never conversation messages. Syncs before the
  // `\Draft` guard imported them from folders such as Gmail's All Mail; the timeline refresh
  // below recomputes the conversations they were in. A message placed anywhere without the
  // `\Draft` flag, even in a placement the provider has since removed, was sent from another
  // program with the draft's Message-ID and stays.
  const removedDraftCopies = await db<{ id: string }[]>`
    DELETE FROM mail.message_contents message
    USING mail.draft_provider_snapshots snapshot
    WHERE message.mailbox_id = ${mailboxId}::uuid
      AND snapshot.mailbox_id = message.mailbox_id
      AND snapshot.direction = 'export'
      AND lower(snapshot.stable_message_id) = lower(message.message_id)
      AND NOT EXISTS (
        SELECT 1 FROM mail.message_placements placement
        WHERE placement.message_id = message.id
          AND NOT ('\\Draft' = ANY(placement.flags) OR '\\Draft' = ANY(placement.keywords))
      )
      AND NOT EXISTS (SELECT 1 FROM mail.outbox_submissions outbox WHERE outbox.message_id = message.id)
      AND NOT EXISTS (
        SELECT 1 FROM mail.drafts draft
        WHERE draft.source_message_id = message.id OR draft.derived_from_message_id = message.id
      )
      AND NOT EXISTS (SELECT 1 FROM mail.automatic_reply_effects effect WHERE effect.message_id = message.id)
    RETURNING message.id
  `;
  await db`SELECT id FROM mail.message_contents WHERE mailbox_id = ${mailboxId}::uuid ORDER BY id FOR SHARE`;
  const orphans = await db<
    {
      message_id: string;
      subject: string;
      internal_date: Date | string;
      outbound: boolean;
      human_reply: boolean;
      participants: string;
    }[]
  >`
    SELECT
      message.id AS message_id,
      message.subject,
      message.internal_date,
      EXISTS (
        SELECT 1 FROM mail.message_addresses sender
        JOIN mail.sender_identities identity
          ON identity.mailbox_id = message.mailbox_id
         AND lower(identity.from_address) = sender.normalized_email
        WHERE sender.message_id = message.id AND sender.role = 'from'
      ) AS outbound,
      (
        (message.in_reply_to IS NOT NULL OR cardinality(message.reference_ids) > 0)
        AND COALESCE(NULLIF(lower(btrim(message.protocol_facts->>'autoSubmitted')), ''), 'no') = 'no'
      ) AS human_reply,
      COALESCE((
        SELECT string_agg(COALESCE(NULLIF(address.display_name, ''), address.email), ', ' ORDER BY address.position)
        FROM mail.message_addresses address WHERE address.message_id = message.id
      ), '') AS participants
    FROM mail.message_contents message
    WHERE message.mailbox_id = ${mailboxId}::uuid
      AND NOT EXISTS (SELECT 1 FROM mail.conversation_messages link WHERE link.message_id = message.id)
    ORDER BY message.id
  `;
  for (const orphan of orphans) {
    const rows = await withShortIdDb(
      db,
      "conversation",
      (attempt, shortId) => attempt<{ id: string }[]>`
      INSERT INTO mail.conversations (
        short_id, mailbox_id, subject, participant_summary,
        latest_inbound_at, latest_outbound_at, latest_message_at, work_status
      ) VALUES (
        ${shortId}, ${mailboxId}::uuid, ${orphan.subject}, ${orphan.participants},
        ${orphan.outbound ? null : orphan.internal_date}, ${orphan.outbound ? orphan.internal_date : null},
        ${orphan.internal_date}, ${orphan.outbound && orphan.human_reply ? "waiting" : "needs_action"}
      )
      RETURNING id
    `,
    );
    const conversation = rows[0];
    if (!conversation) throw new Error("Thread rebuild conversation insert returned no row");
    await db`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (
        ${conversation.id}::uuid, ${orphan.message_id}::uuid,
        floor(extract(epoch FROM ${orphan.internal_date}::timestamptz) * 1000)::bigint, 'heuristic'
      )
    `;
  }
  const refreshed = await db<{ id: string }[]>`
    WITH classified AS (
      SELECT
        conversation.id AS conversation_id,
        message.id AS message_id,
        message.subject,
        message.internal_date,
        EXISTS (
          SELECT 1 FROM mail.message_addresses sender
          JOIN mail.sender_identities identity
            ON identity.mailbox_id = conversation.mailbox_id
           AND lower(identity.from_address) = sender.normalized_email
          WHERE sender.message_id = message.id AND sender.role = 'from'
        ) AS outbound
      FROM mail.conversations conversation
      JOIN mail.conversation_messages link ON link.conversation_id = conversation.id
      JOIN mail.message_contents message ON message.id = link.message_id
      WHERE conversation.mailbox_id = ${mailboxId}::uuid
    ), latest AS (
      SELECT DISTINCT ON (conversation_id) conversation_id, message_id, subject, outbound
      FROM classified ORDER BY conversation_id, internal_date DESC, message_id DESC
    ), timeline AS (
      SELECT
        conversation_id,
        MAX(internal_date) AS latest_message_at,
        MAX(internal_date) FILTER (WHERE NOT outbound) AS latest_inbound_at,
        MAX(internal_date) FILTER (WHERE outbound) AS latest_outbound_at
      FROM classified GROUP BY conversation_id
    ), participants AS (
      SELECT
        latest.conversation_id,
        COALESCE(
          string_agg(
            COALESCE(NULLIF(address.display_name, ''), address.email),
            ', ' ORDER BY address.position
          ) FILTER (
            WHERE (latest.outbound AND address.role IN ('to', 'cc', 'bcc'))
               OR (NOT latest.outbound AND address.role = 'from')
          ),
          ''
        ) AS summary
      FROM latest LEFT JOIN mail.message_addresses address ON address.message_id = latest.message_id
      GROUP BY latest.conversation_id
    )
    UPDATE mail.conversations conversation
    SET
      subject = latest.subject,
      participant_summary = participants.summary,
      latest_message_at = timeline.latest_message_at,
      latest_inbound_at = timeline.latest_inbound_at,
      latest_outbound_at = timeline.latest_outbound_at
    FROM latest, timeline, participants
    WHERE conversation.id = latest.conversation_id
      AND timeline.conversation_id = conversation.id
      AND participants.conversation_id = conversation.id
    RETURNING conversation.id
  `;
  return {
    createdSingletonThreads: orphans.length,
    refreshedThreads: refreshed.length,
    removedDraftCopies: removedDraftCopies.length,
  };
};

export const executeOperatorAction = async (params: {
  commandId: string;
  mailboxId: string;
  input: MaintenanceCommandInput;
}): Promise<JsonRecord> => {
  return sql.begin(async (tx) => {
    const target = targetFor(params.input);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${params.mailboxId}:${params.input.kind}:${JSON.stringify(target)}`}, 0))`;
    if ("commandId" in params.input) {
      const [targetCommand] = await tx<{ state: string; transport_metadata: Record<string, unknown> | string }[]>`
        SELECT state, transport_metadata
        FROM mail.commands
        WHERE id = ${params.input.commandId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
        FOR UPDATE
      `;
      const rawMetadata = targetCommand?.transport_metadata;
      const metadata: Record<string, unknown> =
        rawMetadata === undefined
          ? {}
          : typeof rawMetadata === "string"
            ? (JSON.parse(rawMetadata) as Record<string, unknown>)
            : rawMetadata;
      if (
        params.input.kind === "retry_command" &&
        (targetCommand?.state === "queued" || metadata?.operatorRetryCommandId === params.commandId)
      ) {
        return { commandId: params.input.commandId, retried: true, replayed: true };
      }
      if (params.input.kind === "cancel_command" && targetCommand?.state === "cancelled") {
        return { commandId: params.input.commandId, cancelled: true, replayed: true };
      }
    }
    const current = await getOperatorActionEligibility({
      db: tx,
      mailboxId: params.mailboxId,
      input: params.input,
      excludeCommandId: params.commandId,
      lockTarget: true,
    });
    if (!current.eligible)
      throw Object.assign(new Error(current.reason ?? "Operator action is no longer eligible"), { code: "OPERATOR_ACTION_INELIGIBLE" });
    if (params.input.kind === "rebuild_search") return rebuildSearchProjection(tx, params.mailboxId);
    if (params.input.kind === "rebuild_threads") return rebuildThreadProjection(tx, params.mailboxId);
    if (params.input.kind === "reconcile_effect") {
      const [command] = await tx<{ kind: CommandKind }[]>`
        UPDATE mail.commands
        SET
          state = 'ambiguous',
          attempt = 0,
          started_at = NULL,
          finished_at = NULL,
          worker_heartbeat_at = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          updated_at = now()
        WHERE id = ${params.input.commandId}::uuid
          AND mailbox_id = ${params.mailboxId}::uuid
          AND state IN ('ambiguous', 'needs_attention')
        RETURNING kind
      `;
      if (!command) throw Object.assign(new Error("Target command changed state"), { code: "COMMAND_STATE_CHANGED" });
      return { commandId: params.input.commandId, reconciliationQueued: true };
    }
    if (params.input.kind === "retry_command") {
      const [command] = await tx<{ kind: CommandKind }[]>`
        UPDATE mail.commands
        SET state = 'queued', started_at = NULL, finished_at = NULL, worker_heartbeat_at = NULL,
            last_error_code = NULL, last_error_message = NULL,
            transport_metadata = transport_metadata || ${{ operatorRetryCommandId: params.commandId }}::jsonb,
            updated_at = now()
        WHERE id = ${params.input.commandId}::uuid AND mailbox_id = ${params.mailboxId}::uuid AND state = 'failed'
        RETURNING kind
      `;
      if (!command) throw Object.assign(new Error("Target command changed state"), { code: "COMMAND_STATE_CHANGED" });
      return { commandId: params.input.commandId, retried: true };
    }
    if (params.input.kind === "cancel_command") {
      const [command] = await tx<{ id: string }[]>`
        UPDATE mail.commands
        SET state = 'cancelled', finished_at = now(), worker_heartbeat_at = NULL,
            last_error_code = 'OPERATOR_CANCELLED', last_error_message = 'Cancelled by a mailbox operator', updated_at = now()
        WHERE id = ${params.input.commandId}::uuid
          AND mailbox_id = ${params.mailboxId}::uuid
          AND state IN ('queued', 'failed')
        RETURNING id
      `;
      if (!command) throw Object.assign(new Error("Target command changed state"), { code: "COMMAND_STATE_CHANGED" });
      return { commandId: params.input.commandId, cancelled: true };
    }
    throw Object.assign(new Error("Operator action is handled by the maintenance runtime"), { code: "OPERATOR_ACTION_ROUTING_ERROR" });
  });
};

export const isOperatorMaintenanceKind = (kind: string): kind is OperatorActionKind =>
  OPERATOR_MAINTENANCE_KINDS.includes(kind as OperatorActionKind);
