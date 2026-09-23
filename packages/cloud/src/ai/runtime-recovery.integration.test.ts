import { expect, spyOn } from "bun:test";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { logging } from "../services/logging";
import { coreSettings } from "../services/settings/api";
import { __aiRuntimeTest } from "./runtime";
import { aiConversations } from "./store";
import * as stream from "./stream";

const recovery = testFor("database");
// The logger inserts fire-and-forget; wait for the row by time, not by iterations.
const persisted = async (conversationId: string, code: string) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await logging.list({ page: 1, perPage: 10, offset: 0 }, { source: "ai:runtime", search: conversationId });
    const entry = result.entries.find((entry) => entry.metadata?.code === code);
    if (entry) return entry;
    await Bun.sleep(10);
  }
  throw new Error("Diagnostic was not persisted");
};

// Exercise the real recovery callbacks; restore every seam after each scenario.
recovery("heartbeat warnings are deduplicated and shutdown does not advance the queue", async () => {
  const pending = Promise.withResolvers<void>();
  const settings = spyOn(coreSettings, "get").mockResolvedValue(30);
  const claim = spyOn(aiConversations, "claimTurn").mockImplementation(async () => {
    await pending.promise;
    return null;
  });
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const interval = globalThis.setInterval;
  let tick: (() => void) | undefined;
  Object.defineProperty(globalThis, "setInterval", {
    value: (callback: () => void) => {
      tick = callback;
      return interval(callback, 1_000_000);
    },
  });
  const signal = new AbortController();
  let heartbeatFails = true;
  const job = { conversationId: crypto.randomUUID(), turnId: crypto.randomUUID() };
  const processing = __aiRuntimeTest.processMessage(
    {
      messageId: "recovery-fixture",
      data: job,
      heartbeat: async () => {
        if (heartbeatFails) throw new Error("private transport details");
      },
    },
    signal.signal,
  );
  try {
    tick!();
    await Bun.sleep(0);
    tick!();
    await Bun.sleep(0);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[2]).toMatchObject({ code: "queue_heartbeat_failed" });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private transport details");
    heartbeatFails = false;
    tick!();
    await Bun.sleep(0);
    heartbeatFails = true;
    tick!();
    await Bun.sleep(0);
    expect(warning).toHaveBeenCalledTimes(2);
    signal.abort();
    tick!();
    await Bun.sleep(0);
    expect(warning).toHaveBeenCalledTimes(2);
    expect((await persisted(job.conversationId, "queue_heartbeat_failed")).metadata?.turnId).toBe(job.turnId);
  } finally {
    signal.abort();
    pending.resolve();
    await processing;
    Object.defineProperty(globalThis, "setInterval", { value: interval });
    settings.mockRestore();
    claim.mockRestore();
    warning.mockRestore();
  }
});

recovery("a failed completion publication remains recoverable and logs turn correlation", async () => {
  const publish = spyOn(stream, "publishAiWireEvent").mockRejectedValue(new Error("private payload"));
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const turn = { conversationId: crypto.randomUUID(), turnId: crypto.randomUUID(), attempt: 1, seq: 7 };
  try {
    await __aiRuntimeTest.publishSweepFinished(turn, "aborted");
    expect(warning.mock.calls[0]?.[2]).toMatchObject({
      code: "completion_publish_failed",
      conversationId: turn.conversationId,
      turnId: turn.turnId,
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private payload");
    expect((await persisted(turn.conversationId, "completion_publish_failed")).metadata?.turnId).toBe(turn.turnId);
  } finally {
    publish.mockRestore();
    warning.mockRestore();
  }
});

recovery("background sweep finalization does not finish the interactive chat stream", async () => {
  const config = spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue({
    kind: "chat",
    input: "Run",
    toolSource: { kind: "none" },
    background: { taskId: "task01", occurrenceId: "run001", context: [] },
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
