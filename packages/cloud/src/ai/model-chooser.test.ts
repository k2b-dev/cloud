import { describe, expect, test } from "bun:test";
import type { AiPeopleModels } from "../shared/ai-models";
import { aiModelBlocksSending, aiModelRequestFor, resolveAiModelChoice } from "./model-chooser";

const mark = { kind: "mark" as const, text: "CO", color: "#0f766e" };
// Like the people API: the model behind Maximum is no longer allowed, so it is not among the options.
const models: AiPeopleModels = {
  status: "ok",
  selection: null,
  effectiveDefault: { class: "balanced" },
  classes: [
    { class: "balanced", variantId: "gpt-oss" },
    { class: "maximum", variantId: "claude", unavailable: { code: "access_revoked" } },
  ],
  options: [
    { id: "gpt-oss", label: "GPT-OSS", description: "Für die meisten Aufgaben", icon: mark, classes: ["balanced"] },
    { id: "qwen", label: "Qwen", description: "Im Haus", icon: mark, classes: [] },
  ],
};

describe("model choice", () => {
  test("a class whose model is no longer allowed keeps its reason and holds the draft back", () => {
    expect(resolveAiModelChoice(models, { class: "maximum" })).toMatchObject({
      option: undefined,
      class: "maximum",
      unavailable: { code: "access_revoked" },
    });
    expect(aiModelBlocksSending({ status: "ready", models }, { class: "maximum" })).toBe(true);
    expect(aiModelBlocksSending({ status: "ready", models }, { class: "balanced" })).toBe(false);
  });

  test("picking a model inside a class keeps the class, a model outside stays a model", () => {
    expect(aiModelRequestFor(models, "gpt-oss")).toEqual({ class: "balanced" });
    expect(aiModelRequestFor(models, "qwen")).toEqual({ id: "qwen" });
  });
});
