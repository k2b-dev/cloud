import { projectAiChoices } from "./choices";
import { projectAiNextMessages } from "./next-message-store";
import { capabilityResultView } from "./result-view";
import { aiConversations, resolveAiTurnShortIds } from "./store";
import type { AiConversation, AiStoredMessage } from "./types";

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
): Promise<AiStoredMessage[]> => {
  const choiceContext = await aiConversations.listChoiceMessages({ conversationId: conversation.id });
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
