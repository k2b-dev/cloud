import type { BarItem, Point, Series, SliceItem } from "@k2b/stdlib";
import type { PublicField as Field } from "../../api/public-dto";
import type { AggregationSpec, GroupBySpec } from "../../contracts";

/**
 * Transforms `record.group()` buckets into the shapes the platform
 * `Chart` primitive expects. Pure functions — no DOM, no DB calls;
 * lives in this file so unit tests can hit every chart-type / edge
 * case without spinning up the resolver or hitting the SVG layer.
 *
 * Bucket shape produced by the group resolver:
 *
 * ```ts
 * { keys: unknown[]; values: Record<"<fieldId>__<agg>", unknown> }
 * ```
 *
 *  - `keys` is parallel to the source's grouped GQL output.
 *  - `values` keys are namespaced `${fieldId}__${agg}` (mirrors `record.aggregate()`).
 *    The shorthand `*` is used for COUNT(*).
 *
 * The transformers in this module take one bucket array plus the
 * relevant chart metadata and emit slices, bars, or line series.
 */

/** Bucket shape as produced by `gridsService.record.group()`. */
type ChartBucket = {
  keys: unknown[];
  values: Record<string, unknown>;
};

/** The same `${fieldId}__${agg}` key the server uses to namespace
 *  aggregation results inside `bucket.values`. */
export const aggKey = (spec: AggregationSpec): string => `${spec.fieldId}__${spec.agg}`;

/** Derive a human label for an aggregation — same precedence the
 *  view-stats resolver uses: explicit `.label` first, then a
 *  generated `agg(fieldName)` / `agg(*)` fallback. */
export const aggLabel = (spec: AggregationSpec, fieldsById: Map<string, Field>): string => {
  if (spec.label) return spec.label;
  if (spec.fieldId === "*") return `${spec.agg}(*)`;
  const field = fieldsById.get(spec.fieldId);
  return `${spec.agg}(${field?.name ?? "?"})`;
};

/** Coerce a bucket-value to a finite number, or null when it's
 *  missing / non-numeric. The group resolver returns strings for
 *  decimal-safe number aggregations (matching `record.aggregate()`), so we cast
 *  carefully and reject NaN / Infinity so the chart layer never sees
 *  a bad point. */
export const toNumber = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    if (!/^-?\d+(\.\d+)?$/.test(v)) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const dateKeyParts = (key: unknown): { year: number; month: number; day: number } | null => {
  const [year, month, day] = String(key).slice(0, 10).split("-").map(Number);
  return year && month && day ? { year, month, day } : null;
};

const formatCalendarDateKey = (key: unknown, options: Intl.DateTimeFormatOptions, locale?: string): string => {
  const parts = dateKeyParts(key);
  if (!parts) return String(key);
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return d.toLocaleDateString(locale, { ...options, timeZone: "UTC" });
};

type ChartCategoryFormat = { locale?: string; unknownRecordLabel?: string };

/** Render the first groupBy key of a bucket as a category label
 *  (donut / bar / line x-axis tick). Resolution order:
 *
 *    1. `relationLabels[uuid]` — for relation-typed groupBy, the key
 *       is the linked record's UUID; the labels map is built server-
 *       side via `buildLabelCacheForGroupedKeys`. Falls through to
 *       a neutral placeholder if missing (target table the viewer
 *       can't read, or label resolution skipped).
 *    2. Date-truncated keys (ISO strings) → granularity-appropriate
 *       readable form. The `dates.formatDate` family is locale-aware.
 *    3. Numeric keys stringify natively; everything else falls back
 *       to `String(...)`. Nullish → em-dash. */
export const formatCategoryKey = (
  key: unknown,
  spec: GroupBySpec | undefined,
  relationLabels?: Record<string, string>,
  format: ChartCategoryFormat = {},
): string => {
  if (key === null || key === undefined) return "—";

  // Relation-typed groupBy: bucket key is a UUID. Look up the
  // presentable label resolved server-side; without it the axis
  // would show raw UUIDs (the bug we're fixing).
  if (relationLabels && typeof key === "string" && relationLabels[key]) {
    return relationLabels[key];
  }

  // Date-truncated groupBy → granularity-appropriate format.
  if (spec?.granularity && (typeof key === "string" || key instanceof Date)) {
    const granularity = spec.granularity;
    if (granularity === "year") {
      const year = String(key).slice(0, 4);
      return /^\d{4}$/.test(year) ? year : String(key);
    }
    if (granularity === "month" || granularity === "quarter") {
      return formatCalendarDateKey(key, { year: "numeric", month: "short" }, format.locale);
    }
    return formatCalendarDateKey(key, { year: "numeric", month: "short", day: "numeric" }, format.locale);
  }

  // Plain UUID fallback when the lookup failed (e.g. relationLabels
  // not threaded through). Do not leak UUID prefixes into chart labels.
  if (typeof key === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(key)) {
    return format.unknownRecordLabel ?? "Unknown record";
  }
  return String(key);
};

/**
 * Donut / bar — both want `{label, value}[]`. Picks the first
 * aggregation as the value source (the renderer documents this
 * convention; multi-agg donuts don't make visual sense). Buckets
 * with non-numeric values are dropped silently — they'd render as
 * zero-area slices anyway.
 */
export const bucketsToSlices = (
  buckets: ChartBucket[],
  primaryAgg: AggregationSpec,
  groupBy: GroupBySpec | undefined,
  relationLabels?: Record<string, string>,
  format?: ChartCategoryFormat,
): SliceItem[] => {
  const key = aggKey(primaryAgg);
  const items: SliceItem[] = [];
  for (const b of buckets) {
    const v = toNumber(b.values[key]);
    if (v === null) continue;
    items.push({
      label: formatCategoryKey(b.keys[0], groupBy, relationLabels, format),
      value: v,
    });
  }
  return items;
};

/** Bar items are structurally identical to slices — alias for
 *  callsite clarity (bar charts can carry negatives, donuts can't,
 *  but the shape itself is the same). */
export const bucketsToBars = (
  buckets: ChartBucket[],
  primaryAgg: AggregationSpec,
  groupBy: GroupBySpec | undefined,
  relationLabels?: Record<string, string>,
  format?: ChartCategoryFormat,
): BarItem[] => bucketsToSlices(buckets, primaryAgg, groupBy, relationLabels, format) as BarItem[];

/**
 * Line — one `Series` per aggregation. x is the bucket index (0..N)
 * so categorical groupBys (strings, mixed types) work without
 * domain math; the renderer puts the category label on the x-axis
 * tick via a custom `xAxis.format` (see `chartXAxisFormat`).
 *
 * For numeric groupBys (e.g. a "year" field), the index-as-x makes
 * the line evenly spaced regardless of source spacing — semantically
 * "trend over ordered buckets", which is what App line charts
 * almost always mean. True numeric x-axes (continuous quantities)
 * can come later with an explicit `xField` knob if a use case shows up.
 */
export const bucketsToLineSeries = (buckets: ChartBucket[], aggs: AggregationSpec[], fieldsById: Map<string, Field>): Series[] => {
  return aggs.map((agg) => {
    const key = aggKey(agg);
    const data: Point[] = [];
    buckets.forEach((b, idx) => {
      const y = toNumber(b.values[key]);
      if (y === null) return;
      data.push({ x: idx, y });
    });
    return { label: aggLabel(agg, fieldsById), data };
  });
};

/** Format-function for the x-axis tick numeric index, looking up the
 *  bucket key by position and rendering it via `formatCategoryKey`.
 *  Stdlib's `AxisOptions.format(v: number)` is called with each tick
 *  value — we round-trip the index back to a label. The optional
 *  `relationLabels` map lets relation-typed groupBy ticks render as
 *  presentable strings instead of raw UUIDs. */
export const chartXAxisFormat = (
  buckets: ChartBucket[],
  groupBy: GroupBySpec | undefined,
  relationLabels?: Record<string, string>,
  format?: ChartCategoryFormat,
): ((v: number) => string) => {
  return (v: number) => {
    const idx = Math.round(v);
    const bucket = buckets[idx];
    if (!bucket) return "";
    return formatCategoryKey(bucket.keys[0], groupBy, relationLabels, format);
  };
};

/**
 * Resolves the chartType-specific data + axis options bundle the
 * renderer hands straight to `<Chart kind=... />`. Splitting this
 * here keeps the renderer dumb (one switch on chartType) and the
 * transforms unit-testable in isolation.
 */
type ChartRenderData =
  | { kind: "donut"; data: SliceItem[] }
  | { kind: "bar"; data: BarItem[] }
  | {
      kind: "line";
      series: Series[];
      xAxisFormat: (v: number) => string;
    };

/**
 * Inputs the renderer needs to map buckets to a chart-specific shape.
 * The resolved GQL metadata (groupBy + aggregations) determines bucket
 * key formatting and series labels; these used to live on the widget
 * itself but now come from the GQL source that the widget points at.
 */
type ChartRenderInput = {
  widget: { chartType: "donut" | "bar" | "line" };
  /** The source's groupBy specs (parallel to bucket.keys positions). */
  groupBy: GroupBySpec[];
  /** The source's aggregations (parallel to bucket.values keys). */
  aggregations: AggregationSpec[];
  buckets: ChartBucket[];
  fieldsById: Map<string, Field>;
  /** UUID → presentable label map for relation-typed groupBy bucket
   *  keys. Resolved server-side via `buildLabelCacheForGroupedKeys`;
   *  the transformers and tick formatter use it to avoid printing
   *  raw UUIDs on chart axes / slice labels. */
  relationLabels?: Record<string, string>;
  categoryFormat?: ChartCategoryFormat;
};

export const buildChartRenderData = (input: ChartRenderInput): ChartRenderData => {
  const aggs = input.aggregations;
  const groupBy = input.groupBy[0];
  const primary = aggs[0];
  const relLabels = input.relationLabels;
  if (!primary) {
    // Empty aggs is a misconfigured view (charts need at least 1 agg).
    // Returning a donut with no slices lets the renderer fall through
    // to the empty-state placeholder instead of crashing.
    return { kind: "donut", data: [] };
  }
  switch (input.widget.chartType) {
    case "donut":
      return {
        kind: "donut",
        data: bucketsToSlices(input.buckets, primary, groupBy, relLabels, input.categoryFormat),
      };
    case "bar":
      return {
        kind: "bar",
        data: bucketsToBars(input.buckets, primary, groupBy, relLabels, input.categoryFormat),
      };
    case "line":
      return {
        kind: "line",
        series: bucketsToLineSeries(input.buckets, aggs, input.fieldsById),
        xAxisFormat: chartXAxisFormat(input.buckets, groupBy, relLabels, input.categoryFormat),
      };
  }
};
