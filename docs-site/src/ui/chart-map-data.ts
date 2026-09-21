import { type ChartExplorerData, type ChartExplorerRequest, type ChartExplorerSnapshot, prepareChartSnapshot } from "@k2b/ui";
import { queueSteps } from "./chart-local-data";
export const deliverySteps = queueSteps;
export const deliverySeries = [
  { key: "north", label: "Northern route", color: "var(--stdlib-chart-c1)" },
  { key: "south", label: "Southern route", color: "var(--stdlib-chart-c2)" },
];
export const deliveryInitial: ChartExplorerRequest = { step: "08", visibleKeys: ["north", "south"] };
export type DeliveryRow = { key: string; label: string; current: number; reference: number | null };
export type DeliveryCharts = { deliveries: ChartExplorerData<DeliveryRow> };
/** Synthetic route positions, interpolated locally between Hamburg/Berlin and Lyon/Munich. */
export function deliverySnapshot(request: ChartExplorerRequest): ChartExplorerSnapshot<DeliveryCharts> {
  const progress = (step: string | undefined) => (Number(step ?? "08") - 8) / 12;
  const routes = [
    { from: [53.55, 9.99], to: [52.52, 13.405], distance: 290 },
    { from: [45.76, 4.835], to: [48.135, 11.582], distance: 750 },
  ];
  const rows = deliverySeries.flatMap((item, index) =>
    request.visibleKeys && !request.visibleKeys.includes(item.key)
      ? []
      : [
          {
            key: item.key,
            label: item.label,
            current: Math.round(progress(request.step) * routes[index]!.distance),
            reference: request.referenceStep ? Math.round(progress(request.referenceStep) * routes[index]!.distance) : null,
          },
        ],
  );
  const markers = deliverySeries.map((item, index) => {
    const row = rows.find((row) => row.key === item.key);
    if (!row) return [];
    const route = routes[index]!;
    return [request.step ?? "08", ...(request.referenceStep ? [request.referenceStep] : [])].map((step, phase) => ({
      key: `${item.key}:${phase}`,
      row,
      reference: phase === 1,
      step,
      latitude: route.from[0]! + (route.to[0]! - route.from[0]!) * progress(step),
      longitude: route.from[1]! + (route.to[1]! - route.from[1]!) * progress(step),
    }));
  });
  const chart = prepareChartSnapshot(
    {
      kind: "map",
      viewport: { latitude: 50, longitude: 10, zoom: 2 },
      sizeRange: [7, 7],
      series: deliverySeries.map((item, index) => ({
        label: item.label,
        data: markers[index]!.map((mark) => ({ latitude: mark.latitude, longitude: mark.longitude, size: 1, label: item.label })),
      })),
    },
    {
      key: ({ datum }) => markers[datum.seriesIndex!]![datum.index]!.key,
      rowKey: ({ datum }) => markers[datum.seriesIndex!]![datum.index]!.row.key,
      reference: ({ datum }) => markers[datum.seriesIndex!]![datum.index]!.reference,
      tooltip: ({ datum }) => {
        const mark = markers[datum.seriesIndex!]![datum.index]!;
        return {
          title: mark.row.label,
          rows: [
            { label: mark.reference ? "Reference time" : "Time", value: `${mark.step}:00` },
            { label: "Distance travelled", value: `${mark.reference ? mark.row.reference : mark.row.current} km` },
          ],
        };
      },
    },
  );
  return { request, charts: { deliveries: { chart, rows } } };
}
