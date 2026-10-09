import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { assistantAiSettingsState, isAssistantChatTurn, resolveAssistantAudioModel, selectAssistantAiModelId } from "./assistant-models";
import { aiModelAccess } from "./model-access";
import * as settings from "./settings";
import * as transcription from "./transcription";
import type { AiModelProfile, AiPublicModelProfile } from "./types";

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
  spyOn(transcription, "resolveAiAudioModel").mockRejectedValue(new Error("No audio model configured"));
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
    expect(status.audioModelConfigured).toBe(false);
    expect(transcription.resolveAiAudioModel).toHaveBeenCalledTimes(1);
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

const audioProfile: AiModelProfile = {
  id: "speech",
  label: "Speech",
  provider: "openai-compatible",
  model: "whisper",
  baseURL: "https://example.invalid/v1",
  enabled: true,
  capabilities: ["transcription"],
  dataBoundary: "private",
};

const setupAudio = () => {
  const model = { profile: audioProfile, provider: transcription.createAiTranscriptionProvider(audioProfile) };
  spyOn(transcription, "resolveAiAudioModel").mockResolvedValue(model);
  return model;
};

test("Assistant audio access failures keep their cause during configuration classification", async () => {
  setupAudio();
  const aiError = { code: "model_access_denied", message: "Model access denied" };
  spyOn(aiModelAccess, "assertAllowed").mockRejectedValue(Object.assign(new Error(aiError.message), { aiError }));
  let failure: unknown;
  try {
    await resolveAssistantAudioModel(subject);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(transcription.AiTranscriptionError);
  if (!(failure instanceof transcription.AiTranscriptionError)) throw new Error("Expected audio access failure");
  expect(failure.code).toBe("transcription_access_denied");
  expect(failure.message).toBe(
    "Audio transcription is not available to you: you do not have access to the audio model. An administrator can grant access in the AI settings.",
  );
  expect(failure).toMatchObject({ aiError });
  expect(transcription.describeTranscriptionFailure(failure, "configuration")).toBe(failure);
});

test("Assistant audio resolution passes the subject and data boundaries to their owners", async () => {
  const model = setupAudio();
  const access = spyOn(aiModelAccess, "assertAllowed").mockResolvedValue();
  expect(await resolveAssistantAudioModel(subject, ["private"])).toBe(model);
  expect(transcription.resolveAiAudioModel).toHaveBeenCalledWith({ allowedDataBoundaries: ["private"] });
  expect(access).toHaveBeenCalledWith(audioProfile.id, subject);
});

test("Assistant audio resolution rethrows unrelated access errors unchanged", async () => {
  setupAudio();
  const failure = new Error("Access database unavailable");
  spyOn(aiModelAccess, "assertAllowed").mockRejectedValue(failure);
  await expect(resolveAssistantAudioModel(subject)).rejects.toBe(failure);
});
