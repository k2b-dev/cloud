import { describe, expect, test } from "bun:test";
import {
  AI_MODEL_CLASSES,
  type AiModelClass,
  AiModelRequestSchema,
  aiModelClassFallbackChain,
  parseAiModelChoice,
} from "../shared/ai-models";
import { aiAssignmentFixture, aiModelFixture, aiSettingsFixture } from "./model-fixture";
import { resolveAiModelRef, selectAiModelProfile } from "./settings";

describe("model class resolution", () => {
  const chains: Record<AiModelClass, AiModelClass[]> = {
    fast: ["balanced", "thorough", "maximum"],
    balanced: ["fast", "thorough", "maximum"],
    thorough: ["balanced", "fast", "maximum"],
    maximum: ["thorough", "balanced", "fast"],
  };
  for (const requested of AI_MODEL_CLASSES) {
    test(`${requested} only falls back through empty assignments`, () => {
      expect(aiModelClassFallbackChain(requested)).toEqual(chains[requested]!);
      for (const [index, candidate] of [requested, ...aiModelClassFallbackChain(requested)].entries()) {
        const state = aiSettingsFixture({ assignments: [aiAssignmentFixture(candidate, "chat")] });
        expect(resolveAiModelRef(state, { class: requested })).toEqual({ requestedClass: requested, class: candidate, id: "chat" });
        expect(index).toBeGreaterThanOrEqual(0);
      }
    });
  }
  test("default is balanced; empty, disabled and explicit missing are distinct", () => {
    expect(resolveAiModelRef(aiSettingsFixture())).toEqual({ requestedClass: "balanced", class: "balanced", id: "chat" });
    expect(() => resolveAiModelRef(aiSettingsFixture({ assignments: [] }))).toThrow("No AI model class");
    expect(() => resolveAiModelRef(aiSettingsFixture({ enabled: false }))).toThrow("AI is disabled");
    expect(() => selectAiModelProfile(aiSettingsFixture(), { kind: "selectable" }, { id: "missing" })).toThrow("missing, disabled");
  });
  test("an assigned disabled, forbidden or incompatible model never falls back", () => {
    const state = aiSettingsFixture({
      profiles: [aiModelFixture({ enabled: false }), aiModelFixture({ id: "other", enabled: true })],
      assignments: [aiAssignmentFixture("balanced", "chat"), aiAssignmentFixture("fast", "other")],
    });
    expect(() => selectAiModelProfile(state, { kind: "platform-default" })).toThrow();
    state.profiles[0] = aiModelFixture();
    expect(() => selectAiModelProfile(state, { kind: "selectable", allowedModelIds: ["other"] })).toThrow();
    expect(() => selectAiModelProfile(state, { kind: "selectable", requiredCapabilities: ["vision"] })).toThrow();
    expect(() => selectAiModelProfile(state, { kind: "selectable", allowedDataBoundaries: ["hosted"] })).toThrow();
  });
  test("CLI choices and strict transport use the same union", () => {
    expect(parseAiModelChoice("fast")).toEqual({ class: "fast" });
    expect(parseAiModelChoice("example:deep")).toEqual({ id: "example:deep" });
    for (const input of ["fast", {}, { class: "unknown" }, { class: "fast", id: "chat" }])
      expect(AiModelRequestSchema.safeParse(input).success).toBe(false);
  });
});
