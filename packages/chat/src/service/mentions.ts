import { err, fail, getEffectivePermissions, ok } from "@k2b/cloud/server";
import { toPgUuidArray } from "@k2b/cloud/services";
import { principalLabel } from "@k2b/cloud/shared";
import { sql } from "bun";
import type { ChatContext, ConversationRow } from "./access";
import { messages, requireConversation, subjectPrincipal } from "./access";
import { type Mention, MentionCandidateQuerySchema, PEOPLE_PAGE_SIZE } from "./contracts";
import type { MentionTarget } from "./mention-store";
import { cachedResource, readerBatch } from "./resource-access";
import { canReadThread } from "./thread-access";
import { findThread, threadNotFound } from "./threads";

type Person = { access_id: string; type: "user" | "service_account"; id: string; name: string; agent: boolean };
const label = (person: Person, locale?: string) =>
  principalLabel(
    {
      principal: person.type === "user" ? { type: "user", userId: person.id } : { type: "service_account", serviceAccountId: person.id },
      displayName: person.name,
    },
    locale,
  );
const people = async (db: typeof sql, ids: string[], conversation: string) => {
  const rows = await db<Person[]>`SELECT a.id AS access_id,
    CASE WHEN a.user_id IS NOT NULL THEN 'user' ELSE 'service_account' END AS type,
    COALESCE(a.user_id, a.service_account_id) AS id, COALESCE(NULLIF(u.display_name, ''), u.uid, sa.name) AS name,
    COALESCE(sa.kind = 'agent', false) AS agent
  FROM auth.access a LEFT JOIN auth.users u ON u.id = a.user_id LEFT JOIN auth.service_accounts sa ON sa.id = a.service_account_id
  WHERE a.id = ANY(${toPgUuidArray(ids)}::uuid[]) AND
    ((u.id IS NOT NULL AND (u.account_expires IS NULL OR u.account_expires > now())) OR (sa.id IS NOT NULL AND sa.status = 'active' AND
      (sa.kind IN ('standalone', 'agent') OR (sa.kind = 'resource_bound' AND sa.app_id = 'chat' AND sa.resource_type = 'conversation' AND sa.resource_id = ${conversation}))))`;
  const byId = new Map(rows.map((row) => [row.access_id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
};
const readable = async (db: typeof sql, conversation: ConversationRow, threadId: string | null, people: Person[]) => {
  if (conversation.kind === "chat") {
    const permissions = await getEffectivePermissions({
      accessIds: db`SELECT access_id FROM chat.conversation_access WHERE conversation_id = ${conversation.id}::uuid AND role = 'member'`,
      subjects: people.map((person) =>
        person.type === "user"
          ? { type: "user" as const, userId: person.id }
          : { type: "service_account" as const, serviceAccountId: person.id },
      ),
    });
    return people.filter((_, index) => permissions[index] !== undefined && permissions[index] !== "none");
  }
  const [thread] = threadId
    ? await db<{ resource_type: string | null; resource_id: string | null }[]>`
    SELECT resource_type, resource_id FROM chat.threads WHERE id = ${threadId}::uuid AND conversation_id = ${conversation.id}::uuid`
    : [];
  if (!conversation.resource_type || !conversation.resource_id || (threadId && (!thread?.resource_type || !thread.resource_id))) return [];
  const ref = { type: conversation.resource_type, id: conversation.resource_id };
  const result = await readerBatch(people, async (person) => {
    const principal = `${person.type}:${person.id}`;
    if (!(await cachedResource(principal, ref))) return null;
    if (
      thread?.resource_type &&
      thread.resource_id &&
      !(await cachedResource(principal, { type: thread.resource_type, id: thread.resource_id }))
    )
      return null;
    return person;
  });
  return result.filter((person): person is Person => person !== null);
};
export const validateMentions = async (
  db: typeof sql,
  context: ChatContext,
  conversation: ConversationRow,
  threadId: string | null,
  mentions: Mention[],
) => {
  const ids = [...new Set(mentions.map((mention) => mention.accessId))];
  if (!ids.length) return ok<MentionTarget[]>([]);
  const found = await people(db, ids, conversation.short_id);
  const self = subjectPrincipal(context.accessSubject);
  const own = found.filter((person) => person.type === self.type && person.id === self.id);
  const allowed = [
    ...own,
    ...(await readable(
      db,
      conversation,
      threadId,
      found.filter((person) => !own.includes(person)),
    )),
  ];
  const byId = new Map(allowed.map((person) => [person.access_id, person]));
  if (ids.some((id) => !byId.has(id))) return fail({ code: "INVALID_MENTION", status: 400, message: messages(context).invalidMention });
  return ok(
    mentions.map((mention): MentionTarget => {
      const person = byId.get(mention.accessId)!;
      return { ...mention, type: person.type, id: person.id };
    }),
  );
};
const candidates = async (context: ChatContext & { conversationId: string; query?: unknown }) => {
  const parsed = MentionCandidateQuerySchema.safeParse(context.query ?? {});
  if (!parsed.success) return fail(err.badInput(messages(context).invalidInput));
  const self = subjectPrincipal(context.accessSubject);
  return sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (db) => {
    const allowed = await requireConversation({ ...context, required: "read" }, db);
    if (!allowed.ok) return allowed;
    const thread = parsed.data.thread === "general" ? null : await findThread(db, allowed.data.id, parsed.data.thread, context);
    if (parsed.data.thread !== "general" && !thread) return threadNotFound(context);
    if (!(await canReadThread(db, context, thread?.id ?? null))) return threadNotFound(context);
    const pattern = `(^|\\m)${parsed.data.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    const rows = await db<{ access_id: string }[]>`SELECT min(a.id::text)::uuid AS access_id
      FROM auth.access a LEFT JOIN auth.users u ON u.id = a.user_id LEFT JOIN auth.service_accounts sa ON sa.id = a.service_account_id
      WHERE (a.user_id IS NOT NULL OR a.service_account_id IS NOT NULL)
        AND NOT (CASE WHEN a.user_id IS NOT NULL THEN 'user' ELSE 'service_account' END = ${self.type}
          AND COALESCE(a.user_id, a.service_account_id) = ${self.id}::uuid)
        AND COALESCE(NULLIF(u.display_name, ''), u.uid, sa.name) ~* ${pattern}
        AND ${
          allowed.data.kind === "chat"
            ? db`EXISTS (SELECT 1 FROM chat.conversation_access ca
          WHERE ca.conversation_id = ${allowed.data.id}::uuid AND ca.access_id = a.id AND ca.role = 'member' AND a.permission IN ('read', 'write', 'admin'))`
            : db`EXISTS (SELECT 1 FROM chat.messages m WHERE m.conversation_id = ${allowed.data.id}::uuid
          AND m.author_type = CASE WHEN a.user_id IS NOT NULL THEN 'user' ELSE 'service_account' END AND m.author_id = COALESCE(a.user_id, a.service_account_id))`
        }
      GROUP BY a.user_id, a.service_account_id ORDER BY lower(min(COALESCE(NULLIF(u.display_name, ''), u.uid, sa.name))), min(a.id::text) LIMIT ${PEOPLE_PAGE_SIZE}`;
    const visible = await readable(
      db,
      allowed.data,
      thread?.id ?? null,
      await people(
        db,
        rows.map((row) => row.access_id),
        context.conversationId,
      ),
    );
    return ok({
      items: visible.map((person) => ({
        accessId: person.access_id,
        type: person.type,
        name: label(person, context.locale),
        agent: person.agent,
      })),
    });
  });
};
export const mentions = { candidates };
