import { describe, expect, spyOn, test } from "bun:test";
import {
  type Message,
  memoryStore,
  type NessiLoop,
  nessi,
  type OutboundEvent,
  type Provider,
  type ProviderRequest,
  type ToolCallBlock,
  type ToolStreamIssue,
} from "@k2b/nessi";
import type { CapabilityActionReview } from "../contracts/capabilities";
import {
  AI_WEBSITE_APPROVAL_TOOL,
  aiTurnAllowsRememberedApprovals,
  aiTurnAllowsWebsiteApprovals,
  aiWebsiteApprovalScope,
  parseAiWebsiteApprovalScope,
} from "./approvals";
import { __aiExecutorTest, AiTurnExecutor } from "./executor";
import {
  buildMalformedToolCallRepairText,
  countMalformedToolCallRepairs,
  createMalformedToolCallRepair,
  isMalformedToolCallId,
  malformedToolCallMessage,
  withMalformedToolCallRepair,
  withMalformedToolCallResults,
} from "./malformed-tool-call-repair";
import { type AiTurnBlock, buildBlocksFromMessages, messageBlockId, streamBlockId, toolBlockId } from "./protocol";
import { aiConversations } from "./store";
import * as stream from "./stream";
import { aiToolAudit } from "./tool-audit";
import { prepareAiTools } from "./tools";
import * as turnTiming from "./turn-timing";
import type { AiPendingTurnActionRecord, AiStoredMessage, AiTurnSteer } from "./types";

const { createEventMapper, rebuildAttemptBaseline, rebuildBlocksFromMessages } = __aiExecutorTest;

const turn = { agentId: "cloud", loopId: "turn-1", turnId: "turn-1:turn:0", turnIndex: 0 };

describe("malformed tool call steering", () => {
  const at = "2026-10-11T00:00:00.000Z";
  const issue: ToolStreamIssue = {
    kind: "malformed_tool_call",
    reason: "invalid_tool_arguments",
    callId: "bad-call",
    name: "code_run",
    message: "Invalid JSON",
  };
  const userSteer = (id: string): AiTurnSteer => ({
    id,
    conversationId: "chat",
    turnId: "turn",
    seq: 1,
    clientRequestId: id,
    text: `User steer ${id}`,
    status: "consumed",
    messageId: null,
    createdAt: new Date(0).toISOString(),
    consumedAt: null,
  });

  const run = async (
    malformedResponses: number,
    withUserSteers = false,
    options: {
      previousMessages?: Message[];
      overflow?: boolean;
      issue?: ToolStreamIssue;
      providerFailure?: boolean;
      validCall?: boolean;
    } = {},
  ) => {
    const appliedSteers: (AiTurnSteer | null)[] = [];
    const shownSteers: AiTurnSteer[] = [];
    const requests: ProviderRequest[] = [];
    let steeringReads = 0;
    let userPolicyResets = 0;
    const mapper = createEventMapper(1, []);
    const liveBlocks: AiTurnBlock[] = [];
    const store = memoryStore();
    await store.append({ role: "user", content: [{ type: "text", text: "Run" }] });
    for (const message of options.previousMessages ?? []) await store.append(message);
    const repair = createMalformedToolCallRepair(countMalformedToolCallRepairs(await store.load()));
    let repairAttempts = 0;
    let compactions = 0;
    const takeSteering = repair.takeSteering;
    repair.takeSteering = () => {
      const text = takeSteering();
      if (text) repairAttempts++;
      return text;
    };
    const steering = __aiExecutorTest.createChatSteering({
      repair,
      appliedSteers,
      takePendingSteers: async () => {
        steeringReads++;
        // A real steer is returned alongside the repair, then another while its events are still in flight.
        const steers = withUserSteers && (steeringReads === 2 || steeringReads === 3) ? [userSteer(String(steeringReads))] : [];
        for (const steer of steers) await store.append({ role: "user", content: [{ type: "text", text: steer.text }] });
        return steers;
      },
      noteSteering: () => {
        userPolicyResets++;
      },
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
        if (options.overflow && requests.length === 2) {
          yield { type: "issue", issue: { kind: "provider_error", message: "Context full", retryable: false, contextOverflow: true } };
          return;
        }
        if (requests.length <= malformedResponses) {
          if (options.providerFailure) {
            yield { type: "block_start", blockId: "partial", index: 0, kind: "text" };
            yield { type: "block_end", blockId: "partial", index: 0, block: { type: "text", text: "Partial" } };
          }
          yield { type: "issue", issue: options.issue ?? issue };
          if (options.validCall) {
            yield { type: "block_start", blockId: "valid", index: 0, kind: "tool_call", callId: "valid-call", name: "missing_tool" };
            yield { type: "block_delta", blockId: "valid", index: 0, delta: "{}" };
            yield {
              type: "block_end",
              blockId: "valid",
              index: 0,
              block: { type: "tool_call", id: "valid-call", name: "missing_tool", args: {} },
            };
          }
          if (options.providerFailure) {
            yield { type: "issue", issue: { kind: "provider_error", message: "Disconnected", retryable: false } };
            return;
          }
        } else {
          yield { type: "block_start", blockId: "answer", index: 0, kind: "text" };
          yield { type: "block_end", blockId: "answer", index: 0, block: { type: "text", text: "Done" } };
        }
        yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "stop" };
      },
    };
    const loop = nessi({
      loopId: "turn",
      agentId: "cloud",
      input: "Run",
      systemPrompt: "",
      provider: withMalformedToolCallRepair(provider, repair),
      // Cloud's session store persists input/real steering elsewhere and ignores nessi-appended user messages.
      store: withMalformedToolCallResults(
        {
          load: store.load,
          append: async (message, opts) => {
            if (message.role !== "user") {
              await store.append(message, opts);
              for (const op of mapper.storedMessage(message, at)) {
                if (op.type === "block_set") liveBlocks.push(op.block);
              }
            }
          },
        },
        repair,
      ),
      compact: options.overflow
        ? ({ force }) => {
            if (!force) return null;
            compactions++;
            return Promise.resolve();
          }
        : undefined,
      steering,
      coalesce: { ms: 25, maxChars: 512 },
      maxTurns: 5,
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
    pipeline.apply = async (event) => {
      for (const mapped of mapper.translate(event)) {
        if (mapped.type === "block_set") liveBlocks.push(mapped.block);
      }
    };
    pipeline.applySteer = async (steer) => {
      shownSteers.push(steer);
    };
    pipeline.flush = async () => {};
    pipeline.timing.event = async () => {
      await Bun.sleep(1);
    };
    const timing = spyOn(turnTiming, "withDurableTurnTiming").mockImplementation(async (_turnId, aggregate) => aggregate);
    const aggregate = spyOn(aiConversations, "setLatestAssistantLoopAggregate").mockImplementation(async () => {});
    try {
      const outcome = await executor["driveChatLoop"]({
        loop,
        pipeline,
        conversationId: "chat",
        turnId: "turn",
        abortController: new AbortController(),
        prepared: prepareAiTools({ tools: [] }),
        allowRememberedApprovals: false,
        rememberableCapabilityApprovals: new Map(),
        capabilityActionReviews: new Map(),
        approvalTargets: new Map(),
        linkedApprovals: new Map(),
        appliedSteers,
        noteToolRound: () => {},
        noteToolCall: () => {},
        failureReason: { current: null },
      });
      return {
        outcome,
        requests,
        shownSteers,
        appliedSteers,
        userPolicyResets,
        steeringReads,
        repairAttempts,
        compactions,
        messages: (await store.load()).map((row) => ({ ...row, createdAt: at })),
        liveBlocks,
      };
    } finally {
      timing.mockRestore();
      aggregate.mockRestore();
    }
  };

  test("a malformed issue before a valid call keeps live and history tool steps in the same order", async () => {
    const result = await run(1, false, { validCall: true });
    const liveIds = [...new Set(result.liveBlocks.filter((block) => block.kind === "tool").map((block) => block.id))];
    const historyIds = buildBlocksFromMessages(result.messages)
      .filter((block) => block.kind === "tool")
      .map((block) => block.id);
    expect(liveIds).toEqual(historyIds);
    expect(liveIds[0]).toBe(toolBlockId("valid-call"));
    expect(liveIds).toHaveLength(2);
  });

  test("a dropped malformed call sends repair guidance to the next model request", async () => {
    const result = await run(1);
    expect(result.outcome).toMatchObject({ kind: "finished", status: "completed", failure: null });
    expect(result.requests).toHaveLength(2);
    expect(result.requests[1]?.messages).toContainEqual({
      role: "tool_result",
      callId: expect.stringMatching(/^malformed_[0-9a-f]{24}$/),
      name: "code_run",
      result: buildMalformedToolCallRepairText(issue),
      isError: true,
    });
    const assistant = result.requests[1]?.messages[1];
    const toolResult = result.requests[1]?.messages[2];
    expect(assistant).toMatchObject({
      role: "assistant",
      content: [{ type: "tool_call", id: expect.stringMatching(/^malformed_[0-9a-f]{24}$/), name: "code_run", args: {} }],
    });
    if (assistant?.role !== "assistant" || toolResult?.role !== "tool_result") throw new Error("Missing durable repair");
    expect(assistant.content[0]).toMatchObject({ id: toolResult.callId });
    expect(toolResult.callId).not.toBe(issue.callId);
    expect(result.requests[1]?.messages.filter((message) => message.role === "user")).toEqual([
      { role: "user", content: [{ type: "text", text: "Run" }] },
    ]);
    expect(result.userPolicyResets).toBe(0);
    expect(result.shownSteers).toEqual([]);
    expect(result.appliedSteers).toEqual([]);
  });

  test("context overflow retries with the durable repair and spends only one repair attempt", async () => {
    const result = await run(1, false, { overflow: true });
    expect(result.outcome).toMatchObject({ kind: "finished", status: "completed", failure: null });
    expect(result.requests).toHaveLength(3);
    expect(result.compactions).toBe(1);
    expect(result.repairAttempts).toBe(1);
    expect(result.requests[2]?.messages).toEqual(result.requests[1]?.messages);
    expect(result.requests[2]?.messages[2]).toMatchObject({
      role: "tool_result",
      result: buildMalformedToolCallRepairText(issue),
      isError: true,
    });
    expect(countMalformedToolCallRepairs(result.messages)).toBe(1);
  });

  test("resume keeps the repair budget from two stored malformed responses", async () => {
    const previousMessages: Message[] = [
      { role: "assistant", content: [{ type: "tool_call", id: `malformed_${"a".repeat(24)}`, name: "code_run", args: {} }] },
      {
        role: "tool_result",
        callId: `malformed_${"a".repeat(24)}`,
        name: "code_run",
        result: buildMalformedToolCallRepairText(issue),
        isError: true,
      },
      { role: "assistant", content: [{ type: "tool_call", id: "ordinary", name: "code_run", args: {} }] },
      { role: "tool_result", callId: "ordinary", name: "code_run", result: "Done" },
      { role: "assistant", content: [{ type: "tool_call", id: `malformed_${"b".repeat(24)}`, name: "code_run", args: {} }] },
      {
        role: "tool_result",
        callId: `malformed_${"b".repeat(24)}`,
        name: "code_run",
        result: buildMalformedToolCallRepairText(issue),
        isError: true,
      },
    ];
    const result = await run(1, false, { previousMessages });
    expect(countMalformedToolCallRepairs(previousMessages.map((message) => ({ message })))).toBe(2);
    expect(result.requests).toHaveLength(1);
    expect(result.repairAttempts).toBe(0);
    expect(result.outcome).toMatchObject({ kind: "finished", status: "failed", failure: { error: { code: "failed" } } });
  });

  test("stored history preserves the live failed step, including a safe tool name", async () => {
    for (const name of ["code_run", "notes__action__create", "invalid.tool", undefined]) {
      const result = await run(1, false, { issue: { ...issue, name } });
      const live = result.liveBlocks.find((block) => block.kind === "tool" && isMalformedToolCallId(block.callId));
      const history = buildBlocksFromMessages(result.messages).find(
        (block) => block.kind === "tool" && isMalformedToolCallId(block.callId),
      );
      if (live?.kind !== "tool" || history?.kind !== "tool") throw new Error("Missing failed step");
      expect(live).toEqual(history);
      expect(live.at).toBe(at);
      expect(live.args).toEqual({});
      expect(history.result).toBe(buildMalformedToolCallRepairText({ ...issue, name }));
      const expectedName = name === "code_run" ? "code_run" : name === "notes__action__create" ? "notes.create" : "unknown_tool";
      expect(live.name).toBe(expectedName);
      expect(history.name).toBe(expectedName);
    }
  });

  test("a partial assistant response keeps malformed calls and error results on provider failure", async () => {
    const result = await run(1, false, { providerFailure: true });
    expect(result.outcome).toMatchObject({ kind: "finished", status: "failed" });
    expect(result.messages[1]?.message).toMatchObject({
      role: "assistant",
      stopReason: "error",
      content: [
        { type: "text", text: "Partial" },
        { type: "tool_call", id: expect.stringMatching(/^malformed_[0-9a-f]{24}$/), args: {} },
      ],
    });
    expect(result.messages[2]?.message).toMatchObject({
      role: "tool_result",
      result: buildMalformedToolCallRepairText(issue),
      isError: true,
    });
  });

  test("an ordinary provider stop completes without repair guidance", async () => {
    const result = await run(0);
    expect(result.outcome).toMatchObject({ kind: "finished", status: "completed", failure: null });
    expect(result.requests).toHaveLength(1);
  });

  test("two repairs may succeed, while a third malformed response fails visibly with its reason", async () => {
    expect((await run(2)).outcome).toMatchObject({ kind: "finished", status: "completed" });
    const result = await run(3);
    expect(result.requests).toHaveLength(3);
    // Since nessi 0.17.1 continues after a malformed response itself, steering is read only before each provider turn,
    // no longer again after the response; the exhausted repair then fails before the fourth read.
    expect(result.steeringReads).toBe(3);
    expect(result.outcome).toMatchObject({
      kind: "finished",
      status: "failed",
      failure: { error: { code: "failed" }, detail: malformedToolCallMessage(issue) },
    });
  });

  test("repair acknowledgements never consume real user steers or reset their policy", async () => {
    const result = await run(1, true);
    expect(result.outcome).toMatchObject({ kind: "finished", status: "completed" });
    expect(result.shownSteers).toEqual([userSteer("2"), userSteer("3")]);
    expect(result.userPolicyResets).toBe(2);
    expect(result.appliedSteers).toEqual([]);
  });

  test("real user steering does not renew the repair budget", async () => {
    const result = await run(3, true);
    expect(result.requests).toHaveLength(3);
    expect(result.outcome).toMatchObject({ kind: "finished", status: "failed", failure: { error: { code: "failed" } } });
  });
});

test("website approvals apply only to a turn a person started in a signed-in session", () => {
  const mandate = { id: crypto.randomUUID(), revision: 1 };
  const background = { taskId: "task01", occurrenceId: "run001", context: [] };
  expect(aiTurnAllowsWebsiteApprovals({ kind: "chat", input: "Run", signedInSession: true })).toBe(true);
  // `cld`, an API key, or an inter-chat message starts a turn without the marker.
  expect(aiTurnAllowsWebsiteApprovals({ kind: "chat", input: "Run" })).toBe(false);
  expect(aiTurnAllowsWebsiteApprovals({ kind: "chat", input: "Run", signedInSession: true, mandate, background })).toBe(false);
  expect(aiTurnAllowsWebsiteApprovals({ kind: "compact" })).toBe(false);
  expect(aiTurnAllowsWebsiteApprovals(null)).toBe(false);
});

test("a website approval names one exact origin, in a chat or for one Studio app", () => {
  expect(aiWebsiteApprovalScope("https://api.example.com")).toBe("https://api.example.com");
  expect(parseAiWebsiteApprovalScope(aiWebsiteApprovalScope("https://api.example.com", "Ab3dEf"))).toEqual({
    origin: "https://api.example.com",
    resourceId: "Ab3dEf",
  });
  expect(parseAiWebsiteApprovalScope("https://api.example.com")).toEqual({ origin: "https://api.example.com", resourceId: null });
});

test("remembered approvals reject mandate-backed chats even when kind is omitted", () => {
  const mandate = { id: crypto.randomUUID(), revision: 1 };
  expect(aiTurnAllowsRememberedApprovals({ input: "Run", mandate })).toBe(false);
  expect(aiTurnAllowsRememberedApprovals({ kind: "chat", input: "Run", mandate })).toBe(false);
  expect(aiTurnAllowsRememberedApprovals({ input: "Run" })).toBe(true);
  expect(aiTurnAllowsRememberedApprovals({ kind: "compact" })).toBe(true);
});

describe("nessi block event mapping", () => {
  test.each(["completed", "failed", "rejected"] as const)("timestamps the %s outcome, not running or waiting", (status) => {
    const mapper = createEventMapper(1, []);
    const tool = { ...turn, callId: "call-time", name: "send", args: {} };
    const started = mapper.translate({ ...tool, type: "tool_execution_start" });
    expect(started[0]).toMatchObject({ block: { status: "running", at: undefined } });
    const waiting = mapper.translate({ ...tool, type: "tool_action_request", kind: "approval", message: "Send?" });
    expect(waiting[0]).toMatchObject({ block: { status: "awaiting_approval", at: undefined } });
    if (status === "rejected") mapper.setRejectedCallIds(new Set([tool.callId]));
    const before = Date.now();
    const [done] = mapper.translate({ ...tool, type: "tool_execution_end", result: {}, isError: status !== "completed" });
    if (done?.type !== "block_set" || done.block.kind !== "tool") throw new Error("Expected tool block");
    expect(done.block.status).toBe(status);
    const outcomeTime = Date.parse(done.block.at ?? "");
    expect(outcomeTime).toBeGreaterThanOrEqual(before);
    expect(outcomeTime).toBeLessThanOrEqual(Date.now());
    // A later patch without an outcome keeps the recorded time.
    const resumed = mapper.translate({
      ...tool,
      type: "block_end",
      blockId: "block-time",
      index: 0,
      block: { type: "tool_call", id: tool.callId, name: tool.name, args: {} },
    });
    expect(resumed[0]).toMatchObject({ block: { at: done.block.at } });
  });

  test("a malformed call shows as a failed tool step once its error result is saved", () => {
    const mapper = createEventMapper(1, []);
    const issue: ToolStreamIssue = {
      kind: "malformed_tool_call",
      reason: "invalid_tool_arguments",
      callId: "bad-call",
      name: "code_run",
      message: "Invalid JSON",
      argsText: "huge arguments".repeat(10_000),
    };
    const event: OutboundEvent = { ...turn, type: "issue", issue };
    expect(mapper.translate(event)).toEqual([]);
    const callId = `malformed_${"a".repeat(24)}`;
    const result = buildMalformedToolCallRepairText(issue);
    const at = "2026-10-11T00:00:00.000Z";
    expect(mapper.storedMessage({ role: "tool_result", callId, name: "code_run", result, isError: true }, at)).toMatchObject([
      {
        type: "block_set",
        block: { id: toolBlockId(callId), callId, name: "code_run", args: {}, status: "failed", at, result, isError: true },
      },
    ]);
    expect(mapper.storedMessage({ role: "tool_result", callId: "ordinary", name: "code_run", result }, at)).toEqual([]);
    expect(mapper.translate({ ...event, issue: { kind: "runtime_error", message: "Other issue", retryable: false } })).toEqual([]);
  });
  test("text blocks map to attempt+turn scoped ids across start, delta, end", () => {
    const mapper = createEventMapper(2, []);
    const id = streamBlockId(2, 0, "block-0");

    const start = mapper.translate({ ...turn, type: "block_start", blockId: "block-0", index: 0, kind: "text" } as OutboundEvent);
    expect(start).toEqual([{ type: "block_set", block: { id, kind: "text", text: "" } }]);

    const delta = mapper.translate({ ...turn, type: "block_delta", blockId: "block-0", delta: "Hello" } as OutboundEvent);
    expect(delta).toEqual([{ type: "block_delta", blockId: id, blockKind: "text", delta: "Hello" }]);

    const end = mapper.translate({
      ...turn,
      type: "block_end",
      blockId: "block-0",
      index: 0,
      block: { type: "text", text: "Hello world" },
    } as OutboundEvent);
    expect(end).toEqual([{ type: "block_set", block: { id, kind: "text", text: "Hello world" } }]);
  });

  test("same nessi blockId in different turns and attempts never collides", () => {
    expect(streamBlockId(1, 0, "block-0")).not.toBe(streamBlockId(1, 1, "block-0"));
    expect(streamBlockId(1, 0, "block-0")).not.toBe(streamBlockId(2, 0, "block-0"));
  });

  test("tool_call blocks route to callId-keyed tool blocks and their arg deltas are hidden", () => {
    const mapper = createEventMapper(1, []);

    const start = mapper.translate({
      ...turn,
      type: "block_start",
      blockId: "block-1",
      index: 1,
      kind: "tool_call",
      callId: "call-1",
      name: "web_search",
    } as OutboundEvent);
    expect(start).toEqual([
      {
        type: "block_set",
        block: {
          id: toolBlockId("call-1"),
          kind: "tool",
          callId: "call-1",
          name: "web_search",
          args: undefined,
          status: "running",
          result: undefined,
          isError: undefined,
          approval: undefined,
          frontendMode: undefined,
        },
      },
    ]);

    // Raw args JSON streams as deltas on the tool block — never rendered.
    const argsDelta = mapper.translate({ ...turn, type: "block_delta", blockId: "block-1", delta: '{"query":' } as OutboundEvent);
    expect(argsDelta).toEqual([]);

    const end = mapper.translate({
      ...turn,
      type: "block_end",
      blockId: "block-1",
      index: 1,
      block: { type: "tool_call", id: "call-1", name: "web_search", args: { query: "hi" } },
    } as OutboundEvent);
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({
      type: "block_set",
      block: { id: toolBlockId("call-1"), kind: "tool", args: { query: "hi" }, status: "running" },
    });

    const done = mapper.translate({
      ...turn,
      type: "tool_execution_end",
      callId: "call-1",
      name: "web_search",
      result: { results: [] },
      isError: false,
    } as OutboundEvent);
    expect(done[0]).toMatchObject({ type: "block_set", block: { status: "completed", result: { results: [] } } });
  });

  test("tool_action_request marks the tool block awaiting with approval metadata", () => {
    const mapper = createEventMapper(1, []);
    const review = {
      message: "Sure?",
      details: [{ label: "Body", value: "Hello", display: "block" as const }],
      links: [{ rel: "edit" as const, href: "/app/mail/drafts/one" }],
      approvalScope: "skills",
    };
    mapper.setApprovalReviews(new Map([["call-9", review]]));
    const ops = mapper.translate({
      ...turn,
      type: "tool_action_request",
      kind: "custom_approval",
      callId: "call-9",
      name: "danger",
      args: { a: 1 },
      message: "Sure?",
    } as OutboundEvent);
    expect(ops[0]).toMatchObject({
      type: "block_set",
      block: { id: toolBlockId("call-9"), status: "awaiting_approval", approval: { message: "Sure?", review, allowAlways: true } },
    });
  });

  test("custom approval keeps the review from its parent tool call", () => {
    const mapper = createEventMapper(1, []);
    const review = {
      message: "Update the draft.",
      details: [{ label: "Proposed body", value: "Hello Ada", display: "block" as const }],
    };
    mapper.setApprovalReviews(new Map([["call-9", review]]));

    const ops = mapper.translate({
      ...turn,
      type: "tool_action_request",
      kind: "custom_approval",
      callId: "call-9-approval-0",
      name: "mail__action__draft_dot_update",
      args: { draft: { body: "Hello Ada" } },
      message: review.message,
    } as OutboundEvent);

    expect(ops[0]).toMatchObject({
      type: "block_set",
      block: {
        id: toolBlockId("call-9"),
        callId: "call-9-approval-0",
        status: "awaiting_approval",
        approval: { message: review.message, review },
      },
    });
  });

  test("tool approval policy is reflected in the live approval block", () => {
    const mapper = createEventMapper(1, []);
    mapper.setApprovalPolicies(new Map([["danger", { kind: "user-configurable", default: "once", scope: "danger" }]]));

    const ops = mapper.translate({
      ...turn,
      type: "tool_action_request",
      kind: "approval",
      callId: "call-10",
      name: "danger",
      args: {},
      message: "Sure?",
    } as OutboundEvent);

    expect(ops[0]).toMatchObject({
      type: "block_set",
      block: { approval: { allowAlways: true } },
    });
  });

  test("background approval blocks never offer Always Allow for tools or capability scopes", () => {
    const mapper = createEventMapper(
      1,
      [
        {
          id: toolBlockId("old-call"),
          kind: "tool",
          callId: "old-call",
          name: "danger",
          status: "awaiting_approval",
          approval: { message: "Old request", allowAlways: true },
        },
      ],
      false,
    );
    expect(
      mapper.translate({ ...turn, type: "tool_execution_start", callId: "old-call", name: "danger", args: {} } as OutboundEvent)[0],
    ).toMatchObject({ block: { approval: { allowAlways: false } } });
    mapper.setApprovalPolicies(new Map([["danger", "always"]]));
    mapper.setApprovalReviews(new Map([["call-10", { message: "Sure?", approvalScope: "resource:one" }]]));
    for (const kind of ["approval", "custom_approval"] as const) {
      const ops = mapper.translate({
        ...turn,
        type: "tool_action_request",
        kind,
        callId: kind === "custom_approval" ? "call-10-approval-0" : "call-10",
        name: "danger",
        args: {},
        message: "Sure?",
      } as OutboundEvent);
      expect(ops[0]).toMatchObject({ type: "block_set", block: { approval: { allowAlways: false } } });
    }
  });

  test("a code run's approval offers the chat reach of its website or Action, never of the run", () => {
    const mapper = createEventMapper(1, []);
    mapper.setApprovalPolicies(new Map([["code_run", "never"]]));
    mapper.setApprovalTargets(
      new Map([
        ["run-approval-0", { toolName: AI_WEBSITE_APPROVAL_TOOL, approvalScope: "https://query1.finance.yahoo.com", always: false }],
        ["run-approval-1", { toolName: "spaces.task.create", approvalScope: "space:team", always: true }],
      ]),
    );
    const request = (callId: string) =>
      mapper.translate({
        ...turn,
        type: "tool_action_request",
        kind: "custom_approval",
        callId,
        name: "code_run",
        args: {},
        message: "?",
      } as OutboundEvent)[0];
    expect(request("run-approval-0")).toMatchObject({
      block: { approval: { allowAlways: false, allowChat: true, website: "https://query1.finance.yahoo.com" } },
    });
    expect(request("run-approval-1")).toMatchObject({ block: { approval: { allowAlways: true, allowChat: true } } });
    expect((request("run-approval-1") as { block: { approval: { website?: string } } }).block.approval.website).toBeUndefined();
    // An approval without a target is the run itself, which is never remembered.
    expect(request("run-approval-2")).toMatchObject({ block: { approval: { allowAlways: false, allowChat: false } } });
    const background = createEventMapper(1, [], false);
    background.setApprovalTargets(
      new Map([["run-approval-0", { toolName: AI_WEBSITE_APPROVAL_TOOL, approvalScope: "https://a.example", always: false }]]),
    );
    expect(
      background.translate({
        ...turn,
        type: "tool_action_request",
        kind: "custom_approval",
        callId: "run-approval-0",
        name: "code_run",
        args: {},
        message: "?",
      } as OutboundEvent)[0],
    ).toMatchObject({ block: { approval: { allowAlways: false, allowChat: false } } });
  });

  test("website receipts stay on a call through its later approval card and its failure", () => {
    const mapper = createEventMapper(1, []);
    mapper.setApprovalTargets(
      new Map([["run-approval-0", { toolName: AI_WEBSITE_APPROVAL_TOOL, approvalScope: "https://a.example", always: false }]]),
    );
    mapper.translate({ ...turn, type: "tool_execution_start", callId: "run", name: "code_run", args: {} } as OutboundEvent);
    expect(mapper.addReceipts("run", [{ index: 1, method: "GET", url: "https://a.example/2" }])).toEqual([
      { method: "GET", url: "https://a.example/2" },
    ]);
    // A replay reports the same index again; it replaces itself, and order follows the index.
    expect(
      mapper.addReceipts("run", [
        { index: 0, method: "GET", url: "https://a.example/1" },
        { index: 1, method: "GET", url: "https://a.example/2" },
      ]),
    ).toEqual([
      { method: "GET", url: "https://a.example/1" },
      { method: "GET", url: "https://a.example/2" },
    ]);
    const receipts = [
      { method: "GET", url: "https://a.example/1" },
      { method: "GET", url: "https://a.example/2" },
    ];
    const asking = mapper.translate({
      ...turn,
      type: "tool_action_request",
      kind: "custom_approval",
      callId: "run-approval-0",
      name: "code_run",
      args: {},
      message: "GET https://b.example",
    } as OutboundEvent)[0];
    expect(asking).toMatchObject({ block: { id: "tool-run", status: "awaiting_approval", receipts } });
    const failed = mapper.translate({
      ...turn,
      type: "tool_execution_end",
      callId: "run",
      name: "code_run",
      result: "Request failed with HTTP 401.",
      isError: true,
    } as OutboundEvent)[0];
    expect(failed).toMatchObject({ block: { id: "tool-run", status: "failed", receipts } });
    // A rebuilt turn keeps them too.
    const rebuilt = createEventMapper(2, [{ ...(failed as { block: AiTurnBlock }).block }]);
    expect(rebuilt.addReceipts("run", [{ index: 2, method: "HEAD", url: "https://a.example/3" }])).toEqual([
      ...receipts,
      { method: "HEAD", url: "https://a.example/3" },
    ]);
  });

  test("reconnect rebuild replaces the parent call with its pending custom approval", () => {
    const blocks = rebuildBlocksFromMessages(
      [
        {
          seq: 1,
          message: {
            role: "assistant",
            content: [{ type: "tool_call", id: "call-9", name: "mail__action__conversation_dot_mark", args: { read: true } }],
          },
        },
      ] as never,
      [
        {
          callId: "call-9-approval-0",
          kind: "custom_approval",
          name: "mail__action__conversation_dot_mark",
          args: { read: true },
          message: "Mark read.",
          review: { message: "Mark read." },
          allowAlways: true,
          frontendMode: null,
        },
      ] as never,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      id: toolBlockId("call-9"),
      callId: "call-9-approval-0",
      status: "awaiting_approval",
    });
  });

  test("attempt baseline keeps resolved frontend tools in persisted message order", () => {
    const result = { action: "submit", content: "Final draft" };
    const blocks = rebuildAttemptBaseline({
      loopMessages: [
        { seq: 1, message: { role: "assistant", content: [{ type: "text", text: "Here is the draft:" }] } },
        {
          seq: 2,
          message: {
            role: "assistant",
            content: [{ type: "tool_call", id: "editor", name: "text_editor", args: { content: "Draft" } }],
          },
        },
      ] as never,
      pendingRecords: [],
      resolvedRecords: [
        {
          callId: "editor",
          kind: "client_tool",
          frontendMode: "client_interaction",
          resolvedEvent: { type: "tool_result", callId: "editor", result },
        },
      ] as never,
      turnSteers: [],
    });

    expect(blocks.map((block) => block.id)).toEqual([messageBlockId(1, 0), toolBlockId("editor")]);
    expect(blocks[1]).toMatchObject({ kind: "tool", callId: "editor", status: "completed", result });
  });

  test("attempt baseline does not downgrade a tool result already persisted by the loop", () => {
    const persistedResult = { saved: true };
    const blocks = rebuildAttemptBaseline({
      loopMessages: [
        {
          seq: 1,
          message: {
            role: "assistant",
            content: [{ type: "tool_call", id: "editor", name: "text_editor", args: { content: "Draft" } }],
          },
        },
        {
          seq: 2,
          createdAt: "2026-10-07T10:23:45.000Z",
          message: { role: "tool_result", callId: "editor", name: "text_editor", result: persistedResult },
        },
      ] as never,
      pendingRecords: [],
      resolvedRecords: [
        {
          callId: "editor",
          kind: "client_tool",
          frontendMode: "client_interaction",
          resolvedEvent: { type: "tool_result", callId: "editor", result: { stale: true } },
        },
      ] as never,
      turnSteers: [],
    });

    expect(blocks[0]).toMatchObject({
      kind: "tool",
      callId: "editor",
      status: "completed",
      result: persistedResult,
      at: "2026-10-07T10:23:45.000Z",
    });
  });

  test("capability presentation follows a live call through completion", () => {
    const mapper = createEventMapper(1, []);
    const presentation = {
      kind: "capability" as const,
      appId: "contacts",
      appName: "Contacts",
      appIcon: "ti ti-address-book",
      title: "List contacts",
      capabilityKind: "query" as const,
    };
    mapper.setPresentations(new Map([["contacts__query__list", presentation]]));
    mapper.setCanonicalNames(new Map([["contacts__query__list", "contacts.list"]]));
    const start = mapper.translate({
      ...turn,
      type: "tool_execution_start",
      callId: "call-capability",
      name: "contacts__query__list",
      args: {},
    } as OutboundEvent);
    expect(start[0]).toMatchObject({ type: "block_set", block: { name: "contacts.list", presentation } });

    const done = mapper.translate({
      ...turn,
      type: "tool_execution_end",
      callId: "call-capability",
      name: "contacts__query__list",
      result: { data: [] },
    } as OutboundEvent);
    expect(done[0]).toMatchObject({ type: "block_set", block: { name: "contacts.list", status: "completed", presentation } });
  });

  test("client tool action requests carry the tool's real frontend mode", () => {
    const mapper = createEventMapper(1, []);
    mapper.setFrontendModes(new Map([["survey", "client_interaction"]]));
    const ops = mapper.translate({
      ...turn,
      type: "tool_action_request",
      kind: "client_tool",
      callId: "call-7",
      name: "survey",
      args: { title: "Feedback" },
      message: "",
    } as OutboundEvent);
    // "client" here would let the frontend auto-answer the survey with a fake
    // result before the user sees it (the "AI action request not found" bug).
    expect(ops[0]).toMatchObject({
      type: "block_set",
      block: { id: toolBlockId("call-7"), status: "awaiting_client", frontendMode: "client_interaction" },
    });

    // Unknown client tools fall back to plain "client".
    const fallback = mapper.translate({
      ...turn,
      type: "tool_action_request",
      kind: "client_tool",
      callId: "call-8",
      name: "unknown-tool",
      args: {},
      message: "",
    } as OutboundEvent);
    expect(fallback[0]).toMatchObject({ type: "block_set", block: { frontendMode: "client" } });
  });

  test("issues with a callId mark an unfinished tool block failed", () => {
    const mapper = createEventMapper(1, []);
    mapper.translate({ ...turn, type: "tool_execution_start", callId: "call-2", name: "web_extract", args: {} } as OutboundEvent);
    const ops = mapper.translate({
      ...turn,
      type: "issue",
      issue: { kind: "timeout", scope: "tool", message: "Tool timed out", retryable: false, callId: "call-2", name: "web_extract" },
    } as OutboundEvent);
    expect(ops[0]).toMatchObject({
      type: "block_set",
      block: { id: toolBlockId("call-2"), status: "failed", isError: true, at: expect.any(String) },
    });

    // Issues for completed tools or without callId are ignored.
    const ignored = mapper.translate({
      ...turn,
      type: "issue",
      issue: { kind: "runtime_error", message: "boom", retryable: false },
    } as OutboundEvent);
    expect(ignored).toEqual([]);
  });

  test("seeded tool blocks keep their metadata across attempts", () => {
    const mapper = createEventMapper(3, [
      {
        id: toolBlockId("call-1"),
        kind: "tool",
        callId: "call-1",
        name: "danger",
        args: { a: 1 },
        status: "awaiting_approval",
        approval: { allowAlways: true },
      },
    ]);
    const ops = mapper.translate({
      ...turn,
      type: "tool_execution_end",
      callId: "call-1",
      name: "danger",
      result: { done: true },
    } as OutboundEvent);
    expect(ops[0]).toMatchObject({ type: "block_set", block: { args: { a: 1 }, status: "completed", approval: undefined } });
  });

  test("keeps rejected calls rejected while their continuation settles", () => {
    const mapper = createEventMapper(3, []);
    mapper.setRejectedCallIds(new Set(["call-1"]));

    expect(
      mapper.translate({ ...turn, type: "tool_execution_start", callId: "call-1", name: "danger", args: { a: 1 } } as OutboundEvent),
    ).toEqual([]);
    expect(
      mapper.translate({
        ...turn,
        type: "issue",
        issue: {
          kind: "tool_execution_error",
          reason: "execution_failed",
          message: "Capability Action was rejected by the user.",
          retryable: false,
          callId: "call-1",
          name: "danger",
        },
      } as OutboundEvent),
    ).toEqual([]);
    expect(
      mapper.translate({
        ...turn,
        type: "tool_execution_end",
        callId: "call-1",
        name: "danger",
        result: "Capability Action was rejected by the user.",
        isError: true,
      } as OutboundEvent)[0],
    ).toMatchObject({ type: "block_set", block: { status: "rejected", isError: true } });
  });

  test("marks approved calls, including the parent of a custom approval, so their receipt survives", () => {
    const mapper = createEventMapper(3, []);
    mapper.setApprovedCallIds(new Set(["call-1"]));
    const end = mapper.translate({
      ...turn,
      type: "tool_execution_end",
      callId: "call-1",
      name: "danger",
      result: { done: true },
    } as OutboundEvent);
    expect(end[0]).toMatchObject({ type: "block_set", block: { status: "completed", approved: true } });
    const other = mapper.translate({
      ...turn,
      type: "tool_execution_start",
      callId: "call-2",
      name: "read_file",
      args: {},
    } as OutboundEvent);
    expect(other[0]).toMatchObject({ type: "block_set", block: { callId: "call-2" } });
    expect((other[0] as { block: { approved?: boolean } }).block.approved).toBeUndefined();
  });

  test("rebuilds a resolved approval as approved before its result is saved", () => {
    const blocks = rebuildAttemptBaseline({
      loopMessages: [
        {
          id: "m1",
          shortId: "m1",
          conversationId: "c",
          seq: 1,
          kind: "message",
          message: { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "danger", args: {} }] },
          loopId: "turn-1",
          modelProfileId: null,
          providerModel: null,
          usage: null,
          stopReason: null,
          loopAggregate: null,
          loopDoneReason: null,
          compactedAt: null,
          meta: null,
          createdAt: "2026-10-07T10:00:00.000Z",
        },
      ],
      pendingRecords: [],
      resolvedRecords: [
        {
          turnId: "turn-1",
          conversationId: "c",
          callId: "call-1",
          kind: "approval",
          status: "resolved",
          name: "danger",
          args: {},
          approvalScope: "danger",
          allowAlways: false,
          resolvedEvent: { type: "approval_response", callId: "call-1", approved: true },
        },
      ],
      turnSteers: [],
    });
    expect(blocks[0]).toMatchObject({ kind: "tool", status: "running", approved: true });
  });

  test("loop lifecycle and usage events map to nothing", () => {
    const mapper = createEventMapper(1, []);
    expect(mapper.translate({ type: "loop_start", agentId: "cloud", loopId: "turn-1" } as OutboundEvent)).toEqual([]);
    expect(mapper.translate({ ...turn, type: "turn_start" } as OutboundEvent)).toEqual([]);
    expect(mapper.translate({ ...turn, type: "usage", usage: { input: 1, output: 1, total: 2 } } as OutboundEvent)).toEqual([]);
  });
});

test("web search sources retain the query above the activity description", async () => {
  const index = spyOn(aiConversations, "indexConversationSource").mockResolvedValue(undefined);
  try {
    await __aiExecutorTest.indexConversationToolSource({
      conversationId: "conversation",
      turnId: "turn",
      callId: "search",
      name: "web_search",
      args: { query: "  Wetter Ulm  " },
      result: [],
      isError: false,
    });
    expect(index).toHaveBeenCalledWith({
      conversationId: "conversation",
      turnId: "turn",
      callId: "search",
      // One entry per normalized query, so every search stays visible.
      source: { kind: "activity", key: "web_search:wetter ulm", title: "Wetter Ulm", preview: "Searched the web", icon: "ti ti-world" },
    });
  } finally {
    index.mockRestore();
  }
});

test("an app is a result only when the browser opened it", async () => {
  const index = spyOn(aiConversations, "indexConversationSource").mockResolvedValue(undefined);
  const call = {
    conversationId: "conversation",
    turnId: "turn",
    callId: "open",
    name: "code_open",
    args: { id: "App002" },
    isError: false,
  };
  try {
    // A browser tool ends when the turn continues, with what the browser reported and without isError, also on failure.
    for (const result of [{ error: "Browser workspace disconnected" }, "opened", null])
      await __aiExecutorTest.indexConversationToolSource({ ...call, result });
    expect(index).not.toHaveBeenCalled();
    await __aiExecutorTest.indexConversationToolSource({ ...call, result: { opened: "App002", started: false } });
    expect(index).toHaveBeenCalledWith({
      conversationId: "conversation",
      turnId: "turn",
      callId: "open",
      source: {
        kind: "result",
        key: "assistant.artifact:App002",
        title: "Studio app",
        icon: "ti ti-app-window",
        ref: { type: "assistant.artifact", id: "App002" },
      },
    });
  } finally {
    index.mockRestore();
  }
});

test("direct code tools index returned Studio references without a capability wrapper", async () => {
  const index = spyOn(aiConversations, "indexConversationResources").mockResolvedValue(undefined);
  const call = {
    conversationId: "conversation",
    turnId: "turn",
    callId: "create",
    name: "code_create",
    args: {},
    result: { refs: [{ type: "assistant.artifact", id: "app-id", title: "Dashboard" }] },
    isError: false,
  };
  try {
    await __aiExecutorTest.indexConversationToolSource(call);
    expect(index).toHaveBeenCalledWith({
      conversationId: "conversation",
      turnId: "turn",
      callId: "create",
      resources: [{ ref: { type: "assistant.artifact", id: "app-id" }, title: "Dashboard" }],
    });
    index.mockClear();
    await __aiExecutorTest.indexConversationToolSource({ ...call, isError: true });
    expect(index).not.toHaveBeenCalled();
  } finally {
    index.mockRestore();
  }
});

describe("saved live state", () => {
  test("follows every event within one interval, also without a further event, and stops when the attempt ends", async () => {
    const saved: number[] = [];
    const save = spyOn(aiConversations, "saveTurnLiveState").mockImplementation(async (input) => {
      saved.push(input.seq);
      return true;
    });
    const publish = spyOn(stream, "publishAiWireEvent").mockResolvedValue(undefined);
    try {
      const pipeline = new __aiExecutorTest.StreamPipeline({
        conversationId: "chat",
        turnId: "turn",
        attempt: 1,
        startSeq: 0,
        leaseOwner: "worker",
        seedBlocks: [],
        allowRememberedApprovals: false,
      });
      // A new attempt saves its baseline at once.
      await pipeline.emitTurnStarted("model");
      await pipeline.emitBaseline();
      expect(saved).toEqual([1]);

      // Changes inside the interval are saved when it ends, although nothing follows them.
      await pipeline.applyCompaction("running");
      await pipeline.emitMessage({
        id: "m1",
        shortId: "m1",
        conversationId: "chat",
        seq: 1,
        kind: "message",
        message: { role: "assistant", content: [] },
        loopId: "turn",
        modelProfileId: null,
        providerModel: null,
        usage: null,
        stopReason: null,
        loopAggregate: null,
        loopDoneReason: null,
        compactedAt: null,
        meta: null,
        createdAt: new Date(0).toISOString(),
      });
      expect(saved).toEqual([1]);
      await Bun.sleep(stream.AI_LIVE_SNAPSHOT_INTERVAL_MS + 200);
      expect(saved).toEqual([1, 3]);

      // The attempt ends: a later save would overwrite what suspension or the next attempt saved.
      await pipeline.applyCompaction("completed");
      await pipeline.flush();
      await Bun.sleep(stream.AI_LIVE_SNAPSHOT_INTERVAL_MS + 200);
      expect(saved).toEqual([1, 3]);
    } finally {
      save.mockRestore();
      publish.mockRestore();
    }
  });

  test("saves one after another, so an older state never lands last, and the attempt's end waits for them", async () => {
    const log: string[] = [];
    const save = spyOn(aiConversations, "saveTurnLiveState").mockImplementation(async (input) => {
      log.push(`start ${input.seq}`);
      // The database stalls on the second save.
      await Bun.sleep(input.seq === 2 ? 1_500 : 10);
      log.push(`end ${input.seq}`);
      return true;
    });
    const publish = spyOn(stream, "publishAiWireEvent").mockResolvedValue(undefined);
    try {
      const pipeline = new __aiExecutorTest.StreamPipeline({
        conversationId: "chat",
        turnId: "turn",
        attempt: 1,
        startSeq: 0,
        leaseOwner: "worker",
        seedBlocks: [],
        allowRememberedApprovals: false,
      });
      await pipeline.emitTurnStarted("model");
      await pipeline.emitBaseline();
      await pipeline.applyCompaction("running");
      // The interval ends and saves event 2; the next change waits for the interval after it.
      await Bun.sleep(stream.AI_LIVE_SNAPSHOT_INTERVAL_MS + 100);
      await pipeline.applyCompaction("completed");
      await Bun.sleep(stream.AI_LIVE_SNAPSHOT_INTERVAL_MS);
      await pipeline.flush();
      expect(log).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
    } finally {
      save.mockRestore();
      publish.mockRestore();
    }
  });
});

test("turn policy ignores malformed-only rounds and counts mixed rounds by their ordinary calls", () => {
  const malformed = { type: "tool_call", id: `malformed_${"a".repeat(24)}`, name: "send", args: {} } satisfies ToolCallBlock;
  const entry: AiStoredMessage = {
    id: "m",
    shortId: "m",
    conversationId: "c",
    seq: 1,
    kind: "message",
    message: { role: "assistant", stopReason: "stop", content: [malformed] },
    loopId: "t",
    modelProfileId: null,
    providerModel: null,
    usage: null,
    stopReason: "stop",
    loopAggregate: null,
    loopDoneReason: null,
    compactedAt: null,
    meta: null,
    createdAt: new Date(0).toISOString(),
  };
  const malformedResult: AiStoredMessage = {
    ...entry,
    seq: 2,
    message: { role: "tool_result", callId: malformed.id, name: "send", result: "Failed", isError: true },
  };
  expect(__aiExecutorTest.toolRoundState([entry])).toEqual({ issued: 0, completed: 0 });
  expect(__aiExecutorTest.toolRoundState([entry, malformedResult])).toEqual({ issued: 0, completed: 0 });
  const mixed: AiStoredMessage = {
    ...entry,
    message: {
      role: "assistant",
      stopReason: "tool_use",
      content: [malformed, { type: "tool_call", id: "ordinary", name: "send", args: {} }],
    },
  };
  const ordinaryResult: AiStoredMessage = {
    ...entry,
    seq: 3,
    message: { role: "tool_result", callId: "ordinary", name: "send", result: "Done" },
  };
  expect(__aiExecutorTest.toolRoundState([mixed, malformedResult])).toEqual({ issued: 1, completed: 0 });
  expect(__aiExecutorTest.toolRoundState([mixed, ordinaryResult])).toEqual({ issued: 1, completed: 1 });
});

for (const stopReason of ["error", "interrupted", "aborted"] as const)
  test(`a ${stopReason} answer never counts as an issued or completed tool round`, () => {
    const message = {
      role: "assistant" as const,
      stopReason,
      content: [{ type: "tool_call" as const, id: "call", name: "send", args: {} }],
    };
    const entry = {
      id: "m",
      shortId: "m",
      conversationId: "c",
      seq: 1,
      kind: "message" as const,
      message,
      loopId: "t",
      modelProfileId: null,
      providerModel: null,
      usage: null,
      stopReason,
      loopAggregate: null,
      loopDoneReason: null,
      compactedAt: null,
      meta: null,
      createdAt: new Date(0).toISOString(),
    };
    expect(__aiExecutorTest.toolRoundState([entry])).toEqual({ issued: 0, completed: 0 });
    expect(
      __aiExecutorTest.toolRoundState([
        entry,
        {
          ...entry,
          seq: 2,
          message: {
            role: "tool_result",
            callId: "call",
            name: "send",
            result: "interrupted",
            isError: true,
          },
        },
      ]),
    ).toEqual({ issued: 0, completed: 0 });
  });

for (const stopReason of ["tool_use", "error", "interrupted", "aborted"] as const)
  test(`executor handles ${stopReason} turn_end without counting unexecuted calls as completed rounds`, async () => {
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
    const loop: NessiLoop = {
      async *[Symbol.asyncIterator]() {
        yield {
          ...turn,
          type: "turn_end",
          message: { role: "assistant", stopReason, content: [{ type: "tool_call", id: "call", name: "send", args: {} }] },
        };
      },
      subscribe: () => () => {},
      push: () => {},
      steer: () => {},
      abort: () => {},
    };
    let rounds = 0;
    const input = {
      loop,
      pipeline,
      conversationId: "chat",
      turnId: "turn",
      abortController: new AbortController(),
      prepared: prepareAiTools({ tools: [] }),
      allowRememberedApprovals: false,
      rememberableCapabilityApprovals: new Map<string, string>(),
      capabilityActionReviews: new Map<string, CapabilityActionReview>(),
      approvalTargets: new Map(),
      linkedApprovals: new Map(),
      appliedSteers: [],
      noteToolRound: () => {
        rounds++;
      },
      noteToolCall: () => {},
      failureReason: { current: null },
    };
    await executor["driveChatLoop"](input);
    expect(rounds).toBe(stopReason === "tool_use" ? 1 : 0);
    rounds = 0;
    input.abortController.abort();
    await executor["driveChatLoop"](input);
    expect(rounds).toBe(0);
  });

test.each(["fast", "late", "interaction", "code_open", "abort"] as const)("%s client result uses the correct lease path", async (mode) => {
  const signal = new AbortController();
  const name = mode === "interaction" ? "survey" : mode === "code_open" ? "code_open" : "local_list";
  const event: Extract<OutboundEvent, { type: "tool_action_request" }> = {
    ...turn,
    type: "tool_action_request",
    kind: "client_tool",
    callId: "local-1",
    name,
    args: { path: "." },
  };
  const pending: AiPendingTurnActionRecord = {
    conversationId: "chat-1",
    turnId: "turn-1",
    callId: "local-1",
    kind: "client_tool",
    status: "pending",
    name,
    args: event.args,
    approvalScope: name,
    allowAlways: false,
    allowChat: false,
    frontendMode: mode === "interaction" ? "client_interaction" : "client",
    resolvedEvent: null,
  };
  const resolved: AiPendingTurnActionRecord = {
    ...pending,
    status: "resolved",
    resolvedEvent: { type: "tool_result", callId: "local-1", result: { status: "completed", path: "/work", entries: [], nextAfter: null } },
  };
  const config = spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue({ kind: "chat", input: "List files" });
  const save = spyOn(aiConversations, "savePendingTurnAction").mockResolvedValue(undefined);
  const get = spyOn(aiConversations, "getPendingTurnAction").mockResolvedValue(mode === "fast" ? resolved : pending);
  const markInline = spyOn(aiConversations, "markPendingTurnActionConsumedInline").mockResolvedValue(undefined);
  const suspend = spyOn(aiConversations, "suspendTurn").mockResolvedValue(true);
  const audit = spyOn(aiToolAudit, "noteToolCall").mockResolvedValue(undefined);
  const pipeline = new __aiExecutorTest.StreamPipeline({
    conversationId: "chat-1",
    turnId: "turn-1",
    attempt: 1,
    startSeq: 0,
    leaseOwner: "test",
    seedBlocks: [],
    allowRememberedApprovals: false,
  });
  const apply = spyOn(pipeline, "apply").mockResolvedValue(undefined);
  const flush = spyOn(pipeline, "flush").mockResolvedValue(undefined);
  const loop = nessi({
    provider: {
      name: "mock",
      family: "openai-compatible",
      model: "mock",
      contextWindow: 8000,
      capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: false },
      stream: async function* () {
        throw new Error("Model must not run in this test");
      },
      complete: async () => {
        throw new Error("Model must not run in this test");
      },
    },
    store: memoryStore(),
    tools: [],
    input: "List files",
    systemPrompt: "test",
  });
  const push = spyOn(loop, "push");
  const heartbeatMs = mode === "abort" ? 2000 : 40;
  const executor = new AiTurnExecutor({ leaseOwner: "test", heartbeatMs, enqueueContinuation: async () => {} });
  const timer = mode === "abort" ? setTimeout(() => signal.abort(), 5) : undefined;
  const started = performance.now();
  try {
    expect(
      await executor["handleActionRequest"]({
        event,
        loop,
        pipeline,
        conversationId: "chat-1",
        turnId: "turn-1",
        prepared: {
          tools: [],
          canonicalNames: new Map(),
          approvalPolicies: new Map([[name, "never"]]),
          frontendModes: new Map([[name, mode === "interaction" ? "client_interaction" : "client"]]),
        },
        allowRememberedApprovals: false,
        rememberableCapabilityApprovals: new Map(),
        capabilityActionReviews: new Map(),
        approvalTargets: new Map(),
        linkedApprovals: new Map(),
        signal: signal.signal,
      }),
    ).toBe(mode !== "fast");
    expect(save).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(event);
    if (mode === "fast") {
      expect(flush).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith(resolved.resolvedEvent!);
      expect(markInline).toHaveBeenCalledTimes(1);
      expect(markInline).toHaveBeenCalledWith({ conversationId: "chat-1", turnId: "turn-1", callId: event.callId });
      expect(push.mock.invocationCallOrder[0]).toBeGreaterThan(markInline.mock.invocationCallOrder[0]!);
      expect(suspend).not.toHaveBeenCalled();
      expect(get.mock.invocationCallOrder[0]).toBeGreaterThan(flush.mock.invocationCallOrder[0]!);
    } else {
      expect(suspend).toHaveBeenCalledTimes(1);
      expect(push).not.toHaveBeenCalled();
      expect(markInline).not.toHaveBeenCalled();
      if (mode === "interaction" || mode === "code_open") expect(get).not.toHaveBeenCalled();
      if (mode === "late") expect(get).toHaveBeenCalled();
      if (mode === "abort") expect(performance.now() - started).toBeLessThan(heartbeatMs / 2);
    }
  } finally {
    clearTimeout(timer);
    loop.abort();
    config.mockRestore();
    save.mockRestore();
    get.mockRestore();
    markInline.mockRestore();
    suspend.mockRestore();
    audit.mockRestore();
    apply.mockRestore();
    flush.mockRestore();
    push.mockRestore();
  }
});
