import { afterEach, expect, setSystemTime, test } from "bun:test";
import { CODE_OUTPUT_OPERATION, CODE_OUTPUT_STEP_LIMITS, type CodeOutputBatch, codeOutputStepBytes } from "@k2b/cloud/code";
import { LIVE_LIMITS } from "@k2b/cloud/events/limits";
import { runnerOutputLimits } from "../src/output";

const source = await Bun.file(new URL("../src/assets/console.js", import.meta.url)).text();
const { createCodeConsole } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const fixed = Date.UTC(2030, 0, 2);
afterEach(() => setSystemTime());
const limits = runnerOutputLimits({
  runId: "11111111-1111-4111-8111-111111111111",
  generation: 1,
  token: "fixture-proof",
  trustTier: "code",
  outputBytes: 32768,
});
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
  expect(batches[0]!.batch.entries[0]).toEqual({
    kind: "log" as const,
    at: new Date().toISOString(),
    level: "log",
    text: 'hello {"answer":42}',
  });
  expect(
    batches[0]!.batch.entries.some((line) => line.kind === "log" && line.level === "error" && line.text.includes("sandbox failure")),
  ).toBe(true);
  expect(batches[0]!.batch.entries.some((line) => line.kind === "log" && line.text.includes("console.test.ts"))).toBe(true);
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
  const output = createCodeConsole(
    {
      call: async (_operation: string, batch: CodeOutputBatch) => {
        batches.push(batch);
      },
    },
    limits,
  );
  for (const level of ["log", "info", "debug", "warn", "error"] as const) output.console[level](level);
  setSystemTime(fixed + 250);
  output.console.warn("later\ncontinuation");
  await output.finish();
  expect(batches[0]!.entries).toEqual([
    ...(["log", "info", "debug", "warn", "error"] as const).map((level): CodeOutputBatch["entries"][number] => ({
      kind: "log",
      level,
      at: new Date(fixed).toISOString(),
      text: level,
    })),
    ...["later", "continuation"].map((text): CodeOutputBatch["entries"][number] => ({
      kind: "log",
      level: "warn",
      at: new Date(fixed + 250).toISOString(),
      text,
    })),
  ]);
});

test("logger steps start pending, keep a run-local ID and settle once; pending steps can skip", async () => {
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
  const first = output.logger.step("Read", { icon: "file-text", description: "Read the document" });
  const skipped = output.logger.step({ label: "Save" });
  output.logger.info("Information");
  output.logger.warn("Warning");
  output.logger.error("Error");
  first.succeed("Too early");
  first.start();
  first.start();
  setSystemTime(fixed + 200);
  first.succeed("Read it");
  first.fail("Ignored");
  first.skip("Ignored");
  first.start();
  skipped.skip("Already saved");
  skipped.start();
  skipped.succeed();
  await output.finish();
  const entries = batches.flatMap((batch) => batch.entries);
  expect(entries.filter((entry) => entry.kind === "log").map((entry) => entry.level)).toEqual(["info", "warn", "error"]);
  const revisions = entries.filter((entry) => entry.kind === "step");
  const steps = [...new Map(revisions.map((entry) => [entry.id, entry])).values()];
  expect(revisions.slice(0, 2).map((entry) => entry.status)).toEqual(["pending", "pending"]);
  expect(steps.map((entry) => entry.status)).toEqual(["succeeded", "skipped"]);
  expect(steps.map((entry) => entry.id)).toEqual([1, 2]);
  expect(steps.at(-2)).toMatchObject({
    at: new Date(fixed).toISOString(),
    startedAt: new Date(fixed).toISOString(),
    endedAt: new Date(fixed + 200).toISOString(),
    message: "Read it",
  });
});

test("unhandled errors fail running steps only and retain pending steps; success leaves pending for RunLog", async () => {
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
  const running = output.logger.step("Working");
  output.logger.step("Later");
  running.start();
  output.error(new Error("Document unavailable"));
  await output.finish();
  const revisions = batches.flatMap((batch) => batch.entries).filter((entry) => entry.kind === "step");
  expect(
    [...new Map(revisions.map((entry) => [entry.id, entry])).values()].map((entry) => [entry.id, entry.status, entry.message]),
  ).toEqual([
    [1, "failed", "Document unavailable"],
    [2, "pending", undefined],
  ]);
});

test("200 steps and oversized metadata stay soft-limited with visible loss", async () => {
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
  expect(() => output.logger.step(12)).toThrow("code_output_invalid_text");
  expect(() => {
    const large = output.logger.step("x".repeat(limits.bytes), { description: "y".repeat(limits.bytes) });
    large.start();
    large.succeed("z".repeat(limits.bytes));
    for (let index = 0; index < 200; index++) {
      const step = output.logger.step("Read");
      step.start();
      step.succeed("Done");
    }
  }).not.toThrow();
  await output.finish();
  expect(batches.some((batch) => batch.droppedLines > 0)).toBe(true);
  expect(batches.every((batch) => Buffer.byteLength(JSON.stringify(batch)) <= limits.bytes)).toBe(true);
});

test("pending steps fail without a start; icons accept only unprefixed bounded names", async () => {
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
  output.logger.step("Read", { icon: "file-text" }).fail("Unavailable");
  for (const icon of ["i-tabler:file", "Bad", "file text", "a".repeat(65)]) {
    const step = output.logger.step("Next", { icon });
    step.skip("Unneeded");
  }
  await output.finish();
  const steps = batches.flatMap((batch) => batch.entries).filter((entry) => entry.kind === "step");
  expect(steps[0]).toMatchObject({ status: "failed", message: "Unavailable", icon: "file-text" });
  expect(steps[0]).not.toHaveProperty("startedAt");
  expect(steps.filter((entry) => entry.icon && entry.icon !== "file-text").map((entry) => entry.icon)).toEqual([]);
});

test("successful completion keeps unstarted steps pending for the display to interpret", async () => {
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
  output.logger.step("Never started");
  await output.finish();
  expect(batches[0]!.entries).toEqual([
    { kind: "step", id: 1, at: new Date(fixed).toISOString(), label: "Never started", status: "pending" },
  ]);
});

test("automatic failure fits reserved lifecycle metadata even when handle storage is full", async () => {
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
  for (let index = 0; index < CODE_OUTPUT_STEP_LIMITS.count; index++) {
    try {
      output.logger.step("x".repeat(CODE_OUTPUT_STEP_LIMITS.textBytes / 2)).start();
    } catch {
      break;
    }
  }
  expect(() => output.error(new Error("x".repeat(CODE_OUTPUT_STEP_LIMITS.textBytes)))).not.toThrow();
  await output.finish();
  expect(batches.flatMap((batch) => batch.entries).some((entry) => entry.kind === "step" && entry.status === "failed")).toBe(true);
});

test.each(["chat", "test"])("%s output supplies console and logger without production bridge traffic", async (trustTier) => {
  setSystemTime(fixed);
  const calls: unknown[] = [];
  const output = createCodeConsole(
    {
      call: async (...args: unknown[]) => {
        calls.push(args);
      },
    },
    runnerOutputLimits({ runId: "fixture", generation: 1, token: "fixture-proof", trustTier }),
  );
  const step = output.logger.step("Read");
  step.start();
  output.console.log("Console output");
  output.console.error("Console error");
  output.logger.info("Information");
  output.error(new Error("Document unavailable"));
  await output.finish();
  expect(calls).toEqual([]);
});

test("buffered step rows retain creation order while logs exceed a frame", async () => {
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
  const first = output.logger.step("First"),
    second = output.logger.step("Second");
  first.start();
  second.start();
  for (let index = 0; index < 40; index++) output.console.log("x".repeat(1000));
  first.succeed("Done");
  second.skip("Unneeded");
  await output.finish();
  expect(
    [...new Map(batches[0]!.entries.filter((entry) => entry.kind === "step").map((entry) => [entry.id, entry])).values()].map((entry) => [
      entry.id,
      entry.status,
    ]),
  ).toEqual([
    [1, "succeeded"],
    [2, "skipped"],
  ]);
  expect(batches[0]!.droppedLines).toBeGreaterThan(0);
});

test("completion text follows intervening logs in the captured stream", async () => {
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
  const step = output.logger.step("Upload");
  step.start();
  output.logger.info("Bearer abcd");
  step.succeed("efgh");
  await output.finish();
  expect(batches[0]!.entries.map((entry) => (entry.kind === "log" ? entry.text : [entry.status, entry.message]))).toEqual([
    ["running", undefined],
    "Bearer abcd",
    ["succeeded", "efgh"],
  ]);
});

test("handle admission reserves canonical parts and completion text within the pinned budget", async () => {
  setSystemTime(fixed);
  const batches: CodeOutputBatch[] = [];
  const label = "Read!",
    message = "Done!".repeat(CODE_OUTPUT_STEP_LIMITS.textReserveBytes);
  const output = createCodeConsole(
    {
      call: async (_operation: string, batch: CodeOutputBatch) => {
        batches.push(batch);
      },
    },
    {
      ...limits,
      step: { ...limits.step, budget: codeOutputStepBytes({ label, message }) + Buffer.byteLength("{}") },
    },
  );
  const step = output.logger.step(label);
  step.start();
  step.succeed(message);
  output.logger.step("Another!").start();
  await output.finish();
  expect(batches[0]!.entries).toEqual([
    {
      kind: "step",
      id: 1,
      at: new Date(fixed).toISOString(),
      label,
      status: "succeeded",
      startedAt: new Date(fixed).toISOString(),
      endedAt: new Date(fixed).toISOString(),
      message,
    },
  ]);
  expect(batches[0]!.droppedLines).toBe(1);
});
