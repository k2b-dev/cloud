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
import { createAiProvider } from "./provider";
import { getAiRequestHeaders } from "./request-headers";
import type { AiDataBoundary, AiModelPolicy, AiModelProfile, AiResolvedModel, AiSettingsError, AiSettingsState } from "./types";

export { providerRequiresCredential, providerSupportsCredential };
export const aiSettingsFailure = (code: AiSettingsError["code"], message: string): never => {
  throw Object.assign(new Error(message), { aiError: { code, message } satisfies AiSettingsError });
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
  profile.capabilities.includes("transcription") === Boolean(policy.requiredCapabilities?.includes("transcription")) &&
  (!("allowedModelIds" in policy) || !policy.allowedModelIds || policy.allowedModelIds.includes(profile.id)) &&
  (!policy.allowedDataBoundaries || policy.allowedDataBoundaries.includes(profile.dataBoundary)) &&
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
  if (!profile || !matchesAiModelPolicy(profile, policy))
    return aiSettingsFailure("model_policy_mismatch", "The AI model is missing, disabled, or outside the permitted policy.");
  return profile;
};
export const resolveAiModelFromState = async (
  state: AiSettingsState,
  policy: AiModelPolicy = { kind: "platform-default" },
  request?: AiModelRequest,
): Promise<AiResolvedModel> => {
  const model = resolveAiModelRef(state, policyRequest(policy, request));
  const profile = selectAiModelProfile(state, policy, request);
  const credential = providerSupportsCredential(profile.provider) ? await getAiCredential(profile.providerId) : null;
  if (providerRequiresCredential(profile.provider) && !credential?.trim())
    return aiSettingsFailure("model_policy_mismatch", "The AI provider has no usable credential.");
  const headers = providerSupportsRequestHeaders(profile.provider) ? await getAiRequestHeaders(profile.providerId) : {};
  return { model, profile, provider: createAiProvider(profile, credential?.trim() || undefined, headers) };
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
export const isAiVisionModelConfigured = async (allowedDataBoundaries?: AiDataBoundary[]): Promise<boolean> => {
  try {
    await resolveAiVisionModel(allowedDataBoundaries);
    return true;
  } catch {
    return false;
  }
};
export const listAiModels = async (policy: AiModelPolicy = { kind: "selectable" }): Promise<AiModelProfile[]> => {
  const [state, credentials] = await Promise.all([readAiSettingsState(), listAiCredentialProviderIds()]);
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
