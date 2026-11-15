import { describe, expect, spyOn, test } from "bun:test";
import type { StoreEntry } from "@k2b/nessi";
import { __compactionTest } from "./compaction";
import { __aiRuntimeTest, abortAiTurn, registerAiTurnAbortHandler } from "./runtime";
import { aiConversations } from "./store";

describe("AI compaction split", () => {
  const messageEntry = (seq: number, role: "user" | "assistant"): StoreEntry => ({
    seq,
    kind: "message",
    message:
      role === "user"
        ? { role, content: [{ type: "text", text: `User ${seq}` }] }
        : { role, content: [{ type: "text", text: `Assistant ${seq}` }] },
  });

  test("splits at user-message loop boundaries", () => {
    const entries: StoreEntry[] = [
      messageEntry(1, "user"),
      messageEntry(2, "assistant"),
      { seq: 3, kind: "message", message: { role: "tool_result", callId: "call-1", name: "tool", result: { ok: true } } },
      messageEntry(4, "user"),
      messageEntry(5, "assistant"),
      messageEntry(6, "user"),
      messageEntry(7, "assistant"),
      messageEntry(8, "user"),
    ];

    expect(__compactionTest.countConversationLoops(entries)).toBe(4);
    expect(__compactionTest.findLoopSplitIndex(entries, 2)).toBe(5);
    expect(entries.slice(0, __compactionTest.findLoopSplitIndex(entries, 2)).map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  test("keeps more recent loops when context pressure is lower", () => {
    expect(__compactionTest.keepLoopsForFillRatio(undefined, 10)).toBe(2);
    expect(__compactionTest.keepLoopsForFillRatio(0.75, 10)).toBe(3);
    expect(__compactionTest.keepLoopsForFillRatio(0.95, 10)).toBe(2);
  });

  test("manual compaction (keep 1 loop) splits right before the latest user message", () => {
    const entries: StoreEntry[] = [
      messageEntry(1, "user"),
      messageEntry(2, "assistant"),
      messageEntry(3, "user"),
      messageEntry(4, "assistant"),
      messageEntry(5, "user"),
      messageEntry(6, "assistant"),
    ];

    // keepLoops = 1: everything before the last user message goes into the summary.
    expect(__compactionTest.findLoopSplitIndex(entries, 1)).toBe(4);
    expect(entries.slice(0, 4).map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  });
});

describe("AI action response idempotency", () => {
  test("accepts only an identical replay", () => {
    expect(
      __aiRuntimeTest.actionMatchesResolvedEvent(
        { type: "approval_response", approved: true },
        { type: "approval_response", callId: "call-1", approved: true },
        "call-1",
      ),
    ).toBe(true);
    expect(
      __aiRuntimeTest.actionMatchesResolvedEvent(
        { type: "approval_response", approved: false },
        { type: "approval_response", callId: "call-1", approved: true },
        "call-1",
      ),
    ).toBe(false);
    expect(
      __aiRuntimeTest.actionMatchesResolvedEvent(
        { type: "tool_result", result: { nested: { ok: true }, values: [1, 2] } },
        { type: "tool_result", callId: "call-2", result: { nested: { ok: true }, values: [1, 2] } },
        "call-2",
      ),
    ).toBe(true);
    expect(
      __aiRuntimeTest.actionMatchesResolvedEvent(
        { type: "tool_result", result: { ok: false } },
        { type: "tool_result", callId: "call-2", result: { ok: true } },
        "call-2",
      ),
    ).toBe(false);
  });
});

test("review submission hooks cannot block cancellation of an ordinary turn", async () => {
  let calls = 0;
  const dispose = registerAiTurnAbortHandler(async () => {
    calls++;
    throw new Error("Review host unavailable");
  });
  const config = spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue({ kind: "chat", input: "ordinary" });
  const active = spyOn(aiConversations, "getActiveTurn").mockResolvedValue(null);
  const request = spyOn(aiConversations, "requestTurnAbort").mockResolvedValue({ found: false });
  try {
    expect(await abortAiTurn({ conversationId: "chat", turnId: "turn" })).toEqual({ ok: true });
    expect(calls).toBe(0);
  } finally {
    dispose();
    config.mockRestore();
    active.mockRestore();
    request.mockRestore();
  }
});

test("Composer cancellation closes a review host's submission gate before aborting the turn", async () => {
  const steps: string[] = [];
  const dispose = registerAiTurnAbortHandler(async () => {
    steps.push("submission-gate-closed");
  });
  const config = spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue({
    kind: "chat",
    input: "fixed",
    codeReview: { codeId: "c_review", versionId: "11111111-1111-4111-8111-111111111111" },
  });
  const active = spyOn(aiConversations, "getActiveTurn").mockResolvedValue(null);
  const request = spyOn(aiConversations, "requestTurnAbort").mockImplementation(async () => {
    steps.push("turn-aborted");
    return { found: false };
  });
  try {
    await abortAiTurn({ conversationId: "chat", turnId: "turn" });
    expect(steps).toEqual(["submission-gate-closed", "turn-aborted"]);
  } finally {
    dispose();
    config.mockRestore();
    active.mockRestore();
    request.mockRestore();
  }
});
