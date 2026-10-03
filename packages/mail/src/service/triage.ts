import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { type ConversationTriageInput, MAX_CONVERSATION_ACTION_MESSAGES, type MailCommand } from "../contracts";
import { requireMailboxPermission } from "./access";
import type { MailRequestContext } from "./auth";
import { createActorCommands } from "./commands";
import { resolveMailExecution } from "./execution";
import { resolveRoleFolder } from "./folders";
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
  const permission = await requireMailboxPermission(params.context, params.mailboxId, "write");
  if (!permission.ok) return permission;
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
  if (targets.length === 0) return fail(err.notFound("Conversation messages in the selected folder"));
  if (targets.length > MAX_CONVERSATION_ACTION_MESSAGES) {
    return fail(err.badInput(`Conversation action exceeds the ${MAX_CONVERSATION_ACTION_MESSAGES}-message safety limit`));
  }

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
    afterCreate:
      input.kind === "change_state"
        ? async (tx, createdCommands) => {
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
              return freshIds.has(command.id) && target
                ? [{ commandId: command.id, remoteMessageRefId: target.remote_message_ref_id }]
                : [];
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
          }
        : undefined,
  });
  if (!commands.ok) return commands;
  return ok({ correlationId, commands: commands.data });
};
