import { sql } from "bun";
import type { ConversationView } from "../contracts";

type SqlFragment = Bun.SQL.Query<unknown>;

/** The views of open or postponed work; they leave out conversations that are only in Trash or Junk. */
export const FOLLOW_UP_VIEWS: readonly ConversationView[] = ["needs_action", "mine", "unassigned", "waiting", "snoozed"];

/** Whether a folder has one of these roles, by its configured role or else the provider's, as the folder list shows it. */
const hasFolderRole = (folderId: SqlFragment, roles: readonly string[]): SqlFragment => sql`EXISTS (
  SELECT 1
  FROM mail.folders scope_folder
  JOIN mail.remote_resources scope_resource ON scope_resource.id = scope_folder.remote_resource_id
  LEFT JOIN mail.folder_role_overrides scope_role
    ON scope_role.mailbox_id = scope_resource.mailbox_id
   AND scope_role.folder_id = scope_folder.id
  WHERE scope_folder.id = ${folderId}
    AND COALESCE(scope_role.role, scope_folder.role) IN (SELECT value FROM jsonb_array_elements_text(${roles}::jsonb))
)`;

/** Whether a folder is the mailbox's Trash or Junk. */
export const isTrashOrJunkFolder = (folderId: SqlFragment): SqlFragment => hasFolderRole(folderId, ["trash", "junk"]);

/** Whether a folder is the mailbox's Sent folder. */
export const isSentFolder = (folderId: SqlFragment): SqlFragment => hasFolderRole(folderId, ["sent"]);

/** Whether a folder is the mailbox's Inbox. */
export const isInboxFolder = (folderId: SqlFragment): SqlFragment => hasFolderRole(folderId, ["inbox"]);

/**
 * Whether one message, joined with one of its live placements or with none (`placement` is null),
 * puts its conversation in the follow-up views: the copy is filed outside Trash and Junk, or the
 * message has no copy yet and `hasOpenSubmission` says it is on its way out.
 */
export const isFollowUpMessage = (placement: SqlFragment, hasOpenSubmission: SqlFragment): SqlFragment => sql`(
  (${placement}.message_id IS NOT NULL AND NOT ${isTrashOrJunkFolder(sql`${placement}.folder_id`)})
  OR (${placement}.message_id IS NULL AND ${hasOpenSubmission})
)`;

/**
 * Whether a conversation belongs in the follow-up views and their counts: one of its messages is
 * filed outside Trash and Junk, or is an outgoing message the provider holds no copy of yet. Spam
 * the provider files into Junk and mail someone deleted need no follow-up. The conversation keeps
 * its work state, so moving it back out of Trash or Junk shows it again where it was.
 */
export const isFollowUpConversation = (conversationId: SqlFragment): SqlFragment => sql`EXISTS (
  SELECT 1
  FROM mail.conversation_messages scope_link
  LEFT JOIN mail.message_placements scope_placement
    ON scope_placement.message_id = scope_link.message_id
   AND scope_placement.deleted_at IS NULL
  WHERE scope_link.conversation_id = ${conversationId}
    AND ${isFollowUpMessage(
      sql`scope_placement`,
      sql`EXISTS (
        SELECT 1
        FROM mail.outbox_submissions scope_outbox
        WHERE scope_outbox.message_id = scope_link.message_id
          AND scope_outbox.state <> 'cancelled'
      )`,
    )}
)`;
