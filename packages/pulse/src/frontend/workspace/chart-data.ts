import { type DateContext, dates } from "@k2b/stdlib";
import type { DataTableColumn } from "@k2b/ui";
import type { MetricQueryPoint } from "../../contracts";
import { intervalToMs } from "../../query-dsl/interval";
import { isCalendarBucket } from "../../query-dsl/time-window";
import { compactDate, formatQueryBucket } from "./date-format";
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

export const pointsToBars = (points: MetricQueryPoint[], context?: DateContext, bucket = "1h") =>
  points.flatMap((point) =>
    point.value === null
      ? []
      : [
          {
            label: [formatQueryBucket(point.bucket, bucket, context), metricPointGroupLabel(point)].filter(Boolean).join(" · "),
            value: point.value,
          },
        ],
  );

export const pointsToHistogram = (points: MetricQueryPoint[]) =>
  points.map((point) => point.value).filter((value): value is number => typeof value === "number" && Number.isFinite(value));

export const pointsToHeatmap = (points: MetricQueryPoint[], context?: DateContext, bucket = "1h") =>
  points.flatMap((point) => {
    if (point.value === null) return [];
    const date = new Date(point.bucket);
    return [
      {
        x:
          [isCalendarBucket(bucket) || bucket === "all" ? "" : compactDate(date.toISOString(), context), metricPointGroupLabel(point)]
            .filter(Boolean)
            .join(" · ") || "Total",
        y: formatQueryBucket(point.bucket, isCalendarBucket(bucket) ? bucket : "day", context),
        value: point.value,
      },
    ];
  });

export const queryPointColumns = (context?: DateContext, bucket = "1h"): DataTableColumn<MetricQueryPoint>[] => [
  {
    id: "bucket",
    header: "Bucket",
    value: (point) => formatQueryBucket(point.bucket, bucket, context),
    cellClass: "w-48 whitespace-nowrap",
  },
  {
    id: "group",
    header: "Group",
    value: (point) => metricPointGroupLabel(point) || "-",
  },
  { id: "value", header: "Value", value: (point) => formatValue(point.value), cellClass: "w-32 whitespace-nowrap" },
];

export const queryBucketMaxGap = (points: MetricQueryPoint[], bucket: string, context?: DateContext): number | undefined => {
  const duration = intervalToMs(bucket);
  if (duration !== null) return duration;
  if (!isCalendarBucket(bucket) || points.length === 0) return undefined;
  const calendarContext = { ...context, timeZone: context?.timeZone ?? "UTC" };
  return Math.max(
    ...points.map((point) => {
      const current = new Date(point.bucket);
      const next =
        bucket === "month"
          ? dates.addMonths(current, 1, calendarContext)
          : dates.addDays(current, bucket === "week" ? 7 : 1, calendarContext);
      return +next - +current;
    }),
  );
};
