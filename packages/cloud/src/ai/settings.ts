import { coreSettings } from "../services";
import {
  type AiModelRequest,
  type AiResolvedModelRef,
  aiModelClassFallbackChain,
  providerRequiresCredential,
  providerSupportsCredential,
} from "../shared/ai-models";
import { providerSupportsRequestHeaders } from "../shared/ai-request-options";
import { getAiCredential, listAiCredentialProviderIds } from "./credentials";
import { AI_FIRECRAWL_API_KEY_SETTING_KEY } from "./firecrawl-tools";
import { aiModelCatalog, readAiModelProfiles } from "./model-catalog";
import { aiModelUsesReasoning } from "./output-budget";
import { createAiProvider } from "./provider";
import { listProviderModels } from "./provider-connections";
import { getAiRequestHeaders } from "./request-headers";
import type { AiDataBoundary, AiModelPolicy, AiModelProfile, AiResolvedModel, AiSettingsError, AiSettingsState } from "./types";

export { providerRequiresCredential, providerSupportsCredential };
export const aiSettingsFailure = (code: AiSettingsError["code"], message: string, fields?: AiSettingsError["fields"]): never => {
  throw Object.assign(new Error(message), { aiError: { code, message, ...(fields ? { fields } : {}) } satisfies AiSettingsError });
};
export const readAiSettingsState = async (): Promise<AiSettingsState> => {
  const [
    enabled,
    globalInstructions,
    localClientInstructions,
    compactionInstructions,
    maxToolResultChars,
    firecrawlApiKey,
    profiles,
    assignments,
  ] = await Promise.all([
    coreSettings.get<boolean>("ai.enabled"),
    coreSettings.get<string>("ai.global_instructions"),
    coreSettings.get<string>("ai.local_client_instructions"),
    coreSettings.get<string>("ai.compaction_instructions"),
    coreSettings.get<number>("ai.max_tool_result_chars"),
    coreSettings.get<string>(AI_FIRECRAWL_API_KEY_SETTING_KEY),
    readAiModelProfiles(),
    aiModelCatalog.assignments(),
  ]);
  return {
    ok: true,
    enabled: Boolean(enabled),
    assignments,
    globalInstructions: globalInstructions ?? "",
    localClientInstructions: localClientInstructions ?? "",
    compactionInstructions: compactionInstructions ?? "",
    maxToolResultChars: maxToolResultChars > 0 ? maxToolResultChars : 2_000_000,
    firecrawlConfigured: Boolean(firecrawlApiKey?.trim()),
    profiles,
  };
};
export const matchesAiModelPolicy = (profile: AiModelProfile, policy: AiModelPolicy): boolean =>
  profile.enabled &&
  profile.kind !== "decision" &&
  profile.capabilities.includes("live-transcription") === Boolean(policy.requiredCapabilities?.includes("live-transcription")) &&
  profile.capabilities.includes("transcription") === Boolean(policy.requiredCapabilities?.includes("transcription")) &&
  (!("allowedModelIds" in policy) || !policy.allowedModelIds || policy.allowedModelIds.includes(profile.id)) &&
  // Safe by default: a policy reaches `restricted` models only when it names that boundary.
  (policy.allowedDataBoundaries ? policy.allowedDataBoundaries.includes(profile.dataBoundary) : profile.dataBoundary !== "restricted") &&
  (!policy.requiredCapabilities || policy.requiredCapabilities.every((capability) => profile.capabilities.includes(capability)));

export const resolveAiModelRef = (
  state: Pick<AiSettingsState, "enabled" | "assignments">,
  request: AiModelRequest = { class: "balanced" },
): AiResolvedModelRef => {
  if (!state.enabled) return aiSettingsFailure("ai_disabled", "AI is disabled.");
  if ("id" in request) return { id: request.id };
  for (const modelClass of [request.class, ...aiModelClassFallbackChain(request.class)]) {
    const assignment = state.assignments.find((assignment) => assignment.slot === modelClass);
    if (assignment?.variantId) return { requestedClass: request.class, class: modelClass, id: assignment.variantId };
  }
  return aiSettingsFailure("ai_no_model", "No AI model class is assigned.");
};
const policyRequest = (policy: AiModelPolicy, request?: AiModelRequest): AiModelRequest | undefined =>
  policy.kind === "locked" ? { id: policy.modelId } : request;
export const selectAiModelProfile = (state: AiSettingsState, policy: AiModelPolicy, request?: AiModelRequest): AiModelProfile => {
  const ref = resolveAiModelRef(state, policyRequest(policy, request));
  const profile = state.profiles.find((candidate) => candidate.id === ref.id);
  if (!profile)
    return aiSettingsFailure("model_policy_mismatch", `The AI model "${ref.id}" does not exist. It may have been deleted.`, {
      model: ref.id,
    });
  // A class never resolves to a restricted model, even if an assignment still held one.
  if (profile.dataBoundary === "restricted" && (ref.class || !policy.allowedDataBoundaries?.includes("restricted")))
    return aiSettingsFailure(
      "model_policy_mismatch",
      `The AI model "${ref.id}" has no data-protection commitment. Only application server code that names its ID can use it.`,
      { model: ref.id, boundary: "restricted" },
    );
  if (!profile.enabled) return aiSettingsFailure("model_policy_mismatch", `The AI model "${ref.id}" is disabled.`, { model: ref.id });
  if (!matchesAiModelPolicy(profile, policy))
    return aiSettingsFailure("model_policy_mismatch", `The AI model "${ref.id}" is outside the permitted policy.`, { model: ref.id });
  return profile;
};
export const resolveAiModelFromState = async (
  state: AiSettingsState,
  policy: AiModelPolicy = { kind: "platform-default" },
  request?: AiModelRequest,
): Promise<AiResolvedModel> => {
  const model = resolveAiModelRef(state, policyRequest(policy, request));
  let profile = selectAiModelProfile(state, policy, request);
  const credential = providerSupportsCredential(profile.provider) ? await getAiCredential(profile.providerId) : null;
  if (providerRequiresCredential(profile.provider) && !credential?.trim())
    return aiSettingsFailure("model_policy_mismatch", "The AI provider has no usable credential.");
  const headers = providerSupportsRequestHeaders(profile.provider) ? await getAiRequestHeaders(profile.providerId) : {};
  const provider = createAiProvider(profile, credential?.trim() || undefined, headers);
  // Older catalog rows have no reported output ceiling. Resolve the provider's facts before budgeting, rather than
  // treating a context window as an output limit. Explicit configuration avoids this lookup, bounded to ten seconds.
  if (profile.maxOutputTokens === undefined && profile.outputTokenLimit === undefined && aiModelUsesReasoning(profile, provider)) {
    try {
      const reported = (
        await listProviderModels({ type: profile.provider, baseUrl: profile.baseURL ?? null, apiKey: credential ?? undefined, headers })
      ).find((candidate) => candidate.providerModel === profile.model);
      if (reported) {
        profile = {
          ...profile,
          contextWindow: profile.contextWindow ?? reported.contextWindow,
          outputTokenLimit: reported.outputTokenLimit,
        };
        return { model, profile, provider: createAiProvider(profile, credential?.trim() || undefined, headers) };
      }
    } catch {
      // Discovery is optional. An unavailable listing must not block an otherwise usable generation endpoint.
    }
  }
  return { model, profile, provider };
};
export const resolveAiModel = async (
  policy: AiModelPolicy = { kind: "platform-default" },
  request?: AiModelRequest,
): Promise<AiResolvedModel> => resolveAiModelFromState(await readAiSettingsState(), policy, request);
export const resolveAiVisionModel = async (allowedDataBoundaries?: AiDataBoundary[]): Promise<AiResolvedModel> => {
  const state = await readAiSettingsState();
  if (!state.enabled) return aiSettingsFailure("ai_disabled", "AI is disabled.");
  const id = state.assignments.find((assignment) => assignment.slot === "vision")?.variantId;
  if (!id) return aiSettingsFailure("model_policy_mismatch", "No image inspection model is assigned.");
  return resolveAiModelFromState(state, { kind: "locked", modelId: id, requiredCapabilities: ["vision"], allowedDataBoundaries });
};
export const isAiVisionModelConfigured = async (
  allowedDataBoundaries?: AiDataBoundary[],
  providedState?: AiSettingsState,
): Promise<boolean> => {
  try {
    const state = providedState ?? (await readAiSettingsState());
    const id = state.assignments.find((assignment) => assignment.slot === "vision")?.variantId;
    if (!id) return false;
    const profile = selectAiModelProfile(state, { kind: "locked", modelId: id, requiredCapabilities: ["vision"], allowedDataBoundaries });
    return !providerRequiresCredential(profile.provider) || (await listAiCredentialProviderIds()).includes(profile.providerId);
  } catch {
    return false;
  }
};
export const listAiModels = async (
  policy: AiModelPolicy = { kind: "selectable" },
  providedState?: AiSettingsState,
): Promise<AiModelProfile[]> => {
  const [state, credentials] = await Promise.all([providedState ?? readAiSettingsState(), listAiCredentialProviderIds()]);
  if (!state.enabled) return [];
  return state.profiles.filter(
    (profile) =>
      matchesAiModelPolicy(profile, policy) && (!providerRequiresCredential(profile.provider) || credentials.includes(profile.providerId)),
  );
};
export const toPublicAiSettingsState = async (allowedDataBoundaries?: AiDataBoundary[]) => {
  const state = await readAiSettingsState();
  return {
    ok: true,
    enabled: state.enabled,
    visionModelConfigured: await isAiVisionModelConfigured(allowedDataBoundaries),
    firecrawlConfigured: state.firecrawlConfigured,
    error: null,
  };
};
export type { AiDataBoundary, AiModelCapability, AiModelPolicy, AiModelProfile } from "./types";
