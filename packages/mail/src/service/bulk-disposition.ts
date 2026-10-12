import { ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { MailingListDispositionResult } from "../contracts";
import type { MailRequestContext } from "./auth";
import { createActorCommands } from "./commands";
import { isKeepProtectedDestination, isKeptMessage } from "./conversation-keep-rules";
import { gmailAllMailFoldersSql } from "./folders";

export const DISPOSITION_LIMIT = 500;

type DispositionTarget = {
  remote_message_ref_id: string;
  message_id: string;
  source_folder_id: string;
};

const liveCopyExists = (condition: Bun.SQL.Query<unknown>) => sql`EXISTS (
  SELECT 1 FROM mail.message_placements copy
  JOIN mail.remote_message_refs copy_ref ON copy_ref.id = copy.remote_message_ref_id AND copy_ref.stale_at IS NULL
  JOIN mail.folders copy_folder ON copy_folder.id = copy.folder_id AND copy_folder.discovery_state = 'active'
  JOIN mail.remote_resources copy_resource ON copy_resource.id = copy_folder.remote_resource_id
  LEFT JOIN mail.folder_role_overrides copy_role
    ON copy_role.folder_id = copy_folder.id AND copy_role.mailbox_id = resource.mailbox_id
  WHERE copy.message_id = message.id
    AND copy.deleted_at IS NULL
    AND copy_resource.mailbox_id = resource.mailbox_id
    AND ${condition}
)`;

export const queueBulkMoves = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  destinationFolderId: string;
  idempotencyKey: string;
  // matches can reference message, resource, remote_ref, placement, folder and role_override.
  matches: Bun.SQL.Query<unknown>;
}): Promise<Result<MailingListDispositionResult>> => {
  const targets = await sql<DispositionTarget[]>`
    WITH gmail_folders AS (
      ${gmailAllMailFoldersSql(sql`${params.mailboxId}::uuid`)}
    ), provider AS (
      SELECT CASE WHEN count(*) = 1 THEN min(id::text)::uuid END AS all_folder_id FROM gmail_folders
    )
    SELECT DISTINCT ON (CASE WHEN provider.all_folder_id IS NULL THEN remote_ref.id ELSE message.id END)
      remote_ref.id AS remote_message_ref_id,
      message.id AS message_id,
      folder.id AS source_folder_id
    FROM mail.message_contents message
    JOIN mail.remote_message_refs remote_ref ON remote_ref.message_id = message.id AND remote_ref.stale_at IS NULL
    JOIN mail.message_placements placement ON placement.remote_message_ref_id = remote_ref.id AND placement.deleted_at IS NULL
    JOIN mail.folders folder ON folder.id = placement.folder_id AND folder.discovery_state = 'active'
    JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
    LEFT JOIN mail.folder_role_overrides role_override
      ON role_override.folder_id = folder.id AND role_override.mailbox_id = resource.mailbox_id
    CROSS JOIN provider
    WHERE message.mailbox_id = ${params.mailboxId}::uuid
      AND resource.mailbox_id = ${params.mailboxId}::uuid
      AND ${params.matches}
      AND folder.id <> ${params.destinationFolderId}::uuid
      AND COALESCE(role_override.role, folder.role) NOT IN ('sent', 'drafts', 'trash', 'junk')
      AND NOT (
        ${isKeepProtectedDestination(sql`${params.destinationFolderId}::uuid`)}
        AND ${isKeptMessage(sql`message.id`)}
      )
      AND (
        provider.all_folder_id IS NULL OR (
          NOT ${liveCopyExists(sql`COALESCE(copy_role.role, copy_folder.role) IN ('sent', 'drafts', 'trash', 'junk')`)}
          AND (
            COALESCE(role_override.role, folder.role) = 'inbox'
            OR (folder.id = provider.all_folder_id AND NOT ${liveCopyExists(sql`copy.folder_id = ${params.destinationFolderId}::uuid`)})
          )
        )
      )
    ORDER BY CASE WHEN provider.all_folder_id IS NULL THEN remote_ref.id ELSE message.id END,
      CASE WHEN provider.all_folder_id IS NOT NULL AND COALESCE(role_override.role, folder.role) = 'inbox' THEN 0 ELSE 1 END,
      placement.updated_at DESC, folder.id, remote_ref.id
    LIMIT ${DISPOSITION_LIMIT + 1}
  `;
  const limited = targets.slice(0, DISPOSITION_LIMIT);
  if (!limited.length) return ok({ commandCount: 0, truncated: false });
  const commands = await createActorCommands({
    context: params.context,
    mailboxId: params.mailboxId,
    inputs: limited.map((target) => ({
      kind: "move" as const,
      messageId: target.message_id,
      remoteMessageRefId: target.remote_message_ref_id,
      sourceFolderId: target.source_folder_id,
      destinationFolderId: params.destinationFolderId,
      idempotencyKey: `${params.idempotencyKey}:${target.remote_message_ref_id}`,
      correlationId: params.idempotencyKey,
    })),
  });
  if (!commands.ok) return commands;
  return ok({ commandCount: commands.data.length, truncated: targets.length > DISPOSITION_LIMIT });
};
