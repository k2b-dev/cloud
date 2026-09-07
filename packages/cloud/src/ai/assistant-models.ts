import type { AccessSubject, RequestActor } from "../server";
import { aiModelAccess } from "./model-access";
import { personalAiModelPolicy } from "./personal-agent";
import { listAiModels, toPublicAiSettingsState } from "./settings";
import type { AiChatTurnRunConfig, AiModelPolicy, AiSettingsError } from "./types";

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

export const assistantAiSettingsState = async (subject: AccessSubject | null) => {
  const [status, models] = await Promise.all([
    toPublicAiSettingsState(personalAiModelPolicy.allowedDataBoundaries),
    listAssistantAiModels(subject),
  ]);
  return {
    ...status,
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
