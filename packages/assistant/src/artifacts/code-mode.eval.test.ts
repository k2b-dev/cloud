import { expect, test } from "bun:test";
import { defineTool, memoryStore, nessi, type Provider, type TextBlock, type ToolCallBlock } from "@k2b/nessi";
import { z } from "zod";
import { collectStudioLoop, type StudioEvalResult, studioEvalFailure, studioEvalMetrics, studioEvalSummary } from "./code-mode.eval";

/** Streams each answer the way the evaluation provider does; a throwing answer is a failed provider request. */
const scripted = (answer: () => TextBlock | ToolCallBlock): Provider => ({
  name: "fixture",
  family: "openai-compatible",
  model: "fixture",
  capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
  async complete() {
    throw new Error("Unexpected completion");
  },
  async *stream() {
    const block = answer();
    yield block.type === "text"
      ? { type: "block_start", blockId: "b", index: 0, kind: "text" }
      : { type: "block_start", blockId: "b", index: 0, kind: "tool_call", callId: block.id, name: block.name };
    yield { type: "block_end", blockId: "b", index: 0, block };
    yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: block.type === "text" ? "stop" : "tool_use" };
  },
});
const noop = defineTool({ name: "noop", description: "Does nothing.", inputSchema: z.object({}) }).server(async () => "ok");
const loop = (provider: Provider, options: { maxTurns?: number; signal?: AbortSignal } = {}) =>
  collectStudioLoop(nessi({ provider, systemPrompt: "", input: "Build it", tools: [noop], store: memoryStore(), ...options }), "fixture");

test("a case counts as measured only when the model ends the loop itself", async () => {
  expect((await loop(scripted(() => ({ type: "text", text: "Fertig." })))).error).toBeUndefined();

  const failed = await loop(
    scripted(() => {
      throw new Error("Evaluation provider failed: 502 Bad Gateway");
    }),
  );
  expect(failed.error).toBe("Agent loop ended: error: Evaluation provider failed: 502 Bad Gateway");
  expect(failed.issues).toContainEqual(expect.objectContaining({ message: "Evaluation provider failed: 502 Bad Gateway" }));

  const limited = await loop(
    scripted(() => ({ type: "tool_call", id: crypto.randomUUID(), name: "noop", args: {} })),
    { maxTurns: 1 },
  );
  expect(limited.error).toBe("Agent loop ended: max_turns");
  expect(limited.calls).toEqual([expect.objectContaining({ name: "noop", isError: false })]);

  const aborted = await loop(
    scripted(() => ({ type: "text", text: "Fertig." })),
    { signal: AbortSignal.abort() },
  );
  expect(aborted.error).toBe("Agent loop ended: aborted");
});

const check = (id: string, result: unknown, isError = false) => ({ name: "code_check", isError, args: { id }, result });
const passed = (hash: string) => ({ passed: true, hash });
const present = (id: string) => ({ name: "code_present", isError: false, args: { id }, result: { userVisible: true } });

test("only checks of the presented app count, and a failed check call checks no version", () => {
  // A lost host is not a failed first check; a passing helper app does not stand in for the presented one.
  expect(studioEvalMetrics([check("app", "Evaluation host lost; no replay", true), check("app", passed("a")), present("app")])).toEqual({
    failedCheckCalls: 1,
    firstCheckPassed: true,
    presented: true,
    correctionRounds: 0,
    presentedWithoutCorrection: true,
  });
  expect(
    studioEvalMetrics([
      check("helper", passed("h")),
      check("app", { passed: false, hash: "a" }),
      check("app", passed("b")),
      check("app", passed("b")),
      present("app"),
      check("app", passed("c")),
    ]),
  ).toMatchObject({ firstCheckPassed: false, correctionRounds: 1, presentedWithoutCorrection: false });
  // An invalid steps.json is rejected without a hash; the agent had to change the app before it passed.
  expect(
    studioEvalMetrics([check("app", { error: "Invalid steps.json", failed: true }), check("app", passed("a")), present("app")]),
  ).toMatchObject({ failedCheckCalls: 0, firstCheckPassed: false, correctionRounds: 1 });
  expect(studioEvalMetrics([check("app", passed("a"))])).toMatchObject({
    presented: false,
    correctionRounds: null,
    presentedWithoutCorrection: false,
  });
});

test("the summary names the run and leaves unmeasured cases out of the totals", () => {
  const measured: StudioEvalResult = {
    ...studioEvalFailure("todo", "unused"),
    reasoningEffort: "medium",
    commit: "03d1046d4",
    startedAt: "2026-10-08T13:11:00.000Z",
    elapsedMs: 120_000,
    presented: true,
    firstCheckPassed: true,
    correctionRounds: 0,
    presentedWithoutCorrection: true,
    error: undefined,
  };
  const unmeasured = {
    ...studioEvalFailure("contacts", new Error("Agent loop ended: error: 502 | Bad\nGateway")),
    startedAt: "2026-10-08T13:12:00.000Z",
  };
  const summary = studioEvalSummary([measured, unmeasured]);
  expect(summary).toContain("reasoning effort: medium · commit: 03d1046d4 · started: 2026-10-08T13:11:00.000Z");
  expect(summary).toContain("| contacts | – | – | not measured: Agent loop ended: error: 502 \\| Bad Gateway |");
  expect(summary).toContain("First check passed: 1/1. Presented without a correction round: 1/1. Presented at all: 1/1.");
  expect(summary).toContain("Not measured, because the case failed or ended before the model finished: contacts.");
});
