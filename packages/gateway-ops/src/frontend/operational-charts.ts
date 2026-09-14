import { prepareChartSnapshot, type ChartExplorerData } from "@k2b/ui";
import { formatBytes } from "@k2b/cloud/shared";

export type OperationalRow = { key: string; label: string; at?: number; value: number; formatted: string };
type Series = { label: string; data: { x: number; y: number }[] };
export type OperationalChartSpec = {
  title: string;
  description?: string;
  href?: string;
  linkLabel?: string;
  error?: string | null;
  unit?: "number" | "bytes" | "ms" | "percent";
} & ({ kind: "line"; series: Series[]; maxGap?: number } | { kind: "bar"; data: { label: string; value: number }[] });
export type OperationalChart = Pick<OperationalChartSpec, "title" | "description" | "href" | "linkLabel" | "error"> & {
  data: ChartExplorerData<OperationalRow>;
};

/** SSR-owned snapshots. Only serializable rows and SVG cross the island boundary. */
export function prepareOperationalCharts(specs: OperationalChartSpec[], locale: string): OperationalChart[] {
  const times = specs.flatMap((spec) => (spec.kind === "line" ? spec.series.flatMap((series) => series.data.map((point) => point.x)) : []));
  const domain: [number, number] | undefined = times.length ? [Math.min(...times), Math.max(...times)] : undefined;
  if (domain && domain[0] === domain[1]) {
    domain[0] -= 60_000;
    domain[1] += 60_000;
  }
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  const axisDate = new Intl.DateTimeFormat(locale, {
    ...(domain && domain[1] - domain[0] > 86400000 ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" }),
    timeZone: "UTC",
  });
  return specs.map((spec) => {
    const format = (value: number) =>
      spec.unit === "bytes"
        ? formatBytes(value, { locale })
        : `${value.toLocaleString(locale, { maximumFractionDigits: 3 })}${spec.unit === "ms" ? " ms" : spec.unit === "percent" ? "%" : ""}`;
    const rows: OperationalRow[] =
      spec.kind === "line"
        ? spec.series.flatMap((series, s) =>
            series.data.map((point, i) => ({
              key: `${s}:${i}`,
              label: series.label,
              at: point.x,
              value: point.y,
              formatted: format(point.y),
            })),
          )
        : [...spec.data]
            .sort((a, b) => b.value - a.value)
            .map((item, i) => ({ key: String(i), label: item.label, value: item.value, formatted: format(item.value) }));
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const maximum = Math.max(1, ...rows.map((row) => row.value));
    const axisStep = 10 ** Math.floor(Math.log10(maximum)) / 2;
    const axisMaximum = Math.ceil(maximum / axisStep) * axisStep;
    const chart = prepareChartSnapshot(
      spec.kind === "line"
        ? {
            kind: "line",
            series: spec.series,
            smooth: false,
            maxGap: spec.maxGap,
            legend: spec.series.length > 1,
            padding: { left: 84, right: 32 },
            xAxis: { domain, ticks: 2, format: (value) => axisDate.format(value) },
            yAxis: { domain: [0, axisMaximum], ticks: 3, format },
          }
        : {
            kind: "barGauge",
            data: rows.map((row) => ({ label: row.label.length > 15 ? `${row.label.slice(0, 14)}…` : row.label, value: row.value })),
            min: 0,
            max: maximum,
            format:
              spec.unit === "bytes" ? format : (value) => value.toLocaleString(locale, { notation: "compact", maximumFractionDigits: 1 }),
          },
      {
        key: ({ datum }) => (spec.kind === "line" ? `${datum.seriesIndex ?? 0}:${datum.index}` : String(datum.index)),
        tooltip: ({ datum }) => {
          const row = byKey.get(spec.kind === "line" ? `${datum.seriesIndex ?? 0}:${datum.index}` : String(datum.index))!;
          return {
            title: row.at === undefined ? row.label : `${date.format(row.at)} UTC`,
            rows: [{ label: row.label, value: row.formatted }],
          };
        },
      },
    );
    return {
      title: spec.title,
      description: spec.description,
      href: spec.href,
      linkLabel: spec.linkLabel,
      error: spec.error,
      data: { chart, rows },
    };
  });
}

/** Sum existing count buckets into the coarser comparison intervals, without filling missing data. */
export function alignCountSeries(points: { x: number; y: number }[], intervalMs: number) {
  const buckets = new Map<number, number>();
  for (const point of points) {
    const at = Math.floor(point.x / intervalMs) * intervalMs;
    buckets.set(at, (buckets.get(at) ?? 0) + point.y);
  }
  return [...buckets].sort(([a], [b]) => a - b).map(([x, y]) => ({ x, y }));
}
