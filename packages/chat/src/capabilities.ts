import { defineCapabilities } from "@k2b/cloud";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { z } from "zod";
import {
  DiscussionListDataSchema,
  DiscussionListInputSchema,
  DiscussionMessageDataSchema,
  DiscussionPostInputSchema,
  MessageDeleteInputSchema,
  MessageEditInputSchema,
  MessageReadInputSchema,
} from "./capability-contracts";
import { discussionApprovalScope, discussionReview } from "./capability-reviews";
import { ChatComposeInputSchema } from "./commands";
import { threadHref } from "./frontend/threads";
import { type ChatContext, messages as catalog, requireConversation, subjectPrincipal } from "./service/access";
import {
  ConversationParamSchema,
  FollowingSchema,
  MessageBodySchema,
  MessageIdSchema,
  NotificationsSchema,
  NotificationUpdateSchema,
  withinMessageMutationWindow,
} from "./service/contracts";
import { authorizeDiscussion, checkDiscussionCredentialScope } from "./service/discussion-access";
import {
  changeDiscussionMessage,
  listDiscussion,
  postDiscussion,
  readDiscussionMessage,
  resolveDiscussionMessage,
} from "./service/discussions";
import { messages } from "./service/messages";
import { notificationPreferences } from "./service/notification-preferences";
import { threadFollows } from "./service/thread-follows";

const messageTargetId = (context: CapabilityExecutionContext) => (context.target?.type === "chat.message" ? context.target.id : "");

const reviewChange = async (
  operation: "edit" | "delete",
  input: { id: string; revision: number; body?: string },
  context: CapabilityExecutionContext,
) => {
  const access = await resolveDiscussionMessage(input.id, context, true);
  if (!access.ok) return access;
  const message = access.data.message;
  const self = subjectPrincipal(context.accessSubject);
  const t = catalog(context);
  if (message.author.type !== self.type || message.author.id !== self.id) return fail(err.forbidden(t.forbidden));
  if (message.deletedAt || !withinMessageMutationWindow(message.createdAt, Date.now()))
    return fail({ code: "MESSAGE_MUTATION_EXPIRED", status: 409, message: t.messageMutationExpired });
  if ((message.contentRevision ?? 0) !== input.revision) return fail({ code: "MESSAGE_CHANGED", status: 409, message: t.messageChanged });
  return ok(
    discussionReview(
      operation,
      access.data.item,
      access.data.decision.title,
      operation === "edit" ? input.body! : (message.body ?? ""),
      context.locale,
      input.revision,
    ),
  );
};

const contextFor = (context: CapabilityExecutionContext): ChatContext => ({
  actor: context.actor,
  accessSubject: context.accessSubject,
  locale: context.locale,
  requestId: context.requestId,
  via: context.via ?? null,
  credentialScopes: context.authority?.credentialKind === "session" ? undefined : context.authority?.scopes,
  capabilityQuery: context.query,
  caller: { authority: context.authority, signal: context.signal, locale: context.locale, requestId: context.requestId },
});
const envelope = <T>(result: Result<T>) => (result.ok ? ok({ data: result.data }) : result);
const NotificationReadInput = z.strictObject({
  conversation: ConversationParamSchema.shape.conversation.describe(
    "Six-character Chat conversation ID from a Chat link or conversation response.",
  ),
});
const NotificationSetInput = z.strictObject({
  notifications: NotificationUpdateSchema.describe("The new explicit level or reset to default, including duration only for none."),
});
const FollowInput = z.strictObject({
  thread: ConversationParamSchema.shape.conversation.describe("Six-character item-thread ID from the conversation's thread list."),
  following: z.boolean().describe("True to follow the item discussion; false to stop following it."),
});

const MessagePostInput = NotificationReadInput.extend({
  body: MessageBodySchema.describe("Markdown message; at most 20,000 Unicode characters with non-whitespace content."),
});
const MessagePostData = z.strictObject({
  id: MessageIdSchema,
  conversation: ConversationParamSchema.shape.conversation,
  createdAt: z.iso.datetime(),
});

export const chatCapabilities = defineCapabilities({
  protocolVersion: 2,
  types: {
    conversation: {
      title: "Chat conversation",
      description: "A Chat conversation with current read access and participation.",
      icon: "ti ti-messages",
    },
    message: {
      title: "Discussion message",
      description: "A message in one accessible item discussion.",
      icon: "ti ti-message",
      reader: "message.read",
    },
  },
  queries: {
    "discussion.list": {
      title: "List item discussion",
      description:
        "Read newest-first previews for one discussable item ref. Does not create a discussion. Follow page.nextCursor; message.read returns the full message.",
      input: DiscussionListInputSchema,
      data: DiscussionListDataSchema,
      openWorld: false,
      run: listDiscussion,
    },
    "message.read": {
      title: "Read discussion message",
      description:
        "Read one complete chat.message from an item discussion, with a link to open it. General chats are outside this capability.",
      input: MessageReadInputSchema,
      data: DiscussionMessageDataSchema,
      openWorld: false,
      run: readDiscussionMessage,
    },

    "notifications.read": {
      title: "Read chat notifications",
      description:
        "Read your effective level, explicit choice, mute expiry, default and followed-discussion summary for a known Chat conversation ID. Requires current read access and participation.",
      input: NotificationReadInput,
      data: NotificationsSchema,
      openWorld: false,
      run: async ({ conversation }, context) =>
        envelope(await notificationPreferences.get({ ...contextFor(context), conversationId: conversation })),
    },
  },
  actions: {
    "message.post": {
      title: "Post a chat message",
      description:
        "Post Markdown to the general thread of a Chat conversation or channel the caller may write to. Does not start an AI turn. Reuse the same idempotency key and body when retrying.",
      input: MessagePostInput,
      data: MessagePostData,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      policy: { silent: "shared" },
      review: async (input, context) => {
        const scope = checkDiscussionCredentialScope(context, true);
        if (!scope.ok) return scope;
        const allowed = await requireConversation({ ...contextFor(context), conversationId: input.conversation, required: "write" });
        if (!allowed.ok) return allowed;
        // Item discussions retain their provider-owned authorization and exact-ref Action.
        if (allowed.data.kind !== "chat") return fail(err.forbidden(catalog(context).forbidden));
        const review = discussionReview("post", undefined, allowed.data.name || input.conversation, input.body, context.locale);
        return ok({
          ...review,
          sentence: context.locale?.startsWith("de")
            ? {
                action: "Nachricht in {item} schreiben",
                running: "Nachricht wird in {item} geschrieben",
                done: "Nachricht in {item} geschrieben",
                confirm: "Schreiben",
                decline: "Abbrechen",
              }
            : {
                action: "Post a message in {item}",
                running: "Posting a message in {item}",
                done: "Posted a message in {item}",
                confirm: "Post",
                decline: "Cancel",
              },
          scope: `conversation:${input.conversation}`,
        });
      },
      run: async (input, context) => {
        if (!context.idempotencyKey) return fail({ code: "IDEMPOTENCY_KEY_REQUIRED", status: 400, message: catalog(context).invalidInput });
        const scope = checkDiscussionCredentialScope(context, true);
        if (!scope.ok) return scope;
        const bound = { ...contextFor(context), conversationId: input.conversation };
        const allowed = await requireConversation({ ...bound, required: "write" });
        if (!allowed.ok) return allowed;
        if (allowed.data.kind !== "chat") return fail(err.forbidden(catalog(context).forbidden));
        const result = await messages.send({
          ...bound,
          replayHash: new Bun.CryptoHasher("sha256").update(input.body).digest("hex"),
          input: {
            body: input.body,
            clientId: new Bun.CryptoHasher("sha256")
              .update(
                JSON.stringify([
                  context.actor.kind === "user" ? context.actor.user.id : context.actor.serviceAccount.id,
                  "message.post",
                  context.idempotencyKey,
                ]),
              )
              .digest("hex"),
          },
        });
        if (!result.ok) {
          if ("retryAfter" in result)
            return {
              ok: false as const,
              error: { code: result.code, status: result.status, message: result.error, details: { retryAfter: result.retryAfter } },
            };
          return result;
        }
        return ok({
          data: { id: result.data.message.id, conversation: input.conversation, createdAt: result.data.message.createdAt },
          links: [{ rel: "open" as const, href: threadHref(input.conversation, "general", result.data.message.id) }],
        });
      },
    },
    "discussion.post": {
      code: false,
      title: "Post to item discussion",
      description:
        "Post Markdown to one item discussion, creating its thread when necessary. Requires container write and item read. The provider defines item identity; the same ref always addresses the same discussion.",
      input: DiscussionPostInputSchema,
      data: DiscussionMessageDataSchema,
      openWorld: false,
      destructive: false,
      idempotency: "required",
      policy: { silent: "shared" },
      review: async (input, context) => {
        const access = await authorizeDiscussion(input.ref, context, true);
        if (!access.ok) return access;
        return ok({
          ...discussionReview("post", input.ref, access.data.decision.title, input.body, context.locale),
          scope: discussionApprovalScope(access.data.container.ref),
        });
      },
      run: postDiscussion,
    },
    "message.edit": {
      target: "message",
      code: false,
      title: "Edit discussion message",
      description: "Edit your own message within ten minutes. Use the content revision from message.read. Reactions do not change it.",
      input: MessageEditInputSchema.omit({ id: true }),
      data: DiscussionMessageDataSchema,
      openWorld: false,
      destructive: false,
      idempotency: "required",
      policy: { ask: "cannot_undo" },
      review: (input, context) => reviewChange("edit", { ...input, id: messageTargetId(context) }, context),
      run: (input, context) => changeDiscussionMessage("edit", { ...input, id: messageTargetId(context) }, context),
    },
    "message.delete": {
      target: "message",
      code: false,
      title: "Delete discussion message",
      description:
        "Permanently erase your own message and attachments within ten minutes. A placeholder retains replies. Use the content revision from message.read.",
      input: MessageDeleteInputSchema.omit({ id: true }),
      data: DiscussionMessageDataSchema,
      openWorld: false,
      destructive: true,
      idempotency: "required",
      policy: { ask: "deletes" },
      review: (input, context) => reviewChange("delete", { ...input, id: messageTargetId(context) }, context),
      run: (input, context) => changeDiscussionMessage("delete", { ...input, id: messageTargetId(context) }, context),
    },

    "notifications.set": {
      target: "conversation",
      code: false,
      title: "Set chat notifications",
      description:
        "Set your notification level in a known Chat conversation. Use default to reset, all or mentions for an explicit choice, or none with for=1h|8h|1w|forever. Requires participation; no notifications are sent by this operation.",
      input: NotificationSetInput,
      data: NotificationsSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      approval: "none",
      run: async ({ notifications }, context) =>
        envelope(
          await notificationPreferences.set({
            ...contextFor(context),
            conversationId: context.target?.type === "chat.conversation" ? context.target.id : "",
            input: notifications,
          }),
        ),
    },
    "thread.follow": {
      target: "conversation",
      code: false,
      title: "Follow or unfollow a discussion",
      description:
        "Set whether you follow an item thread in a system conversation. Requires participation and current container and item read access. Ordinary chat threads are unsupported.",
      input: FollowInput,
      data: FollowingSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      approval: "none",
      run: async ({ thread, following }, context) =>
        envelope(
          await threadFollows.set({
            ...contextFor(context),
            conversationId: context.target?.type === "chat.conversation" ? context.target.id : "",
            threadId: thread,
            following,
          }),
        ),
    },
  },
  commands: {
    "conversation.compose": {
      title: "Message a person",
      description: "Select a person in New chat. Choose an existing chat or start another; opening this form creates and sends nothing.",
      icon: "ti ti-message-plus",
      input: ChatComposeInputSchema,
      path: "/app/chat",
    },
  },
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        types: {
          conversation: { title: "Chat-Unterhaltung", description: "Eine Chat-Unterhaltung mit aktuellem Leserecht und Teilnahme." },
          message: { title: "Diskussionsnachricht", description: "Eine Nachricht in einer zugänglichen Element-Diskussion." },
        },
        queries: {
          "discussion.list": {
            title: "Element-Diskussion lesen",
            description:
              "Neueste Nachrichtenvorschauen eines Elements lesen. Erstellt keinen Thread; message.read liefert die vollständige Nachricht.",
          },
          "message.read": {
            title: "Diskussionsnachricht lesen",
            description: "Eine vollständige chat.message einer Element-Diskussion mit Link öffnen. Allgemeine Chats sind ausgeschlossen.",
          },

          "notifications.read": {
            title: "Chat-Benachrichtigungen lesen",
            description:
              "Wirksame Stufe, Wahl, Ablauf, Standard und gefolgte Diskussionen für eine bekannte Chat-ID lesen. Erfordert Leserecht und Teilnahme.",
          },
        },
        actions: {
          "message.post": {
            title: "Chatnachricht schreiben",
            description:
              "Markdown in den allgemeinen Thread eines beschreibbaren Chats oder Kanals schreiben. Startet keinen KI-Lauf. Bei Wiederholung denselben Idempotenzschlüssel und Text verwenden.",
            input: {
              conversation: "Sechsstellige Chat-ID aus dem Chat-Link.",
              body: "Markdown-Nachricht mit höchstens 20.000 Unicode-Zeichen und nicht nur Leerraum.",
            },
          },
          "discussion.post": {
            title: "In Element-Diskussion schreiben",
            description:
              "Eine Nachricht zum Element senden und bei Bedarf dessen Thread erstellen. Braucht Schreiben am Container und Lesen am Element. Die Ref des Anbieters bestimmt die Diskussionsidentität.",
          },
          "message.edit": {
            title: "Diskussionsnachricht ändern",
            description:
              "Eigene Nachricht in den ersten zehn Minuten ändern. Die Inhaltsrevision aus message.read bleibt durch Reaktionen unverändert.",
          },
          "message.delete": {
            title: "Diskussionsnachricht löschen",
            description:
              "Eigene Nachricht und Anhänge in den ersten zehn Minuten endgültig löschen. Antworten bleiben über einen Platzhalter erhalten. Inhaltsrevision aus message.read verwenden.",
          },

          "notifications.set": {
            title: "Chat-Benachrichtigungen ändern",
            description:
              "Deine Stufe für einen bekannten Chat ändern: default, all, mentions oder none mit for=1h|8h|1w|forever. Erfordert Teilnahme.",
          },
          "thread.follow": {
            title: "Einer Diskussion folgen oder nicht mehr folgen",
            description:
              "Für eine Item-Diskussion in einem System-Chat festlegen, ob du ihr folgst. Erfordert Teilnahme sowie Leserecht für Container und Item.",
          },
        },
        commands: {
          "conversation.compose": {
            title: "Nachricht an eine Person",
            description:
              "Wählt eine Person in Neuer Chat aus. Wähle einen vorhandenen Chat oder starte einen weiteren; das Öffnen erstellt und sendet nichts.",
            input: { userId: "Benutzer-UUID der auszuwählenden Person; Chat prüft aktuelle Verfügbarkeit und Gastbeschränkungen." },
          },
        },
      },
    },
  },
});
