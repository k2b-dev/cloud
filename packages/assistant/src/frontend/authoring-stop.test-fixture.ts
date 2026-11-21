import type { AiCodeAuthoringStop, AiStoredMessage } from "@k2b/cloud/ai";

export const authoringStopNow = "2026-11-14T12:05:00.000Z";
export const authoringStopReasons = ["input_tokens", "model_calls", "repeated_error"] as const;
export const authoringStopSaves = ["none", "draft", "version"] as const;
export type AuthoringStopSave = (typeof authoringStopSaves)[number];

export function authoringStopState(reason: AiCodeAuthoringStop["reason"], save: AuthoringStopSave): AiCodeAuthoringStop {
  return {
    reason,
    completedSteps: 2,
    drafts: save === "none" ? 0 : 1,
    unchecked: 0,
    untested: save === "draft" ? 1 : 0,
    unsubmitted: save === "draft" ? 1 : 0,
  };
}

/** Fictitious persisted receipt. The platform tests the real loop and durable append. */
export async function createStoppedAuthoringFixture(
  locale = "en",
  reason: AiCodeAuthoringStop["reason"] = "repeated_error",
  save: AuthoringStopSave = "draft",
) {
  const state = authoringStopState(reason, save);
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
