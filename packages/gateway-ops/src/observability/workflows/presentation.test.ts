import { describe, expect, test } from "bun:test";
import type { UndispatchedWorkflowEvent, WorkflowStepSummary } from "@k2b/cloud/workflows/store";
import { eventState, runErrorSummary, stepDetail } from "./presentation";

const step = (values: Partial<WorkflowStepSummary>): WorkflowStepSummary => ({
  stepKey: "steps.0",
  sourcePath: ["steps", 0],
  iterationPath: [],
  kind: "action",
  action: "mail.send",
  state: "waiting",
  attempt: 0,
  outcome: null,
  effectKey: null,
  effectState: null,
  effectStartedAt: null,
  dependency: null,
  startedAt: new Date("2026-01-01T00:00:00.000Z"),
  finishedAt: null,
  durationMs: null,
  ...values,
});

const event = (values: Partial<UndispatchedWorkflowEvent>): UndispatchedWorkflowEvent => ({
  id: "5de41b38-a3ac-47f3-b47c-da6472afbb42",
  appId: "mail",
  scopeId: "mailbox-1",
  type: "mail.received",
  occurredAt: new Date("2026-01-01T00:00:00.000Z"),
  attempts: 0,
  matchedCount: 1,
  lastError: null,
  dispatchFailedAt: null,
  ...values,
});

describe("workflow operator presentation", () => {
  test("explains waiting dependencies and nested failure messages", () => {
    expect(stepDetail(step({ dependency: { kind: "approval", key: "request-7" } }))).toBe("Waiting on approval: request-7");
    expect(stepDetail(step({ outcome: { mode: "execute", outcome: { state: "failed", message: "Provider refused" } } }))).toBe(
      "Provider refused",
    );
  });

  test("separates unmatched, retrying and dead-lettered events", () => {
    expect(eventState(event({ matchedCount: 0 }))).toEqual({ label: "No activation", tone: "warning" });
    expect(eventState(event({ attempts: 2 }))).toEqual({ label: "Retrying", tone: "degraded" });
    expect(eventState(event({ dispatchFailedAt: new Date("2026-01-01T01:00:00.000Z") }))).toEqual({
      label: "Dead letter",
      tone: "error",
    });
  });

  test("summarizes structured and plain run errors without assuming their shape", () => {
    expect(runErrorSummary({ code: "WORKFLOW_FAILED", message: "Provider refused", retryable: false })).toEqual({
      code: "WORKFLOW_FAILED",
      message: "Provider refused",
      retryable: false,
    });
    expect(runErrorSummary("Worker exited")).toEqual({ code: null, message: "Worker exited", retryable: null });
    expect(runErrorSummary(7)).toBeNull();
  });
});
