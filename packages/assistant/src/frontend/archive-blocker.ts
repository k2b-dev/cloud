import type { AiConversation } from "@k2b/cloud/ai";

/** What keeps a chat from being archived: a response that runs, or a turn that waits for a decision (#108). */
export type AssistantArchiveBlocker = "running" | "waiting" | null;

/** The open chat knows its live turn; every other chat answers from its last known run state. */
export const assistantArchiveBlocker = (
  conversation: Pick<AiConversation, "runStatus">,
  activeTurn: { status: string } | null,
): AssistantArchiveBlocker => {
  if (activeTurn) return activeTurn.status === "waiting_for_action" ? "waiting" : "running";
  if (conversation.runStatus === "queued" || conversation.runStatus === "running") return "running";
  if (conversation.runStatus === "needs_attention" || conversation.runStatus === "waiting_for_browser") return "waiting";
  return null;
};
