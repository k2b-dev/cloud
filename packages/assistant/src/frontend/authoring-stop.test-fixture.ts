import type { AiCodeAuthoringStop, AiStoredMessage } from "@k2b/cloud/ai";

/** Fictitious persisted receipt. The platform tests the real loop and durable append. */
export async function createStoppedAuthoringFixture(locale = "en") {
  const state: AiCodeAuthoringStop = {
    reason: "repeated_error",
    completedSteps: 2,
    drafts: 1,
    unchecked: 0,
    untested: 1,
    unsubmitted: 1,
  };
  const base = {
    shortId: "short",
    conversationId: "chat",
    kind: "message" as const,
    loopId: "turn",
    modelId: "stub",
    providerModel: "stub",
    usage: null,
    stopReason: null,
    loopAggregate: null,
    loopDoneReason: "stop" as const,
    compactedAt: null,
    createdAt: "2026-11-14T12:00:00.000Z",
  };
  const messages: AiStoredMessage[] = [
    {
      ...base,
      id: "request",
      seq: 1,
      meta: null,
      message: {
        role: "user",
        content: [locale === "de" ? "Bereite eine wöchentliche Aufgabenübersicht vor." : "Prepare a weekly task summary."],
      },
    },
    { ...base, id: "stop", seq: 2, meta: { codeAuthoringStop: state }, message: { role: "assistant", content: [] } },
  ];
  return { messages, state };
}
