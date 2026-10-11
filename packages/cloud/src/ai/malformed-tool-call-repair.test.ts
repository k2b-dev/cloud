import { expect, test } from "bun:test";
import {
  defineTool,
  type Message,
  memoryStore,
  nessi,
  type Provider,
  type ProviderRequest,
  type ToolCallBlock,
  type ToolStreamIssue,
} from "@k2b/nessi";
import { z } from "zod";
import {
  AI_MALFORMED_TOOL_CALL_REPAIR_ATTEMPTS,
  buildMalformedToolCallRepairText,
  countMalformedToolCallRepairs,
  createMalformedToolCallRepair,
  isMalformedToolCallId,
  malformedToolCallMessage,
  malformedToolCallName,
  withMalformedToolCallResults,
} from "./malformed-tool-call-repair";
import { AiTurnFailure } from "./turn-failure";

const issue: ToolStreamIssue = {
  kind: "malformed_tool_call",
  reason: "invalid_tool_arguments",
  name: "code_run",
  message: "Unexpected token in JSON",
  argsText: "raw arguments ".repeat(10_000),
};

test("repair names the tool and cause, requests a complete call, and omits raw arguments", () => {
  const text = buildMalformedToolCallRepairText(issue);
  expect(text).toContain("The tool call to code_run could not be used:");
  expect(text).toContain(issue.message);
  expect(text).toContain(issue.reason);
  expect(text).toContain("Re-send the call with its exact tool name and complete, valid, properly escaped JSON arguments.");
  expect(text).not.toContain("raw arguments");
  expect(buildMalformedToolCallRepairText({ ...issue, name: undefined })).not.toContain("undefined");
  expect(buildMalformedToolCallRepairText({ ...issue, message: "x".repeat(20_000), name: "y".repeat(20_000) }).length).toBeLessThan(900);
  for (const reason of [
    "missing_tool_name",
    "text_during_tool_call",
    "stream_ended_before_tool_call",
  ] satisfies ToolStreamIssue["reason"][]) {
    const message = malformedToolCallMessage({ ...issue, reason, message: "Call incomplete" });
    expect(message).toContain(`Call incomplete (${reason})`);
    expect(message).not.toContain("not valid JSON");
  }
});

test("malformed call ids are Cloud-owned, unique and safe for provider replay", () => {
  const repair = createMalformedToolCallRepair(0);
  for (const callId of [undefined, "original", "malformed_aaaaaaaaaaaaaaaaaaaaaaaa"]) {
    const rewritten = repair.noteIssue({ ...issue, callId });
    if (rewritten.kind !== "malformed_tool_call" || !rewritten.callId) throw new Error("Missing malformed call id");
    expect(rewritten.callId).toMatch(/^malformed_[0-9a-f]{24}$/);
    expect(rewritten.callId.length).toBeLessThanOrEqual(40);
    expect(rewritten.callId).not.toBe(callId);
    expect(isMalformedToolCallId(rewritten.callId)).toBe(true);
  }
  for (const id of ["ordinary", "malformed_", `malformed_${"A".repeat(24)}`, `malformed_${"a".repeat(25)}`]) {
    expect(isMalformedToolCallId(id)).toBe(false);
  }
  const other: ToolStreamIssue = { ...issue, kind: "cancelled_tool_call", callId: "cancelled" };
  expect(repair.noteIssue(other)).toBe(other);
  expect(new Set(repair.takeResponseIssues().map((item) => item.callId)).size).toBe(3);
});

test("malformed tool names stay within provider name constraints", () => {
  for (const name of ["code_run", "a", "A-Z_012", "a".repeat(64)]) {
    expect(malformedToolCallName({ ...issue, name })).toBe(name);
  }
  for (const name of [undefined, "", "with spaces", "app.tool", "a".repeat(65), "ä", "code_run\n"]) {
    expect(malformedToolCallName({ ...issue, name })).toBe("unknown_tool");
  }
});

test("only stored responses steer, once per response and at most twice per turn", async () => {
  const repair = createMalformedToolCallRepair(0);
  const store = withMalformedToolCallResults(memoryStore(), repair);
  expect(AI_MALFORMED_TOOL_CALL_REPAIR_ATTEMPTS).toBe(2);
  expect(repair.takeSteering()).toBeUndefined();
  const other = { kind: "runtime_error", message: "Other issue", retryable: false } satisfies Parameters<typeof repair.noteIssue>[0];
  expect(repair.noteIssue(other)).toBe(other);
  expect(repair.takeSteering()).toBeUndefined();
  for (let attempt = 0; attempt < 2; attempt++) {
    repair.startProviderTurn();
    repair.noteIssue(issue);
    repair.noteIssue(issue);
    expect(repair.takeSteering()).toBeUndefined();
    await store.append({ role: "assistant", content: [] });
    expect(repair.takeSteering()).toBe(buildMalformedToolCallRepairText(issue));
    expect(repair.takeSteering()).toBeUndefined();
  }
  expect(countMalformedToolCallRepairs(await store.load())).toBe(2);
  repair.startProviderTurn();
  repair.noteIssue(issue);
  await store.append({ role: "assistant", content: [] });
  expect(() => repair.takeSteering()).toThrow(new AiTurnFailure("failed", malformedToolCallMessage(issue)));
  expect(repair.takeSteering()).toBeUndefined();
});

test("an unpersisted issue from an overflowed response is discarded before retry", async () => {
  const repair = createMalformedToolCallRepair(0);
  const store = withMalformedToolCallResults(memoryStore(), repair);
  repair.noteIssue(issue);
  repair.startProviderTurn();
  await store.append({ role: "assistant", content: [{ type: "text", text: "Done" }] });
  expect(repair.takeSteering()).toBeUndefined();
  expect(countMalformedToolCallRepairs(await store.load())).toBe(0);
});

test("error results follow their assistant message before ordinary tool results", async () => {
  const repair = createMalformedToolCallRepair(0);
  const store = withMalformedToolCallResults(memoryStore(), repair);
  const first = repair.noteIssue(issue);
  const secondIssue: ToolStreamIssue = { ...issue, reason: "missing_tool_name", name: "invalid.tool" };
  const second = repair.noteIssue(secondIssue);
  if (first.kind !== "malformed_tool_call" || second.kind !== "malformed_tool_call" || !first.callId || !second.callId) {
    throw new Error("Missing malformed issues");
  }
  const assistant: Message = {
    role: "assistant",
    model: "fixture",
    provider: "fixture",
    content: [
      { type: "thinking", thinking: "Plan", signature: "signature", redacted: "opaque" },
      { type: "tool_call", id: "valid", name: "code_run", args: { code: "ok" }, signature: "call-signature" },
    ],
  };
  await store.append(assistant);
  const validResult: Message = { role: "tool_result", callId: "valid", name: "code_run", result: "Done" };
  await store.append(validResult);
  const entries = await store.load();
  expect(entries).toHaveLength(4);
  expect(entries[0]?.message).toEqual({
    ...assistant,
    content: [
      ...assistant.content,
      { type: "tool_call", id: first.callId, name: "code_run", args: {} },
      { type: "tool_call", id: second.callId, name: "unknown_tool", args: {} },
    ],
  });
  expect(entries[1]?.message).toEqual({
    role: "tool_result",
    callId: first.callId,
    name: "code_run",
    result: buildMalformedToolCallRepairText(issue),
    isError: true,
  });
  expect(entries[2]?.message).toEqual({
    role: "tool_result",
    callId: second.callId,
    name: "unknown_tool",
    result: buildMalformedToolCallRepairText(secondIssue),
    isError: true,
  });
  expect(entries[3]?.message).toEqual(validResult);
  expect(JSON.stringify(entries)).not.toContain("raw arguments");
  expect(assistant.content).toHaveLength(2);
  expect(repair.takeResponseIssues()).toEqual([]);
  expect(countMalformedToolCallRepairs(entries)).toBe(1);
  expect(repair.takeSteering()).toBe(buildMalformedToolCallRepairText(secondIssue));
});

test("user messages and summaries pass through without consuming in-flight issues", async () => {
  const repair = createMalformedToolCallRepair(0);
  const store = withMalformedToolCallResults(memoryStore(), repair);
  repair.noteIssue(issue);
  const user: Message = { role: "user", content: [{ type: "text", text: "Run" }] };
  const summary: Message = { role: "assistant", content: [{ type: "text", text: "Summary" }] };
  await store.append(user);
  expect(await store.load()).toEqual([{ seq: 1, kind: "message", message: user }]);
  await store.append(summary, { kind: "summary", seq: 10 });
  expect(await store.load()).toEqual([{ seq: 10, kind: "summary", message: summary }]);
  expect(repair.takeSteering()).toBeUndefined();
  await store.append({ role: "assistant", content: [] });
  expect(repair.takeSteering()).toBe(buildMalformedToolCallRepairText(issue));
});

test("repair counting ignores ordinary calls and results and counts each malformed response once", () => {
  const call = { type: "tool_call", id: `malformed_${"a".repeat(24)}`, name: "code_run", args: {} } satisfies ToolCallBlock;
  const messages: Message[] = [
    { role: "assistant", content: [{ ...call, id: "ordinary" }] },
    { role: "assistant", content: [{ ...call, id: "malformed_not-a-cloud-id" }] },
    { role: "assistant", content: [call, { ...call, id: `malformed_${"b".repeat(24)}` }] },
    { role: "tool_result", callId: call.id, name: call.name, result: "failed", isError: true },
    { role: "user", content: [{ type: "text", text: call.id }] },
  ];
  expect(countMalformedToolCallRepairs(messages.map((message) => ({ message })))).toBe(1);
});

test("a resume fails once when stored malformed responses exceed the repair budget", () => {
  const repair = createMalformedToolCallRepair(3);
  try {
    repair.takeSteering();
    throw new Error("Expected exhausted repairs to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AiTurnFailure);
    if (!(error instanceof AiTurnFailure)) throw error;
    expect(error.code).toBe("failed");
    expect(error.message).toBe("A stored response held a tool call that could not be used after the turn's repairs were spent.");
  }
  expect(repair.takeSteering()).toBeUndefined();
  expect(createMalformedToolCallRepair(2).takeSteering()).toBeUndefined();
});

const storedMalformedCall: ToolCallBlock = { type: "tool_call", id: `malformed_${"a".repeat(24)}`, name: "code_run", args: {} };
const genericRepairText =
  "The tool call to code_run could not be used. Re-send the call with its exact tool name and complete, valid, properly escaped JSON arguments.";
const storedError: Message = {
  role: "tool_result",
  callId: storedMalformedCall.id,
  name: storedMalformedCall.name,
  isError: true,
  result: genericRepairText,
};

test("loading repairs only unanswered malformed calls in the trailing assistant exchange, once", async () => {
  const inner = memoryStore();
  await inner.append({ role: "user", content: [{ type: "text", text: "Run" }] });
  await inner.append({
    role: "assistant",
    content: [storedMalformedCall, { type: "tool_call", id: "ordinary", name: "code_run", args: {} }],
    stopReason: "stop",
  });
  const store = withMalformedToolCallResults(inner, createMalformedToolCallRepair(1));
  const entries = await store.load();
  expect(entries).toHaveLength(3);
  expect(entries.at(-1)?.message).toEqual(storedError);
  expect(await inner.load()).toEqual(entries);
  expect(await store.load()).toEqual(entries);
});

test.each(["later user", "already answered"] as const)("loading leaves a malformed call alone when %s", async (mode) => {
  const inner = memoryStore();
  await inner.append({ role: "assistant", content: [storedMalformedCall], stopReason: "stop" });
  await inner.append(mode === "later user" ? { role: "user", content: [{ type: "text", text: "Next" }] } : storedError);
  const before = await inner.load();
  const store = withMalformedToolCallResults(inner, createMalformedToolCallRepair(1));
  expect(await store.load()).toEqual(before);
  expect(await inner.load()).toEqual(before);
});

test("nessi resumes an unanswered malformed call with an error result instead of executing it", async () => {
  const inner = memoryStore();
  await inner.append({ role: "user", content: [{ type: "text", text: "Run" }] });
  await inner.append({ role: "assistant", content: [storedMalformedCall], stopReason: "stop" });
  const requests: ProviderRequest[] = [];
  let executions = 0;
  const tool = defineTool({ name: "code_run", description: "Records execution", inputSchema: z.object({}) }).server(async () => {
    executions++;
    return "Executed";
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
      yield { type: "block_end", blockId: "answer", index: 0, block: { type: "text", text: "Done" } };
      yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "stop" };
    },
  };
  const loop = nessi({
    provider,
    systemPrompt: "",
    store: withMalformedToolCallResults(inner, createMalformedToolCallRepair(1)),
    tools: [tool],
  });
  for await (const _event of loop) {
  }
  expect(executions).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.messages).toContainEqual(storedError);
  expect((await inner.load()).map(({ message }) => message)).toContainEqual(storedError);
});
