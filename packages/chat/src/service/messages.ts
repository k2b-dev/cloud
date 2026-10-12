import { err, fail, ok, type Result, ratelimit } from "@k2b/cloud/server";
import { sql } from "bun";
import type { z } from "zod";
import { type ChatContext, messages as catalog, requireConversation, subjectPrincipal } from "./access";
import {
  CHANGES_PAGE_SIZE,
  ChangesQuerySchema,
  MESSAGE_PAGE_SIZE,
  MessageIdSchema,
  MessageQuerySchema,
  type MessageViewSchema,
  SEND_CONVERSATION_LIMIT,
  SEND_CONVERSATION_WINDOW_SECONDS,
  SEND_LIMIT,
  SEND_WINDOW_SECONDS,
  SendMessageSchema,
} from "./contracts";
import { conversations } from "./conversations";
import { chatLive } from "./live";
import { appendMessage, type MessageRow, messageView } from "./message-store";

const conversationLimit = ratelimit({
  id: "chat.message.send.conversation",
  limit: SEND_CONVERSATION_LIMIT,
  windowSecs: SEND_CONVERSATION_WINDOW_SECONDS,
});
const sendLimit = ratelimit({ id: "chat.message.send", limit: SEND_LIMIT, windowSecs: SEND_WINDOW_SECONDS });
const parse = <T>(schema: z.ZodType<T>, input: unknown, context: ChatContext): Result<T> => {
  const result = schema.safeParse(input);
  return result.success ? ok(result.data) : fail(err.badInput(catalog(context).invalidInput));
};
type Input = ChatContext & { conversationId: string };
type Sent = { message: z.infer<typeof MessageViewSchema>; created: boolean };
type RateLimited = { ok: false; error: string; code: "RATE_LIMITED"; status: 429; retryAfter: number };
const existing = async (db: typeof sql, conversationId: string, input: ChatContext, clientId: string) => {
  const author = subjectPrincipal(input.accessSubject);
  const [row] = await db<MessageRow[]>`SELECT * FROM chat.messages WHERE conversation_id = ${conversationId}::uuid
    AND author_type = ${author.type} AND author_id = ${author.id}::uuid AND client_id = ${clientId}`;
  return row;
};
const send = async (input: Input & { input: unknown }): Promise<Result<Sent> | RateLimited> => {
  const parsed = parse(SendMessageSchema, input.input, input);
  if (!parsed.ok) return parsed;
  const allowed = await requireConversation({ ...input, required: "write" });
  if (!allowed.ok) return allowed;
  const data = parsed.data;
  const found = await existing(sql, allowed.data.id, input, data.clientId);
  if (found) return ok({ message: messageView(found, input.conversationId, input.locale), created: false });
  const author = subjectPrincipal(input.accessSubject);
  const identifier = `${author.type}:${author.id}`;
  // Limits run before the lock: a sender at its limit must not hold up the chat's other writers.
  for (const [limiter, key] of [
    [conversationLimit, `${identifier}:${input.conversationId}`],
    [sendLimit, identifier],
  ] as const) {
    const limited = await limiter.check(key);
    if (limited.limited) {
      return {
        ok: false,
        error: catalog(input).sendRateLimited,
        code: "RATE_LIMITED",
        status: 429,
        retryAfter: Math.max(1, Math.ceil(limited.resetIn / 1000)),
      } satisfies RateLimited;
    }
  }
  const result = await sql.begin(async (db): Promise<Result<Sent>> => {
    await db`SELECT id FROM chat.conversations WHERE short_id = ${input.conversationId} FOR UPDATE`;
    const current = await requireConversation({ ...input, required: "write" }, db);
    if (!current.ok) return current;
    // A concurrent retry of the same clientId may have committed while this one waited for the lock.
    const retry = await existing(db, current.data.id, input, data.clientId);
    if (retry) return ok({ message: messageView(retry, input.conversationId, input.locale), created: false });
    const row = await appendMessage(db, current.data, input, { kind: "text", ...data });
    return ok({ message: messageView(row, input.conversationId, input.locale), created: true });
  });
  if (result.ok && result.data.created) chatLive.wake();
  return result;
};
const list = async (input: Input & { query?: unknown }) => {
  const parsed = parse(MessageQuerySchema, input.query ?? {}, input);
  if (!parsed.ok) return parsed;
  return sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (db) => {
    const allowed = await requireConversation({ ...input, required: "read" }, db);
    if (!allowed.ok) return allowed;
    const query = parsed.data;
    const rows = await db<MessageRow[]>`SELECT * FROM chat.messages WHERE conversation_id = ${allowed.data.id}::uuid
      AND ${query.before !== undefined ? db`seq < ${query.before}` : query.after !== undefined ? db`seq > ${query.after}` : db`true`}
      ORDER BY seq ${query.after !== undefined ? db`ASC` : db`DESC`} LIMIT ${MESSAGE_PAGE_SIZE}`;
    if (query.after === undefined) rows.reverse();
    return ok({
      items: rows.map((row) => messageView(row, input.conversationId, input.locale)),
      seqHead: Number(allowed.data.seq_head),
      rev: Number(allowed.data.rev),
    });
  });
};
const get = async (input: Input & { messageId: string }) => {
  const allowed = await requireConversation({ ...input, required: "read" });
  if (!allowed.ok) return allowed;
  const parsed = parse(MessageIdSchema, input.messageId, input);
  if (!parsed.ok) return parsed;
  const [row] = await sql<
    MessageRow[]
  >`SELECT * FROM chat.messages WHERE conversation_id = ${allowed.data.id}::uuid AND short_id = ${parsed.data}`;
  return row
    ? ok(messageView(row, input.conversationId, input.locale))
    : fail({ code: "NOT_FOUND", message: catalog(input).messageNotFound, status: 404 });
};
const changes = async (input: Input & { query: unknown }) => {
  const parsed = parse(ChangesQuerySchema, input.query, input);
  if (!parsed.ok) return parsed;
  return sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (db) => {
    const allowed = await requireConversation({ ...input, required: "read" }, db);
    if (!allowed.ok) return allowed;
    const afterRev = parsed.data.afterRev;
    const head = Number(allowed.data.rev);
    if (afterRev > head) return fail({ code: "RESYNC_REQUIRED", status: 409, message: catalog(input).resyncRequired });
    const rows = await db<MessageRow[]>`SELECT * FROM chat.messages WHERE conversation_id = ${allowed.data.id}::uuid AND rev > ${afterRev}
      ORDER BY rev LIMIT ${CHANGES_PAGE_SIZE}`;
    const conversation = Number(allowed.data.changed_rev) > afterRev ? await conversations.get(input, db) : null;
    if (conversation && !conversation.ok) return conversation;
    const more = rows.length === CHANGES_PAGE_SIZE;
    return ok({
      rev: more ? Number(rows.at(-1)!.rev) : head,
      more,
      conversation: conversation?.data ?? null,
      messages: rows.map((row) => messageView(row, input.conversationId, input.locale)),
    });
  });
};

export const messages = { send, list, get, changes };
