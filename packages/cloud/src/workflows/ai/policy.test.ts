import { expect, test } from "bun:test";
import type { AiModelProfile } from "../../ai/types";
import { workflowAiHash, workflowAiModelHash } from "./policy";

const profile: AiModelProfile = {
  id: "model",
  label: "Model",
  provider: "openai",
  model: "test",
  enabled: true,
  capabilities: [],
  dataBoundary: "private",
};
test("canonical inference identity includes the resolved model configuration and full request", () => {
  expect(workflowAiHash({ b: 2, a: 1 })).toBe(workflowAiHash({ a: 1, b: 2 }));
  for (const change of [{ model: "other" }, { temperature: 0.5 }, { extraBody: { seed: 1 } }, { baseURL: "https://example.test" }]) {
    expect(workflowAiModelHash({ ...profile, ...change })).not.toBe(workflowAiModelHash(profile));
  }
  const request = { prompt: "Choose", input: { body: "hello" }, choices: ["a", "b"] };
  for (const change of [
    { prompt: "Other" },
    { input: { body: "changed" } },
    { choices: ["b", "a"] },
    { fields: [{ name: "amount", type: "number" }] },
  ]) {
    expect(workflowAiHash({ ...request, ...change })).not.toBe(workflowAiHash(request));
  }
});

test("cosmetic model profile edits preserve inference identity", () => {
  for (const change of [
    { label: "Renamed" },
    { image: "data:image/png;base64,abc" },
    { capabilities: ["vision" as const] },
    { maxToolRounds: 2 },
    { maxLoadedTools: 3 },
  ]) {
    expect(workflowAiModelHash({ ...profile, ...change })).toBe(workflowAiModelHash(profile));
  }
});
