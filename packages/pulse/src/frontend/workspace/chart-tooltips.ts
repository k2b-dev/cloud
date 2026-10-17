import type { DateContext } from "@k2b/stdlib";
import type { ChartTooltipFormatter } from "@k2b/ui";
import type { MetricQueryPoint } from "../../contracts";
import { formatQueryBucket } from "./date-format";
import { formatMetricValue } from "./metric-format";

export type MetricChartTooltipOptions = {
  /** Widget or metric title; the row label. */
  title: string;
  /** Metric unit, formatted through formatMetricValue exactly like the axes. */
  unit: string | null | undefined;
  /** Query points, used to name sparkline buckets and gauge/stat time. */
  points: readonly MetricQueryPoint[];
  bucket: string;
  /** The same context and time zone the chart's axes use. */
  dateContext: DateContext;
  /** Localized count label (Pulse message t.count). */
  countLabel: string;
};

export const metricChartTooltip =
  (options: MetricChartTooltipOptions): ChartTooltipFormatter =>
  ({ kind, datum }) => {
    const field = (key: string) => datum.values.find((value) => value.key === key);
    const number = (key: string) => {
      const value = field(key)?.value;
      return typeof value === "number" ? value : undefined;
    };
    const format = (value: number | undefined) => formatMetricValue(value, options.unit);
    const bucketTitle = (point: MetricQueryPoint | undefined) =>
      point ? formatQueryBucket(point.bucket, options.bucket, options.dateContext) : undefined;
    const row = (value: string, label = options.title) => [{ label, value }];

    switch (kind) {
      case "bar":
        return { title: datum.label, rows: row(format(number("value"))) };
      case "line": {
        const x = number("x");
        return {
          title:
            x !== undefined && Number.isFinite(x)
              ? formatQueryBucket(new Date(x).toISOString(), options.bucket, options.dateContext)
              : undefined,
          rows: row(format(number("y")), datum.label ?? options.title),
        };
      }
      case "histogram": {
        const count = number("count");
        return {
          title: `${format(number("from"))} – ${format(number("to"))}`,
          rows: row(
            count !== undefined && Number.isFinite(count)
              ? new Intl.NumberFormat(options.dateContext.locale ?? "en").format(count)
              : format(count),
            options.countLabel,
          ),
        };
      }
      case "stat": {
        if (datum.role === "point") {
          const points = options.points.filter((point) => typeof point.value === "number" && Number.isFinite(point.value));
          return { title: bucketTitle(points[datum.index]), rows: row(format(number("y"))) };
        }
        const value = field("value");
        return {
          title: bucketTitle(options.points.at(-1)),
          rows: row(
            value && (typeof value.value !== "number" || Number.isFinite(value.value))
              ? String(value.formatted ?? value.value)
              : format(undefined),
          ),
        };
      }
      case "gauge":
      case "barGauge":
        return { title: bucketTitle(options.points.at(-1)), rows: row(format(number("value"))) };
      case "heatmap":
        return { title: `${field("y")?.value ?? ""} · ${field("x")?.value ?? ""}`, rows: row(format(number("value"))) };
      default: {
        const value = number("value") ?? number("y");
        return { title: datum.label, rows: value === undefined ? [] : row(format(value)) };
      }
    }
  };
