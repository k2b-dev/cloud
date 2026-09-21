import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { CompactContext, Provider, StoreEntry, Usage } from "@k2b/nessi";
import { defineTool, nessi } from "@k2b/nessi";
import { z } from "zod";
import { createCloudCompactFn } from "./compaction";
import { aiConversations } from "./store";
import * as structuredRuns from "./structured-runs";

const usage: Usage = { input: 120, output: 30, total: 150, creditsUsed: 0.75 };
const entries: StoreEntry[] = Array.from({ length: 8 }, (_, index) => ({
  seq: index + 1,
  kind: "message",
  message:
    index % 2 === 0
      ? { role: "user", content: [{ type: "text", text: `Request ${index}` }] }
      : { role: "assistant", content: [{ type: "text", text: `Answer ${index}` }] },
}));

const setup = (force = false) => {
  const complete = mock<Provider["complete"]>(async () => ({
    message: { role: "assistant", content: [{ type: "text", text: "Keep working on the request." }] },
    finishReason: "stop",
    usage,
  }));
  const record = spyOn(structuredRuns, "safelyRecordStructuredRun").mockResolvedValue(undefined);
  const compactMessages = spyOn(aiConversations, "compactMessages").mockResolvedValue(undefined);
  const provider: Provider = {
    name: "test",
    family: "openai-compatible",
    model: "test-summary-model",
    capabilities: { streaming: false, tools: false, images: false, thinking: false, usage: true },
    complete,
    async *stream() {
      throw new Error("Compaction must not stream");
    },
  };
  const context: CompactContext = {
    entries,
    store: { load: async () => entries, append: async () => undefined },
    provider,
    usage: { input: 0, output: 0, total: 0 },
    force,
    fillRatio: force ? 0.1 : 0.9,
  };
  const compact = createCloudCompactFn({
    conversationId: "test-conversation",
    modelProfileId: "summary-profile",
    additionalInstructions: "",
    signal: new AbortController().signal,
    ...(force ? { keepRecentLoops: 1 } : {}),
  });
  return { compact, context, complete, record, compactMessages };
};

afterEach(() => mock.restore());

describe("compaction inference accounting", () => {
  test("Nessi compacts an oversized first tool result before requesting its second model turn", async () => {
    const fixture = setup();
    let history: StoreEntry[] = [];
    let seq = 0;
    fixture.compactMessages.mockImplementation(async ({ checkpointSeq, summary }) => {
      history = [{ seq: checkpointSeq, kind: "message", message: summary }, ...history.filter((entry) => entry.seq > checkpointSeq)];
    });
    let requests = 0;
    const provider: Provider = {
      ...fixture.context.provider,
      contextWindow: 1000,
      capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
      async *stream(request) {
        requests++;
        if (requests === 1) {
          yield { type: "block_start", blockId: "read", index: 0, kind: "tool_call", callId: "read", name: "read" };
          yield { type: "block_end", blockId: "read", index: 0, block: { type: "tool_call", id: "read", name: "read", args: {} } };
          yield { type: "usage", usage: { input: 20, output: 10, total: 30 }, finishReason: "tool_use" };
        } else {
          expect(fixture.compactMessages).toHaveBeenCalledTimes(1);
          expect(JSON.stringify(request.messages)).toContain("Conversation summary");
          expect(JSON.stringify(request.messages)).not.toContain("LARGE_FILE_PAYLOAD");
          yield { type: "block_start", blockId: "done", index: 0, kind: "text" };
          yield { type: "block_end", blockId: "done", index: 0, block: { type: "text", text: "Done" } };
          yield { type: "usage", usage: { input: 30, output: 2, total: 32 }, finishReason: "stop" };
        }
      },
    };
    const loop = nessi({
      provider,
      systemPrompt: "Analyze",
      input: "Read the file",
      maxTurns: 2,
      tools: [
        defineTool({ name: "read", description: "Read", inputSchema: z.object({}) }).server(async () => "LARGE_FILE_PAYLOAD".repeat(500)),
      ],
      compact: fixture.compact,
      store: {
        load: async () => history,
        append: async (message) => {
          history.push({ seq: ++seq, kind: "message", message });
        },
      },
    });
    for await (const _event of loop) {
      /* Drain the real Nessi event loop. */
    }
    expect(requests).toBe(2);
    expect(fixture.compactMessages.mock.calls[0]?.[0].checkpointSeq).toBe(3);
  });
  test("compacts completed tool rounds during the first user loop", async () => {
    const { compact, context, compactMessages } = setup();
    const firstLoop: StoreEntry[] = [
      { seq: 1, kind: "message", message: { role: "user", content: [{ type: "text", text: "Build the dashboard" }] } },
    ];
    for (let index = 0; index < 4; index++) {
      firstLoop.push({
        seq: firstLoop.length + 1,
        kind: "message",
        message: { role: "assistant", content: [{ type: "tool_call", id: `call-${index}`, name: "read_file", args: {} }] },
      });
      firstLoop.push({
        seq: firstLoop.length + 1,
        kind: "message",
        message: { role: "tool_result", callId: `call-${index}`, name: "read_file", result: "data" },
      });
    }
    await compact({ ...context, entries: firstLoop });
    expect(compactMessages.mock.calls[0]?.[0].checkpointSeq).toBe(5);
  });

  test("can summarize one oversized completed tool round before the second model request", async () => {
    const { compact, context, compactMessages } = setup();
    const firstLoop: StoreEntry[] = [
      { seq: 1, kind: "message", message: { role: "user", content: [{ type: "text", text: "Analyze all files" }] } },
      {
        seq: 2,
        kind: "message",
        message: { role: "assistant", content: [{ type: "tool_call", id: "read", name: "read_file", args: {} }] },
      },
      { seq: 3, kind: "message", message: { role: "tool_result", callId: "read", name: "read_file", result: "large result" } },
    ];
    await compact({ ...context, entries: firstLoop, force: true });
    expect(compactMessages.mock.calls[0]?.[0].checkpointSeq).toBe(3);
  });

  test("can recover context pressure after just two rounds in the first loop", async () => {
    const { compact, context, compactMessages } = setup();
    const firstLoop: StoreEntry[] = [
      { seq: 1, kind: "message", message: { role: "user", content: [{ type: "text", text: "Build" }] } },
      {
        seq: 2,
        kind: "message",
        message: { role: "assistant", content: [{ type: "tool_call", id: "read", name: "read_file", args: {} }] },
      },
      { seq: 3, kind: "message", message: { role: "tool_result", callId: "read", name: "read_file", result: "large data" } },
      { seq: 4, kind: "message", message: { role: "assistant", content: [{ type: "text", text: "Continue analysis" }] } },
    ];
    await compact({ ...context, entries: firstLoop, force: true });
    expect(compactMessages.mock.calls[0]?.[0].checkpointSeq).toBe(3);
  });

  test("never archives an unanswered tool call across the split", async () => {
    const { compact, context, complete } = setup();
    const firstLoop: StoreEntry[] = [
      { seq: 1, kind: "message", message: { role: "user", content: [{ type: "text", text: "Build" }] } },
      {
        seq: 2,
        kind: "message",
        message: { role: "assistant", content: [{ type: "tool_call", id: "pending", name: "code_run", args: {} }] },
      },
      ...[3, 4, 5].map((seq) => ({
        seq,
        kind: "message" as const,
        message: { role: "assistant" as const, content: [{ type: "text" as const, text: "Working" }] },
      })),
    ];
    expect(compact({ ...context, entries: firstLoop, force: true })).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  for (const force of [false, true]) {
    test(`${force ? "manual" : "automatic"} compaction records inference usage once`, async () => {
      const { compact, context, complete, record, compactMessages } = setup(force);
      await compact(context);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0]?.[0]).toEqual({
        task: "chat-compaction",
        attribution: { conversationId: "test-conversation", turnId: undefined },
        appId: "core",
        modelProfileId: "summary-profile",
        providerModel: "test-summary-model",
        status: "ok",
        durationMs: expect.any(Number),
        usage,
      });
      expect(compactMessages).toHaveBeenCalledTimes(1);
    });
  }

  test("optional compaction below the threshold incurs no inference or usage record", async () => {
    const { compact, context, complete, record, compactMessages } = setup();
    expect(compact({ ...context, fillRatio: 0.5 })).toBeNull();
    expect(complete).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(compactMessages).not.toHaveBeenCalled();
  });

  test("summary persistence failure preserves one successful inference charge", async () => {
    const { compact, context, complete, record, compactMessages } = setup(true);
    compactMessages.mockImplementation(async () => {
      expect(record).toHaveBeenCalledTimes(1);
      throw new Error("summary write failed");
    });
    await expect(compact(context)).rejects.toThrow("summary write failed");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({ status: "ok", usage });
  });

  test("provider failure records model and failure metadata without fabricated usage", async () => {
    const { compact, context, complete, record, compactMessages } = setup(true);
    complete.mockRejectedValue(new Error("provider unavailable"));
    await expect(compact(context)).rejects.toThrow("provider unavailable");
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toEqual({
      task: "chat-compaction",
      attribution: { conversationId: "test-conversation", turnId: undefined },
      appId: "core",
      modelProfileId: "summary-profile",
      providerModel: "test-summary-model",
      status: "failed",
      durationMs: expect.any(Number),
      error: "provider unavailable",
    });
    expect(compactMessages).not.toHaveBeenCalled();
  });
});
