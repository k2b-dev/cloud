import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { CompactContext, Provider, StoreEntry, Usage } from "@k2b/nessi";
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
  for (const force of [false, true]) {
    test(`${force ? "manual" : "automatic"} compaction records inference usage once`, async () => {
      const { compact, context, complete, record, compactMessages } = setup(force);
      await compact(context);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0]?.[0]).toEqual({
        task: "chat-compaction",
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
