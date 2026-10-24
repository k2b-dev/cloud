import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { messagePreview } from "../system-messages";
import {
  type AuthorizedConversation,
  boundConversation,
  type ChatContext,
  capPermission,
  messages,
  requireConversation,
  subjectPrincipal,
} from "./access";
import { FOR_YOU_COUNT_CAP, FOR_YOU_PAGE_SIZE, type ForYouPageSchema, ForYouQuerySchema } from "./contracts";
import { titles } from "./conversation-titles";
import { type MessageRow, messageViews } from "./message-store";
import { RESOURCE_PAGE_SIZE, readerBatch, readResource } from "./resource-access";
import { visibleMessages } from "./thread-access";
import type { ThreadRow } from "./threads";

const CursorSchema = z.strictObject({ v: z.literal(1), at: z.iso.datetime(), id: z.uuid() });
type Cursor = z.infer<typeof CursorSchema>;
export const decodeForYouCursor = (value: string): Cursor | null => {
  try {
    if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
    return CursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    return null;
  }
};
type Candidate = MessageRow & { id: string; conversation: string; mention: boolean; unread: boolean; cursor_at: string };
const position = (row: Candidate): Cursor => ({ v: 1, at: row.cursor_at, id: row.id });
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
const allowedPersonal = (context: ChatContext) => {
  const bound = boundConversation(context.actor);
  return bound.ok && bound.data === null && capPermission("read", context.actor) !== "none";
};
/** Only recipient-indexed mentions and indexed replies to the subject's messages enter this page. */
const candidates = (db: typeof sql, context: ChatContext, limit: number, cursor: Cursor | null, unreadOnly = false) => {
  const self = subjectPrincipal(context.accessSubject);
  return db<Candidate[]>`WITH targets AS (
    SELECT mm.message_id, true AS mention FROM chat.message_mentions mm
      WHERE mm.principal_type = ${self.type} AND mm.principal_id = ${self.id}::uuid
    UNION ALL
    SELECT reply.id, false FROM chat.messages original JOIN chat.messages reply
      ON reply.conversation_id = original.conversation_id AND reply.reply_to_seq = original.seq
      WHERE original.author_type = ${self.type} AND original.author_id = ${self.id}::uuid
  ), distinct_targets AS (SELECT message_id, bool_or(mention) AS mention FROM targets GROUP BY message_id), page AS (
    SELECT m.*, c.short_id AS conversation, target.mention,
      to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
      (p.conversation_id IS NOT NULL AND m.seq > LEAST(GREATEST(COALESCE(
        CASE WHEN m.thread_id IS NULL THEN p.last_read_seq ELSE tr.last_read_seq END, 0), p.joined_seq),
        COALESCE((CASE WHEN m.thread_id IS NULL THEN p.unread_from_seq ELSE tr.unread_from_seq END) - 1, 9223372036854775807))) AS unread
    FROM distinct_targets target JOIN chat.messages m ON m.id = target.message_id
    JOIN chat.conversations c ON c.id = m.conversation_id
    LEFT JOIN chat.participants p ON p.conversation_id = c.id AND p.principal_type = ${self.type} AND p.principal_id = ${self.id}::uuid
    LEFT JOIN chat.thread_reads tr ON tr.thread_id = m.thread_id AND tr.principal_type = ${self.type} AND tr.principal_id = ${self.id}::uuid
    WHERE m.kind = 'text' AND NOT (m.author_type = ${self.type} AND m.author_id = ${self.id}::uuid)
      AND ${cursor ? db`(m.created_at, m.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : db`true`}
  ) SELECT * FROM page WHERE ${unreadOnly ? db`unread` : db`true`} ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
};
const visible = async (db: typeof sql, context: ChatContext, rows: Candidate[]) => {
  const ids = [...new Set(rows.map((row) => row.conversation))];
  const groups = await readerBatch(
    ids,
    async (conversationId) => {
      const allowed = await requireConversation({ ...context, conversationId, required: "read" }, db);
      if (!allowed.ok) return null;
      if (allowed.data.kind === "system" && allowed.data.resource_type && allowed.data.resource_id) {
        const resource = await readResource(context, { type: allowed.data.resource_type, id: allowed.data.resource_id });
        if (!resource) return null;
        allowed.data.name = resource.name;
      }
      return {
        conversation: allowed.data,
        rows: await visibleMessages(
          db,
          context,
          rows.filter((row) => row.conversation === conversationId),
        ),
      };
    },
    context.caller?.signal,
  );
  const conversations = new Map<string, AuthorizedConversation>();
  const readable = new Set<string>();
  for (const group of groups)
    if (group) {
      conversations.set(group.conversation.short_id, group.conversation);
      for (const row of group.rows) readable.add(row.id);
    }
  return { rows: rows.filter((row) => readable.has(row.id)), conversations };
};
const list = async (context: ChatContext & { query?: unknown }): Promise<Result<z.infer<typeof ForYouPageSchema>>> => {
  if (!allowedPersonal(context)) return fail(err.forbidden(messages(context).forbidden));
  const parsed = ForYouQuerySchema.safeParse(context.query ?? {});
  if (!parsed.success) return fail(err.badInput(messages(context).invalidInput));
  const cursor = parsed.data.cursor === undefined ? null : decodeForYouCursor(parsed.data.cursor);
  if (parsed.data.cursor !== undefined && !cursor) return fail(err.badInput(messages(context).invalidInput));
  return sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (db) => {
    const scanned = await candidates(db, context, FOR_YOU_PAGE_SIZE + 1, cursor);
    const page = scanned.slice(0, FOR_YOU_PAGE_SIZE);
    const authorized = await visible(db, context, page);
    const names = await titles([...authorized.conversations.values()], context, db);
    const views = new Map<string, Awaited<ReturnType<typeof messageViews>>[number]>();
    for (const conversation of authorized.conversations.values())
      for (const message of await messageViews(
        db,
        authorized.rows.filter((row) => row.conversation === conversation.short_id),
        conversation.short_id,
        context.accessSubject,
        context.locale,
      ))
        views.set(message.id, message);
    const threadIds = [...new Set(authorized.rows.flatMap((row) => (row.thread_id ? [row.thread_id] : [])))];
    const threads = threadIds.length
      ? await db<ThreadRow[]>`SELECT * FROM chat.threads WHERE id = ANY(${toPgUuidArray(threadIds)}::uuid[])`
      : [];
    const threadNames = new Map(
      await readerBatch(
        threads,
        async (thread) => {
          const resource =
            thread.resource_type && thread.resource_id
              ? await readResource(context, { type: thread.resource_type, id: thread.resource_id })
              : null;
          return [thread.id, thread.resource_type ? (resource?.name ?? null) : thread.name] as const;
        },
        context.caller?.signal,
      ),
    );
    const items: z.infer<typeof ForYouPageSchema>["items"] = [];
    for (const row of authorized.rows) {
      const conversation = authorized.conversations.get(row.conversation)!;
      const message = views.get(row.short_id)!;
      const name = row.thread_id ? threadNames.get(row.thread_id) : messages(context).general;
      if (name == null) continue;
      items.push({
        kind: row.mention ? "mention" : "reply",
        conversation: { id: row.conversation, kind: conversation.kind, title: names.get(conversation.id)! },
        thread: { id: message.thread ?? "general", name },
        message: {
          id: message.id,
          seq: message.seq,
          author: message.author,
          preview: messagePreview(message.body!),
          createdAt: message.createdAt,
        },
        unread: row.unread,
      });
    }
    return ok({ items, nextCursor: scanned.length > FOR_YOU_PAGE_SIZE ? encode(position(page.at(-1)!)) : null });
  });
};
/**
 * Keyset batches bound memory and concurrent readers. Stop at the display cap, at exhaustion, or after a fixed number
 * of batches, because every sidebar read waits for this count: a reader with very many unread mentions they can no
 * longer read sees a lower count rather than a slow list. Honor request cancellation.
 */
const FOR_YOU_COUNT_BATCHES = 5;
export const forYouUnread = async (context: ChatContext, db: typeof sql = sql) => {
  if (!allowedPersonal(context)) return 0;
  let total = 0;
  let cursor: Cursor | null = null;
  for (let batch = 0; batch < FOR_YOU_COUNT_BATCHES && total < FOR_YOU_COUNT_CAP; batch++) {
    context.caller?.signal?.throwIfAborted();
    const page = await candidates(db, context, RESOURCE_PAGE_SIZE, cursor, true);
    total += (await visible(db, context, page)).rows.length;
    if (page.length < RESOURCE_PAGE_SIZE) break;
    cursor = position(page.at(-1)!);
  }
  return Math.min(total, FOR_YOU_COUNT_CAP);
};
export const forYou = { list };
