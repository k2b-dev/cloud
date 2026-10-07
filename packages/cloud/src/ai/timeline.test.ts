import { describe, expect, test } from "bun:test";
import type { Message } from "@k2b/nessi";
import { buildAiMessageTimeline } from "./timeline";
import type { AiStoredMessage } from "./types";

const stored = (input: {
  id: string;
  seq: number;
  message: Message;
  loopId?: string | null;
  loopAggregate?: AiStoredMessage["loopAggregate"];
  createdAt?: string;
}): AiStoredMessage => ({
  id: input.id,
  shortId: input.id,
  conversationId: "conversation-1",
  seq: input.seq,
  kind: "message",
  message: input.message,
  loopId: input.loopId ?? null,
  modelProfileId: null,
  providerModel: null,
  usage: null,
  stopReason: input.message.role === "assistant" ? (input.message.stopReason ?? null) : null,
  loopAggregate: input.loopAggregate ?? null,
  loopDoneReason: input.loopAggregate ? "stop" : null,
  compactedAt: null,
  meta: null,
  createdAt: input.createdAt ?? new Date(0).toISOString(),
});

describe("AI message timeline", () => {
  test("groups one loop into one assistant response with unified blocks", () => {
    const firstAssistant: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "Here is the card." },
        { type: "tool_call", id: "call-card", name: "card", args: { title: "Status", value: "Online" } },
      ],
      stopReason: "tool_use",
    };
    const toolResult: Message = { role: "tool_result", callId: "call-card", name: "card", result: { displayed: true } };
    const finalAssistant: Message = { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" };

    const timeline = buildAiMessageTimeline([
      stored({ id: "user-1", seq: 1, message: { role: "user", content: [{ type: "text", text: "test" }] } }),
      stored({ id: "assistant-1", seq: 2, message: firstAssistant, loopId: "loop-1" }),
      stored({ id: "tool-1", seq: 3, message: toolResult, loopId: "loop-1" }),
      stored({ id: "assistant-2", seq: 4, message: finalAssistant, loopId: "loop-1" }),
    ]);

    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({ type: "user" });

    const group = timeline[1];
    if (group?.type !== "assistant") throw new Error("expected assistant group");
    expect(group.loopId).toBe("loop-1");
    expect(group.entries).toHaveLength(3);
    // Blocks: text, tool (completed via tool_result), text.
    expect(group.blocks.map((block) => block.kind)).toEqual(["text", "tool", "text"]);
    const toolBlock = group.blocks.find((block) => block.kind === "tool");
    expect(toolBlock).toMatchObject({ kind: "tool", callId: "call-card", status: "completed" });
    expect(group.actionEntry?.id).toBe("assistant-2");
  });

  test("workedMs spans from the triggering user message to the last persisted round", () => {
    const timeline = buildAiMessageTimeline([
      stored({
        id: "user-1",
        seq: 1,
        message: { role: "user", content: [{ type: "text", text: "go" }] },
        loopId: "loop-1",
        createdAt: "2026-07-09T10:00:00.000Z",
      }),
      stored({
        id: "assistant-1",
        seq: 2,
        message: { role: "assistant", content: [{ type: "text", text: "working" }], stopReason: "tool_use" },
        loopId: "loop-1",
        createdAt: "2026-07-09T10:00:05.000Z",
      }),
      stored({
        id: "assistant-2",
        seq: 3,
        message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
        loopId: "loop-1",
        createdAt: "2026-07-09T10:00:08.000Z",
      }),
    ]);

    const group = timeline[1];
    if (group?.type !== "assistant") throw new Error("expected assistant group");
    expect(group.workedMs).toBe(8_000);
  });

  test("workedMs falls back to the group's own entries for legacy loops", () => {
    const timeline = buildAiMessageTimeline([
      stored({ id: "user-1", seq: 1, message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      stored({
        id: "assistant-1",
        seq: 2,
        message: { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop" },
        createdAt: "2026-07-09T10:00:03.000Z",
      }),
    ]);

    const group = timeline[1];
    if (group?.type !== "assistant") throw new Error("expected assistant group");
    expect(group.workedMs).toBe(0);
  });

  test("splits distinct loops into separate assistant groups", () => {
    const timeline = buildAiMessageTimeline([
      stored({ id: "u1", seq: 1, message: { role: "user", content: [{ type: "text", text: "one" }] } }),
      stored({
        id: "a1",
        seq: 2,
        message: { role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "stop" },
        loopId: "loop-1",
      }),
      stored({ id: "u2", seq: 3, message: { role: "user", content: [{ type: "text", text: "two" }] } }),
      stored({
        id: "a2",
        seq: 4,
        message: { role: "assistant", content: [{ type: "text", text: "second" }], stopReason: "stop" },
        loopId: "loop-2",
      }),
    ]);

    expect(timeline.map((item) => item.type)).toEqual(["user", "assistant", "user", "assistant"]);
    const [, first, , second] = timeline;
    if (first?.type !== "assistant" || second?.type !== "assistant") throw new Error("expected assistant groups");
    expect(first.loopId).toBe("loop-1");
    expect(second.loopId).toBe("loop-2");
  });

  test("folds a steering marker into the next assistant response in the same loop", () => {
    const timeline = buildAiMessageTimeline([
      stored({ id: "u1", seq: 1, message: { role: "user", content: [{ type: "text", text: "start" }] }, loopId: "loop-1" }),
      stored({
        id: "a1",
        seq: 2,
        message: { role: "assistant", content: [{ type: "text", text: "initial" }], stopReason: "stop" },
        loopId: "loop-1",
      }),
      {
        ...stored({ id: "u2", seq: 3, message: { role: "user", content: [{ type: "text", text: "change course" }] }, loopId: "loop-1" }),
        meta: { steerId: "steer-1" },
      },
      stored({
        id: "a2",
        seq: 4,
        message: { role: "assistant", content: [{ type: "text", text: "revised" }], stopReason: "stop" },
        loopId: "loop-1",
      }),
    ]);

    expect(timeline.map((item) => item.type)).toEqual(["user", "assistant", "user", "assistant"]);
    const final = timeline[3];
    if (final?.type !== "assistant") throw new Error("expected assistant group");
    expect(final.blocks).toEqual([
      { id: "steer-applied-steer-1", kind: "steer_applied", steerId: "steer-1" },
      expect.objectContaining({ kind: "text", text: "revised" }),
    ]);
    expect(timeline[1]?.id).not.toBe(final.id);
  });

  test("keeps one applied marker per steering message in an ordered batch", () => {
    const timeline = buildAiMessageTimeline([
      {
        ...stored({ id: "u1", seq: 1, message: { role: "user", content: [{ type: "text", text: "first" }] }, loopId: "loop-1" }),
        meta: { steerId: "s1" },
      },
      {
        ...stored({ id: "u2", seq: 2, message: { role: "user", content: [{ type: "text", text: "second" }] }, loopId: "loop-1" }),
        meta: { steerId: "s2" },
      },
      stored({
        id: "a1",
        seq: 3,
        message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
        loopId: "loop-1",
      }),
    ]);
    expect(timeline.map((item) => item.type)).toEqual(["user", "user", "assistant"]);
    const response = timeline[2];
    if (response?.type !== "assistant") throw new Error("expected assistant group");
    expect(response.blocks.slice(0, 2).map((block) => block.id)).toEqual(["steer-applied-s1", "steer-applied-s2"]);
  });

  test("keeps a standalone marker when no assistant response follows the steer", () => {
    const timeline = buildAiMessageTimeline([
      {
        ...stored({ id: "u1", seq: 1, message: { role: "user", content: [{ type: "text", text: "change course" }] }, loopId: "loop-1" }),
        meta: { steerId: "s1" },
      },
    ]);

    expect(timeline.map((item) => item.type)).toEqual(["user", "assistant"]);
    expect(timeline[1]?.type === "assistant" ? timeline[1].blocks[0]?.id : null).toBe("steer-applied-s1");
  });

  test("renders summary rows as their own items", () => {
    const timeline = buildAiMessageTimeline([
      {
        ...stored({ id: "s1", seq: 1, message: { role: "assistant", content: [{ type: "text", text: "summary" }], stopReason: "stop" } }),
        kind: "summary",
      },
      stored({ id: "u1", seq: 2, message: { role: "user", content: [{ type: "text", text: "next" }] } }),
    ]);
    expect(timeline[0]).toMatchObject({ type: "summary" });
    expect(timeline[1]).toMatchObject({ type: "user" });
  });

  test("workedMs is the loop's wall time minus its waits for user actions when durable timing exists", () => {
    const timing = { wallMs: 300_000, totalElapsedMs: 300_000, generationMs: 60_000, actionWaitMs: 120_000, toolExecutionMs: 90_000 };
    const timeline = buildAiMessageTimeline([
      stored({ id: "u1", seq: 1, message: { role: "user", content: [{ type: "text", text: "go" }] }, loopId: "loop-1" }),
      stored({
        id: "a1",
        seq: 2,
        message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
        loopId: "loop-1",
        loopAggregate: {
          turns: [],
          timing,
          issueCount: 0,
          issues: [],
          toolCallCount: 0,
          toolErrorCount: 0,
          toolIssueCount: 0,
          toolMalformedCount: 0,
          toolCancelledCount: 0,
          toolIssues: [],
          assistantMessageCount: 1,
        },
        createdAt: "2026-07-09T10:30:00.000Z",
      }),
    ]);
    const group = timeline[1];
    if (group?.type !== "assistant") throw new Error("expected assistant group");
    expect(group.workedMs).toBe(180_000);
  });
});
