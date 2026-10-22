import { err, fail, ok } from "@k2b/cloud/server";
import { sql } from "bun";
import { type ChatContext, messages, requireConversation, subjectPrincipal } from "./access";
import { PersonalConversationSchema, SidebarPreferencesSchema } from "./contracts";
import { conversations } from "./conversations";
import { chatLive } from "./live";

// Every personal mutation uses the same account lock, including a first pin with no participant row yet.
const lock = async (context: ChatContext, db: typeof sql) => {
  const self = subjectPrincipal(context.accessSubject);
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${`chat.personal:${self.type}:${self.id}`}, 0))`;
  return self;
};
const publish = async (context: ChatContext, db: typeof sql) => {
  if (context.accessSubject.type === "user")
    await chatLive.publish(db, { key: `p:${context.accessSubject.userId}`, data: { type: "personal" } });
};
const preferences = async (context: ChatContext, db: typeof sql = sql) => {
  const self = subjectPrincipal(context.accessSubject);
  const [row] = await db<{ collapsed_sections: unknown }[]>`SELECT collapsed_sections FROM chat.account_prefs
    WHERE principal_type = ${self.type} AND principal_id = ${self.id}::uuid`;
  return ok(SidebarPreferencesSchema.parse({ collapsed: row?.collapsed_sections ?? [] }));
};
const savePreferences = async (input: ChatContext & { input: unknown }) => {
  const parsed = SidebarPreferencesSchema.safeParse(input.input);
  if (!parsed.success) return fail(err.badInput(messages(input).invalidInput));
  const result = await sql.begin(async (db) => {
    const self = await lock(input, db);
    await db`INSERT INTO chat.account_prefs (principal_type, principal_id, collapsed_sections)
      VALUES (${self.type}, ${self.id}::uuid, ${JSON.stringify(parsed.data.collapsed)}::jsonb)
      ON CONFLICT (principal_type, principal_id) DO UPDATE SET collapsed_sections = EXCLUDED.collapsed_sections`;
    await publish(input, db);
    return preferences(input, db);
  });
  chatLive.wake();
  return result;
};
const update = async (input: ChatContext & { conversationId: string; input: unknown }) => {
  const parsed = PersonalConversationSchema.safeParse(input.input);
  if (!parsed.success) return fail(err.badInput(messages(input).invalidInput));
  const data = parsed.data;
  const result = await sql.begin(async (db) => {
    const self = await lock(input, db);
    const allowed = await requireConversation({ ...input, required: "read" }, db);
    if (!allowed.ok) return allowed;
    const row = allowed.data;
    // Validate the relative target before making any write. Archived pins keep their position in this same order.
    const [neighbor] = data.before
      ? await db<{ pinned_rank: number }[]>`
      SELECT p.pinned_rank FROM chat.participants p JOIN chat.conversations c ON c.id = p.conversation_id
      WHERE p.principal_type = ${self.type} AND p.principal_id = ${self.id}::uuid
        AND p.pinned_rank IS NOT NULL AND c.short_id = ${data.before}`
      : [];
    if (data.before && (data.before === input.conversationId || !neighbor)) return fail(err.badInput(messages(input).invalidInput));
    await db`INSERT INTO chat.participants (principal_type, principal_id, conversation_id, origin, joined_seq)
      VALUES (${self.type}, ${self.id}::uuid, ${row.id}::uuid, 'ondemand', ${row.seq_head}) ON CONFLICT DO NOTHING`;
    if (data.archived !== undefined)
      await db`UPDATE chat.participants SET archived_at = ${data.archived ? db`COALESCE(archived_at, now())` : db`NULL`}
        WHERE principal_type = ${self.type} AND principal_id = ${self.id}::uuid AND conversation_id = ${row.id}::uuid`;
    if (data.pinned === false)
      await db`UPDATE chat.participants SET pinned_rank = NULL
        WHERE principal_type = ${self.type} AND principal_id = ${self.id}::uuid AND conversation_id = ${row.id}::uuid`;
    if (data.pinned === true) {
      // Re-rank in SQL without loading every pin or accepting an unbounded order array.
      // An omitted neighbor keeps an existing pin in place; null deliberately moves it to the end.
      await db`WITH target AS (
        SELECT COALESCE(${neighbor?.pinned_rank ?? null}::int,
          ${data.before === undefined ? db`(SELECT pinned_rank FROM chat.participants WHERE principal_type = ${self.type} AND principal_id = ${self.id}::uuid AND conversation_id = ${row.id}::uuid)` : db`NULL::int`},
          (SELECT COALESCE(MAX(pinned_rank), -1) + 1 FROM chat.participants WHERE principal_type = ${self.type} AND principal_id = ${self.id}::uuid)) AS rank
      ), ranked AS (
        SELECT p.conversation_id, row_number() OVER (ORDER BY
          CASE WHEN p.conversation_id = ${row.id}::uuid THEN target.rank ELSE p.pinned_rank END,
          CASE WHEN p.conversation_id = ${row.id}::uuid THEN 0 ELSE 1 END, p.conversation_id) - 1 AS rank
        FROM chat.participants p CROSS JOIN target
        WHERE p.principal_type = ${self.type} AND p.principal_id = ${self.id}::uuid AND (p.pinned_rank IS NOT NULL OR p.conversation_id = ${row.id}::uuid)
      ) UPDATE chat.participants p SET pinned_rank = ranked.rank FROM ranked
        WHERE p.principal_type = ${self.type} AND p.principal_id = ${self.id}::uuid AND p.conversation_id = ranked.conversation_id`;
    }
    await publish(input, db);
    return conversations.get(input, db);
  });
  if (result.ok) chatLive.wake();
  return result;
};
export const personal = { update, preferences, savePreferences };
