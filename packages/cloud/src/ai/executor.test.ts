import { describe, expect, test } from "bun:test";
import type { OutboundEvent, Provider, Tool } from "@k2b/nessi";
import { __aiExecutorTest } from "./executor";
import { messageBlockId, streamBlockId, toolBlockId } from "./protocol";

const { applyToolRoundPolicy, createEventMapper, rebuildAttemptBaseline, rebuildBlocksFromMessages } = __aiExecutorTest;

const turn = { agentId: "cloud", loopId: "turn-1", turnId: "turn-1:turn:0", turnIndex: 0 };

describe("nessi block event mapping", () => {
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
        { seq: 2, message: { role: "tool_result", callId: "editor", name: "text_editor", result: persistedResult } },
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

    expect(blocks[0]).toMatchObject({ kind: "tool", callId: "editor", status: "completed", result: persistedResult });
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
    expect(ops[0]).toMatchObject({ type: "block_set", block: { id: toolBlockId("call-2"), status: "failed", isError: true } });

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

  test("loop lifecycle and usage events map to nothing", () => {
    const mapper = createEventMapper(1, []);
    expect(mapper.translate({ type: "loop_start", agentId: "cloud", loopId: "turn-1" } as OutboundEvent)).toEqual([]);
    expect(mapper.translate({ ...turn, type: "turn_start" } as OutboundEvent)).toEqual([]);
    expect(mapper.translate({ ...turn, type: "usage", usage: { input: 1, output: 1, total: 2 } } as OutboundEvent)).toEqual([]);
  });
});

describe("tool round policy", () => {
  const request = { systemPrompt: "Base prompt", messages: [] };
  const tool = {} as Tool;
  const provider = (prompts: string[]): Provider => ({
    name: "test",
    family: "openai-compatible",
    model: "test",
    capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: false },
    complete: async () => {
      throw new Error("not used");
    },
    stream: async function* (input) {
      prompts.push(input.systemPrompt ?? "");
      yield {
        type: "block_end",
        blockId: "call",
        index: 0,
        block: { type: "tool_call", id: "call", name: "test", args: {} },
      };
    },
  });

  test("does not configure a turn limit by default", () => {
    const originalProvider = provider([]);
    const originalTools = [tool];
    const policy = applyToolRoundPolicy({
      provider: originalProvider,
      tools: originalTools,
      issuedToolRounds: 0,
      completedToolRounds: 0,
    });

    expect(policy.provider).toBe(originalProvider);
    expect(policy.tools).toBe(originalTools);
    expect(policy.maxTurns).toBeUndefined();
  });

  test("reserves one tool-free provider call for the final answer", async () => {
    const prompts: string[] = [];
    const policy = applyToolRoundPolicy({
      provider: provider(prompts),
      tools: [tool],
      maxToolRounds: 1,
      issuedToolRounds: 0,
      completedToolRounds: 0,
    });

    expect(policy.maxTurns).toBe(2);
    expect(await (policy.tools as () => Promise<Tool[]>)()).toEqual([tool]);
    for await (const _event of policy.provider.stream(request)) {
      // consume the first tool-using provider round
    }
    policy.noteToolRound();
    expect(await (policy.tools as () => Promise<Tool[]>)()).toEqual([]);
    for await (const _event of policy.provider.stream(request)) {
      // consume the reserved final provider round
    }

    expect(prompts[0]).toBe("Base prompt");
    expect(prompts[1]).toContain("no more tools are available");
    expect(prompts[1]).toContain("best result supported by the evidence already gathered");
  });

  test("counts persisted tool rounds across resumed workers", async () => {
    const prompts: string[] = [];
    const policy = applyToolRoundPolicy({
      provider: provider(prompts),
      tools: [tool],
      maxToolRounds: 2,
      issuedToolRounds: 2,
      completedToolRounds: 2,
    });

    expect(policy.maxTurns).toBe(1);
    expect(await (policy.tools as () => Promise<Tool[]>)()).toEqual([]);
    for await (const _event of policy.provider.stream(request)) {
      // consume the reserved final provider round
    }
    expect(prompts[0]).toContain("no more tools are available");
  });

  test("keeps a pending last-round tool available until its resumed execution completes", async () => {
    const policy = applyToolRoundPolicy({
      provider: provider([]),
      tools: [tool],
      maxToolRounds: 1,
      issuedToolRounds: 1,
      completedToolRounds: 0,
    });

    expect(policy.maxTurns).toBe(1);
    expect(await (policy.tools as () => Promise<Tool[]>)()).toEqual([tool]);
    policy.noteToolRound();
    expect(await (policy.tools as () => Promise<Tool[]>)()).toEqual([]);
  });
});
