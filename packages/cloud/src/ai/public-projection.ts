import { projectAiNextMessages } from "./next-message-store";
import { capabilityResultView } from "./result-view";
import { resolveAiTurnShortIds } from "./store";
import type { AiConversation, AiStoredMessage } from "./types";

export const projectPublicAiStoredMessages = (
  messages: readonly AiStoredMessage[],
  conversationId: string,
  turnShortIds: ReadonlyMap<string, string>,
): AiStoredMessage[] =>
  messages.map((message) => {
    const view = message.message.role === "tool_result" && !message.message.isError ? capabilityResultView(message.message.result) : null;
    return {
      ...message,
      ...(view ? { meta: { ...message.meta, resultView: view } } : {}),
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
  const turnShortIds = await resolveAiTurnShortIds({
    conversationId: conversation.id,
    turnIds: messages.flatMap((message) => (message.loopId ? [message.loopId] : [])),
  });
  return projectAiNextMessages(projectPublicAiStoredMessages(messages, conversation.shortId, turnShortIds), conversation.id, viewerUserId);
};
