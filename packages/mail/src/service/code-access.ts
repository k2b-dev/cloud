import { type CodeAccessAdapter, type CodeAccessDecision, sql } from "@k2b/cloud";
import { listUsersWithAccess } from "@k2b/cloud/server";
import { ResourceShortIdSchema } from "../contracts";
import { requireMailboxPermission } from "./access";

/** Mail's minimum mailbox level per capability. null means no non-manager level can cover it. */
export const MAIL_CODE_OPERATION_LEVELS = {
  search: "read",
  "mailbox.browse": "read",
  "mailbox.list": "read",
  "mailbox.read": "read",
  "mailbox.identity.list": "read",
  "mailbox.member.list": "read",
  "folder.list": "read",
  "conversation.list": "read",
  "conversation.focus": "read",
  "conversation.search": "read",
  "conversation.related": "read",
  "conversation.read": "read",
  "message.list": "read",
  "message.read-content": "read",
  "message.read": "read",
  "attachment.read": "read",
  "attachment.read-content": "read",
  "draft.list": "read",
  "draft.read": "read",
  "draft.send.check": "read",
  "draft.send.review": "write",
  "mailbox.tag.list": "read",
  "conversation.comment.list": "read",
  "comment.read": "read",
  "conversation.activity.list": "read",
  "conversation.reminder.get": "read",
  "reminder.read": "read",
  "delivery.list": "read",
  "delivery.read": "read",
  "mailing-list.subscription.list": "read",
  "mailing-list.subscription.get": "read",
  "draft.patch": "write",
  "draft.create": "write",
  "draft.update": "write",
  "draft.discard": "write",
  "draft.attachment.add": "write",
  "draft.attachment.remove": "write",
  "draft.send": "write",
  "delivery.cancel": "write",
  "conversation.mark": "write",
  "conversation.move": "write",
  "conversation.tag.update": "write",
  "conversation.assign": "write",
  "conversation.assign.batch": "write",
  "conversation.status.update.batch": "write",
  "conversation.status.update": "write",
  "conversation.keep": "write",
  "conversation.keep.release": null,
  "conversation.snooze": "write",
  "conversation.reminder.set": "write",
  "conversation.reminder.cancel": "write",
  "conversation.comment.create": "write",
  "conversation.comment.update": "write",
  "conversation.comment.delete": "write",
  "folder.display.set": null,
  "mailbox.tag.create": "write",
  "mailbox.tag.update": "write",
  "mailbox.tag.delete": "write",
  "mailing-list.unsubscribe": "write",
} as const;

/** Unknown, foreign and administrative operations refuse the whole grant. Empty sets are owner probes only. */
export const mailboxCodeAccessDecision = (operations: readonly string[], dryRun: boolean): CodeAccessDecision => {
  if (!operations.length && !dryRun) return { granted: false, reason: "Mail requires at least one operation." };
  let level: "read" | "write" = "read";
  const levels: Readonly<Record<string, "read" | "write" | null>> = MAIL_CODE_OPERATION_LEVELS;
  for (const operation of operations) {
    const required =
      operation.startsWith("mail.") && Object.hasOwn(levels, operation.slice("mail.".length))
        ? levels[operation.slice("mail.".length)]
        : undefined;
    if (!required) return { granted: false, reason: `Mail cannot grant a non-manager level for ${operation}.` };
    if (required === "write") level = "write";
  }
  return { granted: true, level };
};

/** Core owns proof validation, admission, transaction, grant tombstones and audit. Mail owns the live share. */
export const mailboxCodeAccess: CodeAccessAdapter = {
  manages: async (context, id) => {
    if (context.actor.kind !== "user" || context.accessSubject.type !== "user" || !ResourceShortIdSchema.safeParse(id).success)
      return false;
    const [mailbox] = await sql<{ id: string }[]>`
      SELECT id FROM mail.mailboxes WHERE short_id = ${id} AND deleted_at IS NULL
    `;
    return Boolean(mailbox && (await requireMailboxPermission(context, mailbox.id, "admin")).ok);
  },
  grant: async (tx, input) => {
    const decision = mailboxCodeAccessDecision(input.operations, input.dryRun);
    if (!decision.granted) return decision;
    if (!ResourceShortIdSchema.safeParse(input.id).success) return { granted: false, reason: "Mailbox not found." };
    const [mailbox] = await tx<{ id: string }[]>`
      SELECT id FROM mail.mailboxes WHERE short_id = ${input.id} AND deleted_at IS NULL FOR UPDATE
    `;
    if (!mailbox) return { granted: false, reason: "Mailbox not found." };
    const access = await tx<{ access_id: string }[]>`SELECT ma.access_id FROM mail.mailbox_access ma
      JOIN auth.access a ON a.id=ma.access_id WHERE ma.mailbox_id=${mailbox.id}::uuid AND a.permission='admin'`;
    // Page concrete people through the shared access resolver. Its 500-person page
    // bound does not truncate the notification audience, including nested groups.
    const managerUserIds: string[] = [];
    let cursor: string | null = null;
    while (true) {
      const people: { id: string }[] = await tx`SELECT id FROM auth.users WHERE (${cursor}::uuid IS NULL OR id>${cursor}::uuid)
        AND (account_expires IS NULL OR account_expires>statement_timestamp()) ORDER BY id LIMIT 500`;
      if (!people.length) break;
      const managers = await listUsersWithAccess({
        accessIds: access.map((entry) => entry.access_id),
        userIds: people.map((person) => person.id),
        minimumPermission: "admin",
        limit: 500,
        db: tx,
      });
      managerUserIds.push(...managers.map((person) => person.id));
      cursor = people.at(-1)!.id;
    }
    const result = { ...decision, managerUserIds };
    const [account] = await tx`
      SELECT id FROM auth.service_accounts WHERE id = ${input.principal}::uuid AND kind = 'code' AND status = 'active' FOR SHARE
    `;
    if (!account) return { granted: false, reason: "An active Code account is required." };
    // Each activation gets its own access row, including overlapping grants at one mailbox.
    // Never replace another grant or an ordinary share on an identity collision.
    const [existing] = await tx<{ service_account_id: string | null; permission: string; mailbox_id: string | null }[]>`
      SELECT a.service_account_id, a.permission, ma.mailbox_id
      FROM auth.access a LEFT JOIN mail.mailbox_access ma ON ma.access_id = a.id
      WHERE a.id = ${input.grantId}::uuid
    `;
    if (existing) {
      return existing.service_account_id === input.principal && existing.mailbox_id === mailbox.id && existing.permission === decision.level
        ? result
        : { granted: false, reason: "Grant identity already belongs to another share." };
    }
    if (input.dryRun) return result;
    await tx`INSERT INTO auth.access (id, service_account_id, permission)
      VALUES (${input.grantId}::uuid, ${input.principal}::uuid, ${decision.level}::auth.permission_level)`;
    await tx`INSERT INTO mail.mailbox_access (mailbox_id, access_id) VALUES (${mailbox.id}::uuid, ${input.grantId}::uuid)`;
    return result;
  },
  revoke: async (tx, { id, grantId }) => {
    // Include soft-deleted mailboxes: Core must still be able to clean up their grants.
    const removed = await tx`
      DELETE FROM auth.access a USING mail.mailbox_access ma, mail.mailboxes mailbox, auth.service_accounts account
      WHERE a.id = ${grantId}::uuid AND ma.access_id = a.id AND ma.mailbox_id = mailbox.id AND mailbox.short_id = ${id}
        AND account.id = a.service_account_id AND account.kind = 'code'
    `;
    return removed.count > 0;
  },
  list: async (tx, { principal }) =>
    tx<{ grantId: string; id: string; level: "read" | "write" }[]>`
      SELECT a.id AS "grantId", mailbox.short_id AS id, a.permission AS level
      FROM mail.mailbox_access ma
      JOIN auth.access a ON a.id = ma.access_id
      JOIN auth.service_accounts account ON account.id = a.service_account_id AND account.kind = 'code'
      JOIN mail.mailboxes mailbox ON mailbox.id = ma.mailbox_id
      WHERE a.service_account_id = ${principal}::uuid AND a.permission IN ('read', 'write')
      ORDER BY mailbox.short_id, a.id
    `,
};
