import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { z } from "zod";
import { coreSettings } from "../services";
import * as credentials from "./credentials";
import { type CloudAiChartInput, CloudAiChartInputSchema, parseCloudAiChartInput } from "./default-tool-contracts";
import { createConfiguredDefaultCloudAiTools } from "./default-tools";
import { aiModelAccess } from "./model-access";
import * as settings from "./settings";
import { aiToolPromptHints } from "./tools";
import type { AiModelProfile } from "./types";
import { parseCloudAiChartToolView } from "./view-block";

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
const subject = { type: "user" as const, userId: "user" };
const accessError = Object.assign(new Error("Model access denied"), { aiError: { code: "model_access_denied" } });

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
  spyOn(aiModelAccess, "assertAllowed").mockImplementation(async (_id, accessSubject) => {
    if (!accessSubject) throw accessError;
  });
};

const hasAudio = async (
  config: Parameters<typeof createConfiguredDefaultCloudAiTools>[0] = { firecrawlApiKey: "", accessSubject: subject },
) => {
  const tools = await createConfiguredDefaultCloudAiTools(config);
  const offered = tools.some((tool) => tool.def.name === "transcribe_audio");
  expect(aiToolPromptHints(tools).some((hint) => hint.name === "transcribe_audio")).toBe(offered);
  return offered;
};

describe("configured audio tools", () => {
  test("omits audio and its prompt hint when no audio model is selected", async () => {
    await configure("  ");
    expect(await hasAudio()).toBe(false);
  });
  test("offers a resolving transcription profile without contacting the provider", async () => {
    await configure(audio.id);
    const providerFetch = spyOn(globalThis, "fetch");
    expect(await hasAudio()).toBe(true);
    expect(aiModelAccess.assertAllowed).toHaveBeenCalledWith(audio.id, subject);
    expect(providerFetch).not.toHaveBeenCalled();
  });
  test("omits audio and its prompt hint when Assistant access is denied", async () => {
    await configure(audio.id);
    const access = spyOn(aiModelAccess, "assertAllowed").mockRejectedValue(accessError);
    expect(await hasAudio()).toBe(false);
    expect(access).toHaveBeenCalledWith(audio.id, subject);
  });
  test("omits audio when no access subject is supplied", async () => {
    await configure(audio.id);
    expect(await hasAudio({ firecrawlApiKey: "" })).toBe(false);
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
    expect(await hasAudio({ firecrawlApiKey: "", accessSubject: subject, allowedDataBoundaries: ["hosted"] })).toBe(false);
    expect(await hasAudio({ firecrawlApiKey: "", accessSubject: subject, allowedDataBoundaries: ["private"] })).toBe(true);
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

describe("flat chart tool schema", () => {
  const bar = { kind: "bar", title: "B", data: [{ label: "A", value: 1 }] } satisfies CloudAiChartInput;
  test("accepts old arguments and exactly one of kind or charts", () => {
    expect(CloudAiChartInputSchema.parse(bar)).toEqual(bar);
    const group = { title: "G", charts: [bar, bar], layout: "grid" as const, linkX: false };
    expect(CloudAiChartInputSchema.parse(group)).toEqual(group);
    expect(parseCloudAiChartToolView(group)).toEqual({ ...group, view: "group" });
    expect(parseCloudAiChartToolView(bar)).toEqual({ ...bar, view: "chart" });
    for (const args of [
      { title: "G" },
      { ...bar, charts: [bar, bar] },
      { ...bar, linkX: true },
      { ...bar, layout: "stack" },
      { ...group, data: bar.data },
      { ...group, value: 1 },
      { ...group, series: [] },
      { ...group, charts: [{ ...bar, charts: [bar, bar] }, bar] },
    ])
      expect(CloudAiChartInputSchema.safeParse(args).success).toBe(false);
  });
  test("overlapping item shapes keep per-item bounds, box values and heatmap axes", () => {
    for (const input of [
      { kind: "barGauge", title: "G", data: [{ label: "A", value: 3, min: 1, max: 5 }] },
      { kind: "heatmap", title: "H", data: [{ x: "A", y: "B", value: 0.21 }] },
      { kind: "boxplot", title: "B", data: [{ label: "A", values: [1, 2, 3] }] },
    ] satisfies CloudAiChartInput[])
      expect(parseCloudAiChartInput(CloudAiChartInputSchema.parse(input))).toEqual(input);
  });
  test("JSON schema is a single object, including groups and the new kinds", () => {
    const schema = z.toJSONSchema(CloudAiChartInputSchema, { target: "draft-07" });
    expect(schema.type).toBe("object");
    for (const key of ["oneOf", "anyOf", "allOf"]) expect(schema).not.toHaveProperty(key);
    const text = JSON.stringify(schema);
    for (const kind of ["boxplot", "barGauge", "heatmap", "stat"]) expect(text).toContain(`"${kind}"`);
    expect(text).toContain('"charts"');
    expect(text).not.toContain('"items":[');
  });
});
