import { expect, spyOn, test } from "bun:test";
import { type Message, nessi, type Provider, type ProviderRequest } from "@k2b/nessi";
import { buildEnrichmentTranscript } from "./enrich";
import { answerOpenToolCalls } from "./open-tool-calls";
import { projectPublicAiStoredMessages } from "./public-projection";
import { aiConversations } from "./store";
import { buildAiMessageTimeline } from "./timeline";
import type { AiStoredMessage } from "./types";

for (const providerName of ["anthropic", "gemini", "openrouter"]) {
  test(`${providerName}: stored reasoning and producer survive projections and the next provider request unchanged`, async () => {
    const assistant: Message = {
      role: "assistant",
      provider: providerName,
      model: "fixture",
      stopReason: "tool_use",
      content: [
        { type: "thinking", thinking: "Plan", signature: "signed-reasoning" },
        { type: "thinking", thinking: "", redacted: "encrypted", details: [{ type: "reasoning.encrypted", data: "opaque", index: 0 }] },
        { type: "text", text: "Checking", signature: "signed-text" },
        { type: "tool_call", id: "call", name: "read", args: {}, signature: "signed-call" },
      ],
    };
    const stored: AiStoredMessage = {
      id: "internal",
      shortId: "public",
      conversationId: "chat",
      seq: 1,
      kind: "message",
      message: JSON.parse(JSON.stringify(assistant)),
      loopId: "old-turn",
      modelProfileId: null,
      providerModel: "fixture",
      usage: null,
      stopReason: "tool_use",
      loopAggregate: null,
      loopDoneReason: null,
      compactedAt: null,
      meta: null,
      createdAt: new Date(0).toISOString(),
    };
    // These read projections must never rewrite the canonical provider history.
    buildAiMessageTimeline([stored]);
    buildEnrichmentTranscript([stored]);
    projectPublicAiStoredMessages([stored], "public-chat", new Map([["old-turn", "public-turn"]]));
    const list = spyOn(aiConversations, "listContextMessages").mockResolvedValue([stored]);
    const session = aiConversations.createSessionStore({ conversationId: "chat" });
    const append = spyOn(session, "append").mockResolvedValue(undefined);
    const requests: ProviderRequest[] = [];
    const provider: Provider = {
      name: providerName,
      family: "openai-compatible",
      model: "fixture",
      capabilities: { streaming: true, tools: true, images: false, thinking: true, usage: true },
      complete: async () => {
        throw new Error("Unexpected completion");
      },
      async *stream(request) {
        requests.push(request);
        yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "stop" };
      },
    };
    try {
      for await (const _event of nessi({
        systemPrompt: "Test",
        store: session,
        provider: answerOpenToolCalls(provider),
        input: "Continue",
      })) {
      }
      expect(requests[0]?.messages[0]).toEqual(assistant);
      expect(requests[0]?.messages[1]).toMatchObject({ role: "tool_result", callId: "call", isError: true });
      expect(stored.message).toEqual(assistant);
    } finally {
      append.mockRestore();
      list.mockRestore();
    }
  });
}
