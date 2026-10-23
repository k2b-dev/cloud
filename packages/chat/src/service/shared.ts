import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { sql } from "bun";
import { z } from "zod";
import { type ChatContext, messages, requireConversation } from "./access";
import {
  MAX_MESSAGE_LINKS,
  MAX_MESSAGE_REFS,
  SHARED_PAGE_SIZE,
  type SharedItem,
  type SharedPageSchema,
  SharedQuerySchema,
} from "./contracts";
import { type MessageRow, messageViews } from "./message-store";
import { visibleMessages } from "./thread-access";
import { findThread, threadNotFound } from "./threads";

// A sequence alone would skip items when a page ends inside a message. Positions are stable across kind filters:
// refs occupy 0..9, links 10..29. Clients treat this bounded, versioned cursor as opaque.
const CursorSchema = z.strictObject({
  v: z.literal(1),
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  position: z
    .number()
    .int()
    .min(0)
    .max(MAX_MESSAGE_REFS + MAX_MESSAGE_LINKS - 1),
});
const decodeCursor = (cursor: string) => {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
    return CursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    return null;
  }
};
const list = async (
  input: ChatContext & { conversationId: string; query?: unknown },
): Promise<Result<z.infer<typeof SharedPageSchema>>> => {
  const parsed = SharedQuerySchema.safeParse(input.query ?? {});
  if (!parsed.success) return fail(err.badInput(messages(input).invalidInput));
  const query = parsed.data;
  const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
  if (query.cursor !== undefined && !cursor) return fail(err.badInput(messages(input).invalidInput));
  return sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (db) => {
    const allowed = await requireConversation({ ...input, required: "read" }, db);
    if (!allowed.ok) return allowed;
    const thread = query.thread && query.thread !== "general" ? await findThread(db, allowed.data.id, query.thread, input) : null;
    if (query.thread && query.thread !== "general" && !thread) return threadNotFound(input);
    if (query.kind === "images" || query.kind === "documents") return ok({ items: [], nextCursor: null });
    const threadFilter = query.thread === undefined ? db`true` : thread ? db`thread_id = ${thread.id}::uuid` : db`thread_id IS NULL`;
    const kindFilter =
      query.kind === "elements"
        ? db`refs <> '[]'::jsonb`
        : query.kind === "links"
          ? db`links <> '{}'`
          : db`(refs <> '[]'::jsonb OR links <> '{}')`;
    // At most the cursor's message contributes no remaining items. One message per item plus that message and
    // one lookahead bounds the read, even for sparse chats; no scan of unrelated message bodies is needed.
    const scanned = await db<MessageRow[]>`SELECT * FROM chat.messages WHERE conversation_id = ${allowed.data.id}::uuid
      AND ${threadFilter} AND ${kindFilter} AND ${cursor ? db`seq <= ${cursor.seq}` : db`true`}
      ORDER BY seq DESC LIMIT ${SHARED_PAGE_SIZE + 2}`;
    const rows = query.thread === undefined ? await visibleMessages(db, input, scanned) : scanned;
    const views = await messageViews(db, rows, input.conversationId, input.locale);
    const candidates: { item: SharedItem; position: number }[] = [];
    for (const [index, row] of rows.entries()) {
      const message = views[index]!;
      const metadata = {
        messageId: message.id,
        seq: message.seq,
        thread: message.thread,
        author: message.author,
        createdAt: message.createdAt,
      };
      if (query.kind !== "links")
        row.refs.forEach((ref, position) => candidates.push({ item: { kind: "element", ref, ...metadata }, position }));
      if (query.kind !== "elements")
        row.links.forEach((url, index) =>
          candidates.push({ item: { kind: "link", url, ...metadata }, position: MAX_MESSAGE_REFS + index }),
        );
    }
    const remaining = candidates.filter(({ item, position }) => !cursor || item.seq < cursor.seq || position > cursor.position);
    const page = remaining.slice(0, SHARED_PAGE_SIZE);
    const last = page.at(-1);
    return ok({
      items: page.map(({ item }) => item),
      nextCursor:
        remaining.length > SHARED_PAGE_SIZE && last
          ? Buffer.from(JSON.stringify({ v: 1, seq: last.item.seq, position: last.position })).toString("base64url")
          : scanned.length === SHARED_PAGE_SIZE + 2
            ? Buffer.from(
                JSON.stringify({ v: 1, seq: Number(scanned.at(-1)!.seq), position: MAX_MESSAGE_REFS + MAX_MESSAGE_LINKS - 1 }),
              ).toString("base64url")
            : null,
    });
  });
};

export const shared = { list };
