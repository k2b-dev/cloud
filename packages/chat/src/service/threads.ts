import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { toPgUuidArray } from "@k2b/cloud/services";
import { crypto } from "@k2b/stdlib";
import { sql } from "bun";
import type { z } from "zod";
import { messagePreview } from "../system-messages";
import { type ChatContext, messages, requireConversation, subjectPrincipal } from "./access";
import {
  CreateThreadSchema,
  ForResourceSchema,
  MAX_THREADS,
  ThreadIdSchema,
  type ThreadListSchema,
  ThreadQuerySchema,
  type ThreadSchema,
  UpdateThreadSchema,
} from "./contracts";
import { chatLive } from "./live";
import { appendMessage, type MessageRow, messageViews } from "./message-store";
import { ItemRefSchema, readResource } from "./resource-access";
import { canReadThread, projectResource, visibleThreadPage } from "./thread-access";
import { threadStates } from "./thread-state";

type Input = ChatContext & { conversationId: string; query?: unknown; selectedThread?: string };
export type ThreadRow = {
  resource_type: string | null;
  resource_id: string | null;
  id: string;
  short_id: string;
  name: string;
  description: string | null;
  archived_at: Date | null;
  created_at: Date;
  last_activity_at: Date;
};
export const findThread = async (db: typeof sql, conversationId: string, id: string, context?: ChatContext) => {
  const [row] = await db<ThreadRow[]>`SELECT * FROM chat.threads WHERE conversation_id = ${conversationId}::uuid AND short_id = ${id}`;
  return row && (!context || (await canReadThread(db, context, row.id))) ? row : undefined;
};
export const threadNotFound = (context: ChatContext) => fail({ code: "NOT_FOUND", status: 404, message: messages(context).threadNotFound });
const projectList = async (
  db: typeof sql,
  input: Input,
  conversationId: string,
  onlyId?: string,
): Promise<z.infer<typeof ThreadListSchema>> => {
  const query = ThreadQuerySchema.parse(input.query ?? {});
  const [conversation] = await db<{ kind: string }[]>`SELECT kind FROM chat.conversations WHERE id = ${conversationId}::uuid`;
  const system = conversation?.kind === "system";
  const rows = await db<ThreadRow[]>`SELECT * FROM chat.threads WHERE conversation_id = ${conversationId}::uuid
    AND ${onlyId ? db`short_id = ${onlyId}` : db`true`}
    AND ${system && query.cursor ? db`short_id > ${query.cursor}` : db`true`}
    ORDER BY ${
      system
        ? db`short_id`
        : db`(archived_at IS NOT NULL), CASE WHEN archived_at IS NULL THEN last_activity_at END DESC,
      CASE WHEN archived_at IS NOT NULL THEN name END, short_id`
    } LIMIT ${MAX_THREADS + 1}`;
  const page = rows.slice(0, MAX_THREADS);
  const visible = await visibleThreadPage(input, page);
  const states = await threadStates(
    db,
    input.accessSubject,
    conversationId,
    visible.map(({ row }) => row.id),
  );
  const latest = await db<MessageRow[]>`SELECT m.* FROM chat.threads t
    CROSS JOIN LATERAL (SELECT * FROM chat.messages WHERE conversation_id = ${conversationId}::uuid
      AND thread_id = t.id AND kind = 'text' ORDER BY seq DESC LIMIT 1) m
    WHERE t.conversation_id = ${conversationId}::uuid AND t.id = ANY(${toPgUuidArray(visible.map(({ row }) => row.id))}::uuid[])
    UNION ALL
    (SELECT * FROM chat.messages WHERE conversation_id = ${conversationId}::uuid
      AND thread_id IS NULL AND kind = 'text' ORDER BY seq DESC LIMIT 1)`;
  const views = await messageViews(db, latest, input.conversationId, input.locale);
  const previews = new Map(
    views.map((message) => [
      message.thread,
      {
        id: message.id,
        author: message.author,
        preview: messagePreview(message.body!),
        createdAt: message.createdAt,
      },
    ]),
  );
  return {
    general: { unread: states.find((state) => state.id === null)!.unread, lastMessage: previews.get(null) ?? null },
    ...(system ? { nextCursor: rows.length > MAX_THREADS ? page.at(-1)!.short_id : null } : {}),
    items: visible
      .map(({ row, resource }) => {
        const state = states.find((state) => state.id === row.id)!;
        return {
          id: row.short_id,
          name: resource?.name ?? row.name,
          description: resource ? resource.description : row.description,
          ...(row.resource_type ? { resource: projectResource(row, resource) } : {}),
          archived: row.archived_at !== null,
          unread: state.unread,
          read:
            state.last_read_seq === null && state.unread_from_seq === null
              ? null
              : {
                  lastReadSeq: state.last_read_seq === null ? null : Number(state.last_read_seq),
                  unreadFromSeq: state.unread_from_seq === null ? null : Number(state.unread_from_seq),
                },
          lastMessage: previews.get(row.short_id) ?? null,
          lastActivityAt: row.last_activity_at.toISOString(),
          createdAt: row.created_at.toISOString(),
        };
      })
      .filter(
        (thread) =>
          (!query.q || `${thread.name} ${thread.description ?? ""}`.toLocaleLowerCase().includes(query.q.toLocaleLowerCase())) &&
          (query.filter !== "done" || thread.resource?.done === true) &&
          (query.filter !== "open" || thread.resource?.done !== true) &&
          (query.filter !== "unread" || thread.unread > 0),
      ),
  };
};
const project = async (db: typeof sql, input: Input, conversationId: string, id: string) => {
  const row = (await projectList(db, input, conversationId, id)).items.find((row) => row.id === id);
  if (!row) throw new Error("Thread projection has no thread");
  return row;
};
const publish = async (db: typeof sql, conversationId: string) => {
  // The collection also refetches summaries after a rename or archive.
  for (const prefix of ["c", "l"])
    await chatLive.publish(db, { key: `${prefix}:${conversationId}`, data: { type: "threads", conversationId } });
};
const read = async (input: Input, db: typeof sql) => {
  if (!ThreadQuerySchema.safeParse(input.query ?? {}).success) return fail(err.badInput(messages(input).invalidInput));
  const allowed = await requireConversation({ ...input, required: "read" }, db);
  if (!allowed.ok) return allowed;
  return ok(await projectList(db, input, allowed.data.id, allowed.data.kind === "system" ? input.selectedThread : undefined));
};
/** The chat's threads; inside a caller's transaction with `db`, for example the snapshot's. */
const list = (input: Input, db?: typeof sql) =>
  db ? read(input, db) : sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", (transaction) => read(input, transaction));
type Created = { thread: z.infer<typeof ThreadSchema>; created: boolean };
const create = async (input: Input & { input: unknown }): Promise<Result<Created>> => {
  const parsed = CreateThreadSchema.safeParse(input.input);
  if (!parsed.success) return fail(err.badInput(messages(input).invalidInput));
  const result = await sql.begin(async (db): Promise<Result<Created>> => {
    await db`SELECT id FROM chat.conversations WHERE short_id = ${input.conversationId} FOR UPDATE`;
    const allowed = await requireConversation({ ...input, required: "admin" }, db);
    if (!allowed.ok) return allowed;
    if (allowed.data.kind === "system") return fail(err.forbidden(messages(input).forbidden));
    const conversation = allowed.data;
    const self = subjectPrincipal(input.accessSubject);
    const { name, description, createKey } = parsed.data;
    const payload = JSON.stringify({ conversationId: conversation.id, name, description: description ?? null });
    if (createKey) {
      await db`SELECT pg_advisory_xact_lock(hashtextextended(${`chat.thread.create_intent:${self.type}:${self.id}:${createKey}`}, 0))`;
      const [retry] = await db<
        { short_id: string; same_payload: boolean }[]
      >`SELECT t.short_id, i.payload = ${payload}::jsonb AS same_payload
        FROM chat.thread_create_intents i JOIN chat.threads t ON t.id = i.thread_id
        WHERE i.principal_type = ${self.type}
          AND i.principal_id = ${self.id}::uuid AND i.create_key = ${createKey}::uuid`;
      if (retry)
        return retry.same_payload
          ? ok({ thread: await project(db, input, conversation.id, retry.short_id), created: false })
          : fail(err.conflict(messages(input).threadCreateIntentChanged));
    }
    const [channel] =
      await db`SELECT 1 FROM chat.conversation_access WHERE conversation_id = ${conversation.id}::uuid AND role = 'discoverable' LIMIT 1`;
    if (channel) return fail({ code: "THREADS_UNAVAILABLE", status: 409, message: messages(input).threadsUnavailable });
    const [duplicate] =
      await db`SELECT 1 FROM chat.threads WHERE conversation_id = ${conversation.id}::uuid AND lower(name) = lower(${name})`;
    if (duplicate) return fail({ code: "THREAD_NAME_TAKEN", status: 409, message: messages(input).threadNameTaken });
    const [count] = await db<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM chat.threads WHERE conversation_id = ${conversation.id}::uuid`;
    if (count!.count >= MAX_THREADS) return fail({ code: "THREAD_LIMIT", status: 409, message: messages(input).threadLimit });
    let row: ThreadRow | undefined;
    for (let attempt = 0; attempt < 10 && !row; attempt++) {
      [row] = await db<ThreadRow[]>`INSERT INTO chat.threads (short_id, conversation_id, name, description, created_by_type, created_by_id)
        VALUES (${crypto.common.readableId(6)}, ${conversation.id}::uuid, ${name}, ${description ?? null}, ${self.type}, ${self.id}::uuid)
        ON CONFLICT (short_id) DO NOTHING RETURNING *`;
    }
    if (!row) throw new Error("Thread ID could not be allocated");
    if (createKey)
      await db`INSERT INTO chat.thread_create_intents (principal_type, principal_id, conversation_id, create_key, payload, thread_id)
      VALUES (${self.type}, ${self.id}::uuid, ${conversation.id}::uuid, ${createKey}::uuid, ${payload}::jsonb, ${row.id}::uuid)`;
    await appendMessage(db, conversation, input, {
      kind: "system",
      system: { code: "thread_created", params: { thread: { id: row.short_id, name } } },
    });
    await publish(db, input.conversationId);
    return ok({ thread: await project(db, input, conversation.id, row.short_id), created: true });
  });
  if (result.ok && result.data.created) chatLive.wake();
  return result;
};
const update = async (input: Input & { threadId: string; input: unknown }) => {
  const parsed = UpdateThreadSchema.safeParse(input.input);
  if (!parsed.success || !ThreadIdSchema.safeParse(input.threadId).success) return fail(err.badInput(messages(input).invalidInput));
  const result = await sql.begin(async (db) => {
    await db`SELECT id FROM chat.conversations WHERE short_id = ${input.conversationId} FOR UPDATE`;
    const allowed = await requireConversation({ ...input, required: "admin" }, db);
    if (!allowed.ok) return allowed;
    if (allowed.data.kind === "system") return fail(err.forbidden(messages(input).forbidden));
    const row = await findThread(db, allowed.data.id, input.threadId);
    if (!row) return threadNotFound(input);
    const { name, description, archived } = parsed.data;
    if (name !== undefined) {
      const [duplicate] = await db`SELECT 1 FROM chat.threads WHERE conversation_id = ${allowed.data.id}::uuid
        AND id <> ${row.id}::uuid AND lower(name) = lower(${name})`;
      if (duplicate) return fail({ code: "THREAD_NAME_TAKEN", status: 409, message: messages(input).threadNameTaken });
    }
    await db`UPDATE chat.threads SET name = ${name ?? row.name}, description = ${description === undefined ? row.description : description},
      archived_at = ${archived === undefined ? row.archived_at : archived ? (row.archived_at ?? new Date()) : null} WHERE id = ${row.id}::uuid`;
    // A new name shows as a quiet line in the thread, so its members know why it reads differently now.
    if (name !== undefined && name !== row.name)
      await appendMessage(db, allowed.data, input, {
        kind: "system",
        system: { code: "thread_renamed", params: { from: row.name, to: name } },
        threadId: row.id,
      });
    else await db`UPDATE chat.conversations SET rev = rev + 1, changed_rev = rev + 1 WHERE id = ${allowed.data.id}::uuid`;
    await publish(db, input.conversationId);
    return ok(await project(db, input, allowed.data.id, row.short_id));
  });
  if (result.ok) chatLive.wake();
  return result;
};
const forResource = async (input: Input & { input: unknown }): Promise<Result<Created>> => {
  const parsed = ForResourceSchema.safeParse(input.input);
  if (!parsed.success || !ItemRefSchema.safeParse(parsed.data.ref).success) return fail(err.badInput(messages(input).invalidInput));
  const result = await sql.begin(async (db): Promise<Result<Created>> => {
    await db`SELECT id FROM chat.conversations WHERE short_id = ${input.conversationId} FOR UPDATE`;
    const allowed = await requireConversation({ ...input, required: "write" }, db);
    if (!allowed.ok) return allowed;
    const c = allowed.data;
    if (c.kind !== "system") return fail(err.badInput(messages(input).invalidInput));
    const ref = parsed.data.ref;
    const resource = await readResource(input, ref);
    if (!resource || resource.container?.type !== c.resource_type || resource.container.id !== c.resource_id) return threadNotFound(input);
    const [existing] = await db<ThreadRow[]>`SELECT * FROM chat.threads WHERE conversation_id = ${c.id}::uuid
      AND resource_type = ${ref.type} AND resource_id = ${ref.id}`;
    if (existing) return ok({ thread: await project(db, input, c.id, existing.short_id), created: false });
    const self = subjectPrincipal(input.accessSubject);
    let row: ThreadRow | undefined;
    for (let attempt = 0; attempt < 10 && !row; attempt++) {
      [row] = await db<ThreadRow[]>`INSERT INTO chat.threads
        (short_id, conversation_id, name, description, created_by_type, created_by_id, resource_type, resource_id)
        VALUES (${crypto.common.readableId(6)}, ${c.id}::uuid, ${Array.from(resource.name).slice(0, 80).join("")},
          ${resource.description === null ? null : Array.from(resource.description).slice(0, 80).join("")}, ${self.type}, ${self.id}::uuid, ${ref.type}, ${ref.id})
        ON CONFLICT (short_id) DO NOTHING RETURNING *`;
    }
    if (!row) throw new Error("Thread ID could not be allocated");
    await db`UPDATE chat.conversations SET rev = rev + 1, changed_rev = rev + 1 WHERE id = ${c.id}::uuid`;
    // No thread_created line: item metadata belongs to its owning application.
    for (const prefix of ["t", "s"])
      await chatLive.publish(db, { key: `${prefix}:${c.short_id}:${row.short_id}`, data: { type: "threads", conversationId: c.short_id } });
    return ok({ thread: await project(db, input, c.id, row.short_id), created: true });
  });
  if (result.ok && result.data.created) chatLive.wake();
  return result;
};
export const threads = { list, create, update, forResource };
