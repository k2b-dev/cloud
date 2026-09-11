import { prepareChartSnapshot, type ChartExplorerRequest, type ChartExplorerSnapshot } from "@k2b/ui";

export type ExplorerDemoRow = { key: string; label: string; series: string; payload: number; value: number };
export const explorerSteps = Array.from({ length: 13 }, (_, index) => {
  const hour = String(index + 8).padStart(2, "0");
  return { key: hour, label: `${hour}:00` };
});
export const explorerSeries = [
  { key: "cached", label: "Cached", color: "var(--stdlib-chart-c1)", marker: "circle" as const },
  { key: "uncached", label: "Uncached", color: "var(--stdlib-chart-c2)", marker: "triangle" as const },
];
export const queueSeries = [
  { key: "imports", label: "Imports", color: "var(--stdlib-chart-c1)" },
  { key: "exports", label: "Exports", color: "var(--stdlib-chart-c2)" },
];

/** Demo-only bounded snapshots: 13 steps × 4 visibility combinations. Runs on the server. */
export function explorerSnapshots(kind: "scatter" | "bar"): ChartExplorerSnapshot<ExplorerDemoRow>[] {
  const groups = kind === "scatter" ? explorerSeries : queueSeries;
  return explorerSteps.flatMap((step, stepIndex) =>
    Array.from({ length: 4 }, (_, mask) => {
      const request: ChartExplorerRequest = { step: step.key, visibleKeys: groups.filter((_, i) => mask & (1 << i)).map((g) => g.key) };
      if (kind === "scatter") {
        const seriesRows = explorerSeries.map((group, index) =>
          request.visibleKeys.includes(group.key)
            ? [10, 25, 40, 60].map((payload) => ({
                key: `${group.key}:${payload}`,
                label: `${payload} KB · ${group.label}`,
                series: group.label,
                payload,
                value: Math.round(payload * (index ? 0.9 : 0.4) + 8 + (stepIndex / (explorerSteps.length - 1)) * (index ? 16 : 6)),
              }))
            : [],
        );
        const rows = seriesRows.flat();
        const chart = prepareChartSnapshot(
          {
            kind: "scatter",
            series: explorerSeries.map((group, i) => ({
              label: group.label,
              marker: group.marker,
              data: seriesRows[i]!.map((row) => ({ x: row.payload, y: row.value })),
            })),
            xAxis: { domain: [0, 70], label: "Payload (KB)" },
            yAxis: { domain: [0, 100], label: "Latency (ms)" },
          },
          {
            key: ({ datum }) => seriesRows[datum.seriesIndex!]![datum.index]!.key,
            tooltip: ({ datum }) => {
              const row = seriesRows[datum.seriesIndex!]![datum.index]!;
              return {
                title: row.series,
                rows: [
                  { label: "Payload", value: `${row.payload} KB` },
                  { label: "Latency", value: `${row.value} ms` },
                  { label: "Time", value: step.label },
                ],
              };
            },
          },
        );
        return { request, chart, rows };
      }
      const rows = queueSeries.flatMap((group, i) =>
        request.visibleKeys.includes(group.key)
          ? [{ key: group.key, label: group.label, series: group.label, payload: 0, value: 20 + i * 10 + stepIndex * 2 }]
          : [],
      );
      const chart = prepareChartSnapshot(
        {
          kind: "bar",
          data: rows.map((row) => ({
            label: row.label,
            value: row.value,
            colorIndex: queueSeries.findIndex((group) => group.key === row.key),
          })),
          colorByBar: true,
          showValues: true,
          yAxis: { domain: [0, 70], label: "Completed jobs" },
        },
        {
          key: ({ datum }) => rows[datum.index]!.key,
          tooltip: ({ datum }) => ({
            title: rows[datum.index]!.label,
            rows: [
              { label: "Completed jobs", value: String(rows[datum.index]!.value) },
              { label: "Time", value: step.label },
            ],
          }),
        },
      );
      return { request, chart, rows };
    }),
  );
}
