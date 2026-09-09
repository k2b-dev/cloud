/**
 * Cross-app workflow operator console.
 *
 * The page stays SSR-first and URL-backed: operators can share the exact run,
 * finding queue, filter and page they are looking at. Mutations are limited to
 * the two interventions the kernel can perform safely — cancellation and an
 * explicit decision about an ambiguous external effect.
 */

import { ButtonLink, IconButtonLink, NoticeCard, Pagination, Placeholder, RangePicker, StatCell, StatGrid, useLocale } from "@k2b/ui";
import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { formatDateTime, formatDurationMs, formatNumber } from "@k2b/cloud/shared";
import { AdminLayout } from "@k2b/cloud/ssr";
import {
  getWorkflow,
  getWorkflowRun,
  listStrandedWorkflowEffects,
  listUndispatchedWorkflowEvents,
  listWorkflowFamilies,
  listWorkflowRuns,
  listWorkflowRunTimeline,
  type WorkflowAppHealth,
  workflowHealth,
} from "@k2b/cloud/workflows/store";
import type { JSX } from "solid-js";
import { ssr } from "../../config";
import ObservabilityChart from "../../frontend/ObservabilityChart.island";
import { WorkflowEffectsView, WorkflowEventsView, WorkflowFamiliesView, WorkflowRunsView } from "./_components/WorkflowQueues";
import WorkflowRunDetailView from "./_components/WorkflowRunDetail";
import WorkflowsFilterBar from "./_components/WorkflowsFilterBar.island";
import { FINDINGS_PER_PAGE, RUN_STATES, RUNS_PER_PAGE, type WorkflowView, windowStart, workflowsFilter } from "./filters";
import { LAG_WARN_MS } from "./presentation";
import { buildWorkflowTimelineRows } from "./timeline";
import { gatewayOpsMessages } from "../../messages";

type WorkflowTotals = {
  runs: number;
  failed: number;
  attention: number;
  active: number;
  queued: number;
  stranded: number;
  undispatched: number;
  worstLagMs: number;
  oldestQueuedMs: number;
};

const totalsFor = (health: WorkflowAppHealth[]): WorkflowTotals =>
  health.reduce(
    (sum, entry) => ({
      runs: sum.runs + Object.values(entry.runs).reduce((count, value) => count + value, 0),
      failed: sum.failed + entry.runs.failed,
      attention: sum.attention + entry.runs.needs_attention,
      active: sum.active + entry.runs.running + entry.runs.queued + entry.runs.waiting,
      queued: sum.queued + entry.runs.queued,
      stranded: sum.stranded + entry.strandedEffects,
      undispatched: sum.undispatched + entry.undispatchedEvents,
      worstLagMs: Math.max(sum.worstLagMs, entry.worstStartLagMs ?? 0),
      oldestQueuedMs: Math.max(sum.oldestQueuedMs, entry.oldestQueuedMs ?? 0),
    }),
    { runs: 0, failed: 0, attention: 0, active: 0, queued: 0, stranded: 0, undispatched: 0, worstLagMs: 0, oldestQueuedMs: 0 },
  );

const WorkflowStats = (props: { totals: WorkflowTotals; window: string }) => {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  return <StatGrid columns={6}>
    <StatCell label={t.runs} value={formatNumber(props.totals.runs, { locale: locale() })} sub={t.lastWindow({ window: props.window })} />
    <StatCell
      label={t.inFlight}
      value={formatNumber(props.totals.active, { locale: locale() })}
      sub={
        props.totals.queued === 0
          ? t.runningOrWaiting
          : t.queuedOldest({ count: formatNumber(props.totals.queued, { locale: locale() }), duration: formatDurationMs(props.totals.oldestQueuedMs, { locale: locale() }) })
      }
      valueClass={props.totals.oldestQueuedMs > LAG_WARN_MS ? "text-amber-600 dark:text-amber-400" : undefined}
    />
    <StatCell
      label={t.failed}
      value={formatNumber(props.totals.failed, { locale: locale() })}
      valueClass={props.totals.failed > 0 ? "text-red-600 dark:text-red-400" : undefined}
    />
    <StatCell
      label={t.needsAttentionLabel}
      value={formatNumber(props.totals.attention, { locale: locale() })}
      sub={t.humanDecisionRequired}
      valueClass={props.totals.attention > 0 ? "text-amber-600 dark:text-amber-400" : undefined}
    />
    <StatCell
      label={t.worstStartLag}
      value={props.totals.worstLagMs > 0 ? formatDurationMs(props.totals.worstLagMs, { locale: locale() }) : "—"}
      sub={t.causeToFirstAttempt}
      valueClass={props.totals.worstLagMs > LAG_WARN_MS ? "text-amber-600 dark:text-amber-400" : undefined}
    />
    <StatCell
      label={t.openFindings}
      value={formatNumber(props.totals.stranded + props.totals.undispatched, { locale: locale() })}
      sub={t.findingsSummary({ effects: formatNumber(props.totals.stranded, { locale: locale() }), events: formatNumber(props.totals.undispatched, { locale: locale() }) })}
      valueClass={props.totals.stranded + props.totals.undispatched > 0 ? "text-amber-600 dark:text-amber-400" : undefined}
    />
  </StatGrid>;
};

const FindingNotices = (props: { totals: WorkflowTotals; effectsHref: string; eventsHref: string }) => {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  return <>
    {props.totals.stranded > 0 ? (
      <NoticeCard
        tone="warning"
        title={t.effectsRequireEvidence({ count: formatNumber(props.totals.stranded, { locale: locale() }) })}
        detail={
          <span>
            {t.effectReplayWarning}{" "}
            <a class="font-medium hover:underline" href={props.effectsHref}>
              {t.reviewEffectsQueue}
            </a>
            .
          </span>
        }
      />
    ) : null}
    {props.totals.undispatched > 0 ? (
      <NoticeCard
        tone="warning"
        title={t.eventsWithoutRun({ count: formatNumber(props.totals.undispatched, { locale: locale() }) })}
        detail={
          <span>
            {t.unmatchedEventsWarning}{" "}
            <a class="font-medium hover:underline" href={props.eventsHref}>
              {t.reviewEventsQueue}
            </a>
            .
          </span>
        }
      />
    ) : null}
  </>;
};

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const dateConfig = getDateConfig(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const state = workflowsFilter.parse(new URL(c.req.url));
  const since = windowStart(state.window);
  const offset = (state.page - 1) * (state.view === "runs" ? RUNS_PER_PAGE : FINDINGS_PER_PAGE);
  const showRunList = state.view === "runs" && Boolean(state.workflow || state.parent);
  const showFamilyOverview = state.view === "runs" && !showRunList;
  const runFilter = {
    appId: state.app || undefined,
    workflowId: state.workflow || undefined,
    state: state.state === "all" ? undefined : state.state,
    mode: state.mode === "all" ? undefined : state.mode,
    since,
  };

  const [detail, selectedWorkflow, health, familyRows, runRows, timelineResult, effectRows, eventRows] = await Promise.all([
    state.run ? getWorkflowRun(state.run) : Promise.resolve(null),
    state.workflow ? getWorkflow(state.workflow) : Promise.resolve(null),
    workflowHealth({ since }),
    !state.run && showFamilyOverview
      ? listWorkflowFamilies({
          ...runFilter,
          limit: RUNS_PER_PAGE + 1,
          offset,
        })
      : Promise.resolve([]),
    !state.run && showRunList
      ? listWorkflowRuns({
          ...runFilter,
          parentRunId: state.parent || undefined,
          limit: RUNS_PER_PAGE + 1,
          offset,
        })
      : Promise.resolve([]),
    !state.run && state.view === "runs" && !state.parent
      ? listWorkflowRunTimeline(runFilter, { limit: 2_000 })
      : Promise.resolve({ runs: [], total: 0 }),
    !state.run && state.view === "effects"
      ? listStrandedWorkflowEffects({
          appId: state.app || undefined,
          limit: FINDINGS_PER_PAGE + 1,
          offset,
        })
      : Promise.resolve([]),
    !state.run && state.view === "events"
      ? listUndispatchedWorkflowEvents({
          appId: state.app || undefined,
          limit: FINDINGS_PER_PAGE + 1,
          offset,
        })
      : Promise.resolve([]),
  ]);

  const pageSize = state.view === "runs" ? RUNS_PER_PAGE : FINDINGS_PER_PAGE;
  const rowsForView =
    state.view === "runs" ? (showFamilyOverview ? familyRows : runRows) : state.view === "effects" ? effectRows : eventRows;
  const hasNextPage = rowsForView.length > pageSize;
  const families = familyRows.slice(0, RUNS_PER_PAGE);
  const runs = runRows.slice(0, RUNS_PER_PAGE);
  const effects = effectRows.slice(0, FINDINGS_PER_PAGE);
  const events = eventRows.slice(0, FINDINGS_PER_PAGE);
  const apps = [...new Set(health.map((entry) => entry.appId))].sort();
  const totals = totalsFor(state.app ? health.filter((entry) => entry.appId === state.app) : health);
  const nowMs = Date.now();
  const timelineWindow = { fromMs: since.getTime(), toMs: nowMs };
  const runStateLabels = {
    queued: t.queued,
    running: t.running,
    waiting: t.waiting,
    succeeded: t.succeeded,
    failed: t.failed,
    needs_attention: t.needsAttentionLabel,
    canceled: t.canceled,
  } as const;
  const timelineRows = buildWorkflowTimelineRows(timelineResult.runs, timelineWindow).map((row) => ({
    label: row.label,
    href: workflowsFilter.build(state, { workflow: row.workflowId, run: "", parent: "", page: 1 }),
    tooltip: `${row.label} · ${row.appId}`,
    intervals: row.intervals.map(({ run, ...interval }) => {
      const activeMs = nowMs - (run.startedAt ?? run.createdAt).getTime();
      const timing =
        run.state === "queued"
          ? t.queuedDuration({ duration: formatDurationMs(nowMs - run.createdAt.getTime(), { locale }) })
          : run.durationMs !== null
            ? formatDurationMs(run.durationMs, { locale })
            : run.startedAt
              ? t.activeDuration({ duration: formatDurationMs(activeMs, { locale }) })
              : t.notStarted;
      return {
        ...interval,
        label: timing,
        href: workflowsFilter.build(state, {
          workflow: run.workflowId,
          run: run.id,
          parent: "",
          page: 1,
        }),
        tooltip: [
          run.workflowName,
          runStateLabels[run.state],
          run.eventType ?? t.directInvocation,
          formatDateTime(run.createdAt, dateConfig),
          timing,
          run.attempt === 0 ? t.notAttempted : t.attemptNumber({ count: run.attempt }),
        ].join(" · "),
      };
    }),
  }));

  const hrefFor = {
    app: Object.fromEntries([
      ["", workflowsFilter.build(state, { app: "", workflow: "", page: 1, run: "" })],
      ...apps.map((app) => [app, workflowsFilter.build(state, { app, workflow: "", page: 1, run: "" })] as const),
    ]),
    state: Object.fromEntries(
      RUN_STATES.map((value) => [value, workflowsFilter.build(state, { state: value, page: 1, run: "" })] as const),
    ),
    mode: Object.fromEntries(
      (["all", "execute", "dryRun"] as const).map(
        (value) => [value, workflowsFilter.build(state, { mode: value, page: 1, run: "" })] as const,
      ),
    ),
  };

  const viewOptions = (
    [
      ["runs", t.workflows],
      ["effects", `${t.effects}${totals.stranded ? ` (${formatNumber(totals.stranded, { locale })})` : ""}`],
      ["events", `${t.workflowEvents}${totals.undispatched ? ` (${formatNumber(totals.undispatched, { locale })})` : ""}`],
    ] as const
  ).map(([view, label]) => ({
    value: view,
    label,
    href: workflowsFilter.build(state, { view, workflow: "", run: "", parent: "", page: 1 }),
  }));

  const pagination = (view: WorkflowView): JSX.Element | undefined =>
    state.page > 1 || hasNextPage ? (
      <Pagination
        currentPage={state.page}
        totalPages={hasNextPage ? state.page + 1 : state.page}
        baseUrl={workflowsFilter.paginationBase({ ...state, view }, "page")}
      />
    ) : undefined;

  const filters = (showRunFilters: boolean) => (
    <WorkflowsFilterBar
      apps={apps}
      app={state.app}
      state={state.state}
      mode={state.mode}
      hrefFor={hrefFor}
      showRunFilters={showRunFilters}
    />
  );
  const allWorkflowsHref = workflowsFilter.build(state, { workflow: "", run: "", parent: "", page: 1 });
  const title = selectedWorkflow?.name ?? detail?.workflowName ?? t.workflows;

  return () => (
    <AdminLayout c={c} title={t.workflows}>
      <div class="app-rows">
        <div class="min-w-0" style="view-transition-name: admin-workflows-title">
          <div class="flex items-center gap-2">
            {state.workflow || state.parent ? (
              <IconButtonLink href={allWorkflowsHref} label={t.backToWorkflows} size="sm">
                <i class="ti ti-arrow-left" />
              </IconButtonLink>
            ) : null}
            <div class="min-w-0">
              <h1 class="truncate text-base font-semibold text-primary">{title}</h1>
              <p class="mt-1 text-xs text-dimmed">
                {selectedWorkflow
                  ? t.workflowRunsDescription({ window: state.window })
                  : t.workflowsDescription}
              </p>
            </div>
          </div>
        </div>

        <WorkflowStats totals={totals} window={state.window} />
        <div class="flex flex-wrap items-center justify-between gap-2">
          <RangePicker label={null} ariaLabel={t.workflowView} options={viewOptions} value={state.view} />
          <ButtonLink variant="ghost" size="sm" href={workflowsFilter.build(state)}>
            <i class="ti ti-refresh" />
            {t.refresh}
          </ButtonLink>
        </div>

        {!detail && state.view === "runs" ? (
          <FindingNotices
            totals={totals}
            effectsHref={workflowsFilter.build(state, { view: "effects", workflow: "", run: "", parent: "", page: 1 })}
            eventsHref={workflowsFilter.build(state, { view: "events", workflow: "", run: "", parent: "", page: 1 })}
          />
        ) : null}

        {!detail && state.view === "runs" && !state.parent ? (
          <section class="paper p-3">
            <h2 class="text-xs font-semibold text-primary">{t.runTimeline}</h2>
            <p class="text-[10px] text-dimmed">{t.workflowTimelineDescription}</p>
            {timelineResult.total > timelineResult.runs.length ? (
              <p class="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
                {t.timelineSample({ count: formatNumber(timelineResult.runs.length, { locale }), total: formatNumber(timelineResult.total, { locale }) })}
              </p>
            ) : null}
            {timelineRows.length === 0 ? (
              <Placeholder variant="compact" description={t.noWorkflowRunsWindow} />
            ) : (
              <ObservabilityChart
                kind="stateTimeline"
                class="mt-2 w-full text-dimmed"
                rows={timelineRows}
                domain={[timelineWindow.fromMs, timelineWindow.toMs]}
                states={[
                  { state: "queued", label: t.queued, color: "#71717a" },
                  { state: "running", label: t.running, color: "#3b82f6" },
                  { state: "waiting", label: t.waiting, color: "#8b5cf6" },
                  { state: "succeeded", label: t.succeeded, color: "#10b981" },
                  { state: "failed", label: t.failed, color: "#ef4444" },
                  { state: "needs_attention", label: t.needsAttentionLabel, color: "#f59e0b" },
                  { state: "canceled", label: t.canceled, color: "#a1a1aa" },
                ]}
                xFormat="timeline"
                legend
                interactive
              />
            )}
          </section>
        ) : null}

        {state.run && !detail ? (
          <NoticeCard
            tone="danger"
            title={t.workflowRunNotFound}
            detail={
              <a class="font-medium hover:underline" href={workflowsFilter.build(state, { run: "" })}>
                {t.returnToView({ view: state.view })}
              </a>
            }
          />
        ) : detail ? (
          <WorkflowRunDetailView detail={detail} state={state} />
        ) : state.workflow && !selectedWorkflow ? (
          <NoticeCard
            tone="danger"
            title={t.workflowNotFound}
            detail={
              <a class="font-medium hover:underline" href={allWorkflowsHref}>
                {t.returnToWorkflows}
              </a>
            }
          />
        ) : state.view === "runs" ? (
          showFamilyOverview ? (
            <WorkflowFamiliesView
              families={families}
              state={state}
              filters={filters(true)}
              footer={pagination("runs")}
              hasNextPage={hasNextPage}
            />
          ) : (
            <WorkflowRunsView
              runs={runs}
              workflowName={selectedWorkflow?.name}
              allWorkflowsHref={allWorkflowsHref}
              state={state}
              filters={filters(true)}
              footer={pagination("runs")}
              hasNextPage={hasNextPage}
            />
          )
        ) : state.view === "effects" ? (
          <WorkflowEffectsView
            effects={effects}
            state={state}
            filters={filters(false)}
            footer={pagination("effects")}
            hasNextPage={hasNextPage}
          />
        ) : (
          <WorkflowEventsView
            events={events}
            state={state}
            filters={filters(false)}
            footer={pagination("events")}
            hasNextPage={hasNextPage}
          />
        )}
      </div>
    </AdminLayout>
  );
});
