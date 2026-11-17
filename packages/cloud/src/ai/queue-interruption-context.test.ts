import { expect, test } from "bun:test";
import { aiQueueInterruptionContext } from "./queue-interruption-context";
import type { AiStoredMessage } from "./types";

const result = (callId: string, value: unknown): AiStoredMessage => ({
  id: callId,
  shortId: callId,
  conversationId: "chat",
  seq: 1,
  kind: "message",
  message: { role: "tool_result", callId, name: `tool-${callId}`, result: value },
  loopId: "interrupted-turn",
  modelId: null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta: null,
  createdAt: "2026-11-14T12:00:00.000Z",
});

test("next turn explains finished, unstarted and uncertain effects, todo state and writer provenance", () => {
  const context = aiQueueInterruptionContext({
    turnId: "old-turn",
    steps: [
      { callId: "done", name: "send", started: true },
      { callId: "not-started", name: "delete", started: false },
      { callId: "lost", name: "pay", started: true },
      { callId: "unknown", name: "publish", started: true },
    ],
    messages: [result("done", { sent: true }), result("unknown", { code: "ACTION_OUTCOME_UNKNOWN" })],
    todoPlan: { items: [{ id: "one", text: "Send report", status: "done" }] },
    origin: { kind: "automation", id: "version-1", runId: "run-1" },
  });
  expect(context).toContain("Handle the following message first");
  expect(context).toContain("explain that decision in one sentence");
  expect(context).toContain("Never blindly repeat");
  expect(context).toContain('"interruptedTurnId":"old-turn"');
  expect(context).toContain('"callId":"done","name":"send","state":"completed"');
  expect(context).toContain('"callId":"not-started","name":"delete","state":"not_executed"');
  expect(context).toContain('"callId":"lost","name":"pay","state":"outcome_unknown"');
  expect(context).toContain('"callId":"unknown","name":"publish","state":"outcome_unknown"');
  expect(context).toContain('"todoPlan":{"items":[{"id":"one"');
  expect(context).toContain('"messageOrigin":{"kind":"automation","id":"version-1","runId":"run-1"}');
});

test("an empty interrupted turn has neither a fabricated last step nor a fabricated todo plan", () => {
  const context = aiQueueInterruptionContext({
    turnId: "old",
    steps: [],
    messages: [],
    todoPlan: null,
    origin: { kind: "chat", id: "source", turnId: "source-turn" },
  });
  expect(context).toContain('"lastCompletedStep":null');
  expect(context).toContain('"todoPlan":null');
});

test("queue-interrupted approvals never become completed results in the following turn", () => {
  const context = aiQueueInterruptionContext({
    turnId: "old",
    steps: [
      { callId: "skipped", name: "send", started: false },
      { callId: "partial", name: "run", started: true },
    ],
    messages: [
      result("skipped", { code: "QUEUE_INTERRUPTED", started: false }),
      result("partial", { code: "QUEUE_INTERRUPTED", started: true }),
    ].map((entry) => ({
      ...entry,
      message:
        entry.message.role === "tool_result"
          ? { ...entry.message, reason: entry.id === "skipped" ? ("not_run" as const) : ("not_returned" as const) }
          : entry.message,
    })),
    todoPlan: null,
    origin: { kind: "person", id: "person" },
  });
  expect(context).toContain('"lastCompletedStep":null');
  expect(context).toContain('"callId":"skipped","name":"send","state":"not_executed"');
  expect(context).toContain('"callId":"partial","name":"run","state":"outcome_unknown"');
});
