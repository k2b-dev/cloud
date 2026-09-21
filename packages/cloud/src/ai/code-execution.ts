import { getMandate } from "../services/mandates";
import { aiConversations } from "./store";

/** Trusted run context. Never accept a mandate or background flag from sandbox input. */
export async function authorizeCodeExecution(
  conversationId: string,
  turnId: string,
  userId: string,
  dependencies: {
    store: Pick<typeof aiConversations, "getConversation" | "getTurn" | "getActiveTurn" | "getTurnRunConfig">;
    getMandate: typeof getMandate;
  } = { store: aiConversations, getMandate },
) {
  const { store } = dependencies;
  const [conversation, turn, config] = await Promise.all([
    store.getConversation({ conversationId, ownerUserId: userId }),
    store.getTurn({ conversationId, turnId }),
    store.getTurnRunConfig({ conversationId, turnId }),
  ]);
  if (
    !conversation ||
    conversation.createdByUserId !== userId ||
    conversation.archivedAt ||
    !turn ||
    turn.cancelRequestedAt ||
    !["running", "waiting_for_action"].includes(turn.status) ||
    !config ||
    config.kind === "compact" ||
    Boolean(config.background) !== Boolean(config.mandate)
  )
    throw new Error("Code execution is no longer authorized");
  if (config.background && config.mandate) {
    // chat-tasks persists the mandate binding; background.taskId is a public short ID,
    // whereas mandate.workloadId is the internal task UUID.
    const mandate = await dependencies.getMandate(config.mandate.id);
    if (
      !mandate ||
      mandate.ownerAppId !== "core" ||
      mandate.workloadType !== "ai.chat-task" ||
      mandate.subject.type !== "user" ||
      mandate.subject.id !== userId ||
      mandate.state !== "active" ||
      mandate.revision !== config.mandate.revision ||
      !mandate.confirmedAt ||
      (mandate.expiresAt && Date.parse(mandate.expiresAt) <= Date.now())
    )
      throw new Error("Background task authority changed. Update the task in the normal chat.");
  } else {
    const active = await store.getActiveTurn({ conversationId });
    if (active?.turn.id !== turnId) throw new Error("The code host's conversation turn is no longer active");
  }
  return { conversation, turn, config };
}
