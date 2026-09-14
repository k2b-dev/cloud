import { ChartExplorer, createChartCursor, useLocale, Placeholder, ButtonLink } from "@k2b/ui";
import { gatewayOpsMessages } from "../messages";
import type { OperationalChart, OperationalRow } from "./operational-charts";

export default function OperationalCharts(props: { charts: OperationalChart[]; columns?: 1 | 2 | 3 }) {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  const date = (at: number) => `${new Date(at).toLocaleString(locale(), { timeZone: "UTC" })} UTC`;
  const cursor = createChartCursor({ formatX: date });
  return (
    <div
      class={`grid gap-3 items-start ${props.columns === 3 ? "xl:grid-cols-3" : props.columns === 2 ? "xl:grid-cols-2" : "grid-cols-1"}`}
    >
      {props.charts.map((chart) => (
        <div class="min-w-0">
          {chart.error ? (
            <section class="paper p-3">
              <h2 class="text-xs font-semibold">{chart.title}</h2>
              <Placeholder state="error" variant="compact" description={chart.error} />
            </section>
          ) : (
            <ChartExplorer<OperationalRow>
              class="paper p-3"
              title={chart.title}
              description={chart.description ? <span class="text-[10px] text-dimmed">{chart.description}</span> : undefined}
              data={chart.data}
              cursor={cursor}
              height={chart.data.chart.kind === "barGauge" ? "22rem" : "16rem"}
              columns={[
                ...(chart.data.chart.kind === "line"
                  ? [
                      {
                        id: "at",
                        label: `${t.time} · UTC`,
                        value: (row: OperationalRow) => (row.at === undefined ? "—" : date(row.at)),
                        sortValue: (row: OperationalRow) => row.at ?? null,
                      },
                    ]
                  : []),
                { id: "label", label: t.series, value: (row) => row.label, sortValue: (row) => row.label },
                { id: "value", label: t.chartValue, value: (row) => row.formatted, sortValue: (row) => row.value, align: "right" },
              ]}
            />
          )}
          {chart.href && chart.linkLabel && (
            <ButtonLink class="mt-2" href={chart.href} variant="secondary" size="sm">
              {chart.linkLabel}
              <i class="ti ti-arrow-up-right" aria-hidden="true" />
            </ButtonLink>
          )}
        </div>
      ))}
    </div>
  );
}
