import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { defineTool, type Message, memoryStore, nessi, type Provider, type ProviderRequest, type StoreEntry, toolToSpec } from "@k2b/nessi";
import { z } from "zod";
import authoringSkill from "../../../assistant/src/skills/code-authoring/SKILL.md" with { type: "text" };
import { codeChatSdkView } from "../../../core/src/code/chat-sdk";
import { createCodeAuthoringChatTools } from "../../../core/src/code/chat-tools";
import { capabilityToolInputSchema } from "../capabilities/calls";
import type { CapabilityDefinitions } from "../contracts/capabilities";
import { aiCapabilityInputSchema } from "./capabilities";
import {
  CODE_AUTHORING_TURN_BUDGET,
  codeAuthoringInputTokens,
  createCodeAuthoringTurnBudget,
  projectCodeAuthoringContext,
} from "./code-authoring-turn";
import { createCloudCompactFn } from "./compaction";
import { createDefaultCloudAiTools } from "./default-tools";
import { __aiExecutorTest, AiTurnExecutor } from "./executor";
import { renderPlaceAssistantContext } from "./place-prompt";
import { retryTransientProviderErrors } from "./provider-retry";
import { aiConversations } from "./store";
import * as structuredRuns from "./structured-runs";
import { composeAiSystemPrompt } from "./system-prompt";
import { prepareAiTools } from "./tools";
import type { AiTurnPolicyToolCall } from "./turn-policy";
import { applyAiTurnPolicy } from "./turn-policy";
import * as turnTiming from "./turn-timing";

const codeId = "c_0123456789ab";
const check = (name: string, result: unknown, args: unknown = { codeId }): AiTurnPolicyToolCall => ({
  name,
  args,
  result,
  status: "completed",
});
const budget = (input: Partial<Parameters<typeof createCodeAuthoringTurnBudget>[0]> = {}) =>
  createCodeAuthoringTurnBudget({
    priorCalls: { calls: 0, inputTokens: 0 },
    finishedToolCalls: [],
    selected: true,
    ...input,
  });
const consume = async (provider: Provider, request: ProviderRequest = { messages: [] }) => {
  const events = [];
  for await (const event of provider.stream(request)) events.push(event);
  return events;
};
const provider = (requests: ProviderRequest[], name = "code_test"): Provider => ({
  name: "fixture",
  model: "fixture",
  family: "openai-compatible",
  contextWindow: 128_000,
  capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
  async *stream(request) {
    requests.push(request);
    const id = `call-${requests.length}`;
    yield { type: "block_start", blockId: id, index: 0, kind: "tool_call", callId: id, name };
    yield { type: "block_end", blockId: id, index: 0, block: { type: "tool_call", id, name, args: { codeId } } };
    yield { type: "usage", usage: { input: 100, output: 10, total: 110 }, finishReason: "stop" };
  },
});

test("the executor ends a model that keeps changing failing fixtures, after two retries, with no pending work", async () => {
  const requests: ProviderRequest[] = [];
  const guard = budget({ selected: false });
  let executions = 0;
  const tool = defineTool({ name: "code_test", description: "Test the draft", inputSchema: z.object({ codeId: z.string() }) }).server(
    async () => {
      executions++;
      return {
        version: 1,
        ok: false,
        error: null,
        cases: [{ name: `changing title ${executions}`, runs: [{ error: "code_test_invalid_fixture" }] }],
      };
    },
  );
  const store = memoryStore();
  const policy = applyAiTurnPolicy({
    provider: retryTransientProviderErrors(guard.wrap(provider(requests)), { deadline: null, delaysMs: [] }),
    tools: [tool],
    maxToolRounds: 0,
    issuedToolRounds: 0,
    completedToolRounds: 0,
    runBudgetMs: null,
    deadline: null,
  });
  const loop = nessi({
    provider: policy.provider,
    input: "Create a weekly planning task.",
    systemPrompt: "Answer the request.",
    store,
    tools: async () => guard.tools(await policy.tools()),
    // A test backstop, so a regressed policy fails instead of hanging.
    maxTurns: 20,
  });
  const executor = new AiTurnExecutor({ leaseOwner: "worker", heartbeatMs: 1000, enqueueContinuation: async () => {} });
  executor["startHeartbeat"] = () => () => {};
  const pipeline = new __aiExecutorTest.StreamPipeline({
    conversationId: "chat",
    turnId: "turn",
    attempt: 1,
    startSeq: 0,
    leaseOwner: "worker",
    seedBlocks: [],
    allowRememberedApprovals: false,
  });
  pipeline.apply = async () => {};
  pipeline.flush = async () => {};
  pipeline.timing.event = async () => {};
  const timing = spyOn(turnTiming, "withDurableTurnTiming").mockImplementation(async (_turnId, aggregate) => aggregate);
  const aggregate = spyOn(aiConversations, "setLatestAssistantLoopAggregate").mockImplementation(async () => {});
  const started = spyOn((await import("./tool-audit")).aiToolAudit, "noteToolCall").mockResolvedValue(undefined);
  const running = spyOn((await import("./tool-audit")).aiToolAudit, "noteToolStarted").mockResolvedValue(undefined);
  const completed = spyOn((await import("./tool-audit")).aiToolAudit, "noteToolCompleted").mockResolvedValue(undefined);
  try {
    const outcome = await executor["driveChatLoop"]({
      loop,
      pipeline,
      initialRoundFailed: false,
      rejectedToolCallIds: new Set(),
      unavailablePlaceToolNames: new Set(),
      conversationId: "chat",
      turnId: "turn",
      abortController: new AbortController(),
      prepared: prepareAiTools({ tools: [] }),
      allowRememberedApprovals: false,
      rememberableCapabilityApprovals: new Map(),
      capabilityActionReviews: new Map(),
      approvalTargets: new Map(),
      linkedApprovals: new Map(),
      appliedSteers: [],
      noteToolRound: policy.noteToolRound,
      noteToolCall: (call) => {
        guard.noteToolCall(call);
        policy.noteToolCall(call);
      },
      failureReason: { current: null },
    });
    expect(outcome).toMatchObject({ kind: "finished", status: "completed", failure: null });
    expect(guard.stopped()).toMatchObject({ reason: "repeated_error", completedSteps: 0 });
    expect(executions).toBe(3);
    expect(requests).toHaveLength(3);
    const messages = (await store.load()).map((entry) => entry.message);
    expect(messages.filter((message) => message.role === "tool_result")).toHaveLength(3);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [],
    });
    expect(
      messages.some(
        (message, index) =>
          index === messages.length - 1 && message.role === "assistant" && message.content.some((part) => part.type === "tool_call"),
      ),
    ).toBe(false);
  } finally {
    for (const mock of [timing, aggregate, started, running, completed]) mock.mockRestore();
    loop.abort();
  }
});

test("model attempts and turn input each stop dispatch, including retries, missing usage and resumed turns", async () => {
  const requests: ProviderRequest[] = [];
  const base = provider(requests);
  const missing: Provider = {
    ...base,
    async *stream(request) {
      requests.push(request);
    },
  };
  const guard = budget();
  for (let i = 0; i < CODE_AUTHORING_TURN_BUDGET.modelCalls + 1; i++) await consume(guard.wrap(missing));
  expect(requests).toHaveLength(16);
  requests.length = 0;
  const resumed = budget({ priorCalls: { calls: 16, inputTokens: 500 } });
  expect(await consume(resumed.wrap(base))).toContainEqual(expect.objectContaining({ type: "block_end" }));
  const spent = budget({ priorCalls: { calls: 2, inputTokens: 512_000 } });
  await consume(spent.wrap(base));
  expect(await consume(spent.wrap(base, "compaction"))).toEqual([]);
  await consume(budget().wrap(base), { messages: [], systemPrompt: "a".repeat(512_000 * 4) });
  expect(requests).toHaveLength(0);
  const reported = budget();
  const largeUsage: Provider = {
    ...base,
    async *stream() {
      yield { type: "usage", usage: { input: 512_000, output: 1, total: 512_001 } };
    },
  };
  await consume(reported.wrap(largeUsage));
  await consume(reported.wrap(base));
  expect(requests).toHaveLength(0);
});

test("resumed test failures keep their identity across test/simulate and source edits", async () => {
  const requests: ProviderRequest[] = [];
  const guard = budget({
    finishedToolCalls: [
      check("code_test", { ok: false, error: "code_test_invalid_fixture" }, { codeId, tests: { "test/a.json": "v1" } }),
      check("code_simulate", { ok: false, cases: [{ runs: [{ error: "code_test_invalid_fixture" }] }] }, { codeId, fixture: {} }),
      check("code_write", { ok: true }),
      check("code_check", { result: { ok: true } }),
      check("code_test", { ok: false, error: "code_test_invalid_fixture" }, { codeId, tests: { "test/a.json": "v2" } }),
    ],
  });
  await consume(guard.wrap(provider(requests)));
  expect(requests).toHaveLength(0);
});

test("ordinary chats and one-off Code Mode keep their context and existing policy", async () => {
  const requests: ProviderRequest[] = [];
  const guard = budget({ selected: false, priorCalls: { calls: 100, inputTokens: 1_000_000 } });
  guard.tools(createCodeAuthoringChatTools().map((tool) => prepareAiTools({ tools: [tool] }).tools[0]!));
  const request = {
    messages: [],
    tools: [
      { name: "code_run", description: "Run once", inputSchema: {} },
      { name: "code_test", description: "Previously loaded", inputSchema: {} },
    ],
  };
  await consume(guard.wrap(provider(requests)), request);
  expect(requests).toEqual([request]);
});

test("a representative authoring loop pins per-step context and releases SDK evidence only after its own successful check", async () => {
  const modulePath = join(import.meta.dir, "../../../spaces/src/capabilities.ts");
  const { spacesCapabilities }: Record<string, CapabilityDefinitions> = await import(modulePath);
  const manifest = compileCapabilityManifest("spaces", spacesCapabilities!);
  const sdk = codeChatSdkView([manifest], { mode: "personal" }, ["spaces"]);
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "Create a task every Friday at 16:00 in the Logistics Space." }] },
  ];
  const add = (name: string, result: unknown, target = codeId) => {
    const id = String(messages.length);
    messages.push({ role: "assistant", content: [{ type: "tool_call", id, name, args: { codeId: target } }] });
    messages.push({ role: "tool_result", callId: id, name, result });
  };
  const systemPrompt = composeAiSystemPrompt({
    globalInstructions: "Help members manage work in their Cloud workspace.",
    memoryEnabled: true,
    memoryToolEnabled: true,
    memory: "The Logistics team prefers Friday afternoons for weekly planning. Use Europe/Berlin for schedules.",
    toolDiscoveryEnabled: true,
    appToolsEnabled: true,
    helpEnabled: true,
    turnInstructions: renderPlaceAssistantContext(
      { type: "spaces.space", id: "sp_0123456789ab" },
      { title: "Logistics", context: "Weekly planning for the Logistics team of 8 members.", tools: [], skills: [] },
      [],
    ),
    now: new Date("2026-11-14T12:00:00Z"),
    locale: "en",
    timeZone: "Europe/Berlin",
    interactive: true,
    loadedSkills: [{ name: "code-authoring", revision: 1, instructions: authoringSkill, files: [] }],
  });
  messages.unshift(
    { role: "user", content: [{ type: "text", text: "Which Space should our planning task use?" }] },
    { role: "assistant", content: [{ type: "text", text: "Use the Logistics Space for the Friday planning task." }] },
  );
  const sdkIndex = messages.length + 1;
  add("code_sdk", sdk);
  const unverified = structuredClone(messages);
  expect(projectCodeAuthoringContext(messages)).toEqual(unverified);
  add("code_check", { result: { ok: false } });
  expect(projectCodeAuthoringContext(messages)[sdkIndex]).toEqual(unverified[sdkIndex]);
  add("code_check", { result: { ok: true } }, "c_ffffffffffff");
  expect(projectCodeAuthoringContext(messages)[sdkIndex]).toEqual(unverified[sdkIndex]);
  add("code_write", { files: { "code.ts": "Saved source" } });
  add("code_check", { result: { ok: true } });
  const prepared = prepareAiTools({ tools: [...createDefaultCloudAiTools(), ...createCodeAuthoringChatTools()] }).tools;
  // Real installed-app operation schemas, alongside default and authoring tools.
  const appTools = [...manifest.queries, ...manifest.actions].slice(0, 8).map((operation) =>
    defineTool({
      name: `spaces_${operation.localId.replaceAll(".", "_")}`,
      description: operation.description,
      inputSchema: aiCapabilityInputSchema(capabilityToolInputSchema(operation)),
    }).server(async () => {
      throw new Error("No real app operations in the fixture");
    }),
  );
  const tools = [...prepared, ...appTools].map(toolToSpec);
  const before = codeAuthoringInputTokens({ messages, systemPrompt, tools });
  const projected = projectCodeAuthoringContext(messages);
  expect(projected[sdkIndex]).toMatchObject({ result: { note: expect.stringContaining("Call code_sdk again") } });
  expect(messages[sdkIndex]).toEqual(unverified[sdkIndex]);
  const requests: ProviderRequest[] = [];
  const guard = budget();
  const base = provider(requests);
  const store = memoryStore();
  for (const message of messages) await store.append(message);
  const success = {
    version: 1,
    mode: "test",
    ok: true,
    error: null,
    diagnostics: [],
    cases: [
      {
        name: "Friday task",
        file: "test/friday.json",
        ok: true,
        runs: [{ entrypoint: "tick", ok: true, error: null, value: null, calls: [], failures: [] }],
      },
    ],
  };
  const loop = nessi({
    systemPrompt,
    store,
    maxTurns: 9,
    provider: guard.wrap({
      ...base,
      async *stream(request) {
        if (requests.length < 7) yield* base.stream(request);
        else {
          requests.push(request);
          yield { type: "block_end", blockId: "done", index: 0, block: { type: "text", text: "The weekly task is ready for review." } };
        }
      },
    }),
    tools: guard.tools([
      ...prepared.map((tool) =>
        tool.kind === "server" && tool.def.name === "code_test" ? { ...tool, execute: async () => success } : tool,
      ),
      ...appTools,
    ]),
  });
  const issues = [];
  try {
    for await (const event of loop) if (event.type === "issue") issues.push(event);
  } finally {
    loop.abort();
  }
  expect(issues).toEqual([]);
  const estimates = requests.map(codeAuthoringInputTokens);
  expect(requests).toHaveLength(8);
  // Full real Spaces declarations and real authoring instructions, frozen runtime context.
  expect(Math.max(...estimates)).toBeLessThan(32_000);
  // Keep the original authoring-only ceiling as well as the fuller workload.
  expect(
    codeAuthoringInputTokens({
      messages: projected,
      systemPrompt,
      tools: prepareAiTools({ tools: createCodeAuthoringChatTools() }).tools.map(toolToSpec),
    }),
  ).toBeLessThan(16_000);
  expect(before - estimates[0]!).toBeGreaterThan(20_000);
  expect(JSON.stringify(sdk).length).toBeGreaterThan(90_000);
});

test("a batch cannot execute more identical failing checks than the retry budget, and executor notifications count once", async () => {
  const guard = budget();
  let executions = 0;
  const tool = defineTool({ name: "code_test", description: "Test", inputSchema: z.object({ codeId: z.string() }) }).server(async () => {
    executions++;
    return { ok: false, error: "code_test_invalid_fixture" };
  });
  const wrapped = guard.tools([tool])[0]!;
  if (wrapped.kind !== "server") throw new Error("Expected a server tool");
  for (let index = 0; index < 6; index++) {
    const args = { codeId };
    const callId = `batch-${index}`;
    const result = await wrapped.execute(args, {
      callId,
      signal: new AbortController().signal,
      requestApproval: async () => false,
      requestClientTool: async () => {
        throw new Error("No client tools");
      },
    });
    if (index >= 3) expect(result).toMatchObject({ version: 1, error: { code: "code_authoring_turn_limit", details: null } });
    guard.noteToolCall({ name: "code_test", args, callId, status: "completed", result });
  }
  expect(executions).toBe(3);
});

test("different diagnostics and assertion paths remain independent; identical structured errors stop", async () => {
  const requests: ProviderRequest[] = [];
  const guard = budget();
  for (const code of ["TS2345", "TS2339", "TS2322"]) {
    guard.noteToolCall(
      check("code_check", { result: { ok: false, diagnostics: [{ code, file: "code.ts", line: 4, column: 1, message: code }] } }),
    );
    guard.noteToolCall(
      check("code_test", { ok: false, error: "code_test_compile_failed", diagnostics: [{ code, file: "code.ts", line: 4 }] }),
    );
  }
  for (const path of ["calls.0.args.title", "calls.0.args.spaceId", "value.status"])
    guard.noteToolCall(
      check("code_simulate", {
        ok: false,
        error: null,
        cases: [{ file: "test/a.json", runs: [{ entrypoint: "tick", error: null, failures: [path] }] }],
      }),
    );
  await consume(guard.wrap(provider(requests)));
  expect(requests).toHaveLength(1);
  const failure = { version: 1, error: { code: "BAD_INPUT", message: "Invalid request", details: null } };
  for (let i = 0; i < 3; i++) guard.noteToolCall(check("code_test", failure));
  await consume(guard.wrap(provider(requests)));
  expect(requests).toHaveLength(1);
});

test("pending or rejected call IDs do not hide their eventual failure on recovery", async () => {
  const requests: ProviderRequest[] = [];
  const pending = { ...check("code_test", undefined), callId: "resumed", status: "running" as const };
  const guard = budget({ finishedToolCalls: [pending] });
  guard.noteToolCall({ ...pending, status: "rejected" });
  const result = { version: 1, error: { code: "BAD_INPUT" } };
  for (const callId of ["resumed", "second", "third"]) {
    const call = { ...check("code_test", result), callId };
    guard.noteToolCall(call);
    guard.noteToolCall(call);
  }
  await consume(guard.wrap(provider(requests)));
  expect(requests).toHaveLength(0);
});

test.each([1_000, 1_000_000])(
  "authoring continues with oversized prior history on a %i-token model, within its budget",
  async (contextWindow) => {
    const requests: ProviderRequest[] = [];
    await consume(budget().wrap(provider(requests)), {
      messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(70_000 * 4) }] }],
    });
    expect(requests).toHaveLength(1);
    let history: StoreEntry[] = [
      { seq: 1, kind: "message", message: { role: "user", content: [{ type: "text", text: "Earlier request ".repeat(70_000) }] } },
      { seq: 2, kind: "message", message: { role: "assistant", content: [{ type: "text", text: "Earlier answer ".repeat(70_000) }] } },
    ];
    const guard = budget({ priorCalls: { calls: 14, inputTokens: 100_000 } });
    let summaries = 0;
    let chats = 0;
    const base: Provider = {
      ...provider([]),
      contextWindow,
      async *stream() {
        chats++;
        yield { type: "block_end", blockId: "done", index: 0, block: { type: "text", text: "Continue planning." } };
      },
    };
    const summary: Provider = {
      ...base,
      async *stream(request) {
        summaries++;
        expect(codeAuthoringInputTokens(request)).toBeLessThan(CODE_AUTHORING_TURN_BUDGET.unknownInputTokens);
        yield { type: "block_end", blockId: "summary", index: 0, block: { type: "text", text: "The member is planning a Friday task." } };
      },
    };
    const compacted = spyOn(aiConversations, "compactMessages").mockImplementation(async ({ checkpointSeq, summary }) => {
      history = [{ seq: checkpointSeq, kind: "summary", message: summary }, ...history.filter((entry) => entry.seq > checkpointSeq)];
    });
    const recorded = spyOn(structuredRuns, "safelyRecordStructuredRun").mockResolvedValue(undefined);
    const loop = nessi({
      input: "Continue",
      systemPrompt: "Help with the planning task.",
      provider: guard.wrap(base),
      maxTurns: 3,
      store: {
        load: async () => history,
        append: async (message) => {
          history.push({ seq: history.at(-1)!.seq + 1, kind: "message", message });
        },
      },
      compact: guard.compact(
        createCloudCompactFn({
          conversationId: "chat",
          turnId: "turn",
          modelId: "fixture",
          providerType: "openai-compatible",
          provider: guard.wrap(summary, "compaction"),
          additionalInstructions: "",
          signal: new AbortController().signal,
        }),
      ),
    });
    try {
      for await (const _event of loop) {
      }
      expect(summaries).toBe(1);
      expect(chats).toBe(1);
      await consume(guard.wrap(base));
      expect(chats).toBe(1); // Summary + chat exhausted the two remaining attempts.
      expect(history.find((entry) => entry.kind === "summary")?.message).toMatchObject({
        content: [{ type: "text", text: "Conversation summary:\nThe member is planning a Friday task." }],
      });
    } finally {
      compacted.mockRestore();
      recorded.mockRestore();
      loop.abort();
    }
  },
);

test("provider retries use the final available attempt and stop before another dispatch", async () => {
  let attempts = 0;
  const guard = budget({ priorCalls: { calls: 15, inputTokens: 0 } });
  const failing: Provider = {
    ...provider([]),
    async *stream() {
      attempts++;
      yield { type: "issue", issue: { kind: "provider_error", message: "Unavailable", retryable: true } };
    },
  };
  const events = await consume(retryTransientProviderErrors(guard.wrap(failing), { deadline: null, delaysMs: [0, 0] }));
  expect(attempts).toBe(1);
  expect(events.at(-1)).toMatchObject({ type: "block_end", block: { type: "text", text: "" } });
});

test("passed expected-error runs in a mixed fixture do not spend the repair allowance", async () => {
  const requests: ProviderRequest[] = [];
  const guard = budget();
  for (const path of ["value.a", "value.b", "value.c"])
    guard.noteToolCall(
      check("code_test", {
        ok: false,
        error: null,
        cases: [
          {
            file: "test/a.json",
            runs: [
              { entrypoint: "tick", ok: true, error: "expected_error", failures: [] },
              { entrypoint: "tick", ok: false, error: null, failures: [path] },
            ],
          },
        ],
      }),
    );
  await consume(guard.wrap(provider(requests)));
  expect(requests).toHaveLength(1);
});

test("identical failed tool validation text is bounded without merging different errors", async () => {
  const requests: ProviderRequest[] = [];
  const guard = budget();
  for (const result of ["Invalid input at fixture.a", "Invalid input at fixture.b", "Invalid input at fixture.c"])
    guard.noteToolCall({ ...check("code_test", result), status: "failed" });
  await consume(guard.wrap(provider(requests)));
  expect(requests).toHaveLength(1);
  for (let i = 0; i < 3; i++) {
    const callId = `validation-${i}`;
    guard.noteToolCall({ ...check("code_test", { ok: true }), callId });
    const failed = { ...check("code_test", "Invalid input at fixture.d"), status: "failed" as const, callId };
    guard.noteToolCall(failed);
    guard.noteToolCall(failed);
  }
  await consume(guard.wrap(provider(requests)));
  expect(requests).toHaveLength(1);
});

test("stop receipts invalidate earlier checks after edits and final validation supersedes provisional success", async () => {
  const guard = budget({ priorCalls: { calls: 16, inputTokens: 100 } });
  guard.noteToolCall({ ...check("code_write", { version: 1, draft: { codeId } }), callId: "write" });
  guard.noteToolCall({ ...check("code_check", { result: { ok: true } }), callId: "check" });
  guard.noteToolCall({ ...check("code_test", { ok: true }), callId: "test" });
  guard.noteToolCall({ ...check("code_write", { version: 1, draft: { codeId } }), callId: "edit" });
  guard.noteToolCall({ ...check("code_check", { result: { ok: true } }), callId: "invalid" });
  guard.noteToolCall({ ...check("code_check", "Invalid tool result"), status: "failed", callId: "invalid" });
  await consume(guard.wrap(provider([])));
  expect(guard.stopped()).toEqual({ reason: "model_calls", completedSteps: 4, drafts: 1, unchecked: 1, untested: 1, unsubmitted: 1 });
});

test("continuation receipts confirm an existing draft without a new read or write", async () => {
  const guard = budget({ priorCalls: { calls: 16, inputTokens: 100 } });
  guard.noteToolCall(check("code_check", { version: 1, result: { ok: true } }));
  guard.noteToolCall(check("code_test", { version: 1, ok: false, error: "code_test_invalid_fixture" }, { codeId, tests: {} }));
  await consume(guard.wrap(provider([])));
  expect(guard.stopped()).toEqual({ reason: "model_calls", completedSteps: 1, drafts: 1, unchecked: 1, untested: 1, unsubmitted: 1 });
});

test("failed or skipped writes preserve confirmed draft checks", async () => {
  const guard = budget({ priorCalls: { calls: 16, inputTokens: 100 } });
  guard.noteToolCall(check("code_check", { version: 1, result: { ok: true } }));
  guard.noteToolCall(check("code_test", { version: 1, ok: true }));
  for (const code of ["BAD_INPUT", "code_authoring_turn_limit"]) guard.noteToolCall(check("code_write", { version: 1, error: { code } }));
  await consume(guard.wrap(provider([])));
  expect(guard.stopped()).toEqual({ reason: "model_calls", completedSteps: 2, drafts: 1, unchecked: 0, untested: 0, unsubmitted: 1 });
});

test("a continuation that submits an existing draft reports no unfinished validation", async () => {
  const guard = budget({ priorCalls: { calls: 16, inputTokens: 100 } });
  guard.noteToolCall(check("code_submit", { version: 1, submission: { version: { id: "saved" } } }));
  await consume(guard.wrap(provider([])));
  expect(guard.stopped()).toEqual({ reason: "model_calls", completedSteps: 1, drafts: 1, unchecked: 0, untested: 0, unsubmitted: 0 });
});

test("the authoring loop persists a structured stop after two identical repair retries", async () => {
  const { createStoppedAuthoringFixture } = await import("./code-authoring-stop.fixtures");
  const { messages, calls, state } = await createStoppedAuthoringFixture();
  expect(calls).toBe(3);
  expect(state).toEqual({ reason: "repeated_error", completedSteps: 2, drafts: 1, unchecked: 0, untested: 1, unsubmitted: 1 });
  expect(messages.at(-1)?.meta?.codeAuthoringStop).toEqual(state!);
  expect(messages.at(-1)?.message).toMatchObject({ role: "assistant", content: [] });
});
