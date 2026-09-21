import type { WebVitalName, WebVitalsOverview } from "@k2b/cloud/services";
import { type ChartExplorerData, prepareChartSnapshot } from "@k2b/ui";
import { TELEMETRY_RANGES, type TelemetryRange } from "../contracts";
import { browserMessages } from "./messages";
export type VitalRow = { key: string; bucket: number; p75: number; count: number };
export type VitalChart = { name: WebVitalName; data: ChartExplorerData<VitalRow> };
export function vitalValue(name: WebVitalName, value: number | null | undefined, locale: string): string {
  return value == null
    ? "—"
    : `${value.toLocaleString(locale, { maximumFractionDigits: name === "CLS" ? 3 : 0 })}${name === "CLS" ? "" : " ms"}`;
}
export function buildVitalCharts(overview: WebVitalsOverview, locale: string, range: TelemetryRange, until: number): VitalChart[] {
  const { t } = browserMessages.resolve([locale]);
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  const { hours, bucketSeconds } = TELEMETRY_RANGES[range];
  const bucketMs = bucketSeconds * 1000;
  const domain: [number, number] = [Math.floor((until - hours * 3600000) / bucketMs) * bucketMs, Math.ceil(until / bucketMs) * bucketMs];
  const axisDate = new Intl.DateTimeFormat(locale, {
    ...(hours > 24 ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" }),
    timeZone: "UTC",
  });
  const names: WebVitalName[] = ["LCP", "INP", "CLS"];
  return names.map((name) => {
    const rows = overview.series
      .filter((item) => item.name === name)
      .map((item) => ({ key: `${name}:${item.bucket}`, bucket: item.bucket, p75: item.p75, count: item.count }));
    const chart = prepareChartSnapshot(
      {
        kind: "line",
        smooth: false,
        padding: { left: 84, right: 32 },
        maxGap: bucketMs,
        series: [{ label: name, data: rows.map((row) => ({ x: row.bucket, y: row.p75 })) }],
        legend: false,
        xAxis: { domain, ticks: 2, format: (value) => axisDate.format(value) },
        yAxis: {
          domain: [0, Math.max(name === "CLS" ? 0.01 : 1, ...rows.map((row) => row.p75))],
          ticks: 3,
          format: (value) => `${value.toLocaleString(locale, { maximumSignificantDigits: 3 })}${name === "CLS" ? "" : " ms"}`,
        },
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
