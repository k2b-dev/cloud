import { expect, test } from "bun:test";
import { LIVE_LIMITS } from "../events/live-engine";
import {
  appendCodeOutput,
  applyCodeOutputEvent,
  CodeOutputBatchSchema,
  CodeOutputWindowSchema,
  CodeOutputEventSchema,
  isCodeOutputLogEntry,
  type CodeOutputEvent,
  type CodeOutputKnownEntry,
  cleanCodeOutput,
  codeOutputParts,
  emptyCodeOutput,
} from "./output";

const line = (text: string): CodeOutputKnownEntry => ({ id: text, kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log", text: [{ type: "text", text }] });
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
  const batch = { seq: 1, entries: [{ kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log", text: "ok" }], droppedLines: 0, droppedBytes: 0 };
  expect(CodeOutputBatchSchema.safeParse(batch).success).toBe(true);
  expect(
    CodeOutputBatchSchema.safeParse({ ...batch, entries: [{ kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log", text: "😀".repeat(LIVE_LIMITS.frameBytes / 4) }] }).success,
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

test("future entry kinds survive snapshot and live window accounting without becoming log entries", () => {
  const future = {
    kind: "step",
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
  // Only log production is implemented today; tolerant reads do not grant a new
  // raw step submission path before its sanitization and lifecycle are added.
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
  const event = CodeOutputEventSchema.parse({ ...window, type: "code.output", runId: "11111111-1111-4111-8111-111111111111", budget: 32768 });
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
