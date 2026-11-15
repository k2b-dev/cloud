import { expect, test } from "bun:test";
import { AiTurnInterruption, queuedClientInterruptionState } from "./turn-interruption";

test("interrupt before an effect blocks its body", () => {
  let stopped = false;
  const barrier = new AiTurnInterruption(() => {
    stopped = true;
  });
  barrier.request();
  expect(stopped).toBe(true);
  expect(() => barrier.begin("effect")).toThrow("interrupted");
});

test("interrupt during effects waits for their durable outcomes and starts no further step", () => {
  let stopped = false;
  const barrier = new AiTurnInterruption(() => {
    stopped = true;
  });
  barrier.begin("one");
  barrier.begin("two");
  barrier.request();
  expect(stopped).toBe(false);
  expect(() => barrier.begin("three")).toThrow("interrupted");
  barrier.settled("one");
  expect(stopped).toBe(false);
  barrier.settled("two");
  expect(stopped).toBe(true);
});

test("interrupt after an effect stops before the next step", () => {
  let stopped = false;
  const barrier = new AiTurnInterruption(() => {
    stopped = true;
  });
  barrier.begin("one");
  barrier.settled("one");
  expect(stopped).toBe(false);
  barrier.request();
  expect(stopped).toBe(true);
  expect(() => barrier.begin("two")).toThrow("interrupted");
});

test("client effects stay sending within the existing deadline and confirm only after their known receipt", () => {
  const pending = { status: "pending" as const, resolvedEvent: null, late: false };
  expect(queuedClientInterruptionState({ expectedCount: 1, expired: false, actions: [pending] })).toBe("waiting");
  const resolved = {
    status: "resolved" as const,
    resolvedEvent: { type: "tool_result" as const, callId: "client", result: { written: true } },
    late: false,
  };
  expect(queuedClientInterruptionState({ expectedCount: 1, expired: false, actions: [resolved] })).toBe("confirmed");
  // Timely receipts remain valid when reconciliation runs after the deadline.
  expect(queuedClientInterruptionState({ expectedCount: 1, expired: true, actions: [resolved] })).toBe("confirmed");
});

test("expired, missing, late or unknown client outcomes leave the message not sent", () => {
  const pending = { status: "pending" as const, resolvedEvent: null, late: false };
  expect(queuedClientInterruptionState({ expectedCount: 1, expired: true, actions: [pending] })).toBe("unconfirmed");
  expect(queuedClientInterruptionState({ expectedCount: 1, expired: false, actions: [] })).toBe("unconfirmed");
  const resolved = {
    status: "resolved" as const,
    resolvedEvent: { type: "tool_result" as const, callId: "client", result: { code: "ACTION_OUTCOME_UNKNOWN" } },
    late: false,
  };
  expect(queuedClientInterruptionState({ expectedCount: 1, expired: false, actions: [resolved] })).toBe("unconfirmed");
  expect(
    queuedClientInterruptionState({
      expectedCount: 1,
      expired: false,
      actions: [{ ...resolved, late: true, resolvedEvent: { ...resolved.resolvedEvent, result: { code: "OK" } } }],
    }),
  ).toBe("unconfirmed");
});
