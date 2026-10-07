import { afterEach, expect, spyOn, test } from "bun:test";
import { memoryStore, nessi, type StoreEntry } from "@k2b/nessi";
import { z } from "zod";
import { createCloudCompactFn } from "./compaction";
import { createAiProvider } from "./provider";
import { inferenceProvider } from "./quota-provider";
import { aiConversations } from "./store";
import * as structuredRuns from "./structured-runs";
import { applyAiTurnPolicy } from "./turn-policy";
import type { AiModelProfile, AiProviderId } from "./types";

// A local HTTP fake exercises the real adapters without replacing the global fetch timing wrapper.
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});
const providers: AiProviderId[] = ["openai", "openrouter", "vllm", "openai-compatible", "anthropic", "gemini", "ollama", "mistral"];
const completion = (provider: AiProviderId, text = '{"answer":"ok"}') => {
  if (provider === "anthropic")
    return { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
  if (provider === "gemini")
    return {
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    };
  if (provider === "ollama") return { message: { content: text }, done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 };
  return { choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
};
const streaming = (provider: AiProviderId) => {
  if (provider === "anthropic")
    return 'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"ok"}}\n\nevent: content_block_stop\ndata: {"index":0}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {}\n\n';
  if (provider === "gemini") return `data: ${JSON.stringify(completion(provider, "ok"))}\n\n`;
  if (provider === "ollama") return `${JSON.stringify(completion(provider, "ok"))}\n`;
  return 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
};
const expectedThinking = (provider: AiProviderId, disabled = false) => {
  if (provider === "anthropic") return disabled ? {} : { thinking: { type: "adaptive" }, output_config: { effort: "medium" } };
  if (provider === "gemini")
    return { generationConfig: { thinkingConfig: disabled ? { thinkingBudget: 0 } : { thinkingLevel: "medium" } } };
  if (provider === "ollama") return disabled ? {} : { think: "medium" };
  if (provider === "mistral") return disabled ? {} : { reasoning_effort: "medium" };
  if (provider === "openrouter" && !disabled) return { reasoning: { effort: "medium" } };
  return { reasoning_effort: disabled ? "low" : "medium" };
};

for (const providerId of providers)
  test(`${providerId}: loop thinking level, all-call extra parameters and disabled structured/compaction reasoning`, async () => {
    const requests: { body: Record<string, unknown>; headers: Headers }[] = [];
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = z.record(z.string(), z.unknown()).parse(await request.json());
        requests.push({ body, headers: request.headers });
        const isStream = body.stream === true || request.url.includes("streamGenerateContent");
        return isStream
          ? new Response(streaming(providerId), {
              headers: { "Content-Type": providerId === "ollama" ? "application/x-ndjson" : "text/event-stream" },
            })
          : Response.json(completion(providerId));
      },
    });
    const profile: AiModelProfile = {
      id: "test",
      label: "Test",
      provider: providerId,
      model: "test",
      baseURL: `http://localhost:${server.port}/v1`,
      enabled: true,
      capabilities: ["streaming"],
      dataBoundary: "private",
      reasoningEffort: "medium",
      extraBody: { custom: { feature: true } },
    };
    const booked: (number | undefined)[] = [];
    const rawProvider = createAiProvider(profile, "api-key", { "X-Secret": "header-secret", Authorization: "custom-authorization" });
    const counted = inferenceProvider(rawProvider, profile, { kind: "chat", task: "chat" }, undefined, {
      begin: async (_profile, _context, _tokens, _max, defaultOutputTokens) => {
        booked.push(defaultOutputTokens);
        return { id: crypto.randomUUID(), maxOutputTokens: undefined };
      },
      finish: async () => {},
      heartbeat: async () => {},
    });
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
    if (providerId === "anthropic") expect(booked[0]).toBe(8192);

    await nessi.structured({
      agentId: "test",
      provider: counted,
      input: "title",
      output: z.object({ answer: z.string() }),
      disableReasoning: true,
    });
    expect(requests[1]!.body).toMatchObject({ ...expectedThinking(providerId, true), custom: { feature: true } });
    expect(requests[1]!.body.reasoning).toBeUndefined();
    if (["anthropic", "mistral", "ollama"].includes(providerId)) {
      expect(requests[1]!.body.reasoning_effort).toBeUndefined();
      expect(requests[1]!.body.think).toBeUndefined();
      expect(requests[1]!.body.thinking).toBeUndefined();
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
        modelProfileId: "test",
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
    if (providerId === "vllm" || providerId === "openai-compatible") {
      for (const request of requests) expect(request.headers.get("X-Secret")).toBe("header-secret");
    }
    expect(requests[2]!.body.reasoning).toBeUndefined();
    if (["anthropic", "mistral", "ollama"].includes(providerId)) {
      expect(requests[2]!.body.reasoning_effort).toBeUndefined();
      expect(requests[2]!.body.think).toBeUndefined();
      expect(requests[2]!.body.thinking).toBeUndefined();
    }
    await createAiProvider({ ...profile, reasoningEffort: undefined, extraBody: undefined }, "api-key").complete({ messages: [] });
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
    id: "partial",
    label: "Partial",
    provider: "vllm",
    model: "test",
    baseURL: `http://localhost:${server.port}/v1`,
    enabled: true,
    capabilities: ["streaming"],
    dataBoundary: "private",
  };
  const store = memoryStore();
  let reason: string | undefined;
  for await (const event of nessi({ agentId: "test", systemPrompt: "Test", store, provider: createAiProvider(profile), input: "Hello" }))
    if (event.type === "loop_end") reason = event.reason;
  expect(reason).toBe("error");
  expect((await store.load()).some((entry) => entry.message.role === "assistant" && entry.message.stopReason === "stop")).toBeFalse();
});
