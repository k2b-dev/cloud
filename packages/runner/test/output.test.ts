import { afterEach, expect, setSystemTime, test } from "bun:test";
import { CODE_OUTPUT_INTERVAL_MS, type CodeOutputBatch } from "@k2b/cloud/code";
import { RunnerOutput } from "../src/output";

const proof = { runId: "fixture", generation: 1, token: "fixture-proof" };
const now = Date.UTC(2030, 0, 2);
const batch = (seq: number) => ({ seq, entries: [{ kind: "log" as const, at: new Date().toISOString(), level: "log" as const, text: "fixture" }], droppedLines: 0, droppedBytes: 0 });
afterEach(() => setSystemTime());
test("harden supervisor pacing and aggregate direct submissions before HTTP", async () => {
  setSystemTime(now);
  const sent: CodeOutputBatch[] = [];
  const output = new RunnerOutput(async (batch) => {
    sent.push(batch);
  }, proof);
  for (let seq = 1; seq <= 100; seq++) await output.write(batch(seq));
  expect(sent).toHaveLength(1);
  setSystemTime(now + CODE_OUTPUT_INTERVAL_MS);
  await output.write(batch(101));
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ seq: 2, droppedLines: 99 });
  expect(sent[1]!.droppedBytes).toBeGreaterThan(0);
});
test("harden supervisor in-flight output without queueing additional requests", async () => {
  setSystemTime(now);
  const finish = Promise.withResolvers<void>();
  const sent: CodeOutputBatch[] = [];
  const output = new RunnerOutput(async (batch) => {
    sent.push(batch);
    await finish.promise;
  }, proof);
  const first = output.write(batch(1));
  await Promise.all(Array.from({ length: 100 }, (_, index) => output.write(batch(index + 2))));
  expect(sent).toHaveLength(1);
  finish.resolve();
  await first;
  setSystemTime(now + CODE_OUTPUT_INTERVAL_MS);
  await output.write(batch(102));
  expect(sent[1]!.droppedLines).toBe(100);
});

test("harden the complete output envelope after loss aggregation", async () => {
  const { LIVE_LIMITS } = await import("@k2b/cloud/events/limits");
  const { CodeOutputBatchSchema } = await import("@k2b/cloud/code");
  setSystemTime(now);
  const sent: CodeOutputBatch[] = [];
  const output = new RunnerOutput(async (batch) => {
    sent.push(batch);
  }, proof);
  const raw = { seq: 1, entries: [{ kind: "log" as const, at: new Date().toISOString(), level: "log" as const, text: "" }], droppedLines: 0, droppedBytes: 0 };
  raw.entries[0]!.text = "x".repeat(LIVE_LIMITS.frameBytes - Buffer.byteLength(JSON.stringify(raw)));
  expect(CodeOutputBatchSchema.safeParse(raw).success).toBe(true);
  await output.write(raw);
  expect(sent[0]).toMatchObject({ entries: [], droppedLines: 1 });
  expect(Buffer.byteLength(JSON.stringify({ ...proof, batch: sent[0] }))).toBeLessThanOrEqual(LIVE_LIMITS.frameBytes);
});
