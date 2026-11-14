import { test as bunTest, expect } from "bun:test";
import { decodeChatValue, encodeChatValue } from "@k2b/cloud/code/chat-run";
import type { RunnerBridge, RunnerJobLease } from "@k2b/cloud/code/runner";
import { z } from "zod";
import { executeChatJob } from "../src/chat-job";
import { WorkerdEngine } from "../src/engine";
import { config } from "./fixtures";

const test = bunTest.skipIf(process.getuid?.() !== 0);
test("chat jobs execute the Assistant runtime, SDK sheet chunk and file RPC in isolated workerd", async () => {
  const input = await Bun.file("/app/chat-fixture.json").text();
  const now = Date.now();
  const job: RunnerJobLease = {
    kind: "chat",
    jobId: "44444444-4444-4444-8444-444444444444",
    generation: 1,
    leaseKey: "a".repeat(64),
    deadlineAt: now + 15_000,
    leaseExpiresAt: now + 15_000,
    heartbeatMs: 1000,
    inputBytes: 8 * 1024 * 1024,
    outputBytes: 2 * 1024 * 1024,
  };
  const events: unknown[] = [];
  const engine = new WorkerdEngine();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const jobCall: NonNullable<RunnerBridge["jobCall"]> = async (call) => {
    expect(call.operation).toBe("chat.message");
    const message = z
      .object({ type: z.string(), method: z.string().optional(), args: z.array(z.unknown()).optional(), value: z.unknown().optional() })
      .parse(decodeChatValue(call.input));
    events.push(message);
    if (message.type === "rpc") {
      expect(message.method).toBe("file.save");
      expect(message.args).toEqual(["answer\r\n42\r\n", "answer.csv"]);
    }
    return { ok: true, value: await encodeChatValue(null) };
  };
  try {
    const bridge = { jobCall } satisfies Pick<RunnerBridge, "jobCall">;
    // This adapter receives no production bridge, token or identity key.
    expect(await executeChatJob(job, input, { ...config, bundleBytes: 4 * 1024 * 1024 }, engine, bridge, controller.signal)).toEqual({
      kind: "chat",
      outcome: "succeeded",
    });
    expect(events).toContainEqual({ type: "output", value: { answer: 42, network: "blocked", env: [] } });
    expect(events).toContainEqual({ type: "ready" });
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await engine.close();
  }
}, 20_000);
