import { fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";

/**
 * The rules that keep a kept conversation's mail: SQL conditions, the refusal of deleting commands, and the
 * placements that show Cloud's copy once the mail server lost a message. Read models, sync, and command creation
 * share them; this module imports no Mail service, so it cannot take part in an import cycle.
 */

type SqlFragment = Bun.SQL.Query<unknown>;
type SqlClient = typeof sql;

export const isKeptConversation = (id: SqlFragment): SqlFragment => sql`EXISTS (
  SELECT 1 FROM mail.conversation_keeps keep WHERE keep.conversation_id = ${id}
)`;
export const isKeptMessage = (id: SqlFragment): SqlFragment => sql`EXISTS (
  SELECT 1 FROM mail.conversation_messages keep_link
  JOIN mail.conversation_keeps keep ON keep.conversation_id = keep_link.conversation_id
  WHERE keep_link.message_id = ${id}
)`;
export const keepErrors = {
  CONVERSATION_KEPT:
    "This conversation is kept, so it can't be deleted or moved to Trash, Junk, or Drafts. You can still move or archive it.",
  FOLDER_HAS_KEPT_CONVERSATIONS: "This folder contains kept conversations, so it can't be deleted. Move them to another folder first.",
  KEPT_COPY_ONLY: "Only Cloud's kept copy of these messages is left, so they can't be changed on the mail server.",
} as const;
export const keepError = (code: keyof typeof keepErrors) => ({ code, message: String(keepErrors[code]), status: 409 as const });

/** Accept both public names and IMAP spelling; IMAP system flags are case insensitive. */
export const containsDeletedFlag = (flags: unknown): boolean =>
  Array.isArray(flags) && flags.some((flag) => typeof flag === "string" && flag.trim().replace(/^\\/, "").toLowerCase() === "deleted");

/**
 * A folder a kept message must not be moved to, by the provider's role or the one configured in Mail: Trash and Junk
 * lose mail on their own, and Mail imports whatever lands in Drafts as a draft, which discarding deletes on the server.
 */
export const isKeepProtectedDestination = (folderId: SqlFragment): SqlFragment => sql`EXISTS (
  SELECT 1
  FROM mail.folders destination
  JOIN mail.remote_resources destination_resource ON destination_resource.id = destination.remote_resource_id
  LEFT JOIN mail.folder_role_overrides destination_role
    ON destination_role.mailbox_id = destination_resource.mailbox_id AND destination_role.folder_id = destination.id
  WHERE destination.id = ${folderId}
    AND (destination.role IN ('trash', 'junk', 'drafts') OR destination_role.role IN ('trash', 'junk', 'drafts'))
)`;

/**
 * Restore one last placement after the server disappears; run after hiding in the same transaction. With `folderId`,
 * the restored copy shows in that folder, such as the destination of a move whose new copy no sync has seen yet.
 */
export const keepLastKeptPlacements = async (db: SqlClient, remoteRefIds: readonly string[], folderId?: string): Promise<void> => {
  if (!remoteRefIds.length) return;
  await db`UPDATE mail.message_placements placement
    SET deleted_at = NULL, folder_id = COALESCE(${folderId ?? null}::uuid, placement.folder_id)
    FROM (
      SELECT DISTINCT ON (candidate.message_id) candidate.remote_message_ref_id
      FROM mail.message_placements candidate
      JOIN mail.remote_message_refs candidate_ref ON candidate_ref.id = candidate.remote_message_ref_id
      WHERE candidate.remote_message_ref_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${remoteRefIds}::jsonb))
        AND candidate_ref.stale_at IS NOT NULL AND ${isKeptMessage(sql`candidate.message_id`)}
        AND NOT EXISTS (SELECT 1 FROM mail.message_placements live
          JOIN mail.remote_message_refs live_ref ON live_ref.id = live.remote_message_ref_id
          WHERE live.message_id = candidate.message_id AND live.deleted_at IS NULL AND live_ref.stale_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM mail.message_placements kept_copy
          WHERE kept_copy.message_id = candidate.message_id AND kept_copy.deleted_at IS NULL)
      ORDER BY candidate.message_id, candidate.updated_at DESC, candidate.remote_message_ref_id DESC
    ) restored WHERE placement.remote_message_ref_id = restored.remote_message_ref_id`;
};
export const retireKeptCopyPlacements = async (db: SqlClient, messageId: string, remoteRefId: string): Promise<void> => {
  await db`UPDATE mail.message_placements placement SET deleted_at = now(), updated_at = now()
    FROM mail.remote_message_refs ref
    WHERE placement.message_id = ${messageId}::uuid AND placement.remote_message_ref_id <> ${remoteRefId}::uuid
      AND placement.remote_message_ref_id = ref.id AND ref.stale_at IS NOT NULL AND placement.deleted_at IS NULL`;
};

/**
 * Refuses a command that would delete a kept conversation's message: a delete, a move to Trash, Junk, or Drafts, a
 * `\Deleted` flag, or deleting a folder that holds such a message. Command creation runs it under the mailbox lock
 * that keeping a conversation also takes; the runtime runs it again right before a fresh provider effect.
 */
export const checkCommandKeepProtection = async (
  db: SqlClient,
  command: { kind: string; target: Record<string, unknown>; payload: Record<string, unknown> },
): Promise<Result<void>> => {
  const { kind, target, payload } = command;
  const folderDelete = kind === "delete_folder";
  const destructive =
    kind === "delete" ||
    folderDelete ||
    kind === "move" ||
    (kind === "set_flags" && containsDeletedFlag(payload.flags)) ||
    (kind === "change_message_state" && containsDeletedFlag(payload.addFlags));
  if (!destructive) return ok();
  const refId = typeof target.remoteMessageRefId === "string" ? target.remoteMessageRefId : null;
  const folderId = typeof target.folderId === "string" ? target.folderId : null;
  if (kind === "move") {
    const destinationId = typeof target.destinationFolderId === "string" ? target.destinationFolderId : null;
    const [destination] = await db<{ removes: boolean }[]>`
      SELECT ${isKeepProtectedDestination(sql`${destinationId}::uuid`)} AS removes
    `;
    if (!destination?.removes) return ok();
  }
  const [blocked] = await db`
    SELECT 1
    FROM mail.message_placements placement
    JOIN mail.conversation_messages link ON link.message_id = placement.message_id
    JOIN mail.conversation_keeps keep ON keep.conversation_id = link.conversation_id
    WHERE ${
      folderDelete
        ? sql`placement.folder_id = ${folderId}::uuid AND placement.deleted_at IS NULL`
        : sql`placement.remote_message_ref_id = ${refId}::uuid`
    }
    LIMIT 1
  `;
  return blocked ? fail(keepError(folderDelete ? "FOLDER_HAS_KEPT_CONVERSATIONS" : "CONVERSATION_KEPT")) : ok();
};
