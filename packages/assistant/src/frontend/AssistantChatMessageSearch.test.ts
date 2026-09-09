import { describe, expect, test } from "bun:test";
import type { AiConversationTimelineEntry, AiStoredMessage } from "@k2b/cloud/ai";
import { assistantMessageAnchorSeq, assistantMessageSearchItem } from "./AssistantChatMessageSearch";

const stored = (input: { role: "user" | "assistant"; seq: number; text: string; loopId?: string | null }): AiStoredMessage => ({
  id: `message-${input.seq}`,
  shortId: `message-${input.seq}`,
  conversationId: "chat-1",
  seq: input.seq,
  kind: "message",
  message:
    input.role === "user"
      ? { role: "user", content: [{ type: "text", text: input.text }] }
      : { role: "assistant", content: [{ type: "text", text: input.text }], stopReason: "stop" },
  loopId: input.loopId ?? null,
  modelProfileId: null,
  providerModel: null,
  usage: null,
  stopReason: input.role === "assistant" ? "stop" : null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta: null,
  createdAt: new Date(0).toISOString(),
});

const turn = (seq: number, loopId: string | null): AiConversationTimelineEntry => ({
  id: `turn-${seq}`,
  seq,
  loopId,
  userPreview: "Question",
  assistantPreview: "Answer",
  isSteer: false,
  inputFileCount: 0,
  outputFileCount: 0,
  toolCount: 0,
  createdAt: new Date(0).toISOString(),
});

describe("Assistant chat message search", () => {
  test("maps messages to compact Spotlight results", () => {
    expect(assistantMessageSearchItem(stored({ role: "assistant", seq: 4, text: "First\n\nsecond", loopId: "loop-1" }))).toMatchObject({
      label: "First second",
      desc: "Assistant · Message 4",
      icon: "ti ti-sparkles",
    });
  });

  test("targets user messages directly and assistant messages through their Turn", () => {
    const timeline = [turn(1, "loop-1"), turn(5, "loop-2")];
    expect(assistantMessageAnchorSeq(stored({ role: "user", seq: 5, text: "Question", loopId: "loop-2" }), timeline)).toBe(5);
    expect(assistantMessageAnchorSeq(stored({ role: "assistant", seq: 7, text: "Answer", loopId: "loop-2" }), timeline)).toBe(5);
    expect(assistantMessageAnchorSeq(stored({ role: "assistant", seq: 8, text: "Legacy" }), timeline)).toBe(5);
  });
});
