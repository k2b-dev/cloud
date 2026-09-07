import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { assistantAiSettingsState, isAssistantChatTurn, selectAssistantAiModelId } from "./assistant-models";
import { aiModelAccess } from "./model-access";
import * as settings from "./settings";
import type { AiPublicModelProfile } from "./types";

const subject = { type: "user" as const, userId: "user" };
const models: AiPublicModelProfile[] = ["restricted", "allowed"].map((id) => ({
  id,
  label: id,
  provider: "ollama",
  model: id,
  capabilities: ["streaming"],
  dataBoundary: "private",
}));
afterEach(() => mock.restore());
const setup = (allowed = models.slice(1)) => {
  spyOn(settings, "listAiModels").mockResolvedValue(models);
  spyOn(settings, "toPublicAiSettingsState").mockResolvedValue({
    ok: true,
    enabled: true,
    defaultModelId: "restricted",
    visionModelConfigured: true,
    error: null,
    firecrawlConfigured: false,
    models,
  });
  spyOn(aiModelAccess, "filterModels").mockImplementation(async (candidates) =>
    candidates.filter((candidate) => allowed.some((model) => model.id === candidate.id)),
  );
  spyOn(aiModelAccess, "assertAllowed").mockImplementation(async (id) => {
    if (!allowed.some((model) => model.id === id)) throw new Error("Model access denied");
  });
};

describe("Assistant model boundary", () => {
  test("explicit forbidden selections cannot silently fall back", async () => {
    setup();
    await expect(selectAssistantAiModelId(subject, "restricted")).rejects.toThrow("Model access denied");
    expect(await selectAssistantAiModelId(subject, "allowed")).toBe("allowed");
  });
  test("an unspecified model uses an allowed default and the status exposes the same models", async () => {
    setup();
    expect(await selectAssistantAiModelId(subject)).toBe("allowed");
    const status = await assistantAiSettingsState(subject);
    expect(status.defaultModelId).toBe("allowed");
    expect(status.models.map((model) => model.id)).toEqual(["allowed"]);
    expect(status.visionModelConfigured).toBe(true);
  });
  test("locked and platform-default policies never substitute another allowed model", async () => {
    setup();
    await expect(selectAssistantAiModelId(subject, "allowed", { kind: "locked", modelId: "restricted" })).rejects.toThrow(
      "Model access denied",
    );
    await expect(selectAssistantAiModelId(subject, "allowed", { kind: "platform-default" })).rejects.toThrow("Model access denied");
    expect(await selectAssistantAiModelId(subject, "restricted", { kind: "locked", modelId: "allowed" })).toBe("allowed");
  });
  test("no grants produces an empty picker and a clear submission failure", async () => {
    setup([]);
    expect((await assistantAiSettingsState(subject)).defaultModelId).toBe("");
    await expect(selectAssistantAiModelId(subject)).rejects.toThrow("No AI model is available");
  });
  test("only marked interactive turns are restricted; background default-tool deliveries stay exempt", () => {
    expect(isAssistantChatTurn({ input: "chat", assistantChat: true })).toBe(true);
    expect(isAssistantChatTurn({ input: "delivery", toolSource: { kind: "default" } })).toBe(false);
    expect(isAssistantChatTurn({ input: "job", assistantChat: true, mandate: { id: "mandate", revision: 1 } })).toBe(false);
    expect(isAssistantChatTurn({ input: "job" })).toBe(false);
  });
});
