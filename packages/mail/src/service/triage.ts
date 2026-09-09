import { err, fail, ok, type Result } from "@k2b/stdlib";
import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type { ConversationTriageInput, MailCommand } from "../contracts";
import { requireMailboxPermission } from "./access";
import type { MailRequestContext } from "./auth";
import { createActorCommands } from "./commands";
import { resolveMailExecution } from "./execution";
import { resolveRoleFolder } from "./folders";

const MAX_CONVERSATION_TARGETS = 500;

type ConversationTarget = {
  remote_message_ref_id: string;
  message_id: string;
};

type ConversationProjectionTarget = ConversationTarget & {
  flags: string[];
  keywords: string[];
};

const IMAP_SYSTEM_FLAGS = {
  seen: "\\Seen",
  answered: "\\Answered",
  flagged: "\\Flagged",
  draft: "\\Draft",
} as const;

const applyStateChange = (current: string[], additions: string[], removals: string[]): string[] => {
  const removed = new Set(removals.map((value) => value.toLowerCase()));
  const next = current.filter((value) => !removed.has(value.toLowerCase()));
  const present = new Set(next.map((value) => value.toLowerCase()));
  for (const value of additions) {
    if (present.has(value.toLowerCase())) continue;
    next.push(value);
    present.add(value.toLowerCase());
  }
  return next.sort((left, right) => left.localeCompare(right));
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

  const targets = await sql<ConversationTarget[]>`
    SELECT ref.id AS remote_message_ref_id, message.id AS message_id
    FROM mail.conversation_messages conversation_message
    JOIN mail.conversations conversation ON conversation.id = conversation_message.conversation_id
    JOIN mail.remote_message_refs ref ON ref.message_id = conversation_message.message_id
    JOIN mail.message_contents message ON message.id = ref.message_id
    JOIN mail.message_placements placement ON placement.remote_message_ref_id = ref.id
    JOIN mail.folders folder ON folder.id = ref.folder_id
    JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
    WHERE conversation.id = ${conversationId}::uuid
      AND conversation.mailbox_id = ${params.mailboxId}::uuid
      AND resource.mailbox_id = ${params.mailboxId}::uuid
      AND ref.folder_id = ${sourceFolderId}::uuid
      AND ref.stale_at IS NULL
      AND placement.deleted_at IS NULL
    ORDER BY conversation_message.position, ref.uid
    LIMIT ${MAX_CONVERSATION_TARGETS + 1}
  `;
  if (targets.length === 0) return fail(err.notFound("Conversation messages in the selected folder"));
  if (targets.length > MAX_CONVERSATION_TARGETS) {
    return fail(err.badInput(`Conversation action exceeds the ${MAX_CONVERSATION_TARGETS}-message safety limit`));
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
            folderId: sourceFolderId,
            change: input.change,
            idempotencyKey: `${input.idempotencyKey}:${target.remote_message_ref_id}`,
            correlationId,
          }
        : {
            kind: "move",
            messageId: target.message_id,
            sourceFolderId,
            destinationFolderId: destinationFolderId!,
            idempotencyKey: `${input.idempotencyKey}:${target.remote_message_ref_id}`,
            correlationId,
          },
    ),
    afterCreate:
      input.kind === "change_state"
        ? async (tx, createdCommands) => {
            const addedFlags = input.change.addFlags.map((flag) => IMAP_SYSTEM_FLAGS[flag]);
            const removedFlags = input.change.removeFlags.map((flag) => IMAP_SYSTEM_FLAGS[flag]);
            const projectionTargets = await tx<ConversationProjectionTarget[]>`
              SELECT
                placement.remote_message_ref_id,
                placement.flags,
                placement.keywords
              FROM mail.message_placements placement
              WHERE placement.remote_message_ref_id = ANY(${toPgUuidArray(targets.map((target) => target.remote_message_ref_id))}::uuid[])
                AND placement.deleted_at IS NULL
              FOR UPDATE
            `;
            const projectionTargetById = new Map(projectionTargets.map((target) => [target.remote_message_ref_id, target] as const));
            for (const [index, command] of createdCommands.entries()) {
              if (!["queued", "executing", "ambiguous"].includes(command.state)) continue;
              const commandTarget = targets[index];
              const target = commandTarget ? projectionTargetById.get(commandTarget.remote_message_ref_id) : null;
              if (!target) throw new Error("Conversation command target projection changed");
              const flags = applyStateChange(target.flags, addedFlags, removedFlags);
              const keywords = applyStateChange(target.keywords, input.change.addKeywords, input.change.removeKeywords);
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
                WHERE id = ${command.id}::uuid
                  AND NOT (transport_metadata ? 'localStateProjection')
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
