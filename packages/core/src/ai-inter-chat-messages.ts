import { type AiInterChatMessage, AiQuotaError, aiConversations, aiProjects, personalAiModelPolicy } from "@k2b/cloud/ai";
import { AiMessageQueueConflict, deliverAiInterChatMessage } from "@k2b/cloud/ai/runtime";
import { accounts, logger } from "@k2b/cloud/services";

const log = logger("core:ai-inter-chat-messages");

export type AiMessageDeliveryStatus = "queued" | "delivered" | "failed";

export const deliverPendingAiMessages = async (targetConversationId?: string): Promise<Map<string, AiMessageDeliveryStatus>> => {
  const outcomes = new Map<string, AiMessageDeliveryStatus>();
  let pending: AiInterChatMessage[];
  try {
    pending = await aiConversations.listPendingInterChatMessages({ targetConversationId, limit: 50 });
  } catch (error) {
    log.warn("Could not load pending inter-chat messages", { error: error instanceof Error ? error.message : String(error) });
    return outcomes;
  }
  for (const message of pending) {
    try {
      const [user, activeTarget] = await Promise.all([
        accounts.users.get({ id: message.actorUserId }),
        aiConversations.getConversation({
          conversationId: message.targetConversationId,
          ownerUserId: message.actorUserId,
        }),
      ]);
      if (!user) {
        await aiConversations.failInterChatMessage({ messageId: message.id, error: "Message actor is unavailable" });
        outcomes.set(message.id, "failed");
        continue;
      }
      const target =
        activeTarget ??
        (await aiConversations.getConversationByShortId({
          shortId: message.targetChatId,
          ownerUserId: message.actorUserId,
          archived: true,
        }));
      if (!target) continue;
      const project = target.projectId
        ? await aiProjects.snapshot(target.projectId, { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id } })
        : null;
      if (target.projectId && !project) {
        await aiConversations.failInterChatMessage({ messageId: message.id, error: "Target Project is unavailable" });
        outcomes.set(message.id, "failed");
        continue;
      }
      const delivered = await deliverAiInterChatMessage({
        message,
        chatId: target.shortId,
        actor: { kind: "user", user },
        modelPolicy: personalAiModelPolicy,
        project: project ?? undefined,
        toolSource: { kind: "default", appTools: true },
        toolApprovalContext: { actorUserId: user.id },
      });
      outcomes.set(message.id, delivered.delivered ? "delivered" : delivered.reason === "busy" ? "queued" : "failed");
    } catch (error) {
      if (error instanceof AiMessageQueueConflict || error instanceof AiQuotaError) {
        await aiConversations.failInterChatMessage({
          messageId: message.id,
          error: error instanceof AiQuotaError ? error.code : "queue_full_or_unavailable",
        });
        outcomes.set(message.id, "failed");
        continue;
      }
      outcomes.set(message.id, "queued");
      log.warn("Inter-chat message delivery failed; leaving it pending", {
        messageId: message.shortId,
        targetChatId: message.targetChatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
};
