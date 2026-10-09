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
import { sql } from "bun";
import { chatMessages } from "../messages";

export type ChatContext = { actor: RequestActor; accessSubject: AccessSubject; locale?: string; requestId?: string };
export type ConversationRow = {
  id: string;
  short_id: string;
  name: string | null;
  icon: string | null;
  purpose: string | null;
  member_count: number;
  seq_head: bigint;
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
  const permission = capPermission(permissionFromRank(row?.permission_rank ?? 0), input.actor);
  if (!row || permission === "none") return fail({ code: "NOT_FOUND", message: t.notFound, status: 404 });
  if (!hasPermission(permission, input.required)) return fail(err.forbidden(t.forbidden));
  return ok({ ...row, permission });
};
