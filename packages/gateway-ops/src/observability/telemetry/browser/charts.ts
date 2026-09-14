import { prepareChartSnapshot, type ChartExplorerData } from "@k2b/ui";
import type { WebVitalsOverview, WebVitalName } from "@k2b/cloud/services";
import { browserMessages } from "./messages";
export type VitalRow = { key: string; bucket: number; p75: number; count: number };
export type VitalChart = { name: WebVitalName; data: ChartExplorerData<VitalRow> };
export function vitalValue(name: WebVitalName, value: number | null | undefined, locale: string): string {
  return value == null
    ? "—"
    : `${value.toLocaleString(locale, { maximumFractionDigits: name === "CLS" ? 3 : 0 })}${name === "CLS" ? "" : " ms"}`;
}
export function buildVitalCharts(overview: WebVitalsOverview, locale: string): VitalChart[] {
  const { t } = browserMessages.resolve([locale]);
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  const names: WebVitalName[] = ["LCP", "INP", "CLS"];
  return names.map((name) => {
    const rows = overview.series
      .filter((item) => item.name === name)
      .map((item) => ({ key: `${name}:${item.bucket}`, bucket: item.bucket, p75: item.p75, count: item.count }));
    const chart = prepareChartSnapshot(
      {
        kind: "scatter",
        series: [{ label: name, data: rows.map((row) => ({ x: row.bucket, y: row.p75 })) }],
        legend: false,
        xAxis: { format: (value) => date.format(value) },
        yAxis: { format: (value) => vitalValue(name, value, locale) },
      },
      {
        key: ({ datum }) => rows[datum.index]!.key,
        tooltip: ({ datum }) => {
          const row = rows[datum.index]!;
          return {
            title: `${date.format(row.bucket)} UTC`,
            rows: [
              { label: "p75", value: vitalValue(name, row.p75, locale) },
              { label: t.samples, value: String(row.count) },
            ],
          };
        },
      },
    );
    return { name, data: { chart, rows } };
  });
}
