import type { StatusTone } from "@k2b/ui";
import type { WorkflowRunState } from "@k2b/cloud/workflows";
import type { UndispatchedWorkflowEvent, WorkflowStepSummary } from "@k2b/cloud/workflows/store";

export const RUN_TONE: Record<WorkflowRunState, StatusTone> = {
  queued: "neutral",
  running: "running",
  waiting: "degraded",
  succeeded: "ok",
  failed: "error",
  canceled: "neutral",
  needs_attention: "warning",
};

export const RUN_LABEL: Record<WorkflowRunState, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  succeeded: "Succeeded",
  failed: "Failed",
  canceled: "Canceled",
  needs_attention: "Needs attention",
};

export const STEP_TONE: Record<string, StatusTone> = {
  running: "running",
  waiting: "degraded",
  completed: "ok",
  planned: "ok",
  terminal: "ok",
  failed: "error",
  needs_attention: "warning",
  unsupported: "warning",
  indeterminate: "warning",
  canceled: "neutral",
};

export const EFFECT_TONE: Record<string, StatusTone> = {
  executing: "running",
  ambiguous: "warning",
  succeeded: "ok",
  failed: "error",
};

export const LAG_WARN_MS = 5 * 60 * 1000;

const readRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const readString = (value: unknown, key: string): string | null => {
  const field = readRecord(value)?.[key];
  return typeof field === "string" ? field : null;
};

export const runErrorSummary = (error: unknown): { message: string; code: string | null; retryable: boolean | null } | null => {
  if (typeof error === "string") return { message: error, code: null, retryable: null };
  const record = readRecord(error);
  if (!record) return null;
  const message = typeof record.message === "string" ? record.message : null;
  const code = typeof record.code === "string" ? record.code : null;
  const retryable = typeof record.retryable === "boolean" ? record.retryable : null;
  if (!message && !code) return null;
  return { message: message ?? code ?? "Workflow failed", code, retryable };
};

export const stepDetail = (step: WorkflowStepSummary, waitingOn = "Waiting on"): string => {
  const dependency = readRecord(step.dependency);
  if (dependency) {
    const kind = readString(dependency, "kind") ?? "dependency";
    const key = readString(dependency, "key");
    return key ? `${waitingOn} ${kind}: ${key}` : `${waitingOn} ${kind}`;
  }

  const outcome = readRecord(step.outcome);
  const inner = readRecord(outcome?.outcome);
  return (
    readString(inner, "message") ??
    readString(inner?.error, "message") ??
    readString(inner, "reason") ??
    readString(inner, "state") ??
    readString(outcome, "state") ??
    "—"
  );
};

export const eventState = (event: UndispatchedWorkflowEvent): { label: string; tone: StatusTone } => {
  if (event.matchedCount === 0) return { label: "No activation", tone: "warning" };
  if (event.dispatchFailedAt) return { label: "Dead letter", tone: "error" };
  return { label: "Retrying", tone: "degraded" };
};
