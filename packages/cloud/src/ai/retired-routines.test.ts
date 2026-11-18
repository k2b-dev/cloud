import { expect, spyOn, test } from "bun:test";
import { __aiExecutorTest, AiTurnExecutor } from "./executor";
import { assertInteractiveChatTurn } from "./retired-routines";
import { __aiRuntimeTest, prepareAiChatTurn } from "./runtime";
import { aiConversations } from "./store";
import * as stream from "./stream";
import type { AiChatTurnRunConfig, AiTurnClaim } from "./types";

test("routine admission fails before settings, files or model work, even with a mandate", async () => {
  const background = { taskId: "Task01", occurrenceId: "Run001", context: [] };
  const input = {
    conversationId: "chat",
    input: "run",
    userMessage: { role: "user" as const, content: [] },
    background,
    mandate: { id: "mandate", revision: 1 },
  };
  await expect(prepareAiChatTurn(input)).rejects.toThrow("Scheduled chat routines are retired");
  await expect(
    aiConversations.submitChatTurn({
      conversationId: "chat",
      modelId: "model",
      userMessage: input.userMessage,
      runConfig: { input: "run", background, mandate: input.mandate },
    }),
  ).rejects.toThrow("Scheduled chat routines are retired");
});

test("even a malformed retired flag fails closed; Code-origin interactive turns stay admitted", () => {
  for (const background of [null, false, undefined, {}])
    expect(() => assertInteractiveChatTurn({ input: "run", background })).toThrow("routines are retired");
  expect(() => assertInteractiveChatTurn({ input: "run", mandate: {} })).toThrow("routines are retired");
  expect(() => assertInteractiveChatTurn({ input: "run", codeOrigin: { codeId: "Code01" } })).not.toThrow();
});

// Publication is a pure boundary: legacy run metadata must never close a foreground stream.
test.each(["background", "mandate"])("retired routine sweep finalization leaves the interactive chat stream open (%s)", async (legacy) => {
  const config = spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue({
    kind: "chat",
    input: "Run",
    toolSource: { kind: "none" },
    ...(legacy === "background"
      ? { background: { taskId: "task01", occurrenceId: "run001", context: [] } }
      : { mandate: { id: "mandate", revision: 1 } }),
  });
  const publish = spyOn(stream, "publishAiWireEvent").mockResolvedValue(undefined);
  try {
    await __aiRuntimeTest.publishSweepFinished(
      { conversationId: crypto.randomUUID(), turnId: crypto.randomUUID(), attempt: 1, seq: 7 },
      "failed",
    );
    expect(publish).not.toHaveBeenCalled();
  } finally {
    config.mockRestore();
    publish.mockRestore();
  }
});

test.each(["background", "queued", "automation", "send-now", "resumed interrupt"] as const)(
  "executor denies retired mandate authority before any effect (%s)",
  async (path) => {
    const config: AiChatTurnRunConfig = {
      kind: "chat",
      input: "Legacy authority must not run",
      locale: "de",
      toolSource: { kind: "none" },
      background: { taskId: "Task01", occurrenceId: "Run001", context: [] },
      mandate: { id: "mandate", revision: 1 },
      ...(path === "automation"
        ? { writerOrigin: { kind: "automation", id: "legacy" }, turnTrigger: { kind: "automation", id: "legacy" } }
        : {}),
      ...(path === "send-now" ? { systemPrompt: 'Interrupted turn: {"interruptedTurnId":"Old01"}' } : {}),
    };
    const claim: AiTurnClaim = {
      turn: {
        id: "turn",
        shortId: "Turn01",
        conversationId: "chat",
        status: path === "queued" ? "queued" : "running",
        attempt: path === "resumed interrupt" ? 2 : 1,
        modelId: "fixture",
        createdAt: "2026-11-17T00:00:00.000Z",
        completedAt: null,
        error: null,
      },
      runConfig: config,
      liveSeq: path === "resumed interrupt" ? 8 : 0,
      liveBlocks: [],
    };
    let finalized = 0;
    const host = spyOn(aiConversations, "getConversation").mockRejectedValue(new Error("Must not materialize legacy work"));
    const executor = new AiTurnExecutor({ leaseOwner: "test", heartbeatMs: 1000, enqueueContinuation: async () => {} });
    executor["finalize"] = async (_conversation, _turn, _pipeline, status, failure) => {
      finalized++;
      expect(status).toBe("failed");
      expect(failure?.detail).toContain("Scheduled chat routines are retired");
      return "completed";
    };
    const pipeline = new __aiExecutorTest.StreamPipeline({
      conversationId: "chat",
      turnId: "turn",
      attempt: claim.turn.attempt,
      startSeq: claim.liveSeq,
      leaseOwner: "test",
      seedBlocks: [],
      allowRememberedApprovals: false,
    });
    try {
      await executor["runChat"]("chat", "turn", claim, config, pipeline, new AbortController().signal, path === "resumed interrupt");
      expect(finalized).toBe(1);
      expect(host).not.toHaveBeenCalled();
    } finally {
      host.mockRestore();
      await pipeline.flush();
    }
  },
);
