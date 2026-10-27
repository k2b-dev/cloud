import type { AccessSubject, RequestActor } from "../server";
import { aiModelAccess } from "./model-access";
import { aiModelCatalog } from "./model-catalog";
import {
  AI_MODEL_CLASSES,
  type AiModelRequest,
  type AiModelUnavailableReason,
  type AiPeopleModelIcon,
  type AiPeopleModels,
} from "./model-contracts";
import { personalAiModelPolicy } from "./personal-agent";
import { aiUserPrefs } from "./prefs";
import { aiQuotas } from "./quotas";
import { listAiModels, readAiSettingsState, resolveAiModelRef, selectAiModelProfile, toPublicAiSettingsState } from "./settings";
import { type AiResolvedAudioModel, AiTranscriptionError, resolveAiAudioModel } from "./transcription";
import type { AiChatTurnRunConfig, AiDataBoundary, AiModelPolicy } from "./types";
import { isAiSettingsError } from "./validate";

export const aiChatAccessSubject = (actor: RequestActor | undefined): AccessSubject | null => {
  if (!actor) return null;
  if (actor.kind === "user") return { type: "user", userId: actor.user.id };
  if (actor.delegatedUser) return { type: "user", userId: actor.delegatedUser.id, delegatedByServiceAccountId: actor.serviceAccount.id };
  return { type: "service_account", serviceAccountId: actor.serviceAccount.id };
};
export const isAssistantChatTurn = (config: AiChatTurnRunConfig): boolean => config.assistantChat === true && !config.mandate;
/** Server-side list for permission-aware execution and the developer API. */
export const listAssistantAiModels = async (subject: AccessSubject | null, policy: AiModelPolicy = personalAiModelPolicy) =>
  aiModelAccess.filterModels(await listAiModels(policy), subject);
export const peopleAiModels = async (
  subject: AccessSubject | null,
  policy: AiModelPolicy = personalAiModelPolicy,
): Promise<AiPeopleModels> => {
  const [state, allowed, providers, prefs] = await Promise.all([
    readAiSettingsState(),
    listAssistantAiModels(subject, policy),
    aiModelCatalog.providers(),
    subject?.type === "user" ? aiUserPrefs.get(subject.userId) : null,
  ]);
  const options: AiPeopleModels["options"] = [];
  const unavailable = new Map<string, AiModelUnavailableReason>();
  for (const profile of allowed) {
    const provider = providers.find((provider) => provider.id === profile.providerId);
    let reason: AiModelUnavailableReason | undefined =
      provider?.status === "key_rejected"
        ? { code: "key_rejected" }
        : provider?.status === "unreachable"
          ? { code: "provider_unreachable" }
          : undefined;
    if (!reason && subject) {
      const snapshot = await aiQuotas.snapshot(subject, profile.modelId);
      const exhausted = snapshot.balances.find(
        (balance) => !balance.bypassed && balance.limit !== null && (balance.unknown > 0 || balance.used >= balance.limit),
      );
      if (exhausted) reason = { code: "budget_exhausted", resetsAt: exhausted.resetsAt };
    }
    if (reason) unavailable.set(profile.id, reason);
    if (!profile.showInPicker) continue;
    const icon: AiPeopleModelIcon =
      profile.icon.kind === "image"
        ? { kind: "image", src: profile.icon.dataUrl }
        : profile.icon.kind === "emoji"
          ? profile.icon
          : {
              kind: "mark",
              text: (provider?.label ?? "AI")
                .split(/\s+/)
                .map((word) => word[0])
                .join("")
                .slice(0, 2)
                .toUpperCase(),
              color: String(Array.from(profile.providerId).reduce((sum, letter) => (sum * 31 + letter.charCodeAt(0)) >>> 0, 0) % 12),
            };
    options.push({
      id: profile.id,
      label: profile.label,
      ...(profile.id !== profile.modelId ? { variantLabel: profile.variantLabel } : {}),
      description: profile.description,
      icon,
      classes: AI_MODEL_CLASSES.filter((modelClass) =>
        state.assignments.some((assignment) => assignment.slot === modelClass && assignment.variantId === profile.id),
      ),
      ...(reason ? { unavailable: reason } : {}),
    });
  }
  const storedSelection = prefs?.selection;
  const selection =
    storedSelection && "id" in storedSelection && !state.profiles.some((profile) => profile.id === storedSelection.id)
      ? null
      : (storedSelection ?? null);
  return {
    status: "ok",
    selection,
    effectiveDefault: { class: "balanced" },
    classes: AI_MODEL_CLASSES.flatMap((modelClass) => {
      const id = state.assignments.find((assignment) => assignment.slot === modelClass)?.variantId;
      return id
        ? [
            {
              class: modelClass,
              variantId: id,
              ...(!allowed.some((model) => model.id === id)
                ? { unavailable: { code: "access_revoked" } as const }
                : unavailable.has(id)
                  ? { unavailable: unavailable.get(id) }
                  : {}),
            },
          ]
        : [];
    }),
    options,
  };
};
export const resolveAssistantAudioModel = async (
  subject: AccessSubject | null,
  allowedDataBoundaries?: AiDataBoundary[],
): Promise<AiResolvedAudioModel> => {
  const model = await resolveAiAudioModel({ allowedDataBoundaries });
  try {
    await aiModelAccess.assertAllowed(model.profile.modelId, subject);
  } catch (error) {
    if (!isAiSettingsError(error)) throw error;
    throw Object.assign(new AiTranscriptionError("transcription_access_denied", "Audio transcription is not available to you."), {
      aiError: error.aiError,
    });
  }
  return model;
};
export const assistantAiSettingsState = async (subject: AccessSubject | null) => {
  const [status, choices, audioModelConfigured] = await Promise.all([
    toPublicAiSettingsState(personalAiModelPolicy.allowedDataBoundaries),
    peopleAiModels(subject),
    resolveAssistantAudioModel(subject, personalAiModelPolicy.allowedDataBoundaries).then(
      () => true,
      () => false,
    ),
  ]);
  return { ...status, ...choices, audioModelConfigured };
};
/** Class fallback only considers empty assignments, and access is checked on the owning model. */
export const selectAssistantAiModel = async (
  subject: AccessSubject | null,
  model?: AiModelRequest,
  policy: AiModelPolicy = personalAiModelPolicy,
): Promise<AiModelRequest> => {
  const state = await readAiSettingsState();
  const stored = !model && subject?.type === "user" ? (await aiUserPrefs.get(subject.userId)).selection : null;
  const selection = stored && "id" in stored && !state.profiles.some((profile) => profile.id === stored.id) ? null : stored;
  const requested = model ?? selection ?? { class: "balanced" };
  const profile = selectAiModelProfile(state, policy, requested);
  await aiModelAccess.assertAllowed(profile.modelId, subject);
  resolveAiModelRef(state, requested);
  return requested;
};
