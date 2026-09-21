/**
 * Capability execution console.
 *
 * One history for every surface that can call a capability — the assistant,
 * MCP, HTTP and app-to-app mandates — so an operator answers "what did an agent
 * do, on whose behalf, and did it work" in one place. The page is read-only:
 * the dispatcher owns every row.
 */

import {
  type CapabilityExecution,
  type CapabilityExecutionGroup,
  type CapabilityExecutionSummary,
  listCapabilityExecutions,
  summarizeCapabilityExecutions,
} from "@k2b/cloud/capabilities/store";
import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { aiUsageHref, formatDateTime, formatDurationMs, formatNumber } from "@k2b/cloud/shared";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ButtonLink, DataTable, type DataTableColumn, NoticeCard, StatCell, StatGrid, StatusBadge } from "@k2b/ui";
import { ssr } from "../../config";
import CapabilitiesFilterBar from "./_components/CapabilitiesFilterBar.island";
import ExecutionDetail from "./_components/ExecutionDetail";
import {
  type CapabilitiesFilterState,
  capabilitiesFilter,
  EXECUTIONS_PER_PAGE,
  executionFilter,
  ORIGIN_FILTERS,
  STATUS_FILTERS,
  WINDOWS,
  windowStart,
} from "./filters";
import { statusLabel } from "./labels";
import { capabilityOpsMessages } from "./ops-messages";
import { ORIGIN_ICON, SLOW_DURATION_MS, STATUS_TONE } from "./presentation";

const EMPTY_SUMMARY: CapabilityExecutionSummary = {
  executions: 0,
  failed: 0,
  denied: 0,
  destructive: 0,
  avgDurationMs: null,
  p95DurationMs: null,
  apps: [],
  capabilities: [],
};

/** One place decides which links reset paging, so a filter change never lands on a stale cursor. */
const reset = { cursor: "", request: "" } as const;

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const dateConfig = getDateConfig(c);
  const { t } = capabilityOpsMessages.resolve([locale]);
  const state = capabilitiesFilter.parse(new URL(c.req.url));
  const since = windowStart(state.window);
  const number = (value: number | null) => formatNumber(value, { locale });
  const duration = (value: number | null) => (value === null ? "—" : formatDurationMs(Math.round(value), { locale }));

  let failure: string | null = null;
  let summary = EMPTY_SUMMARY;
  let scope = EMPTY_SUMMARY;
  let executions: CapabilityExecution[] = [];
  let nextCursor: string | undefined;
  let detail: CapabilityExecution[] = [];
  try {
    const [scopeResult, summaryResult, page, detailPage] = await Promise.all([
      // Filter options come from the whole window, so narrowing to one app does
      // not hide every other app from the chip that selected it.
      summarizeCapabilityExecutions({ since }),
      summarizeCapabilityExecutions(executionFilter(state)),
      listCapabilityExecutions({
        ...executionFilter(state),
        limit: EXECUTIONS_PER_PAGE,
        ...(state.cursor ? { cursor: state.cursor } : {}),
      }),
      state.request ? listCapabilityExecutions({ requestId: state.request, limit: 50 }) : Promise.resolve({ items: [] }),
    ]);
    scope = scopeResult;
    summary = summaryResult;
    executions = page.items;
    nextCursor = page.nextCursor;
    detail = detailPage.items;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  const href = (updates: Partial<CapabilitiesFilterState>) => capabilitiesFilter.build(state, { ...reset, ...updates });
  const hrefFor = {
    app: Object.fromEntries([["", href({ app: "" })], ...scope.apps.map((group) => [group.id, href({ app: group.id })] as const)]),
    capability: Object.fromEntries([
      ["", href({ capability: "" })],
      ...scope.capabilities.map((group) => [group.id, href({ capability: group.id })] as const),
    ]),
    origin: Object.fromEntries(ORIGIN_FILTERS.map((value) => [value, href({ origin: value })] as const)),
    status: Object.fromEntries(STATUS_FILTERS.map((value) => [value, href({ status: value })] as const)),
    window: Object.fromEntries(WINDOWS.map((value) => [value, href({ window: value })] as const)),
    destructive: { off: href({ destructive: false }), on: href({ destructive: true }) },
  };

  const groupColumns = (header: string): DataTableColumn<CapabilityExecutionGroup>[] => [
    { id: "id", header, value: (row) => row.id, cellClass: "font-mono text-[11px]" },
    { id: "executions", header: t.executions, value: (row) => row.executions, align: "right" },
    { id: "failed", header: t.failed, value: (row) => row.failed, align: "right" },
    { id: "denied", header: t.denied, value: (row) => row.denied, align: "right" },
    { id: "destructive", header: t.destructive, value: (row) => row.destructive, align: "right" },
  ];

  const groupTable = (rows: CapabilityExecutionGroup[], header: string, onSelect: (id: string) => string) => (
    <DataTable
      rows={rows}
      columns={groupColumns(header)}
      getRowId={(row) => row.id}
      density="compact"
      hoverRows
      class="max-h-[22rem] overflow-auto"
      empty={t.noGroups}
      renderCell={({ row, col, value, render }) => {
        if (col.id === "id")
          return (
            <a class="link" href={onSelect(row.id)}>
              {row.id}
            </a>
          );
        if (col.id === "failed" && row.failed > 0) return <span class="tabular-nums font-semibold text-red-500">{number(row.failed)}</span>;
        if (col.id === "denied" && row.denied > 0)
          return <span class="tabular-nums font-semibold text-amber-600 dark:text-amber-400">{number(row.denied)}</span>;
        if (typeof value === "number") return <span class="tabular-nums">{number(value)}</span>;
        return render(value);
      }}
    />
  );

  const executionColumns: DataTableColumn<CapabilityExecution>[] = [
    { id: "startedAt", header: t.startedAt, value: (row) => row.startedAt },
    { id: "app", header: t.app, value: (row) => row.appId },
    { id: "capability", header: t.capability, value: (row) => row.capability, cellClass: "font-mono text-[11px]" },
    { id: "origin", header: t.origin, value: (row) => row.origin },
    { id: "kind", header: t.kind, value: (row) => row.kind },
    { id: "status", header: t.status, value: (row) => row.status },
    { id: "duration", header: t.duration, value: (row) => row.durationMs, align: "right" },
    { id: "user", header: t.user, value: (row) => row.userId ?? "", cellClass: "font-mono text-[11px] max-w-[10rem] truncate" },
    { id: "details", header: t.details, value: () => null, align: "right" },
  ];

  return () => (
    <AdminLayout c={c} title={t.title}>
      <div class="app-rows">
        <div class="min-w-0" style="view-transition-name: admin-capabilities-title">
          <h1 class="text-base font-semibold text-primary">{t.title}</h1>
          <p class="mt-1 text-xs text-dimmed">{t.description}</p>
        </div>

        {failure ? <NoticeCard tone="danger" title={t.loadFailed} detail={failure} /> : null}

        <div class="flex flex-wrap items-center justify-between gap-2">
          <CapabilitiesFilterBar
            apps={scope.apps.map((group) => group.id)}
            capabilities={scope.capabilities.map((group) => group.id)}
            app={state.app}
            capability={state.capability}
            origin={state.origin}
            status={state.status}
            window={state.window}
            destructive={state.destructive}
            hrefFor={hrefFor}
          />
          <div class="flex items-center gap-2">
            {capabilitiesFilter.isActive(state, ["window"]) ? (
              <ButtonLink variant="ghost" size="sm" href={capabilitiesFilter.clear(state, ["window"])}>
                <i class="ti ti-filter-off" />
                {t.clear}
              </ButtonLink>
            ) : null}
            <ButtonLink variant="ghost" size="sm" href={capabilitiesFilter.build(state)}>
              <i class="ti ti-refresh" />
              {t.refresh}
            </ButtonLink>
          </div>
        </div>

        {state.user ? (
          <NoticeCard
            tone="info"
            icon="ti ti-user"
            title={`${t.user}: ${state.user}`}
            detail={
              <span class="flex flex-wrap gap-2">
                <a class="font-medium hover:underline" href={aiUsageHref({ view: "runs", userId: state.user })}>
                  {t.aiUsage}
                </a>
                <a class="font-medium hover:underline" href={href({ user: "" })}>
                  {t.clearUser}
                </a>
              </span>
            }
          />
        ) : null}

        <StatGrid columns={6}>
          <StatCell label={t.executions} value={number(summary.executions)} sub={t.inSelectedRange} />
          <StatCell
            label={t.failed}
            value={number(summary.failed)}
            sub={t.failedSub}
            valueClass={summary.failed > 0 ? "text-red-600 dark:text-red-400" : undefined}
            accent={summary.failed > 0 ? { tone: "red", icon: "ti ti-alert-triangle" } : undefined}
          />
          <StatCell
            label={t.denied}
            value={number(summary.denied)}
            sub={t.deniedSub}
            valueClass={summary.denied > 0 ? "text-amber-600 dark:text-amber-400" : undefined}
          />
          <StatCell
            label={t.destructive}
            value={number(summary.destructive)}
            sub={t.destructiveSub}
            valueClass={summary.destructive > 0 ? "text-amber-600 dark:text-amber-400" : undefined}
          />
          <StatCell label={t.avgDuration} value={duration(summary.avgDurationMs)} sub={t.inSelectedRange} />
          <StatCell
            label={t.p95Duration}
            value={duration(summary.p95DurationMs)}
            sub={t.inSelectedRange}
            valueClass={(summary.p95DurationMs ?? 0) > SLOW_DURATION_MS ? "text-amber-600 dark:text-amber-400" : undefined}
          />
        </StatGrid>

        <div class="grid gap-3 lg:grid-cols-2">
          <section class="paper overflow-hidden">
            <div class="px-3 py-2">
              <h2 class="text-xs font-semibold text-primary">{t.byApp}</h2>
              <p class="text-[10px] text-dimmed">{`${t.byAppHint} ${t.groupsCapped}`}</p>
            </div>
            {groupTable(summary.apps, t.app, (id) => href({ app: id }))}
          </section>
          <section class="paper overflow-hidden">
            <div class="px-3 py-2">
              <h2 class="text-xs font-semibold text-primary">{t.byCapability}</h2>
              <p class="text-[10px] text-dimmed">{`${t.byCapabilityHint} ${t.groupsCapped}`}</p>
            </div>
            {groupTable(summary.capabilities, t.capability, (id) => href({ capability: id }))}
          </section>
        </div>

        <section id="capability-executions" class="paper overflow-hidden">
          <div class="px-3 py-2">
            <h2 class="text-xs font-semibold text-primary">{t.executions}</h2>
            <p class="text-[10px] text-dimmed">{`${t.executionsHint} ${t.retention}`}</p>
          </div>
          <DataTable
            rows={executions}
            columns={executionColumns}
            getRowId={(row) => row.id}
            density="compact"
            hoverRows
            class="max-h-[34rem] overflow-auto"
            empty={t.noExecutions}
            renderCell={({ row, col, value, render }) => {
              if (col.id === "startedAt") return <span class="tabular-nums">{formatDateTime(row.startedAt, dateConfig)}</span>;
              if (col.id === "app")
                return (
                  <a class="link" href={href({ app: row.appId })}>
                    {row.appId}
                  </a>
                );
              if (col.id === "capability")
                return (
                  <a class="link" href={href({ capability: row.capability })}>
                    {row.capability}
                  </a>
                );
              if (col.id === "origin")
                return (
                  <span class="inline-flex items-center gap-1 text-secondary">
                    <i class={ORIGIN_ICON[row.origin]} />
                    {row.origin}
                  </span>
                );
              if (col.id === "kind")
                return row.destructive ? (
                  <StatusBadge tone="warning" label={t.destructive} variant="dot" />
                ) : (
                  <span class="text-secondary">{row.kind === "action" ? t.kindAction : t.kindQuery}</span>
                );
              if (col.id === "status")
                return (
                  <StatusBadge
                    tone={STATUS_TONE[row.status]}
                    label={statusLabel(row.status, t)}
                    variant="dot"
                    title={row.errorCode ?? undefined}
                  />
                );
              if (col.id === "duration")
                return (
                  <span
                    class={
                      row.durationMs > SLOW_DURATION_MS ? "tabular-nums text-amber-600 dark:text-amber-400" : "tabular-nums text-secondary"
                    }
                  >
                    {formatDurationMs(row.durationMs, { locale })}
                  </span>
                );
              if (col.id === "user")
                return row.userId ? (
                  <a class="link" href={href({ user: row.userId })} title={row.userId}>
                    {row.userId}
                  </a>
                ) : (
                  <span class="text-dimmed">—</span>
                );
              if (col.id === "details")
                return (
                  <ButtonLink
                    href={`${capabilitiesFilter.build(state, { request: row.requestId })}#capability-execution-detail`}
                    size="xs"
                    variant="secondary"
                  >
                    {t.details}
                  </ButtonLink>
                );
              return render(value);
            }}
          />
        </section>

        {state.cursor || nextCursor ? (
          <div class="flex gap-2">
            <ButtonLink href={capabilitiesFilter.build(state, reset)} variant="secondary" size="sm">
              {t.first}
            </ButtonLink>
            {nextCursor ? (
              <ButtonLink href={capabilitiesFilter.build(state, { cursor: nextCursor, request: "" })} variant="secondary" size="sm">
                {t.next}
              </ButtonLink>
            ) : null}
          </div>
        ) : null}

        {state.request ? (
          detail.length > 0 ? (
            <ExecutionDetail
              executions={detail}
              dateConfig={dateConfig}
              closeHref={`${capabilitiesFilter.build(state, { request: "" })}#capability-executions`}
            />
          ) : (
            <NoticeCard
              tone="danger"
              title={t.notFound}
              detail={
                <a class="font-medium hover:underline" href={capabilitiesFilter.build(state, { request: "" })}>
                  {t.backToList}
                </a>
              }
            />
          )
        ) : null}
      </div>
    </AdminLayout>
  );
});
