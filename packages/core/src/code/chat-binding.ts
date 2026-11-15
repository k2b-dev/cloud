import { sql } from "@k2b/cloud";
import { aiProjects } from "@k2b/cloud/ai";
import { audit } from "@k2b/cloud/services";
import type { SQL } from "bun";
import { z } from "zod";
import { ownedActiveChat } from "../ai-code-chat";
import { type CodeContext, CodeDataError, codePerson, requireCodePermission } from "./access";
import { CodeIdSchema } from "./contracts";
import { type CodeRow, mapCode } from "./store";

type BindingRow = CodeRow & { chat_conversation_id: string | null; chat_binding_revision: number };
const revision = z.number().int().nonnegative().describe("Current revision from code.chat_binding.read.");
export const CodeChatBindingSchema = z.strictObject({
  codeId: CodeIdSchema,
  revision,
  canChange: z.boolean(),
  chat: z
    .union([
      z.strictObject({
        state: z.literal("available"),
        id: z.string(),
        title: z.string(),
        project: z.strictObject({ id: z.string(), title: z.string() }).nullable(),
        href: z.string(),
      }),
      z.strictObject({ state: z.literal("unavailable") }),
      z.strictObject({ state: z.literal("hidden") }),
    ])
    .nullable(),
});
export const codeChatBindingContracts = {
  read: { input: z.strictObject({ codeId: CodeIdSchema }), data: CodeChatBindingSchema },
  set: {
    input: z.strictObject({
      codeId: CodeIdSchema,
      chatId: z.string().min(1).max(200).describe("Short ID of your own active chat."),
      revision,
    }),
    data: CodeChatBindingSchema,
  },
};
export type CodeChatBinding = z.infer<typeof CodeChatBindingSchema>;

export async function codeChatSchemaAvailable(db: SQL = sql): Promise<boolean> {
  const [row] = await db<{ available: boolean }[]>`SELECT to_regclass('ai.conversations') IS NOT NULL AS available`;
  return row?.available === true;
}
/** The same predicate supplies attention, the Code page and Waiting for you. Alias c is the Code row. */
export async function codeChatMissingCondition(db: SQL = sql) {
  const missing = (await codeChatSchemaAvailable(db))
    ? db`NOT EXISTS(SELECT 1 FROM ai.conversations chat WHERE chat.id=c.chat_conversation_id
        AND chat.created_by_user_id=c.owner_user_id AND chat.archived_at IS NULL)`
    : db`TRUE`;
  return db`(c.owner_kind='person' AND c.chat_conversation_id IS NOT NULL AND ${missing})`;
}
export async function codeChatMissing(codeId: string, db: SQL = sql): Promise<boolean> {
  const condition = await codeChatMissingCondition(db);
  const [row] = await db<{ missing: boolean }[]>`SELECT ${condition} AS missing FROM code.codes c WHERE c.id=${codeId}`;
  return row?.missing === true;
}
/** Internal projection after Code read authorization. Names remain the viewer's canonical reader's responsibility. */
export async function codeChatReadModelState(codeId: string, db: SQL = sql) {
  const destination = (await codeChatSchemaAvailable(db))
    ? db`(SELECT chat.short_id FROM ai.conversations chat WHERE chat.id=c.chat_conversation_id
        AND chat.created_by_user_id=c.owner_user_id AND chat.archived_at IS NULL)`
    : db`NULL::text`;
  const [row] = await db<{ bound: boolean; short_id: string | null }[]>`
    SELECT c.chat_conversation_id IS NOT NULL AS bound,${destination} AS short_id
    FROM code.codes c WHERE c.id=${codeId} AND c.owner_kind='person'`;
  return {
    missing: row?.bound === true && !row.short_id,
    target: row?.short_id ? { type: "core.ai.chat", id: row.short_id } : null,
  };
}
async function bindingRow(codeId: string, context: CodeContext, db: SQL, lock = false) {
  const [row] = await db<BindingRow[]>`SELECT * FROM code.codes WHERE id=${codeId} ${lock ? db`FOR UPDATE` : db``}`;
  if (!row) throw new CodeDataError("NOT_FOUND", "Code not found.");
  await requireCodePermission(mapCode(row), context, false, db);
  return row;
}
export function requireCodeChatOwner(row: Pick<BindingRow, "owner_kind" | "owner_user_id">, context: CodeContext) {
  const user = codePerson(context, true);
  if (row.owner_kind !== "person" || row.owner_user_id !== user.id)
    throw new CodeDataError("FORBIDDEN", "Only the personal Code owner may change its chat.");
  return user;
}
async function presentBinding(row: BindingRow, context: CodeContext, db: SQL): Promise<CodeChatBinding> {
  const canChange = row.owner_kind === "person" && row.owner_user_id === codePerson(context).id;
  const base = { codeId: row.id, revision: row.chat_binding_revision, canChange };
  if (!row.chat_conversation_id) return { ...base, chat: null };
  if (!canChange) return { ...base, chat: { state: "hidden" } };
  if (!(await codeChatSchemaAvailable(db))) return { ...base, chat: { state: "unavailable" } };
  const [chat] = await db<{ short_id: string; title: string; project_id: string | null }[]>`
    SELECT chat.short_id,chat.title,chat.project_id
    FROM ai.conversations chat
    WHERE chat.id=${row.chat_conversation_id}::uuid AND chat.created_by_user_id=${row.owner_user_id}::uuid AND chat.archived_at IS NULL`;
  const project = chat?.project_id
    ? await aiProjects.get(chat.project_id, { actor: context.authority.actor, accessSubject: context.authority.accessSubject })
    : null;
  return {
    ...base,
    chat: chat
      ? {
          state: "available",
          id: chat.short_id,
          title: chat.title,
          project: project ? { id: project.shortId, title: project.name } : null,
          href: `/app/assistant?conversation=${encodeURIComponent(chat.short_id)}`,
        }
      : { state: "unavailable" },
  };
}
export async function readCodeChatBinding(input: z.infer<typeof codeChatBindingContracts.read.input>, context: CodeContext) {
  return presentBinding(await bindingRow(input.codeId, context, sql), context, sql);
}
/** The Action transport retains idempotent responses; the revision serializes distinct requests and reviews. */
export async function reviewCodeChatBinding(input: z.infer<typeof codeChatBindingContracts.set.input>, context: CodeContext) {
  return sql.begin(async (db) => {
    const row = await bindingRow(input.codeId, context, db, true);
    const user = requireCodeChatOwner(row, context);
    if (row.chat_binding_revision !== input.revision) throw new CodeDataError("CONFLICT", "Chat binding changed. Read it again.");
    if (!(await codeChatSchemaAvailable(db))) throw new CodeDataError("NOT_FOUND", "Chat not found.");
    const chat = await ownedActiveChat(user.id, input.chatId, db, { lock: true });
    if (!chat) throw new CodeDataError("NOT_FOUND", "Chat not found.");
    return { row, chat, user };
  });
}
export async function setCodeChatBinding(input: z.infer<typeof codeChatBindingContracts.set.input>, context: CodeContext) {
  return sql.begin(async (db) => {
    const row = await bindingRow(input.codeId, context, db, true);
    const user = requireCodeChatOwner(row, context);
    if (row.chat_binding_revision !== input.revision) throw new CodeDataError("CONFLICT", "Chat binding changed. Read it again.");
    if (!(await codeChatSchemaAvailable(db))) throw new CodeDataError("NOT_FOUND", "Chat not found.");
    const chat = await ownedActiveChat(user.id, input.chatId, db, { lock: true });
    if (!chat) throw new CodeDataError("NOT_FOUND", "Chat not found.");
    const [updated] = await db<BindingRow[]>`UPDATE code.codes SET chat_conversation_id=${chat.id}::uuid,
      chat_binding_revision=chat_binding_revision+1 WHERE id=${input.codeId} RETURNING *`;
    if (!updated) throw new CodeDataError("NOT_FOUND", "Code not found.");
    await audit.record(
      {
        action: "core.code.chat_binding.changed",
        outcome: "allowed",
        actor: { userId: user.id },
        target: { type: "code", id: row.id },
        requestId: context.requestId,
        metadata: { before: row.chat_conversation_id, after: chat.id, revision: updated.chat_binding_revision },
      },
      db,
    );
    return presentBinding(updated, context, db);
  });
}
