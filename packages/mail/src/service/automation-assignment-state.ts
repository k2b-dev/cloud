import type { sql } from "bun";

type SqlClient = typeof sql;

/** Lock in the collaboration service's order: mailbox, then conversation. */
export const checkMailWorkflowAssignment = async (
  db: SqlClient,
  params: { mailboxId: string; workflowVersionId: string; conversationId: string },
): Promise<{ revision: number; assigneeUserIds: string[]; skipped: "already_assigned" | "undone_before" | null }> => {
  await db`SELECT id FROM mail.mailboxes WHERE id = ${params.mailboxId}::uuid AND deleted_at IS NULL FOR SHARE`;
  const [conversation] = await db<{ revision: string | number }[]>`
    SELECT revision FROM mail.conversations
    WHERE id = ${params.conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid FOR UPDATE
  `;
  if (!conversation) throw Object.assign(new Error("Conversation is no longer available"), { code: "NOT_FOUND" });
  const assignees = await db<{ user_id: string }[]>`
    SELECT user_id FROM mail.conversation_assignees WHERE conversation_id = ${params.conversationId}::uuid
  `;
  const [undone] = await db<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM mail.automation_assignment_undone undone
      JOIN workflows.version version ON version.workflow_id = undone.workflow_id
      WHERE undone.conversation_id = ${params.conversationId}::uuid
        AND undone.mailbox_id = ${params.mailboxId}::uuid AND version.id = ${params.workflowVersionId}::uuid
    ) AS present
  `;
  return {
    revision: Number(conversation.revision),
    assigneeUserIds: assignees.map((row) => row.user_id),
    skipped: undone?.present ? "undone_before" : assignees.length ? "already_assigned" : null,
  };
};
