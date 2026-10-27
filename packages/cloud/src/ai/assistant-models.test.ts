import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { isAssistantChatTurn, resolveAssistantAudioModel, selectAssistantAiModel } from "./assistant-models";
import { aiModelAccess } from "./model-access";
import { aiModelFixture, aiSettingsFixture } from "./model-fixture";
import * as settings from "./settings";
import * as transcription from "./transcription";
import type { AiModelProfile } from "./types";

const subject = { type: "user" as const, userId: "user" };
afterEach(() => mock.restore());
test("classes never substitute on denied access", async () => {
  spyOn(settings, "readAiSettingsState").mockResolvedValue(aiSettingsFixture());
  spyOn(aiModelAccess, "assertAllowed").mockRejectedValue(new Error("denied"));
  await expect(selectAssistantAiModel(subject, { class: "balanced" })).rejects.toThrow("denied");
});
test("explicit variants authorize the owning model", async () => {
  spyOn(settings, "readAiSettingsState").mockResolvedValue(aiSettingsFixture({ profiles: [aiModelFixture({ id: "chat:deep" })] }));
  const access = spyOn(aiModelAccess, "assertAllowed").mockResolvedValue();
  expect(await selectAssistantAiModel(subject, { id: "chat:deep" })).toEqual({ id: "chat:deep" });
  expect(access).toHaveBeenCalledWith("chat", subject);
});
test("background mandates keep their own authorization", () => {
  expect(isAssistantChatTurn({ input: "chat", assistantChat: true })).toBe(true);
  expect(isAssistantChatTurn({ input: "job", assistantChat: true, mandate: { id: "m", revision: 1 } })).toBe(false);
});
const audioProfile: AiModelProfile = {
  modelId: "speech",
  providerId: "speech",
  variantLabel: "Standard",
  description: "",
  icon: { kind: "provider" },
  showInPicker: true,
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
  const aiError = { code: "model_policy_mismatch", message: "Model access denied" };
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
  expect(failure.message).toBe("Audio transcription is not available to you.");
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
