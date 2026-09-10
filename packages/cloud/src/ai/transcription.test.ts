import { describe, expect, test } from "bun:test";
import { createAiProvider } from "./provider";
import { parseAiModelProfiles, resolveAiSettingsStateFromRaw, selectAiModelProfile, validateAiSettingsConfiguration } from "./settings";
import { createAiTranscriptionProvider } from "./transcription";
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
    expect(Object.keys(errors).sort()).toEqual([
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
