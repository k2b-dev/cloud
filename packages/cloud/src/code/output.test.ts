import { expect, test } from "bun:test";
import { LIVE_LIMITS } from "../events/live-engine";
import {
  appendCodeOutput,
  applyCodeOutputEvent,
  CodeOutputBatchSchema,
  type CodeOutputEvent,
  type CodeOutputLine,
  cleanCodeOutput,
  codeOutputParts,
  emptyCodeOutput,
} from "./output";

const line = (text: string): CodeOutputLine => ({ level: "log", parts: [{ type: "text", text }] });
test("the same whole-line tail and loss counters apply on Core, replay and browser", () => {
  const lines = [line("first"), line("second"), line("third")];
  const budget = new TextEncoder().encode(JSON.stringify(lines.slice(1))).length;
  const stored = appendCodeOutput({ ...emptyCodeOutput(1), seq: 1 }, lines, budget, { lines: 2, bytes: 10 });
  const event: CodeOutputEvent = { ...stored, lines, type: "code.output", runId: "11111111-1111-4111-8111-111111111111", budget };
  expect(stored.lines).toEqual(lines.slice(1));
  expect(stored.droppedLines).toBe(3);
  expect(stored.droppedBytes).toBeGreaterThan(10);
  const replay = applyCodeOutputEvent(emptyCodeOutput(), event);
  expect(replay).toEqual(stored);
  expect(applyCodeOutputEvent(replay, event)).toEqual(stored);
  expect(applyCodeOutputEvent(replay, { ...event, generation: 0, seq: 8 })).toEqual(stored);
  expect(applyCodeOutputEvent(replay, { ...event, generation: 2, seq: 1 })).toEqual({ ...stored, generation: 2 });
});
test("input messages use the actual live frame limit, including JSON escaping and UTF-8", () => {
  const batch = { seq: 1, lines: [{ level: "log", text: "ok" }], droppedLines: 0, droppedBytes: 0 };
  expect(CodeOutputBatchSchema.safeParse(batch).success).toBe(true);
  expect(
    CodeOutputBatchSchema.safeParse({ ...batch, lines: [{ level: "log", text: "😀".repeat(LIVE_LIMITS.frameBytes / 4) }] }).success,
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
