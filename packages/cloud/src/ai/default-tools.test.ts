import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { coreSettings } from "../services";
import * as credentials from "./credentials";
import { createConfiguredDefaultCloudAiTools } from "./default-tools";
import * as settings from "./settings";
import { aiToolPromptHints } from "./tools";
import type { AiModelProfile } from "./types";

const audio: AiModelProfile = {
  id: "speech",
  label: "Speech",
  provider: "openai-compatible",
  model: "whisper",
  baseURL: "https://example.invalid/v1",
  enabled: true,
  capabilities: ["transcription"],
  dataBoundary: "private",
};
const chat: AiModelProfile = { ...audio, id: "chat", capabilities: ["streaming", "tools"] };

afterEach(() => mock.restore());

const configure = async (modelId: string, profile = audio, enabled = true) => {
  const state = await settings.resolveAiSettingsStateFromRaw({
    enabled,
    defaultModelId: chat.id,
    profilesJson: JSON.stringify([chat, profile]),
  });
  spyOn(settings, "readAiSettingsState").mockResolvedValue(state);
  spyOn(coreSettings, "get").mockResolvedValue(modelId);
  spyOn(credentials, "getAiCredential").mockResolvedValue(null);
};

const hasAudio = async (config: Parameters<typeof createConfiguredDefaultCloudAiTools>[0] = { firecrawlApiKey: "" }) => {
  const tools = await createConfiguredDefaultCloudAiTools(config);
  const offered = tools.some((tool) => tool.def.name === "transcribe_audio");
  expect(aiToolPromptHints(tools).some((hint) => hint.name === "transcribe_audio")).toBe(offered);
  return offered;
};

describe("configured audio tools", () => {
  test("supports explicit audio availability overrides without reading settings", async () => {
    const read = spyOn(settings, "readAiSettingsState");
    expect(await hasAudio({ firecrawlApiKey: "", audioModelConfigured: false })).toBe(false);
    expect(await hasAudio({ firecrawlApiKey: "", audioModelConfigured: true })).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
  test("omits audio and its prompt hint when no audio model is selected", async () => {
    await configure("  ");
    expect(await hasAudio()).toBe(false);
  });
  test("offers a resolving transcription profile without contacting the provider", async () => {
    await configure(audio.id);
    const providerFetch = spyOn(globalThis, "fetch");
    expect(await hasAudio()).toBe(true);
    expect(providerFetch).not.toHaveBeenCalled();
  });
  test("omits missing, disabled, incompatible, and credential-less audio profiles", async () => {
    for (const profile of [
      audio,
      { ...audio, enabled: false },
      { ...audio, capabilities: chat.capabilities },
      { ...audio, provider: "openai" as const },
    ]) {
      await configure(profile === audio ? "missing" : audio.id, profile);
      expect(await hasAudio()).toBe(false);
      mock.restore();
    }
  });
  test("omits audio when AI is disabled or the data boundary is forbidden", async () => {
    await configure(audio.id, audio, false);
    expect(await hasAudio()).toBe(false);
    mock.restore();
    await configure(audio.id);
    expect(await hasAudio({ firecrawlApiKey: "", allowedDataBoundaries: ["hosted"] })).toBe(false);
    expect(await hasAudio({ firecrawlApiKey: "", allowedDataBoundaries: ["private"] })).toBe(true);
  });
});

test("vision configuration gaps identify the administrator's action", async () => {
  await configure(audio.id);
  await expect(settings.resolveAiVisionModel()).rejects.toThrow("no vision model is configured");
  await expect(settings.resolveAiVisionModel()).rejects.toThrow("administrator");
  mock.restore();
  await configure(audio.id, audio, false);
  await expect(settings.resolveAiVisionModel()).rejects.toThrow("AI is disabled");
  await expect(settings.resolveAiVisionModel()).rejects.toThrow("administrator");
});

test("offers credentialed OpenAI audio profiles", async () => {
  await configure(audio.id, { ...audio, provider: "openai" });
  spyOn(credentials, "getAiCredential").mockResolvedValue("test-key");
  expect(await hasAudio()).toBe(true);
});

for (const [provider, boundaries, expected, code] of [
  ["openai", undefined, "credentials", "missing_provider_credential"],
  ["openai-compatible", ["hosted"], "data boundary", "model_policy_mismatch"],
] satisfies Array<[AiModelProfile["provider"], AiModelProfile["dataBoundary"][] | undefined, string, string]>) {
  test(`vision failures explain ${expected} and keep the error code`, async () => {
    await configure(audio.id);
    const vision: AiModelProfile = { ...audio, provider, capabilities: ["vision"] };
    const state = await settings.resolveAiSettingsStateFromRaw({
      enabled: true,
      defaultModelId: chat.id,
      visionModelId: vision.id,
      profilesJson: JSON.stringify([chat, vision]),
    });
    spyOn(settings, "readAiSettingsState").mockResolvedValue(state);
    let failure: unknown;
    try {
      await settings.resolveAiVisionModel(boundaries);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ aiError: { code } });
    if (!(failure instanceof Error)) throw new Error("Expected vision configuration failure");
    expect(failure.message).toContain(expected);
    expect(failure.message).toContain("administrator");
  });
}
