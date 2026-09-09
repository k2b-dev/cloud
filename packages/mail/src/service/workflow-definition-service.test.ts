import { describe, expect, test } from "bun:test";
import type { WorkflowBoundPlan } from "@k2b/cloud/workflows";
import { workflowActivationError, workflowTriggerRegistrations } from "./workflow-definition-service";

const plan: WorkflowBoundPlan = {
  schemaVersion: 2,
  languageId: "mail",
  languageVersion: 1,
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  catalogHash: "c".repeat(64),
  actionPolicies: {},
  inputs: [],
  triggers: [
    {
      kind: "messageReceived",
      config: {},
      with: { message: "${{ trigger.message }}", conversation: "${{ trigger.conversation }}" },
    },
    { kind: "schedule", config: { cron: "0 8 * * *", timezone: "Europe/Berlin" }, with: {} },
  ],
  steps: [],
  bindings: {},
};

describe("Mail workflow activation registrations", () => {
  test("derives keys and configs exclusively from the bound plan", () => {
    expect(workflowTriggerRegistrations(plan)).toEqual([
      {
        key: "messageReceived:0",
        eventType: "mail.messageReceived",
        config: { with: { message: "${{ trigger.message }}", conversation: "${{ trigger.conversation }}" } },
        enabled: true,
      },
      {
        key: "schedule:1",
        eventType: "mail.schedule",
        config: { cron: "0 8 * * *", timezone: "Europe/Berlin", with: {} },
        enabled: true,
      },
    ]);
  });

  test("rejects activation when no automatic trigger can create a run", () => {
    expect(workflowActivationError({ ...plan, triggers: [] })).toBe("An active workflow needs at least one trigger");
    expect(workflowActivationError(plan)).toBeNull();
  });
});
