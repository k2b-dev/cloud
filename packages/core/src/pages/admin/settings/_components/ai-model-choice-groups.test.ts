import { describe, expect, test } from "bun:test";
import { AI_MODEL_CHOICE_GROUPS, aiModelChoiceGroups, aiModelGroupFiltersFor } from "./ai-model-choice-groups";

describe("AI model choice groups", () => {
  test("uses the complete model taxonomy", () => {
    expect(AI_MODEL_CHOICE_GROUPS.map((group) => group.label)).toEqual(["Hosted", "Private", "Vision", "Tools"]);
  });

  test("supports overlapping boundaries and capabilities", () => {
    expect(aiModelChoiceGroups({ dataBoundary: "private", capabilities: ["streaming", "vision", "tools"] })).toEqual([
      "private",
      "vision",
      "tools",
    ]);
  });

  test("omits groups absent from the current options", () => {
    expect(
      aiModelGroupFiltersFor([{ dataBoundary: "hosted", capabilities: ["streaming", "tools"] }]).map((group) => group.label),
    ).toEqual(["Hosted", "Tools"]);
  });
});
