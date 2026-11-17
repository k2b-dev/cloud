import { expect, test } from "bun:test";
import { AI_WEBSITE_APPROVAL_TOOL } from "./approvals";
import { __aiExecutorTest } from "./executor";
import type { AiTurnBlock, AiWireEvent } from "./protocol";
import { publicAiToolBlock, publicAiToolEvent, publicAiToolInput } from "./public-tool-input";

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
