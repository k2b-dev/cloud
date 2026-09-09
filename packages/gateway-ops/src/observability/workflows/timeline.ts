import type { WorkflowRunState } from "@k2b/cloud/workflows";
import type { WorkflowRunSummary } from "@k2b/cloud/workflows/store";

export const WORKFLOW_TIMELINE_LANES = 12;
const RUNS_PER_LANE = 300;
const MIN_MARK_FRACTION = 0.0025;
const ACTIVE_STATES = new Set<WorkflowRunState>(["queued", "running", "waiting"]);

export type WorkflowTimelineInterval = {
  from: number;
  to: number;
  state: WorkflowRunState;
  run: WorkflowRunSummary;
};

export type WorkflowTimelineRow = {
  workflowId: string;
  appId: string;
  scopeId: string;
  label: string;
  intervals: WorkflowTimelineInterval[];
};

/**
 * Groups bounded, server-selected runs into workflow lanes.
 *
 * Completed runs use their real execution interval. Queued and in-flight runs
 * extend to "now", making backlog age visible. A small width floor keeps
 * millisecond runs clickable without pretending that they lasted longer.
 */
export const buildWorkflowTimelineRows = (runs: WorkflowRunSummary[], window: { fromMs: number; toMs: number }): WorkflowTimelineRow[] => {
  const windowMs = Math.max(1, window.toMs - window.fromMs);
  const minMarkMs = windowMs * MIN_MARK_FRACTION;
  const byWorkflow = new Map<string, WorkflowTimelineRow>();

  for (const run of runs) {
    const startedAt = (run.startedAt ?? run.createdAt).getTime();
    if (!Number.isFinite(startedAt) || startedAt > window.toMs) continue;

    const key = `${run.appId}:${run.workflowId}`;
    const row = byWorkflow.get(key) ?? {
      workflowId: run.workflowId,
      appId: run.appId,
      scopeId: run.scopeId,
      label: run.workflowName,
      intervals: [],
    };
    if (row.intervals.length >= RUNS_PER_LANE) continue;

    const from = Math.max(window.fromMs, startedAt);
    const finishedAt = run.finishedAt?.getTime();
    const naturalTo = ACTIVE_STATES.has(run.state)
      ? window.toMs
      : finishedAt !== undefined && Number.isFinite(finishedAt)
        ? finishedAt
        : startedAt;
    const to = Math.min(window.toMs, Math.max(from + minMarkMs, naturalTo));
    row.intervals.push({ from, to, state: run.state, run });
    byWorkflow.set(key, row);
  }

  return [...byWorkflow.values()]
    .sort((left, right) => right.intervals.length - left.intervals.length || left.label.localeCompare(right.label))
    .slice(0, WORKFLOW_TIMELINE_LANES);
};
