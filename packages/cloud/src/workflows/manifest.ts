import { workflowBuiltinActionDescriptors } from "./builtins";
import type { WorkflowActionDescriptor, WorkflowLanguageManifest } from "./contracts";
import { LANGUAGE_EFFECT, type WorkflowActionMap } from "./definition";

type WorkflowActionMetadata = Record<string, Pick<WorkflowActionMap[string], "label" | "description" | "config" | "effect" | "outputType">>;

const workflowActionDescriptors = (actions: WorkflowActionMetadata): WorkflowActionDescriptor[] =>
  Object.entries(actions).map(([key, action]) => ({
    kind: key,
    label: action.label,
    description: action.description,
    config: action.config,
    effect: LANGUAGE_EFFECT[action.effect],
    ...(action.outputType ? { outputType: action.outputType } : {}),
    dryRun: action.effect === "pure" ? "full" : "validate",
  }));

/** Build authoring metadata without importing action implementations. */
export const createWorkflowManifest = (
  definition: Omit<WorkflowLanguageManifest, "actions"> & { actions: WorkflowActionMetadata },
): WorkflowLanguageManifest => {
  const { actions, ...language } = definition;
  return { ...language, actions: [...workflowActionDescriptors(actions), ...workflowBuiltinActionDescriptors] };
};
