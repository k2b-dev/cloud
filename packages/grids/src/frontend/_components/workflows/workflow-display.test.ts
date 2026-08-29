import { describe, expect, test } from "bun:test";
import {
  isTerminalWorkflowRunStatus,
  workflowRunStatusLabel,
  workflowRunStatusTone,
  workflowStepErrorMessage,
  workflowStepIssueReason,
  workflowStepOutcomeSummary,
  workflowStepPlannedEffects,
  workflowStepStatusLabel,
  workflowStepStatusTone,
} from "./workflow-display";

describe("status badges", () => {
  test("a step that finished reads as finished, in the vocabulary steps actually use", () => {
    // A run succeeds; a step completes. Reusing the run's mapping for steps
    // rendered every finished step in the neutral "still going" badge, because
    // no step is ever "succeeded".
    expect(workflowStepStatusTone("completed")).toBe("ok");
    expect(workflowStepStatusTone("planned")).toBe("ok");
    expect(workflowStepStatusTone("running")).toBe("running");
    expect(workflowStepStatusTone("failed")).toBe("error");
    expect(workflowStepStatusTone("unsupported")).toBe("error");
    expect(workflowRunStatusTone("succeeded")).toBe("ok");
  });

  test("localizes known states for regional German locales and preserves unknown state codes", () => {
    expect(workflowRunStatusLabel("needs_attention", "de-CH")).toBe("Prüfung erforderlich");
    expect(workflowStepStatusLabel("completed", "de-CH")).toBe("Abgeschlossen");
    expect(workflowRunStatusLabel("future_state", "de-CH")).toBe("future_state");
  });
});

describe("isTerminalWorkflowRunStatus", () => {
  test("distinguishes active and terminal runs", () => {
    expect(isTerminalWorkflowRunStatus("running")).toBeFalse();
    expect(isTerminalWorkflowRunStatus("waiting")).toBeFalse();
    expect(isTerminalWorkflowRunStatus("succeeded")).toBeTrue();
    expect(isTerminalWorkflowRunStatus("failed")).toBeTrue();
  });
});

describe("workflowStepErrorMessage", () => {
  test("reads structured workflow errors", () => {
    expect(
      workflowStepErrorMessage({
        error: {
          code: "WORKFLOW_FAILED",
          message: "Approve this loan before sending its agreement.",
          retryable: false,
        },
        state: "failed",
      }),
    ).toBe("Approve this loan before sending its agreement.");
  });

  test("preserves string errors", () => {
    expect(workflowStepErrorMessage({ error: "Request timed out" })).toBe("Request timed out");
  });

  test("uses a readable fallback for unknown error shapes", () => {
    expect(workflowStepErrorMessage({ error: { code: "UNKNOWN" } })).toBe("Step failed");
    expect(workflowStepErrorMessage({ state: "succeeded" })).toBeNull();
  });
});

describe("workflow step outcomes", () => {
  test("describes waiting dependencies and selected control-flow branches", () => {
    expect(workflowStepOutcomeSummary({ state: "waiting", dependency: { kind: "approval", key: "loan-42" } })).toBe("Waiting for approval");
    expect(workflowStepOutcomeSummary({ state: "completed", control: { kind: "if", branches: ["then"] } })).toBe("if: then");
  });

  test("surfaces why a planned branch could not be evaluated", () => {
    // Both branches are planned when the condition is indeterminate, and the
    // step still persists as "succeeded" — the reason is the only signal.
    const outcome = {
      state: "planned",
      control: { kind: "if", branches: ["then", "else"] },
      issues: [{ state: "indeterminate", reason: "Condition depends on a value only available at run time." }],
    };
    expect(workflowStepIssueReason(outcome)).toBe("Condition depends on a value only available at run time.");
    expect(workflowStepOutcomeSummary(outcome)).toBe("if: then, else — Condition depends on a value only available at run time.");
    expect(workflowStepIssueReason({ state: "planned", control: { kind: "if", branches: ["then"] } })).toBeNull();
  });

  test("shows what a step said it would do, and what it would spend", () => {
    // The description is the action's own — the same `plan` hook the effect
    // budget is charged from — so the dry-run view and the run cannot disagree
    // about what a step costs.
    expect(
      workflowStepPlannedEffects({
        effects: [
          { action: "updateRecord", summary: "Update 1 field(s) on one record" },
          { action: "sendEmail", summary: 'Send "Ready notice" to 2 recipient(s)', consumes: { emails: 2 } },
          { action: "httpRequest", summary: "POST api.example.test", consumes: { httpRequests: 1 } },
        ],
      }),
    ).toEqual([
      { title: "Update record", detail: "Update 1 field(s) on one record" },
      { title: "Send email", detail: 'Send "Ready notice" to 2 recipient(s) · 2 emails' },
      { title: "HTTP request", detail: "POST api.example.test · 1 httpRequests" },
    ]);
  });

  test("never stringifies malformed effects as object placeholders", () => {
    expect(workflowStepPlannedEffects({ effects: [{ nested: true }, null] })).toEqual([
      { title: "Workflow effect", detail: null },
      { title: "Planned effect", detail: null },
    ]);
  });
});
