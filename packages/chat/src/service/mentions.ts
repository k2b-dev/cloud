import { err, fail, getEffectivePermissions, ok } from "@k2b/cloud/server";
import { toPgUuidArray } from "@k2b/cloud/services";
import { principalLabel } from "@k2b/cloud/shared";
import { sql } from "bun";
import type { ChatContext, ConversationRow } from "./access";
import { messages, requireConversation, subjectPrincipal } from "./access";
import { type Mention, MentionCandidateQuerySchema, PEOPLE_PAGE_SIZE } from "./contracts";
import { canReadThread } from "./thread-access";
import { findThread, threadNotFound } from "./threads";

type Person = { type: "user" | "service_account"; id: string; name: string; agent: boolean };
const key = (principal: Mention["principal"]) => `${principal.type}:${principal.id}`;
const label = (person: Person, locale?: string) =>
  principalLabel(
    {
      principal: person.type === "user" ? { type: "user", userId: person.id } : { type: "service_account", serviceAccountId: person.id },
      displayName: person.name,
    },
    locale,
  );
const eligiblePeople = (db: typeof sql, conversation: string) => db`
  SELECT 'user'::text AS type, u.id, COALESCE(NULLIF(u.display_name, ''), u.uid) AS name, false AS agent
    FROM auth.users u WHERE u.account_expires IS NULL OR u.account_expires > now()
  UNION ALL
  SELECT 'service_account'::text AS type, sa.id, sa.name, sa.kind = 'agent' AS agent
    FROM auth.service_accounts sa WHERE sa.status = 'active' AND
      (sa.kind IN ('standalone', 'agent') OR (sa.kind = 'resource_bound' AND sa.app_id = 'chat'
        AND sa.resource_type = 'conversation' AND sa.resource_id = ${conversation}))`;

export const validateMentions = async (db: typeof sql, context: ChatContext, conversation: ConversationRow, mentions: Mention[]) => {
  if (!mentions.length) return ok<Mention[]>([]);
  const people = await db<Person[]>`SELECT p.* FROM (${eligiblePeople(db, conversation.short_id)}) p
    WHERE (p.type = 'user' AND p.id = ANY(${toPgUuidArray(mentions.filter((m) => m.principal.type === "user").map((m) => m.principal.id))}::uuid[]))
      OR (p.type = 'service_account' AND p.id = ANY(${toPgUuidArray(mentions.filter((m) => m.principal.type === "service_account").map((m) => m.principal.id))}::uuid[]))`;
  // System targets need only exist. Resource readers run with the reader's own authority when they open the message.
  // Ordinary threads share conversation membership; use the same principal/group evaluator as live delivery.
  const permissions =
    conversation.kind === "chat"
      ? await getEffectivePermissions({
          accessIds: db`SELECT access_id FROM chat.conversation_access WHERE conversation_id = ${conversation.id}::uuid AND role = 'member'`,
          subjects: people.map((person) =>
            person.type === "user"
              ? { type: "user" as const, userId: person.id }
              : { type: "service_account" as const, serviceAccountId: person.id },
          ),
        })
      : null;
  const allowed = new Set(
    people.filter((_, i) => permissions === null || (permissions[i] !== undefined && permissions[i] !== "none")).map(key),
  );
  if (mentions.some((mention) => !allowed.has(key(mention.principal))))
    return fail({ code: "INVALID_MENTION", status: 400, message: messages(context).invalidMention });
  return ok(mentions);
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
    const rows = await db<Person[]>`SELECT p.* FROM (${eligiblePeople(db, allowed.data.short_id)}) p
      WHERE NOT (p.type = ${self.type} AND p.id = ${self.id}::uuid) AND p.name ~* ${pattern}
        AND (EXISTS (SELECT 1 FROM chat.messages m WHERE m.conversation_id = ${allowed.data.id}::uuid
          AND m.author_type = p.type AND m.author_id = p.id)
          OR (${allowed.data.kind === "chat"} AND EXISTS (SELECT 1 FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
            WHERE ca.conversation_id = ${allowed.data.id}::uuid AND ca.role = 'member' AND a.permission IN ('read', 'write', 'admin')
              AND ((p.type = 'user' AND a.user_id = p.id) OR (p.type = 'service_account' AND a.service_account_id = p.id)))))
      ORDER BY lower(p.name), p.type, p.id LIMIT ${PEOPLE_PAGE_SIZE}`;
    return ok({
      items: rows.map((person) => ({
        principal: { type: person.type, id: person.id },
        name: label(person, context.locale),
        agent: person.agent,
      })),
    });
  });
};
export const mentions = { candidates };
