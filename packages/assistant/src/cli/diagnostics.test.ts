import { describe, expect, test } from "bun:test";
import type { AiConversation, AiStoredMessage } from "@valentinkolb/cloud/ai";
import { buildAssistantChatDiagnostic } from "./diagnostics";

const stored = (input: Pick<AiStoredMessage, "seq" | "message"> & Partial<AiStoredMessage>): AiStoredMessage => ({
  id: `message-${input.seq}`,
  shortId: `m${input.seq}`,
  conversationId: "chat-1",
  kind: "message",
  loopId: "loop-1",
  modelProfileId: null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta: null,
  createdAt: `2026-08-20T10:00:0${input.seq}.000Z`,
  ...input,
});

const conversation = {
  id: "chat-1",
  title: "Diagnose me",
  runStatus: "idle",
  projectId: null,
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:04.000Z",
} satisfies Pick<AiConversation, "id" | "title" | "runStatus" | "projectId" | "createdAt" | "updatedAt">;

describe("Assistant chat diagnostics", () => {
  test("pairs tool calls and results while keeping surrounding assistant text in order", () => {
    const diagnostic = buildAssistantChatDiagnostic({
      conversation,
      messages: [
        stored({ seq: 1, message: { role: "user", content: [{ type: "text", text: "Find it" }] } }),
        stored({
          seq: 2,
          modelProfileId: "model-profile",
          providerModel: "provider-model",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Searching." },
              { type: "tool_call", id: "call-1", name: "search", args: { query: "invoice" } },
            ],
          },
        }),
        stored({
          seq: 3,
          message: { role: "tool_result", callId: "call-1", name: "search", result: { hits: 2 }, isError: false },
        }),
        stored({ seq: 4, message: { role: "assistant", content: [{ type: "text", text: "Found two." }] } }),
      ],
    });

    expect(diagnostic.version).toBe(1);
    expect(diagnostic.turns).toHaveLength(1);
    expect(diagnostic.turns[0]?.modelProfiles).toEqual(["model-profile"]);
    expect(diagnostic.turns[0]?.providerModels).toEqual(["provider-model"]);
    expect(diagnostic.turns[0]?.events).toEqual([
      {
        type: "user",
        seq: 1,
        at: "2026-08-20T10:00:01.000Z",
        content: [{ type: "text", text: "Find it" }],
      },
      {
        type: "assistant",
        seq: 2,
        at: "2026-08-20T10:00:02.000Z",
        content: [{ type: "text", text: "Searching." }],
      },
      {
        type: "tool",
        callId: "call-1",
        name: "search",
        callSeq: 2,
        resultSeq: 3,
        requestedAt: "2026-08-20T10:00:02.000Z",
        completedAt: "2026-08-20T10:00:03.000Z",
        status: "completed",
        args: { query: "invoice" },
        result: { hits: 2 },
      },
      {
        type: "assistant",
        seq: 4,
        at: "2026-08-20T10:00:04.000Z",
        content: [{ type: "text", text: "Found two." }],
      },
    ]);
  });

  test("keeps failed and orphaned tool results diagnosable", () => {
    const diagnostic = buildAssistantChatDiagnostic({
      conversation,
      messages: [
        stored({
          seq: 1,
          message: { role: "tool_result", callId: "call-1", name: "read", result: "NOT_FOUND", isError: true },
        }),
      ],
    });

    expect(diagnostic.turns[0]?.events[0]).toMatchObject({
      type: "tool",
      callId: "call-1",
      name: "read",
      callSeq: null,
      resultSeq: 1,
      status: "failed",
      result: "NOT_FOUND",
    });
  });
});
