import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { coreSettings } from "../services";
import * as credentials from "./credentials";
import { createAiProvider } from "./provider";
import * as settings from "./settings";
import { parseAiModelProfiles, resolveAiSettingsStateFromRaw, selectAiModelProfile, validateAiSettingsConfiguration } from "./settings";
import { createAiTranscriptionProvider, describeTranscriptionFailure, resolveAiAudioModel } from "./transcription";
import type { AiModelProfile } from "./types";

const audio: AiModelProfile = {
  id: "speech",
  label: "Speech",
  provider: "openai-compatible",
  model: "whisper-large-v3",
  baseURL: "https://example.invalid/v1",
  enabled: true,
  capabilities: ["transcription"],
  dataBoundary: "private",
};
const chat: AiModelProfile = { ...audio, id: "chat", model: "chat", capabilities: ["streaming", "tools"] };

describe("audio model boundaries", () => {
  test("validates exclusive capabilities and compatible protocols", () => {
    expect(parseAiModelProfiles(JSON.stringify([audio])).error).toBeUndefined();
    for (const profile of [
      { ...audio, capabilities: ["transcription", "streaming"] },
      { ...audio, provider: "anthropic" },
    ]) {
      expect(parseAiModelProfiles(JSON.stringify([profile])).error?.code).toBe("invalid_model_profiles");
    }
  });
  test("rejects audio even from a chat policy without required capabilities", async () => {
    const state = await resolveAiSettingsStateFromRaw({
      enabled: true,
      defaultModelId: chat.id,
      profilesJson: JSON.stringify([chat, audio]),
    });
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error(state.error.message);
    expect(() => selectAiModelProfile(state, { kind: "selectable" }, audio.id)).toThrow();
    expect(() => selectAiModelProfile(state, { kind: "locked", modelId: audio.id })).toThrow();
    expect(selectAiModelProfile(state, { kind: "locked", modelId: audio.id, requiredCapabilities: ["transcription"] }).id).toBe(audio.id);
    expect(() =>
      selectAiModelProfile(state, {
        kind: "locked",
        modelId: audio.id,
        requiredCapabilities: ["transcription"],
        allowedDataBoundaries: ["hosted"],
      }),
    ).toThrow();
    expect(() => createAiProvider(audio)).toThrow();
    expect(() => createAiTranscriptionProvider(chat)).toThrow();
  });
  test("validates every text default and the audio selection", async () => {
    const errors = validateAiSettingsConfiguration({
      enabled: true,
      defaultModelId: audio.id,
      backgroundModelId: audio.id,
      workflowModelId: audio.id,
      audioModelId: chat.id,
      profiles: [chat, audio],
      credentialProfileIds: [],
    });
    expect(errors.map((issue) => issue.setting).sort()).toEqual([
      "ai.audio_model_id",
      "ai.background_model_id",
      "ai.default_model_id",
      "ai.workflow_model_id",
    ]);
    expect(
      (await resolveAiSettingsStateFromRaw({ enabled: true, defaultModelId: audio.id, profilesJson: JSON.stringify([audio]) })).ok,
    ).toBe(false);
  });
  test("sends multipart through the transcription adapter and supports cancellation", async () => {
    let requestBody: FormData | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/v1/audio/transcriptions");
        requestBody = await request.formData();
        return Response.json({ text: "Ein Sprachmemo." });
      },
    });
    try {
      const provider = createAiTranscriptionProvider({ ...audio, baseURL: `${server.url}v1` });
      const result = await provider.transcribe({ file: new Blob(["audio"]), filename: "memo.wav", language: "de" });
      expect(result.text).toBe("Ein Sprachmemo.");
      expect(requestBody?.get("model")).toBe(audio.model);
      expect(requestBody?.get("language")).toBe("de");
      const controller = new AbortController();
      controller.abort(new Error("Canceled"));
      await expect(provider.transcribe({ file: new Blob(), signal: controller.signal })).rejects.toThrow("Canceled");
    } finally {
      server.stop(true);
    }
  });
});

test("classifies provider failures without storing response bodies", () => {
  const failure = describeTranscriptionFailure(new Error("openai-compatible 404: private transcript and secret"), "provider");
  expect(failure.code).toBe("transcription_http_404");
  expect(failure.httpStatus).toBe(404);
  expect(failure.message).toContain("base URL");
  expect(failure.message).not.toContain("private");
  expect(failure.retryable).toBe(false);
  expect(describeTranscriptionFailure(new Error("openai 429: secret"), "provider").retryable).toBe(true);
  expect(describeTranscriptionFailure(new Error("openai-compatible connection failed: secret"), "provider").retryable).toBe(true);
  expect(describeTranscriptionFailure(new Error("secret"), "configuration").message).not.toContain("secret");
  expect(describeTranscriptionFailure(new Error("secret"), "provider", true).code).toBe("transcription_aborted");
});

afterEach(() => mock.restore());

for (const [name, enabled, modelId, profile, boundaries, expected] of [
  ["missing selection", true, "", audio, undefined, "no audio model is configured"],
  ["AI disabled", false, audio.id, audio, undefined, "AI is disabled"],
  ["missing credentials", true, audio.id, { ...audio, provider: "openai" }, undefined, "credentials"],
  ["forbidden boundary", true, audio.id, audio, ["hosted"], "data boundary"],
  ["incompatible profile", true, audio.id, { ...audio, capabilities: ["streaming"] }, undefined, "transcription"],
] satisfies Array<[string, boolean, string, AiModelProfile, AiModelProfile["dataBoundary"][] | undefined, string]>) {
  test(`audio configuration failure explains ${name} and administrator recovery`, async () => {
    const state = await resolveAiSettingsStateFromRaw({ enabled, defaultModelId: chat.id, profilesJson: JSON.stringify([chat, profile]) });
    spyOn(settings, "readAiSettingsState").mockResolvedValue(state);
    spyOn(coreSettings, "get").mockResolvedValue(modelId);
    spyOn(credentials, "getAiCredential").mockResolvedValue(null);
    let failure: unknown;
    try {
      await resolveAiAudioModel({ allowedDataBoundaries: boundaries });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Expected configuration failure");
    expect(failure.message).toContain(expected);
    expect(failure.message).toContain("administrator");
    const classified = describeTranscriptionFailure(failure, "configuration");
    expect(classified.code).toBe("transcription_configuration_failed");
    expect(classified.message).toBe(failure.message);
  });
}

test("unknown configuration failures are sanitized and point to administrator setup", () => {
  const failure = describeTranscriptionFailure(new Error("private configuration secret"), "configuration");
  expect(failure.code).toBe("transcription_configuration_failed");
  expect(failure.message).toContain("administrator");
  expect(failure.message).toContain("AI settings");
  expect(failure.message).not.toContain("secret");
});

for (const [name, defaultModelId, profile, expected] of [
  ["missing default model", "", chat, "AI is enabled but no valid default model profile is configured."],
  ["disabled default model", chat.id, { ...chat, enabled: false }, 'Default AI model "chat" must be an enabled text model.'],
  ["missing default credential", chat.id, { ...chat, provider: "openai" }, 'Default AI model "chat" is missing provider credentials.'],
] satisfies Array<[string, string, AiModelProfile, string]>) {
  test(`audio configuration preserves the specific settings cause: ${name}`, async () => {
    const state = await resolveAiSettingsStateFromRaw({
      enabled: true,
      defaultModelId,
      profilesJson: JSON.stringify([profile, audio]),
    });
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error("Expected invalid AI settings");
    spyOn(settings, "readAiSettingsState").mockResolvedValue(state);
    let failure: unknown;
    try {
      await resolveAiAudioModel();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "transcription_configuration_failed",
      message: `Audio transcription is not available: ${expected} An administrator can fix this in the AI settings.`,
      aiError: state.error,
    });
  });
}
