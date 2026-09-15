import { expect, test } from "bun:test";
import type { Provider, ProviderEvent } from "@k2b/nessi";
import { aiQuotas } from "./quotas";
import { quotaProvider, assistantQuotaProvider } from "./quota-provider";
const subject = { type: "user" as const, userId: crypto.randomUUID() };
const request = { messages: [] };
const event: ProviderEvent = { type: "usage", usage: { input: 8, output: 2, total: 10 } };
function fixture(events: ProviderEvent[], constrained = false) {
  const booked: Parameters<typeof aiQuotas.finish>[1][] = [];
  let calls = 0,
    completions = 0;
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
      completions++;
      return { message: { role: "assistant", content: [] }, finishReason: "stop" };
    },
  };
  const quotas = {
    ...aiQuotas,
    assertAllowed: async () => constrained,
    begin: async () => crypto.randomUUID(),
    finish: async (_id: string, u: Parameters<typeof aiQuotas.finish>[1]) => {
      booked.push(u);
    },
  };
  return {
    booked,
    quotas,
    provider,
    get calls() {
      return calls;
    },
    get completions() {
      return completions;
    },
  };
}
async function drain(provider: Provider) {
  for await (const _ of provider.stream(request)) {
  }
}
test("snapshot usage is recorded once, not added, and complete bypasses accounting", async () => {
  const f = fixture([event, event]);
  const p = quotaProvider(f.provider, subject, "a", "t", f.quotas);
  await drain(p);
  await p.complete(request);
  expect(f.booked).toEqual([{ input: 8, output: 2 }]);
  expect(f.completions).toBe(1);
});
test("missing and synthetic-zero usage stays unknown", async () => {
  for (const events of [[], [{ type: "usage" as const, usage: { input: 0, output: 0, total: 0 } }]]) {
    const f = fixture(events);
    await drain(quotaProvider(f.provider, subject, "a", "t", f.quotas));
    expect(f.booked).toEqual([undefined]);
  }
});
test("disabled or unlimited accounting failures do not block inference", async () => {
  const f = fixture([event]);
  f.quotas.begin = async () => {
    throw new Error("DB unavailable");
  };
  await drain(quotaProvider(f.provider, subject, "a", "t", f.quotas));
  expect(f.calls).toBe(1);
});
test("finite quota fails closed before starting unrecordable inference", async () => {
  const f = fixture([event], true);
  f.quotas.begin = async () => {
    throw new Error("DB unavailable");
  };
  await expect(drain(quotaProvider(f.provider, subject, "a", "t", f.quotas))).rejects.toThrow("DB unavailable");
  expect(f.calls).toBe(0);
});
test("each round checks again and second round stops when exhausted", async () => {
  const f = fixture([event], true);
  f.quotas.assertAllowed = async () => {
    if (f.calls) throw new Error("quota_exhausted");
    return true;
  };
  const p = quotaProvider(f.provider, subject, "a", "t", f.quotas);
  await drain(p);
  await expect(drain(p)).rejects.toThrow("quota_exhausted");
  expect(f.calls).toBe(1);
});
test("consumer abort still finalizes already reported usage", async () => {
  const f = fixture([event, event]);
  for await (const _ of quotaProvider(f.provider, subject, "a", "t", f.quotas).stream(request)) break;
  expect(f.booked).toEqual([{ input: 8, output: 2 }]);
});
test("known context rejection is zero usage, allowing compaction retry", async () => {
  const f = fixture([
    { type: "issue", issue: { kind: "provider_error", message: "context too long", contextOverflow: true, retryable: false } },
  ]);
  await drain(quotaProvider(f.provider, subject, "a", "t", f.quotas));
  expect(f.booked).toEqual([{ input: 0, output: 0 }]);
});

test("stop before final usage books a labelled input/output estimate", async () => {
  const f = fixture([{ type: "block_delta", blockId: "text", delta: "Partial output" }], true);
  for await (const _ of quotaProvider(f.provider, subject, "a", "t", f.quotas).stream({ messages: [{ role: "user", content: [{ type: "text", text: "Prompt that must also be counted" }] }] })) break;
  expect(f.booked[0]?.estimated).toBe(true);
  expect(f.booked[0]!.input).toBeGreaterThan(0);
  expect(f.booked[0]!.output).toBeGreaterThan(0);
});
test("provider failure and thrown timeout without final usage do not book unknown", async () => {
  const f = fixture([{ type: "issue", issue: { kind: "provider_error", message: "503", retryable: true } }], true);
  await drain(quotaProvider(f.provider, subject, "a", "t", f.quotas));
  expect(f.booked[0]?.estimated).toBe(true);
  f.provider.stream = async function* () { throw new Error("timeout"); };
  await expect(drain(quotaProvider(f.provider, subject, "a", "t", f.quotas))).rejects.toThrow("timeout");
  expect(f.booked[1]?.estimated).toBe(true);
});
test("executor provider gate wraps only direct Assistant turns", () => {
  const f = fixture([]);
  expect(assistantQuotaProvider(f.provider, { input: "job", assistantChat: true, mandate: { id: "mandate", revision: 1 } }, subject, "a", "t")).toBe(f.provider);
  expect(assistantQuotaProvider(f.provider, { input: "job" }, subject, "a", "t")).toBe(f.provider);
  expect(assistantQuotaProvider(f.provider, { input: "chat", assistantChat: true }, null, "a", "t")).toBe(f.provider);
  expect(assistantQuotaProvider(f.provider, { input: "chat", assistantChat: true }, subject, "a", "t")).not.toBe(f.provider);
});

test("interrupted estimates ignore stream chunking and encoded files and include system prompt", async () => {
  const failure: ProviderEvent = { type: "issue", issue: { kind: "provider_error", message: "lost", retryable: true } };
  const a = fixture([{ type: "block_delta", blockId: "a", delta: "hello world" }, failure]);
  const b = fixture([...Array.from("hello world", delta => ({ type: "block_delta" as const, blockId: "a", delta })), failure]);
  const req = { messages: [{ role: "user" as const, content: [{ type: "file" as const, data: "A".repeat(100000), mediaType: "image/png" }] }], systemPrompt: "S".repeat(400) };
  for (const f of [a,b]) for await (const _ of quotaProvider(f.provider, subject, "a", "t", f.quotas).stream(req)) {}
  expect(a.booked).toEqual(b.booked);
  expect(a.booked[0]?.output).toBe(3);
  expect(a.booked[0]!.input).toBeGreaterThanOrEqual(100);
  expect(a.booked[0]!.input).toBeLessThan(200);
});
test("final-only tool blocks contribute to interrupted estimates", async () => {
  const f = fixture([{ type: "block_end", blockId: "tool", index: 0, block: { type: "tool_call", id: "call", name: "search", args: { query: "weather" } } }]);
  for await (const _ of quotaProvider(f.provider, subject, "a", "t", f.quotas).stream(request)) break;
  expect(f.booked[0]!.output).toBeGreaterThan(0);
});

test("abort signal and explicit abort finish reason estimate missing usage", async () => {
  const abort = new AbortController();
  abort.abort();
  const f = fixture([]);
  for await (const _ of quotaProvider(f.provider, subject, "a", "t", f.quotas).stream({ ...request, signal: abort.signal })) {}
  expect(f.booked[0]?.estimated).toBe(true);
  const g = fixture([{ type: "usage", usage: { input: 0, output: 0, total: 0 }, finishReason: "aborted" }]);
  await drain(quotaProvider(g.provider, subject, "a", "t", g.quotas));
  expect(g.booked[0]?.estimated).toBe(true);
});
