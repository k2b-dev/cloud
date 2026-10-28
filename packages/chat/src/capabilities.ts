import { defineCapabilities } from "@k2b/cloud";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/cloud/server";
import {
  DiscussionListDataSchema,
  DiscussionListInputSchema,
  DiscussionMessageDataSchema,
  DiscussionPostInputSchema,
  MessageDeleteInputSchema,
  MessageEditInputSchema,
  MessageReadInputSchema,
} from "./capability-contracts";
import { discussionReview } from "./capability-reviews";
import { ChatComposeInputSchema } from "./commands";
import { messages as catalog, subjectPrincipal } from "./service/access";
import { withinMessageMutationWindow } from "./service/contracts";
import { authorizeDiscussion } from "./service/discussion-access";
import {
  changeDiscussionMessage,
  listDiscussion,
  postDiscussion,
  readDiscussionMessage,
  resolveDiscussionMessage,
} from "./service/discussions";

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
      access.data.context.authorizedResources[0]!.decision.name,
      operation === "edit" ? input.body! : (message.body ?? ""),
      context.locale,
      input.revision,
    ),
  );
};

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
        "Read newest-first previews for one spaces.item or notebooks.note. Does not create a discussion. Follow page.nextCursor; message.read returns the full message.",
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
  },
  actions: {
    "discussion.post": {
      title: "Post to item discussion",
      description:
        "Post Markdown to one item discussion, creating its thread when necessary. Requires container write and item read. A recurring event has one discussion for the whole series; write an occurrence date in the text.",
      input: DiscussionPostInputSchema,
      data: DiscussionMessageDataSchema,
      openWorld: false,
      destructive: false,
      idempotency: "required",
      policy: { silent: "shared" },
      review: async (input, context) => {
        const access = await authorizeDiscussion(input.item, context, true);
        if (!access.ok) return access;
        return ok({
          ...discussionReview("post", input.item, access.data.context.authorizedResources[0]!.decision.name, input.body, context.locale),
          scope: `${access.data.container.ref.type}:${access.data.container.ref.id}`,
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
        },
        actions: {
          "discussion.post": {
            title: "In Element-Diskussion schreiben",
            description:
              "Eine Nachricht zum Element senden und bei Bedarf dessen Thread erstellen. Braucht Schreiben am Container und Lesen am Element. Eine Terminserie hat eine Diskussion; das konkrete Datum gehört in den Text.",
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
