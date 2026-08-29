import { ButtonLink, DataPanel, DataTable, type DataTableColumn, RangePicker, StatusBadge, useLocale } from "@k2b/ui";
import { formatDurationMs, formatNumber, formatPercent, formatRelative } from "@valentinkolb/cloud/shared";
import type {
  StrandedWorkflowEffect,
  UndispatchedWorkflowEvent,
  WorkflowFamilySummary,
  WorkflowRunSummary,
} from "@valentinkolb/cloud/workflows/store";
import type { JSX } from "solid-js";
import { WINDOWS, type WorkflowsFilterState, workflowsFilter } from "../filters";
import { EFFECT_TONE, eventState, LAG_WARN_MS, RUN_TONE, runErrorSummary } from "../presentation";
import { gatewayOpsMessages, type GatewayOpsMessages } from "../../../messages";

type CommonProps = {
  state: WorkflowsFilterState;
  filters: JSX.Element;
  footer?: JSX.Element;
  hasNextPage: boolean;
};

const runLabel = (state: WorkflowRunSummary["state"], t: GatewayOpsMessages): string => {
  if (state === "queued") return t.queued;
  if (state === "running") return t.running;
  if (state === "waiting") return t.waiting;
  if (state === "succeeded") return t.succeeded;
  if (state === "failed") return t.failed;
  if (state === "canceled") return t.canceled;
  return t.needsAttentionLabel;
};

export function WorkflowFamiliesView(props: CommonProps & { families: WorkflowFamilySummary[] }) {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  const eventTypesLabel = (family: WorkflowFamilySummary): string =>
    family.eventTypes.length === 0 ? t.directInvocation : family.eventTypes.join(", ");
  const columns: DataTableColumn<WorkflowFamilySummary>[] = [
    { id: "workflow", header: t.workflowTrigger, cellClass: "min-w-[280px]" },
    { id: "latest", header: t.latest, subtitle: t.matchingRun },
    { id: "runs", header: t.runs, align: "right" },
    { id: "failed", header: t.failed, subtitle: t.errorRate, align: "right" },
    { id: "runtime", header: t.runtime, subtitle: t.averageP99, align: "right" },
    { id: "backlog", header: t.backlog, subtitle: t.activeOldest, align: "right" },
    { id: "activity", header: t.last, subtitle: t.activity, align: "right" },
    { id: "open", header: "", align: "right" },
  ];
  return (
    <DataPanel
      title={t.workflowFamilies}
      subtitle={t.matchingDefinitions({ count: `${formatNumber(props.families.length, { locale: locale() })}${props.hasNextPage ? "+" : ""}`, window: props.state.window })}
      filters={props.filters}
      isEmpty={props.families.length === 0}
      empty={t.noWorkflowsWindow}
      footer={props.footer}
    >
      <DataTable
        rows={props.families}
        columns={columns}
        getRowId={(family) => family.workflowId}
        density="compact"
        hoverRows
        highlightColumns={false}
        class="overflow-x-auto"
        renderCell={({ row, col }) => {
          const href = workflowsFilter.build(props.state, { workflow: row.workflowId, run: "", parent: "", page: 1 });
          if (col.id === "workflow")
            return (
              <a class="block min-w-0 hover:text-blue-600 dark:hover:text-blue-300" href={href}>
                <span class="block truncate text-[11px] font-medium text-primary">{row.workflowName}</span>
                <span class="block truncate text-[10px] text-dimmed" title={`${row.appId} · ${row.scopeId} · ${eventTypesLabel(row)}`}>
                  {row.appId} · {eventTypesLabel(row)} · r{row.latestRevision}
                </span>
              </a>
            );
          if (col.id === "latest")
            return (
              <a
                href={workflowsFilter.build(props.state, {
                  workflow: row.workflowId,
                  run: row.latestRunId,
                  parent: "",
                  page: 1,
                })}
                title={t.openLatestRun}
              >
                <StatusBadge tone={RUN_TONE[row.latestState]} label={runLabel(row.latestState, t)} variant="dot" />
              </a>
            );
          if (col.id === "runs") return <span class="text-[10px] tabular-nums text-dimmed">{formatNumber(row.runs, { locale: locale() })}</span>;
          if (col.id === "failed")
            return (
              <span class={`text-[10px] tabular-nums ${row.failed > 0 ? "text-red-500" : "text-dimmed"}`}>
                {formatNumber(row.failed, { locale: locale() })} · {formatPercent(row.runs === 0 ? 0 : row.failed / row.runs, { locale: locale() })}
              </span>
            );
          if (col.id === "runtime")
            return (
              <span class="text-[10px] tabular-nums text-dimmed">
                {formatDurationMs(row.avgDurationMs, { locale: locale() })} / {formatDurationMs(row.p99DurationMs, { locale: locale() })}
              </span>
            );
          if (col.id === "backlog") {
            const queuedAge = row.oldestQueuedAt ? Date.now() - row.oldestQueuedAt.getTime() : null;
            return (
              <span
                class={`text-[10px] tabular-nums ${
                  row.needsAttention > 0 || (queuedAge ?? 0) > LAG_WARN_MS ? "text-amber-600 dark:text-amber-400" : "text-dimmed"
                }`}
                title={row.needsAttention > 0 ? t.needAttentionCount({ count: formatNumber(row.needsAttention, { locale: locale() }) }) : undefined}
              >
                {formatNumber(row.active, { locale: locale() })} / {queuedAge === null ? "—" : formatDurationMs(queuedAge, { locale: locale() })}
              </span>
            );
          }
          if (col.id === "activity") return <span class="text-[10px] text-dimmed">{formatRelative(row.latestRunAt, { locale: locale() })}</span>;
          if (col.id === "open")
            return (
              <ButtonLink variant="ghost" size="sm" href={href}>
                {t.open}
              </ButtonLink>
            );
          return "";
        }}
      />
    </DataPanel>
  );
}

export function WorkflowRunsView(props: CommonProps & { runs: WorkflowRunSummary[]; workflowName?: string; allWorkflowsHref?: string }) {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  const columns: DataTableColumn<WorkflowRunSummary>[] = [
    { id: "workflow", header: t.workflowRun, cellClass: "min-w-[260px]" },
    { id: "cause", header: t.cause, value: (run) => run.eventType ?? t.directInvocation },
    { id: "state", header: t.state },
    { id: "lag", header: t.start, subtitle: t.lagQueued, align: "right" },
    { id: "duration", header: t.duration, align: "right" },
    { id: "attempts", header: t.attempts, align: "right" },
    { id: "created", header: t.created, align: "right" },
  ];
  return (
    <DataPanel
      title={props.state.parent ? t.childRuns : props.workflowName ? t.namedRuns({ name: props.workflowName }) : t.runs}
      subtitle={t.runsInWindow({ count: `${formatNumber(props.runs.length, { locale: locale() })}${props.hasNextPage ? "+" : ""}`, window: props.state.window })}
      actions={
        <div class="flex flex-wrap items-center justify-end gap-2">
          {props.state.parent ? (
            <a
              class="text-xs text-secondary hover:underline"
              href={workflowsFilter.build(props.state, { run: props.state.parent, parent: "", state: "all", page: 1 })}
            >
              {t.openParent}
            </a>
          ) : null}
          {!props.state.parent && props.allWorkflowsHref ? (
            <a class="text-xs text-secondary hover:underline" href={props.allWorkflowsHref}>
              {t.allWorkflows}
            </a>
          ) : null}
          <RangePicker
            options={WINDOWS.map((value) => ({
              value,
              href: workflowsFilter.build(props.state, { window: value, page: 1 }),
            }))}
            value={props.state.window}
          />
        </div>
      }
      filters={props.filters}
      isEmpty={props.runs.length === 0}
      empty={
        workflowsFilter.isActive(props.state, ["view", "window", "app", "state", "mode", "workflow", "parent", "page", "run"])
          ? t.noRunsFilters
          : t.noWorkflowRan
      }
      footer={props.footer}
    >
      <DataTable
        rows={props.runs}
        columns={columns}
        getRowId={(run) => run.id}
        density="compact"
        class="overflow-x-auto"
        renderCell={({ row, col, value, render }) => {
          if (col.id === "workflow") {
            const error = runErrorSummary(row.error);
            return (
              <a class="block min-w-0 hover:underline" href={workflowsFilter.build(props.state, { run: row.id })}>
                <span class="block truncate font-medium text-primary">
                  {row.workflowName}
                  <span class="ml-1 text-dimmed">r{row.revision}</span>
                </span>
                <span class="block truncate font-mono text-[9px] text-dimmed" title={row.id}>
                  {row.appId} · {row.mode} · {row.id.slice(0, 8)}
                </span>
                {error ? (
                  <span class="block truncate text-[9px] text-red-500" title={error.message}>
                    {error.message}
                  </span>
                ) : null}
              </a>
            );
          }
          if (col.id === "state") {
            const queuedMs = row.state === "queued" ? Date.now() - row.createdAt.getTime() : null;
            return (
              <div class="flex flex-col items-start gap-0.5">
                <StatusBadge tone={RUN_TONE[row.state]} label={runLabel(row.state, t)} variant="dot" />
                {queuedMs !== null ? (
                  <span class={queuedMs > LAG_WARN_MS ? "text-[9px] text-amber-600 dark:text-amber-400" : "text-[9px] text-dimmed"}>
                    {t.waitingDuration({ duration: formatDurationMs(queuedMs, { locale: locale() }) })}
                  </span>
                ) : null}
              </div>
            );
          }
          if (col.id === "lag")
            return row.startedAt === null ? (
              <span
                class={
                  row.state === "queued" && Date.now() - row.createdAt.getTime() > LAG_WARN_MS
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-dimmed"
                }
              >
                {t.notStarted}
              </span>
            ) : (
              <span class={(row.startLagMs ?? 0) > LAG_WARN_MS ? "text-amber-600 dark:text-amber-400" : "text-secondary"}>
                {formatDurationMs(row.startLagMs, { locale: locale() })}
              </span>
            );
          if (col.id === "duration") {
            const duration = row.durationMs ?? (row.startedAt ? Date.now() - row.startedAt.getTime() : null);
            return <span class="text-secondary">{formatDurationMs(duration, { locale: locale() })}</span>;
          }
          if (col.id === "attempts")
            return (
              <span class={row.attempt > 1 ? "text-amber-600 dark:text-amber-400" : "text-dimmed"}>
                {row.attempt === 0 ? t.notStarted : formatNumber(row.attempt, { locale: locale() })}
              </span>
            );
          if (col.id === "created") return <span class="text-secondary">{formatRelative(row.createdAt, { locale: locale() })}</span>;
          return render(value);
        }}
      />
    </DataPanel>
  );
}

export function WorkflowEffectsView(props: CommonProps & { effects: StrandedWorkflowEffect[] }) {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  const columns: DataTableColumn<StrandedWorkflowEffect>[] = [
    { id: "workflow", header: t.workflow, cellClass: "min-w-[220px]" },
    { id: "app", header: t.app },
    { id: "step", header: t.step },
    { id: "action", header: t.actionLabel },
    { id: "state", header: t.state },
    { id: "age", header: t.unsettledFor, align: "right" },
    { id: "open", header: "", align: "right" },
  ];
  const effectLabel = (state: string): string => state === "executing" ? t.executing : state === "ambiguous" ? t.ambiguous : state === "succeeded" ? t.succeeded : state === "failed" ? t.failed : state;
  return (
    <DataPanel
      title={t.effectsRequiringEvidence}
      subtitle={t.unsettledEffectsCount({ count: `${formatNumber(props.effects.length, { locale: locale() })}${props.hasNextPage ? "+" : ""}` })}
      filters={props.filters}
      isEmpty={props.effects.length === 0}
      empty={props.state.app ? t.noEffectsForApp : t.noEffectsDecision}
      footer={props.footer}
    >
      <DataTable
        rows={props.effects}
        columns={columns}
        getRowId={(effect) => `${effect.runId}:${effect.stepKey}`}
        density="compact"
        class="overflow-x-auto"
        renderCell={({ row, col, value, render }) => {
          if (col.id === "workflow") return <span class="font-medium">{row.workflowName}</span>;
          if (col.id === "app") return <span class="text-secondary">{row.appId}</span>;
          if (col.id === "step") return <span class="font-mono text-xs">{row.stepKey}</span>;
          if (col.id === "action") return <span class="text-secondary">{row.action ?? "—"}</span>;
          if (col.id === "state")
            return <StatusBadge tone={EFFECT_TONE[row.effectState] ?? "warning"} label={effectLabel(row.effectState)} variant="dot" />;
          if (col.id === "age") return <span class="text-secondary">{formatDurationMs(row.ageMs, { locale: locale() })}</span>;
          if (col.id === "open")
            return (
              <ButtonLink variant="ghost" size="sm" href={workflowsFilter.build(props.state, { run: row.runId })}>
                {t.inspect}
              </ButtonLink>
            );
          return render(value);
        }}
      />
    </DataPanel>
  );
}

export function WorkflowEventsView(props: CommonProps & { events: UndispatchedWorkflowEvent[] }) {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  const columns: DataTableColumn<UndispatchedWorkflowEvent>[] = [
    { id: "type", header: t.event, cellClass: "min-w-[220px]" },
    { id: "app", header: t.app },
    { id: "scope", header: t.scope },
    { id: "state", header: t.state },
    { id: "attempts", header: t.attempts, align: "right" },
    { id: "occurred", header: t.occurred, align: "right" },
    { id: "error", header: t.lastError, cellClass: "min-w-[240px]" },
  ];
  return (
    <DataPanel
      title={t.eventsWithoutRunTitle}
      subtitle={t.undispatchedEventsCount({ count: `${formatNumber(props.events.length, { locale: locale() })}${props.hasNextPage ? "+" : ""}` })}
      filters={props.filters}
      isEmpty={props.events.length === 0}
      empty={props.state.app ? t.noEventsForApp : t.allEventsDispatched}
      footer={props.footer}
    >
      <DataTable
        rows={props.events}
        columns={columns}
        getRowId={(event) => event.id}
        density="compact"
        class="overflow-x-auto"
        renderCell={({ row, col, value, render }) => {
          if (col.id === "type")
            return (
              <span class="font-mono text-xs" title={row.id}>
                {row.type}
              </span>
            );
          if (col.id === "app") return <span class="text-secondary">{row.appId}</span>;
          if (col.id === "scope")
            return (
              <span class="block max-w-[220px] truncate font-mono text-xs text-secondary" title={row.scopeId}>
                {row.scopeId}
              </span>
            );
          if (col.id === "state") {
            const state = eventState(row);
            const label = state.label === "No activation" ? t.noActivation : state.label === "Dead letter" ? t.deadLetter : t.retrying;
            return <StatusBadge tone={state.tone} label={label} variant="dot" />;
          }
          if (col.id === "attempts") return <span class="text-dimmed">{formatNumber(row.attempts, { locale: locale() })}</span>;
          if (col.id === "occurred") return <span class="text-secondary">{formatRelative(row.occurredAt, { locale: locale() })}</span>;
          if (col.id === "error")
            return (
              <span class="block max-w-[360px] truncate text-secondary" title={row.lastError ?? undefined}>
                {row.lastError ?? "—"}
              </span>
            );
          return render(value);
        }}
      />
    </DataPanel>
  );
}
