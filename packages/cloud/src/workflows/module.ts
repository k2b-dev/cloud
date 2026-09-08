import type { WorkflowLanguageManifest } from "./contracts";
import type { WorkflowActionMap } from "./definition";
import { createWorkflowManifest } from "./manifest";

export type DefinedWorkflowModule<Actions extends WorkflowActionMap = WorkflowActionMap> = {
  actions: Actions;
  manifest: WorkflowLanguageManifest;
};

export const defineWorkflowModule = <const Actions extends WorkflowActionMap>(
  definition: Omit<WorkflowLanguageManifest, "actions"> & { actions: Actions },
): DefinedWorkflowModule<Actions> => ({ actions: definition.actions, manifest: createWorkflowManifest(definition) });
