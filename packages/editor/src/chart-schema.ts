import type { ChartInput, ChartLimits } from "@k2b/ui/charts";
import { CALENDAR_MAX_DAYS, calendarDay } from "@k2b/ui/charts/core";
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
    ChartSeries: (points: z.ZodArray<typeof ChartPoint>) =>
      z.object({
        label: ChartLabel.optional(),
        data: points,
        role: z.literal("reference").optional(),
      }),
    ChartPoints: list(ChartPoint, 0, limits?.maxValues),
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
    ChartPoints,
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
        layout: z.enum(["columns", "rows", "grouped", "stacked", "nested"]).optional(),
        normalize: z.boolean().optional(),
        marks: z.enum(["bars", "dots"]).optional(),
        total: z.number().positive().optional(),
        dots: z
          .number()
          .int()
          .min(2)
          .refine((v) => v % 2 === 0, "Dot count must be even.")
          .optional(),
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
        if (bar.layout === "rows" && bar.data.some((d) => Number.isFinite(d.value) && d.value < 0))
          issue("Ranked bar lists require nonnegative values.");
        if (bar.series) {
          if (!bar.x || bar.series.some((s) => s.data.length !== bar.x?.length)) issue("Bar series must have the same length as x.");
          if (bar.data.length) issue("Use data or aligned series, not both.");
          if (bar.layout === "rows" || bar.layout === "columns") issue("Series bars use grouped or stacked layout.");
        } else if (bar.x || bar.compare || bar.layout === "grouped" || bar.layout === "stacked" || bar.layout === "nested")
          issue("This layout needs aligned x and series.");
        if (bar.layout === "stacked" && bar.yAxis?.scale === "log") issue("Stacked bars need a linear axis.");
        if (bar.normalize && bar.layout !== "stacked") issue("Normalized bars must be stacked.");
        if (bar.layout === "nested" && bar.marks !== "dots") issue("Nested bars require dot marks.");
        if (bar.marks !== "dots" && (bar.total !== undefined || bar.dots !== undefined)) issue("Total and dots belong to dot matrices.");
        if (bar.marks === "dots") {
          if (bar.layout !== "nested" || !bar.series?.length || bar.compare || bar.normalize || bar.yAxis?.scale === "log")
            issue("Dot matrices require nested series on a linear axis, without comparison or normalization.");
          const total =
            bar.total ??
            Math.max(1, ...(bar.series?.flatMap((s) => s.data.filter((v): v is number => v !== null && Number.isFinite(v))) ?? []));
          if (bar.yAxis?.domain && (bar.yAxis.domain[0] !== 0 || bar.yAxis.domain[1] !== total))
            issue("Dot matrix domain must be zero to total.");
          bar.series?.forEach((s, i) =>
            s.data.forEach((v, j) => {
              if (v === null || !Number.isFinite(v)) return;
              if (v < 0 || v > total) issue("Nested counts must be nonnegative and at most total.");
              const parent = bar.series?.[i - 1]?.data[j];
              if (i > 0 && parent != null && Number.isFinite(parent) && v > parent)
                issue("Each nested count must be a subset of the previous series.");
            }),
          );
        }
        if (bar.layout === "stacked" && bar.series?.some((s) => s.data.some((v) => v !== null && v < 0)))
          issue("Stacked bars require nonnegative values.");
        if (
          bar.compare &&
          (bar.series?.length !== 1 || bar.compare.data.length !== bar.x?.length || bar.layout === "stacked" || bar.layout === "nested")
        )
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
    z.object({
      kind: z.literal("line"),
      ...ChartKindCommon,
      series: list(
        ChartSeries(
          limits
            ? ChartPoints.min(2, "A line needs at least two points per series; show single values as a bar or scatter chart.")
            : ChartPoints,
        ).extend({ style: z.enum(["solid", "dashed", "dotted"]).optional() }),
        1,
        limits?.maxSeries,
      ),
      xAxis: ChartAxis.optional(),
      yAxis: ChartAxis.optional(),
      legend: z.boolean().optional(),
      area: z.boolean().optional(),
      smooth: z.boolean().optional(),
      references: ChartReferences.optional(),
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
        layout: z.undefined().optional(),
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
        data: list(z.object({ label: ChartLabel, value: z.number().nonnegative(), prev: z.number().nonnegative() }), 1, limits?.maxValues),
        format: numberFormat.optional(),
        locale: chartLocaleSchema().optional(),
      })
      .superRefine((spec, ctx) => {
        if (!Number.isFinite(spec.data.reduce((sum, d) => sum + d.value, 0)))
          ctx.addIssue({ code: "custom", message: "Pareto total must be finite." });
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

// Both directions are checked: a validator change must update the ui-owned description too.
type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type _ChartSchemaMatchesDescription = Assert<Same<z.output<ReturnType<typeof chartKinds>>, ChartInput>>;
type _ChartNumberFormatSchemaMatchesDescription = Assert<
  Same<z.output<ReturnType<typeof chartNumberFormatSchema>>, import("@k2b/ui/charts").ChartNumberFormat>
>;
