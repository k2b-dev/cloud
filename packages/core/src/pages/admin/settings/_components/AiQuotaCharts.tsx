import { ChartExplorer, prepareChartSnapshot, useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";
import type { AiQuotaReport } from "@k2b/cloud/shared";
import { quotaMessages } from "./ai-quota-messages";

export default function AiQuotaCharts(props: { report: AiQuotaReport; modelName: (id: string) => string }) {
  const locale = useLocale(),
    t = () => quotaMessages.resolve([locale()]).t;
  const number = (n: number) => n.toLocaleString(locale());
  const timeline = createMemo(() => {
    const rows = props.report.timeline
      .filter((p) => p.measured > 0)
      .flatMap((p) => [
        { key: `${p.at}:input`, at: p.at, label: t().input, value: p.input },
        { key: `${p.at}:output`, at: p.at, label: t().output, value: p.output },
      ]);
    const row = (series: number, index: number) => rows[index * 2 + series]!;
    return {
      rows,
      chart: prepareChartSnapshot(
        {
          kind: "line",
          smooth: false,
          legend: true,
          maxGap: (props.report.query.range === "24h" ? 3600000 : 86400000) * 1.5,
          series: [t().input, t().output].map((label, i) => ({
            label,
            data: rows.filter((_, j) => j % 2 === i).map((r) => ({ x: Date.parse(r.at), y: r.value })),
          })),
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
      .filter((m) => m.measured > 0)
      .map((m) => ({ key: m.model, label: props.modelName(m.model), value: m.input + m.output }));
    return {
      rows,
      chart: prepareChartSnapshot(
        { kind: "bar", data: rows.map((r) => ({ label: r.label, value: r.value })) },
        {
          key: ({ datum }) => rows[datum.index]!.key,
          tooltip: ({ datum }) => ({
            title: rows[datum.index]!.label,
            rows: [{ label: t().tokens, value: number(rows[datum.index]!.value) }],
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
          { id: "tokens", label: t().tokens, value: (r) => number(r.value), sortValue: (r) => r.value },
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
          { id: "tokens", label: t().tokens, value: (r) => number(r.value), sortValue: (r) => r.value },
        ]}
      />
    </div>
  );
}
