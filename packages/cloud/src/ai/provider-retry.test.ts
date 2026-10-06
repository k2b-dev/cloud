import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Provider, ProviderEvent } from "@k2b/nessi";
import type { AiCallDetails, AiCallStatus } from "./inference-calls";
import { createAiProvider } from "./provider";
import { retryAfterMs } from "./provider-fetch";
import { type AiProviderRetry, retryTransientProviderErrors } from "./provider-retry";
import { inferenceProvider } from "./quota-provider";
import type { AiModelProfile } from "./types";

const profile: AiModelProfile = {
  id: "retry-model",
  label: "Retry model",
  provider: "openai-compatible",
  model: "mock",
  enabled: true,
  capabilities: ["streaming"],
  dataBoundary: "private",
  pricing: { inputPerMillion: 1, outputPerMillion: 2 },
};

const rateLimitIssue = { kind: "provider_error", message: "429 slow down", retryable: true } as const;
const rateLimited: ProviderEvent = { type: "issue", issue: rateLimitIssue };
const answer: ProviderEvent[] = [
  { type: "block_start", blockId: "b0", index: 0, kind: "text" },
  { type: "block_delta", blockId: "b0", delta: "Hello" },
  { type: "block_end", blockId: "b0", index: 0, block: { type: "text", text: "Hello" } },
  { type: "usage", usage: { input: 5, output: 3, total: 8 }, finishReason: "stop" },
];

/** Plays one scripted attempt per provider call. */
const scripted = (...attempts: ProviderEvent[][]) => {
  let calls = 0;
  const provider: Provider = {
    name: "scripted",
    family: "openai-compatible",
    model: "mock",
    capabilities: { streaming: true, tools: false, images: false, thinking: false, usage: true },
    complete: async () => {
      throw new Error("streams only");
    },
    async *stream() {
      yield* attempts[Math.min(calls++, attempts.length - 1)]!;
    },
  };
  return {
    provider,
    get calls() {
      return calls;
    },
  };
};

const collect = async (provider: Provider, signal?: AbortSignal) => {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({ messages: [], signal })) events.push(event);
  return events;
};

const retrying = (provider: Provider, options: { deadline?: number | null; delaysMs?: readonly number[] } = {}) => {
  const retries: AiProviderRetry[] = [];
  return {
    retries,
    provider: retryTransientProviderErrors(provider, {
      deadline: options.deadline ?? null,
      delaysMs: options.delaysMs ?? [1, 2],
      onRetry: async (retry) => {
        retries.push(retry);
      },
    }),
  };
};

describe("transient provider retries", () => {
  test("a call that fails before any output is repeated and leaves no trace of the failure", async () => {
    const source = scripted([rateLimited, { type: "usage", usage: { input: 0, output: 0, total: 0 }, finishReason: "error" }], answer);
    const { provider, retries } = retrying(source.provider);
    expect(await collect(provider)).toEqual(answer);
    expect(source.calls).toBe(2);
    expect(retries).toEqual([{ retry: 1, delayMs: 1, issue: rateLimitIssue }]);
  });

  test("provider timeouts and lost connections are transient", async () => {
    for (const issue of [
      { kind: "timeout", scope: "provider_first_byte", message: "first byte timeout", retryable: true },
      { kind: "provider_error", message: "openai-compatible connection failed: socket hang up", retryable: true },
    ] as const) {
      const source = scripted([{ type: "issue", issue }], answer);
      expect(await collect(retrying(source.provider).provider)).toEqual(answer);
      expect(source.calls).toBe(2);
    }
  });

  test("a failure after streamed output still ends the call", async () => {
    const midStream: ProviderEvent[] = [answer[0]!, answer[1]!, rateLimited];
    const source = scripted(midStream, answer);
    const { provider, retries } = retrying(source.provider);
    expect(await collect(provider)).toEqual(midStream);
    expect(source.calls).toBe(1);
    expect(retries).toEqual([]);
  });

  test("permanent failures and context overflow are not repeated", async () => {
    for (const issue of [
      { kind: "provider_error", message: "401 invalid key", retryable: false },
      { kind: "provider_error", message: "context too long", retryable: false, contextOverflow: true },
      { kind: "runtime_error", message: "unsupported", retryable: false },
    ] as const) {
      const source = scripted([{ type: "issue", issue }], answer);
      expect(await collect(retrying(source.provider).provider)).toEqual([{ type: "issue", issue }]);
      expect(source.calls).toBe(1);
    }
  });

  test("two retries at most, then the last failure reaches the loop", async () => {
    const source = scripted([rateLimited]);
    const { provider, retries } = retrying(source.provider);
    expect(await collect(provider)).toEqual([rateLimited]);
    expect(source.calls).toBe(3);
    expect(retries.map(({ retry, delayMs }) => [retry, delayMs])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  test("a wait that would outlast the turn's run time budget is not started", async () => {
    const source = scripted([rateLimited], answer);
    const { provider, retries } = retrying(source.provider, { deadline: Date.now() + 500, delaysMs: [1_000, 4_000] });
    expect(await collect(provider)).toEqual([rateLimited]);
    expect(source.calls).toBe(1);
    expect(retries).toEqual([]);
  });

  test("stopping the turn ends the wait without another provider call", async () => {
    const source = scripted([rateLimited], answer);
    const controller = new AbortController();
    const provider = retryTransientProviderErrors(source.provider, {
      deadline: null,
      delaysMs: [60_000],
      onRetry: async () => queueMicrotask(() => controller.abort()),
    });
    const startedAt = Date.now();
    await expect(collect(provider, controller.signal)).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(source.calls).toBe(1);
  });
});

test("Retry-After is read in milliseconds, seconds, or as an HTTP date", () => {
  const now = Date.parse("2026-10-06T10:00:00Z");
  expect(retryAfterMs(new Headers({ "retry-after-ms": "250", "retry-after": "9" }), now)).toBe(250);
  expect(retryAfterMs(new Headers({ "retry-after": "2" }), now)).toBe(2_000);
  expect(retryAfterMs(new Headers({ "retry-after": "Tue, 06 Oct 2026 10:00:03 GMT" }), now)).toBe(3_000);
  expect(retryAfterMs(new Headers({ "retry-after": "Tue, 06 Oct 2026 09:00:00 GMT" }), now)).toBe(0);
  expect(retryAfterMs(new Headers({ "retry-after": "soon" }), now)).toBeUndefined();
  expect(retryAfterMs(new Headers(), now)).toBeUndefined();
});

describe("retries against an HTTP provider", () => {
  let server: ReturnType<typeof Bun.serve>;
  let responses: (() => Response)[] = [];
  let requests = 0;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: () => {
        requests++;
        return (responses.shift() ?? completion)();
      },
    });
  });
  afterAll(() => server.stop(true));

  const completion = () =>
    new Response(
      [
        { choices: [{ delta: { role: "assistant", content: "Hello" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
      ]
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join("")
        .concat("data: [DONE]\n\n"),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  const rejected = (status: number, headers: Record<string, string>) => () =>
    Response.json({ error: { message: "Rate limit reached" } }, { status, headers });

  const accounted = (baseURL = `http://localhost:${server.port}/v1`) => {
    const booked: { usage?: { input: number; output: number; estimated?: boolean }; status: AiCallStatus; details?: AiCallDetails }[] = [];
    const raw = createAiProvider({ ...profile, baseURL }, "test");
    const quota = inferenceProvider(raw, profile, { kind: "chat", task: "chat" }, undefined, {
      begin: async () => ({ id: crypto.randomUUID(), maxOutputTokens: 100 }),
      finish: async (_id, usage, status, details) => {
        booked.push({ usage, status, details });
      },
      heartbeat: async () => {},
    });
    return { booked, quota };
  };

  test("honors Retry-After and books the rejected attempt at zero, so the answer is charged once", async () => {
    requests = 0;
    responses = [rejected(429, { "retry-after-ms": "20" })];
    const { booked, quota } = accounted();
    const waits: { delayMs: number; settled: number }[] = [];
    const provider = retryTransientProviderErrors(quota, {
      deadline: null,
      delaysMs: [5_000, 5_000],
      onRetry: async ({ delayMs }) => {
        waits.push({ delayMs, settled: booked.length });
      },
    });
    const events = await collect(provider);
    expect(events.filter((event) => event.type === "issue")).toEqual([]);
    expect(events.some((event) => event.type === "block_delta" && event.delta === "Hello")).toBe(true);
    expect(requests).toBe(2);
    // The rejected attempt is settled, and its reservation released, before the wait starts.
    expect(waits).toEqual([{ delayMs: 20, settled: 1 }]);
    expect(booked.map(({ usage, status }) => ({ usage, status }))).toEqual([
      { usage: { input: 0, output: 0 }, status: "failed" },
      { usage: { input: 5, output: 3 }, status: "ok" },
    ]);
  });

  const prompt = { messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Summarize the quarterly report." }] }] };

  test("a refused request is booked at zero, a server error that may follow processing keeps the estimate", async () => {
    for (const [status, refused] of [
      [429, true],
      [401, true],
      [503, true],
      [529, true],
      [500, false],
      [502, false],
      [504, false],
    ] as const) {
      responses = [rejected(status, {}), rejected(status, {})];
      const { booked, quota } = accounted();
      for await (const _ of quota.stream(prompt));
      await expect(quota.complete(prompt)).rejects.toThrow(String(status));
      const expected = refused ? { input: 0, output: 0 } : { input: expect.any(Number), output: 0, estimated: true };
      expect({ status, usage: booked.map(({ usage }) => usage) }).toEqual({ status, usage: [expected, expected] });
      if (!refused) expect(booked.every(({ usage }) => (usage?.input ?? 0) > 0)).toBe(true);
    }
  });

  test("a request that never reached the provider is booked at zero", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response() });
    const baseURL = `http://127.0.0.1:${closed.port}/v1`;
    await closed.stop(true);
    const { booked, quota } = accounted(baseURL);
    const events = [];
    for await (const event of quota.stream(prompt)) events.push(event);
    expect(events).toContainEqual({ type: "issue", issue: expect.objectContaining({ kind: "provider_error", retryable: true }) });
    await expect(quota.complete(prompt)).rejects.toThrow("connection failed");
    expect(booked.map(({ usage }) => usage)).toEqual([
      { input: 0, output: 0 },
      { input: 0, output: 0 },
    ]);
  });

  test("a provider that asks for more than a minute fails now", async () => {
    requests = 0;
    responses = [rejected(429, { "retry-after": "120" })];
    const { booked, quota } = accounted();
    const { provider, retries } = retrying(quota);
    const events = await collect(provider);
    expect(events).toContainEqual({ type: "issue", issue: expect.objectContaining({ kind: "provider_error", retryable: true }) });
    expect(requests).toBe(1);
    expect(retries).toEqual([]);
    expect(booked).toHaveLength(1);
  });
});
