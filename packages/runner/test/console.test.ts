import { afterEach, expect, setSystemTime, test } from "bun:test";
import { CODE_OUTPUT_INTERVAL_MS, CODE_OUTPUT_OPERATION, type CodeOutputBatch } from "@k2b/cloud/code";
import { LIVE_LIMITS } from "@k2b/cloud/events/limits";

const source = await Bun.file(new URL("../src/assets/console.js", import.meta.url)).text();
const { createCodeConsole } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const fixed = Date.UTC(2030, 0, 2);
afterEach(() => setSystemTime());
const limits = { bytes: LIVE_LIMITS.frameBytes, intervalMs: CODE_OUTPUT_INTERVAL_MS, operation: CODE_OUTPUT_OPERATION };
test("a run owns its console; error stacks travel only through its bounded output call", async () => {
  setSystemTime(fixed);
  const batches: { operation: string; batch: CodeOutputBatch }[] = [];
  const output = createCodeConsole(
    {
      call: async (operation: string, batch: CodeOutputBatch) => {
        batches.push({ operation, batch });
      },
    },
    limits,
  );
  output.console.log("hello", { answer: 42 });
  output.console.error(new Error("sandbox failure"));
  await output.finish();
  expect(batches).toHaveLength(1);
  expect(batches[0]!.operation).toBe(CODE_OUTPUT_OPERATION);
  expect(batches[0]!.batch.entries[0]).toEqual({ kind: "log" as const, at: new Date().toISOString(), level: "log", text: 'hello {"answer":42}' });
  expect(batches[0]!.batch.entries.some((line) => line.level === "error" && line.text.includes("sandbox failure"))).toBe(true);
  expect(batches[0]!.batch.entries.some((line) => line.text.includes("console.test.ts"))).toBe(true);
});
test("oversized lines and a full buffer are counted and dropped, keeping the same frame limit", async () => {
  setSystemTime(fixed);
  const batches: CodeOutputBatch[] = [];
  const output = createCodeConsole(
    {
      call: async (_operation: string, batch: CodeOutputBatch) => {
        batches.push(batch);
      },
    },
    limits,
  );
  output.console.log("x".repeat(LIVE_LIMITS.frameBytes));
  output.console.log("first".repeat(1000));
  output.console.log("second".repeat(1000));
  output.console.log("third".repeat(1000));
  output.console.log("last".repeat(1000));
  await output.finish();
  expect(batches).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(batches[0]))).toBeLessThanOrEqual(LIVE_LIMITS.frameBytes);
  expect(batches[0]!.droppedLines).toBeGreaterThanOrEqual(2);
  expect(batches[0]!.droppedBytes).toBeGreaterThanOrEqual(LIVE_LIMITS.frameBytes);
});
test("two concurrent runs cannot mix console lines, even with one shared bridge", async () => {
  setSystemTime(fixed);
  const received = new Map<string, CodeOutputBatch[]>();
  const outputs = ["a", "b"].map((id) =>
    createCodeConsole(
      {
        call: async (_operation: string, batch: CodeOutputBatch) => {
          received.set(id, [...(received.get(id) ?? []), batch]);
        },
      },
      limits,
    ),
  );
  outputs[0]!.console.log("only a");
  outputs[1]!.console.error("only b");
  await Promise.all(outputs.map((output) => output.finish()));
  expect(received.get("a")![0]!.entries).toEqual([{ kind: "log" as const, at: new Date().toISOString(), level: "log", text: "only a" }]);
  expect(received.get("b")![0]!.entries).toEqual([{ kind: "log" as const, at: new Date().toISOString(), level: "error", text: "only b" }]);
});
test("a failed asynchronous flush joins cleanly and reports a stable failure", async () => {
  setSystemTime(fixed);
  const output = createCodeConsole(
    {
      call: async () => {
        throw new Error("private transport details");
      },
    },
    limits,
  );
  output.console.log("line");
  await expect(output.finish()).rejects.toThrow("code_output_unavailable");
});

test("console methods capture log metadata before the bundle is flushed", async () => {
  setSystemTime(fixed);
  const batches: CodeOutputBatch[] = [];
  const output = createCodeConsole({ call: async (_operation: string, batch: CodeOutputBatch) => { batches.push(batch); } }, limits);
  for (const level of ["log", "info", "debug", "warn", "error"] as const) output.console[level](level);
  setSystemTime(fixed + 250);
  output.console.warn("later\ncontinuation");
  await output.finish();
  expect(batches[0]!.entries).toEqual([
    ...["log", "info", "debug", "warn", "error"].map((level) => ({ kind: "log", level, at: new Date(fixed).toISOString(), text: level })),
    ...["later", "continuation"].map((text) => ({ kind: "log", level: "warn", at: new Date(fixed + 250).toISOString(), text })),
  ]);
});
