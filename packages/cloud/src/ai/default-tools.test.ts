import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { z } from "zod";
import { coreSettings } from "../services";
import * as credentials from "./credentials";
import {
  type CloudAiChartInput,
  CloudAiChartInputSchema,
  cloudAiAppChartSchema,
  cloudAiChartSchema,
  cloudAiGroupSchema,
  parseCloudAiChartInput,
} from "./default-tool-contracts";
import { createAiTurnCodeAndClientTools, createConfiguredDefaultCloudAiTools } from "./default-tools";
import { aiModelAccess } from "./model-access";
import { aiAssignmentFixture, aiSettingsFixture } from "./model-fixture";
import * as settings from "./settings";
import { aiToolPromptHints } from "./tools";
import type { AiModelProfile } from "./types";
import { parseCloudAiChartToolView } from "./view-block";

const audio: AiModelProfile = {
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
const chat: AiModelProfile = { ...audio, id: "chat", capabilities: ["tools"] };
const subject = { type: "user" as const, userId: "user" };
const accessError = Object.assign(new Error("Model access denied"), { aiError: { code: "model_access_denied" } });

afterEach(() => mock.restore());

const configure = async (modelId: string, profile = audio, enabled = true) => {
  const state = aiSettingsFixture({
    enabled,
    assignments: [aiAssignmentFixture("balanced", chat.id), aiAssignmentFixture("audio", modelId)],
    profiles: [chat, profile],
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

describe("turn Code Mode and client tools", () => {
  const clientToolIds = ["code_open", "code_secret", "local_bash"] as const;
  const mandate = { id: "00000000-0000-4000-8000-000000000001", revision: 1 };

  test("includes declared client tools without a mandate", () => {
    const names = createAiTurnCodeAndClientTools({ clientToolIds: [...clientToolIds] }).map((tool) => tool.def.name);
    for (const name of clientToolIds) expect(names).toContain(name);
  });

  test("a mandate excludes app opening and secret entry even when declared by the client", () => {
    const names = createAiTurnCodeAndClientTools({ mandate, clientToolIds: [...clientToolIds] }).map((tool) => tool.def.name);
    expect(names).not.toContain("code_open");
    expect(names).not.toContain("code_secret");
    expect(names).toContain("code_run");
  });

  test("without a client, includes server-run code tools only", () => {
    const tools = createAiTurnCodeAndClientTools({});
    const names = tools.map((tool) => tool.def.name);
    expect(tools.every((tool) => tool.location === "server")).toBe(true);
    expect(names).not.toContain("local_bash");
    expect(names).not.toContain("code_open");
    expect(names).not.toContain("code_secret");
    for (const name of ["code_run", "code_action", "code_inspect", "code_stop", "code_check", "code_present", "code_export"]) {
      expect(names).toContain(name);
    }
  });
});

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
    const state = aiSettingsFixture({
      enabled: true,
      assignments: [aiAssignmentFixture("balanced", chat.id), aiAssignmentFixture("vision", vision.id)],

      profiles: [chat, vision],
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
  test("every chart schema preserves tooltip options for every kind", () => {
    const tooltip = { label: "Umsatz", format: { style: "currency", currency: "EUR" } } satisfies NonNullable<CloudAiChartInput["tooltip"]>;
    const points = [
      {
        data: [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
        ],
      },
    ];
    const inputs = [
      bar,
      { kind: "line", title: "L", series: points },
      { kind: "scatter", title: "S", series: points },
      { ...bar, kind: "pie" },
      { ...bar, kind: "donut" },
      { kind: "histogram", title: "H", data: [1, 2, 3] },
      { kind: "gauge", title: "G", value: 1 },
      { kind: "sparkline", title: "S", data: [1, 2] },
      { kind: "boxplot", title: "B", data: [{ label: "A", values: [1, 2, 3] }] },
      { kind: "heatmap", title: "H", data: [{ x: "A", y: "B", value: 1 }] },
      { ...bar, kind: "barGauge" },
      { kind: "stat", title: "S", value: 1 },
    ];
    for (const schema of [cloudAiChartSchema(), CloudAiChartInputSchema, cloudAiAppChartSchema()]) {
      for (const input of inputs) expect(schema.parse({ ...input, tooltip })).toHaveProperty("tooltip", tooltip);
      for (const tooltip of [{}, { label: "Umsatz" }, { format: { unit: "kWh", decimals: 1 } }])
        expect(schema.parse({ ...bar, tooltip })).toEqual({ ...bar, tooltip });
    }
  });
  test("tooltip is strict, uses number formats, and belongs to charts inside groups", () => {
    for (const tooltip of [{ unknown: true }, { format: { style: "currency" } }, { format: { date: "day" } }])
      for (const schema of [cloudAiChartSchema(), CloudAiChartInputSchema, cloudAiAppChartSchema()])
        expect(schema.safeParse({ ...bar, tooltip }).success).toBe(false);
    const tooltip = { label: "Umsatz", format: { style: "currency", currency: "EUR" } } satisfies NonNullable<CloudAiChartInput["tooltip"]>;
    const group = { title: "G", charts: [{ ...bar, tooltip }, bar] };
    for (const schema of [cloudAiGroupSchema(), CloudAiChartInputSchema]) {
      expect(schema.parse(group)).toEqual(group);
      expect(schema.safeParse({ ...group, tooltip }).success).toBe(false);
    }
  });
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
  test("accepted tool roots render after stripping unknown keys", () => {
    const line = {
      kind: "line",
      title: "L",
      series: [
        {
          data: [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
          ],
        },
      ],
    };
    const group = { title: "G", charts: [line, line], linkX: true };
    for (const args of [group, { ...group, note: "x" }, { ...line, note: "x" }]) {
      expect(CloudAiChartInputSchema.safeParse(args).success).toBe(true);
      expect(parseCloudAiChartToolView(args)).toBeDefined();
      expect(parseCloudAiChartToolView(args)).not.toHaveProperty("note");
    }
    expect(parseCloudAiChartToolView({ ...group, charts: [{ ...line, title: "" }, line] })).toBeUndefined();
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
