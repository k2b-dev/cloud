import type { AiStoredMessage } from "../types";

/** Fictional persisted answer: reasoning consumed all but one completion token. */
export const truncatedAnswer: AiStoredMessage = {
  id: "fictional-answer",
  shortId: "fictional",
  conversationId: "fictional-chat",
  seq: 2,
  kind: "message",
  message: { role: "assistant", content: [{ type: "text", text: "Hier ist die Übersicht für den Ausflug:" }], stopReason: "max_tokens" },
  loopId: "fictional-turn",
  modelId: "fictional-model",
  providerModel: "fictional-model",
  usage: { input: 400, output: 13107, reasoning: 13106, total: 13507 },
  stopReason: "max_tokens",
  loopAggregate: null,
  loopDoneReason: "stop",
  compactedAt: null,
  meta: {},
  createdAt: "2026-11-08T10:00:00.000Z",
};
