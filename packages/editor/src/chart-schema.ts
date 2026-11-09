import type { ChartFormat, ChartInput, ChartLimits } from "@k2b/ui/charts";
import { autoBin, CALENDAR_MAX_DAYS, calendarDay, computeDomain, lineDetailsEnabled, niceStep, sankeyGraph } from "@k2b/ui/charts/core";
import { z } from "zod";
import { chartLocaleSchema } from "./chart-locale";

export type { ChartDateFormat, ChartDescription, ChartFormat, ChartInput, ChartLimits, ChartNumberFormat } from "@k2b/ui/charts";
export { chartAcceptsLocale, chartLocaleSchema } from "./chart-locale";

// Every chart schema is built by a function whose call is marked pure, so a bundle that imports neither chart contract
// leaves them out. App frames include the app contract through `cloud.chart()`.
export const chartNumberFormatSchema = () =>
  z
    .strictObject({
      style: z.enum(["number", "percent", "currency"]).optional(),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .optional(),
      // Units fit after a value in the shared renderer, like the existing gauge unit.
      unit: z.string().trim().min(1).max(12).optional(),
      // Intl.NumberFormat supports this precision; table formats already use 0..10.
      decimals: z.number().int().min(0).max(10).optional(),
      compact: z.boolean().optional(),
    })
    .superRefine((value, ctx) => {
      if ((value.style === "currency") !== (value.currency !== undefined))
        ctx.addIssue({ code: "custom", path: ["currency"], message: "Currency is required exactly when style is currency." });
    });
const dateFormatSchema = () => z.strictObject({ date: z.enum(["day", "minute", "second"]) });
export const chartFormatSchema = () => z.union([chartNumberFormatSchema(), dateFormatSchema()]);

export const chartKindSchema = () =>
  z.enum([
    "waterfall",
    "area",
    "bar",
    "hbar",
    "funnel",
    "line",
    "scatter",
    "pie",
    "donut",
    "histogram",
    "gauge",
    "sparkline",
    "boxplot",
    "heatmap",
    "barGauge",
    "stat",
    "treemap",
    "pareto",
    "bubble",
    "radar",
    "sankey",
  ]);

export const chartParts = (limits?: ChartLimits) => {
  const ChartLabel = limits ? z.string().trim().min(1).max(80) : z.union([z.string(), z.number().transform(String)]);
  const ChartTooltip = z
    .strictObject({ label: ChartLabel.optional(), format: chartNumberFormatSchema().optional() })
    .describe("All kinds: what tooltips and the data table call the value and how they format it; axes keep their own format.");
  // Missing observations stay numeric so the renderer can omit them with its finite-value checks.
  const ChartNumber = limits
    ? z.number()
    : z
        .custom<number>((value) => typeof value === "number", "Expected a number, null or undefined.")
        .nullable()
        .optional()
        .transform((value) => value ?? Number.NaN);
  const list = <T extends z.ZodType>(item: T, min: number, max?: number, message?: string) => {
    const array = z.array(item);
    const bounded = limits && min > 0 ? array.min(min) : array;
    return limits && max !== undefined ? bounded.max(max, message) : bounded;
  };
  const ChartDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/)
    .refine((value) => chartDateTime(value) !== undefined, "Not a valid date.");
  const ChartPoint = z.object({
    x: z.union([ChartNumber, ChartDate]).describe("line, scatter: number or YYYY-MM-DD[THH:mm[:ss]], wall-clock time without an offset."),
    y: ChartNumber.describe("line, scatter: value."),
  });
  // As many lines as series a reader can tell apart.
  const ChartReferences = list(
    z.object({
      value: z.union([z.number(), ChartDate]),
      axis: z.enum(["x", "y"]).optional(),
      label: ChartLabel.optional(),
      style: z.enum(["solid", "dashed", "dotted"]).optional(),
      tone: z.enum(["neutral", "info", "success", "warning", "danger"]).optional(),
    }),
    0,
    limits?.maxSeries,
    `Use at most ${limits?.maxSeries} references.`,
  );
  // One palette color per band.
  const ChartThresholds = list(
    z.object({ value: z.number(), label: ChartLabel.optional() }),
    1,
    limits?.maxSeries,
    `Use at most ${limits?.maxSeries} thresholds.`,
  );
  return {
    ChartLabel,
    ChartCoordinate: z.union([z.number(), ChartDate]),
    ChartTooltip,
    ChartNumber,
    list,
    ChartReferences,
    ChartThresholds,
    ChartAxis: z.object({
      label: ChartLabel.optional(),
      domain: z.array(z.number()).length(2).optional().describe("Exact [min, max]; must contain every value and reference."),
      ticks: (limits ? z.number().int().min(2).max(12) : z.number().int().min(2)).optional(),
      scale: z.enum(["linear", "log"]).optional().describe("log needs values above zero."),
      format: chartFormatSchema().optional(),
    }),
    ChartCategory: z.object({ label: ChartLabel, value: ChartNumber }),
    ChartSlice: z.object({ label: ChartLabel, value: limits ? z.number().min(0) : ChartNumber }),
    ChartSeries: <T extends z.ZodType>(points: z.ZodArray<T>) =>
      z.object({
        label: ChartLabel.optional(),
        data: points,
        role: z.literal("reference").optional(),
      }),
    ChartPoints: list(ChartPoint, 0, limits?.maxValues),
    ChartLinePoints: list(
      ChartPoint.extend({
        y: (limits
          ? z
              .number()
              .nullable()
              .transform((value) => value ?? Number.NaN)
          : ChartNumber
        ).describe("line: value; null is a gap only with forecast, zero, threshold, marker or legendValues enabled."),
      }),
      0,
      limits?.maxValues,
    ),
    ChartBins: z
      .union([
        limits ? z.number().int().min(1).max(limits?.maxValues) : z.number().int().min(1),
        limits
          ? z
              .array(z.number())
              .min(2)
              .max(limits.maxValues + 1)
          : z.array(z.number()).min(2),
      ])
      .describe("histogram: a bin count or ascending bin edges."),
    ChartCommon: {
      title: (limits ? z.string().trim().min(1).max(160) : z.string()).describe("All kinds and groups: chart title."),
      subtitle: (limits ? z.string().trim().min(1).max(300) : z.string())
        .optional()
        .describe("All kinds and groups: unit, period or source."),
    },
    ChartUnit: limits ? z.string().trim().min(1).max(12) : z.string(),
    ChartBox: z.object({ label: ChartLabel, values: list(ChartNumber, 1) }),
    ChartCell: z.object({ x: ChartLabel, y: ChartLabel, value: ChartNumber }),
    ChartBarGauge: z.object({ label: ChartLabel, value: ChartNumber, min: z.number().optional(), max: z.number().optional() }),
  };
};

export const chartKinds = (limits?: ChartLimits) => {
  const {
    ChartNumber,
    list,
    ChartAxis,
    ChartBins,
    ChartCategory,
    ChartCommon,
    ChartTooltip,
    ChartLabel,
    ChartCoordinate,
    ChartPoints,
    ChartLinePoints,
    ChartSeries,
    ChartSlice,
    ChartReferences,
    ChartThresholds,
    ChartUnit,
    ChartBox,
    ChartCell,
    ChartBarGauge,
  } = chartParts(limits);
  const ChartKindCommon = { ...ChartCommon, tooltip: ChartTooltip.optional() };
  const numberFormat = chartNumberFormatSchema();
  return z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("waterfall"),
        ...ChartKindCommon,
        start: z.object({ label: ChartLabel, value: z.number() }),
        steps: list(z.object({ label: ChartLabel, value: z.number() }), 0, limits?.maxValues),
        end: z.strictObject({ label: ChartLabel }),
        format: numberFormat.optional(),
      })
      .superRefine((spec, ctx) => {
        let balance = spec.start.value;
        let lo = Math.min(0, balance),
          hi = Math.max(0, balance);
        for (const step of spec.steps) {
          balance += step.value;
          lo = Math.min(lo, balance);
          hi = Math.max(hi, balance);
        }
        if (!Number.isFinite(balance) || !Number.isFinite(hi - lo))
          ctx.addIssue({ code: "custom", message: "Waterfall balances must form a finite range." });
      }),
    z
      .object({
        kind: z.literal("area"),
        ...ChartKindCommon,
        layout: z.literal("stacked"),
        normalize: z.boolean().optional(),
        x: list(z.union([z.number(), ChartLabel]), 1, limits?.maxValues),
        series: list(z.object({ label: ChartLabel, data: list(z.number().min(0).nullable(), 0, limits?.maxValues) }), 1, limits?.maxSeries),
        legend: z.boolean().optional(),
        format: numberFormat.optional(),
      })
      .superRefine((spec, ctx) => {
        spec.series.forEach((s, i) => {
          if (s.data.length !== spec.x.length)
            ctx.addIssue({ code: "custom", path: ["series", i, "data"], message: "Area series must match x length." });
        });
        spec.x.forEach((_, i) => {
          const sum = spec.series.reduce((sum, s) => sum + (s.data[i] ?? 0), 0);
          if (!Number.isFinite(sum)) ctx.addIssue({ code: "custom", path: ["x", i], message: "Area totals must be finite." });
        });
      }),
    z
      .object({
        kind: z.literal("bar"),
        ...ChartKindCommon,
        data: list(ChartCategory, 0, limits?.maxValues).default([]),
        x: list(ChartLabel, 0, limits?.maxValues).optional(),
        series: list(
          z.object({ label: ChartLabel, data: list(ChartNumber.nullable(), 0, limits?.maxValues) }),
          1,
          limits?.maxSeries,
        ).optional(),
        layout: z.enum(["columns", "rows", "grouped", "stacked"]).optional(),
        normalize: z.boolean().optional(),
        share: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
        tone: z.enum(["in", "out"]).optional(),
        format: numberFormat.optional(),
        compare: z.object({ label: ChartLabel, data: list(ChartNumber.nullable(), 0, limits?.maxValues) }).optional(),
        xAxis: ChartAxis.pick({ label: true }).extend({ ordered: z.boolean().optional() }).strict().optional(),
        yAxis: ChartAxis.optional(),
        colorByBar: z.boolean().optional(),
        showValues: z.boolean().optional(),
        legend: z.boolean().optional(),
        references: ChartReferences.optional(),
      })
      .superRefine((bar, ctx) => {
        const issue = (message: string) => ctx.addIssue({ code: "custom", message });
        if (limits && !bar.series && !bar.data.length)
          ctx.addIssue({ code: "custom", path: ["data"], message: "A bar chart needs data or aligned series." });
        if ((bar.share !== undefined || bar.limit !== undefined || bar.tone !== undefined) && bar.layout !== "rows")
          issue("Share, limit and tone require rows layout.");
        if (
          (bar.share !== undefined || bar.limit !== undefined || bar.tone !== undefined) &&
          bar.data.some((d) => Number.isFinite(d.value) && d.value < 0)
        )
          issue("Share, limit and tone need nonnegative values.");
        if (bar.series) {
          if (!bar.x || bar.series.some((s) => s.data.length !== bar.x?.length)) issue("Bar series must have the same length as x.");
          if (bar.data.length) issue("Use data or aligned series, not both.");
          if (bar.layout === "rows" || bar.layout === "columns") issue("Series bars use grouped or stacked layout.");
        } else if (bar.x || bar.compare || bar.layout === "grouped" || bar.layout === "stacked")
          issue("This layout needs aligned x and series.");
        if (bar.layout === "stacked" && bar.yAxis?.scale === "log") issue("Stacked bars need a linear axis.");
        if (bar.normalize && bar.layout !== "stacked") issue("Normalized bars must be stacked.");
        if (bar.layout === "stacked" && bar.series?.some((s) => s.data.some((v) => v !== null && v < 0)))
          issue("Stacked bars require nonnegative values.");
        if (bar.compare && (bar.series?.length !== 1 || bar.compare.data.length !== bar.x?.length || bar.layout === "stacked"))
          issue("Comparison needs one current series and aligned previous values.");
      }),
    z.object({
      kind: z.literal("funnel"),
      ...ChartKindCommon,
      data: list(z.object({ label: ChartLabel, value: z.number().nonnegative().nullable() }), 1, limits?.maxValues),
      format: numberFormat.optional(),
    }),
    z
      .object({
        kind: z.literal("hbar"),
        ...ChartKindCommon,
        series: list(ChartLabel, 1, limits?.maxSeries),
        rows: list(
          z.object({
            group: ChartLabel.optional(),
            label: ChartLabel,
            values: list(z.number().nonnegative().nullable(), 0, limits?.maxSeries),
          }),
          1,
          limits?.maxValues,
        ),
        legend: z.boolean().optional(),
        format: numberFormat.optional(),
      })
      .superRefine((bar, ctx) => {
        if (bar.rows.some((r) => r.values.length !== bar.series.length))
          ctx.addIssue({ code: "custom", message: "Horizontal bar values must match series." });
      }),
    z
      .object({
        kind: z.literal("line"),
        ...ChartKindCommon,
        series: list(
          ChartSeries(
            limits
              ? ChartLinePoints.min(2, "A line needs at least two points per series; show single values as a bar or scatter chart.")
              : ChartLinePoints,
          ).extend({ style: z.enum(["solid", "dashed", "dotted"]).optional() }),
          1,
          limits?.maxSeries,
        ),
        xAxis: ChartAxis.optional(),
        yAxis: ChartAxis.optional(),
        legend: z.boolean().optional(),
        area: z.boolean().optional(),
        smooth: z.boolean().optional(),
        step: z.enum(["after", "before", "middle"]).optional(),
        zero: z.boolean().optional(),
        legendValues: z.boolean().optional(),
        forecast: z
          .object({
            from: ChartCoordinate,
            band: list(z.tuple([z.number(), z.number()]), 0, limits?.maxValues).optional(),
          })
          .optional(),
        threshold: z.object({ value: z.number(), label: ChartLabel }).optional(),
        marker: z.object({ at: ChartCoordinate, label: ChartLabel }).optional(),
        references: ChartReferences.optional(),
      })
      .superRefine((spec, ctx) => {
        if (limits && !lineDetailsEnabled(spec))
          spec.series.forEach((series, seriesIndex) => {
            series.data.forEach((point, pointIndex) => {
              if (!Number.isFinite(point.y))
                ctx.addIssue({
                  code: "custom",
                  path: ["series", seriesIndex, "data", pointIndex, "y"],
                  message: "Null gaps require forecast, zero, threshold, marker or legendValues enabled.",
                });
            });
          });
        const coordinate = (x: number | string) => (typeof x === "number" ? x : chartDateTime(x));
        const at = spec.marker && coordinate(spec.marker.at);
        if (at !== undefined && spec.xAxis?.domain && (at < spec.xAxis.domain[0]! || at > spec.xAxis.domain[1]!))
          ctx.addIssue({ code: "custom", path: ["marker", "at"], message: "Marker must be inside the explicit X domain." });
        if (!spec.forecast) return;
        const from = coordinate(spec.forecast.from);
        const points = spec.series[0]?.data ?? [];
        if (!points.some((point) => coordinate(point.x) === from)) {
          ctx.addIssue({ code: "custom", path: ["forecast", "from"], message: "Forecast must start at an X value of the first series." });
        }
        const count = points.filter((point) => {
          const x = coordinate(point.x);
          return x !== undefined && from !== undefined && x >= from;
        }).length;
        if (spec.forecast.band && spec.forecast.band.length !== count)
          ctx.addIssue({
            code: "custom",
            path: ["forecast", "band"],
            message: "Forecast band must match the first series from forecast.from, ordered by X.",
          });
        spec.forecast.band?.forEach(([lo, hi], index) => {
          if (lo > hi)
            ctx.addIssue({
              code: "custom",
              path: ["forecast", "band", index],
              message: "Forecast lower bound must not exceed its upper bound.",
            });
        });
      }),
    z.object({
      kind: z.literal("scatter"),
      ...ChartKindCommon,
      series: list(ChartSeries(limits ? ChartPoints.min(1) : ChartPoints), 1, limits?.maxSeries),
      xAxis: ChartAxis.optional(),
      yAxis: ChartAxis.optional(),
      legend: z.boolean().optional(),
      references: ChartReferences.optional(),
    }),
    z.object({
      kind: z.enum(["pie", "donut"]),
      ...ChartKindCommon,
      data: list(ChartSlice, 1, limits?.maxValues),
      legend: z.boolean().optional(),
      showLabels: z.boolean().optional(),
      format: numberFormat.optional(),
    }),
    z.object({
      kind: z.literal("histogram"),
      ...ChartKindCommon,
      data: list(ChartNumber, 1, limits?.maxValues),
      bins: ChartBins.optional(),
      references: ChartReferences.optional(),
    }),
    z.object({
      kind: z.literal("gauge"),
      ...ChartKindCommon,
      value: ChartNumber,
      min: z.number().optional(),
      max: z.number().optional(),
      label: ChartLabel.optional(),
      unit: ChartUnit.optional(),
      format: numberFormat.optional(),
      thresholds: ChartThresholds.optional(),
    }),
    z.object({
      kind: z.literal("sparkline"),
      ...ChartKindCommon,
      data: list(ChartNumber, 2, limits?.maxValues),
      area: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("boxplot"),
      ...ChartKindCommon,
      data: list(ChartBox, 1, limits?.maxValues),
      yAxis: ChartAxis.optional(),
      references: ChartReferences.optional(),
    }),
    z.discriminatedUnion("layout", [
      z
        .object({
          kind: z.literal("heatmap"),
          ...ChartKindCommon,
          layout: z.literal("calendar"),
          data: list(
            z.tuple([
              z.string().refine((day) => {
                try {
                  calendarDay(day);
                  return true;
                } catch {
                  return false;
                }
              }, "Invalid ISO calendar day."),
              ChartNumber.nullable(),
            ]),
            1,
            limits?.maxMarks,
          ),
          scale: z.enum(["sequential", "diverging"]),
          label: ChartLabel.optional(),
          format: numberFormat.optional(),
          locale: chartLocaleSchema().optional(),
        })
        .superRefine((spec, ctx) => {
          if (ctx.issues.length) return;
          const times = spec.data.map(([day]) => calendarDay(day));
          if (times.length && (Math.max(...times) - Math.min(...times)) / 86400000 >= CALENDAR_MAX_DAYS)
            ctx.addIssue({ code: "custom", message: "Calendar span must not exceed three years." });
          if (new Set(spec.data.map(([day]) => day)).size !== spec.data.length)
            ctx.addIssue({ code: "custom", message: "Calendar dates must be unique." });
        }),
      z.object({
        kind: z.literal("heatmap"),
        ...ChartKindCommon,
        // An empty enum accepts no layout, exports as never, and lets optional() enumerate the absent discriminator.
        layout: z.enum([]).optional(),
        data: list(ChartCell, 1, limits?.maxMarks),
        format: numberFormat.optional(),
        showValues: z.boolean().optional(),
        min: z.number().optional(),
        max: z.number().optional(),
      }),
    ]),
    z.object({
      kind: z.literal("barGauge"),
      ...ChartKindCommon,
      // The shared renderer draws 280 units high and a bar gauge row is 28 units, so 8 rows fit without a taller drawing.
      data: list(ChartBarGauge, 1, limits?.maxSeries, `Use at most ${limits?.maxSeries} bar gauge items.`),
      min: z.number().optional(),
      max: z.number().optional(),
      unit: ChartUnit.optional(),
      format: numberFormat.optional(),
      thresholds: ChartThresholds.optional(),
    }),
    z.object({
      kind: z.literal("stat"),
      ...ChartKindCommon,
      value: ChartNumber,
      format: numberFormat.optional(),
      unit: ChartUnit.optional(),
      delta: limits ? z.number().optional() : ChartNumber,
      better: z.enum(["up", "down"]).optional(),
      sparkline: list(ChartNumber, 2, limits?.maxValues).optional(),
    }),
    z
      .object({
        kind: z.literal("treemap"),
        ...ChartKindCommon,
        groups: list(ChartLabel, 1, limits?.maxSeries),
        data: list(z.object({ label: ChartLabel, group: ChartLabel, value: z.number().nonnegative() }), 1, limits?.maxMarks),
        legend: z.boolean().optional(),
        format: numberFormat.optional(),
        locale: chartLocaleSchema().optional(),
      })
      .superRefine((spec, ctx) => {
        if (!Number.isFinite(spec.data.reduce((sum, d) => sum + d.value, 0)))
          ctx.addIssue({ code: "custom", message: "Treemap total must be finite." });
        if (spec.data.some((d) => !spec.groups.includes(d.group)))
          ctx.addIssue({ code: "custom", message: "Treemap groups must contain every item group." });
      }),
    z
      .object({
        kind: z.literal("pareto"),
        ...ChartKindCommon,
        labels: z.tuple([ChartLabel, ChartLabel]),
        data: list(
          z.object({ label: ChartLabel, value: z.number().nonnegative(), prev: z.number().nonnegative(), rest: z.boolean().optional() }),
          1,
          limits?.maxValues,
        ),
        format: numberFormat.optional(),
        locale: chartLocaleSchema().optional(),
      })
      .superRefine((spec, ctx) => {
        if (!Number.isFinite(spec.data.reduce((sum, d) => sum + d.value, 0)))
          ctx.addIssue({ code: "custom", message: "Pareto total must be finite." });
      }),
    z
      .object({
        kind: z.literal("sankey"),
        ...ChartKindCommon,
        nodes: list(
          z.object({
            id: z.string().min(1),
            label: ChartLabel,
            tone: z.enum(["in", "out", "muted", "blue", "green", "amber", "red", "violet", "tax"]).optional(),
          }),
          1,
          limits?.maxValues,
        ),
        links: list(z.object({ source: z.string(), target: z.string(), value: z.number().positive() }), 1, limits?.maxMarks),
        legend: list(
          z.object({ tone: z.enum(["in", "out", "muted", "blue", "green", "amber", "red", "violet", "tax"]), label: ChartLabel }),
          0,
          limits?.maxSeries,
        ).optional(),
        format: numberFormat.optional(),
        locale: chartLocaleSchema().optional(),
      })
      .superRefine((spec, ctx) => {
        try {
          sankeyGraph(spec);
        } catch (error) {
          ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid Sankey graph." });
        }
      }),
    z
      .object({
        kind: z.literal("bubble"),
        ...ChartKindCommon,
        groups: list(ChartLabel, 1, limits?.maxSeries),
        data: list(
          z.object({ label: ChartLabel, group: ChartLabel, x: z.number(), y: z.number(), size: z.number().nonnegative().optional() }),
          1,
          limits?.maxMarks,
        ),
        xLabel: ChartLabel,
        yLabel: ChartLabel,
        sizeLabel: ChartLabel.optional(),
        averages: z.boolean().optional(),
        legend: z.boolean().optional(),
        xFormat: numberFormat.optional(),
        yFormat: numberFormat.optional(),
        format: numberFormat.optional(),
        locale: chartLocaleSchema().optional(),
      })
      .superRefine((spec, ctx) => {
        if (spec.data.some((p) => !spec.groups.includes(p.group)))
          ctx.addIssue({ code: "custom", message: "Bubble groups must contain every point group." });
        for (const key of ["x", "y"] as const)
          if (!Number.isFinite(Math.max(0, ...spec.data.map((p) => p[key])) - Math.min(0, ...spec.data.map((p) => p[key]))))
            ctx.addIssue({ code: "custom", message: "Bubble coordinate ranges must be finite." });
      }),
    z
      .object({
        kind: z.literal("radar"),
        ...ChartKindCommon,
        axes: z.array(ChartLabel).min(3).max(8),
        max: z.number().positive(),
        unit: ChartUnit.optional(),
        series: z
          .array(z.object({ label: ChartLabel, data: z.array(z.number().nonnegative()).min(3).max(8) }))
          .min(1)
          .max(4),
        format: numberFormat.optional(),
        legend: z.boolean().optional(),
        locale: chartLocaleSchema().optional(),
      })
      .superRefine((spec, ctx) => {
        if (spec.series.some((s) => s.data.length !== spec.axes.length || s.data.some((v) => v > spec.max)))
          ctx.addIssue({ code: "custom", message: "Radar series need one value per axis between zero and the common maximum." });
      }),
  ]);
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * A chart date as UTC milliseconds, so calendar days and wall-clock times stay as written on every device. Impossible
 * dates such as February 30 are undefined: engines would move them into March or refuse them, each in its own way.
 */
export const chartDateTime = (value: string): number | undefined => {
  const match = DATE.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  date.setUTCHours(Number(hour), Number(minute), Number(second));
  // Parts out of range roll over, so a date that does not read back as written does not exist.
  return date.toISOString().startsWith(`${year}-${month}-${day}T${hour}:${minute}:${second}`) ? date.getTime() : undefined;
};

export type ChartAxisInput = { label?: string; domain?: number[]; ticks?: number; scale?: "linear" | "log"; format?: ChartFormat };

const dateTime = (value: number | string) => (typeof value === "number" ? value : (chartDateTime(value) ?? Number.NaN));
/** The renderer's default tick count. */
const TICKS = 5;

export const chartReferenceValues = (input: ChartInput, name: "x" | "y") => {
  const values =
    "references" in input ? (input.references ?? []).filter((ref) => (ref.axis ?? "y") === name).map((ref) => dateTime(ref.value)) : [];
  if (input.kind === "line") {
    if (name === "x") {
      if (input.forecast) values.push(dateTime(input.forecast.from));
      if (input.marker) values.push(dateTime(input.marker.at));
    } else {
      if (input.threshold) values.push(input.threshold.value);
      if (input.zero) values.push(0);
      for (const bounds of input.forecast?.band ?? []) values.push(...bounds);
    }
  }
  return values;
};

/** The value axes of a chart with what they show: the data checks and the label room read them alike. */
export const chartValueAxes = (input: ChartInput): { values: number[]; axis?: ChartAxisInput; zero?: boolean; name: "x" | "y" }[] => {
  if (input.kind === "bar")
    return [
      {
        values: [
          ...input.data.map((item) => item.value),
          ...(input.series?.flatMap((s) => s.data.filter((v): v is number => v !== null)) ?? []),
          ...(input.compare?.data.filter((v): v is number => v !== null) ?? []),
        ],
        axis: input.yAxis,
        zero: true,
        name: "y",
      },
    ];
  if (input.kind === "boxplot") return [{ values: input.data.flatMap((item) => item.values), axis: input.yAxis, name: "y" }];
  if (input.kind === "histogram") {
    if (!input.references?.length) return [{ values: input.data, name: "x" }];
    const { edges, counts } = autoBin(input.data, input.bins);
    return [
      { values: edges, name: "x" },
      { values: counts, zero: true, name: "y" },
    ];
  }
  if (input.kind !== "line" && input.kind !== "scatter") return [];
  const points = input.series.flatMap((series) => series.data);
  return [
    { values: points.map((point) => dateTime(point.x)), axis: input.xAxis, name: "x" },
    { values: points.map((point) => point.y), axis: input.yAxis, name: "y" },
  ];
};

/**
 * Whether the renderer can step from the lowest to the highest tick. Values that differ by less than the float
 * precision of their size, such as 1e17 and 1e17 + 16, would make it count forever.
 */
const steppable = (values: number[], ticks = TICKS) => {
  const [min, max] = computeDomain(values);
  const step = niceStep(max - min, ticks);
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step].every((value) => value + step !== value && value - step !== value);
};

/** Rejects only precision ranges that would make the renderer count ticks forever. */
export function chartSteppingIssue(input: ChartInput): string | undefined {
  // Check raw observations before autoBin computes histogram edges.
  if (input.kind === "histogram" && !steppable(input.data))
    return "The values differ too little for their size to label an axis; subtract a common offset first.";
  for (const { values: data, axis, zero, name } of chartValueAxes(input)) {
    const values = [...data, ...chartReferenceValues(input, name)];
    if (axis?.scale !== "log" && !axis?.domain && !steppable(zero ? [...values, 0] : values, axis?.ticks))
      return "The values differ too little for their size to label an axis; subtract a common offset first.";
  }
  return undefined;
}

/** Application chart schema: permissive observations, with the renderer's tick-safety guard. */
export const chartSchema = (limits?: ChartLimits) =>
  chartKinds(limits).superRefine(
    (chart, context) => {
      const issue = chartSteppingIssue(chart);
      if (issue) context.addIssue({ code: "custom", message: issue });
    },
    { when: (payload) => payload.issues.length === 0 },
  );

// Both directions are checked: a validator change must update the ui-owned description too.
type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type _ChartSchemaMatchesDescription = Assert<Same<z.output<ReturnType<typeof chartKinds>>, ChartInput>>;
type _ChartNumberFormatSchemaMatchesDescription = Assert<
  Same<z.output<ReturnType<typeof chartNumberFormatSchema>>, import("@k2b/ui/charts").ChartNumberFormat>
>;
