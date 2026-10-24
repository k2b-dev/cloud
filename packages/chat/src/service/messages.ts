import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type { z } from "zod";
import { type ChatContext, messages as catalog, requireConversation, subjectPrincipal } from "./access";
import {
  CHANGES_PAGE_SIZE,
  ChangesQuerySchema,
  type ChatSnapshotSchema,
  MESSAGE_PAGE_SIZE,
  MessageIdSchema,
  MessageQuerySchema,
  type MessageViewSchema,
  readStart,
  SendMessageSchema,
  SnapshotQuerySchema,
} from "./contracts";
import { conversations } from "./conversations";
import { chatLive } from "./live";
import { appendMessage, type MessageRow, messageViews } from "./message-store";
import { openParticipant } from "./read-state";
import { canReadThread, visibleMessages, visibleThreadIdPage } from "./thread-access";
import { threadStates } from "./thread-state";
import { findThread, threadNotFound, threads } from "./threads";
import { checkWriteRate, type RateLimited } from "./write-rate";

const parse = <T>(schema: z.ZodType<T>, input: unknown, context: ChatContext): Result<T> => {
  const result = schema.safeParse(input);
  return result.success ? ok(result.data) : fail(err.badInput(catalog(context).invalidInput));
};
type Input = ChatContext & { conversationId: string };
type Sent = { message: z.infer<typeof MessageViewSchema>; created: boolean };
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
  if (found && !(await canReadThread(sql, input, found.thread_id))) return threadNotFound(input);
  if (found)
    return ok({ message: (await messageViews(sql, [found], input.conversationId, input.accessSubject, input.locale))[0]!, created: false });
  const limited = await checkWriteRate(input);
  if (limited) return limited;

  const result = await sql.begin(async (db): Promise<Result<Sent>> => {
    await db`SELECT id FROM chat.conversations WHERE short_id = ${input.conversationId} FOR UPDATE`;
    const current = await requireConversation({ ...input, required: "write" }, db);
    if (!current.ok) return current;
    // A concurrent retry of the same clientId may have committed while this one waited for the lock.
    const retry = await existing(db, current.data.id, input, data.clientId);
    if (retry && !(await canReadThread(db, input, retry.thread_id))) return threadNotFound(input);
    if (retry)
      return ok({
        message: (await messageViews(db, [retry], input.conversationId, input.accessSubject, input.locale))[0]!,
        created: false,
      });

    let threadId: string | null = null;
    let replyToSeq: string | bigint | undefined;
    if (data.replyTo) {
      const [original] = await db<
        MessageRow[]
      >`SELECT * FROM chat.messages WHERE conversation_id = ${current.data.id}::uuid AND short_id = ${data.replyTo}`;
      if (!original) return fail({ code: "NOT_FOUND", status: 404, message: catalog(input).messageNotFound });
      threadId = original.thread_id;
      replyToSeq = original.seq;
    }
    if (data.thread) {
      const thread = await findThread(db, current.data.id, data.thread, input);
      if (!thread) return threadNotFound(input);
      if (data.replyTo && thread.id !== threadId) return fail(err.badInput(catalog(input).invalidInput));
      threadId = thread.id;
    }
    if (!(await canReadThread(db, input, threadId))) return threadNotFound(input);
    if (threadId) {
      const [thread] = await db<
        { archived_at: Date | null }[]
      >`SELECT archived_at FROM chat.threads WHERE id = ${threadId}::uuid AND conversation_id = ${current.data.id}::uuid`;
      if (!thread) return threadNotFound(input);
      if (thread.archived_at) return fail({ code: "THREAD_ARCHIVED", status: 409, message: catalog(input).threadArchived });
    }
    if (data.attachments?.length) {
      const author = subjectPrincipal(input.accessSubject);
      const uploaded = await db<{ short_id: string }[]>`SELECT short_id FROM chat.attachments
        WHERE conversation_id = ${current.data.id}::uuid AND short_id = ANY(${toPgTextArray(data.attachments)}::text[])
          AND message_id IS NULL AND uploader_type = ${author.type} AND uploader_id = ${author.id}::uuid FOR UPDATE`;
      if (uploaded.length !== data.attachments.length)
        return fail({ code: "INVALID_ATTACHMENT", status: 400, message: catalog(input).attachmentUnavailable });
    }
    const row = await appendMessage(db, current.data, input, {
      kind: "text",
      clientId: data.clientId,
      body: data.body,
      refs: data.refs,
      attachments: data.attachments,
      threadId: threadId ?? undefined,
      replyToSeq,
    });
    return ok({ message: (await messageViews(db, [row], input.conversationId, input.accessSubject, input.locale))[0]!, created: true });
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
    const thread = query.thread && query.thread !== "general" ? await findThread(db, allowed.data.id, query.thread, input) : null;
    if (query.thread && query.thread !== "general" && !thread) return threadNotFound(input);
    const filter = query.thread === undefined ? db`true` : thread ? db`thread_id = ${thread.id}::uuid` : db`thread_id IS NULL`;
    const candidates = await db<MessageRow[]>`SELECT * FROM chat.messages WHERE conversation_id = ${allowed.data.id}::uuid
      AND ${filter}
      AND ${query.before !== undefined ? db`seq < ${query.before}` : query.after !== undefined ? db`seq > ${query.after}` : db`true`}
      ORDER BY seq ${query.after !== undefined ? db`ASC` : db`DESC`} LIMIT ${MESSAGE_PAGE_SIZE}`;
    if (query.after === undefined) candidates.reverse();
    const rows = query.thread === undefined ? await visibleMessages(db, input, candidates) : candidates;
    const seqHead = Number(allowed.data.seq_head);
    const full = candidates.length === MESSAGE_PAGE_SIZE;
    return ok({
      items: await messageViews(db, rows, input.conversationId, input.accessSubject, input.locale),
      seqHead,
      rev: Number(allowed.data.rev),
      ...(query.after !== undefined
        ? { from: query.after + 1, to: full ? Number(candidates.at(-1)!.seq) : seqHead }
        : { from: full ? Number(candidates[0]!.seq) : 1, to: query.before !== undefined ? Math.min(query.before - 1, seqHead) : seqHead }),
    });
  });
};
const snapshot = async (
  input: Input & { messageId?: string; thread?: string },
): Promise<Result<Omit<z.infer<typeof ChatSnapshotSchema>, "cursor">>> => {
  const parsed = parse(SnapshotQuerySchema, { message: input.messageId, thread: input.thread }, input);
  if (!parsed.ok) return parsed;
  const opened = await openParticipant(input);
  if (!opened.ok) return opened;
  return sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (db) => {
    const allowed = await requireConversation({ ...input, required: "read" }, db);
    if (!allowed.ok) return allowed;
    const selector = parsed.data.thread;
    const thread = selector && selector !== "general" ? await findThread(db, allowed.data.id, selector, input) : null;
    if (selector && selector !== "general" && !thread) return threadNotFound(input);
    const conversation = await conversations.get(
      { ...input, ...(selector !== undefined ? { selectedThread: thread?.id ?? null } : {}) },
      db,
    );
    if (!conversation.ok) return conversation;
    const filter = selector === undefined ? db`true` : thread ? db`thread_id = ${thread.id}::uuid` : db`thread_id IS NULL`;
    const id = MessageIdSchema.safeParse(input.messageId);
    const [candidateTarget] = id.success
      ? await db<{ short_id: string; seq: bigint | string; thread_id: string | null }[]>`SELECT short_id, seq, thread_id FROM chat.messages
          WHERE conversation_id = ${allowed.data.id}::uuid AND short_id = ${id.data} AND ${filter}`
      : [];
    const target = candidateTarget && (await canReadThread(db, input, candidateTarget.thread_id)) ? candidateTarget : undefined;
    const visible = selector === undefined ? await visibleThreadIdPage(db, input, allowed.data.id) : { ids: thread ? [thread.id] : [] };
    const states = await threadStates(db, input.accessSubject, allowed.data.id, visible.ids);
    const hasThreads = states.some((state) => state.id !== null);
    const starts = states
      .filter((state) => state.unread > 0 && (selector === undefined || state.id === (thread?.id ?? null)))
      .map((state) =>
        selector !== "general" && hasThreads
          ? Number(state.first_unread_seq) - 1
          : readStart(
              state.joined_seq === null
                ? null
                : {
                    joinedSeq: Number(state.joined_seq),
                    lastReadSeq: state.last_read_seq === null ? null : Number(state.last_read_seq),
                    unreadFromSeq: state.unread_from_seq === null ? null : Number(state.unread_from_seq),
                  },
            ),
      )
      .filter((start): start is number => start !== null);
    const start = starts.length ? Math.min(...starts) : null;
    const position = target
      ? Number(target.seq)
      : input.messageId === undefined && conversation.data.unread > 0 && start !== null
        ? start + 1
        : null;
    const candidates = await db<MessageRow[]>`SELECT * FROM chat.messages WHERE conversation_id = ${allowed.data.id}::uuid
      AND ${filter}
      AND ${position !== null ? db`seq < ${position + MESSAGE_PAGE_SIZE / 2}` : db`true`}
      ORDER BY seq DESC LIMIT ${MESSAGE_PAGE_SIZE}`;
    candidates.reverse();
    const rows = selector === undefined ? await visibleMessages(db, input, candidates) : candidates;
    const seqHead = Number(allowed.data.seq_head);
    const list = await threads.list(
      {
        ...input,
        query: allowed.data.kind === "system" && selector === undefined ? { short: "true" } : undefined,
        selectedThread: selector === "general" ? "general" : thread?.short_id,
      },
      db,
    );
    if (!list.ok) return list;
    return ok({
      conversation: conversation.data,
      page: {
        items: await messageViews(db, rows, input.conversationId, input.accessSubject, input.locale),
        seqHead,
        rev: Number(allowed.data.rev),
        from: candidates.length === MESSAGE_PAGE_SIZE ? Number(candidates[0]!.seq) : 1,
        to: position !== null ? Math.min(position + MESSAGE_PAGE_SIZE / 2 - 1, seqHead) : seqHead,
      },
      threads: list.data,
      focus: target?.short_id ?? null,
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
  return row && (await canReadThread(sql, input, row.thread_id))
    ? ok((await messageViews(sql, [row], input.conversationId, input.accessSubject, input.locale))[0]!)
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
    const candidates = await db<
      MessageRow[]
    >`SELECT * FROM chat.messages WHERE conversation_id = ${allowed.data.id}::uuid AND rev > ${afterRev}
      ORDER BY rev LIMIT ${CHANGES_PAGE_SIZE}`;
    const rows = await visibleMessages(db, input, candidates);
    const conversation = Number(allowed.data.changed_rev) > afterRev ? await conversations.get(input, db) : null;
    if (conversation && !conversation.ok) return conversation;
    const more = candidates.length === CHANGES_PAGE_SIZE;
    return ok({
      rev: more ? Number(candidates.at(-1)!.rev) : head,
      more,
      conversation: conversation?.data ?? null,
      messages: await messageViews(db, rows, input.conversationId, input.accessSubject, input.locale),
    });
  });
};

export const messages = { send, list, get, changes, snapshot };
