import { Chart, DataPanel, useLocale } from "@k2b/ui";
import type { AiUsageReport } from "@k2b/cloud/ai/admin";
import { formatNumber } from "@k2b/cloud/shared";
import { aiUsageMessages } from "./ai-usage-messages";

export default function AiUsageCharts(props: { timeline: AiUsageReport["timeline"]; range: AiUsageReport["query"]["range"] }) {
  const locale = useLocale();
  const t = () => aiUsageMessages.resolve([locale()]).t;
  const xAxis = {
    ticks: 3,
    format: (value: number) =>
      new Intl.DateTimeFormat(
        locale(),
        props.range === "24h" ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" },
      ).format(new Date(value)),
  };
  return (
    <div class="grid min-w-0 gap-2">
      <DataPanel
        title={t().usageOverTime}
        subtitle={t().usageOverTimeDescription}
        isEmpty={!props.timeline.some((point) => point.turns > 0)}
        empty={t().noTurns}
      >
        <Chart
          kind="line"
          smooth={false}
          class="h-72 w-full text-dimmed"
          series={[
            { label: t().turns, data: props.timeline.map((point) => ({ x: new Date(point.bucket).getTime(), y: point.turns })) },
            { label: t().errors, data: props.timeline.map((point) => ({ x: new Date(point.bucket).getTime(), y: point.failed })) },
          ]}
          xAxis={xAxis}
          legend
          area
          interactive
        />
      </DataPanel>
      <DataPanel
        title={t().tokenVolume}
        subtitle={t().tokenVolumeDescription}
        isEmpty={!props.timeline.some((point) => (point.tokens ?? 0) > 0)}
        empty={t().noTokens}
      >
        <Chart
          kind="line"
          smooth={false}
          class="h-56 w-full text-dimmed"
          series={[
            {
              label: t().tokens,
              data: props.timeline
                .filter((point) => point.tokens !== null)
                .map((point) => ({ x: new Date(point.bucket).getTime(), y: point.tokens! })),
            },
          ]}
          xAxis={xAxis}
          yAxis={{ format: (value) => formatNumber(value, { locale: locale(), compact: true }) }}
          area
          interactive
        />
      </DataPanel>
    </div>
  );
}
