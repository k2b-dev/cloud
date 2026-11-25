/**
 * The workflows console's declarations. Runs filter by window, app, state and mode; the finding queues (effects,
 * events) by app only. `view` names the queue (`runs` by default), `workflow`, `parent`, `run` and `page` are page
 * parameters. The SSR page reads the address only through these; the store filters.
 */

import type { WorkflowRunState } from "@k2b/cloud/workflows";
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { gatewayOpsMessages } from "../../messages";
import { WINDOWS, type WindowFilter, WORKFLOWS_BASE_PATH } from "./filters";

export const WORKFLOW_PAGE_PARAMS = ["workflow", "run", "parent", "page"] as const;

const appOptions = (apps: readonly string[], selected: string | undefined) =>
  [...new Set([...apps, ...(selected ? [selected] : [])])]
    .filter((app) => app !== "" && !app.includes(","))
    .sort()
    .map((app) => ({ value: app, label: app }));

export const runsQuery = (locale: string, apps: readonly string[], selected?: string) => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  const windowLabel: Record<WindowFilter, string> = {
    "1h": t.lastHour,
    "24h": t.lastHours({ count: 24 }),
    "7d": t.lastDays({ count: 7 }),
    "30d": t.lastDays({ count: 30 }),
  };
  return defineListQuery({
    key: "gateway-ops.workflows",
    fields: {
      window: field.timeRange({
        label: t.timeRange,
        common: true,
        custom: false,
        presets: WINDOWS.map((value) => ({ value, label: windowLabel[value] })),
        required: { kind: "preset", preset: "24h" },
      }),
      app: field.choice({ label: t.app, common: true, multiple: false, options: appOptions(apps, selected) }),
      state: field.choice({
        label: t.state,
        common: true,
        multiple: false,
        options: [
          { value: "failed", label: t.failed },
          { value: "needs_attention", label: t.needsAttentionLabel },
          { value: "waiting", label: t.waiting },
          { value: "running", label: t.running },
          { value: "queued", label: t.queued },
          { value: "succeeded", label: t.succeeded },
          { value: "canceled", label: t.canceled },
        ],
      }),
      mode: field.choice({
        label: t.mode,
        multiple: false,
        options: [
          { value: "execute", label: t.execute },
          { value: "dryRun", label: t.dryRun },
        ],
      }),
    },
    sort: { fixed: { field: "latest", direction: "desc", label: t.newestFirst } },
    pageParams: [...WORKFLOW_PAGE_PARAMS],
  });
};
export type RunsQuery = ReturnType<typeof runsQuery>;
export type RunsState = ListQueryStateOf<RunsQuery>;

export const findingsQuery = (locale: string, apps: readonly string[], selected?: string) => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  return defineListQuery({
    key: "gateway-ops.workflows.findings",
    fields: { app: field.choice({ label: t.app, common: true, multiple: false, options: appOptions(apps, selected) }) },
    sort: { fixed: { field: "age", direction: "desc", label: t.oldestFirst } },
    pageParams: [...WORKFLOW_PAGE_PARAMS, "window"],
  });
};
export type FindingsQuery = ReturnType<typeof findingsQuery>;
export type FindingsState = ListQueryStateOf<FindingsQuery>;

/** The address of a state with page parameters; an empty value drops the parameter. */
export const workflowsHref = (params: URLSearchParams, extra: Partial<Record<(typeof WORKFLOW_PAGE_PARAMS)[number], string>> = {}) => {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(extra)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return `${WORKFLOWS_BASE_PATH}${next.size ? `?${next}` : ""}`;
};

/** Addresses from before v2 named "all" for no state or mode filter; they lead to the same list. */
export const legacyWorkflowsHref = (params: URLSearchParams): string | null => {
  if (params.get("state") !== "all" && params.get("mode") !== "all" && params.get("view") !== "runs" && params.get("page") !== "1")
    return null;
  const next = new URLSearchParams(params);
  if (next.get("state") === "all") next.delete("state");
  if (next.get("mode") === "all") next.delete("mode");
  if (next.get("view") === "runs") next.delete("view");
  if (next.get("page") === "1") next.delete("page");
  return `${WORKFLOWS_BASE_PATH}${next.size ? `?${next}` : ""}`;
};

/** Läufe (lane C, `/admin/observability/runs`) lists workflow runs; its status words for the workflow run states. */
const RUNS_STATUS: Record<WorkflowRunState, string> = {
  failed: "failed",
  needs_attention: "failed",
  running: "running",
  queued: "waiting",
  waiting: "waiting",
  canceled: "canceled",
  succeeded: "succeeded",
};

/** The workflow runs in Läufe, of one app and in one state when given. This page keeps definitions and findings. */
export const workflowRunsHref = (filter: { app?: string; state?: WorkflowRunState } = {}) => {
  const params = new URLSearchParams({ kind: "workflow" });
  if (filter.app) params.set("app", filter.app);
  if (filter.state) params.set("status", RUNS_STATUS[filter.state]);
  return `/admin/observability/runs?${params}`;
};
