import { expect, test } from "bun:test";
import type { Provider, ProviderEvent } from "@k2b/nessi";
import { aiQuotas } from "./quotas";
import { quotaProvider } from "./quota-provider";
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
