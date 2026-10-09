import type { AccessSubject, RequestActor } from "../server";
import { aiModelAccess } from "./model-access";
import { personalAiModelPolicy } from "./personal-agent";
import { listAiModels, toPublicAiSettingsState } from "./settings";
import { type AiResolvedAudioModel, AiTranscriptionError, resolveAiAudioModel } from "./transcription";
import type { AiChatTurnRunConfig, AiDataBoundary, AiModelPolicy, AiSettingsError } from "./types";
import { isAiSettingsError } from "./validate";

export const aiChatAccessSubject = (actor: RequestActor | undefined): AccessSubject | null => {
  if (!actor) return null;
  if (actor.kind === "user") return { type: "user", userId: actor.user.id };
  if (actor.delegatedUser) {
    return { type: "user", userId: actor.delegatedUser.id, delegatedByServiceAccountId: actor.serviceAccount.id };
  }
  return { type: "service_account", serviceAccountId: actor.serviceAccount.id };
};

/** Background chat deliveries also use default tools; only the explicit HTTP marker identifies interactive turns. */
export const isAssistantChatTurn = (config: AiChatTurnRunConfig): boolean => config.assistantChat === true && !config.mandate;

export const listAssistantAiModels = async (subject: AccessSubject | null, policy: AiModelPolicy = personalAiModelPolicy) =>
  aiModelAccess.filterModels(await listAiModels(policy), subject);

/** The one audio check behind the composer microphone, dictation, and offering and running transcribe_audio. */
export const resolveAssistantAudioModel = async (
  subject: AccessSubject | null,
  allowedDataBoundaries?: AiDataBoundary[],
): Promise<AiResolvedAudioModel> => {
  const model = await resolveAiAudioModel({ allowedDataBoundaries });
  try {
    await aiModelAccess.assertAllowed(model.profile.id, subject);
  } catch (error) {
    if (!isAiSettingsError(error) || error.aiError.code !== "model_access_denied") throw error;
    throw Object.assign(
      new AiTranscriptionError(
        "transcription_access_denied",
        "Audio transcription is not available to you: you do not have access to the audio model. An administrator can grant access in the AI settings.",
      ),
      { aiError: error.aiError },
    );
  }
  return model;
};

export const assistantAiSettingsState = async (subject: AccessSubject | null) => {
  const [status, models, audioModelConfigured] = await Promise.all([
    toPublicAiSettingsState(personalAiModelPolicy.allowedDataBoundaries),
    listAssistantAiModels(subject),
    (async () => {
      try {
        await resolveAssistantAudioModel(subject, personalAiModelPolicy.allowedDataBoundaries);
        return true;
      } catch {
        return false;
      }
    })(),
  ]);
  return {
    ...status,
    audioModelConfigured,
    models,
    defaultModelId: models.some((model) => model.id === status.defaultModelId) ? status.defaultModelId : (models[0]?.id ?? ""),
  };
};

/** Explicit and project selections never silently switch models. */
export const selectAssistantAiModelId = async (
  subject: AccessSubject | null,
  requestedModelId?: string,
  policy: AiModelPolicy = personalAiModelPolicy,
): Promise<string> => {
  if (policy.kind === "locked") {
    await aiModelAccess.assertAllowed(policy.modelId, subject);
    return policy.modelId;
  }
  if (policy.kind === "platform-default") {
    const status = await toPublicAiSettingsState();
    await aiModelAccess.assertAllowed(status.defaultModelId, subject);
    return status.defaultModelId;
  }
  if (requestedModelId) {
    await aiModelAccess.assertAllowed(requestedModelId, subject);
    return requestedModelId;
  }
  const [status, models] = await Promise.all([toPublicAiSettingsState(), listAssistantAiModels(subject, policy)]);
  const preferred = policy.defaultModelId;
  const model = models.find((candidate) => candidate.id === (preferred ?? status.defaultModelId)) ?? models[0];
  if (!model) {
    const message = "No AI model is available for your Assistant access. Contact an administrator.";
    throw Object.assign(new Error(message), { aiError: { code: "model_access_denied", message } satisfies AiSettingsError });
  }
  return model.id;
};
