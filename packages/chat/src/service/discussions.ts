import type { CapabilityError, CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { fail, ok, type Result } from "@k2b/cloud/server";
import { sql } from "bun";
import type { z } from "zod";
import { DISCUSSION_PREVIEW_LENGTH, type DiscussionItemSchema } from "../capability-contracts";
import { threadHref } from "../frontend/threads";
import { actingPrincipal, type ChatContext, messages as catalog, requireConversation } from "./access";
import type { MessageViewSchema } from "./contracts";
import { authorizeDiscussion, checkDiscussionCredentialScope } from "./discussion-access";
import { type MessageRow, messageViews } from "./message-store";
import { messages } from "./messages";
import { systemChats } from "./system-chats";
import { threads } from "./threads";
import type { RateLimited } from "./write-rate";

type Item = z.infer<typeof DiscussionItemSchema>;
type Message = z.infer<typeof MessageViewSchema>;
const notFound = (context: Pick<ChatContext, "locale">) =>
  fail({ code: "NOT_FOUND", status: 404, message: catalog(context).messageNotFound });
export const discussionMessage = (item: Item, message: Message) => ({
  ref: { type: "chat.message" as const, id: message.id },
  item,
  author: message.author,
  createdAt: message.createdAt,
  editedAt: message.editedAt ?? null,
  deletedAt: message.deletedAt ?? null,
  revision: message.contentRevision ?? 0,
  via: message.via ?? null,
  replyTo: message.replyTo && "id" in message.replyTo ? message.replyTo.id : null,
});
export const discussionPreview = (body: string | null) => {
  const points = Array.from(body ?? "");
  return { preview: points.slice(0, DISCUSSION_PREVIEW_LENGTH).join(""), previewTruncated: points.length > DISCUSSION_PREVIEW_LENGTH };
};
const envelope = (item: Item, message: Message) => ({
  data: { ...discussionMessage(item, message), body: message.body, refs: message.refs, attachments: message.attachments },
  links: [{ rel: "open" as const, href: threadHref(message.conversationId, message.thread ?? "general", message.id) }],
});

export const findDiscussion = async (item: Item, container: { type: string; id: string }) => {
  const [row] = await sql<
    { conversation: string; thread: string; thread_id: string }[]
  >`SELECT c.short_id AS conversation, t.short_id AS thread, t.id AS thread_id
    FROM chat.conversations c JOIN chat.threads t ON t.conversation_id = c.id
    WHERE c.kind = 'system' AND c.resource_type = ${container.type} AND c.resource_id = ${container.id}
      AND t.resource_type = ${item.type} AND t.resource_id = ${item.id}`;
  return row;
};

export const listDiscussion = async (input: { item: Item; limit: number; cursor?: string }, context: CapabilityExecutionContext) => {
  const access = await authorizeDiscussion(input.item, context);
  if (!access.ok) return access;
  const location = await findDiscussion(input.item, access.data.container.ref);
  if (!location) return ok({ data: [], page: { hasMore: false as const } });
  const allowed = await requireConversation({ ...access.data.context, conversationId: location.conversation, required: "read" });
  if (!allowed.ok) return allowed;
  const rows = await sql<MessageRow[]>`SELECT * FROM chat.messages WHERE conversation_id = ${allowed.data.id}::uuid
    AND thread_id = ${location.thread_id}::uuid AND kind = 'text'
    AND ${input.cursor ? sql`seq < ${input.cursor}::bigint` : sql`true`} ORDER BY seq DESC LIMIT ${input.limit + 1}`;
  const visible = rows.slice(0, input.limit);
  const views = await messageViews(sql, visible, location.conversation, context.accessSubject, context.locale);
  return ok({
    data: views.map((message) => ({ ...discussionMessage(input.item, message), ...discussionPreview(message.body) })),
    page: rows.length > input.limit ? { hasMore: true as const, nextCursor: String(visible.at(-1)!.seq) } : { hasMore: false as const },
    links: [{ rel: "open" as const, href: threadHref(location.conversation, location.thread) }],
  });
};

/** Resolve only item discussions; general and manually created chat threads never enter this surface. */
export const resolveDiscussionMessage = async (id: string, context: CapabilityExecutionContext, write = false) => {
  const scope = checkDiscussionCredentialScope(context, write);
  if (!scope.ok) return scope;
  const [row] = await sql<
    { conversation: string; item_type: "spaces.item" | "notebooks.note"; item_id: string; container_type: string; container_id: string }[]
  >`
    SELECT c.short_id AS conversation, t.resource_type AS item_type, t.resource_id AS item_id,
      c.resource_type AS container_type, c.resource_id AS container_id
    FROM chat.messages m JOIN chat.threads t ON t.id = m.thread_id JOIN chat.conversations c ON c.id = m.conversation_id
    WHERE m.short_id = ${id} AND m.kind = 'text' AND c.kind = 'system'
      AND t.resource_type IN ('spaces.item', 'notebooks.note')`;
  if (!row) return notFound(context);
  const item: Item = { type: row.item_type, id: row.item_id };
  const access = await authorizeDiscussion(item, context, write);
  if (!access.ok) return access.error.status === 404 ? notFound(context) : access;
  if (access.data.container.ref.type !== row.container_type || access.data.container.ref.id !== row.container_id) return notFound(context);
  const loaded = await messages.get({ ...access.data.context, conversationId: row.conversation, messageId: id });
  if (!loaded.ok) return loaded.error.status === 404 ? notFound(context) : loaded;
  return ok({ ...access.data, message: loaded.data });
};
export const readDiscussionMessage = async (input: { id: string }, context: CapabilityExecutionContext) => {
  const resolved = await resolveDiscussionMessage(input.id, context);
  return resolved.ok ? ok(envelope(resolved.data.item, resolved.data.message)) : resolved;
};

const clientId = (context: CapabilityExecutionContext, operation: string) =>
  context.idempotencyKey
    ? new Bun.CryptoHasher("sha256")
        .update(JSON.stringify([actingPrincipal(context.actor), operation, context.idempotencyKey]))
        .digest("hex")
    : null;
const normalize = <T>(result: Result<T> | RateLimited): { ok: true; data: T } | { ok: false; error: CapabilityError } => {
  if (result.ok) return result;
  if ("retryAfter" in result)
    return { ok: false, error: { code: result.code, message: result.error, status: 429, details: { retryAfter: result.retryAfter } } };
  return result;
};
export const postDiscussion = async (input: { item: Item; body: string; replyTo?: string }, context: CapabilityExecutionContext) => {
  const key = clientId(context, "discussion.post");
  if (!key) return fail({ code: "IDEMPOTENCY_KEY_REQUIRED", status: 400, message: catalog(context).invalidInput });
  const access = await authorizeDiscussion(input.item, context, true);
  if (!access.ok) return access;
  const opened = await systemChats.open({
    ...access.data.context,
    resourceType: access.data.container.ref.type,
    resourceId: access.data.container.ref.id,
  });
  if (!opened.ok) return opened;
  const bound = { ...access.data.context, conversationId: opened.data.id };
  const thread = await threads.forResource({ ...bound, input: { ref: input.item } });
  if (!thread.ok) return thread;
  const sent = normalize(
    await messages.send({ ...bound, input: { body: input.body, clientId: key, thread: thread.data.thread.id, replyTo: input.replyTo } }),
  );
  if (!sent.ok) return sent;
  if (sent.data.message.thread !== thread.data.thread.id)
    return fail({ code: "IDEMPOTENCY_CONFLICT", status: 409, message: catalog(context).invalidInput });
  return ok(envelope(input.item, sent.data.message));
};
export const changeDiscussionMessage = async (
  operation: "edit" | "delete",
  input: { id: string; revision: number; body?: string },
  context: CapabilityExecutionContext,
) => {
  const key = clientId(context, `message.${operation}`);
  if (!key) return fail({ code: "IDEMPOTENCY_KEY_REQUIRED", status: 400, message: catalog(context).invalidInput });
  const access = await resolveDiscussionMessage(input.id, context, true);
  if (!access.ok) return access;
  const changed = normalize(
    await messages[operation]({
      ...access.data.context,
      conversationId: access.data.message.conversationId,
      messageId: input.id,
      input: { clientId: key, revision: input.revision, ...(operation === "edit" ? { body: input.body } : {}) },
    }),
  );
  return changed.ok ? ok(envelope(access.data.item, changed.data)) : changed;
};
