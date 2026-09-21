import {
  type ChartExplorerData,
  type ChartExplorerRequest,
  type ChartExplorerSnapshot,
  type ChartSelection,
  prepareChartSnapshot,
} from "@k2b/ui";
import { explorerSeries, explorerSteps } from "./chart-explorer-data";
import { comparisonValues, type LinkedChartRow, signed } from "./chart-group-demo-model";

export type LinkedCharts = { latency: ChartExplorerData<LinkedChartRow>; requests: ChartExplorerData<LinkedChartRow> };
export const initialGroupRequest: ChartExplorerRequest = { step: "08", visibleKeys: ["cached", "uncached"] };

export function parseGroupRequest(url: URL): ChartExplorerRequest | null {
  const step = url.searchParams.get("step") ?? "";
  const referenceStep = url.searchParams.get("reference") || undefined;
  const visibleKeys = url.searchParams.getAll("series");
  if (
    !explorerSteps.some((s) => s.key === step) ||
    (referenceStep !== undefined && !explorerSteps.some((s) => s.key === referenceStep)) ||
    new Set(visibleKeys).size !== visibleKeys.length ||
    visibleKeys.some((key) => !explorerSeries.some((s) => s.key === key))
  )
    return null;
  return { step, referenceStep, visibleKeys };
}

function metric(kind: "latency" | "requests", step: string, seriesIndex: number, payload: number): number | null {
  const hour = Number(step) - 8;
  // Deliberate missing observation and zero baseline exercise the comparison UI.
  if (step === "11" && seriesIndex === 1 && payload === 25) return null;
  if (kind === "requests") return seriesIndex === 0 && payload === 10 && step === "08" ? 0 : 60 + payload * 2 + hour * 2 + seriesIndex * 20;
  return Math.round(payload * (seriesIndex ? 0.9 : 0.4) + 8 + (hour / 12) * (seriesIndex ? 16 : 6));
}

/** On-demand, bounded synthetic data. Both charts and reference values are built on the server. */
export function linkedChartSnapshot(request: ChartExplorerRequest): ChartExplorerSnapshot<LinkedCharts> {
  const make = (kind: "latency" | "requests") => {
    const unit = kind === "latency" ? " ms" : "";
    const label = kind === "latency" ? "Latency" : "Requests";
    const observations = explorerSeries.flatMap((series, seriesIndex) =>
      request.visibleKeys !== undefined && !request.visibleKeys.includes(series.key)
        ? []
        : [10, 25, 40, 60].flatMap((payload) => {
            const entity = `${series.key}:${payload}`;
            const current = metric(kind, request.step ?? "08", seriesIndex, payload);
            const reference = request.referenceStep === undefined ? null : metric(kind, request.referenceStep, seriesIndex, payload);
            const base = { entity, seriesKey: series.key, series: series.label, payload, current, reference };
            return [
              ...(current === null
                ? []
                : [{ ...base, key: `${entity}:current`, phase: "current" as const, time: `${request.step}:00`, value: current }]),
              ...(reference === null
                ? []
                : [
                    {
                      ...base,
                      key: `${entity}:reference`,
                      phase: "reference" as const,
                      time: `${request.referenceStep}:00`,
                      value: reference,
                    },
                  ]),
            ];
          }),
    );
    const rows: LinkedChartRow[] = [
      ...new Map(
        observations.map((item) => [
          item.entity,
          {
            key: item.entity,
            seriesKey: item.seriesKey,
            series: item.series,
            payload: item.payload,
            current: item.current,
            reference: item.reference,
          },
        ]),
      ).values(),
    ];
    const seriesRows = explorerSeries.map((series) => observations.filter((row) => row.seriesKey === series.key));
    const rowFor = ({ datum }: ChartSelection) =>
      kind === "latency" ? seriesRows[datum.seriesIndex!]![datum.index]! : observations[datum.index]!;
    const inspection = {
      key: (selection: ChartSelection) => rowFor(selection).key,
      rowKey: (selection: ChartSelection) => rowFor(selection).entity,
      reference: (selection: ChartSelection) => rowFor(selection).phase === "reference",
      tooltip: (selection: ChartSelection) => {
        const row = rowFor(selection),
          diff = comparisonValues(row.current, row.reference);
        return {
          title: `${row.series} · ${row.payload} KB · ${row.phase === "current" ? "Current" : "Reference"} ${row.time}`,
          rows:
            request.referenceStep === undefined
              ? [{ label, value: `${row.value}${unit}` }]
              : [
                  { label: `Current ${request.step}:00`, value: row.current === null ? "No current value" : `${row.current}${unit}` },
                  {
                    label: `Reference ${request.referenceStep}:00`,
                    value: row.reference === null ? "No reference value" : `${row.reference}${unit}`,
                  },
                  { label: "Change", value: diff.delta === null ? "No comparison" : `${signed(diff.delta)}${unit}` },
                  { label: "Change (%)", value: diff.percent === null ? "Not available" : `${signed(diff.percent)}%` },
                ],
        };
      },
    };
    const chart =
      kind === "latency"
        ? prepareChartSnapshot(
            {
              kind: "scatter",
              series: explorerSeries.map((series, i) => ({
                label: series.label,
                marker: series.marker,
                data: seriesRows[i]!.map((row) => ({ x: row.payload, y: row.value })),
              })),
              xAxis: { domain: [0, 70], label: "Payload (KB)" },
              yAxis: { domain: [0, 100], label: "Latency (ms)" },
            },
            inspection,
          )
        : prepareChartSnapshot(
            {
              kind: "bar",
              colorByBar: true,
              showValues: true,
              data: observations.map((row) => ({
                label: row.phase === "reference" && row.current !== null ? "" : String(row.payload),
                value: row.value,
                colorIndex: explorerSeries.findIndex((series) => series.key === row.seriesKey),
              })),
              yAxis: { domain: [0, 300], label: "Requests" },
            },
            inspection,
          );
    return { chart, rows };
  };
  return { request, charts: { latency: make("latency"), requests: make("requests") } };
}
