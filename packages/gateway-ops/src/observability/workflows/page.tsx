/**
 * Cross-app workflow operator console on v2.
 *
 * The page stays SSR-first and URL-backed: operators can share the exact run, finding queue, filter and page they are
 * looking at. Mutations are limited to the two interventions the kernel can perform safely — cancellation and an
 * explicit decision about an ambiguous external effect.
 */

import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { formatDateTime, formatDurationMs, formatNumber, formatPercent, formatRelative } from "@k2b/cloud/shared";
import { AdminLayout } from "@k2b/cloud/ssr";
import type { WorkflowRunState } from "@k2b/cloud/workflows";
import {
  getWorkflowRun,
  listStrandedWorkflowEffects,
  listUndispatchedWorkflowEvents,
  listWorkflowFamilies,
  listWorkflowRunTimeline,
  type WorkflowAppHealth,
  type WorkflowRunDetail,
  workflowHealth,
} from "@k2b/cloud/workflows/store";
import { z } from "zod";
import { ssr } from "../../config";
import { type GatewayOpsMessages, gatewayOpsMessages } from "../../messages";
import { observabilityAdminNav } from "../_components/admin-nav";
import type { KeyCell } from "../_components/KeyCells";
import { areaText, readAttention } from "../_components/ObservabilityArea";
import WorkflowsScreen, { type RunDetailView, type Worded } from "./_components/WorkflowsScreen.island";
import { FINDINGS_PER_PAGE, RUNS_PER_PAGE, type WindowFilter, type WorkflowView, windowStart } from "./filters";
import { eventState, LAG_WARN_MS, runErrorSummary, stepDetail } from "./presentation";
import { findingsQuery, legacyWorkflowsHref, runsQuery, workflowRunsHref, workflowsHref } from "./query";
import { buildWorkflowTimelineRows } from "./timeline";

const UUID = z.string().uuid();
const uuid = (value: string | null) => (value && UUID.safeParse(value).success ? value : "");

const STATUS: Record<string, Worded["status"]> = {
  succeeded: "ok",
  completed: "ok",
  planned: "ok",
  terminal: "ok",
  failed: "bad",
  needs_attention: "warn",
  waiting: "warn",
  unsupported: "warn",
  indeterminate: "warn",
  ambiguous: "warn",
};

const stateLabel = (state: string, t: GatewayOpsMessages): string => {
  if (state === "queued") return t.queued;
  if (state === "running") return t.running;
  if (state === "waiting") return t.waiting;
  if (state === "succeeded" || state === "completed" || state === "planned" || state === "terminal") return t.succeeded;
  if (state === "failed") return t.failed;
  if (state === "canceled") return t.canceled;
  if (state === "needs_attention") return t.needsAttentionLabel;
  if (state === "executing") return t.executing;
  if (state === "ambiguous") return t.ambiguous;
  return state;
};
const worded = (state: string, t: GatewayOpsMessages): Worded => ({ label: stateLabel(state, t), status: STATUS[state] ?? null });

const totalsFor = (health: WorkflowAppHealth[]) =>
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

const TIMELINE_STATES = (t: GatewayOpsMessages) => [
  { state: "queued", label: t.queued, color: "#71717a" },
  { state: "running", label: t.running, color: "#3b82f6" },
  { state: "waiting", label: t.waiting, color: "#8b5cf6" },
  { state: "succeeded", label: t.succeeded, color: "#10b981" },
  { state: "failed", label: t.failed, color: "#ef4444" },
  { state: "needs_attention", label: t.needsAttentionLabel, color: "#f59e0b" },
  { state: "canceled", label: t.canceled, color: "#a1a1aa" },
];

const json = (value: unknown) => JSON.stringify(value, null, 2) ?? "null";

/**
 * Workflows on v2: definitions, the run timeline and the findings queues, with one run open beside them. The runs
 * themselves are listed in Läufe; `?workflow=` and `?parent=` lead there.
 */
export default ssr<AuthContext>(async (c) => {
  const url = new URL(c.req.url);
  const legacy = legacyWorkflowsHref(url.searchParams);
  if (legacy) return c.redirect(legacy);
  const locale = getLocale(c);
  const dateConfig = getDateConfig(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const params = url.searchParams;
  const view: WorkflowView = params.get("view") === "effects" ? "effects" : params.get("view") === "events" ? "events" : "runs";
  const selectedApp = params.get("app") ?? undefined;
  // The app the address names stays a value of its filter, so the address reads the same before the apps are known.
  const runsAddress = runsQuery(locale, [], selectedApp).parse(params);
  const findingsAddress = findingsQuery(locale, [], selectedApp).parse(params);
  const filters = view === "runs" ? runsAddress.state.filters : { ...runsAddress.state.filters, app: findingsAddress.state.filters.app };
  const range = runsAddress.state.filters.window;
  const window: WindowFilter = range.kind === "preset" ? range.preset : "24h";
  const workflow = uuid(params.get("workflow"));
  const run = uuid(params.get("run"));
  const parent = uuid(params.get("parent"));
  const pageValue = Number(params.get("page") ?? "1");
  const page = Number.isSafeInteger(pageValue) && pageValue > 0 ? pageValue : 1;
  const since = windowStart(window);
  const pageSize = view === "runs" ? RUNS_PER_PAGE : FINDINGS_PER_PAGE;
  const offset = (page - 1) * pageSize;
  // The runs of one workflow and a run's children are listed in Läufe, with the same filters.
  if (view === "runs" && !run && (workflow || parent))
    return c.redirect(
      workflowRunsHref({
        workflow: workflow || undefined,
        parent: parent || undefined,
        app: filters.app,
        state: filters.state as WorkflowRunState | undefined,
        window,
      }),
    );
  const showFamilies = view === "runs";
  const runFilter = {
    appId: filters.app || undefined,
    state: view === "runs" ? (filters.state as WorkflowRunState | undefined) : undefined,
    mode: view === "runs" ? (filters.mode as "execute" | "dryRun" | undefined) : undefined,
    since,
  };

  const [detail, health, familyRows, timelineResult, effectRows, eventRows, attention] = await Promise.all([
    run ? getWorkflowRun(run) : Promise.resolve(null),
    workflowHealth({ since }),
    showFamilies ? listWorkflowFamilies({ ...runFilter, limit: RUNS_PER_PAGE + 1, offset }) : Promise.resolve([]),
    view === "runs" ? listWorkflowRunTimeline(runFilter, { limit: 2_000 }) : Promise.resolve({ runs: [], total: 0 }),
    view === "effects"
      ? listStrandedWorkflowEffects({ appId: filters.app || undefined, limit: FINDINGS_PER_PAGE + 1, offset })
      : Promise.resolve([]),
    view === "events"
      ? listUndispatchedWorkflowEvents({ appId: filters.app || undefined, limit: FINDINGS_PER_PAGE + 1, offset })
      : Promise.resolve([]),
    readAttention(),
  ]);

  const apps = [...new Set(health.map((entry) => entry.appId))].sort();
  const runs = runsQuery(locale, apps, selectedApp);
  const findings = findingsQuery(locale, apps, selectedApp);
  const rows = view === "runs" ? familyRows : view === "effects" ? effectRows : eventRows;
  const hasNextPage = rows.length > pageSize;
  const totals = totalsFor(filters.app ? health.filter((entry) => entry.appId === filters.app) : health);
  const number = (value: number) => formatNumber(value, { locale });
  const duration = (value: number | null) => formatDurationMs(value, { locale });
  const relative = (value: Date) => formatRelative(value, { locale });
  const nowMs = Date.now();
  const listParams = view === "runs" ? runs.serialize(runsAddress.state) : findings.serialize(findingsAddress.state);
  if (view !== "runs") listParams.set("view", view);
  const href = (extra: Parameters<typeof workflowsHref>[1]) =>
    workflowsHref(listParams, { page: page > 1 ? String(page) : "", run, ...extra });
  const viewHref = (next: WorkflowView) => {
    const base =
      next === "runs" ? runs.serialize(runsAddress.state) : findings.serialize({ ...findingsAddress.state, filters: { app: filters.app } });
    if (next !== "runs") base.set("view", next);
    return workflowsHref(base);
  };
  const countLabel = (count: number) => `${number(Math.min(count, pageSize))}${hasNextPage ? "+" : ""}`;

  const cells: KeyCell[] = [
    { icon: "player-play", label: t.runs, value: number(totals.runs), meta: t.lastWindow({ window }) },
    {
      icon: "hourglass",
      label: t.inFlight,
      value: number(totals.active),
      meta:
        totals.queued === 0
          ? t.runningOrWaiting
          : t.queuedOldest({ count: number(totals.queued), duration: duration(totals.oldestQueuedMs) }),
      tone: totals.oldestQueuedMs > LAG_WARN_MS ? "warn" : undefined,
    },
    { icon: "alert-circle", label: t.failed, value: number(totals.failed), tone: totals.failed > 0 ? "bad" : undefined },
    {
      icon: "hand-stop",
      label: t.needsAttentionLabel,
      value: number(totals.attention),
      meta: t.humanDecisionRequired,
      tone: totals.attention > 0 ? "warn" : undefined,
    },
    {
      icon: "clock-exclamation",
      label: t.worstStartLag,
      value: totals.worstLagMs > 0 ? duration(totals.worstLagMs) : "—",
      meta: t.causeToFirstAttempt,
      tone: totals.worstLagMs > LAG_WARN_MS ? "warn" : undefined,
    },
    {
      icon: "flag",
      label: t.openFindings,
      value: number(totals.stranded + totals.undispatched),
      meta: t.findingsSummary({ effects: number(totals.stranded), events: number(totals.undispatched) }),
      tone: totals.stranded + totals.undispatched > 0 ? "warn" : undefined,
    },
  ];

  const timelineWindow = { fromMs: since.getTime(), toMs: nowMs };
  const timeline =
    !detail && view === "runs"
      ? {
          domain: [timelineWindow.fromMs, timelineWindow.toMs] as [number, number],
          states: TIMELINE_STATES(t),
          sample:
            timelineResult.total > timelineResult.runs.length
              ? t.timelineSample({ count: number(timelineResult.runs.length), total: number(timelineResult.total) })
              : null,
          rows: buildWorkflowTimelineRows(timelineResult.runs, timelineWindow).map((row) => ({
            label: row.label,
            href: workflowRunsHref({ workflow: row.workflowId, window }),
            tooltip: `${row.label} · ${row.appId}`,
            intervals: row.intervals.map(({ run: item, ...interval }) => {
              const timing =
                item.state === "queued"
                  ? t.queuedDuration({ duration: duration(nowMs - item.createdAt.getTime()) })
                  : item.durationMs !== null
                    ? duration(item.durationMs)
                    : item.startedAt
                      ? t.activeDuration({ duration: duration(nowMs - item.startedAt.getTime()) })
                      : t.notStarted;
              return {
                ...interval,
                label: timing,
                href: href({ run: item.id, page: "" }),
                tooltip: [
                  item.workflowName,
                  stateLabel(item.state, t),
                  item.eventType ?? t.directInvocation,
                  formatDateTime(item.createdAt, dateConfig),
                  timing,
                  item.attempt === 0 ? t.notAttempted : t.attemptNumber({ count: item.attempt }),
                ].join(" · "),
              };
            }),
          })),
        }
      : null;

  const findingsNotices =
    !detail && view === "runs"
      ? [
          ...(totals.stranded > 0
            ? [
                {
                  tone: "warn" as const,
                  title: t.effectsRequireEvidence({ count: number(totals.stranded) }),
                  text: t.effectReplayWarning,
                  action: { label: t.reviewEffectsQueue, href: viewHref("effects") },
                },
              ]
            : []),
          ...(totals.undispatched > 0
            ? [
                {
                  tone: "warn" as const,
                  title: t.eventsWithoutRun({ count: number(totals.undispatched) }),
                  text: t.unmatchedEventsWarning,
                  action: { label: t.reviewEventsQueue, href: viewHref("events") },
                },
              ]
            : []),
        ]
      : [];

  const filtered = Boolean(filters.app || filters.state || filters.mode);
  const missing =
    run && !detail ? { title: t.workflowRunNotFound, action: { label: t.returnToView({ view }), href: href({ run: "" }) } } : null;
  const list =
    view === "runs"
      ? {
          title: t.workflowFamilies,
          count: countLabel(familyRows.length),
          summary: t.matchingDefinitions({ count: countLabel(familyRows.length), window }),
          actions: [
            {
              label: t.allWorkflowRuns,
              href: workflowRunsHref({ app: filters.app, state: filters.state as WorkflowRunState | undefined, window }),
            },
          ],
          empty: t.noWorkflowsWindow,
          filtered,
          families: familyRows.slice(0, RUNS_PER_PAGE).map((row) => {
            const queuedAge = row.oldestQueuedAt ? nowMs - row.oldestQueuedAt.getTime() : null;
            return {
              key: row.workflowId,
              name: row.workflowName,
              meta: `${row.appId} · ${row.eventTypes.length === 0 ? t.directInvocation : row.eventTypes.join(", ")} · r${row.latestRevision}`,
              latest: worded(row.latestState, t),
              runs: number(row.runs),
              failed: `${number(row.failed)} · ${formatPercent(row.runs === 0 ? 0 : row.failed / row.runs, { locale })}`,
              failedBad: row.failed > 0,
              runtime: `${duration(row.avgDurationMs)} / ${duration(row.p99DurationMs)}`,
              backlog: `${number(row.active)} / ${queuedAge === null ? "—" : duration(queuedAge)}`,
              backlogWarn: row.needsAttention > 0 || (queuedAge ?? 0) > LAG_WARN_MS,
              activity: relative(row.latestRunAt),
              href: workflowRunsHref({ workflow: row.workflowId, window }),
            };
          }),
        }
      : view === "effects"
        ? {
            title: t.effectsRequiringEvidence,
            count: countLabel(effectRows.length),
            summary: t.unsettledEffectsCount({ count: countLabel(effectRows.length) }),
            actions: [],
            empty: filters.app ? t.noEffectsForApp : t.noEffectsDecision,
            filtered: Boolean(filters.app),
            effects: effectRows.slice(0, FINDINGS_PER_PAGE).map((row) => ({
              key: `${row.runId}:${row.stepKey}`,
              workflow: row.workflowName,
              app: row.appId,
              step: row.stepKey,
              action: row.action ?? "—",
              state: worded(row.effectState, t),
              age: duration(row.ageMs),
              href: href({ run: row.runId }),
            })),
          }
        : {
            title: t.eventsWithoutRunTitle,
            count: countLabel(eventRows.length),
            summary: t.undispatchedEventsCount({ count: countLabel(eventRows.length) }),
            actions: [],
            empty: filters.app ? t.noEventsForApp : t.allEventsDispatched,
            filtered: Boolean(filters.app),
            events: eventRows.slice(0, FINDINGS_PER_PAGE).map((row) => {
              const state = eventState(row);
              return {
                key: row.id,
                type: row.type,
                app: row.appId,
                scope: row.scopeId,
                state: {
                  label: state.label === "No activation" ? t.noActivation : state.label === "Dead letter" ? t.deadLetter : t.retrying,
                  status: state.tone === "error" ? ("bad" as const) : ("warn" as const),
                },
                attempts: number(row.attempts),
                occurred: relative(row.occurredAt),
                error: row.lastError ?? "",
              };
            }),
          };

  const runDetail = (value: WorkflowRunDetail): RunDetailView => {
    const attentionStep = value.steps.find(
      (step) => step.state === "needs_attention" && (step.effectState === "executing" || step.effectState === "ambiguous"),
    );
    const error = runErrorSummary(value.error);
    return {
      title: `${value.workflowName} · ${t.revision({ revision: value.revision })}`,
      state: worded(value.state, t),
      meta: `${value.appId} · ${value.mode} · ${t.attemptNumber({ count: value.attempt })} · ${relative(value.createdAt)}`,
      outcome: attentionStep
        ? {
            tone: "warn",
            title: t.needsOperatorDecision({ name: attentionStep.action ?? attentionStep.stepKey }),
            text: t.operatorDecisionDetail,
          }
        : error
          ? {
              tone: "bad",
              title: error.message,
              text: [error.code, error.retryable === null ? null : error.retryable ? t.runCanRetry : t.runWillNotRetry]
                .filter(Boolean)
                .join(" · "),
            }
          : null,
      facts: [
        { label: t.trigger, value: value.eventType ?? t.directInvocation },
        { label: t.occurred, value: relative(value.occurredAt) },
        { label: t.startLag, value: duration(value.startLagMs) },
        { label: t.duration, value: duration(value.durationMs) },
        ...(value.parentRunId ? [{ label: t.parentRun, value: value.parentRunId, href: href({ run: value.parentRunId }) }] : []),
      ],
      children: (Object.entries(value.children) as [WorkflowRunState, number][])
        .filter(([, count]) => count > 0)
        .map(([state, count]) => {
          return {
            label: `${number(count)} ${stateLabel(state, t).toLocaleLowerCase(locale)}`,
            status: STATUS[state] ?? null,
            href: workflowRunsHref({ parent: value.id, state }),
          };
        }),
      steps: value.steps.map((step) => ({
        key: step.stepKey,
        step: step.stepKey,
        action: step.action ?? step.kind,
        state: worded(step.state, t),
        effect: step.effectState ? worded(step.effectState, t) : null,
        detail: stepDetail(step, t.waitingOn),
        attempts: t.attemptNumber({ count: step.attempt + 1 }),
        duration: duration(step.durationMs),
      })),
      payloads: [
        { title: t.inputs, json: json(value.inputs) },
        {
          title: t.result,
          json: value.result === null || value.result === undefined ? json(value.resultMessage ?? null) : json(value.result),
        },
        ...(value.eventPayloadExpired
          ? [{ title: t.eventPayload, json: json(t.eventPayloadExpired) }]
          : value.eventData
            ? [{ title: t.eventPayload, json: json(value.eventData) }]
            : []),
      ],
      technical: [
        {
          title: t.identity,
          json: json({ runId: value.id, scopeId: value.scopeId, parentRunId: value.parentRunId, revision: value.revision }),
        },
        ...(value.error ? [{ title: t.error, json: json(value.error) }] : []),
        ...(Object.keys(value.effectBudget).length > 0
          ? [
              {
                title: t.effectBudget,
                json: json(
                  Object.fromEntries(
                    Object.entries(value.effectBudget).map(([dimension, limit]) => [
                      dimension,
                      { used: value.effectsUsed[dimension] ?? 0, limit },
                    ]),
                  ),
                ),
              },
            ]
          : []),
        {
          title: t.stepJournal,
          json: json(
            value.steps.map((step) => ({
              stepKey: step.stepKey,
              sourcePath: step.sourcePath,
              iterationPath: step.iterationPath,
              outcome: step.outcome,
              dependency: step.dependency,
              effectKey: step.effectKey,
              effectState: step.effectState,
            })),
          ),
        },
        { title: t.pinnedDefinition, json: json({ source: value.source }) },
      ],
      actions: {
        runId: value.id,
        cancelable: ["queued", "running", "waiting"].includes(value.state),
        attentionStep: attentionStep ? { stepKey: attentionStep.stepKey, action: attentionStep.action } : null,
      },
      closeHref: href({ run: "" }),
    };
  };

  const issues = [...(view === "runs" ? runsAddress.issues : findingsAddress.issues)];
  const ignored = issues.length > 0 ? issues.map((issue) => `${issue.param}=${issue.value}`).join(", ") : null;
  const area = areaText(locale);

  return () => (
    <AdminLayout c={c} ui="v2" title={area.workflows}>
      <WorkflowsScreen
        nav={observabilityAdminNav(c, locale, attention, "workflows")}
        apps={apps}
        view={view}
        runsState={runsAddress.state}
        findingsState={findingsAddress.state}
        search={url.search}
        ignored={ignored}
        tabs={{
          runs: viewHref("runs"),
          effects: viewHref("effects"),
          events: viewHref("events"),
          effectsCount: totals.stranded ? number(totals.stranded) : "",
          eventsCount: totals.undispatched ? number(totals.undispatched) : "",
        }}
        cells={cells}
        findings={findingsNotices}
        timeline={timeline}
        list={list}
        missing={missing}
        previousHref={page > 1 ? href({ page: page > 2 ? String(page - 1) : "", run: "" }) : null}
        nextHref={hasNextPage ? href({ page: String(page + 1), run: "" }) : null}
        detail={detail ? runDetail(detail) : null}
      />
    </AdminLayout>
  );
});
