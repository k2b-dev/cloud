import { ButtonLink, DataPanel, DataTable, type DataTableColumn, StatCell, StatGrid, StatusBadge } from "@k2b/ui";
import { type AuthContext, getDateConfig, getLocale } from "@valentinkolb/cloud/server";
import { formatBytes, formatDateTime as formatDate, formatNumber } from "@valentinkolb/cloud/shared";
import { AdminLayout } from "@valentinkolb/cloud/ssr";
import { SearchBar } from "@valentinkolb/cloud/ssr/islands";
import { ssr } from "../../config";

/** Seconds to a compact age; sessions report ages, not durations. */
const formatSeconds = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
};

import ObservabilityChart from "../../frontend/ObservabilityChart.island";
import {
  getPostgresDiagnostics,
  listPostgresIndexes,
  listPostgresSessions,
  type PostgresExtensionDiagnostic,
  type PostgresIndexDiagnostic,
  type PostgresSession,
  type PostgresTableDiagnostic,
} from "../data/service";
import PostgresDataFilters from "./_components/PostgresDataFilters.island";
import { gatewayOpsMessages } from "../../messages";

const normalize = (value: string): string => value.toLowerCase();

const sortTables = (rows: PostgresTableDiagnostic[], sort: string): PostgresTableDiagnostic[] => {
  const sorted = [...rows];
  switch (sort) {
    case "rows-desc":
      return sorted.sort((a, b) => b.estimatedRows - a.estimatedRows || a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
    case "dead-desc":
      return sorted.sort((a, b) => b.deadRows - a.deadRows || b.totalBytes - a.totalBytes);
    case "schema-asc":
      return sorted.sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
    case "name-asc":
      return sorted.sort((a, b) => a.name.localeCompare(b.name) || a.schema.localeCompare(b.schema));
    case "size-desc":
    default:
      return sorted.sort((a, b) => b.totalBytes - a.totalBytes || a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
  }
};

const warningClasses = (tone: "amber" | "red"): string =>
  tone === "red"
    ? "rounded-lg border border-red-200 bg-red-50 p-3 text-red-900 dark:border-red-500/30 dark:bg-red-950/25 dark:text-red-100"
    : "rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/25 dark:text-amber-100";
const warningGridClass = (count: number): string => {
  if (count <= 1) return "grid gap-2";
  if (count === 2) return "grid gap-2 md:grid-cols-2";
  return "grid gap-2 md:grid-cols-2 xl:grid-cols-3";
};

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const dateConfig = getDateConfig(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const url = new URL(c.req.url);
  const search = url.searchParams.get("search")?.trim() ?? "";
  const selectedSchema = url.searchParams.get("schema")?.trim() || "all";
  const selectedSort = url.searchParams.get("sort")?.trim() || "size-desc";
  const [diagnostics, sessions, indexes] = await Promise.all([getPostgresDiagnostics(locale), listPostgresSessions(), listPostgresIndexes()]);
  const blockedSessions = sessions.filter((session) => session.blockedBy.length > 0);
  const unnamedSessions = sessions.filter((session) => !session.application).length;
  // Cumulative since the last statistics reset, so this is "not used since
  // then" rather than a claim that the index is unnecessary.
  const unusedIndexBytes = indexes
    .filter((index) => index.scans === 0 && !index.isPrimary)
    .reduce((sum, index) => sum + index.sizeBytes, 0);

  const sessionColumns: DataTableColumn<PostgresSession>[] = [
    { id: "pid", header: "PID", cellClass: "tabular-nums" },
    { id: "state", header: t.state },
    { id: "application", header: t.application },
    { id: "wait", header: t.waitingOn },
    { id: "txAge", header: t.transaction, subtitle: t.age, align: "right" },
    { id: "queryAge", header: t.query, subtitle: t.age, align: "right" },
    { id: "query", header: t.statement, cellClass: "max-w-[320px]" },
  ];

  const indexColumns: DataTableColumn<PostgresIndexDiagnostic>[] = [
    { id: "index", header: t.index, cellClass: "min-w-[240px]" },
    { id: "kind", header: t.kind },
    { id: "size", header: t.size, align: "right" },
    { id: "scans", header: t.scans, subtitle: t.sinceReset, align: "right" },
  ];
  const hasCriticalWarning = diagnostics.warnings.some((warning) => warning.tone === "red");
  const searchNeedle = normalize(search);
  const schemas = diagnostics.schemaRows.map((row) => row.schema).sort((a, b) => a.localeCompare(b));

  const searchActionParams = new URLSearchParams(url.searchParams);
  searchActionParams.delete("search");
  const searchAction = searchActionParams.toString()
    ? `/admin/observability/postgres?${searchActionParams.toString()}`
    : "/admin/observability/postgres";

  const filteredTables = sortTables(
    diagnostics.tableRows.filter((table) => {
      if (selectedSchema !== "all" && table.schema !== selectedSchema) return false;
      if (!searchNeedle) return true;
      return (
        normalize(`${table.schema}.${table.name}`).includes(searchNeedle) ||
        table.warnings.some((warning) => warning.includes(searchNeedle))
      );
    }),
    selectedSort,
  );

  const filteredExtensions = diagnostics.extensionRows.filter((extension) => {
    if (!searchNeedle) return true;
    return normalize(
      `${extension.name} ${extension.defaultVersion ?? ""} ${extension.installedVersion ?? ""} ${extension.comment ?? ""}`,
    ).includes(searchNeedle);
  });

  const filteredSchemaTotals = [
    ...filteredTables.reduce((bySchema, table) => {
      const current = bySchema.get(table.schema) ?? { totalBytes: 0, estimatedRows: 0 };
      current.totalBytes += table.totalBytes;
      current.estimatedRows += table.estimatedRows;
      bySchema.set(table.schema, current);
      return bySchema;
    }, new Map<string, { totalBytes: number; estimatedRows: number }>()),
  ]
    .map(([schema, totals]) => ({ schema, ...totals }))
    .sort((left, right) => right.totalBytes - left.totalBytes || left.schema.localeCompare(right.schema));
  const schemaChartData = filteredSchemaTotals.slice(0, 10).map((schema) => ({ label: schema.schema, value: schema.totalBytes }));
  const schemaRowsChartData = filteredSchemaTotals
    .slice()
    .sort((left, right) => right.estimatedRows - left.estimatedRows || left.schema.localeCompare(right.schema))
    .slice(0, 10)
    .map((schema) => ({ label: schema.schema, value: schema.estimatedRows }));
  const tableChartData = filteredTables
    .slice()
    .sort((left, right) => right.totalBytes - left.totalBytes)
    .slice(0, 10)
    .map((table) => ({ label: `${table.schema}.${table.name}`, value: table.totalBytes }));
  const postgresFilterHref = (updates: { schema?: string; search?: string }): string => {
    const params = new URLSearchParams(url.searchParams);
    if (updates.schema !== undefined) {
      if (updates.schema === "all") params.delete("schema");
      else params.set("schema", updates.schema);
    }
    if (updates.search !== undefined) {
      if (updates.search) params.set("search", updates.search);
      else params.delete("search");
    }
    const query = params.toString();
    return query ? `/admin/observability/postgres?${query}` : "/admin/observability/postgres";
  };

  const tableColumns: DataTableColumn<PostgresTableDiagnostic>[] = [
    { id: "table", header: t.table, value: (table) => `${table.schema}.${table.name}`, cellClass: "min-w-[220px]" },
    {
      id: "rows",
      header: t.rows,
      subtitle: t.estimated,
      value: (table) => table.estimatedRows,
      headerClass: "text-right",
      cellClass: "text-right",
    },
    {
      id: "total",
      header: t.total,
      subtitle: t.relation,
      value: (table) => table.totalBytes,
      headerClass: "text-right",
      cellClass: "text-right",
    },
    {
      id: "tableBytes",
      header: t.table,
      subtitle: t.heap,
      value: (table) => table.tableBytes,
      headerClass: "text-right",
      cellClass: "text-right",
    },
    { id: "indexBytes", header: t.indexes, value: (table) => table.indexBytes, headerClass: "text-right", cellClass: "text-right" },
    { id: "dead", header: t.deadRows, value: (table) => table.deadRows, headerClass: "text-right", cellClass: "text-right" },
    { id: "analyze", header: t.analyze, value: (table) => table.lastAutoanalyze ?? table.lastAnalyze, cellClass: "whitespace-nowrap" },
    { id: "warnings", header: t.signals, value: (table) => table.warnings.join(", ") },
  ];

  const extensionColumns: DataTableColumn<PostgresExtensionDiagnostic>[] = [
    { id: "name", header: t.extension, value: (extension) => extension.name, cellClass: "font-mono text-[11px]" },
    { id: "status", header: t.status, value: (extension) => extension.installed },
    { id: "installed", header: t.installed, value: (extension) => extension.installedVersion },
    { id: "default", header: t.default, value: (extension) => extension.defaultVersion },
    { id: "comment", header: t.description, value: (extension) => extension.comment, cellClass: "max-w-[34rem]" },
  ];

  return () => (
    <AdminLayout c={c} title="Postgres">
      <div class="app-rows">
        <div class="min-w-0" style="view-transition-name: admin-postgres-title">
          <h1 class="text-base font-semibold text-primary">Postgres</h1>
          <p class="mt-1 text-xs text-dimmed">{t.postgresDescription}</p>
        </div>

        <StatGrid columns={5}>
          <StatCell
            label={t.storage}
            value={formatBytes(diagnostics.totalBytes, { locale })}
            sub={t.tablesCount({ count: formatNumber(diagnostics.tables, { locale }) })}
            accent={{ tone: diagnostics.available ? "blue" : "red", icon: "ti ti-database" }}
          />
          <StatCell
            label={t.connections}
            value={`${formatNumber(diagnostics.runtime.connections, { locale })}/${formatNumber(diagnostics.runtime.maxConnections, { locale })}`}
            sub={t.activeCount({ count: formatNumber(diagnostics.runtime.activeConnections, { locale }) })}
            accent={
              diagnostics.runtime.maxConnections > 0 && diagnostics.runtime.connections / diagnostics.runtime.maxConnections >= 0.8
                ? { tone: "amber", icon: "ti ti-plug-connected" }
                : undefined
            }
          />
          <StatCell
            label={t.lockWaits}
            value={formatNumber(diagnostics.runtime.waitingLocks, { locale })}
            sub={diagnostics.runtime.waitingLocks ? t.oldestQuerySeconds({ seconds: Math.round(diagnostics.runtime.oldestWaitingQuerySeconds) }) : t.none}
            accent={diagnostics.runtime.waitingLocks ? { tone: "amber", icon: "ti ti-lock" } : undefined}
          />
          <StatCell
            label={t.extensions}
            value={`${formatNumber(diagnostics.installedExtensions, { locale })}/${formatNumber(diagnostics.availableExtensions, { locale })}`}
            sub={t.installedAvailable}
            accent={{ tone: "zinc", icon: "ti ti-plug" }}
          />
          <StatCell
            label={t.warnings}
            value={formatNumber(diagnostics.warnings.length, { locale })}
            sub={diagnostics.warnings.length ? t.needsReview : t.none}
            valueClass={
              hasCriticalWarning
                ? "text-red-600 dark:text-red-400"
                : diagnostics.warnings.length
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-primary"
            }
            accent={
              hasCriticalWarning
                ? { tone: "red", icon: "ti ti-alert-circle" }
                : diagnostics.warnings.length
                  ? { tone: "amber", icon: "ti ti-alert-triangle" }
                  : { tone: "emerald", icon: "ti ti-check" }
            }
          />
        </StatGrid>

        {diagnostics.warnings.length ? (
          <section class={warningGridClass(diagnostics.warnings.length)}>
            {diagnostics.warnings.map((warning) => (
              <article class={warningClasses(warning.tone)}>
                <div class="flex items-start gap-2">
                  <i
                    class={`ti mt-0.5 shrink-0 ${
                      warning.tone === "red"
                        ? "ti-alert-circle text-red-600 dark:text-red-300"
                        : "ti-alert-triangle text-amber-600 dark:text-amber-300"
                    }`}
                  />
                  <div class="min-w-0">
                    <h2 class="text-xs font-semibold">{warning.title}</h2>
                    <p class="mt-1 text-[11px] opacity-80">{warning.detail}</p>
                  </div>
                </div>
              </article>
            ))}
          </section>
        ) : null}

        <section class="paper p-3">
          <h2 class="text-xs font-semibold text-primary">{t.storageView}</h2>
          <p class="text-[10px] text-dimmed">{t.storageViewDescription({ count: formatNumber(filteredTables.length, { locale }), total: formatNumber(diagnostics.tableRows.length, { locale }) })}</p>
          <div class="mt-2 flex flex-col gap-2">
            <SearchBar
              action={searchAction}
              value={search}
              placeholder={t.searchPostgresTables}
              ariaLabel={t.searchPostgresTablesLabel}
            />
            <PostgresDataFilters search={search} schema={selectedSchema} sort={selectedSort} schemas={schemas} />
          </div>
        </section>

        <section class="grid gap-2 xl:grid-cols-3">
          <article class="paper p-3">
            <h2 class="text-xs font-semibold text-primary">{t.sizeBySchema}</h2>
            <p class="text-[10px] text-dimmed">{t.topSchemasDescription}</p>
            <ObservabilityChart kind="bar" class="mt-2 h-56 text-dimmed" data={schemaChartData} yFormat="bytes" />
            <nav class="mt-2 flex flex-wrap gap-1" aria-label={t.filterTablesBySchema}>
              {schemaChartData.slice(0, 5).map((schema) => (
                <ButtonLink
                  href={postgresFilterHref({ schema: schema.label })}
                  variant={selectedSchema === schema.label ? "primary" : "secondary"}
                  size="sm"
                  aria-current={selectedSchema === schema.label ? "true" : undefined}
                >
                  {schema.label}
                </ButtonLink>
              ))}
            </nav>
          </article>
          <article class="paper p-3">
            <h2 class="text-xs font-semibold text-primary">{t.largestTables}</h2>
            <p class="text-[10px] text-dimmed">{t.topTenDescription}</p>
            <ObservabilityChart kind="donut" class="mt-2 h-64 text-dimmed" data={tableChartData} legend />
            <nav class="mt-2 flex flex-wrap gap-1" aria-label={t.inspectLargeTable}>
              {tableChartData.slice(0, 5).map((table) => (
                <ButtonLink
                  href={postgresFilterHref({ search: table.label })}
                  variant="secondary"
                  size="sm"
                  class="max-w-full truncate"
                  title={table.label}
                >
                  {table.label}
                </ButtonLink>
              ))}
            </nav>
          </article>
          <article class="paper p-3">
            <h2 class="text-xs font-semibold text-primary">{t.rowsBySchema}</h2>
            <p class="text-[10px] text-dimmed">{t.plannerRowsDescription}</p>
            <ObservabilityChart kind="bar" class="mt-2 h-56 text-dimmed" data={schemaRowsChartData} yFormat="number" />
          </article>
        </section>

        <DataPanel
          title={t.sessions}
          subtitle={
            sessions.length === 0
              ? t.noClientBackendsReported
              : t.sessionSummary({ total: sessions.length, blocked: blockedSessions.length, unnamed: unnamedSessions })
          }
          isEmpty={sessions.length === 0}
          empty={t.noClientBackends}
        >
          <DataTable
            rows={sessions}
            columns={sessionColumns}
            getRowId={(session) => String(session.pid)}
            density="compact"
            class="max-h-[26rem] overflow-auto"
            renderCell={({ row, col, value, render }) => {
              if (col.id === "state")
                return (
                  <StatusBadge
                    tone={row.blockedBy.length > 0 ? "error" : row.state === "active" ? "running" : "neutral"}
                    label={row.blockedBy.length > 0 ? t.blockedBy({ pids: row.blockedBy.join(", ") }) : (row.state ?? t.unknown)}
                    variant="dot"
                  />
                );
              if (col.id === "application")
                return row.application ? (
                  <span class="text-[10px] text-dimmed">{row.application}</span>
                ) : (
                  // Cloud does not set application_name yet, so an unattributable
                  // connection is the finding rather than a rendering gap.
                  <span class="text-[10px] text-amber-600 dark:text-amber-400" title={t.unnamedConnection}>
                    {t.unnamed}
                  </span>
                );
              if (col.id === "txAge")
                return <span class="text-[10px] tabular-nums text-dimmed">{formatSeconds(row.transactionAgeSeconds)}</span>;
              if (col.id === "queryAge")
                return <span class="text-[10px] tabular-nums text-dimmed">{formatSeconds(row.queryAgeSeconds)}</span>;
              if (col.id === "wait")
                return <span class="text-[10px] text-dimmed">{row.waitEvent ? `${row.waitEventType}: ${row.waitEvent}` : "—"}</span>;
              if (col.id === "query")
                return (
                  <code class="block truncate text-[10px] text-dimmed" title={row.query ?? undefined}>
                    {row.query ?? "—"}
                  </code>
                );
              return render(value);
            }}
          />
        </DataPanel>

        <DataPanel
          title={t.indexes}
          subtitle={t.indexesSummary({ count: indexes.length, size: formatBytes(unusedIndexBytes, { locale }) })}
          isEmpty={indexes.length === 0}
          empty={t.noUserIndexes}
        >
          <DataTable
            rows={indexes}
            columns={indexColumns}
            getRowId={(index) => `${index.schema}.${index.name}`}
            density="compact"
            class="max-h-[26rem] overflow-auto"
            renderCell={({ row, col, value, render }) => {
              if (col.id === "index")
                return (
                  <div class="min-w-0">
                    <code class="block truncate text-[10px] text-primary">{row.name}</code>
                    <span class="text-[9px] text-dimmed">
                      {row.schema}.{row.table}
                    </span>
                  </div>
                );
              if (col.id === "size") return <span class="text-[10px] tabular-nums text-dimmed">{formatBytes(row.sizeBytes, { locale })}</span>;
              if (col.id === "scans")
                return (
                  <span
                    class={`text-[10px] tabular-nums ${row.scans === 0 && !row.isPrimary ? "text-amber-600 dark:text-amber-400" : "text-dimmed"}`}
                  >
                    {formatNumber(row.scans, { locale })}
                  </span>
                );
              if (col.id === "kind")
                return <span class="text-[10px] text-dimmed">{row.isPrimary ? t.primary : row.isUnique ? t.unique : t.index.toLowerCase()}</span>;
              return render(value);
            }}
          />
        </DataPanel>

        <section class="paper overflow-hidden">
          <div class="px-3 py-2">
            <h2 class="text-xs font-semibold text-primary">{t.tables}</h2>
            <p class="text-[10px] text-dimmed">{t.matchingTables({ count: formatNumber(filteredTables.length, { locale }) })}</p>
          </div>
          <DataTable
            rows={filteredTables}
            columns={tableColumns}
            getRowId={(table) => `${table.schema}.${table.name}`}
            density="compact"
            hoverRows
            class="max-h-[34rem] overflow-auto"
            rowClass={(table) => (table.warnings.length > 0 ? "bg-amber-500/[0.04]" : "")}
            empty={t.noMatchingTables}
            renderCell={({ row: table, col, value, render }) => {
              if (col.id === "table") {
                return (
                  <span title={`${table.schema}.${table.name}`}>
                    <span class="text-dimmed">{table.schema}</span>
                    <span class="text-dimmed">.</span>
                    <span class="font-medium text-primary">{table.name}</span>
                  </span>
                );
              }
              if (col.id === "rows" || col.id === "dead") return <span class="tabular-nums">{formatNumber(Number(value ?? 0), { locale })}</span>;
              if (col.id === "total" || col.id === "tableBytes" || col.id === "indexBytes")
                return <span class="tabular-nums">{formatBytes(Number(value ?? 0), { locale })}</span>;
              if (col.id === "analyze") return <span class="text-dimmed">{formatDate(value as string | null, dateConfig)}</span>;
              if (col.id === "warnings") {
                return table.warnings.length ? (
                  <div class="flex flex-wrap gap-1">
                    {table.warnings.map((warning) => (
                      <span class="tag bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">{warning}</span>
                    ))}
                  </div>
                ) : (
                  <span class="text-dimmed">-</span>
                );
              }
              return render(value);
            }}
          />
        </section>

        <section class="paper overflow-hidden">
          <div class="px-3 py-2">
            <h2 class="text-xs font-semibold text-primary">{t.extensions}</h2>
            <p class="text-[10px] text-dimmed">{t.extensionSummary({ installed: formatNumber(diagnostics.installedExtensions, { locale }), available: formatNumber(diagnostics.availableExtensions, { locale }) })}</p>
          </div>
          <DataTable
            rows={filteredExtensions}
            columns={extensionColumns}
            getRowId={(extension) => extension.name}
            density="compact"
            hoverRows
            class="max-h-80 overflow-auto"
            empty={t.noMatchingExtensions}
            renderCell={({ row: extension, col, value, render }) => {
              if (col.id === "status") {
                return extension.installed ? (
                  <span class="tag bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                    <i class="ti ti-check text-[9px]" />
                    {t.installed.toLowerCase()}
                  </span>
                ) : (
                  <span class="tag bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{t.available}</span>
                );
              }
              if (col.id === "comment") return <span title={extension.comment ?? undefined}>{extension.comment ?? "-"}</span>;
              return render(value);
            }}
          />
        </section>
      </div>
    </AdminLayout>
  );
});
