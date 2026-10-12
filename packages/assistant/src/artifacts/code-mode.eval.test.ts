import { expect, test } from "bun:test";
import { defineTool, memoryStore, nessi, type Provider, type TextBlock, type ToolCallBlock } from "@k2b/nessi";
import { z } from "zod";
import {
  collectStudioLoop,
  type StudioEvalResult,
  studioEvalFailure,
  studioEvalMetrics,
  studioEvalRoute,
  studioEvalSummary,
} from "./code-mode.eval";

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
    route: "studio-app",
    routeMatches: true,
    modelTurns: 5,
    modelMs: 80_000,
    toolMs: 35_000,
    toolCalls: 12,
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
  expect(summary).toContain(
    "| contacts | studio-app | – | – | – | – | – | – | – | – | – | not measured: Agent loop ended: error: 502 \\| Bad Gateway |",
  );
  expect(summary).toContain(
    "| Case | Expected | Route | Match | Minutes | Model turns | Model s | Tool s | Tool calls | Checks | First check passed | Presented without correction |",
  );
  expect(summary).toContain("| todo | studio-app | studio-app | yes | 2.0 | 5 | 80.0 | 35.0 | 12 | 0 | yes | yes |");
  expect(summary).toContain("Route matches: 1/1 overall. App cases: 1/1. View cases: 0/0.");
  expect(summary).toContain("First check passed: 1/1. Presented without a correction round: 1/1. Presented at all: 1/1.");
  expect(summary).toContain("Not measured, because the case failed or ended before the model finished: contacts.");
});

test("routes distinguish saved apps, chat apps, views and no presentation", () => {
  const call = (name: string, args: unknown = {}, isError = false, result: unknown = {}) => ({ name, args, isError, result });
  const chat = call("code_present", { files: [{ path: "index.html", content: "" }] });
  expect(studioEvalRoute([call("code_open", { id: "app" }, false, { opened: "app", started: false })])).toBe("studio-app");
  expect(studioEvalRoute([present("app")])).toBe("studio-app");
  expect(studioEvalRoute([chat])).toBe("chat-app");
  for (const view of [call("present", { path: "/views/revenue.view.json" }), call("chart"), call("card")]) {
    expect(studioEvalRoute([view])).toBe("view");
    expect(studioEvalRoute([view, chat])).toBe("chat-app");
    expect(studioEvalRoute([view, chat, present("app")])).toBe("studio-app");
  }
  expect(studioEvalRoute([chat, call("code_open")])).toBe("studio-app");
  expect(studioEvalRoute([chat, present("app")])).toBe("studio-app");
  expect(studioEvalRoute([present("app"), chat])).toBe("studio-app");
  expect(studioEvalRoute([])).toBe("none");
  expect(studioEvalRoute([call("code_create"), call("present", { path: "/report.pdf" })])).toBe("none");
  expect(studioEvalRoute([call("present", { path: "/views-other/file" })])).toBe("none");
  for (const failed of [
    call("code_open", {}, true),
    call("code_present", { id: "app" }, true),
    call("code_present", chat.args, true),
    call("present", { path: "/views/revenue.view.json" }, true),
    call("chart", {}, true),
    call("card", {}, true),
    call("code_open", {}, false, { failed: true, error: "Check required" }),
  ]) {
    expect(studioEvalRoute([failed])).toBe("none");
  }
});

test("route totals separate app and view cases and exclude unmeasured cases", () => {
  const base = { ...studioEvalFailure("calculator-de", "unused"), error: undefined };
  const summary = studioEvalSummary([
    { ...base, route: "studio-app", routeMatches: true },
    { ...base, name: "calculator-en", locale: "en", route: "chat-app", routeMatches: false },
    { ...base, name: "sales-chart-de", expect: "view", route: "view", routeMatches: true },
    { ...base, name: "top-customers-en", expect: "view", route: "none", routeMatches: false },
    studioEvalFailure("sales-chart-en", "timeout", { locale: "en", expect: "view" }),
  ]);
  expect(summary).toContain("Route matches: 2/4 overall. App cases: 1/2. View cases: 1/2.");
});

test("turn timings retain call arguments, results, duration and errors", async () => {
  let turn = 0;
  const result = await loop(
    scripted(() => (turn++ === 0 ? { type: "tool_call", id: "call", name: "noop", args: {} } : { type: "text", text: "Done" })),
  );
  expect(result.modelTurns).toBe(2);
  expect(result.turns.map((turn) => turn.index)).toEqual([0, 1]);
  expect(result.turns[0]?.toolCalls).toEqual([expect.objectContaining({ name: "noop", args: {}, result: "ok", isError: false })]);
  expect(result.turns[1]?.toolCalls).toEqual([]);
  expect(result.modelMs).toBeGreaterThanOrEqual(0);
  expect(result.toolMs).toBeGreaterThanOrEqual(0);
  for (const turn of result.turns) {
    expect(turn.modelMs).toBeGreaterThanOrEqual(0);
    expect(turn.elapsedMs).toBeGreaterThanOrEqual(turn.modelMs);
    for (const call of turn.toolCalls) expect(call.elapsedMs).toBeGreaterThanOrEqual(0);
  }
});

test("approval requests fail the case and retain the requested call", async () => {
  const gated = defineTool({ name: "gated", description: "Needs approval", inputSchema: z.object({}), needsApproval: true }).server(
    async () => {
      throw new Error("Must not run");
    },
  );
  const result = await collectStudioLoop(
    nessi({
      provider: scripted(() => ({ type: "tool_call", id: "approval", name: "gated", args: {} })),
      systemPrompt: "",
      input: "Run it",
      tools: [gated],
      store: memoryStore(),
    }),
    "approval",
  );
  expect(result.error).toBe("This evaluation cannot answer approval requests (gated)");
  expect(result.calls).toEqual([expect.objectContaining({ name: "gated", args: {}, isError: true })]);
  expect(result.turns[0]?.toolCalls).toEqual(result.calls);
});

test("failed tools stay in the turn timing report", async () => {
  let turn = 0;
  const failing = defineTool({ name: "failing", description: "Cannot answer", inputSchema: z.object({}) }).server(async () => {
    throw new Error("survey is not answerable in this evaluation");
  });
  const result = await collectStudioLoop(
    nessi({
      provider: scripted(() =>
        turn++ === 0 ? { type: "tool_call", id: "failure", name: "failing", args: {} } : { type: "text", text: "Done" },
      ),
      systemPrompt: "",
      input: "Run it",
      tools: [failing],
      store: memoryStore(),
    }),
    "failure",
  );
  expect(result.error).toBeUndefined();
  expect(result.turns[0]?.toolCalls).toEqual([expect.objectContaining({ name: "failing", isError: true })]);
  expect(result.calls[0]?.result).toContain("not answerable in this evaluation");
});
