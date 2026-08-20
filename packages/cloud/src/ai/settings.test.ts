import { describe, expect, test } from "bun:test";
import {
  parseAiModelProfiles,
  planAiProfileCredentials,
  resolveAiSettingsStateFromRaw,
  selectAiModelProfile,
  validateAiSettingsConfiguration,
} from "./settings";

const profilesJson = (overrides: Array<Record<string, unknown>> = []) =>
  JSON.stringify([
    {
      id: "openrouter-fast",
      label: "OpenRouter Fast",
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
      enabled: true,
      tags: ["chat", "fast", "hosted"],
      capabilities: ["streaming"],
      dataBoundary: "hosted",
      ...overrides[0],
    },
    ...overrides.slice(1),
  ]);

const resolve = (input: {
  enabled?: boolean;
  defaultModelId?: string;
  profilesJson?: string;
  /** Keyed by profile id, mirroring ai.model_credentials. */
  credentials?: Record<string, string>;
  firecrawlApiKey?: string;
}) =>
  resolveAiSettingsStateFromRaw({
    enabled: input.enabled ?? true,
    defaultModelId: input.defaultModelId ?? "openrouter-fast",
    profilesJson: input.profilesJson ?? profilesJson(),
    firecrawlApiKey: input.firecrawlApiKey,
    readCredential: async (profileId) => (input.credentials ?? { "openrouter-fast": "secret" })[profileId] ?? null,
  });

describe("AI settings model registry", () => {
  test("accepts a valid enabled default model with profile-bound credentials", async () => {
    const state = await resolve({});

    expect(state.ok).toBe(true);
    expect(state.enabled).toBe(true);
    expect(state.firecrawlConfigured).toBe(false);
    expect(state.maxToolResultChars).toBe(2_000_000);
    if (state.ok) expect(state.profiles[0]?.id).toBe("openrouter-fast");
  });

  test("keeps profile limits optional and accepts zero or negative as unlimited", async () => {
    for (const limit of [undefined, 0, -1, 12]) {
      const state = await resolve({ profilesJson: profilesJson([{ maxLoadedTools: limit, maxToolRounds: limit }]) });
      expect(state.ok).toBe(true);
      if (state.ok) {
        expect(state.profiles[0]?.maxLoadedTools).toBe(limit);
        expect(state.profiles[0]?.maxToolRounds).toBe(limit);
      }
    }
  });

  test("tracks Firecrawl configuration without exposing the key", async () => {
    const state = await resolve({ firecrawlApiKey: "fc-secret" });

    expect(state.ok).toBe(true);
    expect(state.firecrawlConfigured).toBe(true);
    expect(JSON.stringify(state)).not.toContain("fc-secret");
  });

  test("selects the configured platform default model", async () => {
    const state = await resolve({});
    if (!state.ok || !state.enabled) throw new Error("Expected valid AI state");

    const selected = selectAiModelProfile(state, { kind: "platform-default", requiredCapabilities: ["streaming"] });

    expect(selected.id).toBe("openrouter-fast");
    expect(selected.dataBoundary).toBe("hosted");
  });

  test("rejects invalid model profile JSON", async () => {
    const state = await resolve({ profilesJson: "{" });

    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.error.code).toBe("invalid_model_profiles");
  });

  test("rejects malformed entries and duplicate canonical profile ids", async () => {
    const malformed = await resolve({ enabled: false, profilesJson: JSON.stringify([null]) });
    const duplicate = await resolve({
      enabled: false,
      profilesJson: JSON.stringify([
        { id: "duplicate", label: "A", provider: "ollama", model: "a" },
        { id: " duplicate ", label: "B", provider: "ollama", model: "b" },
      ]),
    });

    expect(malformed.ok).toBe(false);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.message).toContain("Duplicate");
  });

  test("rejects custom OpenAI-compatible profiles without a base URL", async () => {
    const state = await resolve({
      enabled: false,
      profilesJson: profilesJson([{ provider: "openai-compatible", dataBoundary: "private" }]),
    });

    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.error.code).toBe("invalid_model_profiles");
  });

  test("rejects provider endpoints outside HTTP and HTTPS", async () => {
    const state = await resolve({
      enabled: false,
      profilesJson: profilesJson([{ provider: "openai-compatible", dataBoundary: "private", baseURL: "file:///tmp/provider" }]),
    });

    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.error.code).toBe("invalid_model_profiles");
  });

  test("rejects enabled AI without a valid default model", async () => {
    const state = await resolve({ defaultModelId: "missing" });

    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.error.code).toBe("missing_default_model");
  });

  test("rejects a disabled default model", async () => {
    const state = await resolve({ profilesJson: profilesJson([{ enabled: false }]) });

    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.error.code).toBe("default_model_disabled");
  });

  test("rejects a default hosted model without provider credentials", async () => {
    const state = await resolve({ credentials: {} });

    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.error.code).toBe("missing_provider_credential");
  });

  test("reads the credential from the store rather than the profile", async () => {
    // The profile JSON never carries a key, so a state that resolves proves the
    // lookup went to ai.model_credentials under the profile's id.
    const state = await resolve({ credentials: { "openrouter-fast": "secret" } });

    expect(state.ok).toBe(true);
    expect(JSON.stringify(state)).not.toContain("secret");
  });

  test("turns an unreadable default credential into a recoverable settings error", async () => {
    const state = await resolveAiSettingsStateFromRaw({
      enabled: true,
      defaultModelId: "openrouter-fast",
      profilesJson: profilesJson(),
      readCredential: async () => {
        throw new Error("decrypt failed");
      },
    });

    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.error.code).toBe("missing_provider_credential");
  });

  test("rejects model selection when the data boundary is not allowed", async () => {
    const state = await resolve({});
    if (!state.ok || !state.enabled) throw new Error("Expected valid AI state");

    expect(() => selectAiModelProfile(state, { kind: "platform-default", allowedDataBoundaries: ["private"] })).toThrow();
  });

  test("rejects user-selected models outside the allowlist", async () => {
    const state = await resolve({
      profilesJson: profilesJson([
        {},
        {
          id: "openrouter-strong",
          label: "OpenRouter Strong",
          provider: "openrouter",
          model: "openai/gpt-4.1",
          enabled: true,
          tags: ["chat", "strong", "hosted"],
          capabilities: ["streaming"],
          dataBoundary: "hosted",
        },
      ]),
    });
    if (!state.ok || !state.enabled) throw new Error("Expected valid AI state");

    expect(() =>
      selectAiModelProfile(
        state,
        { kind: "selectable", allowedModelIds: ["openrouter-fast"], requiredCapabilities: ["streaming"] },
        "openrouter-strong",
      ),
    ).toThrow();
  });

  test("tolerates legacy tags but does not expose them on normalized profiles", async () => {
    const state = await resolve({});
    if (!state.ok || !state.enabled) throw new Error("Expected valid AI state");

    expect("tags" in state.profiles[0]!).toBe(false);
    expect(state.profiles[0]?.dataBoundary).toBe("hosted");
  });

  test("maps legacy local and internal data boundaries to private", async () => {
    const state = await resolve({
      profilesJson: profilesJson([
        {
          provider: "ollama",
          model: "llama3.1",
          dataBoundary: undefined,
          dataPolicy: "local",
        },
        {
          id: "internal-gateway",
          label: "Internal Gateway",
          provider: "openai-compatible",
          model: "gateway-model",
          enabled: true,
          capabilities: ["streaming"],
          dataBoundary: "internal",
          baseURL: "http://ai-gateway.internal/v1",
        },
      ]),
    });
    if (!state.ok || !state.enabled) throw new Error("Expected valid AI state");

    expect(state.profiles[0]?.dataBoundary).toBe("private");
    expect(state.profiles[1]?.dataBoundary).toBe("private");
  });
});

describe("AI settings admin invariants", () => {
  const parse = (value: Array<Record<string, unknown>>) => {
    const parsed = parseAiModelProfiles(JSON.stringify(value));
    if (parsed.error) throw new Error(parsed.error.message);
    return parsed.profiles;
  };

  test("requires every enabled hosted profile to be usable when AI is enabled", () => {
    const profiles = parse([
      { id: "local", label: "Local", provider: "ollama", model: "qwen", enabled: true },
      { id: "hosted", label: "Hosted", provider: "openrouter", model: "qwen", enabled: true },
    ]);

    expect(
      validateAiSettingsConfiguration({
        enabled: true,
        defaultModelId: "local",
        backgroundModelId: "",
        workflowModelId: "",
        profiles,
        credentialProfileIds: [],
      }),
    ).toEqual({ "ai.model_profiles_json": "Enter a provider API key for: Hosted." });
  });

  test("validates default and background profile references only when AI is enabled", () => {
    const profiles = parse([{ id: "local", label: "Local", provider: "ollama", model: "qwen", enabled: true }]);
    const invalid = validateAiSettingsConfiguration({
      enabled: true,
      defaultModelId: "missing",
      backgroundModelId: "missing",
      workflowModelId: "missing",
      profiles,
      credentialProfileIds: [],
    });

    expect(invalid["ai.default_model_id"]).toBeDefined();
    expect(invalid["ai.background_model_id"]).toBeDefined();
    expect(invalid["ai.workflow_model_id"]).toBeDefined();
    expect(
      validateAiSettingsConfiguration({
        enabled: false,
        defaultModelId: "missing",
        backgroundModelId: "missing",
        workflowModelId: "missing",
        profiles,
        credentialProfileIds: [],
      }),
    ).toEqual({});
  });

  test("requires the configured image tool model to support vision", () => {
    const profiles = parse([
      { id: "text", label: "Text", provider: "ollama", model: "qwen", enabled: true, capabilities: ["streaming", "tools"] },
      { id: "vision", label: "Vision", provider: "ollama", model: "llava", enabled: true, capabilities: ["vision"] },
    ]);
    expect(
      validateAiSettingsConfiguration({
        enabled: true,
        defaultModelId: "text",
        backgroundModelId: "",
        visionModelId: "text",
        workflowModelId: "",
        profiles,
        credentialProfileIds: [],
      })["ai.vision_model_id"],
    ).toBeDefined();
    expect(
      validateAiSettingsConfiguration({
        enabled: true,
        defaultModelId: "text",
        backgroundModelId: "",
        visionModelId: "vision",
        workflowModelId: "",
        profiles,
        credentialProfileIds: [],
      }),
    ).toEqual({});
  });

  test("keeps credentials only for the same profile id and provider", () => {
    const currentProfiles = parse([{ id: "model", label: "Model", provider: "openrouter", model: "a" }]);
    const unchanged = parse([{ id: "model", label: "Renamed", provider: "openrouter", model: "b" }]);
    const changedProvider = parse([{ id: "model", label: "Model", provider: "openai", model: "b" }]);
    const renamed = parse([{ id: "model-v2", label: "Model", provider: "openrouter", model: "b" }]);

    expect(
      planAiProfileCredentials({
        currentProfiles,
        nextProfiles: unchanged,
        existingCredentialProfileIds: ["model"],
        submittedCredentialProfileIds: [],
      }).keepCredentialProfileIds,
    ).toEqual(["model"]);
    expect(
      planAiProfileCredentials({
        currentProfiles,
        nextProfiles: changedProvider,
        existingCredentialProfileIds: ["model"],
        submittedCredentialProfileIds: [],
      }).keepCredentialProfileIds,
    ).toEqual([]);
    expect(
      planAiProfileCredentials({
        currentProfiles,
        nextProfiles: renamed,
        existingCredentialProfileIds: ["model"],
        submittedCredentialProfileIds: [],
      }).keepCredentialProfileIds,
    ).toEqual([]);
  });

  test("accepts a replacement credential but rejects keys for unsupported providers", () => {
    const hosted = parse([{ id: "model", label: "Model", provider: "openai", model: "b" }]);
    const local = parse([{ id: "local", label: "Local", provider: "ollama", model: "qwen" }]);

    expect(
      planAiProfileCredentials({
        currentProfiles: [],
        nextProfiles: hosted,
        existingCredentialProfileIds: [],
        submittedCredentialProfileIds: ["model"],
      }).keepCredentialProfileIds,
    ).toEqual(["model"]);
    expect(
      planAiProfileCredentials({
        currentProfiles: [],
        nextProfiles: local,
        existingCredentialProfileIds: [],
        submittedCredentialProfileIds: ["local"],
      }).unsupportedCredentialProfileId,
    ).toBe("local");
  });

  test("drops every credential when the profile registry is reset", () => {
    const currentProfiles = parse([
      { id: "one", label: "One", provider: "openrouter", model: "a" },
      { id: "two", label: "Two", provider: "openai-compatible", model: "b", baseURL: "http://localhost:3000/v1" },
    ]);

    expect(
      planAiProfileCredentials({
        currentProfiles,
        nextProfiles: [],
        existingCredentialProfileIds: ["one", "two"],
        submittedCredentialProfileIds: [],
      }).keepCredentialProfileIds,
    ).toEqual([]);
  });
});
