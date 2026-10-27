import { afterAll, expect, test } from "bun:test";
import type { WorkflowBoundPlan } from "@k2b/cloud/workflows";
import { createWorkflow, createWorkflowRun, deleteWorkflowScope, publishWorkflowVersion } from "@k2b/cloud/workflows/store";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailWorkflowAiScope } from "./workflow-ai";

// An isolated workflow scope, removed through the public scope contract when the module finishes.
const scopeId = `workflow-test-${crypto.randomUUID()}`;
afterAll(() => deleteWorkflowScope({ appId: "mail", scopeId }));

suiteFor("database", "nats")("Mail inference source scope", () => {
  test("scheduled and manual runs without a message retain mailbox admission with a run source", async () => {
    const workflow = await createWorkflow({
      appId: "mail",
      scopeId,
      key: "scheduled-ai",
      name: "Scheduled inference",
      author: { kind: "system" },
    });
    const plan: WorkflowBoundPlan = {
      schemaVersion: 2,
      languageId: "mail",
      languageVersion: 1,
      sourceHash: "a".repeat(64),
      manifestHash: "b".repeat(64),
      catalogHash: "c".repeat(64),
      actionPolicies: {},
      inputs: [],
      triggers: [],
      steps: [],
      bindings: {},
    };
    const version = await publishWorkflowVersion({
      workflowId: workflow.id,
      activations: [],
      source: "steps: []",
      plan,
      author: { kind: "system" },
    });
    const runId = await createWorkflowRun({
      appId: "mail",
      scopeId,
      workflowId: workflow.id,
      workflowVersionId: version.id,
      mode: "execute",
      authorization: {},
      idempotencyKey: "scheduled-ai",
      occurredAt: new Date("2026-10-26T00:00:00Z"),
    });
    const scope = await mailWorkflowAiScope({
      runId,
      invocation: {
        workflowId: workflow.id,
        mode: "execute",
        channel: "schedule",
        actor: {},
        inputs: {},
        idempotencyKey: "scheduled-ai",
        occurredAt: "2026-10-26T00:00:00Z",
      },
    });
    expect(scope).toMatchObject({
      sourceId: `run:${runId}`,
      sourceRevision: runId,
      budget: { maxStepsPerSource: 2, scopeConcurrent: 1, globalConcurrent: 4 },
    });
  });
});
