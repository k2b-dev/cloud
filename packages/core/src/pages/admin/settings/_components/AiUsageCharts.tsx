import type { AiUsageReport } from "@k2b/cloud/ai/admin";
import { formatNumber } from "@k2b/cloud/shared";
import { ChartExplorer, createChartCursor, prepareChartSnapshot, useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";
import { aiUsageMessages } from "./ai-usage-messages";

export default function AiUsageCharts(props: {
  timeline: AiUsageReport["timeline"];
  range: AiUsageReport["query"]["range"];
  unit: string;
}) {
  const locale = useLocale(),
    t = () => aiUsageMessages.resolve([locale()]).t;
  const date = (at: number) => `${new Date(at).toLocaleString(locale(), { timeZone: "UTC" })} UTC`;
  const n = (v: number) => formatNumber(v, { locale: locale(), decimals: 0 });
  const cursor = createChartCursor({ formatX: date });
  const amount = (value: number) => `${value.toLocaleString(locale(), { maximumSignificantDigits: 6 })} ${props.unit}`;
  const build = (metrics: { label: string; value: (p: AiUsageReport["timeline"][number]) => number | null }[], format = n) => {
    const series = metrics.map((m) => ({
      label: m.label,
      data: props.timeline.flatMap((p) => (m.value(p) === null ? [] : [{ x: Date.parse(p.bucket), y: m.value(p)! }])),
    }));
    const rows = series.flatMap((s, seriesIndex) =>
      s.data.map((p, index) => ({ key: `${seriesIndex}:${index}`, at: p.x, label: s.label, value: p.y })),
    );
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return {
      rows,
      chart: prepareChartSnapshot(
        {
          kind: "line",
          series,
          smooth: false,
          legend: metrics.length > 1,
          maxGap: (props.range === "24h" ? 3600000 : 86400000) * 1.5,
          xAxis: {
            ticks: 3,
            format: (value) =>
              new Date(value).toLocaleString(locale(), {
                timeZone: "UTC",
                ...(props.range === "24h" ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" }),
              }),
          },
          yAxis: { format },
        },
        {
          key: ({ datum }) => `${datum.seriesIndex ?? 0}:${datum.index}`,
          tooltip: ({ datum }) => {
            const r = byKey.get(`${datum.seriesIndex ?? 0}:${datum.index}`)!;
            return { title: date(r.at), rows: [{ label: r.label, value: format(r.value) }] };
          },
        },
      ),
    };
  };
  const usage = createMemo(() =>
    build([
      { label: t().turns, value: (p) => p.turns },
      { label: t().errors, value: (p) => p.failed },
    ]),
  );
  const tokens = createMemo(() => build([{ label: t().tokens, value: (p) => p.tokens }]));
  const costs = createMemo(() => build([{ label: t().cost, value: (p) => p.cost }], amount));
  type Row = ReturnType<typeof build>["rows"][number];
  const columns = [
    { id: "at", label: "UTC", value: (r: Row) => date(r.at), sortValue: (r: Row) => r.at },
    { id: "label", label: t().runKind, value: (r: Row) => r.label },
    { id: "value", label: t().tokens, value: (r: Row) => n(r.value), sortValue: (r: Row) => r.value },
  ];
  return (
    <div class="grid min-w-0 gap-3 xl:grid-cols-2">
      <ChartExplorer
        class="paper p-3 xl:col-span-2"
        height="14rem"
        title={`${t().costOverTime} (${props.unit})`}
        description={<span class="text-xs text-dimmed">{t().costOverTimeDescription}</span>}
        data={costs()}
        cursor={cursor}
        columns={columns.map((c) => (c.id === "value" ? { ...c, label: t().cost, value: (r: Row) => amount(r.value) } : c))}
      />
      <ChartExplorer
        class="paper p-3"
        height="14rem"
        title={t().usageOverTime}
        description={<span class="text-xs text-dimmed">{t().usageOverTimeDescription}</span>}
        data={usage()}
        cursor={cursor}
        columns={columns.map((c) => (c.id === "value" ? { ...c, label: t().runs } : c))}
      />
      <ChartExplorer
        class="paper p-3"
        height="14rem"
        title={t().tokenVolume}
        description={<span class="text-xs text-dimmed">{t().tokenVolumeDescription}</span>}
        data={tokens()}
        cursor={cursor}
        columns={columns}
      />
    </div>
  );
}
