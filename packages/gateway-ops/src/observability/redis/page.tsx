import { ButtonLink, DataTable, type DataTableColumn, StatCell, StatGrid } from "@k2b/ui";
import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { formatBytes, formatNumber, formatPercent } from "@valentinkolb/cloud/shared";
import { AdminLayout } from "@valentinkolb/cloud/ssr";
import { SearchBar } from "@valentinkolb/cloud/ssr/islands";
import { ssr } from "../../config";
import ObservabilityChart from "../../frontend/ObservabilityChart.island";
import { getRedisDiagnostics, type RedisPrefixDiagnostic } from "../data/service";
import RedisDataFilters from "./_components/RedisDataFilters.island";
import { gatewayOpsMessages } from "../../messages";

const normalize = (value: string): string => value.toLowerCase();

/**
 * The service marks fatal problems (diagnostics unreachable) red and routine
 * advisories amber. This page ignored the tone and painted everything amber,
 * so "Redis is down" looked like "some keys have no expiry".
 */
const warningClasses = (tone: string): string =>
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
  const { t } = gatewayOpsMessages.resolve([locale]);
  const url = new URL(c.req.url);
  const search = url.searchParams.get("search")?.trim() ?? "";
  const selectedDepth = Math.min(3, Math.max(1, Number(url.searchParams.get("depth") ?? "3")));
  const diagnostics = await getRedisDiagnostics(locale);
  const searchNeedle = normalize(search);

  const searchActionParams = new URLSearchParams(url.searchParams);
  searchActionParams.delete("search");
  const searchAction = searchActionParams.toString()
    ? `/admin/observability/redis?${searchActionParams.toString()}`
    : "/admin/observability/redis";

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
  const redisPrefixHref = (prefix: string): string => {
    const params = new URLSearchParams(url.searchParams);
    params.set("search", prefix);
    return `/admin/observability/redis?${params.toString()}`;
  };

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
          <StatCell label={t.keys} value={formatNumber(diagnostics.dbSize, { locale })} sub={t.expiringKeys({ count: formatNumber(expiringKeys, { locale }) })} />
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
            sub={runtime.connectedClients === null ? t.clientsUnknown : t.clientCount({ count: formatNumber(runtime.connectedClients, { locale }) })}
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

        {diagnostics.warnings.length ? (
          <section class={warningGridClass(diagnostics.warnings.length)}>
            {diagnostics.warnings.map((warning) => (
              <article class={warningClasses(warning.tone)}>
                <div class="flex items-start gap-2">
                  <i class="ti ti-alert-triangle mt-0.5 shrink-0 text-amber-600 dark:text-amber-300" />
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
          <h2 class="text-xs font-semibold text-primary">{t.prefixDistribution}</h2>
          <p class="text-[10px] text-dimmed">
            {diagnostics.scanComplete
              ? t.keysScanned({ count: formatNumber(diagnostics.sampledKeys, { locale }) })
              : t.keysSampled({ count: formatNumber(diagnostics.sampledKeys, { locale }), total: formatNumber(diagnostics.dbSize, { locale }) })}
          </p>
          <ObservabilityChart kind="donut" class="mt-2 h-72 text-dimmed" data={prefixChartData} legend />
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

        <section class="paper overflow-hidden">
          <div class="flex flex-col gap-2 px-3 py-2">
            <div>
              <h2 class="text-xs font-semibold text-primary">{t.prefixes}</h2>
              <p class="text-[10px] text-dimmed">{t.prefixesAtDepth({ count: formatNumber(filteredPrefixes.length, { locale }), depth: selectedDepth })}</p>
            </div>
            <SearchBar action={searchAction} value={search} placeholder={t.searchRedisPrefixes} ariaLabel={t.searchRedisPrefixesLabel} />
            <RedisDataFilters search={search} depth={selectedDepth} />
          </div>
          <DataTable
            rows={filteredPrefixes}
            columns={prefixColumns}
            getRowId={(prefix) => `${prefix.depth}:${prefix.prefix}`}
            density="compact"
            hoverRows
            class="max-h-[34rem] overflow-auto"
            empty={t.noMatchingRedisPrefixes}
            renderCell={({ col, value, render }) => {
              if (col.id === "count") return <span class="tabular-nums">{formatNumber(Number(value ?? 0), { locale })}</span>;
              if (col.id === "share") return <span class="tabular-nums">{formatPercent(Number(value ?? 0) || 0, { locale })}</span>;
              return render(value);
            }}
          />
        </section>
      </div>
    </AdminLayout>
  );
});
