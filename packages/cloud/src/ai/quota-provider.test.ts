import { expect, spyOn, test } from "bun:test";
import type { Provider, ProviderEvent } from "@k2b/nessi";
import {
  AiBackgroundAdmissionError,
  AiBackgroundCostError,
  type AiCallContext,
  type AiCallDetails,
  type AiCallStatus,
} from "./inference-calls";
import { inferenceProvider } from "./quota-provider";
import type { AiModelProfile } from "./types";

const profile: AiModelProfile = {
  id: "a",
  label: "A",
  provider: "openai",
  model: "a",
  enabled: true,
  capabilities: ["streaming"],
  dataBoundary: "hosted",
  pricing: { inputPerMillion: 1, outputPerMillion: 2 },
};
const request = { messages: [] };
const event: ProviderEvent = { type: "usage", usage: { input: 8, output: 2, total: 10 } };
function fixture(events: ProviderEvent[]) {
  const booked: {
    usage: { input: number; output: number; estimated?: boolean } | undefined;
    status: AiCallStatus;
    details?: AiCallDetails;
  }[] = [];
  const contexts: AiCallContext[] = [];
  let calls = 0;
  const provider: Provider = {
    name: "fixture",
    family: "openai-compatible",
    model: "fixture",
    capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
    async *stream() {
      calls++;
      yield* events;
    },
    async complete() {
      calls++;
      return { message: { role: "assistant", content: [] }, finishReason: "stop", usage: event.type === "usage" ? event.usage : undefined };
    },
  };
  const lifecycle = {
    begin: async (_profile: AiModelProfile, context: AiCallContext) => {
      contexts.push(context);
      return { id: crypto.randomUUID(), maxOutputTokens: 100 };
    },
    finish: async (
      _id: string,
      usage: { input: number; output: number; estimated?: boolean } | undefined,
      status: AiCallStatus,
      details?: AiCallDetails,
    ) => {
      booked.push({ usage, status, details });
    },
    heartbeat: async (_id: string) => {},
  };
  const wrap = () =>
    inferenceProvider(provider, profile, { kind: "chat", task: "chat" }, { kind: "background", task: "chat-compaction" }, lifecycle);
  return {
    provider,
    lifecycle,
    wrap,
    booked,
    contexts,
    get calls() {
      return calls;
    },
  };
}
const drain = async (provider: Provider) => {
  for await (const _ of provider.stream(request)) {
  }
};

test("usage snapshots count once and complete has a separate purpose", async () => {
  const f = fixture([event, event]);
  await drain(f.wrap());
  await f.wrap().complete(request);
  expect(f.booked.map((b) => b.usage)).toEqual([
    { input: 8, output: 2 },
    { input: 8, output: 2 },
  ]);
  expect(f.contexts.map((c) => c.kind)).toEqual(["chat", "background"]);
});
test("every actual complete attempt is recorded separately", async () => {
  const f = fixture([]);
  const p = f.wrap();
  await p.complete(request);
  await p.complete(request);
  expect(f.calls).toBe(2);
  expect(f.booked).toHaveLength(2);
});
test("rejected admission never invokes provider", async () => {
  const f = fixture([event]);
  f.lifecycle.begin = async () => {
    throw new AiBackgroundCostError();
  };
  await expect(drain(f.wrap())).rejects.toThrow("Background AI");
  expect(f.calls).toBe(0);
});
test("accounting completion failure never retries successful inference", async () => {
  const f = fixture([event]);
  f.lifecycle.finish = async () => {
    throw new Error("database unavailable");
  };
  await drain(f.wrap());
  expect(f.calls).toBe(1);
});
test("consumer return preserves already reported usage", async () => {
  const f = fixture([event, event]);
  for await (const _ of f.wrap().stream(request)) break;
  expect(f.booked[0]?.usage).toEqual({ input: 8, output: 2 });
});
test("known context rejection costs zero and permits compaction", async () => {
  const f = fixture([{ type: "issue", issue: { kind: "provider_error", message: "context", contextOverflow: true, retryable: false } }]);
  await drain(f.wrap());
  expect(f.booked[0]?.usage).toEqual({ input: 0, output: 0 });
});
test("normal missing or synthetic zero usage remains unknown", async () => {
  for (const events of [[], [{ type: "usage" as const, usage: { input: 0, output: 0, total: 0 } }]]) {
    const f = fixture(events);
    await drain(f.wrap());
    expect(f.booked[0]?.usage).toBeUndefined();
  }
});
test("early return estimates partial output including final-only tool blocks", async () => {
  const f = fixture([
    { type: "block_end", blockId: "tool", index: 0, block: { type: "tool_call", id: "call", name: "search", args: { query: "weather" } } },
  ]);
  for await (const _ of f.wrap().stream(request)) break;
  expect(f.booked[0]?.usage?.estimated).toBe(true);
  expect(f.booked[0]!.usage!.output).toBeGreaterThan(0);
});
test("stream exception and complete exception preserve estimated input", async () => {
  const f = fixture([]);
  f.provider.stream = async function* () {
    throw new Error("timeout");
  };
  f.provider.complete = async () => {
    throw new Error("timeout");
  };
  await expect(drain(f.wrap())).rejects.toThrow("timeout");
  await expect(f.wrap().complete({ messages: [], systemPrompt: "S".repeat(100) })).rejects.toThrow("timeout");
  expect(f.booked.every((b) => b.usage?.estimated && b.status === "failed")).toBe(true);
  expect(f.booked[1]!.usage!.input).toBeGreaterThan(0);
});
test("provider-declared complete abort is a failed estimate", async () => {
  const f = fixture([]);
  f.provider.complete = async () => ({ message: { role: "assistant", content: [] }, finishReason: "aborted" });
  await f.wrap().complete(request);
  expect(f.booked[0]?.status).toBe("failed");
  expect(f.booked[0]?.usage?.estimated).toBe(true);
});
test("chunking does not change estimates and encoded file data is excluded", async () => {
  const failure: ProviderEvent = { type: "issue", issue: { kind: "provider_error", message: "lost", retryable: true } };
  const a = fixture([{ type: "block_delta", blockId: "a", delta: "hello world" }, failure]);
  const b = fixture([...Array.from("hello world", (delta) => ({ type: "block_delta" as const, blockId: "a", delta })), failure]);
  for (const f of [a, b])
    for await (const _ of f.wrap().stream({
      messages: [{ role: "user", content: [{ type: "file", data: "A".repeat(100000), mediaType: "image/png" }] }],
      systemPrompt: "S".repeat(400),
    })) {
    }
  // Compare what chunking could change; requestStartedAt is wall-clock time of each run.
  const comparable = (booked: typeof a.booked) =>
    booked.map(({ details, ...rest }) => ({ ...rest, details: details && { ...details, requestStartedAt: undefined } }));
  expect(comparable(a.booked)).toEqual(comparable(b.booked));
  expect(a.booked[0]!.usage!.output).toBe(3);
  expect(a.booked[0]!.usage!.input).toBeLessThan(200);
});
test("explicit stream abort estimates synthetic zero usage", async () => {
  const f = fixture([{ type: "usage", usage: { input: 0, output: 0, total: 0 }, finishReason: "aborted" }]);
  await drain(f.wrap());
  expect(f.booked[0]?.usage?.estimated).toBe(true);
});

test("unrestricted admission preserves undefined provider output defaults", async () => {
  const f = fixture([event]);
  f.provider.contextWindow = 200_000;
  const observed: (number | undefined)[] = [];
  f.provider.complete = async (request) => {
    observed.push(request.maxOutputTokens);
    return { message: { role: "assistant", content: [] }, finishReason: "stop" };
  };
  const wrapped = inferenceProvider(f.provider, profile, { kind: "background", task: "default" }, undefined, {
    ...f.lifecycle,
    begin: async (_profile, _context, _input, requested) => ({ id: crypto.randomUUID(), maxOutputTokens: requested }),
  });
  await wrapped.complete({ messages: [] });
  await wrapped.complete({ messages: [], maxOutputTokens: 123 });
  expect(observed).toEqual([undefined, 123]);
});

test("background admission waits for reservations without calling the provider twice", async () => {
  const f = fixture([]);
  const admit = f.lifecycle.begin;
  let attempts = 0;
  f.lifecycle.begin = async (...args) => {
    if (++attempts === 1) throw new AiBackgroundAdmissionError(true);
    return admit(...args);
  };
  await f.wrap().complete(request);
  expect(attempts).toBe(2);
  expect(f.calls).toBe(1);
  expect(f.booked).toHaveLength(1);
});
test("waiting for a reservation can be canceled without spending or booking", async () => {
  const f = fixture([]);
  const controller = new AbortController();
  f.lifecycle.begin = async () => {
    queueMicrotask(() => controller.abort());
    throw new AiBackgroundAdmissionError(true);
  };
  await expect(f.wrap().complete({ ...request, signal: controller.signal })).rejects.toThrow();
  expect(f.calls).toBe(0);
  expect(f.booked).toHaveLength(0);
});
test("a call too expensive even without reservations does not wait", async () => {
  const f = fixture([]);
  f.lifecycle.begin = async () => {
    throw new AiBackgroundAdmissionError(false);
  };
  await expect(f.wrap().complete(request)).rejects.toMatchObject({ code: "ai_background_budget_insufficient" });
  expect(f.calls).toBe(0);
});

test("reservation waiting is bounded and returns a retryable error on timeout", async () => {
  const f = fixture([]);
  const now = spyOn(Date, "now").mockReturnValue(0);
  f.lifecycle.begin = async () => {
    now.mockReturnValue(120_000);
    throw new AiBackgroundAdmissionError(true);
  };
  try {
    await expect(f.wrap().complete(request)).rejects.toMatchObject({ code: "ai_background_budget_reserved", retryable: true });
    expect(f.calls).toBe(0);
    expect(f.booked).toHaveLength(0);
  } finally {
    now.mockRestore();
  }
});

test("a provider timeout is retained as the call's error and is not a cancellation", async () => {
  const f = fixture([
    {
      type: "issue",
      issue: { kind: "timeout", scope: "provider_first_byte", message: "SSE stream first byte timeout after 60000ms.", retryable: true },
    },
  ]);
  await drain(f.wrap());
  expect(f.booked[0]).toMatchObject({
    status: "failed",
    details: { error: "SSE stream first byte timeout after 60000ms.", cancelled: false },
  });
  expect(f.booked[0]!.details!.requestStartedAt).toBeGreaterThan(0);
});
test("a caller abort is recorded as aborted without an error", async () => {
  const controller = new AbortController();
  const f = fixture([{ type: "block_delta", blockId: "a", delta: "partial" }]);
  f.provider.stream = async function* (request) {
    yield { type: "block_delta", blockId: "a", delta: "partial" };
    controller.abort();
    request.signal?.throwIfAborted();
  };
  await expect(
    (async () => {
      for await (const _ of f.wrap().stream({ ...request, signal: controller.signal })) {
      }
    })(),
  ).rejects.toThrow();
  expect(f.booked[0]).toMatchObject({ status: "aborted", details: { error: null, cancelled: true } });
  expect(f.booked[0]!.usage!.estimated).toBe(true);
});
test("a thrown provider error keeps its message and the timing of the first visible block", async () => {
  const f = fixture([]);
  f.provider.stream = async function* () {
    yield { type: "block_start", blockId: "a", index: 0, kind: "text" };
    throw new Error("openai-compatible connection failed: socket hang up");
  };
  await expect(drain(f.wrap())).rejects.toThrow("socket hang up");
  expect(f.booked[0]).toMatchObject({
    status: "failed",
    details: { error: "openai-compatible connection failed: socket hang up", cancelled: false },
  });
  expect(f.booked[0]!.details!.firstBlockMs).toBeGreaterThanOrEqual(0);
  const complete = fixture([]);
  complete.provider.complete = async () => ({ message: { role: "assistant", content: [] }, finishReason: "error" });
  await complete.wrap().complete(request);
  expect(complete.booked[0]).toMatchObject({ status: "failed", details: { error: "The provider finished with error." } });
});
