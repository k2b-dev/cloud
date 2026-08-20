import { z } from "zod";
import { coreSettings } from "../services";
import { getAiCredential, listAiCredentialProfileIds } from "./credentials";
import { AI_FIRECRAWL_API_KEY_SETTING_KEY } from "./firecrawl-tools";
import { createAiProvider } from "./provider";
import {
  AI_DATA_BOUNDARIES,
  AI_MODEL_CAPABILITIES,
  type AiDataBoundary,
  type AiModelCapability,
  type AiModelPolicy,
  type AiModelProfile,
  type AiProviderId,
  type AiPublicModelProfile,
  type AiResolvedModel,
  type AiSettingsError,
  type AiSettingsState,
} from "./types";

const PROVIDERS = ["openai", "openrouter", "anthropic", "mistral", "gemini", "ollama", "vllm", "openai-compatible"] as const;
const LEGACY_DATA_BOUNDARIES = ["local", "internal"] as const;
const DATA_BOUNDARY_INPUTS = [...AI_DATA_BOUNDARIES, ...LEGACY_DATA_BOUNDARIES] as const;
const HttpUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Provider endpoints must use HTTP or HTTPS.");

export const providerRequiresCredential = (provider: AiProviderId): boolean =>
  provider === "openai" || provider === "openrouter" || provider === "anthropic" || provider === "mistral" || provider === "gemini";

export const providerSupportsCredential = (provider: AiProviderId): boolean =>
  providerRequiresCredential(provider) || provider === "vllm" || provider === "openai-compatible";

const defaultDataBoundary = (provider: AiProviderId): AiDataBoundary =>
  provider === "ollama" || provider === "vllm" || provider === "openai-compatible" ? "private" : "hosted";

const normalizeDataBoundary = (boundary: (typeof DATA_BOUNDARY_INPUTS)[number] | undefined, provider: AiProviderId): AiDataBoundary => {
  if (boundary === "hosted") return "hosted";
  if (boundary === "private" || boundary === "local" || boundary === "internal") return "private";
  return defaultDataBoundary(provider);
};

const isModelCapability = (value: string): value is AiModelCapability => AI_MODEL_CAPABILITIES.some((capability) => capability === value);

// Keep in sync with the ai.max_tool_result_chars default in core-settings.ts.
// This is an operator ceiling. The runtime derives the actual per-result
// budget from the selected model's context window.
const DEFAULT_MAX_TOOL_RESULT_CHARS = 2_000_000;

const normalizeMaxToolResultChars = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_MAX_TOOL_RESULT_CHARS;
  return Math.floor(numeric);
};

const normalizeCapabilities = (values: string[] | undefined): AiModelCapability[] => {
  if (!values) return ["streaming"];
  const capabilities = values.filter(isModelCapability);
  return [...new Set(capabilities)];
};

const ModelProfileSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    label: z.string().trim().min(1),
    provider: z.enum(PROVIDERS),
    model: z.string().trim().min(1),
    enabled: z.boolean().default(true),
    // Small logo shown in the admin card and the composer model picker. Hard cap:
    // it ships to every user via the public model list (64x64 webp ≈ a few KB).
    image: z
      .string()
      .trim()
      .regex(/^data:image\//)
      .max(28_000)
      .optional(),
    // Legacy/advanced metadata is tolerated but no longer used for model selection.
    tags: z.array(z.string()).optional(),
    capabilities: z.array(z.string()).optional(),
    dataBoundary: z.enum(DATA_BOUNDARY_INPUTS).optional(),
    // Legacy name accepted for stored profiles created before dataBoundary.
    dataPolicy: z.enum(DATA_BOUNDARY_INPUTS).optional(),
    baseURL: HttpUrlSchema.optional(),
    contextWindow: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    maxLoadedTools: z.number().int().optional(),
    maxToolRounds: z.number().int().optional(),
    creditsPerInputToken: z.number().nonnegative().optional(),
    creditsPerOutputToken: z.number().nonnegative().optional(),
  })
  .superRefine((profile, ctx) => {
    if (profile.provider === "openai-compatible" && !profile.baseURL) {
      ctx.addIssue({ code: "custom", path: ["baseURL"], message: "OpenAI-compatible profiles require a base URL." });
    }
  });

const profileToPublic = (profile: AiModelProfile): AiPublicModelProfile => ({
  id: profile.id,
  label: profile.label,
  provider: profile.provider,
  model: profile.model,
  image: profile.image,
  capabilities: profile.capabilities,
  dataBoundary: profile.dataBoundary,
  contextWindow: profile.contextWindow,
});

const normalizeProfile = (raw: z.infer<typeof ModelProfileSchema>): AiModelProfile => {
  const { capabilities, dataBoundary, dataPolicy: legacyDataPolicy, tags: _legacyTags, ...profile } = raw;
  return {
    ...profile,
    capabilities: normalizeCapabilities(capabilities),
    dataBoundary: normalizeDataBoundary(dataBoundary ?? legacyDataPolicy, raw.provider),
  };
};

export const parseAiModelProfiles = (rawJson: string): { profiles: AiModelProfile[]; error?: AiSettingsError } => {
  let raw: unknown;
  try {
    raw = rawJson.trim() ? JSON.parse(rawJson) : [];
  } catch (error) {
    return {
      profiles: [],
      error: {
        code: "invalid_model_profiles",
        message: "AI model profiles must be valid JSON.",
        fields: { "ai.model_profiles_json": error instanceof Error ? error.message : "Invalid JSON" },
      },
    };
  }

  const parsed = z.array(ModelProfileSchema).safeParse(raw);
  if (!parsed.success) {
    return {
      profiles: [],
      error: {
        code: "invalid_model_profiles",
        message: "AI model profiles do not match the expected shape.",
        fields: { "ai.model_profiles_json": z.prettifyError(parsed.error) },
      },
    };
  }

  const seen = new Set<string>();
  const duplicate = parsed.data.find((profile) => {
    if (seen.has(profile.id)) return true;
    seen.add(profile.id);
    return false;
  });

  if (duplicate) {
    return {
      profiles: [],
      error: {
        code: "invalid_model_profiles",
        message: `Duplicate AI model profile id "${duplicate.id}".`,
        fields: { "ai.model_profiles_json": `Duplicate model profile id "${duplicate.id}".` },
      },
    };
  }

  const profiles = parsed.data.map(normalizeProfile);
  return { profiles };
};

export const validateAiSettingsConfiguration = (input: {
  enabled: boolean;
  defaultModelId: string;
  backgroundModelId: string;
  visionModelId?: string;
  workflowModelId: string;
  profiles: readonly AiModelProfile[];
  credentialProfileIds: readonly string[];
}): Record<string, string> => {
  if (!input.enabled) return {};

  const errors: Record<string, string> = {};
  const enabledProfiles = input.profiles.filter((profile) => profile.enabled);
  const defaultProfile = input.profiles.find((profile) => profile.id === input.defaultModelId);
  if (!input.defaultModelId || !defaultProfile?.enabled) {
    errors["ai.default_model_id"] = "Choose an enabled model profile.";
  }

  if (input.backgroundModelId) {
    const backgroundProfile = input.profiles.find((profile) => profile.id === input.backgroundModelId);
    if (!backgroundProfile?.enabled) errors["ai.background_model_id"] = "Choose an enabled model profile or use the platform default.";
  }

  if (input.visionModelId) {
    const visionProfile = input.profiles.find((profile) => profile.id === input.visionModelId);
    if (!visionProfile?.enabled || !visionProfile.capabilities.includes("vision")) {
      errors["ai.vision_model_id"] = "Choose an enabled model profile with Vision support or disable the fallback.";
    }
  }

  if (input.workflowModelId) {
    const workflowProfile = input.profiles.find((profile) => profile.id === input.workflowModelId);
    if (!workflowProfile?.enabled) errors["ai.workflow_model_id"] = "Choose an enabled model profile or use the background model.";
  }

  const configured = new Set(input.credentialProfileIds);
  const missingCredentials = enabledProfiles.filter(
    (profile) => providerRequiresCredential(profile.provider) && !configured.has(profile.id),
  );
  if (missingCredentials.length > 0) {
    errors["ai.model_profiles_json"] = `Enter a provider API key for: ${missingCredentials.map((profile) => profile.label).join(", ")}.`;
  }

  return errors;
};

export const planAiProfileCredentials = (input: {
  currentProfiles: readonly AiModelProfile[];
  nextProfiles: readonly AiModelProfile[];
  existingCredentialProfileIds: readonly string[];
  submittedCredentialProfileIds: readonly string[];
}): { keepCredentialProfileIds: string[]; unsupportedCredentialProfileId?: string } => {
  const nextProfilesById = new Map(input.nextProfiles.map((profile) => [profile.id, profile]));
  const unsupportedCredentialProfileId = input.submittedCredentialProfileIds.find((profileId) => {
    const profile = nextProfilesById.get(profileId);
    return !profile || !providerSupportsCredential(profile.provider);
  });
  if (unsupportedCredentialProfileId) return { keepCredentialProfileIds: [], unsupportedCredentialProfileId };

  const existingCredentials = new Set(input.existingCredentialProfileIds);
  const submittedCredentials = new Set(input.submittedCredentialProfileIds);
  const currentProfilesById = new Map(input.currentProfiles.map((profile) => [profile.id, profile]));
  const keepCredentialProfileIds = input.nextProfiles
    .filter((profile) => {
      if (!providerSupportsCredential(profile.provider)) return false;
      if (submittedCredentials.has(profile.id)) return true;
      const current = currentProfilesById.get(profile.id);
      return current?.provider === profile.provider && existingCredentials.has(profile.id);
    })
    .map((profile) => profile.id);

  return { keepCredentialProfileIds };
};

export const resolveAiSettingsStateFromRaw = async (input: {
  enabled: boolean;
  defaultModelId: string;
  visionModelId?: string;
  profilesJson: string;
  globalInstructions?: string;
  compactionInstructions?: string;
  maxToolResultChars?: unknown;
  firecrawlApiKey?: string;
  credentialProfileIds?: readonly string[];
  readCredential?: (profileId: string) => Promise<string | null | undefined>;
}): Promise<AiSettingsState> => {
  const parsed = parseAiModelProfiles(input.profilesJson ?? "[]");
  const baseState = {
    enabled: Boolean(input.enabled),
    defaultModelId: input.defaultModelId ?? "",
    visionModelId: input.visionModelId ?? "",
    globalInstructions: input.globalInstructions ?? "",
    compactionInstructions: input.compactionInstructions ?? "",
    maxToolResultChars: normalizeMaxToolResultChars(input.maxToolResultChars),
    firecrawlConfigured: Boolean(input.firecrawlApiKey?.trim()),
  };
  if (parsed.error) {
    return {
      ok: false,
      ...baseState,
      profiles: parsed.profiles,
      error: parsed.error,
    };
  }

  if (!input.enabled) {
    return {
      ok: true,
      ...baseState,
      enabled: false,
      profiles: parsed.profiles,
    };
  }

  const defaultProfile = parsed.profiles.find((profile) => profile.id === input.defaultModelId);
  if (!input.defaultModelId || !defaultProfile) {
    return {
      ok: false,
      ...baseState,
      enabled: true,
      profiles: parsed.profiles,
      error: {
        code: "missing_default_model",
        message: "AI is enabled but no valid default model profile is configured.",
        fields: { "ai.default_model_id": "Choose an enabled model profile id." },
      },
    };
  }

  if (!defaultProfile.enabled) {
    return {
      ok: false,
      ...baseState,
      enabled: true,
      profiles: parsed.profiles,
      error: {
        code: "default_model_disabled",
        message: `Default AI model "${input.defaultModelId}" is disabled.`,
        fields: { "ai.default_model_id": "Choose an enabled model profile id." },
      },
    };
  }

  if (providerRequiresCredential(defaultProfile.provider)) {
    let credentialConfigured = input.credentialProfileIds?.includes(defaultProfile.id) ?? false;
    if (!input.credentialProfileIds && input.readCredential) {
      try {
        credentialConfigured = Boolean((await input.readCredential(defaultProfile.id))?.trim());
      } catch {
        credentialConfigured = false;
      }
    }
    if (!credentialConfigured) {
      return {
        ok: false,
        ...baseState,
        enabled: true,
        profiles: parsed.profiles,
        error: {
          code: "missing_provider_credential",
          message: `Default AI model "${input.defaultModelId}" is missing provider credentials.`,
          fields: { "ai.model_profiles_json": "Enter the provider API key on the default model profile." },
        },
      };
    }
  }

  return {
    ok: true,
    ...baseState,
    enabled: true,
    profiles: parsed.profiles,
  };
};

const readAiSettingsSnapshot = async (): Promise<{ state: AiSettingsState; credentialProfileIds: string[] }> => {
  const [
    enabled,
    defaultModelId,
    visionModelId,
    profilesJson,
    globalInstructions,
    compactionInstructions,
    maxToolResultChars,
    firecrawlApiKey,
  ] = await Promise.all([
    coreSettings.get<boolean>("ai.enabled"),
    coreSettings.get<string>("ai.default_model_id"),
    coreSettings.get<string>("ai.vision_model_id"),
    coreSettings.get<string>("ai.model_profiles_json"),
    coreSettings.get<string>("ai.global_instructions"),
    coreSettings.get<string>("ai.compaction_instructions"),
    coreSettings.get<number>("ai.max_tool_result_chars"),
    coreSettings.get<string>(AI_FIRECRAWL_API_KEY_SETTING_KEY),
  ]);

  const parsed = parseAiModelProfiles(profilesJson ?? "[]");
  const defaultProfile = parsed.profiles.find((profile) => profile.id === defaultModelId);
  const needsCredentials =
    Boolean(enabled) &&
    !parsed.error &&
    Boolean(defaultProfile?.enabled) &&
    parsed.profiles.some((profile) => profile.enabled && providerRequiresCredential(profile.provider));
  const credentialProfileIds = needsCredentials ? await listAiCredentialProfileIds() : [];

  const state = await resolveAiSettingsStateFromRaw({
    enabled: Boolean(enabled),
    defaultModelId: defaultModelId ?? "",
    visionModelId: visionModelId ?? "",
    profilesJson: profilesJson ?? "[]",
    globalInstructions: globalInstructions ?? "",
    compactionInstructions: compactionInstructions ?? "",
    maxToolResultChars,
    firecrawlApiKey: firecrawlApiKey ?? "",
    credentialProfileIds,
  });
  return { state, credentialProfileIds };
};

export const readAiSettingsState = async (): Promise<AiSettingsState> => (await readAiSettingsSnapshot()).state;

const hasAll = <T extends string>(values: readonly T[], required: readonly T[] | undefined): boolean =>
  !required || required.every((requiredValue) => values.includes(requiredValue));

const matchesPolicy = (profile: AiModelProfile, policy: AiModelPolicy): boolean => {
  if (!profile.enabled) return false;
  if ("allowedModelIds" in policy && policy.allowedModelIds && !policy.allowedModelIds.includes(profile.id)) return false;
  if (policy.allowedDataBoundaries && !policy.allowedDataBoundaries.includes(profile.dataBoundary)) return false;
  return hasAll(profile.capabilities, policy.requiredCapabilities);
};

const resolvePolicyModelId = (state: Extract<AiSettingsState, { ok: true }>, policy: AiModelPolicy, requestedModelId?: string): string => {
  if (policy.kind === "locked") return policy.modelId;
  if (policy.kind === "selectable") return requestedModelId ?? policy.defaultModelId ?? state.defaultModelId;
  return state.defaultModelId;
};

export const selectAiModelProfile = (
  state: Extract<AiSettingsState, { ok: true }>,
  policy: AiModelPolicy,
  requestedModelId?: string,
): AiModelProfile => {
  const modelId = resolvePolicyModelId(state, policy, requestedModelId);
  const profile = state.profiles.find((candidate) => candidate.id === modelId);
  if (!profile || !matchesPolicy(profile, policy)) {
    throw Object.assign(new Error(`AI model "${modelId}" is not allowed for this chat.`), {
      aiError: {
        code: "model_policy_mismatch",
        message: `AI model "${modelId}" is not allowed for this chat.`,
        fields: { modelProfileId: "Choose an allowed enabled model profile." },
      } satisfies AiSettingsError,
    });
  }
  return profile;
};

export const resolveAiModel = async (
  policy: AiModelPolicy = { kind: "platform-default" },
  requestedModelId?: string,
): Promise<AiResolvedModel> => {
  const state = await readAiSettingsState();
  return resolveAiModelFromState(state, policy, requestedModelId);
};

const visionModelPolicy = (modelId: string, allowedDataBoundaries?: AiDataBoundary[]): AiModelPolicy => ({
  kind: "locked",
  modelId,
  requiredCapabilities: ["vision"],
  allowedDataBoundaries,
});

export const resolveAiVisionModel = async (allowedDataBoundaries?: AiDataBoundary[]): Promise<AiResolvedModel> => {
  const state = await readAiSettingsState();
  if (!state.ok) throw Object.assign(new Error(state.error.message), { aiError: state.error });
  const modelId = (state.visionModelId ?? "").trim();
  if (!modelId) throw new Error("No vision model is configured.");
  return resolveAiModelFromState(state, visionModelPolicy(modelId, allowedDataBoundaries));
};

export const isAiVisionModelConfigured = async (allowedDataBoundaries?: AiDataBoundary[]): Promise<boolean> => {
  const { state, credentialProfileIds } = await readAiSettingsSnapshot();
  if (!state.ok || !state.enabled || !state.visionModelId?.trim()) return false;
  try {
    const profile = selectAiModelProfile(state, visionModelPolicy(state.visionModelId, allowedDataBoundaries));
    return isUsableProfile(profile, new Set(credentialProfileIds));
  } catch {
    return false;
  }
};

export const resolveAiModelFromState = async (
  state: AiSettingsState,
  policy: AiModelPolicy = { kind: "platform-default" },
  requestedModelId?: string,
): Promise<AiResolvedModel> => {
  if (!state.ok) throw Object.assign(new Error(state.error.message), { aiError: state.error });
  if (!state.enabled) {
    throw Object.assign(new Error("AI is disabled."), {
      aiError: { code: "ai_disabled", message: "AI is disabled." } satisfies AiSettingsError,
    });
  }

  const profile = selectAiModelProfile(state, policy, requestedModelId);

  const credential = providerSupportsCredential(profile.provider) ? await getAiCredential(profile.id) : null;
  if (providerRequiresCredential(profile.provider) && !credential?.trim()) {
    throw Object.assign(new Error(`AI model "${profile.id}" is missing provider credentials.`), {
      aiError: {
        code: "missing_provider_credential",
        message: `AI model "${profile.id}" is missing provider credentials.`,
        fields: { "ai.model_profiles_json": "Enter the provider API key on this model profile." },
      } satisfies AiSettingsError,
    });
  }

  return { profile, provider: createAiProvider(profile, credential?.trim() || undefined) };
};

const isUsableProfile = (profile: AiModelProfile, credentialProfileIds: ReadonlySet<string>): boolean =>
  !providerRequiresCredential(profile.provider) || credentialProfileIds.has(profile.id);

export const listAiModels = async (policy: AiModelPolicy = { kind: "selectable" }): Promise<AiPublicModelProfile[]> => {
  const { state, credentialProfileIds } = await readAiSettingsSnapshot();
  if (!state.ok || !state.enabled) return [];
  const configured = new Set(credentialProfileIds);
  return state.profiles.filter((profile) => matchesPolicy(profile, policy) && isUsableProfile(profile, configured)).map(profileToPublic);
};

export const toPublicAiSettingsState = async (allowedDataBoundaries?: AiDataBoundary[]) => {
  const { state, credentialProfileIds } = await readAiSettingsSnapshot();
  const configured = new Set(credentialProfileIds);
  let visionModelConfigured = false;
  if (state.ok && state.enabled && state.visionModelId?.trim()) {
    try {
      const profile = selectAiModelProfile(state, visionModelPolicy(state.visionModelId, allowedDataBoundaries));
      visionModelConfigured = isUsableProfile(profile, configured);
    } catch {
      // The configured auxiliary model is outside this application's policy.
    }
  }
  return {
    ok: state.ok,
    enabled: state.enabled,
    defaultModelId: state.defaultModelId,
    visionModelConfigured,
    error: state.ok ? null : state.error,
    firecrawlConfigured: state.firecrawlConfigured,
    models:
      state.ok && state.enabled
        ? state.profiles.filter((profile) => profile.enabled && isUsableProfile(profile, configured)).map(profileToPublic)
        : [],
  };
};

export type { AiDataBoundary, AiModelCapability, AiModelPolicy, AiModelProfile };
