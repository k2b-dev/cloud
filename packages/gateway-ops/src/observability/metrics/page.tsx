import { StatCell, StatGrid } from "@k2b/ui";
import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { formatDate, formatNumber } from "@k2b/cloud/shared";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { gatewayOpsMessages } from "../../messages";
import MetricsCatalogue, { type MetricsCatalogueRow } from "./_components/MetricsCatalogue.island";
import MetricsTokens from "./_components/MetricsTokens.island";
import { getMetricsSnapshot, listMetricsTokens, METRICS_ENDPOINT, type MetricsSnapshot } from "./service";

const parseMetricMetadata = (text: string): Map<string, { description: string; type: string; series: number }> => {
  const metrics = new Map<string, { description: string; type: string; series: number }>();
  for (const line of text.split("\n")) {
    if (line.startsWith("# HELP ")) {
      const [, name, description] = line.match(/^# HELP\s+(\S+)\s+(.+)$/) ?? [];
      if (name) metrics.set(name, { description: description ?? "", type: "unknown", series: 0 });
      continue;
    }
    if (line.startsWith("# TYPE ")) {
      const [, name, type] = line.match(/^# TYPE\s+(\S+)\s+(\S+)$/) ?? [];
      if (name) {
        const current = metrics.get(name) ?? { description: "", type: "unknown", series: 0 };
        metrics.set(name, { ...current, type: type ?? "unknown" });
      }
      continue;
    }
    if (line.startsWith("#") || !line.trim()) continue;
    const name = line.match(/^([^{\s]+)/)?.[1];
    if (!name) continue;
    const current = metrics.get(name) ?? { description: "", type: "unknown", series: 0 };
    metrics.set(name, { ...current, series: current.series + 1 });
  }
  return metrics;
};

const buildMetricRows = (snapshot: MetricsSnapshot): MetricsCatalogueRow[] => {
  const metadata = parseMetricMetadata(snapshot.text);
  const sourceByMetric = new Map<string, (typeof snapshot.collectors)[number]>();
  for (const collector of snapshot.collectors) {
    for (const metric of collector.metricNames) sourceByMetric.set(metric, collector);
  }

  return [...metadata.entries()]
    .map(([name, metric]) => {
      const collector = sourceByMetric.get(name);
      return {
        name,
        sourceId: collector?.id ?? "metrics",
        source: collector?.name ?? "Metrics",
        description: metric.description,
        type: metric.type,
        series: metric.series,
        status: collector?.status ?? "ok",
        error: collector?.error ?? null,
      } satisfies MetricsCatalogueRow;
    })
    .sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
};

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const dateConfig = getDateConfig(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const [snapshot, tokens] = await Promise.all([getMetricsSnapshot(), listMetricsTokens()]);
  const okCollectors = snapshot.collectors.filter((collector) => collector.status === "ok").length;
  const unhealthyCollectors = snapshot.collectors.filter((collector) => collector.status !== "ok");
  const metrics = buildMetricRows(snapshot);
  const sources = [...new Map(metrics.map((metric) => [metric.sourceId, { id: metric.sourceId, label: metric.source }])).values()].sort(
    (a, b) => a.label.localeCompare(b.label),
  );

  return () => (
    <AdminLayout c={c} title={t.metrics}>
      <div class="app-rows">
        <div class="min-w-0" style="view-transition-name: admin-metrics-title">
          <h1 class="text-base font-semibold text-primary">{t.metrics}</h1>
          <p class="mt-1 text-xs text-dimmed">{t.metricsDescription}</p>
        </div>

        <StatGrid columns={4}>
          <StatCell
            label={t.scrapeEndpoint}
            value={METRICS_ENDPOINT}
            sub={t.seriesTokenRequired({ count: formatNumber(snapshot.series, { locale }) })}
            accent={{ tone: "blue", icon: "ti ti-plug" }}
          />
          <StatCell
            label={t.collectors}
            value={`${okCollectors}/${snapshot.collectors.length}`}
            sub={unhealthyCollectors.length > 0 ? unhealthyCollectors.map((collector) => collector.name).join(", ") : t.healthy}
            valueClass={unhealthyCollectors.length > 0 ? "text-amber-600 dark:text-amber-400" : "text-primary"}
            title={
              unhealthyCollectors.map((collector) => `${collector.name}: ${collector.error ?? collector.status}`).join("\n") || undefined
            }
            accent={
              unhealthyCollectors.length === 0 ? { tone: "emerald", icon: "ti ti-check" } : { tone: "amber", icon: "ti ti-alert-triangle" }
            }
          />
          <StatCell label={t.series} value={formatNumber(snapshot.series, { locale })} sub={t.lastPayload} />
          <StatCell label={t.tokens} value={formatNumber(tokens.length, { locale })} sub={t.active} accent={{ tone: "zinc", icon: "ti ti-key" }} />
        </StatGrid>

        <p class="text-[10px] text-dimmed">{t.metricsGenerated({ date: formatDate(snapshot.generatedAt, dateConfig) })}</p>

        <MetricsTokens tokens={tokens} />

        <MetricsCatalogue rows={metrics} sources={sources} />
      </div>
    </AdminLayout>
  );
});
