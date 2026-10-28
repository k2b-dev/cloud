import { defineCapabilities } from "@k2b/cloud";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { ok, type Result } from "@k2b/cloud/server";
import { z } from "zod";
import { ChatComposeInputSchema } from "./commands";
import type { ChatContext } from "./service/access";
import { ConversationParamSchema, FollowingSchema, NotificationsSchema, NotificationUpdateSchema } from "./service/contracts";
import { notificationPreferences } from "./service/notification-preferences";
import { threadFollows } from "./service/thread-follows";

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
  queries: {
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
        queries: {
          "notifications.read": {
            title: "Chat-Benachrichtigungen lesen",
            description:
              "Wirksame Stufe, Wahl, Ablauf, Standard und gefolgte Diskussionen für eine bekannte Chat-ID lesen. Erfordert Leserecht und Teilnahme.",
          },
        },
        actions: {
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
