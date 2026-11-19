import { expect, test } from "bun:test";
import { AUTOMATION_TURN_BUDGET } from "@k2b/cloud/ai/runtime";
import { aiCostDecimal, aiCostUnits, aiDecimalUnits } from "@k2b/cloud/shared";
import { codeAiBudgetRemainder } from "./ai-budget";
import { codeChatBudgetMessages } from "./chat-budget-messages";
import { assertCodeChatTurnFits, codeChatCallOutputTokens, codeChatTurnMaximum } from "./chat-turn-budget";

const briefingModel = { pricing: { inputPerMillion: 2.5, outputPerMillion: 10 }, contextWindow: 128_000 };

test("reserves the input allowance, one call of estimation margin and the turn's output allowance", () => {
  // (192,000 + 32,000) input at 1 USD and 12,000 output at 2 USD per million tokens.
  expect(codeChatTurnMaximum({ pricing: { inputPerMillion: 1, outputPerMillion: 2 }, contextWindow: 128_000 })).toBe("0.248000000000");
  // The window only decides how unknown usage is charged; it never enlarges the reservation.
  expect(codeChatTurnMaximum({ pricing: { inputPerMillion: 1, outputPerMillion: 2 }, contextWindow: 1_000_000 })).toBe("0.248000000000");
});

test("each call is capped by the turn budget, below a lower model ceiling", () => {
  expect(codeChatCallOutputTokens({})).toBe(AUTOMATION_TURN_BUDGET.maxOutputTokens);
  expect(codeChatCallOutputTokens({ outputTokenLimit: 1_000_000 })).toBe(AUTOMATION_TURN_BUDGET.maxOutputTokens);
  expect(codeChatCallOutputTokens({ maxOutputTokens: 2000, outputTokenLimit: 16_000 })).toBe(2000);
});

test("free and unpriced models have no monetary maximum", () => {
  expect(codeChatTurnMaximum({})).toBe("0");
  expect(codeChatTurnMaximum({ pricing: { inputPerMillion: 0, outputPerMillion: 0 } })).toBe("0");
});

test.each(["de", "en"])("the unpriced-model reason names the automation, model and remedy in %s", (locale) => {
  const message = codeChatBudgetMessages(locale).unpricedModel({ automation: "Morning briefing", model: "Test Model" });
  expect(message).toContain("Morning briefing");
  expect(message).toContain("Test Model");
  expect(message).toContain(locale === "de" ? "Preis" : "price");
  expect(message).toContain(
    locale === "de"
      ? "Administration kann den Preis in der Modellverwaltung eintragen"
      : "administrator can enter the price in model management",
  );
});

test("priced models without an authoritative context limit cannot prove the maximum", () => {
  expect(codeChatTurnMaximum({ pricing: { inputPerMillion: 1, outputPerMillion: 1 } })).toBeNull();
});

test("a briefing at 2.50/10 USD with a 128k window fits a 1 USD day, and a second turn still fits after it", () => {
  const maximum = codeChatTurnMaximum(briefingModel);
  expect(maximum).toBe("0.680000000000");
  expect(() => assertCodeChatTurnFits(briefingModel, { code: 1, owner: 1 })).not.toThrow();
  // Median measured briefing (16.11.2026): 101,434 input and 2,804 output tokens.
  const briefing = aiCostDecimal(aiCostUnits(briefingModel.pricing, 101_434, 2_804));
  expect(codeAiBudgetRemainder(1, briefing)).toBeGreaterThanOrEqual(aiDecimalUnits(maximum!));
});

test("the reservation never falls below the cost of a turn that stays within its allowance", () => {
  for (const pricing of [
    { inputPerMillion: 2.5, outputPerMillion: 10 },
    { inputPerMillion: 0.4, outputPerMillion: 1.6 },
    { inputPerMillion: 15, outputPerMillion: 75 },
    { inputPerMillion: 3, outputPerMillion: 0 },
  ]) {
    const maximum = aiDecimalUnits(codeChatTurnMaximum({ pricing, contextWindow: 128_000 })!);
    // The guard admits a last call whose estimate fits; its real input may exceed the estimate by up to one call.
    const worst = aiCostUnits(
      pricing,
      AUTOMATION_TURN_BUDGET.inputTokens + AUTOMATION_TURN_BUDGET.reserveInputTokens,
      AUTOMATION_TURN_BUDGET.outputTokens,
    );
    expect(worst).toBeLessThanOrEqual(maximum);
    expect(aiCostUnits(pricing, AUTOMATION_TURN_BUDGET.inputTokens, AUTOMATION_TURN_BUDGET.outputTokens)).toBeLessThanOrEqual(maximum);
  }
});

test("a fresh day cannot admit a maximum above either daily limit", () => {
  const profile = { pricing: { inputPerMillion: 10, outputPerMillion: 40 }, contextWindow: 128_000 };
  expect(() => assertCodeChatTurnFits(profile, { code: 1, owner: 1 })).toThrow("code_ai_turn_exceeds_daily_budget");
  expect(() => assertCodeChatTurnFits(profile, { code: 10, owner: 1 })).toThrow("code_ai_turn_exceeds_daily_budget");
  expect(() => assertCodeChatTurnFits(profile, { code: 10, owner: 10 })).not.toThrow();
});
