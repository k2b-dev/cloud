import { describe, expect, test } from "bun:test";
import type { WorkflowIrInput } from "@k2b/cloud/workflows";
import type { PublicWorkflowLauncher } from "../workspace/workspace-public-state-model";
import { customAppLauncherConfigForSave, missingLauncherRequiredInputs } from "./workflow-launcher-draft";

describe("workflow launcher editor", () => {
  test("preserves App labels and fixed input bindings while editing metadata", () => {
    const launcher = {
      config: { kind: "customApp", label: "Refresh", inputMode: "fixed", inputBindings: { range: "30d" } },
    } satisfies Pick<PublicWorkflowLauncher, "config">;

    expect(customAppLauncherConfigForSave(launcher)).toEqual({
      kind: "customApp",
      label: "Refresh",
      inputMode: "fixed",
      inputBindings: { range: "30d" },
    });
  });

  test("replaces App fixed input bindings when edited", () => {
    const launcher = {
      config: { kind: "customApp", label: "Refresh", inputMode: "fixed", inputBindings: { range: "30d" } },
    } satisfies Pick<PublicWorkflowLauncher, "config">;

    expect(customAppLauncherConfigForSave(launcher, "fixed", { range: "7d", notify: false })).toEqual({
      kind: "customApp",
      label: "Refresh",
      inputMode: "fixed",
      inputBindings: { range: "7d", notify: false },
    });
  });

  test("stores prompt mode without fixed values", () => {
    const launcher = {
      config: { kind: "customApp", label: "Run", inputMode: "fixed", inputBindings: { range: "30d" } },
    } satisfies Pick<PublicWorkflowLauncher, "config">;

    expect(customAppLauncherConfigForSave(launcher, "prompt", { range: "7d" })).toEqual({
      kind: "customApp",
      label: "Run",
      inputMode: "prompt",
    });
  });

  test("reports required inputs not supplied by scanner or bulk launchers", () => {
    const inputs: WorkflowIrInput[] = [
      { name: "record", type: "record", config: { label: "Loan", required: true } },
      { name: "notify", type: "boolean", config: { label: "Notify owner", required: true } },
      { name: "note", type: "text", config: {} },
    ];

    expect(missingLauncherRequiredInputs(inputs, "scanner", "record")).toEqual(["Notify owner"]);
    expect(missingLauncherRequiredInputs(inputs, "customApp", "")).toEqual([]);
  });
});
