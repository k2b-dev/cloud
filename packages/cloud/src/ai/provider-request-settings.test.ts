import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { memoryStore, nessi, type StoreEntry } from "@k2b/nessi";
import { complete } from "@k2b/nessi/ai";
import { z } from "zod";
import { createCloudCompactFn } from "./compaction";
import { createAiProvider, taskReasoningEffort } from "./provider";
import * as connections from "./provider-connections";
import { inferenceProvider } from "./quota-provider";
import { aiConversations } from "./store";
import * as structuredRuns from "./structured-runs";
import { applyAiTurnPolicy } from "./turn-policy";
import type { AiModelProfile, AiProviderId } from "./types";

// Adapter unit tests own HTTP fakes; provider status persistence belongs to its integration seam.
beforeEach(() => spyOn(connections, "recordAiProviderStatus").mockResolvedValue(undefined));
afterEach(() => mock.restore());

// A local HTTP fake exercises the real adapters without replacing the global fetch timing wrapper.
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});
const providers: AiProviderId[] = ["openai", "openrouter", "vllm", "openai-compatible", "anthropic", "gemini", "ollama", "mistral"];
// Every provider type is an OpenAI-compatible chat endpoint.
const streaming = () =>
  `data: {"choices":[{"delta":{"content":${JSON.stringify('{"answer":"ok"}')}}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n`;
/** The thinking fields of a request: the profile's level for a loop, the task level for structured calls and compaction. */
const expectedThinking = (provider: AiProviderId, task = false) => {
  const effort = task ? taskReasoningEffort(provider) : "medium";
  if (effort === undefined) return {};
  return provider === "openrouter" ? { reasoning: { effort } } : { reasoning_effort: effort };
};

for (const providerId of providers)
  test(`${providerId}: loop thinking level, all-call extra parameters and preserved structured/compaction reasoning`, async () => {
    const requests: { body: Record<string, unknown>; headers: Headers; url: string }[] = [];
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = z.record(z.string(), z.unknown()).parse(await request.json());
        requests.push({ body, headers: request.headers, url: request.url });
        expect(body.stream).toBe(true);
        return new Response(streaming(), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const profile: AiModelProfile = {
      modelId: "test",
      providerId: "test",
      variantLabel: "Standard",
      description: "",
      icon: { kind: "provider" },
      showInPicker: true,
      id: "test",
      label: "Test",
      provider: providerId,
      model: "test",
      baseURL: `http://localhost:${server.port}/v1`,
      enabled: true,
      capabilities: [],
      dataBoundary: "private",
      reasoningEffort: "medium",
      extraBody: { custom: { feature: true } },
    };
    const rawProvider = createAiProvider(profile, "api-key", { "X-Secret": "header-secret", Authorization: "custom-authorization" });
    const counted = inferenceProvider(
      rawProvider,
      profile,
      { kind: "chat", task: "chat" },
      {
        begin: async () => ({ id: crypto.randomUUID(), maxOutputTokens: undefined }),
        finish: async () => {},
        heartbeat: async () => {},
      },
    );
    const policy = applyAiTurnPolicy({
      provider: counted,
      tools: [],
      issuedToolRounds: 0,
      completedToolRounds: 0,
      deadline: null,
      runBudgetMs: null,
    });
    const loop = nessi({
      systemPrompt: "Test",
      store: memoryStore(),
      agentId: "test",
      provider: policy.provider,
      tools: policy.tools,
      input: "hello",
      reasoningEffort: profile.reasoningEffort,
    });
    let reason: string | undefined;
    for await (const event of loop) if (event.type === "loop_end") reason = event.reason;
    expect(reason).toBe("stop");
    expect(requests[0]!.body).toMatchObject({ ...expectedThinking(providerId), custom: { feature: true } });
    if (providerId === "vllm" || providerId === "openai-compatible") {
      expect(requests[0]!.headers.get("X-Secret")).toBe("header-secret");
      expect(requests[0]!.headers.get("Authorization")).toBe("Bearer api-key");
    } else expect(requests[0]!.headers.get("X-Secret")).toBeNull();

    await nessi.structured({
      provider: counted,
      input: "title",
      output: z.object({ answer: z.string() }),
      reasoningEffort: taskReasoningEffort(providerId),
    });
    expect(requests[1]!.body).toMatchObject({ ...expectedThinking(providerId, true), custom: { feature: true } });
    if (rawProvider.capabilities.structuredOutput === true) {
      switch (providerId) {
        case "openai":
        case "openrouter":
        case "mistral":
        case "anthropic":
        case "gemini":
        case "ollama":
          expect(requests[1]!.body).toHaveProperty("response_format.type", "json_schema");
          expect(requests[1]!.body).toHaveProperty("response_format.json_schema.schema.properties.answer.type", "string");
          break;
        case "vllm":
          expect(requests[1]!.body).toHaveProperty("structured_outputs.json.properties.answer.type", "string");
          break;
        case "openai-compatible":
          throw new Error("The generic adapter should not advertise native structured output");
      }
    } else {
      expect(requests[1]!.body).not.toHaveProperty("response_format");
      expect(requests[1]!.body).not.toHaveProperty("structured_outputs");
    }

    const compactMessages = spyOn(aiConversations, "compactMessages").mockResolvedValue(undefined);
    const recordStructuredRun = spyOn(structuredRuns, "safelyRecordStructuredRun").mockResolvedValue(undefined);
    const entries: StoreEntry[] = Array.from({ length: 8 }, (_, i) => ({
      seq: i + 1,
      kind: "message",
      message:
        i % 2 === 0
          ? { role: "user", content: [{ type: "text", text: "hello" }] }
          : { role: "assistant", content: [{ type: "text", text: "answer" }] },
    }));
    try {
      await createCloudCompactFn({
        conversationId: "test",
        modelId: "test",
        providerType: providerId,
        additionalInstructions: "",
        signal: new AbortController().signal,
      })({
        entries,
        store: { load: async () => entries, append: async () => {} },
        provider: counted,
        usage: { input: 0, output: 0, total: 0 },
        force: false,
        fillRatio: 0.9,
      });
    } finally {
      compactMessages.mockRestore();
      recordStructuredRun.mockRestore();
    }
    expect(requests).toHaveLength(3);
    expect(requests[2]!.body).toMatchObject({ ...expectedThinking(providerId, true), custom: { feature: true } });
    for (const request of [requests[1]!, requests[2]!]) {
      if (providerId === "anthropic" || providerId === "mistral" || providerId === "ollama")
        for (const key of ["thinking", "reasoning_effort", "think", "reasoning"]) expect(request.body[key]).toBeUndefined();
      if (providerId === "openai" || providerId === "vllm" || providerId === "openai-compatible")
        expect(request.body.reasoning).toBeUndefined();
    }
    if (providerId === "vllm" || providerId === "openai-compatible") {
      for (const request of requests) expect(request.headers.get("X-Secret")).toBe("header-secret");
    }
    await complete(createAiProvider({ ...profile, reasoningEffort: undefined, extraBody: undefined }, "api-key"), { messages: [] });
    const defaultBody = requests[3]!.body;
    for (const key of ["reasoning_effort", "reasoning", "thinking", "think", "custom"]) expect(defaultBody[key]).toBeUndefined();
    expect(defaultBody.generationConfig).toBeUndefined();
  });

test("interrupted provider streams finish the loop as errors instead of successful answers", async () => {
  server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response('data: {"choices":[{"delta":{"content":"Partial answer"}}]}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      }),
  });
  const profile: AiModelProfile = {
    modelId: "partial",
    providerId: "partial",
    variantLabel: "Standard",
    description: "",
    icon: { kind: "provider" },
    showInPicker: true,
    id: "partial",
    label: "Partial",
    provider: "vllm",
    model: "test",
    baseURL: `http://localhost:${server.port}/v1`,
    enabled: true,
    capabilities: [],
    dataBoundary: "private",
  };
  const store = memoryStore();
  let reason: string | undefined;
  for await (const event of nessi({ agentId: "test", systemPrompt: "Test", store, provider: createAiProvider(profile), input: "Hello" }))
    if (event.type === "loop_end") reason = event.reason;
  expect(reason).toBe("error");
  expect((await store.load()).some((entry) => entry.message.role === "assistant" && entry.message.stopReason === "stop")).toBeFalse();
});
