import { describe, expect, spyOn, test } from "bun:test";
import {
  AI_MODEL_CLASSES,
  type AiModelClass,
  AiModelRequestSchema,
  aiModelClassFallbackChain,
  parseAiModelChoice,
} from "../shared/ai-models";
import * as credentials from "./credentials";
import { aiAssignmentFixture, aiModelFixture, aiSettingsFixture } from "./model-fixture";
import * as connections from "./provider-connections";
import * as requestHeaders from "./request-headers";
import { resolveAiModelFromState, resolveAiModelRef, selectAiModelProfile } from "./settings";

describe("model class resolution", () => {
  test("legacy reasoning models discover real output ceilings; explicit budgets avoid discovery and unavailable metadata preserves defaults", async () => {
    const credential = spyOn(credentials, "getAiCredential").mockResolvedValue(null);
    const headers = spyOn(requestHeaders, "getAiRequestHeaders").mockResolvedValue({});
    const listing = spyOn(connections, "listProviderModels").mockResolvedValue([
      { providerModel: "chat", contextWindow: 1_048_576, outputTokenLimit: 65_536 },
    ]);
    const profile = aiModelFixture({ provider: "openai-compatible", baseURL: "https://example.invalid/v1" });
    try {
      const resolved = await resolveAiModelFromState(aiSettingsFixture({ profiles: [profile] }));
      expect(resolved.profile.outputTokenLimit).toBe(65_536);
      expect(resolved.provider.contextWindow).toBe(1_048_576);
      expect(listing).toHaveBeenCalledTimes(1);
      await resolveAiModelFromState(aiSettingsFixture({ profiles: [{ ...profile, maxOutputTokens: 123 }] }));
      expect(listing).toHaveBeenCalledTimes(1);
      listing.mockRejectedValue(new Error("Unavailable listing"));
      const unknown = await resolveAiModelFromState(aiSettingsFixture({ profiles: [profile] }));
      expect(unknown.profile.outputTokenLimit).toBeUndefined();
    } finally {
      credential.mockRestore();
      headers.mockRestore();
      listing.mockRestore();
    }
  });
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
    expect(() => selectAiModelProfile(aiSettingsFixture(), { kind: "selectable" }, { id: "missing" })).toThrow("does not exist");
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
