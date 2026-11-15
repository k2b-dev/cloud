import { describe, expect, test } from "bun:test";
import type { Message } from "@k2b/nessi";
import { visibleMessages } from "./client/projection";
import { buildBlocksFromMessages } from "./protocol";
import { projectPublicAiStoredMessages } from "./public-projection";
import type { AiStoredMessage } from "./types";

const stored = (id: string, role: Extract<Message["role"], "user" | "assistant">, loopId: string | null): AiStoredMessage => ({
  id,
  shortId: id,
  conversationId: "internal-conversation",
  seq: role === "user" ? 1 : 2,
  kind: "message",
  message:
    role === "user"
      ? { role, content: [{ type: "text", text: "go" }] }
      : { role, content: [{ type: "text", text: "working" }], stopReason: "tool_use" },
  loopId,
  modelId: null,
  providerModel: null,
  usage: null,
  stopReason: role === "assistant" ? "tool_use" : null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta: null,
  createdAt: new Date(0).toISOString(),
});

describe("public AI message projection", () => {
  test("uses the public Turn id for message loops and hides active assistant rounds", () => {
    const messages = projectPublicAiStoredMessages(
      [stored("user-1", "user", "internal-turn"), stored("assistant-1", "assistant", "internal-turn")],
      "public-conversation",
      new Map([["internal-turn", "public-turn"]]),
    );

    expect(messages.map((message) => message.loopId)).toEqual(["public-turn", "public-turn"]);
    expect(
      visibleMessages({
        conversation: null,
        messages,
        activeTurn: { turnId: "public-turn", attempt: 1, seq: 1, status: "running", blocks: [], modelId: null },
      }).map((message) => message.id),
    ).toEqual(["user-1"]);
  });

  test("never exposes an unresolved internal loop id", () => {
    const [message] = projectPublicAiStoredMessages(
      [stored("assistant-1", "assistant", "internal-turn")],
      "public-conversation",
      new Map(),
    );
    expect(message?.loopId).toBeNull();
  });
});

test("public message reads deliver the same bound blocks as live tool blocks while storage stays raw", () => {
  const call: AiStoredMessage = {
    ...stored("call", "assistant", "turn"),
    message: { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "demo__query__get", args: {} }] },
  };
  const raw = {
    data: { rows: [{ name: "Vase" }] },
    view: {
      version: 1,
      blocks: [{ kind: "Table", title: "Objects", rows: { from: ["rows"] }, columns: [{ path: ["name"], label: "Name" }] }],
    },
  };
  const result: AiStoredMessage = {
    ...stored("result", "assistant", "turn"),
    seq: 3,
    message: { role: "tool_result", callId: "call-1", name: "demo__query__get", result: raw },
  };
  const publicMessages = projectPublicAiStoredMessages([call, result], "chat", new Map([["turn", "public-turn"]]));
  const block = buildBlocksFromMessages(publicMessages)[0];
  expect(block).toMatchObject({ kind: "tool", view: { version: 1, blocks: [{ kind: "Table", rows: raw.data.rows }] } });
  expect(result.meta).toBeNull();
  expect(result.message.role === "tool_result" ? result.message.result : null).toEqual(raw);
});
