import { aiConversations } from "./store";

/** Trusted run context. Never accept a mandate or background flag from sandbox input. */
export async function authorizeCodeExecution(
  conversationId: string,
  turnId: string,
  userId: string,
  dependencies: {
    store: Pick<typeof aiConversations, "getConversation" | "getTurn" | "getActiveTurn" | "getTurnRunConfig">;
  } = { store: aiConversations },
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
    Object.hasOwn(config, "background") ||
    Object.hasOwn(config, "mandate")
  )
    throw new Error("Code execution is no longer authorized");
  const active = await store.getActiveTurn({ conversationId });
  if (active?.turn.id !== turnId) throw new Error("The code host's conversation turn is no longer active");
  return { conversation, turn, config };
}
