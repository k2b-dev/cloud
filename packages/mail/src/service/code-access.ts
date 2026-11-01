import { type CodeAccessAdapter, type CodeAccessDecision, sql } from "@k2b/cloud";
import { CAPABILITY_MAX_RESULT_BYTES } from "@k2b/cloud/contracts";
import { listUsersWithAccess } from "@k2b/cloud/server";
import { ResourceShortIdSchema } from "../contracts";

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

/** Target edits take FOR UPDATE; shared locks compose across multi-target Code listings. */
const lockTarget = async (tx: SQL, id: string, includeDeleted = false) => {
  const [target] = await tx<{ id: string }[]>`
    SELECT id FROM mail.mailboxes WHERE short_id = ${id} AND (${includeDeleted} OR deleted_at IS NULL) FOR SHARE
  `;
  return target ?? null;
};

/** Expand current person managers, respecting the directory's same-provider nesting rule.
 * Assigned-only Mail grants and service accounts never count as people managing the target.
 */
const managerUserIds = async (tx: SQL, id: string): Promise<string[] | null> => {
  const rows = await tx<{ id: string }[]>`
    WITH RECURSIVE manager_grants AS (
      SELECT a.* FROM auth.access a JOIN mail.mailbox_access grants ON grants.access_id = a.id
      WHERE grants.mailbox_id = ${id}::uuid AND a.permission = 'admin'
    ), manager_groups AS (
      SELECT g.id, g.provider FROM manager_grants a JOIN auth.groups g ON g.id = a.group_id
      UNION
      SELECT child.id, child.provider FROM manager_groups parent
      JOIN auth.group_groups_v2 edge ON edge.parent_group_id = parent.id
      JOIN auth.groups child ON child.id = edge.child_group_id AND child.provider = parent.provider
    ), manager_users AS (
      SELECT user_id AS id FROM manager_grants WHERE user_id IS NOT NULL
      UNION
      SELECT membership.user_id FROM auth.user_groups_v2 membership JOIN manager_groups g ON g.id = membership.group_id
      UNION
      SELECT id FROM auth.users WHERE EXISTS (
        SELECT 1 FROM manager_grants WHERE user_id IS NULL AND group_id IS NULL AND service_account_id IS NULL
      )
    )
    SELECT u.id FROM auth.users u JOIN manager_users managers ON managers.id = u.id
    WHERE u.account_expires IS NULL OR u.account_expires > statement_timestamp()
    ORDER BY u.id LIMIT ${CODE_ACCESS_MAX_MANAGER_USER_IDS + 1}
  `;
  return rows.length > CODE_ACCESS_MAX_MANAGER_USER_IDS ? null : rows.map((row) => row.id);
};

/** Core owns proof validation, admission, transaction, grant tombstones and audit. Mail owns the live share. */
export const mailboxCodeAccess: CodeAccessAdapter = {
  manages: async (tx, context, id) => {
    if (
      context.actor.kind !== "user" ||
      context.accessSubject.type !== "user" ||
      context.accessSubject.userId !== context.actor.user.id ||
      !ResourceShortIdSchema.safeParse(id).success
    )
      return false;
    // Match platform lock order: current person before target and directory authority.
    const [person] = await tx`SELECT id FROM auth.users WHERE id = ${context.actor.user.id}::uuid
      AND (account_expires IS NULL OR account_expires > statement_timestamp()) FOR SHARE`;
    if (!person) return false;
    // Do not wait on directory writers while holding a person/projection lock:
    // IPA sync writes users and memberships before its role projection. A busy
    // directory rolls this Code transaction back; it must never abort the sync.
    await tx`LOCK TABLE auth.groups, auth.group_groups_v2, auth.user_groups_v2 IN SHARE MODE NOWAIT`;
    const target = await lockTarget(tx, id);
    if (!target) return false;
    const matches = buildAccessPrincipalCondition({
      subject: context.accessSubject,
      columns: {
        userId: tx`a.user_id`,
        groupId: tx`a.group_id`,
        serviceAccountId: tx`a.service_account_id`,
        authenticatedOnly: tx`a.authenticated_only`,
      },
    });
    // Lock only this person's supporting shares. An unrelated person's deletion
    // can cascade through other shares before waiting on directory membership.
    const admins = await tx<{ id: string }[]>`SELECT a.id FROM auth.access a
      JOIN mail.mailbox_access grants ON grants.access_id = a.id
      WHERE grants.mailbox_id = ${target.id}::uuid AND a.permission = 'admin' AND ${matches}
      ORDER BY a.id FOR SHARE OF a, grants`;
    return (await getEffectivePermission({ accessIds: admins.map((row) => row.id), subject: context.accessSubject }, tx)) === "admin";
  },
  grant: async (tx, input) => {
    const decision = mailboxCodeAccessDecision(input.operations, input.dryRun);
    if (!decision.granted) return decision;
    if (!ResourceShortIdSchema.safeParse(input.id).success) return { granted: false, reason: "Mailbox not found." };
    const mailbox = await lockTarget(tx, input.id);
    if (!mailbox) return { granted: false, reason: "Mailbox not found." };
    const access = await tx<{ access_id: string }[]>`SELECT ma.access_id FROM mail.mailbox_access ma
      JOIN auth.access a ON a.id=ma.access_id WHERE ma.mailbox_id=${mailbox.id}::uuid AND a.permission='admin'`;
    // UUID pages expand only the manager grants, not the entire user directory.
    // The audience is needed at preflight; real/replayed sets reuse Core's saved audience.
    const managerUserIds: string[] = [];
    if (input.dryRun && access.length) {
      let cursor: string | null = null;
      const envelopeBytes = Buffer.byteLength(
        JSON.stringify({ data: { granted: true, grantId: input.grantId, level: decision.level, managerUserIds: [] } }),
      );
      const maximum = Math.floor((CAPABILITY_MAX_RESULT_BYTES - envelopeBytes) / 39);
      while (true) {
        const managers = await listUsersWithAccess({
          accessIds: access.map((entry) => entry.access_id),
          minimumPermission: "admin",
          limit: 500,
          afterId: cursor,
          db: tx,
        });
        if (!managers.length) break;
        const active: { id: string }[] = await tx`SELECT id FROM auth.users WHERE id=ANY(${tx.array(
          managers.map((p) => p.id),
          "uuid",
        )})
          AND (account_expires IS NULL OR account_expires>statement_timestamp()) ORDER BY id`;
        managerUserIds.push(...active.map((p) => p.id));
        if (managerUserIds.length > maximum) return { granted: false, reason: "Manager audience exceeds the capability result budget." };
        cursor = managers.at(-1)!.id;
      }
    }
    const result = { ...decision, ...(input.dryRun ? { managerUserIds } : {}) };
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
    if (!ResourceShortIdSchema.safeParse(id).success) return false;
    const target = await lockTarget(tx, id, true);
    if (!target) return false;
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
