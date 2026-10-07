import { expect, test } from "bun:test";
import { AiExtraBodySchema } from "./ai-request-options";

test("extra parameters reserve model selection, answer counts and normalized provider keys", () => {
  for (const body of [
    { models: ["other/model"] },
    { route: "fallback" },
    { n: 2 },
    { generationConfig: { candidateCount: 2 } },
    { generation_config: { max_output_tokens: 90000 } },
    { generation_config: "x" },
    { system_instruction: {} },
    { tool_config: {} },
    { Max_Tokens: 1 },
    { generation_config: { response_mime_type: "text/plain" } },
  ]) {
    expect(AiExtraBodySchema.safeParse(body).success).toBeFalse();
  }
  for (const body of [
    { generationConfig: { thinkingConfig: { thinkingBudget: 1024 } } },
    { generation_config: { thinking_config: { thinking_budget: 0 } } },
    { provider: { order: ["a"] } },
    { chat_template_kwargs: { enable_thinking: false } },
  ]) {
    expect(AiExtraBodySchema.safeParse(body).success).toBeTrue();
  }
});

test("extra parameters enforce the exact serialized UTF-8 limit", () => {
  const overhead = JSON.stringify({ custom: "" }).length;
  expect(AiExtraBodySchema.safeParse({ custom: "a".repeat(8192 - overhead) }).success).toBeTrue();
  expect(AiExtraBodySchema.safeParse({ custom: "a".repeat(8193 - overhead) }).success).toBeFalse();
  expect(AiExtraBodySchema.safeParse({ custom: "ä".repeat(Math.ceil((8192 - overhead) / 2)) }).success).toBeFalse();
});

test("extra parameters reject non-JSON values and prototype keys without throwing", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const value of [
    new Date(),
    { custom: new Date() },
    { custom: undefined },
    { custom: () => {} },
    { custom: Infinity },
    { custom: 1n },
    cyclic,
    JSON.parse('{"__proto__":{}}'),
    { constructor: {} },
  ]) {
    expect(AiExtraBodySchema.safeParse(value).success).toBeFalse();
  }
  expect(AiExtraBodySchema.safeParse({ toString: true, chat_template_kwargs: { enable_thinking: false } }).success).toBeTrue();
});
