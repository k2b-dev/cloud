import { describe, expect, test } from "bun:test";
import type { Message } from "@k2b/nessi";
import { visibleMessages } from "./client/projection";
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
