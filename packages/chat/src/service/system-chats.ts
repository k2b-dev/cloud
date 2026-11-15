import { sql } from "@k2b/cloud";
import { err, fail, ok } from "@k2b/cloud/server";
import { crypto } from "@k2b/stdlib";
import { boundConversation, type ChatContext, type ConversationRow, capPermission, messages, subjectPrincipal } from "./access";
import { type SystemChatPageSchema, SystemChatParamSchema, SystemChatQuerySchema } from "./contracts";
import { conversations } from "./conversations";
import { discussionRead, providerFor } from "./discussion-read";
import { openParticipant } from "./read-state";
import { discussionIncomplete, readContainers, readResource, resourceDeferred } from "./resource-access";
import { SUMMARY_TRAVERSAL_BUDGET } from "./thread-access";
import { threads } from "./threads";

const open = async (input: ChatContext & { resourceType: string; resourceId: string }) => {
  const parsed = SystemChatParamSchema.safeParse(input);
  if (!parsed.success) return fail(err.badInput(messages(input).invalidInput));
  const ref = { type: parsed.data.resourceType, id: parsed.data.resourceId };
  const resource = (await providerFor(input, ref.type, "container")) ? await readResource(input, ref) : null;
  const bound = boundConversation(input.actor, input.locale);
  if (!resource || capPermission(resource.permission, input.actor) === "none" || !bound.ok)
    return fail({ code: "NOT_FOUND", status: 404, message: messages(input).notFound });
  const result = await sql.begin(async (db) => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${`chat.system:${ref.type}:${ref.id}`}, 0))`;
    const [existing] = await db<ConversationRow[]>`SELECT * FROM chat.conversations
      WHERE kind = 'system' AND resource_type = ${ref.type} AND resource_id = ${ref.id}`;
    if (bound.data !== null && existing?.short_id !== bound.data)
      return fail({ code: "NOT_FOUND", status: 404, message: messages(input).notFound });
    if (existing) return ok(existing.short_id);
    const self = subjectPrincipal(input.accessSubject);
    for (let attempt = 0; attempt < 10; attempt++) {
      const [row] = await db<ConversationRow[]>`INSERT INTO chat.conversations
        (short_id, kind, resource_type, resource_id, name, purpose, created_by_type, created_by_id)
        VALUES (${crypto.common.readableId(6)}, 'system', ${ref.type}, ${ref.id}, ${Array.from(resource.title).slice(0, 80).join("")},
          ${resource.context == null ? null : Array.from(resource.context).slice(0, 300).join("")}, ${self.type}, ${self.id}::uuid)
        ON CONFLICT (short_id) DO NOTHING RETURNING *`;
      if (row) return ok(row.short_id);
    }
    throw new Error("Conversation ID could not be allocated");
  });
  if (!result.ok) return result;
  const context = { ...input, conversationId: result.data };
  const opened = await openParticipant(context);
  return opened.ok ? conversations.get(context) : opened;
};
/**
 * Where the discussion about one resource is, as the panel beside it shows it. It creates nothing: someone who only
 * looks leaves no conversation behind; the first message opens it through `openFor`. The ref is a selector only.
 */
const locate = async (input: ChatContext & { ref: { type: string; id: string } }) => {
  const missing = () => fail({ code: "NOT_FOUND", status: 404, message: messages(input).notFound });
  const parsed = SystemChatParamSchema.safeParse({ resourceType: input.ref.type, resourceId: input.ref.id });
  if (!parsed.success) return fail(err.badInput(messages(input).invalidInput));
  const readable = async (ref: { type: string; id: string }) => {
    const resource = await readResource(input, ref);
    return resource && capPermission(resource.permission, input.actor) !== "none" ? resource : null;
  };
  let container: { type: string; id: string } | undefined;
  let title: string;
  let item = false;
  if (await providerFor(input, input.ref.type, "container")) {
    const resource = await readable(input.ref);
    if (!resource) return missing();
    container = input.ref;
    title = resource.title;
  } else if (await providerFor(input, input.ref.type, "item")) {
    const resource = await readable(input.ref);
    container = resource?.container?.ref;
    if (!resource || !container) return missing();
    title = resource.title;
    item = true;
  } else return missing();
  const place = item ? await readable(container) : await readResource(input, container);
  const bound = boundConversation(input.actor, input.locale);
  if (!place || !bound.ok) return missing();
  const permission = capPermission(place.permission, input.actor);
  if (permission === "none") return missing();
  const [conversation] = await sql<{ id: string; short_id: string }[]>`SELECT id, short_id FROM chat.conversations
    WHERE kind = 'system' AND resource_type = ${container.type} AND resource_id = ${container.id}`;
  if (bound.data !== null && conversation?.short_id !== bound.data) return missing();
  const [thread] =
    conversation && item
      ? await sql<{ short_id: string }[]>`SELECT short_id FROM chat.threads
          WHERE conversation_id = ${conversation.id}::uuid AND resource_type = ${input.ref.type} AND resource_id = ${input.ref.id}`
      : [];
  return ok({
    conversation: conversation?.short_id ?? null,
    thread: thread?.short_id ?? null,
    item,
    title,
    canWrite: permission !== "read",
  });
};
/**
 * The discussion about one resource, as the panel beside it opens it: a container's chat, or an item's thread in its
 * container's chat, starting what does not exist yet. The ref is a selector only; the item and container readers
 * decide as this reader, and starting an item's thread needs write access to its container.
 */
const openFor = async (input: ChatContext & { ref: { type: string; id: string } }) => {
  const missing = () => fail({ code: "NOT_FOUND", status: 404, message: messages(input).notFound });
  const parsed = SystemChatParamSchema.safeParse({ resourceType: input.ref.type, resourceId: input.ref.id });
  if (!parsed.success) return fail(err.badInput(messages(input).invalidInput));
  if (await providerFor(input, input.ref.type, "container")) {
    const opened = await open({ ...input, ...parsed.data });
    return opened.ok ? ok({ conversation: opened.data, thread: null, title: opened.data.title }) : opened;
  }
  if (!(await providerFor(input, input.ref.type, "item"))) return missing();
  const item = await readResource(input, input.ref);
  const container = item && capPermission(item.permission, input.actor) !== "none" ? item.container?.ref : undefined;
  if (!item || !container) return missing();
  const opened = await open({ ...input, resourceType: container.type, resourceId: container.id });
  if (!opened.ok) return opened;
  // Starting the item's thread checks write access and the item's current container again; a refusal stays one.
  const thread = await threads.forResource({ ...input, conversationId: opened.data.id, input: { ref: input.ref } });
  return thread.ok ? ok({ conversation: opened.data, thread: thread.data.thread.id, title: item.title }) : thread;
};
const list = async (input: ChatContext & { query?: unknown }) => {
  const parsed = SystemChatQuerySchema.safeParse(input.query ?? {});
  if (!parsed.success) return fail(err.badInput(messages(input).invalidInput));
  const bound = boundConversation(input.actor, input.locale);
  if (!bound.ok || capPermission("read", input.actor) === "none" || !input.caller) return ok({ items: [], cursors: {}, skipped: [] });
  const session = discussionRead(input);
  const providers = await session.catalog().catch(() => null);
  if (!providers) return fail({ code: "PROVIDER_UNAVAILABLE", status: 500, message: messages(input).systemChatsFailed });
  const incoming = parsed.data.cursors ?? {};
  // Object order carries the rotation: unvisited providers lead the next page.
  const types = [...new Set([...Object.keys(incoming), ...providers.map((provider) => provider.containerType)])].filter((type) =>
    providers.some((provider) => provider.containerType === type),
  );
  const cursors: typeof SystemChatPageSchema._output.cursors = {};
  const skipped: string[] = [];
  const entries = [];
  const visited: [string, (typeof cursors)[string]][] = [];
  for (const [index, type] of types.entries()) {
    if (incoming[type] === "") {
      visited.push([type, ""]);
      continue;
    }
    const start = incoming[type] ?? {};
    const { cursor, offset = 0 } = start;
    if (session.remaining < 2) {
      cursors[type] = start;
      if (!skipped.includes(type)) skipped.push(type);
      continue;
    }
    try {
      const active = types.slice(index).filter((candidate) => incoming[candidate] !== "").length;
      // Split the available work fairly; reserve list + reader calls and room for summaries.
      const limit = Math.max(1, Math.min(100, Math.floor((session.remaining / active - 1) / 2)));
      const page = await readContainers(input, type, cursor, undefined, undefined, Math.max(limit, offset + 1));
      let stopped = false;
      for (const [entryIndex, entry] of page.items.entries()) {
        if (entryIndex < offset) continue;
        let unavailable = false;
        const resource = await readResource(input, entry.ref, undefined, () => {
          unavailable = true;
        });
        if (resourceDeferred(input, entry.ref)) {
          cursors[type] = { ...(cursor ? { cursor } : {}), offset: entryIndex };
          if (!skipped.includes(type)) skipped.push(type);
          stopped = true;
          break;
        }
        // A broken individual reader must not pin the provider to this page forever.
        // Budget/deadline stops keep an offset before the first uninspected entry.
        if (unavailable && !skipped.includes(type)) skipped.push(type);
        if (resource && capPermission(resource.permission, input.actor) !== "none") entries.push({ entry, resource });
      }
      if (!stopped) visited.push([type, page.nextCursor === null ? "" : { cursor: page.nextCursor }]);
    } catch {
      input.caller.signal?.throwIfAborted();
      cursors[type] = start;
      if (!skipped.includes(type)) skipped.push(type);
    }
  }
  for (const [type, cursor] of visited) cursors[type] = cursor;
  const visible = [];
  for (const { entry, resource } of entries) {
    input.caller.signal?.throwIfAborted();
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM chat.conversations
      WHERE kind = 'system' AND resource_type = ${entry.ref.type} AND resource_id = ${entry.ref.id}`;
    if (bound.data !== null && row?.short_id !== bound.data) continue;
    const threadBudget = { remaining: Math.floor(SUMMARY_TRAVERSAL_BUDGET / entries.length) };
    try {
      const conversation = row ? await conversations.get({ ...input, conversationId: row.short_id, threadBudget }) : null;
      if (conversation && !conversation.ok) continue;
      visible.push({ ...entry, name: resource.title, conversation: conversation?.data ?? null });
      if (discussionIncomplete(input) && !skipped.includes(entry.ref.type)) skipped.push(entry.ref.type);
    } catch {
      input.caller.signal?.throwIfAborted();
      if (!skipped.includes(entry.ref.type)) skipped.push(entry.ref.type);
    }
  }
  return ok({ items: visible, cursors, skipped });
};
export const systemChats = { open, openFor, locate, list };
