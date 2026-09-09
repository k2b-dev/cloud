import type { PermissionLevel } from "@k2b/cloud/server";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { getMailboxPermission } from "./access";
import type { MailRequestContext } from "./auth";
import type { SqlClient } from "./workflow-data";

export const requireAutomaticReplyManagementPermission = async (
  context: MailRequestContext,
  mailboxId: string,
  db: SqlClient = sql,
): Promise<Result<PermissionLevel>> => {
  const permission = await getMailboxPermission(context, mailboxId, db);
  if (permission === "none" || permission === "read") return fail(err.forbidden("Access denied"));
  if (permission === "admin") return ok(permission);

  const [mailbox] = await db<{ automatic_reply_management_permission: "write" | "admin" }[]>`
    SELECT automatic_reply_management_permission
    FROM mail.mailboxes
    WHERE id = ${mailboxId}::uuid AND deleted_at IS NULL
  `;
  if (!mailbox) return fail(err.notFound("Mailbox"));
  return mailbox.automatic_reply_management_permission === "write" ? ok(permission) : fail(err.forbidden("Access denied"));
};
