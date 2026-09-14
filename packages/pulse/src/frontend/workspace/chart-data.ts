import type { DateContext } from "@k2b/stdlib";
import type { DataTableColumn } from "@k2b/ui";
import type { MetricQueryPoint } from "../../contracts";
import { compactDate, compactDateWithDelta, compactDay } from "./date-format";
import { formatValue } from "./metric-format";

export const metricPointGroupLabel = (point: MetricQueryPoint): string =>
  Object.entries(point.group ?? {})
    .map(([key, value]) => `${key}=${value || "(none)"}`)
    .join(" · ");

export const pointsToLineSeries = (points: MetricQueryPoint[], fallbackLabel: string) => {
  const grouped = new Map<string, MetricQueryPoint[]>();
  for (const point of points) {
    const label = metricPointGroupLabel(point) || fallbackLabel;
    grouped.set(label, [...(grouped.get(label) ?? []), point]);
  }
  return [...grouped.entries()].map(([label, data]) => ({
    label,
    data: data.flatMap((point) => (point.value === null ? [] : [{ x: Date.parse(point.bucket), y: point.value }])),
  }));
};

export const pointsToBars = (points: MetricQueryPoint[], context?: DateContext) =>
  points.flatMap((point) =>
    point.value === null
      ? []
      : [
          {
            label: compactDate(point.bucket, context),
            value: point.value,
          },
        ],
  );

export const pointsToHistogram = (points: MetricQueryPoint[]) =>
  points.map((point) => point.value).filter((value): value is number => typeof value === "number" && Number.isFinite(value));

export const pointsToHeatmap = (points: MetricQueryPoint[], context?: DateContext) =>
  points.flatMap((point) => {
    if (point.value === null) return [];
    const date = new Date(point.bucket);
    return [
      {
        x: compactDate(date.toISOString(), context).slice(0, 2),
        y: compactDay(point.bucket, context),
        value: point.value,
      },
    ];
  });

export const queryPointColumns: DataTableColumn<MetricQueryPoint>[] = [
  { id: "bucket", header: "Bucket", value: (point) => compactDateWithDelta(point.bucket), cellClass: "w-48 whitespace-nowrap" },
  {
    id: "group",
    header: "Group",
    value: (point) => metricPointGroupLabel(point) || "-",
  },
  { id: "value", header: "Value", value: (point) => formatValue(point.value), cellClass: "w-32 whitespace-nowrap" },
];
