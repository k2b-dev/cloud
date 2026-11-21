import type { AiStoredMessage } from "../../packages/cloud/src/ai/types";

export const chatDoneMessage = (seq: number, text: string, extra: Partial<AiStoredMessage> = {}): AiStoredMessage => ({
  id: `Fact0${seq}`,
  shortId: `Fact0${seq}`,
  conversationId: "Source",
  seq,
  kind: "message",
  message: { role: "assistant", content: [{ type: "text", text }] },
  loopId: "Turn01",
  modelId: null,
  providerModel: null,
  usage: null,
  stopReason: "stop",
  loopAggregate: null,
  loopDoneReason: "stop",
  compactedAt: null,
  meta: null,
  createdAt: "2026-11-19T10:19:00.000Z",
  ...extra,
});

export const chatDoneFact = (status: "completed" | "failed" | "aborted" = "completed"): AiStoredMessage =>
  chatDoneMessage(3, "", {
    loopId: null,
    meta: {
      chatDone: {
        chatId: "Target",
        turnId: "Turn02",
        status,
        messageSeq: 2,
        name: "Hotels in Lyon",
        summary: "3 Hotels verglichen, eines unter 120 €",
        href: "/app/assistant?conversation=Target&message=2",
      },
    },
  });
