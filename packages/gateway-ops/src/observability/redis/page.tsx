import { ButtonLink, DataTable, type DataTableColumn, NoticeCard, StatCell, StatGrid } from "@k2b/ui";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { formatBytes, formatNumber, formatPercent } from "@k2b/cloud/shared";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import OperationalCharts from "../../frontend/OperationalCharts.island";
import { prepareOperationalCharts } from "../../frontend/operational-charts";
import { getRedisDiagnostics, type RedisPrefixDiagnostic } from "../data/service";
import { buildRedisFilterUrl, parseRedisFilterFromUrl } from "./_components/filter-state";
import RedisDataFilters from "./_components/RedisDataFilters.island";
import { gatewayOpsMessages } from "../../messages";

const normalize = (value: string): string => value.toLowerCase();

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const url = new URL(c.req.url);
  const filter = parseRedisFilterFromUrl(url);
  const { search, depth: selectedDepth } = filter;
  const diagnostics = await getRedisDiagnostics(locale);
  const searchNeedle = normalize(search);

  const filteredPrefixes = diagnostics.prefixes.filter((prefix) => {
    if (prefix.depth !== selectedDepth) return false;
    if (!searchNeedle) return true;
    return normalize(prefix.prefix).includes(searchNeedle);
  });

  const prefixChartData = filteredPrefixes
    .slice()
    .sort((left, right) => right.count - left.count || left.prefix.localeCompare(right.prefix))
    .slice(0, 10)
    .map((prefix) => ({ label: prefix.prefix, value: prefix.count }));
  const redisPrefixHref = (prefix: string): string => buildRedisFilterUrl(filter, { search: prefix });

  const expiringKeys = diagnostics.keyspace.reduce((sum, row) => sum + row.expires, 0);
  const runtime = diagnostics.runtime;
  const memoryPressure =
    runtime.usedMemoryBytes !== null && runtime.maxMemoryBytes !== null && runtime.maxMemoryBytes > 0
      ? runtime.usedMemoryBytes / runtime.maxMemoryBytes > 0.85
      : false;
  const memorySub =
    runtime.maxMemoryBytes && runtime.maxMemoryBytes > 0
      ? t.ofValue({ value: formatBytes(runtime.maxMemoryBytes, { locale }) })
      : runtime.usedMemoryBytes === null
        ? t.unavailable
        : t.noMaxMemory;
  const prefixColumns: DataTableColumn<RedisPrefixDiagnostic>[] = [
    { id: "prefix", header: t.prefix, value: (prefix) => prefix.prefix, cellClass: "font-mono text-[11px] min-w-[220px]" },
    { id: "depth", header: t.depth, value: (prefix) => prefix.depth, headerClass: "text-right", cellClass: "text-right" },
    { id: "count", header: t.sampleCount, value: (prefix) => prefix.count, headerClass: "text-right", cellClass: "text-right" },
    { id: "share", header: t.sampleShare, value: (prefix) => prefix.share, headerClass: "text-right", cellClass: "text-right" },
  ];

  return () => (
    <AdminLayout c={c} title="Redis">
      <div class="app-rows">
        <div class="min-w-0" style="view-transition-name: admin-redis-title">
          <h1 class="text-base font-semibold text-primary">Redis</h1>
          <p class="mt-1 text-xs text-dimmed">{t.redisDescription}</p>
        </div>

        <StatGrid columns={5}>
          <StatCell
            label={t.keys}
            value={formatNumber(diagnostics.dbSize, { locale })}
            sub={t.expiringKeys({ count: formatNumber(expiringKeys, { locale }) })}
          />
          <StatCell
            label={t.memory}
            value={runtime.usedMemoryBytes === null ? "—" : formatBytes(runtime.usedMemoryBytes, { locale })}
            sub={memorySub}
            valueClass={memoryPressure ? "text-amber-600 dark:text-amber-400" : "text-primary"}
            accent={memoryPressure ? { tone: "amber", icon: "ti ti-alert-triangle" } : undefined}
          />
          <StatCell
            label={t.evicted}
            value={runtime.evictedKeys === null ? "—" : formatNumber(runtime.evictedKeys, { locale })}
            sub={runtime.maxMemoryPolicy ?? t.policyUnknown}
            valueClass={(runtime.evictedKeys ?? 0) > 0 ? "text-red-500" : "text-primary"}
            accent={(runtime.evictedKeys ?? 0) > 0 ? { tone: "red", icon: "ti ti-trash-x" } : undefined}
          />
          <StatCell
            label={t.hitRate}
            value={runtime.hitRate === null ? "—" : formatPercent(runtime.hitRate, { locale })}
            sub={
              runtime.connectedClients === null
                ? t.clientsUnknown
                : t.clientCount({ count: formatNumber(runtime.connectedClients, { locale }) })
            }
            valueClass={runtime.hitRate !== null && runtime.hitRate < 0.8 ? "text-amber-600 dark:text-amber-400" : "text-primary"}
          />
          <StatCell
            label={t.warnings}
            value={formatNumber(diagnostics.warnings.length, { locale })}
            sub={diagnostics.warnings.length === 0 ? t.none : t.seeBelow}
            valueClass={diagnostics.warnings.length > 0 ? "text-amber-600 dark:text-amber-400" : "text-primary"}
            accent={diagnostics.warnings.length > 0 ? { tone: "amber", icon: "ti ti-alert-triangle" } : undefined}
          />
        </StatGrid>

        <NoticeCard.Grid items={diagnostics.warnings}>
          {(warning) => <NoticeCard tone={warning.tone === "red" ? "danger" : "warning"} title={warning.title} detail={warning.detail} />}
        </NoticeCard.Grid>

        <section>
          <OperationalCharts
            charts={prepareOperationalCharts(
              [
                {
                  kind: "bar",
                  title: t.prefixDistribution,
                  description: diagnostics.scanComplete
                    ? t.keysScanned({ count: formatNumber(diagnostics.sampledKeys, { locale }) })
                    : t.keysSampled({
                        count: formatNumber(diagnostics.sampledKeys, { locale }),
                        total: formatNumber(diagnostics.dbSize, { locale }),
                      }),
                  data: prefixChartData,
                },
              ],
              locale,
            )}
          />
          <nav class="mt-2 flex flex-wrap gap-1" aria-label={t.filterSampledKeys}>
            {prefixChartData.slice(0, 6).map((prefix) => (
              <ButtonLink
                href={redisPrefixHref(prefix.label)}
                variant="secondary"
                size="sm"
                class="max-w-full truncate"
                title={prefix.label}
              >
                {prefix.label}
              </ButtonLink>
            ))}
          </nav>
        </section>

        <DataTable.Panel>
          <DataTable.Header
            title={t.prefixes}
            subtitle={t.prefixesAtDepth({ count: formatNumber(filteredPrefixes.length, { locale }), depth: selectedDepth })}
          />
          <DataTable.Controls>
            <RedisDataFilters search={search} depth={selectedDepth} />
          </DataTable.Controls>
          <DataTable
            rows={filteredPrefixes}
            columns={prefixColumns}
            getRowId={(prefix) => `${prefix.depth}:${prefix.prefix}`}
            density="compact"
            hoverRows
            surface="plain"
            class="max-h-[34rem]"
            empty={t.noMatchingRedisPrefixes}
            renderCell={({ col, value, render }) => {
              if (col.id === "count") return <span class="tabular-nums">{formatNumber(Number(value ?? 0), { locale })}</span>;
              if (col.id === "share") return <span class="tabular-nums">{formatPercent(Number(value ?? 0) || 0, { locale })}</span>;
              return render(value);
            }}
          />
        </DataTable.Panel>
      </div>
    </AdminLayout>
  );
});
