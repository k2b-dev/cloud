import { ChartExplorer, prepareChartSnapshot, useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";
import type { AiQuotaReport } from "@k2b/cloud/shared";
import { quotaMessages } from "./ai-quota-messages";

export default function AiQuotaCharts(props: { report: AiQuotaReport; modelName: (id: string) => string }) {
  const locale = useLocale(),
    t = () => quotaMessages.resolve([locale()]).t;
  const number = (n: number) => n.toLocaleString(locale(), { maximumSignificantDigits: 6 });
  const timeline = createMemo(() => {
    const rows = props.report.timeline
      .filter((p) => p.cost !== null)
      .map((p) => ({ key: p.at, at: p.at, label: t().cost, value: p.cost! }));
    const row = (_series: number, index: number) => rows[index]!;
    return {
      rows,
      chart: prepareChartSnapshot(
        {
          kind: "line",
          smooth: false,
          legend: true,
          maxGap: (props.report.query.range === "24h" ? 3600000 : 86400000) * 1.5,
          series: [{ label: t().cost, data: rows.map((r) => ({ x: Date.parse(r.at), y: r.value })) }],
          xAxis: {
            ticks: 3,
            format: (at) =>
              new Date(at).toLocaleString(locale(), {
                timeZone: "UTC",
                month: "short",
                day: "numeric",
                ...(props.report.query.range === "24h" ? { hour: "2-digit" } : {}),
              }),
          },
        },
        {
          key: ({ datum }) => row(datum.seriesIndex ?? 0, datum.index).key,
          tooltip: ({ datum }) => {
            const r = row(datum.seriesIndex ?? 0, datum.index);
            return {
              title: `${new Date(r.at).toLocaleString(locale(), { timeZone: "UTC" })} UTC`,
              rows: [{ label: r.label, value: number(r.value) }],
            };
          },
        },
      ),
    };
  });
  const models = createMemo(() => {
    const rows = props.report.models
      .filter((m) => m.cost !== null)
      .map((m) => ({ key: m.model, label: props.modelName(m.model), value: m.cost! }));
    return {
      rows,
      chart: prepareChartSnapshot(
        { kind: "bar", data: rows.map((r) => ({ label: r.label, value: r.value })) },
        {
          key: ({ datum }) => rows[datum.index]!.key,
          tooltip: ({ datum }) => ({
            title: rows[datum.index]!.label,
            rows: [{ label: t().cost, value: number(rows[datum.index]!.value) }],
          }),
        },
      ),
    };
  });
  return (
    <div class="grid min-w-0 gap-3 xl:grid-cols-2">
      <ChartExplorer
        title={t().timeline}
        description={<span class="text-xs text-dimmed">{t().chartHint}</span>}
        class="paper p-3"
        height="14rem"
        data={timeline()}
        columns={[
          { id: "at", label: "UTC", value: (r) => new Date(r.at).toLocaleString(locale(), { timeZone: "UTC" }) },
          { id: "series", label: t().scope, value: (r) => r.label },
          { id: "cost", label: t().cost, value: (r) => number(r.value), sortValue: (r) => r.value },
        ]}
      />
      <ChartExplorer
        title={t().byModel}
        description={<span class="text-xs text-dimmed">{t().modelChartHint}</span>}
        class="paper p-3"
        height="14rem"
        data={models()}
        columns={[
          { id: "model", label: t().scope, value: (r) => r.label },
          { id: "cost", label: t().cost, value: (r) => number(r.value), sortValue: (r) => r.value },
        ]}
      />
    </div>
  );
}
