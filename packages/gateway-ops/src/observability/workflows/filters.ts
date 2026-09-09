/**
 * URL state for the workflows page.
 *
 * Filtering and paging are server concerns, so they live in the address bar:
 * the page is reloadable and shareable, and an operator can send a colleague
 * the exact view that shows the problem.
 */
import { createUrlFilter, oneOf, page, text, type UrlFilterField } from "@k2b/cloud/ssr/url-filter";
import { z } from "zod";

export const WORKFLOWS_BASE_PATH = "/admin/observability/workflows";

export const RUN_STATES = ["all", "queued", "running", "waiting", "succeeded", "failed", "canceled", "needs_attention"] as const;
export type RunStateFilter = (typeof RUN_STATES)[number];

export const WINDOWS = ["1h", "24h", "7d", "30d"] as const;
export type WindowFilter = (typeof WINDOWS)[number];

const WORKFLOW_VIEWS = ["runs", "effects", "events"] as const;
export type WorkflowView = (typeof WORKFLOW_VIEWS)[number];

const WINDOW_MS: Record<WindowFilter, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const uuid = (param: string): UrlFilterField<string> => ({
  param,
  fallback: "",
  parse: (raw) => {
    const parsed = z.string().uuid().safeParse(raw);
    return parsed.success ? parsed.data : "";
  },
});

export const windowStart = (window: WindowFilter): Date => new Date(Date.now() - WINDOW_MS[window]);

export const workflowsFilter = createUrlFilter(WORKFLOWS_BASE_PATH, {
  view: oneOf<WorkflowView>("view", WORKFLOW_VIEWS, "runs"),
  app: text("app"),
  state: oneOf<RunStateFilter>("state", RUN_STATES, "all"),
  mode: oneOf("mode", ["all", "execute", "dryRun"] as const, "all"),
  window: oneOf<WindowFilter>("window", WINDOWS, "24h"),
  /** Narrows the overview to one workflow definition and reveals its runs. */
  workflow: uuid("workflow"),
  /** Opens the detail view for one run, keeping the list's filters behind it. */
  run: uuid("run"),
  /** Lists only direct children of the selected fan-out parent. */
  parent: uuid("parent"),
  page: page(),
});

export type WorkflowsFilterState = ReturnType<typeof workflowsFilter.parse>;

export const RUNS_PER_PAGE = 50;
export const FINDINGS_PER_PAGE = 50;
