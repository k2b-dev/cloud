import { z } from "zod";

/** Optional caller policy. Rendering itself has no AI input budget. */
export type ChartLimits = { maxSeries: number; maxValues: number; maxMarks: number };

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
export type ChartNumberFormat = z.output<ReturnType<typeof chartNumberFormatSchema>>;
export type ChartDateFormat = z.output<ReturnType<typeof dateFormatSchema>>;
export type ChartFormat = ChartNumberFormat | ChartDateFormat;

export const chartKindSchema = () =>
  z.enum(["bar", "line", "scatter", "pie", "donut", "histogram", "gauge", "sparkline", "boxplot", "heatmap", "barGauge", "stat"]);

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
    z.object({ value: z.union([z.number(), ChartDate]), axis: z.enum(["x", "y"]).optional(), label: ChartLabel.optional() }),
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
    z.object({
      kind: z.literal("bar"),
      ...ChartKindCommon,
      data: list(ChartCategory, 1, limits?.maxValues),
      xAxis: ChartAxis.pick({ label: true }).strict().optional(),
      yAxis: ChartAxis.optional(),
      colorByBar: z.boolean().optional(),
      showValues: z.boolean().optional(),
      legend: z.boolean().optional(),
      references: ChartReferences.optional(),
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
    z.object({
      kind: z.literal("heatmap"),
      ...ChartKindCommon,
      data: list(ChartCell, 1, limits?.maxMarks),
      format: numberFormat.optional(),
      showValues: z.boolean().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
    }),
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

/** One chart as the shared renderers read it. */
export type ChartInput = z.output<ReturnType<typeof chartKinds>>;
