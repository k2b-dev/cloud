import { ChartExplorer, createChartCursor, useLocale } from "@k2b/ui";
import type { VitalChart, VitalRow } from "./charts";
import { vitalValue } from "./charts";
import { browserMessages } from "./messages";
export default function VitalCharts(props: { charts: VitalChart[] }) {
  const locale = useLocale();
  const { t } = browserMessages.resolve([locale()]);
  const date = (value: number) => `${new Date(value).toLocaleString(locale(), { timeZone: "UTC" })} UTC`;
  const cursor = createChartCursor({ formatX: date });
  return (
    <div class="grid grid-cols-1 xl:grid-cols-3 gap-3 items-start">
      {props.charts.map((item) => (
        <ChartExplorer<VitalRow>
          class="paper p-3 min-w-0"
          cursor={cursor}
          title={`${item.name} · p75`}
          description={<span class="text-[10px] text-dimmed">{t.details} · UTC</span>}
          data={item.data}
          height="15rem"
          columns={[
            { id: "time", label: t.interval, value: (row) => date(row.bucket), sortValue: (row) => row.bucket },
            {
              id: "p75",
              label: item.name === "CLS" ? `p75 (${t.unitless})` : "p75 (ms)",
              value: (row) => vitalValue(item.name, row.p75, locale()),
              sortValue: (row) => row.p75,
            },
            {
              id: "count",
              label: t.samples,
              value: (row) => row.count.toLocaleString(locale()),
              sortValue: (row) => row.count,
              align: "right",
            },
          ]}
        />
      ))}
    </div>
  );
}
