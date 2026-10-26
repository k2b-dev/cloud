import { type AccessSubject, err, fail, ok, type Result } from "@k2b/cloud/server";
import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type { z } from "zod";
import {
  boundConversation,
  type ChatContext,
  capPermission,
  messages,
  personalChannelKey,
  principalCondition,
  readableMemberCondition,
  requireConversation,
  subjectPrincipal,
} from "./access";
import {
  MarkUnreadSchema,
  READ_ALL_BATCH,
  READ_ALL_CONFIRM_FROM,
  type ReadAllOutcomeSchema,
  ReadAllSchema,
  ReadSchema,
  type ReadState,
  type ReadUpdateSchema,
  UNREAD_CAP,
  UNREAD_TOTAL_CAP,
} from "./contracts";
import { chatLive } from "./live";
import { canReadThread, messageCondition, SUMMARY_TRAVERSAL_BUDGET, visibleThreadIdPage } from "./thread-access";
import { threadStates } from "./thread-state";
import { findThread } from "./threads";

// PostgreSQL's largest bigint keeps the optional mark out of the minimum.
export const readStartSql = (db: typeof sql) =>
  db`LEAST(GREATEST(COALESCE(p.last_read_seq, 0), p.joined_seq), COALESCE(p.unread_from_seq - 1, 9223372036854775807))`;
export type ReadProjection = {
  conversation_id: string;
  short_id: string;
  rev: string | bigint;
  last_read_seq: string | bigint | null;
  unread_from_seq: string | bigint | null;
  joined_seq: string | bigint | null;
  unread: number;
  archived_at: Date | null;
  pinned_rank: number | null;
  threads: number;
  channel: boolean;
  member: boolean;
};
/** Production and EXPLAIN use this same bounded, index-backed count and snapshot revision. */
export const unreadQuery = (db: typeof sql, subject: AccessSubject, conversationIds: readonly string[]) => {
  const self = subjectPrincipal(subject);
  return db`SELECT c.id AS conversation_id, c.short_id, c.rev, p.archived_at, p.pinned_rank,
    EXISTS(SELECT 1 FROM chat.conversation_access ca WHERE ca.conversation_id = c.id AND ca.role = 'discoverable') AS channel,
    EXISTS(SELECT 1 FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
      WHERE ca.conversation_id = c.id AND ca.role = 'member' AND ${principalCondition(subject, db)}
        AND a.permission IN ('read', 'write', 'admin')) AS member,
    (SELECT count(*)::int FROM chat.threads t WHERE t.conversation_id = c.id) AS threads, p.last_read_seq, p.unread_from_seq, p.joined_seq,
    CASE WHEN NOT EXISTS (SELECT 1 FROM chat.threads t WHERE t.conversation_id = c.id) THEN
      CASE WHEN p.conversation_id IS NOT NULL AND c.seq_head > ${readStartSql(db)} THEN
        (SELECT count(*)::int FROM (SELECT seq FROM chat.messages m
          WHERE m.conversation_id = c.id AND m.seq > ${readStartSql(db)} AND m.kind = 'text'
            AND NOT (m.author_type = ${self.type} AND m.author_id = ${self.id}::uuid)
          ORDER BY m.seq LIMIT ${UNREAD_CAP}) counting) ELSE 0 END
    ELSE (SELECT LEAST(COALESCE(sum(states.unread), 0), ${UNREAD_CAP})::int
      FROM (${threadStates(db, subject, db`c.id`)}) states) END AS unread
    FROM chat.conversations c LEFT JOIN chat.participants p ON p.conversation_id = c.id
      AND p.principal_type = ${self.type} AND p.principal_id = ${self.id}::uuid
    WHERE c.id = ANY(${toPgUuidArray([...conversationIds])}::uuid[])`;
};
export const projectRead = (
  row: Pick<
    ReadProjection,
    "joined_seq" | "last_read_seq" | "unread_from_seq" | "unread" | "threads" | "channel" | "member" | "archived_at" | "pinned_rank"
  >,
): {
  read: ReadState | null;
  unread: number;
  archived: boolean;
  pinnedRank: number | null;
  threads: number;
  channel: boolean;
  member: boolean;
} => ({
  archived: row.archived_at !== null,
  pinnedRank: row.pinned_rank,
  read:
    row.joined_seq === null
      ? null
      : {
          lastReadSeq: row.last_read_seq === null ? null : Number(row.last_read_seq),
          unreadFromSeq: row.unread_from_seq === null ? null : Number(row.unread_from_seq),
          joinedSeq: Number(row.joined_seq),
        },
  unread: row.unread,
  threads: row.threads,
  channel: row.channel,
  member: row.member,
});
export const readProjection = async (db: typeof sql, context: ChatContext, id: string, ids?: string[], includeGeneral = true) => {
  if (ids === undefined) return projectRead((await db<ReadProjection[]>`${unreadQuery(db, context.accessSubject, [id])}`)[0]!);
  const [flags] = await db<{ channel: boolean; member: boolean; archived_at: Date | null; pinned_rank: number | null }[]>`SELECT
    p.archived_at, p.pinned_rank,
    EXISTS(SELECT 1 FROM chat.conversation_access ca WHERE ca.conversation_id = c.id AND ca.role = 'discoverable') AS channel,
    EXISTS(SELECT 1 FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
      WHERE ca.conversation_id = c.id AND ca.role = 'member' AND ${principalCondition(context.accessSubject, db)}
        AND a.permission IN ('read', 'write', 'admin')) AS member
    FROM chat.conversations c LEFT JOIN chat.participants p ON p.conversation_id = c.id
      AND p.principal_type = ${subjectPrincipal(context.accessSubject).type} AND p.principal_id = ${subjectPrincipal(context.accessSubject).id}::uuid
    WHERE c.id = ${id}::uuid`;
  if (!flags) throw new Error("Read projection has no conversation");
  const states = await threadStates(db, context.accessSubject, id, ids);
  const general = states.find((state) => state.id === null)!;
  return projectRead({
    ...general,
    ...flags,
    unread: Math.min(
      UNREAD_CAP,
      states.reduce((sum, state) => sum + (state.id !== null || includeGeneral ? state.unread : 0), 0),
    ),
    threads: ids.length,
  });
};
const update = async (
  db: typeof sql,
  context: ChatContext,
  id: string,
  touched: string[] = [],
  page?: Awaited<ReturnType<typeof visibleThreadIdPage>>,
  includeGeneral = true,
): Promise<z.infer<typeof ReadUpdateSchema>> => {
  const visible = page ?? (await visibleThreadIdPage(db, context, id));
  const [row] = await db<{ short_id: string; rev: string }[]>`SELECT short_id, rev FROM chat.conversations WHERE id = ${id}::uuid`;
  if (!row) throw new Error("Read state has no conversation");
  const state = await readProjection(db, context, id, visible.ids, includeGeneral);
  if (!state.read) throw new Error("Read update has no participant");
  const threads = touched.length
    ? (await threadStates(db, context.accessSubject, id, touched))
        .filter((thread) => thread.id !== null)
        .map((thread) => ({
          id: thread.short_id!,
          lastReadSeq: thread.last_read_seq === null ? null : Number(thread.last_read_seq),
          unreadFromSeq: thread.unread_from_seq === null ? null : Number(thread.unread_from_seq),
          unread: thread.unread,
        }))
    : [];
  return {
    conversationId: row.short_id,
    ...state.read,
    unread: state.unread,
    asOfRev: Number(row.rev),
    threads,
    ...(visible.ids ? { summaryCursor: visible.nextCursor } : {}),
  };
};
const publish = async (db: typeof sql, context: ChatContext, data: z.infer<typeof ReadUpdateSchema>) => {
  const [conversation] = await db<{ kind: string }[]>`SELECT kind FROM chat.conversations WHERE short_id = ${data.conversationId}`;
  // Personal channels cannot reauthorize the container or item for each receiver's credential.
  if (conversation?.kind === "system") return false;
  await chatLive.publish(db, { key: personalChannelKey(context.accessSubject), data: { type: "read", ...data } });

  return true;
};
type ParticipantRow = {
  last_read_seq: string | bigint | null;
  unread_from_seq: string | bigint | null;
  joined_seq: string | bigint;
  seq_head: string | bigint;
};
const lockParticipant = (db: typeof sql, context: ChatContext, id: string) => {
  const self = subjectPrincipal(context.accessSubject);
  return db<ParticipantRow[]>`SELECT p.last_read_seq, p.unread_from_seq, p.joined_seq, c.seq_head FROM chat.participants p
    JOIN chat.conversations c ON c.id = p.conversation_id WHERE p.conversation_id = ${id}::uuid
      AND p.principal_type = ${self.type} AND p.principal_id = ${self.id}::uuid FOR UPDATE OF p`;
};
// Opening creates the row at the head; a first read creates it at the read seq (V5 rule 2).
const createParticipant = async (db: typeof sql, context: ChatContext, id: string, seq?: number) => {
  const self = subjectPrincipal(context.accessSubject);
  const position = seq === undefined ? db`seq_head` : db`CASE WHEN kind = 'system' THEN seq_head ELSE LEAST(${seq}, seq_head) END`;
  const inserted = await db`INSERT INTO chat.participants (conversation_id, principal_type, principal_id, origin, joined_seq, last_read_seq)
    SELECT id, ${self.type}, ${self.id}::uuid, 'ondemand', ${position}, ${seq === undefined ? db`NULL` : position}
    FROM chat.conversations WHERE id = ${id}::uuid
    ON CONFLICT DO NOTHING RETURNING conversation_id`;
  return inserted.length > 0;
};
const ensure = async (db: typeof sql, context: ChatContext, id: string, seq?: number) => {
  const created = await createParticipant(db, context, id, seq);
  const [row] = await lockParticipant(db, context, id);
  if (!row) throw new Error("Participant could not be created");
  return { row, created };
};
const parse = <T>(schema: z.ZodType<T>, input: unknown, context: ChatContext): Result<T> => {
  const parsed = schema.safeParse(input);
  return parsed.success ? ok(parsed.data) : fail(err.badInput(messages(context).invalidInput));
};
type Input = ChatContext & { conversationId: string };
const advanceThreads = async (db: typeof sql, context: ChatContext, id: string, seq: number, thread: string, ids?: string[]) => {
  const self = subjectPrincipal(context.accessSubject);
  return db<
    { thread_id: string }[]
  >`INSERT INTO chat.thread_reads AS tr (principal_type, principal_id, conversation_id, thread_id, last_read_seq)
    SELECT ${self.type}, ${self.id}::uuid, t.conversation_id, t.id, ${seq} FROM chat.threads t
    WHERE t.conversation_id = ${id}::uuid AND ${ids ? db`t.id = ANY(${toPgUuidArray(ids)}::uuid[])` : db`true`} AND ${thread === "all" ? db`true` : db`t.short_id = ${thread}`}
    ON CONFLICT (principal_type, principal_id, thread_id) DO UPDATE SET
      last_read_seq = GREATEST(COALESCE(tr.last_read_seq, EXCLUDED.last_read_seq), EXCLUDED.last_read_seq),
      unread_from_seq = CASE WHEN EXCLUDED.last_read_seq >= tr.unread_from_seq THEN
        CASE WHEN EXCLUDED.last_read_seq < tr.last_read_seq THEN EXCLUDED.last_read_seq + 1 ELSE NULL END ELSE tr.unread_from_seq END
    WHERE tr.last_read_seq IS NULL OR EXCLUDED.last_read_seq > tr.last_read_seq OR EXCLUDED.last_read_seq >= tr.unread_from_seq
    RETURNING thread_id`;
};
const read = async (input: Input & { input: unknown }) => {
  const parsed = parse(ReadSchema, input.input, input);
  if (!parsed.ok) return parsed;
  let published = false;
  const result = await sql.begin(async (db) => {
    const allowed = await requireConversation({ ...input, required: "read" }, db);
    if (!allowed.ok) return allowed;
    const selector = parsed.data.thread;
    const selected = selector !== "general" && selector !== "all" ? await findThread(db, allowed.data.id, selector, input) : null;
    if (selector !== "general" && selector !== "all" && !selected)
      return fail({ code: "NOT_FOUND", status: 404, message: messages(input).threadNotFound });
    const { row, created } = await ensure(db, input, allowed.data.id, parsed.data.seq);
    const s = Math.min(parsed.data.seq, Number(row.seq_head));
    const last = Math.max(row.last_read_seq === null ? s : Number(row.last_read_seq), s);
    const from = row.unread_from_seq === null ? null : Number(row.unread_from_seq);
    const next = from !== null && s >= from ? (s + 1 <= last ? s + 1 : null) : from;
    const changed =
      (selector === "general" || selector === "all") &&
      (created || row.last_read_seq === null || last !== Number(row.last_read_seq) || next !== from);
    if (changed) {
      const self = subjectPrincipal(input.accessSubject);
      await db`UPDATE chat.participants SET last_read_seq = ${last}, unread_from_seq = ${next}
        WHERE conversation_id = ${allowed.data.id}::uuid AND principal_type = ${self.type} AND principal_id = ${self.id}::uuid`;
    }
    const page =
      allowed.data.kind === "system"
        ? selector === "all"
          ? await visibleThreadIdPage(db, input, allowed.data.id, parsed.data.summaryCursor)
          : { ids: selector === "general" ? [] : [selected!.id], nextCursor: "" }
        : { ids: undefined, nextCursor: null };
    const touched = selector === "general" ? [] : await advanceThreads(db, input, allowed.data.id, s, selector, page.ids);
    const data = await update(
      db,
      input,
      allowed.data.id,
      touched.map((row) => row.thread_id),
      page,
      selector === "general" || selector === "all",
    );
    if (created || changed || touched.length) published = await publish(db, input, data);
    return ok(data);
  });
  if (result.ok && published) chatLive.wake();
  return result;
};
const markUnread = async (input: Input & { input: unknown }) => {
  const parsed = parse(MarkUnreadSchema, input.input, input);
  if (!parsed.ok) return parsed;
  let published = false;
  const result = await sql.begin(async (db) => {
    const allowed = await requireConversation({ ...input, required: "read" }, db);
    if (!allowed.ok) return allowed;
    const self = subjectPrincipal(input.accessSubject);
    const page = await visibleThreadIdPage(db, input, allowed.data.id);
    const visibility = messageCondition(db, page.ids);
    type MarkTarget = { seq: string | bigint; thread_id: string | null };
    const [message] = parsed.data.message
      ? await db<MarkTarget[]>`SELECT seq, thread_id FROM chat.messages
          WHERE conversation_id = ${allowed.data.id}::uuid AND short_id = ${parsed.data.message}`
      : await db<MarkTarget[]>`SELECT seq, thread_id FROM (
          (SELECT seq, thread_id, 0 AS priority FROM chat.messages
            WHERE conversation_id = ${allowed.data.id}::uuid AND thread_id IS NULL AND kind = 'text'
              AND NOT (author_type = ${self.type} AND author_id = ${self.id}::uuid) ORDER BY seq DESC LIMIT 1)
          UNION ALL
          (SELECT seq, thread_id, 1 AS priority FROM chat.messages
            WHERE conversation_id = ${allowed.data.id}::uuid AND kind = 'text' AND ${visibility}
              AND NOT (author_type = ${self.type} AND author_id = ${self.id}::uuid) ORDER BY seq DESC LIMIT 1)
        ) latest ORDER BY priority LIMIT 1`;
    if (parsed.data.message && (!message || !(await canReadThread(db, input, message.thread_id))))
      return fail({ code: "NOT_FOUND", status: 404, message: messages(input).messageNotFound });
    const { row, created } = await ensure(db, input, allowed.data.id);
    if (allowed.data.kind === "system" && Number(message?.seq ?? row.seq_head) <= Number(row.joined_seq))
      return ok(await update(db, input, allowed.data.id, [], page));
    if (message?.thread_id) {
      const [thread] = await db<{ last_read_seq: string | bigint | null; unread_from_seq: string | bigint | null }[]>`
        SELECT last_read_seq, unread_from_seq FROM chat.thread_reads WHERE thread_id = ${message.thread_id}::uuid
          AND principal_type = ${self.type} AND principal_id = ${self.id}::uuid`;
      const from = Number(message.seq);
      const base = Math.max(Number(thread?.last_read_seq ?? 0), Number(row.joined_seq));
      const changed = from >= 1 && from <= base && from !== Number(thread?.unread_from_seq ?? 0);
      if (changed)
        await db`INSERT INTO chat.thread_reads (principal_type, principal_id, conversation_id, thread_id, unread_from_seq)
        VALUES (${self.type}, ${self.id}::uuid, ${allowed.data.id}::uuid, ${message.thread_id}::uuid, ${from})
        ON CONFLICT (principal_type, principal_id, thread_id) DO UPDATE SET unread_from_seq = EXCLUDED.unread_from_seq`;
      const data = await update(db, input, allowed.data.id, changed ? [message.thread_id] : [], page);
      if (created || changed) published = await publish(db, input, data);
      return ok(data);
    }
    const from = Number(message?.seq ?? row.seq_head);
    const base = Math.max(Number(row.last_read_seq ?? 0), Number(row.joined_seq));
    const changed = from >= 1 && from <= base && from !== (row.unread_from_seq === null ? null : Number(row.unread_from_seq));
    if (changed)
      await db`UPDATE chat.participants SET unread_from_seq = ${from} WHERE conversation_id = ${allowed.data.id}::uuid AND principal_type = ${self.type} AND principal_id = ${self.id}::uuid`;
    const data = await update(db, input, allowed.data.id, [], page);
    if (created || changed) published = await publish(db, input, data);
    return ok(data);
  });
  if (result.ok && published) chatLive.wake();
  return result;
};
export const openParticipant = async (input: Input) => {
  let published = false;
  const result = await sql.begin(async (db) => {
    const allowed = await requireConversation({ ...input, required: "read" }, db);
    if (!allowed.ok) return allowed;
    const created = await createParticipant(db, input, allowed.data.id);
    if (created && allowed.data.kind !== "system") published = await publish(db, input, await update(db, input, allowed.data.id));
    return ok();
  });
  if (result.ok && published) chatLive.wake();
  return result;
};
const readAll = async (input: ChatContext & { input: unknown }): Promise<Result<z.infer<typeof ReadAllOutcomeSchema>>> => {
  const parsed = parse(ReadAllSchema, input.input, input);
  if (!parsed.ok) return parsed;
  const bound = boundConversation(input.actor, input.locale);
  if (!bound.ok) return bound;
  if (capPermission("read", input.actor) === "none") return ok({ outcome: "done", marked: 0, more: false });
  const result = await sql.begin(async (db): Promise<Result<z.infer<typeof ReadAllOutcomeSchema>>> => {
    const self = subjectPrincipal(input.accessSubject);
    const after = parsed.data.cursor;
    const rows = await db<{ id: string; short_id: string; kind: string; cursor_at: string }[]>`SELECT c.id, c.short_id, c.kind,
      to_char(c.last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM chat.conversations c
      JOIN chat.participants p ON p.conversation_id = c.id AND p.principal_type = ${self.type} AND p.principal_id = ${self.id}::uuid
      WHERE ${
        after
          ? after.thread !== undefined
            ? db`(c.last_activity_at, c.short_id) <= (${after.at}::timestamptz, ${after.id})`
            : db`(c.last_activity_at, c.short_id) < (${after.at}::timestamptz, ${after.id})`
          : db`true`
      }
      AND ${bound.data ? db`c.short_id = ${bound.data}` : db`true`}
      AND (c.kind = 'system' OR EXISTS (SELECT 1 FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
        WHERE ca.conversation_id = c.id AND ${readableMemberCondition(input.accessSubject, bound.data, db)}))
      AND (c.kind = 'system' OR EXISTS (SELECT 1 FROM (${threadStates(db, input.accessSubject, db`c.id`)}) states
        WHERE states.unread > 0 OR states.unread_from_seq IS NOT NULL))
      ORDER BY c.last_activity_at DESC, c.short_id DESC LIMIT ${READ_ALL_BATCH + 1}`;
    const budget = { remaining: SUMMARY_TRAVERSAL_BUDGET };
    const batch: { id: string; page: Awaited<ReturnType<typeof visibleThreadIdPage>> }[] = [];
    let nextCursor: string | null = null;
    for (const [index, row] of rows.slice(0, READ_ALL_BATCH).entries()) {
      input.caller?.signal?.throwIfAborted();
      const position = { at: row.cursor_at, id: row.short_id };
      nextCursor = index + 1 < rows.length ? JSON.stringify(position) : null;
      if (row.kind === "system") {
        const allowed = await requireConversation({ ...input, conversationId: row.short_id, required: "read" }, db);
        if (!allowed.ok) continue;
      }
      const page = await visibleThreadIdPage(db, input, row.id, after?.id === row.short_id ? after.thread : undefined, budget);
      const states = await threadStates(db, input.accessSubject, row.id, page.ids);
      if (states.some((state) => state.unread > 0 || state.unread_from_seq !== null)) batch.push({ id: row.id, page });
      if (page.nextCursor !== null) {
        nextCursor = JSON.stringify({ ...position, thread: page.nextCursor });
        break;
      }
    }
    // An incomplete preview cannot prove the operation is below the confirmation threshold.
    if (!parsed.data.confirmed && (batch.length >= READ_ALL_CONFIRM_FROM || nextCursor !== null)) return ok({ outcome: "confirm" });
    let marked = 0;
    // All operations acquire participant locks in this order; never take a conversation lock.
    for (const { id, page } of batch.sort((a, b) => a.id.localeCompare(b.id))) {
      const [row] = await lockParticipant(db, input, id);
      if (!row) continue;
      const changed =
        await db`UPDATE chat.participants SET last_read_seq = GREATEST(COALESCE(last_read_seq, ${row.seq_head}), ${row.seq_head}), unread_from_seq = NULL
        WHERE conversation_id = ${id}::uuid AND principal_type = ${self.type} AND principal_id = ${self.id}::uuid
          AND (last_read_seq IS DISTINCT FROM GREATEST(COALESCE(last_read_seq, ${row.seq_head}), ${row.seq_head}) OR unread_from_seq IS NOT NULL)
        RETURNING conversation_id`;
      const touched = await advanceThreads(db, input, id, Number(row.seq_head), "all", page.ids);
      if (changed.length || touched.length) {
        marked++;
        await publish(
          db,
          input,
          await update(
            db,
            input,
            id,
            touched.map((row) => row.thread_id),
            page,
          ),
        );
      }
    }
    return ok({
      outcome: "done",
      marked,
      more: nextCursor !== null,
      ...(rows.some((row) => row.kind === "system") || after ? { nextCursor } : {}),
    });
  });
  if (result.ok && result.data.outcome === "done" && result.data.marked) chatLive.wake();
  return result;
};
/** The reader's readable chats with unread messages or an unread mark, newest activity first. */
const unreadChats = (
  db: typeof sql,
  input: ChatContext,
  bound: Extract<ReturnType<typeof boundConversation>, { ok: true }>["data"],
  limit: number,
) => {
  const self = subjectPrincipal(input.accessSubject);
  return db<{ id: string }[]>`SELECT c.id FROM chat.conversations c
    JOIN chat.participants p ON p.conversation_id = c.id AND p.principal_type = ${self.type} AND p.principal_id = ${self.id}::uuid
    WHERE EXISTS (SELECT 1 FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
      WHERE ca.conversation_id = c.id AND ${readableMemberCondition(input.accessSubject, bound, db)})
    AND EXISTS (SELECT 1 FROM (${threadStates(db, input.accessSubject, db`c.id`)}) states
      WHERE states.unread > 0 OR states.unread_from_seq IS NOT NULL)
    ORDER BY c.last_activity_at DESC, c.short_id DESC LIMIT ${limit}`;
};

/**
 * Unread messages across all of the reader's chats, not only the first page of the list, up to `UNREAD_TOTAL_CAP`.
 * Every chat counted has at least one, so reading that many chats is enough to reach the cap.
 */
const unreadTotal = async (input: ChatContext): Promise<Result<{ count: number }>> => {
  const bound = boundConversation(input.actor, input.locale);
  if (!bound.ok) return bound;
  if (capPermission("read", input.actor) === "none") return ok({ count: 0 });
  const chats = await unreadChats(sql, input, bound.data, UNREAD_TOTAL_CAP);
  if (!chats.length) return ok({ count: 0 });
  const rows = await sql<ReadProjection[]>`${unreadQuery(
    sql,
    input.accessSubject,
    chats.map((chat) => chat.id),
  )}`;
  return ok({
    count: Math.min(
      UNREAD_TOTAL_CAP,
      rows.reduce((sum, row) => sum + row.unread, 0),
    ),
  });
};

export const readState = { read, markUnread, readAll, unreadTotal };
