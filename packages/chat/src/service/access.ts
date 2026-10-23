import type { CapabilityCaller } from "@k2b/cloud/capabilities/server";
import {
  type AccessSubject,
  buildAccessPrincipalCondition,
  err,
  fail,
  hasPermission,
  ok,
  type PermissionLevel,
  type RequestActor,
  type Result,
} from "@k2b/cloud/server";
import { type SQLQuery, sql } from "bun";
import { chatMessages } from "../messages";
import { readResource } from "./resource-access";

export type ChatContext = {
  actor: RequestActor;
  accessSubject: AccessSubject;
  locale?: string;
  requestId?: string;
  caller?: CapabilityCaller;
  credentialPrincipal?: string;
};
export type ConversationRow = {
  kind: "chat" | "system";
  resource_type: string | null;
  resource_id: string | null;
  id: string;
  short_id: string;
  name: string | null;
  icon: string | null;
  purpose: string | null;
  member_count: number;
  seq_head: bigint | string;
  rev: bigint | string;
  changed_rev: bigint | string;
  created_at: Date;
  last_activity_at: Date;
};
export type AuthorizedConversation = ConversationRow & { permission: Exclude<PermissionLevel, "none"> };
export const messages = (context: Pick<ChatContext, "locale">) => chatMessages.resolve(context.locale ? [context.locale] : []).t;
export const actingPrincipal = (actor: RequestActor) =>
  actor.kind === "user" ? { type: "user" as const, id: actor.user.id } : { type: "service_account" as const, id: actor.serviceAccount.id };
export const subjectPrincipal = (subject: AccessSubject) =>
  subject.type === "user"
    ? { type: "user" as const, id: subject.userId }
    : { type: "service_account" as const, id: subject.serviceAccountId };
export const auditActor = (actor: RequestActor) =>
  actor.kind === "user"
    ? { userId: actor.user.id, uid: actor.user.uid, provider: actor.user.provider, roles: actor.user.roles }
    : { uid: actor.serviceAccount.id, provider: "service_account" };

export const permissionFromRank = (rank: number): PermissionLevel =>
  rank >= 3 ? "admin" : rank >= 2 ? "write" : rank >= 1 ? "read" : "none";
export const capPermission = (granted: PermissionLevel, actor: RequestActor): PermissionLevel => {
  if (actor.kind !== "service_account" || actor.delegatedUser !== null) return granted;
  const scopes = actor.scopes;
  const cap = scopes.includes("admin") ? "admin" : scopes.includes("write") ? "write" : scopes.includes("read") ? "read" : "none";
  return hasPermission(granted, cap) ? cap : granted;
};
export const boundConversation = (actor: RequestActor, locale?: string): Result<string | null> => {
  if (actor.kind !== "service_account" || actor.delegatedUser !== null || actor.serviceAccount.kind !== "resource_bound") return ok(null);
  const account = actor.serviceAccount;
  return account.appId === "chat" && account.resourceType === "conversation" && account.resourceId
    ? ok(account.resourceId)
    : fail(err.forbidden(messages({ locale }).forbidden));
};
export const principalCondition = (subject: AccessSubject, db: typeof sql = sql) =>
  buildAccessPrincipalCondition({
    subject,
    columns: {
      userId: db`a.user_id`,
      groupId: db`a.group_id`,
      serviceAccountId: db`a.service_account_id`,
      authenticatedOnly: db`a.authenticated_only`,
    },
  });

/** Shared binding and scope rules for HTTP reads and live delivery. */
export const conversationPermission = (conversationId: string, granted: PermissionLevel, actor: RequestActor): PermissionLevel => {
  const bound = boundConversation(actor);
  return !bound.ok || (bound.data !== null && bound.data !== conversationId) ? "none" : capPermission(granted, actor);
};

/** The member-only sidebar filter, shared by list reads and the live collection. */
export const readableMemberCondition = (subject: AccessSubject, bound: string | null, db: typeof sql = sql) => db`
  c.kind = 'chat' AND ca.role = 'member' AND ${principalCondition(subject, db)} AND a.permission IN ('read', 'write', 'admin')
  AND ${bound ? db`c.short_id = ${bound}` : db`true`}
`;

/** One SQL query resolves the resource and highest matching grant; credential checks precede it. */
export const requireConversation = async (
  input: ChatContext & { conversationId: string; required: PermissionLevel },
  db: typeof sql = sql,
): Promise<Result<AuthorizedConversation>> => {
  const t = messages(input);
  const bound = boundConversation(input.actor, input.locale);
  if (!bound.ok || (bound.data !== null && bound.data !== input.conversationId)) return fail(err.forbidden(t.forbidden));
  const [row] = await db<(ConversationRow & { permission_rank: number })[]>`
    SELECT c.*, COALESCE((
      SELECT MAX(CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END)
      FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
      WHERE ca.conversation_id = c.id AND ${principalCondition(input.accessSubject, db)}
    ), 0)::int AS permission_rank
    FROM chat.conversations c WHERE c.short_id = ${input.conversationId}
  `;
  const granted =
    row?.kind === "system"
      ? row.resource_type && row.resource_id
        ? ((await readResource(input, { type: row.resource_type, id: row.resource_id }))?.permission ?? "none")
        : "none"
      : permissionFromRank(row?.permission_rank ?? 0);
  const permission = conversationPermission(input.conversationId, granted, input.actor);
  if (!row || permission === "none") return fail({ code: "NOT_FOUND", message: t.notFound, status: 404 });
  if (!hasPermission(permission, input.required)) return fail(err.forbidden(t.forbidden));
  return ok({ ...row, permission });
};

export const memberUsers = (conversationId: string | SQLQuery, db: typeof sql = sql) => db`
  WITH RECURSIVE member_groups(id, provider) AS (
    SELECT g.id, g.provider FROM chat.conversation_access ca
    JOIN auth.access a ON a.id = ca.access_id JOIN auth.groups g ON g.id = a.group_id
    WHERE ca.conversation_id = ${conversationId}::uuid AND ca.role = 'member' AND a.permission IN ('read', 'write', 'admin')
    UNION
    SELECT child.id, child.provider FROM member_groups parent
    JOIN auth.group_groups_v2 gg ON gg.parent_group_id = parent.id
    JOIN auth.groups child ON child.id = gg.child_group_id AND child.provider = parent.provider
  )
  SELECT u.id FROM auth.users u WHERE u.id IN (
    SELECT a.user_id FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
    WHERE ca.conversation_id = ${conversationId}::uuid AND ca.role = 'member' AND a.permission IN ('read', 'write', 'admin')
    UNION
    SELECT ug.user_id FROM member_groups g JOIN auth.user_groups_v2 ug ON ug.group_id = g.id
  )
`;
export const groupUsers = (groupId: string | SQLQuery, db: typeof sql = sql) => db`
  WITH RECURSIVE member_groups(id, provider) AS (
    SELECT id, provider FROM auth.groups WHERE id = ${groupId}::uuid
    UNION
    SELECT child.id, child.provider FROM member_groups parent
    JOIN auth.group_groups_v2 gg ON gg.parent_group_id = parent.id
    JOIN auth.groups child ON child.id = gg.child_group_id AND child.provider = parent.provider
  )
  SELECT DISTINCT ug.user_id AS id FROM member_groups g
  JOIN auth.user_groups_v2 ug ON ug.group_id = g.id JOIN auth.users u ON u.id = ug.user_id
`;

/** People with a direct member entry in a chat the subject belongs to; groups are never expanded for this list. */
export const coMemberIds = (subject: AccessSubject, db: typeof sql = sql) => db`
  SELECT person_a.user_id FROM chat.conversations c
  JOIN chat.conversation_access ca ON ca.conversation_id = c.id JOIN auth.access a ON a.id = ca.access_id
  JOIN chat.conversation_access person_ca ON person_ca.conversation_id = c.id AND person_ca.role = 'member'
  JOIN auth.access person_a ON person_a.id = person_ca.access_id
  WHERE ${readableMemberCondition(subject, null, db)}
    AND person_a.user_id IS NOT NULL AND person_a.permission IN ('read', 'write', 'admin')
`;

export const repairMemberCount = async (conversationId: string, db: typeof sql) => {
  const [row] = await db<{ member_count: number }[]>`
    UPDATE chat.conversations SET member_count = (SELECT COUNT(*)::int FROM (${memberUsers(conversationId, db)}) members)
    WHERE id = ${conversationId}::uuid RETURNING member_count
  `;
  if (!row) throw new Error("Chat member count has no conversation");
  return row.member_count;
};
