import { sql } from "@k2b/cloud";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { fail, ok } from "@k2b/cloud/server";
import { threadHref } from "../frontend/threads";
import { type ChatContext, messages as catalog, requireConversation } from "./access";
import { titles } from "./conversation-titles";
import { checkDiscussionCredentialScope } from "./discussion-access";
import { readDiscussionMessage } from "./discussions";
import { messages } from "./messages";

const contextFor = (context: CapabilityExecutionContext): ChatContext => ({
  actor: context.actor,
  accessSubject: context.accessSubject,
  locale: context.locale,
  requestId: context.requestId,
  capabilityQuery: context.query,
  credentialScopes: context.authority?.credentialKind === "session" ? undefined : context.authority?.scopes,
  caller: { authority: context.authority, signal: context.signal, locale: context.locale, requestId: context.requestId },
});

export const readConversation = async ({ id }: { id: string }, context: CapabilityExecutionContext) => {
  const scope = checkDiscussionCredentialScope(context, false);
  if (!scope.ok) return scope;
  const allowed = await requireConversation({ ...contextFor(context), conversationId: id, required: "read" });
  if (!allowed.ok) return allowed;
  // A container read alone cannot authorize its individual item discussions.
  if (allowed.data.kind !== "chat") return fail({ code: "NOT_FOUND", status: 404, message: catalog(context).notFound });
  return ok({
    data: {
      view: { title: (await titles([allowed.data], contextFor(context), sql)).get(allowed.data.id)!, permission: allowed.data.permission },
    },
    links: [{ rel: "open" as const, href: threadHref(id, "general") }],
  });
};

export const readMessage = async (input: { id: string }, context: CapabilityExecutionContext) => {
  const scope = checkDiscussionCredentialScope(context, false);
  if (!scope.ok) return scope;
  const [location] = await sql<{ conversation: string; kind: "chat" | "system" }[]>`
    SELECT c.short_id AS conversation, c.kind FROM chat.messages m
    JOIN chat.conversations c ON c.id = m.conversation_id WHERE m.short_id = ${input.id} AND m.kind = 'text'`;
  if (!location || location.kind === "system") return readDiscussionMessage(input, context);
  const loaded = await messages.get({ ...contextFor(context), conversationId: location.conversation, messageId: input.id });
  if (!loaded.ok) return loaded;
  const message = loaded.data;
  return ok({
    data: {
      ref: { type: "chat.message" as const, id: message.id },
      conversation: { type: "chat.conversation" as const, id: location.conversation },
      thread: message.thread,
      author: message.author,
      createdAt: message.createdAt,
      editedAt: message.editedAt ?? null,
      deletedAt: message.deletedAt ?? null,
      revision: message.contentRevision ?? 0,
      via: message.via ?? null,
      replyTo: message.replyTo && "id" in message.replyTo ? message.replyTo.id : null,
      body: message.body,
      refs: message.refs,
      attachments: message.attachments,
    },
    links: [{ rel: "open" as const, href: threadHref(location.conversation, message.thread ?? "general", message.id) }],
  });
};
