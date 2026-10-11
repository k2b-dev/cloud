import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Provider } from "@k2b/nessi";
import type { GenerateRequest, GenerateResult, StreamEvent } from "@k2b/nessi/ai";
import { buildProjectedUser } from "../services/session/user";
import { coreSettings } from "../services/settings/api";
import { createAiOpenAiRoutes } from "./openai-api";
import { checkOpenAiApiMessages } from "./openai-api-messages";
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
const result: GenerateResult = {
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private" },
      { type: "text", text: "Hello" },
      { type: "text", text: "!" },
    ],
  },
  finishReason: "stop",
  usage: { input: 10, output: 2, total: 12 },
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

function fixture(
  options: {
    enabled?: boolean;
    auth?: boolean;
    slots?: boolean;
    family?: Provider["family"];
    context?: number;
    events?: StreamEvent[];
    result?: GenerateResult;
    failure?: Error;
    models?: AiModelProfile[];
    stream?: Provider["stream"];
    complete?: Provider["complete"];
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
    async complete(request) {
      requests.push(request);
      if (options.failure) throw options.failure;
      if (options.complete) return options.complete(request);
      return options.result ?? result;
    },
    stream:
      options.stream ??
      async function* (request) {
        requests.push(request);
        if (options.failure) throw options.failure;
        yield* options.events ?? textEvents;
      },
  };
  const app = createAiOpenAiRoutes({
    limit: async (_c, next) => next(),
    authenticate: async (token) => (token === "models-key" && options.auth !== false ? { user, credentialId: "credential" } : null),
    listModels: async (subject) => {
      expect(subject).toEqual({ type: "user", userId: user.id });
      return options.models ?? [profile];
    },
    resolveModel: async (policy, id) => {
      if (options.resolutionError) throw options.resolutionError;
      expect(policy?.kind).toBe("selectable");
      expect(id).toBe(profile.id);
      return { profile, provider };
    },
    acquire: async ({ userId, limit }) => {
      expect(userId).toBe(user.id);
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
      expect(context).toEqual({ kind: "chat", task: "openai-api", subject: { type: "user", userId: user.id } });
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
      expect(f.acquisitions()).toBe(0);
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
      const response = await fixture().call({ messages: [message] });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("unsupported_content");
    });
  }
  test("unknown model is 404 and oversized context is 400", async () => {
    const f = fixture({ context: 2 });
    const unknown = await f.call({ model: "forbidden" });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe("model_not_found");
    const long = await f.call({ messages: [{ role: "user", content: "long ".repeat(100) }] });
    expect(long.status).toBe(400);
    expect((await long.json()).error.code).toBe("context_length_exceeded");
    expect(f.acquisitions()).toBe(0);
  });
  test("a person with no available chat models gets model_not_found", async () => {
    const f = fixture({ models: [] });
    const response = await f.call();
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("model_not_found");
    expect(f.acquisitions()).toBe(0);
  });
  test("body limit follows the largest allowed context and returns OpenAI 413", async () => {
    const f = fixture();
    const response = await f.call({ metadata: "x".repeat(16_000) });
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("request_too_large");
  });
  test("invalid JSON and invalid supported fields use localized OpenAI errors", async () => {
    const f = fixture();
    expect(
      (await f.app.request("/chat/completions", { method: "POST", headers: { authorization: "Bearer models-key" }, body: "{" })).status,
    ).toBe(400);
    const response = await f.call({ temperature: 3 });
    expect(response.status).toBe(400);
    expect((await response.json()).error.param).toBe("temperature");
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
      const f = fixture({ result: { ...result, finishReason: reason } });
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
    const f = fixture({ result: { message: result.message, finishReason: "stop" } });
    expect(await (await f.call()).json()).not.toHaveProperty("usage");
  });
  for (const reason of ["error", "aborted", "interrupted"] as const) {
    test(`maps failed completion ${reason} to 502 and releases the slot`, async () => {
      const f = fixture({ result: { ...result, finishReason: reason } });
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
      expect(f.acquisitions()).toBe(0);
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
  test("releases a failed non-streaming request", async () => {
    const f = fixture({ failure: new Error("provider secret") });
    expect((await f.call()).status).toBe(502);
    expect(f.releases()).toBe(1);
  });
  test("cancels a non-streaming provider call and books an estimate when the client aborts", async () => {
    let start = () => {};
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const bookings: { usage: { input: number; output: number; estimated?: boolean } | undefined; status: string }[] = [];
    const lifecycle: NonNullable<Parameters<typeof inferenceProvider>[4]> = {
      begin: async () => ({ id: crypto.randomUUID(), maxOutputTokens: 40 }),
      heartbeat: async () => {},
      finish: async (_id, usage, status) => {
        bookings.push({ usage, status });
      },
    };
    const f = fixture({
      complete: async (request) => {
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          start();
        });
        return result;
      },
      wrap: (provider, profile, context) => inferenceProvider(provider, profile, context, context, lifecycle),
    });
    const controller = new AbortController();
    const response = f.call({}, {}, controller.signal);
    await started;
    controller.abort();
    expect((await response).status).toBe(502);
    await f.released;
    expect(f.requests[0]?.signal?.aborted).toBe(true);
    expect(bookings).toEqual([{ usage: { input: expect.any(Number), output: 0, estimated: true }, status: "aborted" }]);
    expect(f.releases()).toBe(1);
  });
  test("SSE consumer cancellation aborts the provider and releases its slot", async () => {
    let cancelled = false;
    let providerWaiting = () => {};
    const waiting = new Promise<void>((resolve) => {
      providerWaiting = resolve;
    });
    const f = fixture({
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
