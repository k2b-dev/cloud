import type { AiConversationTimelineEntry, AiStoredMessage } from "@k2b/cloud/ai";

export const assistantMessageAnchorSeq = (message: AiStoredMessage, timeline: readonly AiConversationTimelineEntry[]): number => {
  if (message.message.role === "user") return message.seq;
  const sameTurn = message.loopId ? timeline.find((entry) => entry.loopId === message.loopId) : undefined;
  if (sameTurn) return sameTurn.seq;
  return timeline.findLast((entry) => entry.seq <= message.seq)?.seq ?? message.seq;
};
