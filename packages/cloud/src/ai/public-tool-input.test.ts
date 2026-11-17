import { expect, test } from "bun:test";
import { AI_WEBSITE_APPROVAL_TOOL } from "./approvals";
import { __aiExecutorTest } from "./executor";
import type { AiTurnBlock, AiWireEvent } from "./protocol";
import { publicAiToolBlock, publicAiToolEvent, publicAiToolInput, publicAiToolResult } from "./public-tool-input";
import { encodeSseEvent } from "./stream";
import type { AiPendingTurnActionRecord, AiStoredMessage } from "./types";

const source = "export default async () => cloud.spaces.task.create({ title: 'Delivery' })";
const block: AiTurnBlock = {
  id: "tool-run",
  kind: "tool",
  callId: "run",
  name: "code_run",
  args: { code: source, inputPaths: [] },
  status: "running",
};
const base = { v: 1 as const, conversationId: "chat", turnId: "turn", attempt: 1, seq: 1 };

test("public snapshots and legacy live baselines omit execution source without mutating it", () => {
  const events: AiWireEvent[] = [
    { ...base, type: "block_set", block },
    { ...base, type: "turn_started", blocks: [block], modelId: "model", providerModel: "model" },
  ];
  for (const event of events) expect(JSON.stringify(publicAiToolEvent(event))).not.toContain(source);
  expect(publicAiToolBlock(block)).toMatchObject({ args: { inputPaths: [] } });
  expect(block.args).toMatchObject({ code: source });
  expect(publicAiToolInput("other_tool", { code: source })).toEqual({ code: source });
});

test("a website question after an app approval does not inherit the app's identity or proposal", () => {
  const mapper = __aiExecutorTest.createEventMapper(1, []);
  mapper.setTool("run", {
    name: "code_run",
    presentation: {
      kind: "capability",
      appId: "spaces",
      appName: "Spaces",
      appIcon: "ti ti-app",
      title: "Create task",
      capabilityKind: "action",
    },
    review: { legacy: { question: "Create task in Spaces?", rows: [] } },
  });
  mapper.setApprovalReviews(new Map([["run", { message: "Create task in Spaces?" }]]));
  mapper.setApprovalTargets(
    new Map([["run-approval-0", { toolName: AI_WEBSITE_APPROVAL_TOOL, approvalScope: "https://example.com", always: false }]]),
  );
  const steps = mapper.translate({
    agentId: "agent",
    loopId: "turn",
    turnId: "round",
    turnIndex: 0,
    type: "tool_action_request",
    kind: "custom_approval",
    callId: "run-approval-0",
    name: "code_run",
    args: { code: source },
    message: "Read example.com?",
  });
  expect(JSON.stringify(steps)).not.toContain("Spaces");
  expect(JSON.stringify(steps)).not.toContain("Create task");
  expect(JSON.stringify(steps)).not.toContain(source);
  expect(steps[0]).toMatchObject({ type: "block_set", block: { approval: { website: "https://example.com" } } });
});

test("new Code step details never carry the execution input, including custom approval details", () => {
  const mapper = __aiExecutorTest.createEventMapper(1, []);
  const turn = { agentId: "agent", loopId: "turn", turnId: "round", turnIndex: 0 };
  for (const event of [
    { ...turn, type: "tool_execution_start" as const, callId: "run", name: "code_run", args: block.args },
    {
      ...turn,
      type: "tool_action_request" as const,
      kind: "custom_approval" as const,
      callId: "run-approval-0",
      name: "code_run",
      args: block.args,
      message: "Create task?",
    },
  ]) {
    const steps = mapper.translate(event);
    expect(JSON.stringify(steps)).not.toContain(source);
    expect(steps[0]).toMatchObject({ type: "block_set", block: { args: { inputPaths: [] } } });
    expect(event.args).toMatchObject({ code: source });
  }
});

test("all Code source fields stay out of live SSE blocks and resumed baselines", () => {
  for (const name of [
    "code_write",
    "code_read",
    "code_pull",
    "code_init",
    "code_sdk",
    "code_diff",
    "code_check",
    "code_test",
    "code_simulate",
    "code_submit",
  ]) {
    const args = {
      codeId: "ABCDEF",
      path: "code.ts",
      content: source,
      files: { "code.ts": source },
      tests: { "test/a.json": source },
      project: { files: { "code.ts": source } },
    };
    const result = {
      version: 1,
      files: { "code.ts": source },
      declarations: source,
      diff: { files: [{ path: "code.ts", lines: [{ kind: "add", text: source }] }] },
    };
    const raw: AiTurnBlock = { ...block, name, args, result };
    const mapper = __aiExecutorTest.createEventMapper(1, []);
    const turn = { agentId: "agent", loopId: "turn", turnId: "round", turnIndex: 0 };
    const events: AiWireEvent[] = [
      { ...base, type: "block_set", block: raw },
      { ...base, type: "turn_started", blocks: [raw], modelId: "model", providerModel: "model" },
    ];
    for (const event of events) expect(new TextDecoder().decode(encodeSseEvent(publicAiToolEvent(event)))).not.toContain(source);
    const start = mapper.translate({ ...turn, type: "tool_execution_start", callId: "run", name, args });
    const end = mapper.translate({ ...turn, type: "tool_execution_end", callId: "run", name, result, isError: false });
    expect(JSON.stringify([start, end])).not.toContain(source);
    expect(raw.args).toEqual(args);
    expect(raw.result).toEqual(result);
  }
});

test("worker resume separates a later website question from the prior app proposal and keeps its receipt", () => {
  const message: AiStoredMessage = {
    id: "message",
    shortId: "msg",
    conversationId: "chat",
    seq: 1,
    kind: "message",
    loopId: "turn",
    message: { role: "assistant", content: [{ type: "tool_call", id: "run", name: "code_run", args: { code: source } }] },
    modelId: null,
    providerModel: null,
    usage: null,
    stopReason: null,
    loopAggregate: null,
    loopDoneReason: null,
    compactedAt: null,
    meta: {
      toolPresentations: {
        run: {
          kind: "capability",
          appId: "spaces",
          appName: "Spaces",
          appIcon: "ti ti-app",
          title: "Create task",
          capabilityKind: "action",
        },
      },
      toolReviews: { run: { legacy: { question: "Create task in Spaces?", rows: [] } } },
      toolChecks: { run: { state: "done", receipt: { text: "Task created." }, at: "2026-11-17T00:00:00Z" } },
      websiteReceipts: { run: { "0": { method: "GET", url: "https://earlier.example.test" } } },
    },
    createdAt: "2026-11-17T00:00:00Z",
  };
  const pending: AiPendingTurnActionRecord = {
    conversationId: "chat",
    turnId: "turn",
    callId: "run-approval-1",
    name: "code_run",
    kind: "custom_approval",
    status: "pending",
    args: { code: source },
    message: "Read example.com?",
    allowAlways: false,
    allowChat: true,
    rememberToolName: AI_WEBSITE_APPROVAL_TOOL,
    approvalScope: "https://example.com",
    resolvedEvent: null,
  };
  const blocks = __aiExecutorTest.rebuildAttemptBaseline({
    loopMessages: [message],
    pendingRecords: [pending],
    resolvedRecords: [],
    turnSteers: [],
  });
  expect(blocks[0]).toMatchObject({
    callId: pending.callId,
    approval: { message: pending.message, website: pending.approvalScope },
    check: message.meta!.toolChecks!.run,
    receipts: [{ method: "GET", url: "https://earlier.example.test" }],
  });
  expect(blocks[0]?.kind === "tool" ? blocks[0].presentation : null).toBeUndefined();
  expect(blocks[0]?.kind === "tool" ? blocks[0].review : null).toBeUndefined();
  expect(JSON.stringify(blocks)).not.toContain("Spaces");
  expect(message.meta!.toolReviews!.run).toEqual({ legacy: { question: "Create task in Spaces?", rows: [] } });
});

test("streamed Code write previews keep their path but never their source", () => {
  const mapper = __aiExecutorTest.createEventMapper(1, []);
  mapper.setStreamArgs(new Map([["code_write", ["path", "content"]]]));
  const events = mapper.translate({
    agentId: "agent",
    loopId: "turn",
    turnId: "round",
    turnIndex: 0,
    type: "tool_args_delta",
    callId: "write",
    name: "code_write",
    delta: JSON.stringify({ path: "code.ts", content: source }),
  });
  expect(events[0]).toMatchObject({ type: "block_set", block: { args: { path: "code.ts" } } });
  expect(JSON.stringify(events)).not.toContain(source);
});

test("Code result projection preserves worded results, error codes and file summaries; other tools remain unchanged", () => {
  const result = {
    version: 1,
    error: { code: "BAD_INPUT", message: "Check the draft." },
    words: { notices: ["The draft needs a correction."] },
    manifest: { hashes: { bundle: "checked-bundle-hash" } },
    files: [{ path: "code.ts", bytes: 54 }],
  };
  expect(publicAiToolResult("code_check", result)).toEqual(result);
  const other = { content: source, files: { "code.ts": source } };
  expect(publicAiToolInput("other_tool", other)).toBe(other);
  expect(publicAiToolResult("other_tool", other)).toBe(other);
});

test("public Code projection keeps runtime output and authored test data, including fields named content or bundle hashes", () => {
  const output = { status: "ready", output: { content: "Task created.", lines: 3, files: { summary: "Saved" } } };
  expect(publicAiToolResult("code_run", output)).toBe(output);
  expect(publicAiToolResult("code_inspect", output)).toBe(output);
  const fixture = { input: { content: "Delivery" }, replies: [{ content: "Done" }] };
  expect(publicAiToolInput("code_simulate", { codeId: "ABCDEF", fixture })).toEqual({ codeId: "ABCDEF", fixture });
  const checked = { result: { bundle: source }, manifest: { hashes: { bundle: "checked-bundle-hash" } }, words: { notices: [] } };
  expect(publicAiToolResult("code_check", checked)).toEqual({ result: {}, manifest: checked.manifest, words: checked.words });
});
