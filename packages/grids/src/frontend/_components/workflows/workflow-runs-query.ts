/**
 * The runs of a workflow as one declaration: filtered by status and by channel, one value each. The parameter names
 * stay the page's own (`status`, `channel`), so links from before v2 open the same runs; `window` (the span of the key
 * figures) and `run` (the open run) stay the page's too. The runs come newest first; their order has no choice.
 */
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import type { PublicWorkflowRun } from "../workspace/workspace-public-state-model";
import { workflowMessages } from "./messages";
import { workflowChannelLabel } from "./workflow-display";
import type { WorkflowUrlState } from "./workflow-url-state";

const STATUSES = ["queued", "running", "waiting", "succeeded", "failed", "needs_attention", "canceled"] as const;
const CHANNELS: PublicWorkflowRun["channel"][] = ["api", "customApp", "scanner", "bulk", "record", "schedule", "recordEvent"];

export const workflowRunsQuery = (locale: string) => {
  const { t } = workflowMessages.resolve([locale]);
  const statusLabel = {
    queued: t.queued,
    running: t.running,
    waiting: t.waitingStatus,
    succeeded: t.succeeded,
    failed: t.failed,
    needs_attention: t.needsAttention,
    canceled: t.canceled,
  };
  return defineListQuery({
    key: "grids.workflow-runs",
    fields: {
      status: field.choice({
        label: t.status,
        common: true,
        multiple: false,
        options: STATUSES.map((value) => ({ value, label: statusLabel[value] })),
      }),
      channel: field.choice({
        label: t.channel,
        common: true,
        multiple: false,
        options: CHANNELS.map((value) => ({ value, label: workflowChannelLabel(value, locale) })),
      }),
    },
    sort: { fixed: { field: "started", direction: "desc", label: t.newestFirst } },
    pageParams: ["window", "run"],
  });
};

export type WorkflowRunsQuery = ReturnType<typeof workflowRunsQuery>;
export type WorkflowRunsListState = ListQueryStateOf<WorkflowRunsQuery>;

/** The page's filters as the declaration's state: "all" is no statement. */
export const runsListState = (query: WorkflowRunsQuery, state: WorkflowUrlState): WorkflowRunsListState => {
  let next = query.reset();
  if (state.status !== "all") next = query.set(next, "status", state.status) ?? next;
  if (state.channel !== "all") next = query.set(next, "channel", state.channel) ?? next;
  return next;
};

/** A new list state on the page's filters; the window stays. */
export const urlStateOf = (next: WorkflowRunsListState, before: WorkflowUrlState): WorkflowUrlState => ({
  ...before,
  status: next.filters.status ?? "all",
  channel: next.filters.channel ?? "all",
});
