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
} from "./contracts";
import { chatLive } from "./live";
import { threadStates } from "./thread-state";

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
  threads: number;
  channel: boolean;
  member: boolean;
};
/** Production and EXPLAIN use this same bounded, index-backed count and snapshot revision. */
export const unreadQuery = (db: typeof sql, subject: AccessSubject, conversationIds: readonly string[]) => {
  const self = subjectPrincipal(subject);
  return db`SELECT c.id AS conversation_id, c.short_id, c.rev,
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
  row: ReadProjection,
): { read: ReadState | null; unread: number; threads: number; channel: boolean; member: boolean } => ({
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
const update = async (
  db: typeof sql,
  context: ChatContext,
  id: string,
  touched: string[] = [],
): Promise<z.infer<typeof ReadUpdateSchema>> => {
  const [row] = await db<ReadProjection[]>`${unreadQuery(db, context.accessSubject, [id])}`;
  if (!row) throw new Error("Read state has no conversation");
  const state = projectRead(row);
  if (!state.read) throw new Error("Read update has no participant");
  const threads = touched.length
    ? (await threadStates(db, context.accessSubject, id))
        .filter((thread) => thread.id !== null && touched.includes(thread.id))
        .map((thread) => ({
          id: thread.short_id!,
          lastReadSeq: thread.last_read_seq === null ? null : Number(thread.last_read_seq),
          unreadFromSeq: thread.unread_from_seq === null ? null : Number(thread.unread_from_seq),
          unread: thread.unread,
        }))
    : [];
  return { conversationId: row.short_id, ...state.read, unread: state.unread, asOfRev: Number(row.rev), threads };
};
const publish = async (db: typeof sql, context: ChatContext, data: z.infer<typeof ReadUpdateSchema>) => {
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
  const position = seq === undefined ? db`seq_head` : db`LEAST(${seq}, seq_head)`;
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
const advanceThreads = async (db: typeof sql, context: ChatContext, id: string, seq: number, thread: string) => {
  const self = subjectPrincipal(context.accessSubject);
  return db<
    { thread_id: string }[]
  >`INSERT INTO chat.thread_reads AS tr (principal_type, principal_id, conversation_id, thread_id, last_read_seq)
    SELECT ${self.type}, ${self.id}::uuid, t.conversation_id, t.id, ${seq} FROM chat.threads t
    WHERE t.conversation_id = ${id}::uuid AND ${thread === "all" ? db`true` : db`t.short_id = ${thread}`}
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
    if (selector !== "general" && selector !== "all") {
      const [thread] = await db`SELECT id FROM chat.threads WHERE conversation_id = ${allowed.data.id}::uuid AND short_id = ${selector}`;
      if (!thread) return fail({ code: "NOT_FOUND", status: 404, message: messages(input).threadNotFound });
    }
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
    const touched = selector === "general" ? [] : await advanceThreads(db, input, allowed.data.id, s, selector);
    const data = await update(
      db,
      input,
      allowed.data.id,
      touched.map((row) => row.thread_id),
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
            WHERE conversation_id = ${allowed.data.id}::uuid AND kind = 'text'
              AND NOT (author_type = ${self.type} AND author_id = ${self.id}::uuid) ORDER BY seq DESC LIMIT 1)
        ) latest ORDER BY priority LIMIT 1`;
    if (parsed.data.message && !message) return fail({ code: "NOT_FOUND", status: 404, message: messages(input).messageNotFound });
    const { row, created } = await ensure(db, input, allowed.data.id);
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
      const data = await update(db, input, allowed.data.id, changed ? [message.thread_id] : []);
      if (created || changed) published = await publish(db, input, data);
      return ok(data);
    }
    const from = Number(message?.seq ?? row.seq_head);
    const base = Math.max(Number(row.last_read_seq ?? 0), Number(row.joined_seq));
    const changed = from >= 1 && from <= base && from !== (row.unread_from_seq === null ? null : Number(row.unread_from_seq));
    if (changed)
      await db`UPDATE chat.participants SET unread_from_seq = ${from} WHERE conversation_id = ${allowed.data.id}::uuid AND principal_type = ${self.type} AND principal_id = ${self.id}::uuid`;
    const data = await update(db, input, allowed.data.id);
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
    if (created) published = await publish(db, input, await update(db, input, allowed.data.id));
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
    const candidates = (limit: number) => db<{ id: string }[]>`SELECT c.id FROM chat.conversations c
      JOIN chat.participants p ON p.conversation_id = c.id AND p.principal_type = ${self.type} AND p.principal_id = ${self.id}::uuid
      WHERE EXISTS (SELECT 1 FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
        WHERE ca.conversation_id = c.id AND ${readableMemberCondition(input.accessSubject, bound.data, db)})
      AND EXISTS (SELECT 1 FROM (${threadStates(db, input.accessSubject, db`c.id`)}) states
        WHERE states.unread > 0 OR states.unread_from_seq IS NOT NULL)
      ORDER BY c.last_activity_at DESC, c.short_id DESC LIMIT ${limit}`;
    const batch = await candidates(parsed.data.confirmed ? READ_ALL_BATCH : READ_ALL_CONFIRM_FROM);
    if (!parsed.data.confirmed && batch.length >= READ_ALL_CONFIRM_FROM) return ok({ outcome: "confirm" });
    let marked = 0;
    // All operations acquire participant locks in this order; never take a conversation lock.
    for (const { id } of batch.sort((a, b) => a.id.localeCompare(b.id))) {
      const [row] = await lockParticipant(db, input, id);
      if (!row) continue;
      const changed =
        await db`UPDATE chat.participants SET last_read_seq = GREATEST(COALESCE(last_read_seq, ${row.seq_head}), ${row.seq_head}), unread_from_seq = NULL
        WHERE conversation_id = ${id}::uuid AND principal_type = ${self.type} AND principal_id = ${self.id}::uuid
          AND (last_read_seq IS DISTINCT FROM GREATEST(COALESCE(last_read_seq, ${row.seq_head}), ${row.seq_head}) OR unread_from_seq IS NOT NULL)
        RETURNING conversation_id`;
      const touched = await advanceThreads(db, input, id, Number(row.seq_head), "all");
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
          ),
        );
      }
    }
    return ok({ outcome: "done", marked, more: (await candidates(1)).length > 0 });
  });
  if (result.ok && result.data.outcome === "done" && result.data.marked) chatLive.wake();
  return result;
};
export const readState = { read, markUnread, readAll };
