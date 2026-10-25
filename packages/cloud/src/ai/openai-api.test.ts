import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Provider } from "@k2b/nessi";
import { type GenerateRequest, openAICompatible, type StreamEvent } from "@k2b/nessi/ai";
import { REQUEST_IDLE_TIMEOUT_SECONDS } from "../server/request-timeout";
import { buildProjectedUser } from "../services/session/user";
import { coreSettings } from "../services/settings/api";
import { createAiOpenAiRoutes } from "./openai-api";
import { checkOpenAiApiMessages } from "./openai-api-messages";
import { PROVIDER_TIMEOUTS } from "./provider";
import { inferenceProvider } from "./quota-provider";
import { AiQuotaError } from "./quotas";
import type { AiModelProfile } from "./types";

const user = buildProjectedUser({ id: "11111111-1111-4111-8111-111111111111", uid: "api-user", provider: "local", profile: "user" });
const profile: AiModelProfile = {
  id: "text-model",
  label: "Text model",
  provider: "openai",
  model: "provider-model",
  enabled: true,
  capabilities: ["streaming"],
  dataBoundary: "hosted",
  contextWindow: 1000,
  maxOutputTokens: 40,
  reasoningEffort: "low",
};
const textEvents: StreamEvent[] = [
  { type: "block_start", blockId: "thinking", index: 0, kind: "thinking" },
  { type: "block_delta", blockId: "thinking", delta: "private" },
  { type: "block_start", blockId: "tool", index: 1, kind: "tool_call" },
  { type: "block_delta", blockId: "tool", delta: "tool args" },
  { type: "block_start", blockId: "text", index: 2, kind: "text" },
  { type: "block_delta", blockId: "text", delta: "Hello" },
  { type: "block_delta", blockId: "text", delta: "!" },
  { type: "usage", usage: { input: 10, output: 2, total: 12 }, finishReason: "max_tokens" },
];
const issue: StreamEvent = { type: "issue", issue: { kind: "provider_error", message: "secret provider detail", retryable: false } };
const settings = spyOn(coreSettings, "get");
afterEach(() => settings.mockReset());
afterAll(() => settings.mockRestore());

function accounting() {
  type Lifecycle = NonNullable<Parameters<typeof inferenceProvider>[4]>;
  const bookings: {
    usage: Parameters<Lifecycle["finish"]>[1];
    status: Parameters<Lifecycle["finish"]>[2];
    details: Parameters<Lifecycle["finish"]>[3];
  }[] = [];
  const lifecycle: Lifecycle = {
    begin: async () => ({ id: crypto.randomUUID(), maxOutputTokens: 40 }),
    heartbeat: async () => {},
    finish: async (_id, usage, status, details) => {
      bookings.push({ usage, status, details });
    },
  };
  const wrap: typeof inferenceProvider = (provider, profile, context) => inferenceProvider(provider, profile, context, context, lifecycle);
  return { bookings, wrap };
}

function fixture(
  options: {
    enabled?: boolean;
    auth?: boolean;
    slots?: boolean;
    family?: Provider["family"];
    context?: number;
    events?: StreamEvent[];
    failure?: Error;
    models?: AiModelProfile[];
    stream?: Provider["stream"];
    provider?: Provider;
    keepaliveMs?: number;
    wrap?: typeof inferenceProvider;
    resolutionError?: Error;
  } = {},
) {
  settings.mockResolvedValue(4).mockResolvedValueOnce(options.enabled ?? true);
  const requests: GenerateRequest[] = [];
  let releases = 0;
  let resolveReleased = () => {};
  const released = new Promise<void>((resolve) => {
    resolveReleased = resolve;
  });
  let acquisitions = 0;
  const provider: Provider = {
    name: "fixture",
    model: "provider-model",
    family: options.family ?? "openai-compatible",
    contextWindow: options.context ?? 1000,
    capabilities: { streaming: true, tools: false, thinking: true, images: false, usage: true },
    async complete() {
      throw new Error("OpenAI API must use stream(), including non-streaming requests");
    },
    stream(request) {
      requests.push(request);
      if (options.stream) return options.stream(request);
      return (async function* () {
        if (options.failure) throw options.failure;
        yield* options.events ?? textEvents;
      })();
    },
  };
  const app = createAiOpenAiRoutes({
    keepaliveMs: options.keepaliveMs,
    limit: async (_c, next) => next(),
    authenticate: async (token) =>
      token === "models-key" && options.auth !== false ? { subject: { type: "user", userId: user.id }, credentialId: "credential" } : null,
    assertModelAccess: async () => {},
    listModels: async (subject) => {
      expect(subject).toEqual({ type: "user", userId: user.id });
      return options.models ?? [profile];
    },
    resolveModel: async (policy, id) => {
      if (options.resolutionError) throw options.resolutionError;
      expect(policy?.kind).toBe("selectable");
      expect(id).toBe(profile.id);
      return { profile, provider: options.provider ?? provider };
    },
    acquire: async ({ subject, limit }) => {
      expect(subject).toEqual({ type: "user", userId: user.id });
      expect(limit).toBe(4);
      acquisitions++;
      return options.slots === false
        ? null
        : {
            release: async () => {
              releases++;
              resolveReleased();
            },
          };
    },
    inferenceProvider: (provider, _profile, context) => {
      expect(context).toEqual({ kind: "chat", task: "openai-api", subject: { type: "user", userId: user.id }, credentialId: "credential" });
      return options.wrap ? options.wrap(provider, profile, context) : provider;
    },
  });
  const call = (extra: Record<string, unknown> = {}, headers: Record<string, string> = {}, signal?: AbortSignal) =>
    app.request("/chat/completions", {
      method: "POST",
      signal,
      headers: { authorization: "Bearer models-key", "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: profile.id, messages: [{ role: "user", content: "Hi" }], ...extra }),
    });
  return { app, call, requests, released, releases: () => releases, acquisitions: () => acquisitions };
}

describe("models-only OpenAI-compatible API", () => {
  test("slow first provider events reach both JSON and SSE clients over Bun HTTP", async () => {
    const f = fixture({
      stream: async function* () {
        await Bun.sleep(13_000);
        yield* textEvents;
      },
    });
    const server = Bun.serve({ port: 0, fetch: f.app.fetch });
    try {
      const [json, sse] = await Promise.all(
        [false, true].map(async (stream) => {
          const response = await fetch(new URL("/chat/completions", server.url), {
            method: "POST",
            signal: AbortSignal.timeout(25_000),
            headers: { authorization: "Bearer models-key", "content-type": "application/json" },
            body: JSON.stringify({ model: profile.id, messages: [{ role: "user", content: "Hi" }], stream }),
          });
          expect(response.status).toBe(200);
          return response.text();
        }),
      );
      expect(JSON.parse(json ?? "").choices[0].message.content).toBe("Hello!");
      expect(sse).toContain('"object":"chat.completion.chunk"');
      expect(sse).toContain('"content":"Hello"');
      expect(sse).toContain('"content":"!"');
      expect(sse).toEndWith("data: [DONE]\n\n");
      expect(f.releases()).toBe(2);
    } finally {
      await server.stop(true);
    }
  }, 30_000);

  test.each([false, true])("restarts the provider wait only before answering (stream: %s)", async (stream) => {
    const f = fixture();
    const seconds: number[] = [];
    const wait = Math.ceil(Math.max(PROVIDER_TIMEOUTS.firstByteMs, PROVIDER_TIMEOUTS.idleMs) / 1000) + 10;
    expect(wait).toBe(70);
    const response = await f.app.request(
      "/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer models-key", "content-type": "application/json" },
        body: JSON.stringify({ model: profile.id, messages: [{ role: "user", content: "Hi" }], stream }),
      },
      { timeout: (_req: Request, value: number) => seconds.push(value) },
    );
    expect(response.status).toBe(200);
    await response.text();
    // Streaming commits after the sixth event (the first text); later SSE events use keepalives.
    expect(seconds).toEqual([...Array.from({ length: 1 + (stream ? 6 : textEvents.length) }, () => wait), REQUEST_IDLE_TIMEOUT_SECONDS]);
  });

  test("body validation never raises the request timeout", async () => {
    const f = fixture();
    const seconds: number[] = [];
    const response = await f.app.request(
      "/chat/completions",
      { method: "POST", headers: { authorization: "Bearer models-key", "content-type": "application/json" }, body: "{}" },
      { timeout: (_req: Request, value: number) => seconds.push(value) },
    );
    expect(response.status).toBe(400);
    expect(seconds).toEqual([REQUEST_IDLE_TIMEOUT_SECONDS]);
    expect(f.requests).toHaveLength(0);
  });

  test.each([false, true])("restores the request timeout after a provider error (stream: %s)", async (stream) => {
    const f = fixture({ events: [issue] });
    const seconds: number[] = [];
    const response = await f.app.request(
      "/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer models-key", "content-type": "application/json" },
        body: JSON.stringify({ model: profile.id, messages: [{ role: "user", content: "Hi" }], stream }),
      },
      { timeout: (_req: Request, value: number) => seconds.push(value) },
    );
    expect(response.status).toBe(502);
    expect(seconds).toEqual([70, 70, REQUEST_IDLE_TIMEOUT_SECONDS]);
    expect(f.releases()).toBe(1);
  });

  test("translation catalog covers both languages", () => expect(checkOpenAiApiMessages()).toEqual([]));
  test("checks the operator switch on every request before authentication", async () => {
    const f = fixture({ enabled: false });
    const response = await f.app.request("/models");
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("openai_api_disabled");
    settings.mockResolvedValue(true);
    expect((await f.app.request("/models", { headers: { authorization: "Bearer models-key" } })).status).toBe(200);
  });
  for (const authorization of [undefined, "Bearer invalid", "Bearer full-key", "Bearer oauth-token"]) {
    test(`rejects missing or unsuitable credentials: ${authorization}`, async () => {
      const f = fixture();
      const response = await f.app.request("/models", { headers: authorization ? { authorization } : {} });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_api_key", type: "authentication_error", param: null } });
    });
  }
  test("lists allowed chat models without provider, pricing or transcription profiles", async () => {
    const f = fixture({ models: [profile, { ...profile, id: "audio", capabilities: ["transcription"] }] });
    const response = await f.app.request("/models", { headers: { authorization: "Bearer models-key" } });
    expect(await response.json()).toEqual({ object: "list", data: [{ id: profile.id, object: "model", created: 0, owned_by: "cloud" }] });
  });
  for (const [param, value] of [
    ["tools", [{}]],
    ["functions", [{}]],
    ["n", 2],
    ["response_format", { type: "json_schema" }],
    ["audio", {}],
    ["modalities", ["text", "audio"]],
  ] as const) {
    test(`rejects unsupported ${param}: ${JSON.stringify(value)}`, async () => {
      const f = fixture();
      const response = await f.call({ [param]: value });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatchObject({ code: "unsupported_parameter", param });
      expect(f.acquisitions()).toBe(1);
      expect(f.releases()).toBe(1);
    });
  }
  for (const message of [
    { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test" } }] },
    { role: "user", content: [{ type: "input_audio", input_audio: {} }] },
    { role: "tool", content: "result" },
    { role: "function", content: "result" },
    { role: "assistant", content: "text", tool_calls: [{ id: "call", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "assistant", content: "text", function_call: {} },
  ]) {
    test(`rejects unsupported message content ${JSON.stringify(message)}`, async () => {
      const f = fixture();
      const response = await f.call({ messages: [message] });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("unsupported_content");
      expect(f.acquisitions()).toBe(1);
      expect(f.releases()).toBe(1);
    });
  }
  test("unknown model is 404 and oversized context is 400", async () => {
    const f = fixture({ context: 2 });
    const unknown = await f.call({ model: "forbidden" });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe("model_not_found");
    expect(f.acquisitions()).toBe(1);
    expect(f.releases()).toBe(1);
    const long = await f.call({ messages: [{ role: "user", content: "long ".repeat(100) }] });
    expect(long.status).toBe(400);
    expect((await long.json()).error.code).toBe("context_length_exceeded");
    expect(f.acquisitions()).toBe(2);
    expect(f.releases()).toBe(2);
  });
  test("a person with no available chat models gets model_not_found", async () => {
    const f = fixture({ models: [] });
    const response = await f.call();
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("model_not_found");
    expect(f.acquisitions()).toBe(0);
    expect(f.releases()).toBe(0);
  });
  test("body limit follows the largest allowed context and returns OpenAI 413", async () => {
    const f = fixture();
    const response = await f.call({ metadata: "x".repeat(16_000) });
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("request_too_large");
    expect(f.acquisitions()).toBe(1);
    expect(f.releases()).toBe(1);
  });
  test("invalid JSON and invalid supported fields use localized OpenAI errors", async () => {
    const f = fixture();
    expect(
      (await f.app.request("/chat/completions", { method: "POST", headers: { authorization: "Bearer models-key" }, body: "{" })).status,
    ).toBe(400);
    expect(f.acquisitions()).toBe(1);
    expect(f.releases()).toBe(1);
    const response = await f.call({ temperature: 3 });
    expect(response.status).toBe(400);
    expect((await response.json()).error.param).toBe("temperature");
    expect(f.acquisitions()).toBe(2);
    expect(f.releases()).toBe(2);
  });
  test("converts only client messages and ignores unknown options", async () => {
    const f = fixture();
    const response = await f.call({
      messages: [
        { role: "system", content: "system" },
        { role: "developer", content: [{ type: "text", text: "dev" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "one" },
            { type: "text", text: "two" },
          ],
        },
        { role: "assistant", content: "answer" },
      ],
      temperature: 0.5,
      tools: [],
      functions: [],
      response_format: { type: "text" },
      n: 1,
      stop: ["END"],
      reasoning_effort: "high",
      metadata: {},
      store: true,
      tool_choice: "auto",
    });
    expect(response.status).toBe(200);
    expect(f.requests[0]).toMatchObject({
      systemPrompt: "system\n\ndev",
      messages: [
        { role: "user", content: ["onetwo"] },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
      ],
      temperature: 0.5,
      reasoningEffort: "low",
    });
    expect(f.requests[0]).not.toHaveProperty("tools");
    expect(f.requests[0]).not.toHaveProperty("metadata");
  });
  test("treats null fields as unset, as many OpenAI clients send them", async () => {
    const f = fixture();
    const response = await f.call({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello", tool_calls: null, function_call: null },
        { role: "user", content: "Again" },
      ],
      temperature: null,
      top_p: null,
      max_tokens: null,
      max_completion_tokens: null,
      stream: null,
      stream_options: null,
      tools: null,
      functions: null,
      n: null,
      response_format: null,
      audio: null,
      modalities: null,
      stop: null,
    });
    expect(response.status).toBe(200);
    expect(f.requests[0]).toMatchObject({ maxOutputTokens: 40 });
    expect(f.requests[0]?.temperature).toBeUndefined();
    expect(f.requests[0]?.extraBody).toBeUndefined();
  });
  for (const [family, extraBody] of [
    ["ollama", { options: { top_p: 0.7 } }],
    ["gemini", { generationConfig: { topP: 0.7 } }],
    ["openai-compatible", { top_p: 0.7 }],
    ["anthropic", { top_p: 0.7 }],
    ["mistral", { top_p: 0.7 }],
  ] as const) {
    test(`maps top_p for ${family}`, async () => {
      const f = fixture({ family });
      await f.call({ top_p: 0.7 });
      expect(f.requests[0]?.extraBody).toEqual(extraBody);
    });
  }
  for (const [fields, cap] of [
    [{ max_tokens: 100 }, 40],
    [{ max_tokens: 100, max_completion_tokens: 20 }, 20],
    [{}, 40],
  ] as const) {
    test(`caps output tokens ${JSON.stringify(fields)}`, async () => {
      const f = fixture();
      await f.call(fields);
      expect(f.requests[0]?.maxOutputTokens).toBe(cap);
    });
  }
  for (const [reason, mapped] of [
    ["stop", "stop"],
    ["max_tokens", "length"],
    ["tool_use", "stop"],
  ] as const) {
    test(`returns completion shape and maps ${reason}`, async () => {
      const f = fixture({
        events: [...textEvents.slice(0, -1), { type: "usage", usage: { input: 10, output: 2, total: 12 }, finishReason: reason }],
      });
      const body = await (await f.call()).json();
      expect(body).toMatchObject({
        object: "chat.completion",
        model: profile.id,
        choices: [{ index: 0, message: { role: "assistant", content: "Hello!" }, logprobs: null, finish_reason: mapped }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.created).toBeGreaterThan(0);
      expect(f.releases()).toBe(1);
    });
  }
  test("omits unreported usage", async () => {
    const f = fixture({ events: textEvents.slice(0, -1) });
    expect(await (await f.call()).json()).not.toHaveProperty("usage");
  });
  test.each([false, true])("omits all-zero adapter usage and preserves the finish reason (stream: %s)", async (stream) => {
    const f = fixture({
      events: [...textEvents.slice(0, -1), { type: "usage", usage: { input: 0, output: 0, total: 0 }, finishReason: "max_tokens" }],
    });
    const response = await f.call({ stream, stream_options: { include_usage: true } });
    expect(response.status).toBe(200);
    if (stream) {
      const text = await response.text();
      expect(text).not.toContain('"usage"');
      expect(text).toContain('"finish_reason":"length"');
      expect(text).toEndWith("data: [DONE]\n\n");
    } else {
      const body = await response.json();
      expect(body).not.toHaveProperty("usage");
      expect(body.choices[0].finish_reason).toBe("length");
    }
    expect(f.releases()).toBe(1);
  });
  for (const reason of ["error", "aborted", "interrupted"] as const) {
    test(`maps failed completion ${reason} to 502 and releases the slot`, async () => {
      const f = fixture({
        events: [...textEvents.slice(0, -1), { type: "usage", usage: { input: 10, output: 2, total: 12 }, finishReason: reason }],
      });
      expect((await f.call()).status).toBe(502);
      expect(f.releases()).toBe(1);
    });
  }
  for (const includeUsage of [true, false]) {
    test(`streams role, text, finish, optional usage (${includeUsage}) and DONE`, async () => {
      const f = fixture();
      const response = await f.call({ stream: true, stream_options: { include_usage: includeUsage } });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const data = (await response.text()).split("\n\n").filter(Boolean);
      expect(data.every((line) => line.startsWith("data: "))).toBe(true);
      expect(data.at(-1)).toBe("data: [DONE]");
      const chunks = data.slice(0, -1).map((line) => JSON.parse(line.slice(6)));
      expect(chunks[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
      expect(chunks[1].choices[0].delta).toEqual({ content: "Hello" });
      expect(chunks[2].choices[0].delta).toEqual({ content: "!" });
      expect(chunks[3].choices[0]).toMatchObject({ delta: {}, finish_reason: "length" });
      expect(chunks).toHaveLength(includeUsage ? 5 : 4);
      if (includeUsage)
        expect(chunks[4]).toMatchObject({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
      expect(data.join("")).not.toContain("private");
      expect(data.join("")).not.toContain("tool args");
      expect(f.releases()).toBe(1);
    });
  }
  test("empty text stream still ends normally without unreported usage", async () => {
    const f = fixture({ events: [] });
    const text = await (await f.call({ stream: true, stream_options: { include_usage: true } })).text();
    expect(text).toContain("[DONE]");
    expect(text).not.toContain('"usage"');
    expect(f.releases()).toBe(1);
  });
  for (const failure of ["issue", "throw", "finish"] as const) {
    test(`provider ${failure} before text is a JSON 502`, async () => {
      const f = fixture({
        events: failure === "issue" ? [issue] : [{ type: "usage", usage: { input: 1, output: 0, total: 1 }, finishReason: "error" }],
        failure: failure === "throw" ? new Error("provider secret") : undefined,
      });
      const response = await f.call({ stream: true });
      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect((await response.json()).error.code).toBe("upstream_error");
      expect(f.releases()).toBe(1);
    });
  }
  test("provider failure after text sends one SSE error and no DONE", async () => {
    const f = fixture({ events: [...textEvents.slice(0, 6), issue] });
    const response = await f.call({ stream: true });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"code":"upstream_error"');
    expect(text).not.toContain("[DONE]");
    expect(text).not.toContain("secret provider detail");
    expect(f.releases()).toBe(1);
  });
  for (const failure of [
    issue,
    { type: "issue", issue: { kind: "timeout", scope: "provider_idle", message: "provider timed out", retryable: true } },
    { type: "usage", usage: { input: 10, output: 2, total: 12 }, finishReason: "error" },
  ] satisfies StreamEvent[]) {
    for (const stream of [false, true]) {
      test(`books ${failure.type === "issue" ? failure.issue.kind : failure.finishReason} after text as failed (stream=${stream})`, async () => {
        const tracked = accounting();
        const f = fixture({ events: [...textEvents.slice(0, 6), failure], wrap: tracked.wrap });
        const response = await f.call({ stream });
        if (stream) {
          expect(response.status).toBe(200);
          const text = await response.text();
          expect(text).toContain('"content":"Hello"');
          expect(text).toContain('"code":"upstream_error"');
          expect(text).not.toContain("[DONE]");
        } else {
          expect(response.status).toBe(502);
          expect((await response.json()).error.code).toBe("upstream_error");
        }
        await f.released;
        expect(tracked.bookings).toHaveLength(1);
        expect(tracked.bookings[0]?.status).toBe("failed");
        expect(tracked.bookings[0]?.details?.cancelled).toBe(false);
        expect(tracked.bookings[0]?.details?.error).toBeString();
        expect(f.releases()).toBe(1);
      });
    }
  }
  test("SSE keepalives fill a provider pause between data events", async () => {
    let resume = () => {};
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const f = fixture({
      keepaliveMs: 5,
      stream: async function* () {
        yield* textEvents.slice(0, 6);
        await paused;
        yield* textEvents.slice(6);
      },
    });
    const response = await f.call({ stream: true });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing stream");
    const decoder = new TextDecoder();
    let text = "";
    try {
      // Reading a heartbeat itself releases the provider; no elapsed-time assumption is needed.
      while (!text.includes('"content":"Hello"') || !text.slice(text.indexOf('"content":"Hello"')).includes(": keepalive\n\n")) {
        const step = await reader.read();
        if (step.done) throw new Error("Stream ended before keepalive");
        text += decoder.decode(step.value, { stream: true });
      }
    } finally {
      resume();
    }
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      text += decoder.decode(step.value, { stream: true });
    }
    await f.released;
    const first = text.indexOf('"content":"Hello"');
    const keepalive = text.indexOf(": keepalive\n\n", first);
    const next = text.indexOf('"content":"!"', first);
    expect(keepalive).toBeGreaterThan(first);
    expect(keepalive).toBeLessThan(next);
    expect(text).toContain('"finish_reason":"length"');
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(f.releases()).toBe(1);
  });
  test("SSE keepalives stay bounded while the client does not read", async () => {
    const paused = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const f = fixture({
      keepaliveMs: 5,
      stream: async function* () {
        yield* textEvents.slice(0, 6);
        waiting.resolve();
        await paused.promise;
        yield* textEvents.slice(6);
      },
    });
    const interval = spyOn(globalThis, "setInterval");
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      response = await f.call({ stream: true });
      expect(interval).toHaveBeenCalledTimes(1);
      const [tick, ms] = interval.mock.calls[0] ?? [];
      expect(ms).toBe(5);
      if (typeof tick !== "function") throw new Error("Missing interval callback");
      interval.mockRestore();
      // Fire many ticks deterministically while the initial data writes face backpressure.
      for (let i = 0; i < 20; i++) {
        tick();
        await Promise.resolve();
      }
      reader = response.body?.getReader();
      if (!reader) throw new Error("Missing stream");
      const decoder = new TextDecoder();
      let text = "";
      // Consume role and first text, then pause again with the provider stalled.
      for (let i = 0; i < 2; i++) {
        const step = await reader.read();
        text += decoder.decode(step.value, { stream: true });
      }
      await waiting.promise;
      for (let i = 0; i < 20; i++) {
        tick();
        await Promise.resolve();
      }
      paused.resolve();
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        text += decoder.decode(step.value, { stream: true });
      }
      const keepalives = text.split(": keepalive\n\n").length - 1;
      expect(keepalives).toBeGreaterThan(0);
      expect(keepalives).toBeLessThanOrEqual(2);
      expect(text).toContain('"content":"Hello"');
      expect(text).toEndWith("data: [DONE]\n\n");
      expect(f.releases()).toBe(1);
    } finally {
      interval.mockRestore();
      paused.resolve();
      if (reader) await reader.cancel();
      else if (response && !response.bodyUsed) await response.body?.cancel();
      if (response) await f.released;
    }
  });
  for (const stream of [false, true]) {
    test(`quota errors return German HTTP 429 before output (stream=${stream})`, async () => {
      const f = fixture({ failure: new AiQuotaError("quota_usage_unknown", "English private detail") });
      const response = await f.call({ stream }, { "Accept-Language": "de" });
      expect(response.status).toBe(429);
      expect((await response.json()).error).toMatchObject({
        code: "insufficient_quota",
        type: "insufficient_quota",
        message: expect.stringContaining("Dein Nutzungslimit im Assistenten"),
      });
      expect(f.releases()).toBe(1);
    });
  }
  test("rate limiting keeps its headers and uses the OpenAI error envelope", async () => {
    const app = createAiOpenAiRoutes({
      limit: async (c) => {
        c.header("Retry-After", "2");
        return c.json({ message: "Rate limit exceeded" }, 429);
      },
    });
    const response = await app.request("/models");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect((await response.json()).error).toMatchObject({ code: "rate_limit_exceeded", type: "rate_limit_error" });
  });
  for (const [code, status, mapped] of [
    ["ai_disabled", 403, "ai_disabled"],
    ["model_access_denied", 403, "model_access_denied"],
    ["missing_provider_credential", 502, "missing_provider_credential"],
    ["model_policy_mismatch", 404, "model_not_found"],
    ["invalid_model_profiles", 500, "internal_error"],
  ] as const) {
    test(`maps safe model resolution error ${code}`, async () => {
      const f = fixture({ resolutionError: Object.assign(new Error("secret"), { aiError: { code, message: "secret" } }) });
      const response = await f.call();
      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(mapped);
      expect(f.acquisitions()).toBe(1);
      expect(f.releases()).toBe(1);
    });
  }
  test("concurrency refusal includes Retry-After without invoking provider", async () => {
    const f = fixture({ slots: false });
    const response = await f.call();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect((await response.json()).error.code).toBe("too_many_concurrent_requests");
    expect(f.requests).toHaveLength(0);
    expect(f.releases()).toBe(0);
  });
  test("concurrency refusal does not read an unfinished body", async () => {
    const f = fixture({ slots: false });
    let starts = 0;
    let pulls = 0;
    let bodyRead = () => {};
    const unexpectedRead = new Promise<never>((_resolve, reject) => {
      bodyRead = () => reject(new Error("Request body was read before refusing the slot"));
    });
    const body = new ReadableStream<Uint8Array>(
      {
        start() {
          starts++;
        },
        pull() {
          pulls++;
          bodyRead();
          return new Promise<void>(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request("http://localhost/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer models-key", "content-type": "application/json" },
      body,
    });
    const response = await Promise.race([f.app.request(request), unexpectedRead]);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect((await response.json()).error.code).toBe("too_many_concurrent_requests");
    expect(starts).toBe(1);
    expect(pulls).toBe(0);
    expect(request.bodyUsed).toBe(false);
    expect(f.requests).toHaveLength(0);
    expect(f.acquisitions()).toBe(1);
    expect(f.releases()).toBe(0);
    await body.cancel();
  });
  test("a non-streaming request uses the real adapter's first-byte timeout", async () => {
    let accepted = false;
    let streaming: unknown;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname !== "/chat/completions") return new Response(null, { status: 404 });
        accepted = true;
        const body: unknown = await request.json();
        if (typeof body === "object" && body !== null && "stream" in body) streaming = body.stream;
        return new Promise<Response>(() => {});
      },
    });
    try {
      const f = fixture({
        provider: openAICompatible({
          name: "stalled",
          model: "provider-model",
          baseURL: server.url.toString(),
          timeouts: { firstByteMs: 200, idleMs: 200 },
        }),
      });
      const response = await f.call({ stream: false });
      expect(accepted).toBe(true);
      expect(streaming).toBe(true);
      expect(response.status).toBe(502);
      expect((await response.json()).error.code).toBe("upstream_error");
      expect(f.acquisitions()).toBe(1);
      expect(f.releases()).toBe(1);
    } finally {
      await server.stop(true);
    }
  });
  test("releases a failed non-streaming request", async () => {
    const f = fixture({ failure: new Error("provider secret") });
    expect((await f.call()).status).toBe(502);
    expect(f.releases()).toBe(1);
  });
  test("non-streaming iterator cleanup failures stay 502 and release the slot once", async () => {
    let returns = 0;
    const f = fixture({
      stream: async function* () {
        try {
          yield issue;
        } finally {
          returns++;
          throw new Error("cleanup failed");
        }
      },
    });
    const response = await f.call({ stream: false });
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("upstream_error");
    expect(returns).toBe(1);
    expect(f.acquisitions()).toBe(1);
    expect(f.releases()).toBe(1);
  });
  test("cancels a non-streaming provider call and books an estimate when the client aborts", async () => {
    let start = () => {};
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const tracked = accounting();
    const f = fixture({
      stream: async function* (request) {
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          start();
        });
      },
      wrap: tracked.wrap,
    });
    const controller = new AbortController();
    const response = f.call({}, {}, controller.signal);
    await started;
    controller.abort();
    expect((await response).status).toBe(502);
    await f.released;
    expect(f.requests[0]?.signal?.aborted).toBe(true);
    expect(tracked.bookings).toEqual([
      {
        usage: { input: expect.any(Number), output: 0, estimated: true },
        status: "aborted",
        details: expect.objectContaining({ error: null, cancelled: true }),
      },
    ]);
    expect(f.releases()).toBe(1);
  });
  test("SSE consumer cancellation aborts the provider and releases its slot", async () => {
    let cancelled = false;
    let providerWaiting = () => {};
    const waiting = new Promise<void>((resolve) => {
      providerWaiting = resolve;
    });
    const tracked = accounting();
    const f = fixture({
      wrap: tracked.wrap,
      stream: async function* (request) {
        yield { type: "block_start", blockId: "text", index: 0, kind: "text" };
        yield { type: "block_delta", blockId: "text", delta: "first" };
        try {
          await new Promise<void>((_resolve, reject) => {
            if (request.signal?.aborted) reject(new Error("cancelled"));
            else request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
            providerWaiting();
          });
        } finally {
          cancelled = request.signal?.aborted === true;
        }
      },
    });
    const response = await f.call({ stream: true });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing stream");
    await reader.read();
    await reader.read();
    await waiting;
    await reader.cancel();
    await f.released;
    expect(cancelled).toBe(true);
    expect(tracked.bookings).toEqual([
      {
        usage: { input: expect.any(Number), output: 2, estimated: true },
        status: "aborted",
        details: expect.objectContaining({ error: null, cancelled: true }),
      },
    ]);
    expect(f.releases()).toBe(1);
  });
  test("synchronous stream setup failure also releases its slot", async () => {
    const f = fixture({
      stream: () => {
        throw new Error("setup failed");
      },
    });
    expect((await f.call({ stream: true })).status).toBe(502);
    expect(f.releases()).toBe(1);
  });
  test("unknown sub-path stays inside the OpenAI JSON surface", async () => {
    const f = fixture();
    const response = await f.app.request("/unknown", { headers: { authorization: "Bearer models-key" } });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatchObject({ code: "not_found", type: "invalid_request_error" });
  });
});
