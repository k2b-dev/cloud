import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { formatDateTime, formatNumber } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { gatewayOpsMessages } from "../../messages";
import { areaText, observabilityGroups, readAttention } from "../_components/ObservabilityArea";
import ObservabilityNavigation from "../_components/ObservabilityNavigation.island";
import MetricsScreen, { type MetricRow } from "./_components/MetricsScreen.island";
import { metricsQuery } from "./query";
import { getMetricsSnapshot, listMetricsTokens, METRICS_ENDPOINT, type MetricsSnapshot } from "./service";

type CatalogueRow = Omit<MetricRow, "series"> & { sourceId: string; series: number };

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

const buildMetricRows = (snapshot: MetricsSnapshot): CatalogueRow[] => {
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
      };
    })
    .sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
};

/** Metrics on v2. The address holds the catalogue's source, type and search; the page filters itself. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const dateConfig = getDateConfig(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const [snapshot, tokens, attention] = await Promise.all([getMetricsSnapshot(), listMetricsTokens(), readAttention()]);
  const number = (value: number) => formatNumber(value, { locale });
  const unhealthy = snapshot.collectors.filter((collector) => collector.status !== "ok");
  const rows = buildMetricRows(snapshot);
  const sources = [...new Map(rows.map((row) => [row.sourceId, { id: row.sourceId, label: row.source }])).values()].sort((a, b) =>
    a.label.localeCompare(b.label),
  );
  const url = new URL(c.req.url);
  const query = metricsQuery(locale, sources, url.searchParams.get("source") ?? undefined);
  const address = query.parse(url.searchParams);
  const { source, type } = address.state.filters;
  const needle = address.state.search?.trim().toLowerCase() ?? "";
  const metrics = rows.filter(
    (row) =>
      (!source || row.sourceId === source) &&
      (!type || row.type === type) &&
      (!needle || [row.name, row.source, row.type, row.description].some((value) => value.toLowerCase().includes(needle))),
  );
  const date = (value: string | null) => formatDateTime(value, dateConfig);
  const ignored = address.issues.length > 0 ? address.issues.map((issue) => `${issue.param}=${issue.value}`).join(", ") : null;
  const area = areaText(locale);
  const groups = observabilityGroups(c, locale, attention);

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[{ title: t.start, href: "/" }, { title: area.area, href: "/admin/observability" }, { title: area.metrics }]}
    >
      <ObservabilityNavigation label={area.area} current="metrics" groups={groups} />
      <MetricsScreen
        area={{ title: area.area, groups, markLabel: area.needsAttention }}
        sources={sources}
        state={address.state}
        ignored={ignored}
        cells={[
          {
            icon: "plug",
            label: t.scrapeEndpoint,
            value: METRICS_ENDPOINT,
            meta: t.seriesTokenRequired({ count: number(snapshot.series) }),
          },
          {
            icon: unhealthy.length ? "alert-triangle" : "check",
            label: t.collectors,
            value: `${number(snapshot.collectors.length - unhealthy.length)}/${number(snapshot.collectors.length)}`,
            meta: unhealthy.length ? unhealthy.map((collector) => collector.name).join(", ") : t.healthy,
            tone: unhealthy.length ? "warn" : undefined,
          },
          { icon: "chart-dots", label: t.series, value: number(snapshot.series), meta: t.lastPayload },
          { icon: "key", label: t.tokens, value: number(tokens.length), meta: t.active },
        ]}
        generatedAt={t.metricsGenerated({ date: date(snapshot.generatedAt) })}
        unhealthy={unhealthy.map((collector) => ({ name: collector.name, error: collector.error ?? collector.status }))}
        tokens={tokens.map((token) => ({
          id: token.id,
          name: token.name,
          line: [
            token.tokenPrefix,
            token.scopes.join(", ") || "—",
            `${t.expires}: ${date(token.expiresAt)}`,
            `${t.lastUsed}: ${date(token.lastUsedAt)}`,
          ].join(" · "),
        }))}
        metrics={metrics.map((row) => ({ ...row, series: number(row.series) }))}
        metricsTotal={number(rows.length)}
      />
    </Layout>
  );
});
