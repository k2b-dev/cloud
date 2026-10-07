import { describe, expect, test } from "bun:test";
import type { Provider, Tool } from "@k2b/nessi";
import { type AiTurnPolicyDecision, applyAiTurnPolicy } from "./turn-policy";

const tool = {} as Tool;
const request = { systemPrompt: "Base prompt", messages: [] };

const recordingProvider = (prompts: (string | undefined)[]): Provider => ({
  name: "test",
  family: "openai-compatible",
  model: "test",
  capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: false },
  complete: async () => {
    throw new Error("not used");
  },
  stream: async function* (input) {
    prompts.push(input.systemPrompt);
    yield { type: "block_end", blockId: "call", index: 0, block: { type: "tool_call", id: "call", name: "test", args: {} } };
  },
});

/** One model call as nessi makes it: resolve the tools, then stream. */
const modelCall = async (policy: ReturnType<typeof applyAiTurnPolicy>, prompts: (string | undefined)[]) => {
  const tools = await policy.tools();
  for await (const _event of policy.provider.stream(request)) {
    // consume the call
  }
  return { tools, prompt: prompts.at(-1) ?? "" };
};

const setup = (options: Partial<Parameters<typeof applyAiTurnPolicy>[0]> = {}) => {
  const prompts: (string | undefined)[] = [];
  const decisions: AiTurnPolicyDecision[] = [];
  const policy = applyAiTurnPolicy({
    provider: recordingProvider(prompts),
    tools: [tool],
    issuedToolRounds: 0,
    completedToolRounds: 0,
    deadline: null,
    runBudgetMs: null,
    onDecision: (decision) => decisions.push(decision),
    ...options,
  });
  return { policy, prompts, decisions, call: () => modelCall(policy, prompts) };
};

const failed = (name: string, args: unknown = { path: "/missing.csv" }) => ({ name, args, status: "failed" as const });
const completed = (name: string, args: unknown = {}) => ({ name, args, status: "completed" as const });

describe("tool round limit", () => {
  test("leaves the tools and the prompt unchanged by default", async () => {
    const { policy, call } = setup();

    expect(policy.maxTurns).toBeUndefined();
    expect(await call()).toEqual({ tools: [tool], prompt: "Base prompt" });
  });

  test("reserves one tool-free provider call for the final answer", async () => {
    const { policy, call } = setup({ maxToolRounds: 1 });

    expect(policy.maxTurns).toBe(2);
    expect((await call()).tools).toEqual([tool]);
    policy.noteToolRound();
    const final = await call();
    expect(final.tools).toEqual([]);
    expect(final.prompt).toContain("tool-round budget has been reached, so no more tools are available");
    expect(final.prompt).toContain("best result supported by the evidence already gathered");
  });

  test("counts persisted tool rounds across resumed workers", async () => {
    const { policy, call } = setup({ maxToolRounds: 2, issuedToolRounds: 2, completedToolRounds: 2 });

    expect(policy.maxTurns).toBe(1);
    const final = await call();
    expect(final.tools).toEqual([]);
    expect(final.prompt).toContain("no more tools are available");
  });

  test("keeps a pending last-round tool available until its resumed execution completes", async () => {
    const { policy } = setup({ maxToolRounds: 1, issuedToolRounds: 1, completedToolRounds: 0 });

    expect(policy.maxTurns).toBe(1);
    expect(await policy.tools()).toEqual([tool]);
    policy.noteToolRound();
    expect(await policy.tools()).toEqual([]);
  });
});

describe("repeated failures", () => {
  test("hint once after the same call failed twice, then end tool use when it fails again", async () => {
    const { policy, call, decisions } = setup();

    await call();
    policy.noteToolCall(failed("read_file"));
    expect((await call()).prompt).toBe("Base prompt");
    policy.noteToolCall(failed("read_file", { path: "/missing.csv" }));
    const hinted = await call();
    expect(hinted.tools).toEqual([tool]);
    expect(hinted.prompt).toContain("# Turn check");
    expect(hinted.prompt).toContain("These calls failed twice with the same input: read_file.");
    expect((await call()).prompt).toBe("Base prompt");

    policy.noteToolCall(failed("read_file"));
    const final = await call();
    expect(final.tools).toEqual([]);
    expect(final.prompt).toContain("kept repeating steps that made no progress");
    expect(final.prompt).toContain("Say what blocked you");
    expect(final.prompt).not.toContain("# Turn check");
    expect(decisions).toEqual([
      { kind: "hint", hints: ["repeated_failure"] },
      { kind: "final_answer", reason: "loop" },
    ]);
  });

  test("compares inputs regardless of key order and ignores other inputs and rejected approvals", async () => {
    const { policy, call, decisions } = setup();

    policy.noteToolCall(failed("mail.send", { to: "jana@example.test", subject: "Offer" }));
    policy.noteToolCall(failed("mail.send", { to: "tom@example.test", subject: "Offer" }));
    policy.noteToolCall({ name: "mail.send", args: { subject: "Offer", to: "jana@example.test" }, status: "rejected" });
    expect((await call()).prompt).toBe("Base prompt");

    policy.noteToolCall(failed("mail.send", { subject: "Offer", to: "jana@example.test" }));
    expect((await call()).prompt).toContain("failed twice with the same input: mail.send");
    expect(decisions).toEqual([{ kind: "hint", hints: ["repeated_failure"] }]);
  });

  test("calls a resumed attempt already finished count, but give no hint by themselves", async () => {
    const { policy, call } = setup({ finishedToolCalls: [failed("read_file"), failed("read_file")] });

    expect((await call()).prompt).toBe("Base prompt");
    policy.noteToolCall(failed("read_file"));
    expect((await call()).prompt).toContain("failed twice with the same input: read_file");
  });
});

describe("discovery loops", () => {
  const discover = (policy: ReturnType<typeof applyAiTurnPolicy>, count: number) => {
    for (let index = 0; index < count; index += 1)
      policy.noteToolCall(completed(index % 2 === 0 ? "search_tools" : "load_tools", { query: `try ${index}` }));
  };

  test("hint after six discovery calls without a completed working step", async () => {
    const { policy, call } = setup();

    discover(policy, 5);
    policy.noteToolCall(failed("guessed_tool"));
    expect((await call()).prompt).toBe("Base prompt");
    discover(policy, 1);
    const hinted = await call();
    expect(hinted.tools).toEqual([tool]);
    expect(hinted.prompt).toContain("You searched for or loaded tools 6 times in a row without completing another step.");
  });

  test("a completed working step starts the count again", async () => {
    const { policy, call } = setup();

    discover(policy, 5);
    policy.noteToolCall(completed("calculate"));
    discover(policy, 5);
    expect((await call()).prompt).toBe("Base prompt");
  });

  test("end tool use when the search goes on after the hint, but not for a failed attempt to work", async () => {
    const { policy, call } = setup();

    discover(policy, 6);
    expect((await call()).prompt).toContain("Stop searching.");
    policy.noteToolCall(failed("mail.list", { limit: 500 }));
    expect((await call()).tools).toEqual([tool]);
    discover(policy, 1);
    const final = await call();
    expect(final.tools).toEqual([]);
    expect(final.prompt).toContain("kept repeating steps that made no progress");
  });

  test("both hints share one model call", async () => {
    const { policy, call, decisions } = setup();

    discover(policy, 6);
    policy.noteToolCall(failed("load_tools", { names: ["mail.send"] }));
    policy.noteToolCall(failed("load_tools", { names: ["mail.send"] }));
    const prompt = (await call()).prompt ?? "";
    expect(prompt).toContain("failed twice with the same input: load_tools");
    expect(prompt).toContain("loaded tools 8 times in a row");
    expect(decisions).toEqual([{ kind: "hint", hints: ["repeated_failure", "discovery_loop"] }]);
  });
});

describe("run time limit", () => {
  const runBudgetMs = 30 * 60_000;

  test("answer without tools in the last tenth of the run time", async () => {
    let now = 0;
    const { call, decisions } = setup({ deadline: runBudgetMs, runBudgetMs, now: () => now });

    now = 26 * 60_000;
    expect(await call()).toEqual({ tools: [tool], prompt: "Base prompt" });
    now = 27 * 60_000;
    const final = await call();
    expect(final.tools).toEqual([]);
    expect(final.prompt).toContain("The run time limit of this turn is almost reached");
    expect(final.prompt).toContain("the user can continue the task with a new message");
    now = 20 * 60_000;
    expect((await call()).tools).toEqual([]);
    expect(decisions).toEqual([{ kind: "final_answer", reason: "run_time" }]);
  });

  test("a resumed round finishes its pending tools before the final answer", async () => {
    const { policy } = setup({ deadline: runBudgetMs, runBudgetMs, now: () => runBudgetMs - 1, issuedToolRounds: 1 });

    expect(await policy.tools()).toEqual([tool]);
    policy.noteToolRound();
    expect(await policy.tools()).toEqual([]);
  });

  test("a turn without a run time limit keeps its tools", async () => {
    const { call } = setup({ deadline: null, runBudgetMs: 0, now: () => Number.MAX_SAFE_INTEGER });

    expect((await call()).tools).toEqual([tool]);
  });
});
