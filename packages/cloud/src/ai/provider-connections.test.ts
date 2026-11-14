import { expect, test } from "bun:test";
import { AiProviderListError, classifyProviderFailure, listProviderModels } from "./provider-connections";

test("connection failures expose stable status without provider messages", () => {
  expect(classifyProviderFailure({ status: 401, message: "private" }).status).toBe("key_rejected");
  expect(classifyProviderFailure({ statusCode: 403 }).status).toBe("key_rejected");
  expect(classifyProviderFailure(new TypeError("private endpoint")).status).toBe("unreachable");
  expect(classifyProviderFailure({ name: "TimeoutError" }).status).toBe("unreachable");
  expect(classifyProviderFailure({ status: 429, message: "private" })).toEqual({
    status: "error",
    httpStatus: 429,
    message: "The provider request failed.",
  });
});

test("model discovery preserves reported context and output bounds for reasoning defaults", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        data: [
          { id: "reasoner", context_length: 1_048_576, max_output_tokens: 1_048_576 },
          { id: "router", context_length: 131_072, top_provider: { max_completion_tokens: 65_536 } },
        ],
      }),
    { preconnect: original.preconnect },
  );
  try {
    expect(await listProviderModels({ type: "openai-compatible", baseUrl: "https://example.invalid/v1" })).toEqual([
      { providerModel: "reasoner", contextWindow: 1_048_576, outputTokenLimit: 1_048_576 },
      { providerModel: "router", contextWindow: 131_072, outputTokenLimit: 65_536 },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
test("Anthropic discovery follows advancing cursors and keeps credentials in headers", async () => {
  const original = globalThis.fetch;
  const requests: { url: string; key: string | null }[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), key: new Headers(init?.headers).get("x-api-key") });
      return Response.json(
        requests.length === 1
          ? { data: [{ id: "first", display_name: "First" }], has_more: true, last_id: "first" }
          : { data: [{ id: "second" }], has_more: false },
      );
    },
    { preconnect: original.preconnect },
  );
  try {
    expect(await listProviderModels({ type: "anthropic", baseUrl: "https://example.invalid/v1", apiKey: "fixture" })).toEqual([
      { providerModel: "first", label: "First" },
      { providerModel: "second" },
    ]);
    expect(requests).toEqual([
      { url: "https://example.invalid/v1/models", key: "fixture" },
      { url: "https://example.invalid/v1/models?after_id=first", key: "fixture" },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
test("invalid discovery responses fail with a sanitized typed error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({ private: "provider response" }), { preconnect: original.preconnect });
  try {
    await expect(listProviderModels({ type: "openai", baseUrl: null })).rejects.toBeInstanceOf(AiProviderListError);
  } finally {
    globalThis.fetch = original;
  }
});
