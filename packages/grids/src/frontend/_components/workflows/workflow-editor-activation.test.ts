import { describe, expect, test } from "bun:test";
import type { WorkflowBoundPlan } from "@valentinkolb/cloud/workflows";
import { automaticTriggerSummary, shouldConfirmAutomaticTriggers } from "./workflow-editor-activation";

const plan = (triggers: WorkflowBoundPlan["triggers"]): WorkflowBoundPlan =>
  ({
    schemaVersion: 2,
    languageId: "grids",
    languageVersion: 1,
    sourceHash: "source",
    manifestHash: "manifest",
    catalogHash: "catalog",
    actionPolicies: {},
    inputs: [],
    triggers,
    steps: [],
    bindings: {},
  }) as WorkflowBoundPlan;

const schedule = (cron = "0 8 * * *"): WorkflowBoundPlan["triggers"][number] =>
  ({
    kind: "schedule",
    config: { cron, timezone: "Europe/Berlin" },
    with: {},
  }) as WorkflowBoundPlan["triggers"][number];

describe("workflow automatic trigger activation", () => {
  test("summarizes schedules and record events for the confirmation dialog", () => {
    expect(
      automaticTriggerSummary(
        plan([
          schedule(),
          {
            kind: "recordEvent",
            config: { event: "updated", table: "Loans" },
            with: {},
          } as WorkflowBoundPlan["triggers"][number],
        ]),
      ),
    ).toBe("Schedule 0 8 * * * (Europe/Berlin)\nRecord updated in Loans");
    expect(automaticTriggerSummary(plan([schedule()]), "de-CH")).toBe("Zeitplan 0 8 * * * (Europe/Berlin)");
  });

  test("confirms the first activation and newly added automatic triggers", () => {
    const noTriggers = plan([]);
    const scheduled = plan([schedule()]);

    expect(shouldConfirmAutomaticTriggers(undefined, scheduled, true)).toBe(true);
    expect(shouldConfirmAutomaticTriggers({ enabled: true, plan: noTriggers }, scheduled, true)).toBe(true);
  });

  test("does not confirm unchanged, removed, or disabled automatic triggers", () => {
    const scheduled = plan([schedule()]);

    expect(shouldConfirmAutomaticTriggers({ enabled: true, plan: scheduled }, scheduled, true)).toBe(false);
    expect(shouldConfirmAutomaticTriggers({ enabled: true, plan: scheduled }, plan([]), true)).toBe(false);
    expect(shouldConfirmAutomaticTriggers({ enabled: false, plan: plan([]) }, scheduled, false)).toBe(false);
  });
});
