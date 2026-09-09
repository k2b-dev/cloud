import { ButtonLink, DataTable, type DataTableColumn, Pagination, StatCell, StatGrid } from "@k2b/ui";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { SearchBar } from "@k2b/cloud/ssr/islands";
import { ssr } from "../config";
import { gridsService } from "../service";
import AdminGridsActions from "./_components/AdminGridsActions.island";
import AdminGridsSettings from "./_components/settings/AdminGridsSettings.island";
import { gridsAdminMessages } from "./admin-messages";

const PER_PAGE = 100;

/**
 * /admin/grids — platform-admin overview of every base in the system.
 * Mirrors the spaces admin page: stat cards (totals + orphaned),
 * search bar, paginated table with per-row counts. Bypasses per-base
 * ACLs by living under auth.requireRole("admin") in the route map.
 */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = gridsAdminMessages.resolve([locale]);
  const formatDuration = (seconds: number): string => {
    if (seconds < 1) return t.current;
    if (seconds < 60) return t.secondsOld({ value: Math.round(seconds) });
    if (seconds < 3600) return t.minutesOld({ value: Math.round(seconds / 60) });
    return t.hoursOld({ value: Math.round(seconds / 3600) });
  };
  const search = (c.req.query("search") ?? "").trim();
  const pageRaw = Number.parseInt(c.req.query("page") ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const offset = (page - 1) * PER_PAGE;

  const [list, summary, operations] = await Promise.all([
    gridsService.base.admin.list({
      pagination: { perPage: PER_PAGE, offset },
      filter: { query: search || undefined },
    }),
    gridsService.base.admin.summary({ filter: { query: search || undefined } }),
    gridsService.operations.health(),
  ]);

  const totalPages = Math.ceil(list.total / list.perPage);
  const baseUrl = search ? `/admin/grids?search=${encodeURIComponent(search)}&page=` : "/admin/grids?page=";
  type BaseRow = (typeof list.items)[number];
  const columns: DataTableColumn<BaseRow>[] = [
    { id: "base", header: t.base, value: (base) => base.name },
    { id: "description", header: t.description, value: (base) => base.description, cellClass: "max-w-xl" },
    { id: "tables", header: t.tables, value: (base) => base.tableCount, headerClass: "text-right", cellClass: "text-right tabular-nums" },
    {
      id: "records",
      header: t.records,
      value: (base) => base.recordCount,
      headerClass: "text-right",
      cellClass: "text-right tabular-nums",
    },
    {
      id: "access",
      header: t.access,
      value: (base) => base.accessCount,
      headerClass: "text-right",
      cellClass: "text-right whitespace-nowrap",
    },
    { id: "actions", header: t.settings, headerClass: "w-px text-right", cellClass: "text-right whitespace-nowrap" },
  ];

  return () => (
    <AdminLayout c={c} title="Grids">
      <div class="app-rows" data-scroll-preserve="grids-admin">
        <div class="flex items-center justify-between gap-3" style="view-transition-name: admin-grids-title">
          <div class="min-w-0">
            <h1 class="text-base font-semibold text-primary">Grids</h1>
          </div>
        </div>

        <StatGrid columns={4}>
          <StatCell
            label={t.bases}
            value={summary.totalBases}
            sub={search ? t.filtered : t.total}
            accent={{ tone: "blue", icon: "ti ti-database" }}
          />
          <StatCell
            label={t.tables}
            value={summary.totalTables}
            sub={search ? t.inFilteredBases : t.total}
            accent={{ tone: "zinc", icon: "ti ti-table" }}
          />
          <StatCell label={t.records} value={summary.totalRecords} sub={t.nonDeleted} accent={{ tone: "zinc", icon: "ti ti-list" }} />
          <StatCell
            label={t.orphanedBases}
            value={summary.orphanedBases}
            sub={summary.orphanedBases > 0 ? t.noAccessEntries : t.allReachable}
            valueClass={summary.orphanedBases > 0 ? "text-red-500" : "text-primary"}
            accent={summary.orphanedBases > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
          />
        </StatGrid>

        <section class="paper flex flex-col gap-2 p-3" aria-labelledby="grids-operations-title">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0">
              <h2 id="grids-operations-title" class="text-xs font-semibold text-primary">
                {t.operations}
              </h2>
              <p class="text-[10px] text-dimmed">{t.operationsDescription}</p>
            </div>
            <nav class="flex flex-wrap items-center gap-1" aria-label={t.observabilityLinks}>
              <ButtonLink variant="secondary" size="sm" href="/admin/observability/telemetry?app=grids">
                <i class="ti ti-activity" aria-hidden="true" /> {t.requests}
              </ButtonLink>
              <ButtonLink variant="secondary" size="sm" href="/admin/observability/jobs?search=grids">
                <i class="ti ti-route" aria-hidden="true" /> {t.traces}
              </ButtonLink>
              <ButtonLink variant="secondary" size="sm" href="/admin/observability/logs?search=grids">
                <i class="ti ti-list-details" aria-hidden="true" /> {t.logs}
              </ButtonLink>
              <ButtonLink variant="secondary" size="sm" href="/admin/observability/metrics">
                <i class="ti ti-chart-histogram" aria-hidden="true" /> {t.metrics}
              </ButtonLink>
              <ButtonLink variant="secondary" size="sm" href="/admin/observability/alerts">
                <i class="ti ti-bell-ringing" aria-hidden="true" /> {t.alerts}
              </ButtonLink>
            </nav>
          </div>

          <StatGrid columns={4} size="sm">
            <StatCell
              label={t.state}
              value={operations.status === "ok" ? t.healthy : operations.status === "warn" ? t.delayed : t.actionNeeded}
              sub={t.observed({
                time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(
                  new Date(operations.observedAt),
                ),
              })}
              valueClass={
                operations.status === "ok"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : operations.status === "warn"
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-red-500"
              }
              accent={{
                tone: operations.status === "ok" ? "emerald" : operations.status === "warn" ? "amber" : "red",
                icon: operations.status === "ok" ? "ti ti-check" : "ti ti-alert-triangle",
              }}
            />
            <StatCell
              label={t.recordEvents}
              value={operations.outbox.pending + operations.outbox.failed}
              sub={
                operations.outbox.pending + operations.outbox.failed > 0
                  ? formatDuration(operations.outbox.oldestActiveAgeSeconds)
                  : t.queueClear
              }
              accent={operations.outbox.dead > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
            />
            <StatCell
              label={t.workflowAttention}
              value={operations.workflows.needsAttention + operations.effects.needsAttention + operations.workflows.staleRunning}
              sub={t.queuedRunning({ queued: operations.workflows.queued, running: operations.workflows.running })}
              accent={
                operations.workflows.needsAttention + operations.effects.needsAttention + operations.workflows.staleRunning > 0
                  ? { tone: "red", icon: "ti ti-alert-circle" }
                  : undefined
              }
            />
            <StatCell
              label="GQL"
              value={operations.gql.total24h.toLocaleString(locale)}
              sub={t.gqlDiagnostics({
                errors: operations.gql.errors24h.toLocaleString(locale),
                p99: Math.round(operations.gql.p99DurationMs24h),
              })}
            />
          </StatGrid>

          {operations.issues.length > 0 ? (
            <div class="grid gap-1 lg:grid-cols-2">
              {operations.issues.map((issue, index) => {
                const localized =
                  [
                    operations.outbox.dead > 0
                      ? { title: t.issueRecordEvents, detail: t.issueRecordEventsDetail({ count: operations.outbox.dead }) }
                      : null,
                    operations.workflows.needsAttention > 0 || operations.effects.needsAttention > 0
                      ? {
                          title: t.issueWorkflowEffects,
                          detail: t.issueWorkflowEffectsDetail({
                            count: operations.workflows.needsAttention + operations.effects.needsAttention,
                          }),
                        }
                      : null,
                    operations.workflows.staleRunning > 0
                      ? { title: t.issueLeases, detail: t.issueLeasesDetail({ count: operations.workflows.staleRunning }) }
                      : null,
                    operations.outbox.failed > 0 || operations.outbox.oldestActiveAgeSeconds > 60
                      ? {
                          title: t.issueEventsDelayed,
                          detail: t.issueEventsDelayedDetail({
                            count: operations.outbox.pending + operations.outbox.failed,
                            seconds: Math.round(operations.outbox.oldestActiveAgeSeconds),
                          }),
                        }
                      : null,
                    operations.workflows.oldestQueuedAgeSeconds > 60
                      ? {
                          title: t.issueQueueDelayed,
                          detail: t.issueQueueDelayedDetail({ seconds: Math.round(operations.workflows.oldestQueuedAgeSeconds) }),
                        }
                      : null,
                    operations.effects.oldestActiveAgeSeconds > 300
                      ? {
                          title: t.issueEffectsDelayed,
                          detail: t.issueEffectsDelayedDetail({ seconds: Math.round(operations.effects.oldestActiveAgeSeconds) }),
                        }
                      : null,
                    operations.federatedDegraded > 0
                      ? { title: t.issueCombined, detail: t.issueCombinedDetail({ count: operations.federatedDegraded }) }
                      : null,
                    operations.emailFailed24h > 0
                      ? { title: t.issueEmail, detail: t.issueEmailDetail({ count: operations.emailFailed24h }) }
                      : null,
                  ].filter((value): value is { title: string; detail: string } => value !== null)[index] ?? issue;
                return (
                  <article
                    class={`rounded-md p-2 ${
                      issue.severity === "error"
                        ? "bg-red-50 text-red-800 dark:bg-red-950/25 dark:text-red-300"
                        : "bg-amber-50 text-amber-900 dark:bg-amber-950/25 dark:text-amber-200"
                    }`}
                  >
                    <div class="flex items-start gap-2">
                      <i
                        class={`ti ${issue.severity === "error" ? "ti-alert-circle" : "ti-clock-exclamation"} mt-0.5 shrink-0`}
                        aria-hidden="true"
                      />
                      <div class="min-w-0">
                        <h3 class="text-xs font-semibold">{localized.title}</h3>
                        <p class="text-[11px] opacity-80">{localized.detail}</p>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : null}
        </section>

        <section class="paper flex flex-col gap-1 overflow-hidden" style="view-transition-name: admin-grids-table">
          <div class="flex flex-col gap-2 p-3">
            <div>
              <h2 class="text-xs font-semibold text-primary">{t.bases}</h2>
              <p class="text-[10px] text-dimmed">{t.shown({ shown: list.items.length, total: list.total })}</p>
            </div>
            <SearchBar action="/admin/grids" value={search} placeholder={t.search} ariaLabel={t.searchLabel} />
            <div class="flex flex-wrap items-center gap-2">
              <div class="ml-auto">
                <AdminGridsSettings />
              </div>
            </div>
          </div>
          <DataTable
            ariaLabel={t.tableLabel}
            rows={list.items}
            columns={columns}
            getRowId={(base) => base.id}
            hoverRows
            class="overflow-x-auto"
            scrollPreserveKey="grids-admin-table"
            empty={search ? t.noMatch({ query: search }) : t.noBases}
            renderCell={({ row: base, col }) => {
              if (col.id === "base") {
                return (
                  <div class="flex min-w-52 items-center gap-2">
                    <span class="app-accent-text inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--ui-selected)] text-[10px]">
                      <i class="ti ti-database" />
                    </span>
                    <span class="truncate font-medium text-primary">{base.name}</span>
                  </div>
                );
              }
              if (col.id === "description") {
                return (
                  <span class="block truncate" title={base.description ?? t.noDescription}>
                    {base.description || <span class="italic">{t.noDescription}</span>}
                  </span>
                );
              }
              if (col.id === "tables") return <span class="text-secondary">{base.tableCount}</span>;
              if (col.id === "records") return <span class="text-secondary">{base.recordCount}</span>;
              if (col.id === "access") {
                return (
                  <span
                    class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      base.accessCount === 0
                        ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                        : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                    }`}
                  >
                    {t.accessEntries({ count: base.accessCount })}
                  </span>
                );
              }
              if (col.id === "actions")
                return (
                  <div class="flex items-center justify-end gap-2">
                    <ButtonLink variant="secondary" size="sm" href={`/admin/grids/${base.shortId}/record-event-failures`}>
                      {t.eventFailures}
                    </ButtonLink>
                    <AdminGridsActions baseId={base.id} baseName={base.name} />
                  </div>
                );
              return "";
            }}
          />
        </section>

        <Pagination currentPage={list.page} totalPages={totalPages} baseUrl={baseUrl} />
      </div>
    </AdminLayout>
  );
});
