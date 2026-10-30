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
import { type ChatContext, messages as catalog, subjectPrincipal } from "./service/access";
import {
  ConversationParamSchema,
  FollowingSchema,
  NotificationsSchema,
  NotificationUpdateSchema,
  withinMessageMutationWindow,
} from "./service/contracts";
import { authorizeDiscussion } from "./service/discussion-access";
import {
  changeDiscussionMessage,
  listDiscussion,
  postDiscussion,
  readDiscussionMessage,
  resolveDiscussionMessage,
} from "./service/discussions";
import { notificationPreferences } from "./service/notification-preferences";
import { threadFollows } from "./service/thread-follows";

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
const NotificationSetInput = NotificationReadInput.extend({
  notifications: NotificationUpdateSchema.describe("The new explicit level or reset to default, including duration only for none."),
});
const FollowInput = NotificationReadInput.extend({
  thread: ConversationParamSchema.shape.conversation.describe("Six-character item-thread ID from the conversation's thread list."),
  following: z.boolean().describe("True to follow the item discussion; false to stop following it."),
});

export const chatCapabilities = defineCapabilities({
  protocolVersion: 2,
  types: {
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
    "discussion.post": {
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
      title: "Edit discussion message",
      description: "Edit your own message within ten minutes. Use the content revision from message.read. Reactions do not change it.",
      input: MessageEditInputSchema,
      data: DiscussionMessageDataSchema,
      openWorld: false,
      destructive: false,
      idempotency: "required",
      policy: { ask: "cannot_undo" },
      review: (input, context) => reviewChange("edit", input, context),
      run: (input, context) => changeDiscussionMessage("edit", input, context),
    },
    "message.delete": {
      title: "Delete discussion message",
      description:
        "Permanently erase your own message and attachments within ten minutes. A placeholder retains replies. Use the content revision from message.read.",
      input: MessageDeleteInputSchema,
      data: DiscussionMessageDataSchema,
      openWorld: false,
      destructive: true,
      idempotency: "required",
      policy: { ask: "deletes" },
      review: (input, context) => reviewChange("delete", input, context),
      run: (input, context) => changeDiscussionMessage("delete", input, context),
    },

    "notifications.set": {
      title: "Set chat notifications",
      description:
        "Set your notification level in a known Chat conversation. Use default to reset, all or mentions for an explicit choice, or none with for=1h|8h|1w|forever. Requires participation; no notifications are sent by this operation.",
      input: NotificationSetInput,
      data: NotificationsSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      approval: "none",
      run: async ({ conversation, notifications }, context) =>
        envelope(await notificationPreferences.set({ ...contextFor(context), conversationId: conversation, input: notifications })),
    },
    "thread.follow": {
      title: "Follow or unfollow a discussion",
      description:
        "Set whether you follow an item thread in a system conversation. Requires participation and current container and item read access. Ordinary chat threads are unsupported.",
      input: FollowInput,
      data: FollowingSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      approval: "none",
      run: async ({ conversation, thread, following }, context) =>
        envelope(await threadFollows.set({ ...contextFor(context), conversationId: conversation, threadId: thread, following })),
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
        types: { message: { title: "Diskussionsnachricht", description: "Eine Nachricht in einer zugänglichen Element-Diskussion." } },
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
