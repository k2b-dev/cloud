import { expect, test } from "bun:test";
import { assertCodeChatTurnFits, codeChatTurnMaximum } from "./chat-turn-budget";

test("reserves input and all sixteen completions including reasoning and compaction", () => {
  expect(codeChatTurnMaximum({ pricing: { inputPerMillion: 1, outputPerMillion: 2 }, outputTokenLimit: 1000, contextWindow: 128000 })).toBe(
    "0.672000000000",
  );
  expect(
    codeChatTurnMaximum({
      pricing: { inputPerMillion: 1, outputPerMillion: 2 },
      maxOutputTokens: 2000,
      outputTokenLimit: 1000,
      contextWindow: 128000,
    }),
  ).toBe("0.704000000000");
});
test("priced turns require a known output ceiling, including input-only pricing", () => {
  for (const pricing of [
    { inputPerMillion: 1, outputPerMillion: 0 },
    { inputPerMillion: 0, outputPerMillion: 2 },
  ]) {
    expect(codeChatTurnMaximum({ pricing, contextWindow: 128000 })).toBeNull();
    expect(codeChatTurnMaximum({ pricing, maxOutputTokens: 0, contextWindow: 128000 })).toBeNull();
  }
});
test("free and unpriced models have no monetary maximum and still need ordinary AI policy", () => {
  expect(codeChatTurnMaximum({})).toBe("0");
  expect(codeChatTurnMaximum({ pricing: { inputPerMillion: 0, outputPerMillion: 0 } })).toBe("0");
});

test("priced models without an authoritative context limit cannot prove the maximum", () => {
  expect(codeChatTurnMaximum({ pricing: { inputPerMillion: 1, outputPerMillion: 1 }, maxOutputTokens: 1000 })).toBeNull();
});

test("a fresh day cannot admit a maximum above either daily limit", () => {
  const profile = { pricing: { inputPerMillion: 2.5, outputPerMillion: 10 }, contextWindow: 128000, maxOutputTokens: 16000 };
  expect(() => assertCodeChatTurnFits(profile, { code: 1, owner: 1 })).toThrow("code_ai_turn_exceeds_daily_budget");
  expect(() => assertCodeChatTurnFits(profile, { code: 10, owner: 1 })).toThrow("code_ai_turn_exceeds_daily_budget");
  expect(() => assertCodeChatTurnFits(profile, { code: 10, owner: 10 })).not.toThrow();
});
