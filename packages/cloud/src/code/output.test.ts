import { expect, spyOn, test } from "bun:test";
import { LIVE_LIMITS } from "../events/live-engine";
import {
  appendCodeOutput,
  applyCodeOutputEvent,
  CODE_OUTPUT_STEP_LIMITS,
  CodeOutputBatchSchema,
  type CodeOutputEvent,
  CodeOutputEventSchema,
  type CodeOutputKnownEntry,
  CodeOutputWindowSchema,
  cleanCodeOutput,
  codeOutputParts,
  codeOutputStepBytes,
  codeOutputStepsBudget,
  emptyCodeOutput,
  isCodeOutputLogEntry,
  isCodeOutputStepEntry,
} from "./output";

const line = (text: string): Extract<CodeOutputKnownEntry, { kind: "log" }> => ({
  id: text,
  kind: "log" as const,
  at: "2030-01-02T00:00:00.000Z",
  level: "log",
  text: [{ type: "text", text }],
});
test("the same whole-line tail and loss counters apply on Core, replay and browser", () => {
  const lines = [line("first"), line("second"), line("third")];
  const budget = new TextEncoder().encode(JSON.stringify(lines.slice(1))).length;
  const stored = appendCodeOutput({ ...emptyCodeOutput(1), seq: 1 }, lines, budget, { lines: 2, bytes: 10 });
  const event: CodeOutputEvent = { ...stored, entries: lines, type: "code.output", runId: "11111111-1111-4111-8111-111111111111", budget };
  expect(stored.entries).toEqual(lines.slice(1));
  expect(stored.droppedLines).toBe(3);
  expect(stored.droppedBytes).toBeGreaterThan(10);
  const replay = applyCodeOutputEvent(emptyCodeOutput(), event);
  expect(replay).toEqual(stored);
  expect(applyCodeOutputEvent(replay, event)).toEqual(stored);
  expect(applyCodeOutputEvent(replay, { ...event, generation: 0, seq: 8 })).toEqual(stored);
  expect(applyCodeOutputEvent(replay, { ...event, generation: 2, seq: 1 })).toEqual({ ...stored, generation: 2 });
});
test("input messages use the actual live frame limit, including JSON escaping and UTF-8", () => {
  const batch = {
    seq: 1,
    entries: [{ kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log", text: "ok" }],
    droppedLines: 0,
    droppedBytes: 0,
  };
  expect(CodeOutputBatchSchema.safeParse(batch).success).toBe(true);
  expect(
    CodeOutputBatchSchema.safeParse({
      ...batch,
      entries: [{ kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log", text: "😀".repeat(LIVE_LIMITS.frameBytes / 4) }],
    }).success,
  ).toBe(false);
  expect(CodeOutputBatchSchema.safeParse({ ...batch, seq: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
});
test("terminal sequences, C1 CSI, controls and direction marks are removed; HTML stays ordinary text", () => {
  expect(cleanCodeOutput("\x1b[31mred\x1b[0m\x9b32mgreen\x9b0m\x1b]0;title\x07\x1bPprivate\x1b\\\u202e<img>\x00\x08")).toBe(
    "redgreen<img>",
  );
  expect(cleanCodeOutput("a\x9d0;title\x9cb\x90private\x9cc\x1b7d\x1b[31")).toBe("abcd");
  expect(codeOutputParts("before [secret:TOKEN] <script>after</script>")).toEqual([
    { type: "text", text: "before " },
    { type: "secret", name: "TOKEN" },
    { type: "text", text: " <script>after</script>" },
  ]);
});

test.each(["\x1b]", "\x9d"])("OSC %j keeps its terminator and incomplete-sequence behavior", (start) => {
  for (const terminator of ["\x07", "\x1b\\", "\x9c"]) {
    expect(cleanCodeOutput(`before${start}title${terminator}after`)).toBe("beforeafter");
    expect(cleanCodeOutput(`${start}outer\x9dinner${terminator}after`)).toBe("after");
  }
  expect(cleanCodeOutput(`before${start}title`)).toBe("before");
  expect(cleanCodeOutput(`${start}title\x1b!`)).toBe("title!");
  expect(cleanCodeOutput(`${start}outer\x9dinner\x1b!after`)).toBe("outerinnerfter");
  expect(cleanCodeOutput(`${start}title\x1b\x00after`)).toBe("titleafter");
  expect(cleanCodeOutput(`${start}title\x1b[31mafter`)).toBe("titleafter");
  expect(cleanCodeOutput(`${start}outer\x1b]inner\x07after`)).toBe("outerafter");
});

test.each(["\x1bP", "\x1b^", "\x1b_", "\x1bX", "\x90", "\x98", "\x9e", "\x9f"])(
  "string sequence %j ends at ST or input end, and permits other escapes in its body",
  (start) => {
    for (const terminator of ["\x1b\\", "\x9c"]) {
      expect(cleanCodeOutput(`before${start}private\x1b]title\x07${terminator}after`)).toBe("beforeafter");
    }
    expect(cleanCodeOutput(`before${start}private\x1b!`)).toBe("before");
  },
);

test.each(["\x1b[", "\x9b"])("CSI %j preserves parameter, intermediate and final byte boundaries", (start) => {
  expect(cleanCodeOutput(`before${start}0:;? !/mafter`)).toBe("beforeafter");
  expect(cleanCodeOutput(`before${start}0:;? !/`)).toBe("before");
  expect(cleanCodeOutput(`${start}31\x00after`)).toBe("31after");
  expect(cleanCodeOutput(`${start}31 0after`)).toBe("31 0after");
  expect(cleanCodeOutput(`${start}0 /@after${start}?~end`)).toBe("afterend");
});

test("generic escapes, trailing escapes, Unicode and empty input keep their existing behavior", () => {
  expect(cleanCodeOutput("a\x1b !0b\x1b!\x00c\x1b")).toBe("ab!c");
  expect(cleanCodeOutput("a\x1b~b\x1b\x7fc")).toBe("abc");
  expect(cleanCodeOutput("\x1b\x1b[31mred\x1b]unfinished\n")).toBe("red");
  expect(cleanCodeOutput("é😀\ud800\udfff\u2028\u2029\u200d\n")).toBe("é😀\ud800\udfff");
  expect(cleanCodeOutput("")).toBe("");
});

test("failed OSC prefixes take linear character reads on long output without a timing assertion", () => {
  const reads = spyOn(String.prototype, "charCodeAt");
  try {
    const work = (length: number) => {
      const input = `${"\x9d".repeat(length)}\x1b!`;
      reads.mockClear();
      const result = cleanCodeOutput(input);
      const count = reads.mock.calls.length;
      expect(result).toBe("!");
      // Includes the outer scan and OSC lookahead, not just successful matches.
      expect(count).toBeGreaterThan(length);
      expect(count).toBeLessThan(8 * input.length);
      return count;
    };
    const single = work(100_000);
    const double = work(200_000);
    expect(double).toBeGreaterThanOrEqual(single * 1.99);
    expect(double).toBeLessThanOrEqual(single * 2);
  } finally {
    reads.mockRestore();
  }
});

test("future entry kinds survive snapshot and live window accounting without becoming log entries", () => {
  const future = {
    kind: "future-step",
    id: "step-fixture",
    at: "2030-01-02T00:00:00.000Z",
    label: "Read document",
    icon: "file-text",
    description: "Read the document's text and positions.",
    status: "failed",
    startedAt: "2030-01-02T00:00:01.000Z",
    endedAt: "2030-01-02T00:00:02.000Z",
    message: "Document unavailable",
  };
  // Tolerant reads do not allow unsupported kinds into the raw submission path.
  expect(CodeOutputBatchSchema.safeParse({ seq: 1, entries: [future], droppedLines: 0, droppedBytes: 0 }).success).toBe(false);
  const known = line("recent");
  const window = CodeOutputWindowSchema.parse({ ...emptyCodeOutput(1), seq: 1, entries: [future, known] });
  expect(window.entries).toEqual([future, known]);
  expect(CodeOutputWindowSchema.parse(JSON.parse(JSON.stringify(window)))).toEqual(window);
  for (const status of ["pending", "running", "succeeded", "failed", "skipped"]) {
    const entry = { ...future, status };
    expect(CodeOutputWindowSchema.parse({ ...window, entries: [entry] }).entries).toEqual([entry]);
  }
  expect(window.entries.filter(isCodeOutputLogEntry)).toEqual([known]);
  const event = CodeOutputEventSchema.parse({
    ...window,
    type: "code.output",
    runId: "11111111-1111-4111-8111-111111111111",
    budget: 32768,
  });
  expect(applyCodeOutputEvent(emptyCodeOutput(), event)).toEqual(window);
  const budget = Buffer.byteLength(JSON.stringify([known]));
  const trimmed = appendCodeOutput(emptyCodeOutput(), window.entries, budget);
  expect(trimmed.entries).toEqual([known]);
  expect(trimmed.droppedLines).toBe(1);
  expect(trimmed.droppedBytes).toBe(Buffer.byteLength(JSON.stringify(future)));
  for (const invalid of [{ kind: "log" }, { ...known, id: "" }, { ...known, at: "not-a-date" }, { ...known, text: "raw" }]) {
    expect(CodeOutputWindowSchema.safeParse({ ...window, entries: [invalid] }).success).toBe(false);
  }
});

test("step revisions replace the same row in creation order in stored, live and replayed windows", () => {
  const pending = {
    kind: "step" as const,
    id: "1:step:1",
    at: "2030-01-02T00:00:00.000Z",
    status: "pending" as const,
    label: codeOutputParts("Read document"),
  };
  const second = { ...pending, id: "1:step:2", label: codeOutputParts("Save") };
  const running = { ...pending, status: "running" as const, startedAt: pending.at };
  const done = { ...running, status: "succeeded" as const, endedAt: pending.at, message: codeOutputParts("Done") };
  const budget = LIVE_LIMITS.frameBytes;
  let window = appendCodeOutput(emptyCodeOutput(1), [pending, line("between"), second], budget);
  const initial = window;
  window = appendCodeOutput(window, [running, done], budget);
  expect(window.entries).toEqual([done, line("between"), second]);
  expect(window.droppedLines).toBe(0);
  expect(CodeOutputWindowSchema.parse(window)).toEqual(window);
  const event: CodeOutputEvent = {
    ...window,
    seq: 2,
    type: "code.output",
    runId: "11111111-1111-4111-8111-111111111111",
    budget,
    entries: [running, done],
  };
  expect(applyCodeOutputEvent(initial, event)).toEqual({ ...window, seq: 2 });
  expect(window.entries.filter(isCodeOutputStepEntry)).toHaveLength(2);
});

test("incoming steps use bounded run-local ordinals and known sanitized fields", () => {
  const step = { kind: "step", id: 1, at: "2030-01-02T00:00:00.000Z", label: "Read", status: "pending" };
  const batch = (entry: unknown) => ({ seq: 1, entries: [entry], droppedLines: 0, droppedBytes: 0 });
  expect(CodeOutputBatchSchema.safeParse(batch(step)).success).toBe(true);
  for (const change of [
    { id: 0 },
    { id: CODE_OUTPUT_STEP_LIMITS.count + 1 },
    { id: "other-run" },
    { status: "unknown" },
    { label: "x".repeat(CODE_OUTPUT_STEP_LIMITS.textBytes) },
    { kind: "future" },
  ]) {
    expect(CodeOutputBatchSchema.safeParse(batch({ ...step, ...change })).success).toBe(false);
  }
});

test("retained steps keep creation order while more than a window of logs is displaced", () => {
  const step = (id: number): Extract<CodeOutputKnownEntry, { kind: "step" }> => ({
    kind: "step",
    id: `1:step:${id}`,
    at: line("").at,
    status: "pending",
    label: codeOutputParts(`Step ${id}`),
  });
  const first = step(1),
    second = step(2);
  let window = appendCodeOutput(emptyCodeOutput(1), [first, second], 32768);
  for (let index = 0; index < 100; index++) window = appendCodeOutput(window, [line(`${index}: ${"x".repeat(1000)}`)], 32768);
  expect(window.entries.filter(isCodeOutputStepEntry)).toEqual([first, second]);
  expect(window.droppedLines).toBeGreaterThan(0);
  const done = { ...first, status: "succeeded" as const, endedAt: first.at };
  window = appendCodeOutput(window, [done], 32768);
  expect(window.entries.filter(isCodeOutputStepEntry)).toEqual([done, second]);
  expect(Buffer.byteLength(JSON.stringify(window.entries))).toBeLessThanOrEqual(32768);
});

test("the complete canonical short-handle count fits the pinned window and live event", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const budget = codeOutputStepsBudget(runId, Number.MAX_SAFE_INTEGER, 32768);
  const step = { label: "Upload!", icon: "upload", description: "Transfer!", message: "Done!" };
  expect(CODE_OUTPUT_STEP_LIMITS.count * codeOutputStepBytes(step) + Buffer.byteLength("{}")).toBeLessThanOrEqual(budget);
  expect(codeOutputStepsBudget(runId, 1, 1024)).toBe(1024);
  const entry = {
    kind: "step",
    id: "1:step:1",
    at: "2030-01-02T00:00:00.000Z",
    label: codeOutputParts("Read"),
    status: "failed",
    reason: "run_ended",
    message: [],
  };
  expect(CodeOutputWindowSchema.parse({ ...emptyCodeOutput(1), entries: [entry] }).entries).toEqual([entry]);
  expect(CodeOutputWindowSchema.safeParse({ ...emptyCodeOutput(1), entries: [{ ...entry, reason: "future_reason" }] }).success).toBe(true);
  expect(
    CodeOutputBatchSchema.safeParse({
      seq: 1,
      entries: [{ ...entry, id: 1, label: "Read", message: "", reason: "run_ended" }],
      droppedLines: 0,
      droppedBytes: 0,
    }).success,
  ).toBe(false);
});

test.each(["ASCII", "é", "ह", "😀", "\ud800", "\udfff", '\u0000\n"\\'])(
  "canonical reservations measure JSON UTF-8 bytes for %j without encoding globals",
  (unit) => {
    const text = unit.repeat(CODE_OUTPUT_STEP_LIMITS.textReserveBytes + 1);
    const textCost = Buffer.byteLength(JSON.stringify(text)) - Buffer.byteLength(JSON.stringify(""));
    expect(codeOutputStepBytes({ label: text })).toBe(
      CODE_OUTPUT_STEP_LIMITS.metadataBytes + Math.max(0, textCost - CODE_OUTPUT_STEP_LIMITS.textReserveBytes),
    );
  },
);
