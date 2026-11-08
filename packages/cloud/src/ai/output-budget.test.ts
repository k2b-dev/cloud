import { expect, test } from "bun:test";
import { aiOutputBudget } from "./output-budget";
import { createAiProvider } from "./provider";
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
const provider = createAiProvider(profile);
const plain = { ...provider, capabilities: { ...provider.capabilities, thinking: false } };

test("reasoning uses the reported output maximum bounded by space after the prompt, without a fractional cap", () => {
  expect(aiOutputBudget({ ...profile, outputTokenLimit: 65_536 }, provider, 1_000)).toBe(65_536);
  expect(aiOutputBudget({ ...profile, outputTokenLimit: 1_048_576 }, provider, 1_000)).toBe(130_072);
  expect(aiOutputBudget(profile, provider, 1_000)).toBe(130_072);
  expect(aiOutputBudget(profile, plain, 1_000)).toBeUndefined();
  expect(aiOutputBudget({ ...profile, reasoningEffort: "high" }, plain, 1_000)).toBe(130_072);
  expect(aiOutputBudget({ ...profile, extraBody: { thinking: { type: "enabled" } } }, plain, 1_000)).toBe(130_072);
  expect(aiOutputBudget({ ...profile, reasoningEffort: "none" }, provider, 1_000)).toBeUndefined();
  expect(aiOutputBudget({ ...profile, outputTokenLimit: undefined }, provider, 1_000)).toBeUndefined();
});

test("explicit request or catalog output budgets win, including for non-reasoning calls", () => {
  const configured = { ...profile, maxOutputTokens: 65_536, outputTokenLimit: 16_384 };
  expect(aiOutputBudget(configured, provider, 100_000)).toBe(65_536);
  expect(aiOutputBudget(configured, plain, 100_000)).toBe(65_536);
  expect(aiOutputBudget(configured, provider, 100_000, { maxOutputTokens: 10 })).toBe(10);
});
