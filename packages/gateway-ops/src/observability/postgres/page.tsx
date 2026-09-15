import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { formatBytes, formatDateTime as formatDate, formatNumber } from "@k2b/cloud/shared";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ButtonLink, DataPanel, DataTable, type DataTableColumn, NoticeCard, PanelHeader, StatCell, StatGrid, StatusBadge } from "@k2b/ui";
import { ssr } from "../../config";

/** Seconds to a compact age; sessions report ages, not durations. */
const formatSeconds = (seconds: number | null, locale: string): string => {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${formatNumber(Math.round(seconds), { locale })}s`;
  if (seconds < 3600) return `${formatNumber(Math.round(seconds / 60), { locale })}m`;
  return `${formatNumber(Math.round(seconds / 3600), { locale })}h`;
};

import OperationalCharts from "../../frontend/OperationalCharts.island";
import { prepareOperationalCharts } from "../../frontend/operational-charts";
import { gatewayOpsMessages } from "../../messages";
import {
  getPostgresDiagnostics,
  listPostgresIndexes,
  listPostgresSessions,
  type PostgresExtensionDiagnostic,
  type PostgresIndexDiagnostic,
  type PostgresSession,
  type PostgresTableDiagnostic,
} from "../data/service";
import { buildPostgresFilterUrl, parsePostgresFilterFromUrl } from "./_components/filter-state";
import PostgresDataFilters from "./_components/PostgresDataFilters.island";

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

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const dateConfig = getDateConfig(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const url = new URL(c.req.url);
  const filter = parsePostgresFilterFromUrl(url);
  const { search, schema: selectedSchema, sort: selectedSort } = filter;
  const [diagnostics, [sessionsResult, indexesResult]] = await Promise.all([
    getPostgresDiagnostics(locale),
    Promise.allSettled([listPostgresSessions(), listPostgresIndexes()]),
  ]);
  const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value : [];
  const indexes = indexesResult.status === "fulfilled" ? indexesResult.value : [];
  const blockedSessions = sessions.filter((session) => session.blockedBy.length > 0);
  const unnamedSessions = sessions.filter((session) => !session.application).length;
  // Cumulative since the last statistics reset, so this is "not used since
  // then" rather than a claim that the index is unnecessary.
  const unusedIndexBytes = indexes
    .filter((index) => index.scans === 0 && !index.isPrimary)
    .reduce((sum, index) => sum + index.sizeBytes, 0);

  const sessionColumns: DataTableColumn<PostgresSession>[] = [
    { id: "pid", header: "PID", value: (session) => session.pid, cellClass: "tabular-nums" },
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
  const postgresFilterHref = (updates: { schema?: string; search?: string }): string => buildPostgresFilterUrl(filter, updates);

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
    { id: "seqScans", header: t.sequentialScans, subtitle: t.sinceReset, value: (table) => table.seqScans, align: "right" },
    { id: "indexScans", header: t.indexScans, subtitle: t.sinceReset, value: (table) => table.indexScans, align: "right" },
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

        <p class="text-xs text-dimmed">{t.postgresConnectionsDescription}</p>

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
            sub={
              diagnostics.runtime.waitingLocks
                ? t.oldestQuerySeconds({ seconds: Math.round(diagnostics.runtime.oldestWaitingQuerySeconds) })
                : t.none
            }
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

        <StatGrid columns={3}>
          <StatCell
            label={t.deadlocks}
            value={diagnostics.available ? formatNumber(diagnostics.runtime.deadlocks, { locale }) : "—"}
            sub={t.sinceReset}
          />
          <StatCell
            label={t.oldestTransaction}
            value={diagnostics.available ? formatSeconds(diagnostics.runtime.oldestTransactionSeconds, locale) : "—"}
          />
          <StatCell
            label={t.oldestActiveQuery}
            value={diagnostics.available ? formatSeconds(diagnostics.runtime.oldestQuerySeconds, locale) : "—"}
          />
        </StatGrid>

        <NoticeCard.Grid items={diagnostics.warnings}>
          {(warning) => <NoticeCard tone={warning.tone === "red" ? "danger" : "warning"} title={warning.title} detail={warning.detail} />}
        </NoticeCard.Grid>

        <section class="paper p-3">
          <PanelHeader
            title={t.storageView}
            subtitle={t.storageViewDescription({
              count: formatNumber(filteredTables.length, { locale }),
              total: formatNumber(diagnostics.tableRows.length, { locale }),
            })}
          />
          <div class="mt-2 flex flex-col gap-2">
            <PostgresDataFilters search={search} schema={selectedSchema} sort={selectedSort} schemas={schemas} />
          </div>
        </section>

        <DataPanel
          title={t.sessions}
          subtitle={
            sessionsResult.status === "rejected"
              ? undefined
              : sessions.length === 0
                ? t.noClientBackendsReported
                : t.sessionSummary({
                    total: formatNumber(sessions.length, { locale }),
                    blocked: formatNumber(blockedSessions.length, { locale }),
                    unnamed: formatNumber(unnamedSessions, { locale }),
                  })
          }
          error={sessionsResult.status === "rejected" ? t.postgresSessionsUnavailable : null}
          isEmpty={sessions.length === 0}
          empty={t.noClientBackends}
        >
          <DataTable
            ariaLabel={t.sessions}
            rows={sessions}
            columns={sessionColumns}
            getRowId={(session) => String(session.pid)}
            density="compact"
            surface="plain"
            class="max-h-[26rem]"
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
                  <span class="text-[10px] text-amber-600 dark:text-amber-400" title={t.unnamedConnection}>
                    {t.unnamed}
                  </span>
                );
              if (col.id === "txAge")
                return <span class="text-[10px] tabular-nums text-dimmed">{formatSeconds(row.transactionAgeSeconds, locale)}</span>;
              if (col.id === "queryAge")
                return <span class="text-[10px] tabular-nums text-dimmed">{formatSeconds(row.queryAgeSeconds, locale)}</span>;
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
          subtitle={
            indexesResult.status === "fulfilled"
              ? t.indexesSummary({ count: formatNumber(indexes.length, { locale }), size: formatBytes(unusedIndexBytes, { locale }) })
              : undefined
          }
          error={indexesResult.status === "rejected" ? t.postgresIndexesUnavailable : null}
          isEmpty={indexes.length === 0}
          empty={t.noUserIndexes}
        >
          <DataTable
            ariaLabel={t.indexes}
            rows={indexes}
            columns={indexColumns}
            getRowId={(index) => `${index.schema}.${index.name}`}
            density="compact"
            surface="plain"
            class="max-h-[26rem]"
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
              if (col.id === "size")
                return <span class="text-[10px] tabular-nums text-dimmed">{formatBytes(row.sizeBytes, { locale })}</span>;
              if (col.id === "scans")
                return (
                  <span
                    class={`text-[10px] tabular-nums ${row.scans === 0 && !row.isPrimary ? "text-amber-600 dark:text-amber-400" : "text-dimmed"}`}
                  >
                    {formatNumber(row.scans, { locale })}
                  </span>
                );
              if (col.id === "kind")
                return (
                  <span class="text-[10px] text-dimmed">{row.isPrimary ? t.primary : row.isUnique ? t.unique : t.index.toLowerCase()}</span>
                );
              return render(value);
            }}
          />
        </DataPanel>

        <DataTable.Panel>
          <DataTable.Header title={t.tables} subtitle={t.matchingTables({ count: formatNumber(filteredTables.length, { locale }) })} />
          <DataTable
            rows={filteredTables}
            columns={tableColumns}
            getRowId={(table) => `${table.schema}.${table.name}`}
            density="compact"
            hoverRows
            surface="plain"
            class="max-h-[34rem]"
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
              if (col.id === "rows" || col.id === "dead" || col.id === "seqScans" || col.id === "indexScans")
                return <span class="tabular-nums">{formatNumber(Number(value ?? 0), { locale })}</span>;
              if (col.id === "total" || col.id === "tableBytes" || col.id === "indexBytes")
                return <span class="tabular-nums">{formatBytes(Number(value ?? 0), { locale })}</span>;
              if (col.id === "analyze") return <span class="text-dimmed">{formatDate(value as string | null, dateConfig)}</span>;
              if (col.id === "warnings") {
                return table.warnings.length ? (
                  <div class="flex flex-wrap gap-1">
                    {table.warnings.map((warning) => (
                      <StatusBadge tone="warning" label={warning} />
                    ))}
                  </div>
                ) : (
                  <span class="text-dimmed">-</span>
                );
              }
              return render(value);
            }}
          />
        </DataTable.Panel>

        <section class="grid gap-2 xl:grid-cols-3">
          <article class="min-w-0">
            <OperationalCharts
              charts={prepareOperationalCharts(
                [{ kind: "bar", title: t.sizeBySchema, description: t.topSchemasDescription, data: schemaChartData, unit: "bytes" }],
                locale,
              )}
            />
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
          <article class="min-w-0">
            <OperationalCharts
              charts={prepareOperationalCharts(
                [{ kind: "bar", title: t.largestTables, description: t.topTenDescription, data: tableChartData, unit: "bytes" }],
                locale,
              )}
            />
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
          <article class="min-w-0">
            <OperationalCharts
              charts={prepareOperationalCharts(
                [{ kind: "bar", title: t.rowsBySchema, description: t.plannerRowsDescription, data: schemaRowsChartData, unit: "number" }],
                locale,
              )}
            />
          </article>
        </section>

        <DataTable.Panel>
          <DataTable.Header
            title={t.extensions}
            subtitle={t.extensionSummary({
              installed: formatNumber(diagnostics.installedExtensions, { locale }),
              available: formatNumber(diagnostics.availableExtensions, { locale }),
            })}
          />
          <DataTable
            rows={filteredExtensions}
            columns={extensionColumns}
            getRowId={(extension) => extension.name}
            density="compact"
            hoverRows
            surface="plain"
            class="max-h-80"
            empty={t.noMatchingExtensions}
            renderCell={({ row: extension, col, value, render }) => {
              if (col.id === "status") {
                return (
                  <StatusBadge
                    tone={extension.installed ? "ok" : "neutral"}
                    label={extension.installed ? t.installed.toLowerCase() : t.available}
                  />
                );
              }
              if (col.id === "comment") return <span title={extension.comment ?? undefined}>{extension.comment ?? "-"}</span>;
              return render(value);
            }}
          />
        </DataTable.Panel>
      </div>
    </AdminLayout>
  );
});
