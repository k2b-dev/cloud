import { type ChartExplorerData, type ChartExplorerRequest, type ChartExplorerSnapshot, prepareChartSnapshot } from "@k2b/ui";
import { comparisonValues, signed } from "./chart-group-demo-model";
export type QueueRow = { key: string; label: string; current: number; reference: number | null };
export type QueueCharts = { queues: ChartExplorerData<QueueRow> };
export const queueSteps = Array.from({ length: 13 }, (_, index) => ({
  key: String(index + 8).padStart(2, "0"),
  label: `${String(index + 8).padStart(2, "0")}:00`,
}));
export const staticQueueSteps = queueSteps.filter((_, index) => index % 2 === 0);
export const queueSeries = [
  { key: "imports", label: "Imports", color: "var(--stdlib-chart-c1)" },
  { key: "exports", label: "Exports", color: "var(--stdlib-chart-c2)" },
];
export const queueInitial: ChartExplorerRequest = { step: "08", visibleKeys: ["imports", "exports"] };
/** Pure builder: called locally in the client example, ahead of time for the static example. */
export function queueSnapshot(request: ChartExplorerRequest): ChartExplorerSnapshot<QueueCharts> {
  const value = (step: string | undefined, index: number) => 20 + index * 10 + (Number(step ?? "08") - 8);
  const rows = queueSeries.flatMap((series, index) =>
    request.visibleKeys && !request.visibleKeys.includes(series.key)
      ? []
      : [
          {
            key: series.key,
            label: series.label,
            current: value(request.step, index),
            reference: request.referenceStep ? value(request.referenceStep, index) : null,
          },
        ],
  );
  const marks = rows.flatMap((row) => [
    { key: `${row.key}:current`, row, reference: false, value: row.current },
    ...(row.reference === null ? [] : [{ key: `${row.key}:reference`, row, reference: true, value: row.reference }]),
  ]);
  const chart = prepareChartSnapshot(
    {
      kind: "bar",
      colorByBar: true,
      showValues: true,
      yAxis: { domain: [0, 60], label: "Completed jobs" },
      data: marks.map((mark) => ({
        label: mark.reference ? "" : mark.row.label,
        value: mark.value,
        colorIndex: queueSeries.findIndex((series) => series.key === mark.row.key),
      })),
    },
    {
      key: ({ datum }) => marks[datum.index]!.key,
      rowKey: ({ datum }) => marks[datum.index]!.row.key,
      reference: ({ datum }) => marks[datum.index]!.reference,
      tooltip: ({ datum }) => {
        const mark = marks[datum.index]!;
        const diff = comparisonValues(mark.row.current, mark.row.reference);
        return {
          title: `${mark.row.label} · ${mark.reference ? "Reference" : "Current"}`,
          rows: [
            { label: "Completed jobs", value: String(mark.value) },
            ...(diff.percent === null ? [] : [{ label: "Change", value: `${signed(diff.percent)}%` }]),
          ],
        };
      },
    },
  );
  return { request, charts: { queues: { chart, rows } } };
}
/** 7 times × 8 reference choices × 4 series combinations = 224 bounded states. */
export const staticQueueSnapshots = () =>
  staticQueueSteps.flatMap((step) =>
    [undefined, ...staticQueueSteps.map((item) => item.key)].flatMap((referenceStep) =>
      [[], ["imports"], ["exports"], ["imports", "exports"]].map((visibleKeys) =>
        queueSnapshot({ step: step.key, referenceStep, visibleKeys }),
      ),
    ),
  );
