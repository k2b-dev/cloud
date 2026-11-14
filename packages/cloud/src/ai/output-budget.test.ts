import { expect, test } from "bun:test";
import { aiOutputBudget } from "./output-budget";
import type { AiModelProfile } from "./types";

const profile: AiModelProfile = {
  id: "fixture",
  modelId: "fixture",
  providerId: "fixture",
  label: "Fixture",
  variantLabel: "Standard",
  description: "",
  icon: { kind: "provider" },
  showInPicker: true,
  provider: "openai-compatible",
  model: "fixture",
  enabled: true,
  capabilities: [],
  dataBoundary: "private",
  baseURL: "https://example.invalid/v1",
  contextWindow: 131_072,
  outputTokenLimit: 1_048_576,
};
test("reported output maxima are bounded only by known context space, without a fractional cap", () => {
  expect(aiOutputBudget({ ...profile, outputTokenLimit: 65_536 }, 1_000)).toBe(65_536);
  expect(aiOutputBudget(profile, 1_000)).toBe(130_072);
  expect(aiOutputBudget({ ...profile, reasoningEffort: "high" }, 1_000)).toBe(130_072);
  expect(aiOutputBudget({ ...profile, extraBody: { thinking: { type: "enabled" } } }, 1_000)).toBe(130_072);
  expect(aiOutputBudget({ ...profile, reasoningEffort: "none" }, 1_000)).toBe(130_072);
  expect(aiOutputBudget({ ...profile, outputTokenLimit: undefined }, 1_000)).toBeUndefined();
  expect(aiOutputBudget(profile, 140_000)).toBe(1);
});

test("unknown context windows preserve the full reported output limit", () => {
  expect(aiOutputBudget({ ...profile, contextWindow: undefined }, 1_000)).toBe(1_048_576);
  expect(aiOutputBudget({ ...profile, contextWindow: undefined }, 150_000)).toBe(1_048_576);
});

test("explicit request or catalog output budgets win, including for non-reasoning calls", () => {
  const configured = { ...profile, maxOutputTokens: 65_536, outputTokenLimit: 16_384 };
  expect(aiOutputBudget(configured, 100_000)).toBe(65_536);
  expect(aiOutputBudget(configured, 100_000, { maxOutputTokens: 10 })).toBe(10);
});
