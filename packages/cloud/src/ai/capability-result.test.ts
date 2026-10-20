import { expect, test } from "bun:test";
import { defineTool, type Message, nessi, type Provider, type ProviderRequest, type StoreEntry } from "@k2b/nessi";
import { z } from "zod";
import type { AiActionCheck } from "./action-review";
import { aiCapabilityCheckResult, projectSettledAiToolChecks } from "./capability-result";

const call: Message = {
  role: "assistant",
  content: [{ type: "tool_call", id: "send", name: "demo__action__send", args: {} }],
};
const unknown: Message = {
  role: "tool_result",
  callId: "send",
  name: "demo__action__send",
  result: "ACTION_OUTCOME_UNKNOWN: Do not retry the Action.",
  isError: true,
};
const receipt = { text: "Saved" };
const entries = (check?: AiActionCheck, result: Message | null = unknown) => [
  { seq: 1, kind: "message" as const, message: call, meta: { toolChecks: check ? { send: check } : undefined } },
  ...(result ? [{ seq: 2, kind: "message" as const, message: result }] : []),
];

test.each(["done", "not_done"] as const)("projects a settled %s result with the executor's no-retry instructions", (state) => {
  const check = { state, receipt };
  const rows = entries(check);
  const before = structuredClone(rows);
  const projected = projectSettledAiToolChecks(rows);
  expect(projected[0]?.message).toBe(call);
  expect(projected[1]?.message).toMatchObject({ role: "tool_result", callId: "send", isError: state !== "done" });
  if (state === "done") expect(projected[1]?.message).toMatchObject({ result: aiCapabilityCheckResult(check) });
  else
    expect(projected[1]?.message).toMatchObject({
      result: "ACTION_NOT_DONE: The app's check confirmed nothing happened. Ask the person before trying again.",
    });
  expect(JSON.stringify(projected)).toContain(state === "done" ? "Do not run it again." : "Ask the person before trying again.");
  expect(rows).toEqual(before);
  expect(projectSettledAiToolChecks(projected.map((row, i) => ({ ...row, meta: rows[i]?.meta })))[1]?.message).toBe(projected[1]?.message);
});

test.each(["pending", "checking", "failed", undefined] as const)("leaves %s checks and missing checks unchanged", (state) => {
  const projected = projectSettledAiToolChecks(entries(state ? { state } : undefined));
  expect(projected[1]?.message).toBe(unknown);
  expect(projectSettledAiToolChecks(entries(state ? { state } : undefined, null))).toHaveLength(1);
});

test.each(["done", "not_done"] as const)("answers a cut-off call with its settled %s outcome", (state) => {
  const rows = entries({ state, receipt }, null);
  const projected = projectSettledAiToolChecks(rows);
  expect(projected).toHaveLength(2);
  expect(projected[1]).toMatchObject({
    seq: 1,
    kind: "message",
    message: { role: "tool_result", callId: "send", isError: state !== "done" },
  });
  expect(rows).toHaveLength(1);
});

test("preserves a known success and unrelated tool results", () => {
  const success: Message = { ...unknown, result: { data: { id: "original" }, receipt }, isError: false };
  const other: StoreEntry = { seq: 3, kind: "message", message: { ...unknown, callId: "other" } };
  const projected = projectSettledAiToolChecks([...entries({ state: "done" }, success), other]);
  expect(projected[1]?.message).toBe(success);
  expect(projected[2]?.message).toBe(other.message);
});

test("a changed outcome drops stale historical result projections", () => {
  const stale: Message = { ...unknown, historicalResult: { originLoopId: "earlier", value: "ACTION_OUTCOME_UNKNOWN" } };
  const projected = projectSettledAiToolChecks(entries({ state: "done", receipt }, stale));
  expect(projected[1]?.message).not.toHaveProperty("historicalResult");
});

test.each(["user", "reused-call"] as const)("does not apply a check across a %s boundary", (boundary) => {
  const separator: StoreEntry = {
    seq: 2,
    kind: "message",
    message: boundary === "user" ? { role: "user", content: [{ type: "text", text: "Next" }] } : call,
  };
  const projected = projectSettledAiToolChecks([
    ...entries({ state: "done", receipt }, null),
    separator,
    { seq: 3, kind: "message", message: unknown },
  ]);
  expect(projected).toHaveLength(4);
  expect(projected[1]?.message).toMatchObject({ role: "tool_result", callId: "send", isError: false });
  expect(projected.at(-1)?.message).toBe(unknown);
});

test.each(["done", "not_done"] as const)("nessi resumes a settled %s cut-off call without executing the Action", async (state) => {
  const rows = entries({ state, receipt }, null);
  const expected = projectSettledAiToolChecks(rows)[1]?.message;
  if (expected?.role !== "tool_result") throw new Error("Expected a settled tool result");
  const requests: ProviderRequest[] = [];
  let executions = 0;
  const tool = defineTool({ name: "demo__action__send", description: "Send", inputSchema: z.object({}) }).server(async () => {
    executions++;
    return "Sent again";
  });
  const provider: Provider = {
    name: "fixture",
    family: "openai-compatible",
    model: "fixture",
    capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
    complete: async () => {
      throw new Error("Unexpected completion");
    },
    async *stream(request) {
      requests.push(request);
      yield { type: "block_start", blockId: "answer", index: 0, kind: "text" };
      yield { type: "block_end", blockId: "answer", index: 0, block: { type: "text", text: "Checked" } };
      yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "stop" };
    },
  };
  for await (const _event of nessi({
    provider,
    systemPrompt: "",
    tools: [tool],
    store: { load: async () => projectSettledAiToolChecks(rows), append: async () => {} },
  })) {
  }
  expect(executions).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.messages.filter((message) => message.role === "tool_result")).toEqual([expected]);
});
