import { expect, test } from "bun:test";
import { memoryStore, type Provider, type ProviderRequest } from "@k2b/nessi";
import { AUTOMATION_TURN_BUDGET, createCodeAuthoringTurnBudget } from "./code-authoring-turn";
import { retryTransientProviderErrors } from "./provider-retry";
import { AiTurnInferenceLimit } from "./turn-failure";

const budget = (priorCalls = { calls: 0, inputTokens: 0 }) =>
  createCodeAuthoringTurnBudget({ priorCalls, finishedToolCalls: [], selected: false, nonPerson: true });
const consume = async (provider: Provider, request: ProviderRequest = { messages: [] }) => {
  for await (const _ of provider.stream(request)) {
    /* drain the provider */
  }
};
const fixture = (call: () => void): Provider => ({
  name: "fixture",
  model: "fixture",
  family: "openai-compatible",
  contextWindow: 128_000,
  capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
  async *stream() {
    call();
    yield { type: "usage", usage: { input: 100, output: 1, total: 101 } };
  },
});

test("automatic work is bounded from its first attempt without loading the authoring Skill", async () => {
  let calls = 0;
  const guard = budget();
  const provider = guard.wrap(fixture(() => calls++));
  for (let i = 0; i < AUTOMATION_TURN_BUDGET.modelCalls + 1; i++) await consume(provider);
  expect(calls).toBe(16);
  expect(guard.automationStopped()).toEqual({ reason: "model_calls" });
  expect(guard.stopped()).toBeNull();
});

test("worker recovery restores the turn-wide allowance; compaction and tool activity cannot refill it", async () => {
  let calls = 0;
  const guard = budget({ calls: 15, inputTokens: 1_000 });
  const base = fixture(() => calls++);
  await consume(guard.wrap(base, "compaction"));
  guard.noteToolCall({ name: "read_file", args: {}, status: "completed", result: "source" });
  await consume(guard.wrap(base));
  expect(calls).toBe(1);
  expect(guard.automationStopped()).toEqual({ reason: "model_calls" });
  // A compaction stop must never become a stored summary.
  let summaries = 0;
  await guard.compact(() => {
    summaries++;
    return null;
  })({ entries: [], store: memoryStore(), provider: base, usage: { input: 0, output: 0, total: 0 }, force: false });
  expect(summaries).toBe(0);
});

test("input admission covers instructions and schemas; higher reported input exhausts the same allowance", async () => {
  let calls = 0;
  const base = fixture(() => calls++);
  const oversized = budget();
  await consume(oversized.wrap(base), { messages: [], systemPrompt: "x".repeat(512_000 * 4) });
  expect(calls).toBe(0);
  expect(oversized.automationStopped()).toEqual({ reason: "input_tokens" });
  const guard = budget();
  await consume(
    guard.wrap({
      ...base,
      async *stream() {
        yield { type: "usage", usage: { input: 512_000, output: 1, total: 512_001 } };
      },
    }),
  );
  await consume(guard.wrap(base));
  expect(calls).toBe(0);
  expect(guard.automationStopped()).toEqual({ reason: "input_tokens" });
});

test("transient provider retries consume model attempts before dispatch, even when they return no usage", async () => {
  let calls = 0;
  const guard = budget({ calls: 15, inputTokens: 0 });
  const failing: Provider = {
    ...fixture(() => {}),
    async *stream() {
      calls++;
      yield { type: "issue", issue: { kind: "provider_error", message: "503 unavailable", retryable: true } };
    },
  };
  await consume(retryTransientProviderErrors(guard.wrap(failing), { deadline: null, delaysMs: [0] }));
  expect(calls).toBe(1);
  expect(guard.automationStopped()).toEqual({ reason: "model_calls" });
});

test("ordinary person turns retain their existing policy until authoring actually starts", async () => {
  let calls = 0;
  const guard = createCodeAuthoringTurnBudget({ priorCalls: { calls: 0, inputTokens: 0 }, finishedToolCalls: [], selected: false });
  for (let i = 0; i < 17; i++) await consume(guard.wrap(fixture(() => calls++)));
  expect(calls).toBe(17);
  expect(guard.automationStopped()).toBeNull();
});

test("automatic authoring retains its saved progress receipt under the same hard allocation", async () => {
  const guard = createCodeAuthoringTurnBudget({
    priorCalls: { calls: 16, inputTokens: 0 },
    finishedToolCalls: [],
    selected: true,
    nonPerson: true,
  });
  await consume(
    guard.wrap(
      fixture(() => {
        throw new Error("No extra call");
      }),
    ),
  );
  expect(guard.stopped()).toMatchObject({ reason: "model_calls", drafts: 0 });
  expect(guard.automationStopped()).toBeNull();
});

test("Code attempts without input usage consume an authoritative context window", async () => {
  let calls = 0;
  const guard = createCodeAuthoringTurnBudget({
    priorCalls: { calls: 0, inputTokens: 0 },
    finishedToolCalls: [],
    selected: false,
    nonPerson: true,
    inputTokenCeiling: 128000,
  });
  const base = {
    ...fixture(() => {}),
    async *stream() {
      calls++;
    },
  };
  for (let i = 0; i < 6; i++) await consume(guard.wrap(base));
  expect(calls).toBe(4);
  expect(guard.automationStopped()).toEqual({ reason: "input_tokens" });
});

test("tool inference exhausting the durable allowance still emits the visible local stop", async () => {
  for (const reason of ["model_calls", "input_tokens"] as const) {
    const guard = budget();
    const provider = guard.wrap({
      ...fixture(() => {}),
      async *stream() {
        throw new AiTurnInferenceLimit(reason);
      },
    });
    const events = await Array.fromAsync(provider.stream({ messages: [] }));
    expect(guard.automationStopped()).toEqual({ reason });
    expect(events.at(-1)).toMatchObject({ type: "block_end", block: { type: "text", text: "" } });
  }
});
