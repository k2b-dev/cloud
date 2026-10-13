import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import {
  type ActorRef,
  type CommandState,
  type ConversationTriageInput,
  type ConversationTriageUndoInput,
  type ConversationTriageUndoOutcome,
  type ConversationTriageUndoResult,
  conversationTriageUndoInputSchema,
  MAX_CONVERSATION_ACTION_MESSAGES,
  type MailCommand,
  type MailCommandOutcome,
} from "../contracts";
import { requireMailboxAccess, requireVisibleConversation, requireVisibleMessages } from "./access";
import { actorRefFromRequest, type MailRequestContext } from "./auth";
import { commandTargetVisibleTo } from "./command-authorization";
import { notifyCommandState, recordCommandState } from "./command-runtime";
import { commandActorMatches, createActorCommands } from "./commands";
import { isKeepProtectedDestination, isKeptConversation, keepError } from "./conversation-keep-rules";
import { resolveMailExecution } from "./execution";
import { resolveRoleFolder } from "./folders";
import { enqueueMailInvalidation, mailLive } from "./live";
import { applyStateChange, providerStateChange } from "./local-state-projection";

type ConversationTarget = {
  remote_message_ref_id: string;
  message_id: string;
};

type ConversationProjectionTarget = ConversationTarget & {
  flags: string[];
  keywords: string[];
};

export const createConversationTriageCommands = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  input: ConversationTriageInput;
}): Promise<Result<{ correlationId: string; commands: MailCommand[] }>> => {
  const input = params.input;
  const permission = await requireMailboxAccess(params.context, params.mailboxId, "write");
  if (!permission.ok) return permission;
  const visible = await requireVisibleConversation(permission.data, params.conversationId);
  if (!visible.ok) return visible;
  const requestedMessages = await requireVisibleMessages(permission.data, input.messageIds ?? []);
  if (!requestedMessages.ok) return requestedMessages;
  const conversationId = params.conversationId;
  const sourceFolderId = input.sourceFolderId;
  const roleDestination = input.kind === "move_to_role" ? await resolveRoleFolder(params.mailboxId, input.role) : null;
  if (roleDestination && !roleDestination.ok) return roleDestination;
  const destinationFolderId =
    input.kind === "move_to_folder" ? input.destinationFolderId : roleDestination?.ok ? roleDestination.data.id : null;
  if (destinationFolderId === sourceFolderId) return fail(err.badInput("Source and destination folders must differ"));

  const execution = await resolveMailExecution({
    mailboxId: params.mailboxId,
    operation: "actorMutation",
    context: params.context,
    conversationScoped: true,
    folderRequirements: [
      {
        folderId: sourceFolderId,
        rights: input.kind === "change_state" ? ["write_flags"] : ["read", "move"],
      },
      ...(destinationFolderId ? [{ folderId: destinationFolderId, rights: ["insert"] }] : []),
    ],
  });
  if (!execution.ok) return execution;

  // Every provider copy in the source folder: the same message delivered twice, such as through a list and a Bcc,
  // is one message with two copies, and acting on one of them would leave it unread or in the folder.
  const messageIds = input.messageIds ? toPgUuidArray(input.messageIds) : null;
  const targets = await sql<ConversationTarget[]>`
    SELECT ref.id AS remote_message_ref_id, ref.message_id
    FROM mail.conversation_messages conversation_message
    JOIN mail.conversations conversation ON conversation.id = conversation_message.conversation_id
    JOIN mail.remote_message_refs ref ON ref.message_id = conversation_message.message_id
    JOIN mail.message_placements placement ON placement.remote_message_ref_id = ref.id
    JOIN mail.folders folder ON folder.id = ref.folder_id
    JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
    WHERE conversation.id = ${conversationId}::uuid
      AND conversation.mailbox_id = ${params.mailboxId}::uuid
      AND resource.mailbox_id = ${params.mailboxId}::uuid
      AND ref.folder_id = ${sourceFolderId}::uuid
      AND (${messageIds}::uuid[] IS NULL OR conversation_message.message_id = ANY(${messageIds}::uuid[]))
      AND ref.stale_at IS NULL
      AND placement.deleted_at IS NULL
    ORDER BY conversation_message.position, ref.uid, ref.id
    LIMIT ${MAX_CONVERSATION_ACTION_MESSAGES + 1}
  `;
  // Cloud's own copies of kept messages the server deleted: the server has nothing left to change, so the action
  // changes them in Cloud, together with the commands for the server's messages.
  const keptCopies = sql`
    SELECT placement.remote_message_ref_id, placement.flags, placement.keywords
    FROM mail.conversation_messages link
    JOIN mail.conversations conversation ON conversation.id = link.conversation_id
    JOIN mail.message_placements placement ON placement.message_id = link.message_id
    JOIN mail.remote_message_refs ref ON ref.id = placement.remote_message_ref_id
    WHERE link.conversation_id = ${conversationId}::uuid AND conversation.mailbox_id = ${params.mailboxId}::uuid
      AND ${isKeptConversation(sql`conversation.id`)} AND placement.folder_id = ${sourceFolderId}::uuid
      AND (${messageIds}::uuid[] IS NULL OR link.message_id = ANY(${messageIds}::uuid[]))
      AND placement.deleted_at IS NULL AND ref.stale_at IS NOT NULL
    ORDER BY link.position, placement.remote_message_ref_id
  `;
  const copies = await sql<ConversationProjectionTarget[]>`${keptCopies} LIMIT ${MAX_CONVERSATION_ACTION_MESSAGES + 1}`;
  if (targets.length === 0 && copies.length === 0) return fail(err.notFound("Conversation messages in the selected folder"));
  if (targets.length + copies.length > MAX_CONVERSATION_ACTION_MESSAGES) {
    return fail(err.badInput(`Conversation action exceeds the ${MAX_CONVERSATION_ACTION_MESSAGES}-message safety limit`));
  }
  if (copies.length > 0 && destinationFolderId) {
    const [destination] = await sql<{ blocked: boolean }[]>`
      SELECT ${isKeepProtectedDestination(sql`${destinationFolderId}::uuid`)} AS blocked
    `;
    if (destination?.blocked) return fail(keepError("CONVERSATION_KEPT"));
  }
  const updateKeptCopies = async (tx: typeof sql): Promise<void> => {
    if (copies.length === 0) return;
    // Locks and reads them again: a release may have hidden them, or another action changed them meanwhile.
    const current = await tx<
      ConversationProjectionTarget[]
    >`${keptCopies} LIMIT ${MAX_CONVERSATION_ACTION_MESSAGES} FOR UPDATE OF placement`;
    for (const copy of current) {
      if (input.kind === "change_state") {
        const change = providerStateChange(input.change);
        await tx`
          UPDATE mail.message_placements
          SET
            flags = ${toPgTextArray(applyStateChange(copy.flags, change.addFlags, change.removeFlags))}::text[],
            keywords = ${toPgTextArray(applyStateChange(copy.keywords, change.addKeywords, change.removeKeywords))}::text[],
            updated_at = now()
          WHERE remote_message_ref_id = ${copy.remote_message_ref_id}::uuid
        `;
      } else {
        await tx`
          UPDATE mail.message_placements
          SET folder_id = ${destinationFolderId}::uuid, updated_at = now()
          WHERE remote_message_ref_id = ${copy.remote_message_ref_id}::uuid
        `;
      }
    }
    if (current.length > 0) await enqueueMailInvalidation(tx, { mailboxId: params.mailboxId, conversationId });
  };

  const correlationId = input.correlationId?.trim() || crypto.randomUUID();
  const commands = await createActorCommands({
    context: params.context,
    mailboxId: params.mailboxId,
    inputs: targets.map((target) =>
      input.kind === "change_state"
        ? {
            kind: "change_message_state",
            messageId: target.message_id,
            remoteMessageRefId: target.remote_message_ref_id,
            folderId: sourceFolderId,
            change: input.change,
            idempotencyKey: `${input.idempotencyKey}:${target.remote_message_ref_id}`,
            correlationId,
          }
        : {
            kind: "move",
            messageId: target.message_id,
            remoteMessageRefId: target.remote_message_ref_id,
            sourceFolderId,
            destinationFolderId: destinationFolderId!,
            idempotencyKey: `${input.idempotencyKey}:${target.remote_message_ref_id}`,
            correlationId,
          },
    ),
    afterCreate: async (tx, createdCommands) => {
      await updateKeptCopies(tx);
      if (input.kind !== "change_state") return;
      const change = providerStateChange(input.change);
      // A replay returns an existing command that already projected its change. Projecting it again would
      // overwrite what later commands show, and locking the placement after the replayed command row would
      // take the locks in the opposite order of a rollback, which locks the placement before later commands.
      const fresh = await tx<{ id: string }[]>`
        SELECT id
        FROM mail.commands
        WHERE id = ANY(${toPgUuidArray(createdCommands.map((command) => command.id))}::uuid[])
          AND state IN ('queued', 'executing', 'ambiguous')
          AND NOT (transport_metadata ? 'localStateProjection')
      `;
      const freshIds = new Set(fresh.map((command) => command.id));
      const freshTargets = createdCommands.flatMap((command, index) => {
        const target = targets[index];
        return freshIds.has(command.id) && target ? [{ commandId: command.id, remoteMessageRefId: target.remote_message_ref_id }] : [];
      });
      if (freshTargets.length === 0) return;
      const projectionTargets = await tx<ConversationProjectionTarget[]>`
        SELECT
          placement.remote_message_ref_id,
          placement.flags,
          placement.keywords
        FROM mail.message_placements placement
        WHERE placement.remote_message_ref_id = ANY(${toPgUuidArray(freshTargets.map((target) => target.remoteMessageRefId))}::uuid[])
          AND placement.deleted_at IS NULL
        FOR UPDATE
      `;
      const projectionTargetById = new Map(projectionTargets.map((target) => [target.remote_message_ref_id, target] as const));
      for (const freshTarget of freshTargets) {
        const target = projectionTargetById.get(freshTarget.remoteMessageRefId);
        if (!target) throw new Error("Conversation command target projection changed");
        const flags = applyStateChange(target.flags, change.addFlags, change.removeFlags);
        const keywords = applyStateChange(target.keywords, change.addKeywords, change.removeKeywords);
        await tx`
          UPDATE mail.commands
          SET transport_metadata = transport_metadata || ${{
            localStateProjection: {
              remoteMessageRefId: target.remote_message_ref_id,
              previousFlags: target.flags,
              previousKeywords: target.keywords,
              projectedFlags: flags,
              projectedKeywords: keywords,
            },
          }}::jsonb
          WHERE id = ${freshTarget.commandId}::uuid
        `;
        await tx`
          UPDATE mail.message_placements
          SET
            flags = ${toPgTextArray(flags)}::text[],
            keywords = ${toPgTextArray(keywords)}::text[],
            updated_at = now()
          WHERE remote_message_ref_id = ${target.remote_message_ref_id}::uuid
            AND deleted_at IS NULL
        `;
      }
    },
  });
  if (!commands.ok) return commands;
  if (copies.length > 0) mailLive.wake();
  return ok({ correlationId, commands: commands.data });
};

type TriageUndoCommand = {
  id: string;
  mailbox_id: string;
  state: CommandState;
  actor_kind: ActorRef["kind"];
  actor_id: string | null;
  correlation_id: string | null;
  transport_metadata: Record<string, unknown> | string;
  provider_effect_started_at: Date | string | null;
  message_id: string;
  source_folder_id: string;
  destination_folder_id: string;
};

export const undoConversationTriageCommands = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  input: ConversationTriageUndoInput;
}): Promise<Result<ConversationTriageUndoResult>> => {
  const permission = await requireMailboxAccess(params.context, params.mailboxId, "write");
  if (!permission.ok) return permission;
  const visible = await requireVisibleConversation(permission.data, params.conversationId);
  if (!visible.ok) return visible;
  const input = conversationTriageUndoInputSchema.safeParse(params.input);
  if (!input.success) return fail(err.badInput("Invalid command IDs"));
  const ids = [...new Set(input.data.commandIds)];
  const actor = actorRefFromRequest(params.context);
  const prepared = await sql.begin(async (tx) => {
    // Lock in a stable order, like the runtime claim, and authorize the whole request before cancelling anything.
    const commands = await tx<TriageUndoCommand[]>`
      SELECT c.id, c.mailbox_id, c.state, c.actor_kind, c.actor_id, c.correlation_id,
        c.transport_metadata, c.provider_effect_started_at, ref.message_id,
        c.target ->> 'sourceFolderId' AS source_folder_id,
        c.target ->> 'destinationFolderId' AS destination_folder_id
      FROM mail.commands c
      JOIN mail.remote_message_refs ref ON ref.id = (c.target ->> 'remoteMessageRefId')::uuid
      JOIN mail.conversation_messages link ON link.message_id = ref.message_id
      JOIN mail.conversations conversation ON conversation.id = link.conversation_id
      WHERE c.id = ANY(${toPgUuidArray(ids)}::uuid[])
        AND c.mailbox_id = ${params.mailboxId}::uuid AND c.kind = 'move'
        AND conversation.id = ${params.conversationId}::uuid
        AND conversation.mailbox_id = ${params.mailboxId}::uuid
        AND ${commandTargetVisibleTo(permission.data, sql`c.kind`, sql`c.target`, params.mailboxId, sql`c.id`)}
      ORDER BY c.id
      FOR UPDATE OF c
    `;
    if (commands.length !== ids.length || commands.some((command) => !commandActorMatches(command, actor))) {
      return fail(err.notFound("Mail command"));
    }
    const outcomes = new Map<string, ConversationTriageUndoOutcome>();
    for (const command of commands) {
      let outcome: ConversationTriageUndoOutcome["outcome"];
      if (command.state === "queued" && command.provider_effect_started_at === null) {
        await tx`
          UPDATE mail.commands
          SET state = 'cancelled', finished_at = now(), last_error_code = 'UNDONE',
            last_error_message = 'The action was undone before it ran', updated_at = now()
          WHERE id = ${command.id}::uuid AND state = 'queued' AND provider_effect_started_at IS NULL
        `;
        await recordCommandState(tx, command, "cancelled", "UNDONE");
        outcome = "cancelled";
      } else if (command.state === "failed" || command.state === "cancelled") {
        outcome = "not_applied";
      } else if (command.state === "needs_attention") {
        outcome = "unavailable";
      } else {
        outcome = "pending";
      }
      outcomes.set(command.id, { id: command.id, outcome, inverse: null });
    }
    return ok({ commands, outcomes });
  });
  if (!prepared.ok) return prepared;
  const { commands, outcomes } = prepared.data;
  for (const command of commands) {
    if (outcomes.get(command.id)?.outcome === "cancelled") await notifyCommandState(command, "cancelled");
  }

  const reversible = commands.filter((command) => command.state === "confirmed" || command.state === "reconciled");
  // A completed inverse may already have removed its source placement. Read replays before resolving a new provider copy.
  const replays = reversible.length
    ? await sql<
        (MailCommandOutcome & {
          idempotency_key: string;
          actor_kind: ActorRef["kind"];
          actor_id: string | null;
          kind: string;
          message_id: string | null;
          source_folder_id: string | null;
          destination_folder_id: string | null;
        })[]
      >`
        SELECT c.id, c.state, c.last_error_code AS code, c.idempotency_key, c.actor_kind, c.actor_id, c.kind,
          ref.message_id, c.target ->> 'sourceFolderId' AS source_folder_id,
          c.target ->> 'destinationFolderId' AS destination_folder_id
        FROM mail.commands c
        LEFT JOIN mail.remote_message_refs ref ON ref.id = (c.target ->> 'remoteMessageRefId')::uuid
        WHERE c.mailbox_id = ${params.mailboxId}::uuid
          AND c.idempotency_key = ANY(${toPgTextArray(reversible.map((command) => `undo:${command.id}`))}::text[])
          AND ${commandTargetVisibleTo(permission.data, sql`c.kind`, sql`c.target`, params.mailboxId, sql`c.id`)}
      `
    : [];
  const replayByKey = new Map(replays.map((command) => [command.idempotency_key, command]));
  const inverseIds: string[] = [];
  for (const command of reversible) {
    const outcome = outcomes.get(command.id)!;
    const idempotencyKey = `undo:${command.id}`;
    const replay = replayByKey.get(idempotencyKey);
    if (replay) {
      outcome.outcome =
        commandActorMatches(replay, actor) &&
        replay.kind === "move" &&
        replay.message_id === command.message_id &&
        replay.source_folder_id === command.destination_folder_id &&
        replay.destination_folder_id === command.source_folder_id
          ? "reversed"
          : "unavailable";
      if (outcome.outcome === "reversed") outcome.inverse = { id: replay.id, state: replay.state, code: replay.code };
      continue;
    }
    const inverse = await createActorCommands({
      context: params.context,
      mailboxId: params.mailboxId,
      inputs: [
        {
          kind: "move",
          messageId: command.message_id,
          sourceFolderId: command.destination_folder_id,
          destinationFolderId: command.source_folder_id,
          idempotencyKey,
          correlationId: command.correlation_id ?? undefined,
        },
      ],
    });
    if (!inverse.ok) {
      outcome.outcome =
        inverse.error.code === "NOT_FOUND" && inverse.error.message === err.notFound("Message placement").message
          ? "pending"
          : "unavailable";
      continue;
    }
    const created = inverse.data[0]!;
    outcome.outcome = "reversed";
    outcome.inverse = { id: created.id, state: created.state, code: null };
    inverseIds.push(created.id);
  }
  if (inverseIds.length > 0) {
    const inverseOutcomes = await sql<MailCommandOutcome[]>`
      SELECT id, state, last_error_code AS code FROM mail.commands WHERE id = ANY(${toPgUuidArray(inverseIds)}::uuid[])
    `;
    const inverseById = new Map(inverseOutcomes.map((command) => [command.id, command]));
    for (const outcome of outcomes.values()) {
      if (outcome.inverse && inverseById.has(outcome.inverse.id)) outcome.inverse = inverseById.get(outcome.inverse.id)!;
    }
  }
  return ok({ commands: input.data.commandIds.map((id) => outcomes.get(id)!) });
};
