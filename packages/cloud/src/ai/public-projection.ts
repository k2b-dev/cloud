import { projectAiChoices } from "./choices";
import { projectAiNextMessages } from "./next-message-store";
import { capabilityResultView } from "./result-view";
import { aiConversations, resolveAiTurnShortIds } from "./store";
import type { AiConversation, AiStoredMessage } from "./types";

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
    const view = message.message.role === "tool_result" && !message.message.isError ? capabilityResultView(message.message.result) : null;
    return {
      ...message,
      meta:
        message.meta || view
          ? {
              ...message.meta,
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

export const publicAiStoredMessages = async (
  messages: readonly AiStoredMessage[],
  conversation: Pick<AiConversation, "id" | "shortId">,
  viewerUserId?: string | null,
  loadedChoiceContext?: readonly AiStoredMessage[],
): Promise<AiStoredMessage[]> => {
  const choiceContext =
    loadedChoiceContext ??
    (messagesNeedChoiceContext(messages) ? await aiConversations.listChoiceMessages({ conversationId: conversation.id }) : []);
  const turnShortIds = await resolveAiTurnShortIds({
    conversationId: conversation.id,
    turnIds: messages.flatMap((message) => [
      ...(message.loopId ? [message.loopId] : []),
      ...(message.meta?.choice ? [message.meta.choice.turnId] : []),
    ]),
  });
  return projectAiNextMessages(
    projectPublicAiStoredMessages(messages, conversation.shortId, turnShortIds, choiceContext),
    conversation.id,
    viewerUserId,
  );
};
