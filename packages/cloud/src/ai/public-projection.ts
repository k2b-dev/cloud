import type { Message } from "@k2b/nessi";
import { getApp } from "../_internal/registry";
import type { AppRegistryEntry } from "../contracts/registry";
import { resolveAppIdentityPresentation } from "../shared/app-presentation";
import { projectAiChoices } from "./choices";
import { projectAiNextMessages } from "./next-message-store";
import type { AiTurnBlock, AiWireEvent } from "./protocol";
import { publicAiToolInput, publicAiToolResult } from "./public-tool-input";
import { capabilityResultView } from "./result-view";
import { aiConversations, resolveAiTurnShortIds } from "./store";
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
export const messagesNeedChoiceContext = (messages: readonly AiStoredMessage[]): boolean =>
  messages.some((message) =>
    message.message.role === "user"
      ? Boolean(message.meta?.choice)
      : message.message.role === "tool_result" && viewHasChoice(Reflect.get(Object(message.message.result), "view")),
  );

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
    return {
      ...message,
      message:
        message.message.role === "assistant"
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
              ...message.meta,
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
  conversation: Pick<AiConversation, "id" | "shortId">,
  viewerUserId?: string | null,
  locale?: string,
  loadedChoiceContext?: readonly AiStoredMessage[],
): Promise<AiStoredMessage[]> => {
  const [choiceContext, turnShortIds, named] = await Promise.all([
    loadedChoiceContext ??
      (messagesNeedChoiceContext(messages) ? aiConversations.listChoiceMessages({ conversationId: conversation.id }) : []),
    resolveAiTurnShortIds({
      conversationId: conversation.id,
      turnIds: messages.flatMap((message) => [
        ...(message.loopId ? [message.loopId] : []),
        ...(message.meta?.choice ? [message.meta.choice.turnId] : []),
      ]),
    }),
    withCurrentAppNames(messages, locale),
  ]);
  return projectAiNextMessages(
    projectPublicAiStoredMessages(named, conversation.shortId, turnShortIds, choiceContext),
    conversation.id,
    viewerUserId,
  );
};
