import type { AccessSubject } from "../server/services/access";
import { selectAssistantAiModelId } from "./assistant-models";
import { personalAiModelPolicy } from "./personal-agent";
import { resolveAiModel } from "./settings";
import { resolveAiWorkflowModel } from "./structured";

/** Interactive application tasks retain Assistant grants and data-boundary policy. */
export const resolveApplicationAiTaskModel = async (subject?: AccessSubject, requestedModelId?: string) =>
  subject
    ? resolveAiModel(personalAiModelPolicy, await selectAssistantAiModelId(subject, requestedModelId))
    : resolveAiWorkflowModel(requestedModelId);
