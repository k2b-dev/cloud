import type { Message } from "@k2b/nessi";
import { getApp } from "../_internal/registry";
import type { AppRegistryEntry } from "../contracts/registry";
import { resolveAppIdentityPresentation } from "../shared/app-presentation";
import { projectAiChoices } from "./choices";
import { type AiOriginViewer, loadAiMessageOrigins } from "./message-origin";
import { projectAiNextMessages } from "./next-message-store";
import type { AiTurnBlock, AiWireEvent } from "./protocol";
import { publicAiToolInput, publicAiToolResult } from "./public-tool-input";
import type { AiStoredMessageOrigin } from "./queue-contracts";
import { capabilityResultView } from "./result-view";
import { splitAiSourceContext } from "./source-context";
import { aiConversations } from "./store";
import type { AiConversation, AiStoredMessage } from "./types";

/** Provider thinking remains in canonical history, never in public step details. */
export const publicAiMessageContent = (message: Message): Message =>
  message.role === "assistant"
    ? { ...message, content: message.content.map((block) => (block.type === "thinking" ? { type: "thinking", thinking: "" } : block)) }
    : message;

/** Keep the step's identity, but no text or provider-specific thinking metadata. */
export const publicAiTurnBlock = (block: AiTurnBlock): AiTurnBlock =>
  block.kind === "thinking" ? { id: block.id, kind: "thinking", text: "" } : block;

/** Applies to new events and retained events from an earlier executor version. */
export const publicAiWireEvent = (event: AiWireEvent): AiWireEvent => {
  switch (event.type) {
    case "turn_started":
      return event.blocks ? { ...event, blocks: event.blocks.map(publicAiTurnBlock) } : event;
    case "block_set":
      return { ...event, block: publicAiTurnBlock(event.block) };
    case "block_delta":
      return event.blockKind === "thinking" ? { ...event, delta: "" } : event;
    case "message_saved":
      return { ...event, message: { ...event.message, message: publicAiMessageContent(event.message.message) } };
    case "turn_finished":
      return event.messages
        ? { ...event, messages: event.messages.map((message) => ({ ...message, message: publicAiMessageContent(message.message) })) }
        : event;
    default:
      return event;
  }
};

const blockHasChoice = (block: unknown): boolean =>
  block !== null &&
  typeof block === "object" &&
  (Reflect.get(block, "kind") === "Choice" ||
    (Reflect.get(block, "kind") === "Section" && (Reflect.get(block, "children") as unknown[] | undefined)?.some(blockHasChoice) === true));

/** Whether a view holds a choice, the only part of a result that needs the conversation's choice history. */
export const viewHasChoice = (view: unknown): boolean => {
  const blocks = view !== null && typeof view === "object" ? Reflect.get(view, "blocks") : undefined;
  return Array.isArray(blocks) && blocks.some(blockHasChoice);
};

/**
 * Only messages with a choice, or a person's answer to one, need the choice history. Every other message, such as a
 * live delta or a page without choices, reads no SQL for it (DATA-13).
 */
export const messagesNeedChoiceContext = (messages: readonly AiStoredMessage[], liveBlocks: readonly AiTurnBlock[] = []): boolean =>
  messages.some((message) =>
    message.message.role === "user"
      ? Boolean(message.meta?.choice)
      : message.message.role === "tool_result" && viewHasChoice(Reflect.get(Object(message.message.result), "view")),
  ) ||
  liveBlocks.some(
    (block) => block.kind === "tool" && (viewHasChoice(block.view) || viewHasChoice(Reflect.get(Object(block.result), "view"))),
  );

/** The user message without the source data Send appended to its text, and that data; without data it stays unchanged. */
const withoutSourceContext = (message: Extract<Message, { role: "user" }>): { message: Message; context: string | null } => {
  const textOf = (part: (typeof message.content)[number]) => (typeof part === "string" ? part : part.type === "text" ? part.text : null);
  const index = message.content.findIndex((part) => textOf(part) !== null);
  const text = index < 0 ? null : textOf(message.content[index]!);
  if (text === null) return { message, context: null };
  const split = splitAiSourceContext(text);
  if (split.context === null) return { message, context: null };
  const content = message.content.map((part, at) => (at === index ? { type: "text" as const, text: split.text } : part));
  return { message: { ...message, content }, context: split.context };
};

export const projectPublicAiStoredMessages = (
  messages: readonly AiStoredMessage[],
  conversationId: string,
  turnShortIds: ReadonlyMap<string, string>,
  choiceContext: readonly AiStoredMessage[] = messages,
): AiStoredMessage[] =>
  projectAiChoices(messages, choiceContext).map((message) => {
    const toolNames = new Map(
      message.message.role === "assistant"
        ? message.message.content.flatMap((block) => (block.type === "tool_call" ? [[block.id, block.name] as const] : []))
        : [],
    );
    const view = message.message.role === "tool_result" && !message.message.isError ? capabilityResultView(message.message.result) : null;
    const { writerOrigin, ...meta } = message.meta ?? {};
    // A message the person did not type shows its instruction; the data it brought stands apart (Send, `context`).
    const sourced =
      message.message.role === "user" && writerOrigin && writerOrigin.kind !== "person" ? withoutSourceContext(message.message) : null;
    return {
      ...message,
      message: sourced
        ? sourced.message
        : message.message.role === "assistant"
          ? publicAiMessageContent({
              ...message.message,
              content: message.message.content.map((block) =>
                block.type === "tool_call" ? { ...block, args: publicAiToolInput(block.name, block.args) } : block,
              ),
            })
          : message.message.role === "tool_result"
            ? { ...message.message, result: publicAiToolResult(message.message.name, message.message.result) }
            : message.message,
      meta:
        message.meta || view
          ? {
              ...meta,
              ...(message.meta?.toolInterimResults
                ? {
                    toolInterimResults: Object.fromEntries(
                      Object.entries(message.meta.toolInterimResults).map(([callId, result]) => [
                        callId,
                        publicAiToolResult(toolNames.get(callId) ?? "", result),
                      ]),
                    ),
                  }
                : {}),
              ...(view ? { resultView: view } : {}),
              ...(sourced?.context ? { sourceContext: sourced.context } : {}),
              ...(message.meta?.choice
                ? { choice: { ...message.meta.choice, turnId: turnShortIds.get(message.meta.choice.turnId) ?? message.meta.choice.turnId } }
                : {}),
            }
          : null,
      id: message.shortId,
      conversationId,
      loopId: message.loopId ? (turnShortIds.get(message.loopId) ?? null) : null,
    };
  });

/**
 * A turn stores its steps' presentation, app name included, as it was then. An app that renames itself must read the
 * same everywhere. Relayed Code approvals keep the review's turn locale so their name, title and question agree;
 * other steps use the reader's locale. Legacy Code approvals without a recorded locale keep their stored name.
 * The registry is an in-memory view, so this reads no SQL; an unknown app keeps its stored name.
 */
export const withCurrentAppNames = async (
  messages: readonly AiStoredMessage[],
  locale?: string,
  readApp: (appId: string) => Promise<Pick<AppRegistryEntry, "name" | "description" | "presentation"> | null> = getApp,
): Promise<AiStoredMessage[]> => {
  const appIds = new Set(
    messages.flatMap((message) =>
      Object.values(message.meta?.toolPresentations ?? {}).flatMap((presentation) =>
        presentation.kind === "capability" ? [presentation.appId] : [],
      ),
    ),
  );
  if (appIds.size === 0) return [...messages];
  const apps = new Map(
    (
      await Promise.all(
        [...appIds].map(async (appId) => {
          const app = await readApp(appId).catch(() => null);
          return app ? ([[appId, app]] as const) : [];
        }),
      )
    ).flat(),
  );
  if (apps.size === 0) return [...messages];
  return messages.map((message) => {
    const presentations = message.meta?.toolPresentations;
    if (!presentations) return message;
    const codeCalls = new Set(
      message.message.role === "assistant"
        ? message.message.content.flatMap((block) => (block.type === "tool_call" && block.name === "code_run" ? [block.id] : []))
        : [],
    );
    const current = Object.fromEntries(
      Object.entries(presentations).map(([callId, presentation]) => {
        const review = message.meta?.toolReviews?.[callId];
        const displayLocale = codeCalls.has(callId) ? (review && "locale" in review ? review.locale : null) : locale;
        const app = presentation.kind === "capability" ? apps.get(presentation.appId) : undefined;
        const appName =
          app && displayLocale !== null ? (displayLocale ? resolveAppIdentityPresentation(app, displayLocale).name : app.name) : undefined;
        return [callId, appName && appName !== presentation.appName ? { ...presentation, appName } : presentation];
      }),
    );
    return { ...message, meta: { ...message.meta, toolPresentations: current } };
  });
};

export const publicAiStoredMessages = async (
  messages: readonly AiStoredMessage[],
  conversation: Pick<AiConversation, "id" | "shortId"> & Partial<Pick<AiConversation, "createdByUserId">>,
  viewerUserId: string | null | undefined,
  /** Who reads: names of origins, and of the apps of stored steps, follow this viewer and `locale`. */
  originViewer: AiOriginViewer & { locale: string },
  loadedChoiceContext?: readonly AiStoredMessage[],
): Promise<AiStoredMessage[]> => {
  const attributed = messages.flatMap((message) => {
    const origin: AiStoredMessageOrigin | undefined =
      message.meta?.writerOrigin ??
      (message.meta?.agentMessage
        ? { kind: "chat", id: message.meta.agentMessage.sourceChatId, turnId: message.meta.agentMessage.sourceTurnId }
        : message.message.role === "user" && conversation.createdByUserId
          ? { kind: "person", id: conversation.createdByUserId }
          : undefined);
    return origin ? [{ ...message, meta: { ...message.meta, writerOrigin: origin } }] : [];
  });
  const [choiceContext, { origins, turnShortIds, doneChats }, named] = await Promise.all([
    loadedChoiceContext ??
      (messagesNeedChoiceContext(messages) ? aiConversations.listChoiceMessages({ conversationId: conversation.id }) : []),
    loadAiMessageOrigins(
      attributed.map((message) => message.meta!.writerOrigin!),
      { ...originViewer, userId: originViewer.userId ?? viewerUserId },
      {
        conversationId: conversation.id,
        turnIds: messages.flatMap((message) => [
          ...(message.loopId ? [message.loopId] : []),
          ...(message.meta?.choice ? [message.meta.choice.turnId] : []),
        ]),
        doneConversationIds: messages.flatMap((message) =>
          message.meta?.chatDone?.targetConversationId ? [message.meta.chatDone.targetConversationId] : [],
        ),
      },
    ),
    withCurrentAppNames(messages, originViewer.locale),
  ]);
  const byId = new Map(attributed.map((message, index) => [message.id, origins[index]!]));
  const projected = named.map((message) => {
    const done = message.meta?.chatDone;
    if (!done && !byId.has(message.id)) return message;
    const target = done?.targetConversationId && doneChats.get(done.targetConversationId);
    return {
      ...message,
      meta: {
        ...message.meta,
        ...(byId.has(message.id) ? { origin: byId.get(message.id)! } : {}),
        ...(done
          ? {
              chatDone: {
                chatId: done.chatId,
                turnId: done.turnId,
                status: done.status,
                messageSeq: done.messageSeq,
                ...(target
                  ? { name: target.name, href: target.href + (done.messageSeq === null ? "" : `&message=${done.messageSeq}`) }
                  : {}),
              },
            }
          : {}),
      },
    };
  });
  return projectAiNextMessages(
    projectPublicAiStoredMessages(projected, conversation.shortId, turnShortIds, choiceContext),
    conversation.id,
    viewerUserId,
  );
};
