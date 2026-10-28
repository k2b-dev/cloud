import type { AccessSubject } from "../server/services/access";
import { selectAssistantAiModel } from "./assistant-models";
import { personalAiModelPolicy } from "./personal-agent";
import { resolveAiModel } from "./settings";
import { resolveAiWorkflowModel } from "./structured";

/** Interactive application tasks retain Assistant grants and data-boundary policy. */
export const resolveApplicationAiTaskModel = async (subject?: AccessSubject, model?: import("../shared/ai-models").AiModelRequest) =>
  subject ? resolveAiModel(personalAiModelPolicy, await selectAssistantAiModel(subject, model)) : resolveAiWorkflowModel(model);
