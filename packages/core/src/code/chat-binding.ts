import { sql } from "@k2b/cloud";
import { aiProjects } from "@k2b/cloud/ai";
import { CODE_BOUND_CHAT_ID } from "@k2b/cloud/code";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { audit } from "@k2b/cloud/services";
import { err, fail, i18n, ok, type Result } from "@k2b/stdlib";
import type { SQL } from "bun";
import { z } from "zod";
import { codeChatDestination, ownedActiveChat, personalCodeRun } from "../ai-code-chat";
import { type CodeContext, CodeDataError, codePerson, requireCodePermission } from "./access";
import { CodeIdSchema } from "./contracts";
import { type CodeRow, mapCode } from "./store";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      chat_unbound: "Choose a chat for this Code before sending.",
      chat_unavailable: "The bound chat is unavailable. Restore it or choose another chat.",
    },
    de: {
      chat_unbound: "Wähle vor dem Senden einen Chat für diesen Code.",
      chat_unavailable: "Der gebundene Chat ist nicht verfügbar. Stelle ihn wieder her oder wähle einen anderen Chat.",
    },
  },
});

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
      z.strictObject({
        state: z.literal("unavailable"),
        reason: z.literal("archived"),
        id: z.string().optional(),
        title: z.string().optional(),
      }),
      z.strictObject({ state: z.literal("unavailable"), reason: z.literal("deleted") }),
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
/**
 * The same predicate supplies attention, the Code page and Waiting for you. Alias c is the Code row. Synchronous on
 * purpose: a SQL fragment is thenable, so returning it from an async function would run it as a query of its own.
 */
export function codeChatMissingCondition(chatSchemaAvailable: boolean, db: SQL = sql) {
  const missing = chatSchemaAvailable
    ? db`NOT EXISTS(SELECT 1 FROM ai.conversations chat WHERE chat.id=c.chat_conversation_id
        AND chat.created_by_user_id=c.owner_user_id AND chat.archived_at IS NULL)`
    : db`TRUE`;
  return db`(c.owner_kind='person' AND c.chat_conversation_id IS NOT NULL AND ${missing})`;
}
export async function codeChatMissing(codeId: string, db: SQL = sql): Promise<boolean> {
  const condition = codeChatMissingCondition(await codeChatSchemaAvailable(db), db);
  const [row] = await db<{ missing: boolean }[]>`SELECT ${condition} AS missing FROM code.codes c WHERE c.id=${codeId}`;
  return row?.missing === true;
}
type BindingChat = { short_id: string; title: string; project_id: string | null; archived_at: Date | null };
async function readBindingChat(row: Pick<BindingRow, "chat_conversation_id" | "owner_user_id">, db: SQL): Promise<BindingChat | null> {
  if (!row.chat_conversation_id || !(await codeChatSchemaAvailable(db))) return null;
  const [chat] = await db<BindingChat[]>`SELECT short_id,title,project_id,archived_at FROM ai.conversations
    WHERE id=${row.chat_conversation_id}::uuid AND created_by_user_id=${row.owner_user_id}::uuid`;
  return chat ?? null;
}
/** Internal data only. Callers must authorize Code access before exposing this projection. */
export async function readCodeChatBinding(codeId: string, db: SQL) {
  const [code] = await db<BindingRow[]>`SELECT * FROM code.codes WHERE id=${codeId}`;
  return code ? { code, chat: await readBindingChat(code, db) } : null;
}
/**
 * Internal projection after Code read authorization. Names remain the viewer's canonical reader's responsibility.
 * The caller already read the Code row, so unbound or non-personal Code costs no statement here.
 */
export async function codeChatReadModelState(
  code: Pick<BindingRow, "owner_kind" | "owner_user_id" | "chat_conversation_id">,
  db: SQL = sql,
) {
  if (code.owner_kind !== "person" || !code.chat_conversation_id) return { missing: false, target: null };
  const found = await readBindingChat(code, db);
  const chat = found && !found.archived_at ? found : null;
  return { missing: !chat, target: chat ? { type: "core.ai.chat", id: chat.short_id } : null };
}
/** Resolve only within a current personal Code run; ordinary literal destinations keep their identity. */
export async function resolveCodeChatDestination(
  context: CapabilityExecutionContext,
  db: SQL,
): Promise<Result<{ chatId: string; binding: { codeId: string; revision: number } | null }>> {
  const destination = codeChatDestination(context);
  if (destination !== CODE_BOUND_CHAT_ID) return ok({ chatId: destination, binding: null });
  const run = personalCodeRun(context);
  if (!run) return fail(err.forbidden("A bound chat requires a personal Code run."));
  const [current] = await db<{ id: string }[]>`SELECT code.id FROM code.codes code JOIN code.runs run ON run.code_id=code.id
    WHERE run.id=${run.runId}::uuid AND run.version_id=${run.versionId}::uuid
    AND code.owner_kind='person' AND code.owner_user_id=${run.userId}::uuid
    AND code.state='active' AND code.active_version_id=run.version_id AND run.state='running'`;
  if (!current) return fail(err.forbidden("The personal Code run is no longer current."));
  const binding = await readCodeChatBinding(current.id, db);
  if (!binding || binding.code.owner_kind !== "person" || binding.code.owner_user_id !== run.userId)
    return fail(err.forbidden("The personal Code owner changed."));
  const t = messages.resolve([context.locale ?? "en"]).t;
  if (!binding.code.chat_conversation_id) return fail({ code: "chat_unbound", status: 409, message: t.chat_unbound });
  if (!binding.chat || binding.chat.archived_at) return fail({ code: "chat_unavailable", status: 409, message: t.chat_unavailable });
  return ok({ chatId: binding.chat.short_id, binding: { codeId: current.id, revision: binding.code.chat_binding_revision } });
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
async function presentBinding(row: BindingRow, context: CodeContext, db: SQL, loadedChat?: BindingChat | null): Promise<CodeChatBinding> {
  const canChange = row.owner_kind === "person" && row.owner_user_id === codePerson(context).id;
  const base = { codeId: row.id, revision: row.chat_binding_revision, canChange };
  if (!row.chat_conversation_id) return { ...base, chat: null };
  if (!canChange) return { ...base, chat: { state: "hidden" } };
  const chat = loadedChat === undefined ? await readBindingChat(row, db) : loadedChat;
  if (!chat) return { ...base, chat: { state: "unavailable", reason: "deleted" } };
  if (chat.archived_at) return { ...base, chat: { state: "unavailable", reason: "archived", id: chat.short_id, title: chat.title } };
  const project = chat.project_id
    ? await aiProjects.get(chat.project_id, { actor: context.authority.actor, accessSubject: context.authority.accessSubject })
    : null;
  return {
    ...base,
    chat: {
      state: "available",
      id: chat.short_id,
      title: chat.title,
      project: project ? { id: project.shortId, title: project.name } : null,
      href: `/app/assistant?conversation=${encodeURIComponent(chat.short_id)}`,
    },
  };
}
export async function getCodeChatBinding(input: z.infer<typeof codeChatBindingContracts.read.input>, context: CodeContext) {
  const binding = await readCodeChatBinding(input.codeId, sql);
  if (!binding) throw new CodeDataError("NOT_FOUND", "Code not found.");
  await requireCodePermission(mapCode(binding.code), context, false, sql);
  return presentBinding(binding.code, context, sql, binding.chat);
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
