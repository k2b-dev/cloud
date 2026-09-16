import { expect, test } from "bun:test";
import type { Provider, ProviderEvent } from "@k2b/nessi";
import { inferenceProvider } from "./quota-provider";
import type { AiModelProfile } from "./types";
import { AiBackgroundCostError, type AiCallContext } from "./inference-calls";
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
  const booked: { usage: { input: number; output: number; estimated?: boolean } | undefined; status: string }[] = [];
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
    finish: async (_id: string, usage: { input: number; output: number; estimated?: boolean } | undefined, status: "ok" | "failed") => {
      booked.push({ usage, status });
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
  expect(a.booked).toEqual(b.booked);
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
