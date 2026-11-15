import { type AiOriginViewer, projectAiMessageOrigins } from "./message-origin";
import { projectAiNextMessages } from "./next-message-store";
import type { AiStoredMessageOrigin } from "./queue-contracts";
import { resolveAiTurnShortIds } from "./store";
import type { AiConversation, AiStoredMessage } from "./types";

export const projectPublicAiStoredMessages = (
  messages: readonly AiStoredMessage[],
  conversationId: string,
  turnShortIds: ReadonlyMap<string, string>,
): AiStoredMessage[] =>
  messages.map((message) => ({
    ...message,
    id: message.shortId,
    conversationId,
    loopId: message.loopId ? (turnShortIds.get(message.loopId) ?? null) : null,
    meta: message.meta ? (({ writerOrigin: _, ...meta }) => meta)(message.meta) : null,
  }));

export const publicAiStoredMessages = async (
  messages: readonly AiStoredMessage[],
  conversation: Pick<AiConversation, "id" | "shortId"> & Partial<Pick<AiConversation, "createdByUserId">>,
  viewerUserId?: string | null,
  originViewer: AiOriginViewer = {},
): Promise<AiStoredMessage[]> => {
  const turnShortIds = await resolveAiTurnShortIds({
    conversationId: conversation.id,
    turnIds: messages.flatMap((message) => (message.loopId ? [message.loopId] : [])),
  });
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
  const origins = await projectAiMessageOrigins(
    attributed.map((message) => message.meta!.writerOrigin!),
    { ...originViewer, userId: originViewer.userId ?? viewerUserId },
  );
  const byId = new Map(attributed.map((message, index) => [message.id, origins[index]!]));
  const projected = messages.map((message) =>
    byId.has(message.id) ? { ...message, meta: { ...message.meta, origin: byId.get(message.id)! } } : message,
  );
  return projectAiNextMessages(projectPublicAiStoredMessages(projected, conversation.shortId, turnShortIds), conversation.id, viewerUserId);
};
