import type { WorkflowIrInput, WorkflowJsonValue } from "@k2b/cloud/workflows";
import type { GridsWorkflowLauncherConfig, GridsWorkflowLauncherKind } from "../../../workflows/contracts";
import type { PublicWorkflowLauncher } from "../workspace/workspace-public-state-model";
import { workflowInputLabel, workflowInputRequired } from "./workflow-trigger-actions";

export const customAppLauncherConfigForSave = (
  launcher?: Pick<PublicWorkflowLauncher, "config">,
  inputMode: "fixed" | "prompt" = "fixed",
  inputBindings?: Record<string, WorkflowJsonValue>,
): Extract<GridsWorkflowLauncherConfig, { kind: "customApp" }> =>
  inputMode === "prompt"
    ? {
        kind: "customApp",
        ...(launcher?.config.kind === "customApp" && launcher.config.label ? { label: launcher.config.label } : {}),
        inputMode,
      }
    : {
        kind: "customApp",
        ...(launcher?.config.kind === "customApp" && launcher.config.label ? { label: launcher.config.label } : {}),
        inputMode,
        ...(inputBindings === undefined
          ? launcher?.config.kind === "customApp" && launcher.config.inputBindings
            ? { inputBindings: launcher.config.inputBindings }
            : {}
          : { inputBindings }),
      };

export const missingLauncherRequiredInputs = (
  inputs: WorkflowIrInput[],
  kind: GridsWorkflowLauncherKind,
  controlledInput: string,
): string[] =>
  kind === "customApp"
    ? []
    : inputs.filter((input) => workflowInputRequired(input) && input.name !== controlledInput).map((input) => workflowInputLabel(input));
