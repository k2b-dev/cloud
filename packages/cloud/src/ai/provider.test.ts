import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ProviderEvent } from "@k2b/nessi";
import { complete } from "@k2b/nessi/ai";
import { z } from "zod";
import { createAiProvider } from "./provider";
import * as connections from "./provider-connections";
import type { AiModelProfile } from "./types";

// Adapter unit tests own HTTP fakes; provider status persistence belongs to its integration seam.
beforeEach(() => spyOn(connections, "recordAiProviderStatus").mockResolvedValue(undefined));
afterEach(() => mock.restore());

const profile = (overrides: Partial<AiModelProfile>): AiModelProfile => ({
  modelId: "model-1",
  providerId: "model-1",
  variantLabel: "Standard",
  description: "",
  icon: { kind: "provider" },
  showInPicker: true,
  id: "model-1",
  label: "Model 1",
  provider: "openrouter",
  model: "openai/gpt-4.1-mini",
  enabled: true,
  capabilities: [],
  dataBoundary: "hosted",
  ...overrides,
});

describe("AI provider factory", () => {
  test("complete sends a streaming request and returns the streamed text", async () => {
    const requests: { stream: boolean }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push(z.object({ stream: z.boolean() }).parse(await request.json()));
        return new Response(
          'data: {"choices":[{"delta":{"content":"Streamed "}}]}\n\ndata: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    try {
      const provider = createAiProvider(profile({ provider: "vllm", model: "mock", baseURL: `http://localhost:${server.port}/v1` }));
      const result = await complete(provider, { messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] });
      expect(requests).toEqual([{ stream: true }]);
      expect(result.message.content).toEqual([{ type: "text", text: "Streamed answer" }]);
      expect(result.finishReason).toBe("stop");
    } finally {
      server.stop(true);
    }
  });

  test("maps Cloud model profiles to Nessi provider metadata without provider calls", () => {
    const provider = createAiProvider(profile({ provider: "openrouter", model: "openai/gpt-4.1-mini" }), "secret");

    expect(provider.name).toBe("openrouter");
    expect(provider.family).toBe("openai-compatible");
    expect(provider.model).toBe("openai/gpt-4.1-mini");
  });

  test("every provider type calls its OpenAI-compatible chat endpoint with its own request details", async () => {
    const originalFetch = globalThis.fetch;
    const sent: { url: string; body: Record<string, unknown>; authorization: string | null }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get("authorization") });
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    try {
      const cases = [
        ["openai", undefined, "https://api.openai.com/v1/chat/completions", "max_completion_tokens"],
        ["openrouter", undefined, "https://openrouter.ai/api/v1/chat/completions", "max_tokens"],
        ["mistral", undefined, "https://api.mistral.ai/v1/chat/completions", "max_tokens"],
        ["anthropic", undefined, "https://api.anthropic.com/v1/chat/completions", "max_tokens"],
        ["gemini", undefined, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", "max_tokens"],
        // Addresses stored for a native API reach the OpenAI-compatible one of the same service.
        ["ollama", "http://ollama.example.test:11434/", "http://ollama.example.test:11434/v1/chat/completions", "max_tokens"],
        ["ollama", "http://ollama.example.test:11434/v1", "http://ollama.example.test:11434/v1/chat/completions", "max_tokens"],
        ["anthropic", "https://claude.example.test", "https://claude.example.test/v1/chat/completions", "max_tokens"],
        ["anthropic", "https://claude.example.test/v1/", "https://claude.example.test/v1/chat/completions", "max_tokens"],
        ["gemini", "https://g.example.test/v1beta/models", "https://g.example.test/v1beta/openai/chat/completions", "max_tokens"],
        ["gemini", "https://g.example.test/v1beta", "https://g.example.test/v1beta/openai/chat/completions", "max_tokens"],
      ] as const;
      for (const [provider, baseURL, url, maxTokensField] of cases) {
        sent.length = 0;
        await complete(createAiProvider(profile({ provider, model: "m", baseURL }), "secret"), { messages: [], maxOutputTokens: 32 });
        expect({ provider, url: sent[0]?.url }).toEqual({ provider, url });
        expect(sent[0]?.body[maxTokensField]).toBe(32);
        // Ollama takes no key; every other type sends the configured one.
        expect(sent[0]?.authorization).toBe(provider === "ollama" ? null : "Bearer secret");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Gemini gets each tool call's thought signature back, and a placeholder for a call it did not sign", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: { messages: { role: string; tool_calls?: { extra_content?: unknown }[] }[] }[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    try {
      const provider = createAiProvider(profile({ provider: "gemini", model: "gemini-3-pro" }), "secret");
      await complete(provider, {
        messages: [
          { role: "assistant", provider: "gemini", content: [{ type: "tool_call", id: "a", name: "look", args: {}, signature: "sig" }] },
          { role: "tool_result", callId: "a", name: "look", result: "ok" },
          { role: "assistant", provider: "openai", content: [{ type: "tool_call", id: "b", name: "look", args: {} }] },
          { role: "tool_result", callId: "b", name: "look", result: "ok" },
        ],
      });
      const calls = bodies[0]?.messages.flatMap((message) => message.tool_calls ?? []);
      expect(calls?.map((call) => call.extra_content)).toEqual([
        { google: { thought_signature: "sig" } },
        { google: { thought_signature: "skip_thought_signature_validator" } },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Anthropic and Gemini keep their large context windows unless the profile names one", () => {
    expect(createAiProvider(profile({ provider: "anthropic" }), "k").contextWindow).toBe(200_000);
    expect(createAiProvider(profile({ provider: "gemini" }), "k").contextWindow).toBe(1_000_000);
    expect(createAiProvider(profile({ provider: "gemini", contextWindow: 32_000 }), "k").contextWindow).toBe(32_000);
  });

  test("requires baseURL for custom OpenAI-compatible providers", () => {
    expect(() =>
      createAiProvider(
        profile({
          id: "custom",
          provider: "openai-compatible",
          model: "custom-model",
        }),
        "secret",
      ),
    ).toThrow('AI model profile "custom" requires baseURL');
  });

  test("normalizes Mistral tool call and result ids consistently to nine alphanumeric characters", async () => {
    const originalFetch = globalThis.fetch;
    const requests: { messages: { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[] }[] = [];

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(
        [
          'data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;

    try {
      const provider = createAiProvider(profile({ provider: "mistral", model: "mistral-large-latest" }), "secret");
      const callId = `malformed_${"a".repeat(24)}`;
      for await (const _event of provider.stream({
        messages: [
          { role: "user", content: [{ type: "text", text: "Run" }] },
          { role: "assistant", content: [{ type: "tool_call", id: callId, name: "code_run", args: {} }] },
          { role: "tool_result", callId, name: "code_run", result: "retry", isError: true },
        ],
      })) {
        // Exhaust the stream so the request body is captured.
      }

      const assistantId = requests[0]?.messages.find((message) => message.role === "assistant")?.tool_calls?.[0]?.id;
      const resultId = requests[0]?.messages.find((message) => message.role === "tool")?.tool_call_id;
      expect(assistantId).toEqual(resultId);
      expect(assistantId).toMatch(/^[A-Za-z0-9]{9}$/);
      expect(resultId).toMatch(/^[A-Za-z0-9]{9}$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("surfaces vLLM reasoning deltas as Nessi thinking events", async () => {
    const originalFetch = globalThis.fetch;
    const requests: unknown[] = [];

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init?.body ? JSON.parse(String(init.body)) : null);
      return new Response(
        [
          'data: {"choices":[{"delta":{"reasoning":"plan first"},"finish_reason":null}]}',
          'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;

    try {
      const provider = createAiProvider(
        profile({
          provider: "vllm",
          model: "qwen3.6",
          baseURL: "http://vllm.example.test/v1",
        }),
      );
      const events: ProviderEvent[] = [];
      for await (const event of provider.stream({
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      })) {
        events.push(event);
      }

      expect(provider.capabilities.thinking).toBe(true);
      expect(requests[0]).toMatchObject({ model: "qwen3.6", stream: true });
      expect(requests[0]).not.toHaveProperty("max_tokens");
      // 0.5.0 block model: reasoning and text arrive as separate canonical blocks.
      const deltaFor = (kind: string) => {
        const start = events.find((event) => event.type === "block_start" && event.kind === kind);
        if (!start || start.type !== "block_start") return "";
        return events
          .filter((event) => event.type === "block_delta" && event.blockId === start.blockId)
          .map((event) => (event.type === "block_delta" ? event.delta : ""))
          .join("");
      };
      expect(deltaFor("thinking")).toBe("plan first");
      expect(deltaFor("text")).toBe("answer");

      for await (const _event of provider.stream({
        messages: [{ role: "user", content: [{ type: "text", text: "short" }] }],
        maxOutputTokens: 64,
      })) {
        // Exhaust the stream so the request body is captured.
      }
      expect(requests[1]).toMatchObject({ model: "qwen3.6", stream: true, max_tokens: 64 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
