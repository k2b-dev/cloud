import { expect, test } from "bun:test";
import { AiExtraBodySchema } from "./ai-request-options";

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
