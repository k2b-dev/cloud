import type { StatusTone } from "@k2b/ui";
import type { PublicWorkflowRun, PublicWorkflowStepRun } from "../workspace/workspace-public-state-model";

export const channelLabels: Record<PublicWorkflowRun["channel"], string> = {
  api: "API",
  customApp: "App",
  scanner: "Scanner",
  bulk: "Bulk",
  record: "Record action",
  schedule: "Schedule",
  recordEvent: "Record event",
};

export const workflowRunStatusTone = (status: PublicWorkflowRun["status"] | string): StatusTone =>
  status === "succeeded"
    ? "ok"
    : status === "failed" || status === "canceled" || status === "needs_attention"
      ? "error"
      : status === "running"
        ? "running"
        : "neutral";

/**
 * The same badge vocabulary for a step, whose states are the kernel's.
 *
 * A step that ran ends "completed" and one that was only planned ends
 * "planned"; neither is "succeeded", which is a run's word. Reusing the run's
 * mapping here rendered every finished step in the neutral "still going" badge.
 */
export const workflowStepStatusTone = (status: PublicWorkflowStepRun["status"] | string): StatusTone =>
  status === "completed" || status === "planned" || status === "terminal"
    ? "ok"
    : status === "failed" || status === "canceled" || status === "needs_attention" || status === "unsupported"
      ? "error"
      : status === "running"
        ? "running"
        : "neutral";

/**
 * The same step vocabulary as bare text colour, for the places that render the
 * status as a word rather than a badge. Kept next to the badge mapping so the
 * two cannot drift on which states count as finished.
 */
export const workflowStepStatusTextClass = (status: PublicWorkflowStepRun["status"] | string) =>
  status === "completed" || status === "planned" || status === "terminal"
    ? "text-emerald-700 dark:text-emerald-300"
    : status === "failed" || status === "canceled" || status === "needs_attention" || status === "unsupported"
      ? "text-red-700 dark:text-red-300"
      : "text-blue-700 dark:text-blue-300";

export const isTerminalWorkflowRunStatus = (status: PublicWorkflowRun["status"]): boolean =>
  status === "succeeded" || status === "failed" || status === "canceled" || status === "needs_attention";

export const formatWorkflowRunDate = (value: string | null) => (value ? new Date(value).toLocaleString() : "-");

export const formatWorkflowRunDuration = (run: Pick<PublicWorkflowRun, "startedAt" | "finishedAt">): string => {
  if (!run.startedAt || !run.finishedAt) return "-";
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
};

export const workflowStepErrorMessage = (outcome: unknown): string | null => {
  if (!outcome || typeof outcome !== "object" || !("error" in outcome)) return null;
  const error = (outcome as { error?: unknown }).error;
  if (typeof error === "string") return error.trim() || "Step failed";
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Step failed";
};

type JsonRecord = Record<string, unknown>;

const objectValue = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;

// A dry run that cannot evaluate a branch condition plans BOTH branches and
// records why on the control step's `issues`. Those steps persist as "planned",
// so without this the panel shows mutually exclusive branches as green with no
// hint that only one of them can actually run.
export const workflowStepIssueReason = (outcome: unknown): string | null => {
  const value = objectValue(outcome);
  if (!value || !Array.isArray(value.issues)) return null;
  const issues = value.issues.map(objectValue).filter((issue): issue is JsonRecord => issue !== null);
  const issue = issues.find((candidate) => candidate.state === "indeterminate") ?? issues[0];
  if (!issue) return null;
  if (typeof issue.reason === "string" && issue.reason.trim()) return issue.reason;
  return typeof issue.state === "string" ? String(issue.state).replaceAll("_", " ") : null;
};

export const workflowStepOutcomeSummary = (outcome: unknown): string | null => {
  const value = objectValue(outcome);
  if (!value || typeof value.state !== "string") return null;
  const stateSummary = workflowStateSummary(value);
  if (stateSummary) return stateSummary;
  const issueReason = workflowStepIssueReason(value);
  const control = objectValue(value.control);
  const controlSummary =
    control && typeof control.kind === "string" && Array.isArray(control.branches)
      ? `${control.kind}: ${control.branches.map(String).join(", ")}`
      : null;
  if (issueReason) return controlSummary ? `${controlSummary} — ${issueReason}` : issueReason;
  return controlSummary;
};

const workflowStateSummary = (value: JsonRecord): string | null => {
  if (value.state === "unsupported" || value.state === "indeterminate") {
    return typeof value.reason === "string" ? value.reason : String(value.state).replaceAll("_", " ");
  }
  if (value.state !== "waiting") return null;
  const dependency = objectValue(value.dependency);
  return dependency && typeof dependency.kind === "string" ? `Waiting for ${dependency.kind}` : "Waiting";
};

type WorkflowPlannedEffect = { title: string; detail: string | null };

/**
 * What a dry run says a step would do.
 *
 * The description comes from the action itself now — the same `plan` hook the
 * budget is charged from — rather than from a per-action formatter here that
 * had to be kept in step with what each action happened to report. What is left
 * is presentation: a readable name, and the counts against the run's allowance.
 */
const plannedEffectCounts = (consumes: unknown): string | null => {
  const counts = objectValue(consumes);
  if (!counts) return null;
  const parts = Object.entries(counts)
    .filter(([, amount]) => typeof amount === "number" && amount > 0)
    .map(([dimension, amount]) => `${amount} ${dimension}`);
  return parts.length > 0 ? parts.join(" · ") : null;
};

const plannedEffectTitle = (action: unknown): string => {
  if (typeof action !== "string" || !action) return "Workflow effect";
  if (action === "httpRequest") return "HTTP request";
  const words = action.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

export const workflowStepPlannedEffects = (outcome: unknown): WorkflowPlannedEffect[] => {
  const value = objectValue(outcome);
  if (!value || !Array.isArray(value.effects)) return [];
  return value.effects.map((effect) => {
    const item = objectValue(effect);
    if (!item) {
      return {
        title: typeof effect === "string" && effect.trim() ? effect : "Planned effect",
        detail: null,
      };
    }
    const summary = typeof item.summary === "string" && item.summary.trim() ? item.summary : null;
    const counts = plannedEffectCounts(item.consumes);
    return {
      title: plannedEffectTitle(item.action),
      detail: [summary, counts].filter(Boolean).join(" · ") || null,
    };
  });
};
