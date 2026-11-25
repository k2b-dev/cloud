import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { formatBytes, formatDateTime, formatNumber } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { prepareOperationalCharts } from "../../frontend/operational-charts";
import { gatewayOpsMessages } from "../../messages";
import type { KeyCell } from "../_components/KeyCells";
import { areaText, observabilityGroups, readAttention } from "../_components/ObservabilityArea";
import ObservabilityNavigation from "../_components/ObservabilityNavigation.island";
import { getPostgresDiagnostics, listPostgresIndexes, listPostgresSessions, type PostgresTableDiagnostic } from "../data/service";
import PostgresScreen from "./_components/PostgresScreen.island";
import { legacyPostgresHref, type PostgresState, postgresQuery } from "./query";

/** Seconds to a compact age; sessions report ages, not durations. */
const formatSeconds = (seconds: number | null, locale: string): string => {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${formatNumber(Math.round(seconds), { locale })}s`;
  if (seconds < 3600) return `${formatNumber(Math.round(seconds / 60), { locale })}m`;
  return `${formatNumber(Math.round(seconds / 3600), { locale })}h`;
};

const sortTables = (rows: PostgresTableDiagnostic[], sort: PostgresState["sort"]["field"]): PostgresTableDiagnostic[] => {
  const sorted = [...rows];
  switch (sort) {
    case "rows":
      return sorted.sort((a, b) => b.estimatedRows - a.estimatedRows || a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
    case "dead":
      return sorted.sort((a, b) => b.deadRows - a.deadRows || b.totalBytes - a.totalBytes);
    case "schema":
      return sorted.sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
    case "name":
      return sorted.sort((a, b) => a.name.localeCompare(b.name) || a.schema.localeCompare(b.schema));
    default:
      return sorted.sort((a, b) => b.totalBytes - a.totalBytes || a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
  }
};

/** Postgres on v2. The address holds the schema, the search and the order of the tables; the page filters itself. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const dateConfig = getDateConfig(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const url = new URL(c.req.url);
  const legacy = legacyPostgresHref(url.searchParams);
  if (legacy) return c.redirect(legacy);
  const [diagnostics, [sessionsResult, indexesResult], attention] = await Promise.all([
    getPostgresDiagnostics(locale),
    Promise.allSettled([listPostgresSessions(), listPostgresIndexes()]),
    readAttention(),
  ]);
  const schemas = diagnostics.schemaRows.map((row) => row.schema);
  const query = postgresQuery(locale, schemas, url.searchParams.get("schema") ?? undefined);
  const address = query.parse(url.searchParams);
  const state = address.state;
  const number = (value: number) => formatNumber(value, { locale });
  const bytes = (value: number) => formatBytes(value, { locale });
  const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value : [];
  const indexes = indexesResult.status === "fulfilled" ? indexesResult.value : [];
  const blocked = sessions.filter((session) => session.blockedBy.length > 0);
  // Cumulative since the last statistics reset: "not used since then", not a claim that the index is unnecessary.
  const unusedIndexBytes = indexes
    .filter((index) => index.scans === 0 && !index.isPrimary)
    .reduce((sum, index) => sum + index.sizeBytes, 0);
  const needle = state.search?.trim().toLowerCase() ?? "";
  const schema = state.filters.schema;

  const tables = sortTables(
    diagnostics.tableRows.filter(
      (table) =>
        (!schema || table.schema === schema) &&
        (!needle ||
          `${table.schema}.${table.name}`.toLowerCase().includes(needle) ||
          table.warnings.some((warning) => warning.includes(needle))),
    ),
    state.sort.field,
  );
  const extensions = diagnostics.extensionRows.filter(
    (extension) =>
      !needle ||
      `${extension.name} ${extension.defaultVersion ?? ""} ${extension.installedVersion ?? ""} ${extension.comment ?? ""}`
        .toLowerCase()
        .includes(needle),
  );
  const bySchema = [
    ...tables.reduce((totals, table) => {
      const current = totals.get(table.schema) ?? { totalBytes: 0, estimatedRows: 0 };
      current.totalBytes += table.totalBytes;
      current.estimatedRows += table.estimatedRows;
      totals.set(table.schema, current);
      return totals;
    }, new Map<string, { totalBytes: number; estimatedRows: number }>()),
  ].map(([name, totals]) => ({ schema: name, ...totals }));
  const top = <T,>(rows: T[], value: (row: T) => number, label: (row: T) => string) =>
    rows
      .slice()
      .sort((left, right) => value(right) - value(left) || label(left).localeCompare(label(right)))
      .slice(0, 10)
      .map((row) => ({ label: label(row), value: value(row) }));
  const [schemaSize, largest, schemaRows] = prepareOperationalCharts(
    [
      {
        kind: "bar",
        title: t.sizeBySchema,
        description: t.topSchemasDescription,
        data: top(
          bySchema,
          (row) => row.totalBytes,
          (row) => row.schema,
        ),
        unit: "bytes",
      },
      {
        kind: "bar",
        title: t.largestTables,
        description: t.topTenDescription,
        data: top(
          tables,
          (row) => row.totalBytes,
          (row) => `${row.schema}.${row.name}`,
        ),
        unit: "bytes",
      },
      {
        kind: "bar",
        title: t.rowsBySchema,
        description: t.plannerRowsDescription,
        data: top(
          bySchema,
          (row) => row.estimatedRows,
          (row) => row.schema,
        ),
        unit: "number",
      },
    ],
    locale,
  );

  const runtime = diagnostics.runtime;
  const critical = diagnostics.warnings.some((warning) => warning.tone === "red");
  const cells: KeyCell[] = [
    {
      icon: "database",
      label: t.storage,
      value: bytes(diagnostics.totalBytes),
      meta: t.tablesCount({ count: number(diagnostics.tables) }),
      tone: diagnostics.available ? undefined : "bad",
    },
    {
      icon: "plug-connected",
      label: t.connections,
      value: `${number(runtime.connections)}/${number(runtime.maxConnections)}`,
      meta: t.activeCount({ count: number(runtime.activeConnections) }),
      tone: runtime.maxConnections > 0 && runtime.connections / runtime.maxConnections >= 0.8 ? "warn" : undefined,
    },
    {
      icon: "lock",
      label: t.lockWaits,
      value: number(runtime.waitingLocks),
      meta: runtime.waitingLocks ? t.oldestQuerySeconds({ seconds: Math.round(runtime.oldestWaitingQuerySeconds) }) : t.none,
      tone: runtime.waitingLocks ? "warn" : undefined,
    },
    {
      icon: critical ? "alert-circle" : "alert-triangle",
      label: t.warnings,
      value: number(diagnostics.warnings.length),
      meta: diagnostics.warnings.length ? t.needsReview : t.none,
      tone: critical ? "bad" : diagnostics.warnings.length ? "warn" : undefined,
    },
  ];
  const runtimeCells: KeyCell[] = [
    { icon: "lock-x", label: t.deadlocks, value: diagnostics.available ? number(runtime.deadlocks) : "—", meta: t.sinceReset },
    {
      icon: "clock",
      label: t.oldestTransaction,
      value: diagnostics.available ? formatSeconds(runtime.oldestTransactionSeconds, locale) : "—",
    },
    {
      icon: "clock-play",
      label: t.oldestActiveQuery,
      value: diagnostics.available ? formatSeconds(runtime.oldestQuerySeconds, locale) : "—",
    },
    {
      icon: "plug",
      label: t.extensions,
      value: `${number(diagnostics.installedExtensions)}/${number(diagnostics.availableExtensions)}`,
      meta: t.installedAvailable,
    },
  ];
  const ignored = address.issues.length > 0 ? address.issues.map((issue) => `${issue.param}=${issue.value}`).join(", ") : null;
  const area = areaText(locale);
  const groups = observabilityGroups(c, locale, attention);

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[{ title: t.start, href: "/" }, { title: area.area, href: "/admin/observability" }, { title: area.postgres }]}
    >
      <ObservabilityNavigation label={area.area} current="postgres" groups={groups} />
      <PostgresScreen
        area={{ title: area.area, groups, markLabel: area.needsAttention }}
        schemas={schemas}
        state={state}
        ignored={ignored}
        cells={cells}
        runtime={runtimeCells}
        warnings={diagnostics.warnings.map((warning) => ({
          tone: warning.tone === "red" ? "bad" : "warn",
          title: warning.title,
          text: warning.detail,
        }))}
        tables={tables.map((table) => ({
          key: `${table.schema}.${table.name}`,
          name: table.name,
          schema: table.schema,
          rows: number(table.estimatedRows),
          total: bytes(table.totalBytes),
          heap: bytes(table.tableBytes),
          indexes: bytes(table.indexBytes),
          seqScans: number(table.seqScans),
          indexScans: number(table.indexScans),
          dead: number(table.deadRows),
          analyzed: formatDateTime(table.lastAutoanalyze ?? table.lastAnalyze, dateConfig),
          warnings: table.warnings,
        }))}
        tablesTotal={number(diagnostics.tableRows.length)}
        charts={{ schemaSize: schemaSize!, largest: largest!, schemaRows: schemaRows! }}
        sessions={{
          error: sessionsResult.status === "rejected" ? t.postgresSessionsUnavailable : null,
          summary:
            sessions.length === 0
              ? t.noClientBackendsReported
              : t.sessionSummary({
                  total: number(sessions.length),
                  blocked: number(blocked.length),
                  unnamed: number(sessions.filter((session) => !session.application).length),
                }),
          rows: sessions.map((session) => ({
            // A PID is an identifier, not a quantity: its digits stay ungrouped.
            pid: String(session.pid),
            state:
              session.blockedBy.length > 0
                ? { label: t.blockedBy({ pids: session.blockedBy.join(", ") }), status: "bad" }
                : { label: session.state ?? t.unknown, status: session.state === "active" ? "ok" : null },
            application: session.application,
            wait: session.waitEvent ? `${session.waitEventType}: ${session.waitEvent}` : "—",
            transactionAge: formatSeconds(session.transactionAgeSeconds, locale),
            queryAge: formatSeconds(session.queryAgeSeconds, locale),
            query: session.query ?? "—",
          })),
        }}
        indexes={{
          error: indexesResult.status === "rejected" ? t.postgresIndexesUnavailable : null,
          summary: t.indexesSummary({ count: number(indexes.length), size: bytes(unusedIndexBytes) }),
          rows: indexes.map((index) => ({
            key: `${index.schema}.${index.name}`,
            name: index.name,
            table: `${index.schema}.${index.table}`,
            kind: index.isPrimary ? t.primary : index.isUnique ? t.unique : t.index,
            size: bytes(index.sizeBytes),
            scans: number(index.scans),
            unused: index.scans === 0 && !index.isPrimary,
          })),
        }}
        extensions={{
          summary: t.extensionSummary({
            installed: number(diagnostics.installedExtensions),
            available: number(diagnostics.availableExtensions),
          }),
          rows: extensions.map((extension) => ({
            name: extension.name,
            installed: Boolean(extension.installed),
            installedVersion: extension.installedVersion ?? "—",
            defaultVersion: extension.defaultVersion ?? "—",
            comment: extension.comment ?? "—",
          })),
        }}
      />
    </Layout>
  );
});
