import { z } from "zod";
import { chartDataIssue, chartDateTime, chartDrawingIssue, chartSteppingIssue, cloudAiChartMarks } from "./chart-block";

const ToneSchema = z.enum(["neutral", "blue", "teal", "green", "amber", "red"]);

export const CloudAiCardInputSchema = z.object({
  title: z.string().min(1),
  value: z.string().min(1).describe("The figure or status itself, short enough to read at a glance: about 20 characters."),
  emoji: z.string().max(8).optional().describe("Optional single emoji shown next to the card content. Omit when none fits."),
  caption: z.string().optional().describe("Optional scope or time range of the value in one short line."),
  tone: ToneSchema.default("teal"),
  trendLabel: z.string().min(1).optional(),
  trendValue: z.string().min(1).optional(),
  trendDirection: z.enum(["up", "down", "flat"]).default("flat"),
});
export const CloudAiCardOutputSchema = z.object({ displayed: z.boolean() });

/** The chart palette has eight colors; a ninth series would repeat one. */
export const CLOUD_AI_CHART_MAX_SERIES = 8;
/** Charts draw on a 480-unit wide plane: more values per list than units cannot be told apart. */
export const CLOUD_AI_CHART_MAX_VALUES = 480;

/** A view, including a group of charts, never draws more marks than the largest single chart. */
export const CLOUD_AI_VIEW_MAX_MARKS = CLOUD_AI_CHART_MAX_SERIES * CLOUD_AI_CHART_MAX_VALUES;
/**
 * Every chart of a group mounts its own frame, axes and controls: about 30 ms each on a phone (4x CPU throttling)
 * even with a dozen points. Six stay within the 200 ms in which a response still feels immediate; eight took 420 ms.
 */
export const CLOUD_AI_GROUP_MAX_CHARTS = 6;

// Every chart schema is built by a function whose call is marked pure, so a bundle that imports neither chart contract
// leaves them out. App frames include the app contract through `cloud.chart()`.
export const cloudAiNumberFormatSchema = () =>
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
export const cloudAiFormatSchema = () => z.union([cloudAiNumberFormatSchema(), dateFormatSchema()]);
export type CloudAiNumberFormat = z.output<ReturnType<typeof cloudAiNumberFormatSchema>>;
export type CloudAiDateFormat = z.output<ReturnType<typeof dateFormatSchema>>;
export type CloudAiFormat = CloudAiNumberFormat | CloudAiDateFormat;

export const cloudAiChartKindSchema = () =>
  z.enum(["bar", "line", "scatter", "pie", "donut", "histogram", "gauge", "sparkline", "boxplot", "heatmap", "barGauge", "stat"]);

const chartParts = (limits = true) => {
  const ChartLabel = limits ? z.string().trim().min(1).max(80) : z.union([z.string(), z.number().transform(String)]);
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
    CLOUD_AI_CHART_MAX_SERIES,
    `Use at most ${CLOUD_AI_CHART_MAX_SERIES} references.`,
  );
  // One palette color per band.
  const ChartThresholds = list(
    z.object({ value: z.number(), label: ChartLabel.optional() }),
    1,
    CLOUD_AI_CHART_MAX_SERIES,
    `Use at most ${CLOUD_AI_CHART_MAX_SERIES} thresholds.`,
  );
  return {
    ChartLabel,
    ChartNumber,
    list,
    ChartReferences,
    ChartThresholds,
    ChartAxis: z.object({
      label: ChartLabel.optional(),
      domain: z.array(z.number()).length(2).optional().describe("Exact [min, max]; must contain every value and reference."),
      ticks: (limits ? z.number().int().min(2).max(12) : z.number().int().min(2)).optional(),
      scale: z.enum(["linear", "log"]).optional().describe("log needs values above zero."),
      format: cloudAiFormatSchema().optional(),
    }),
    ChartCategory: z.object({ label: ChartLabel, value: ChartNumber }),
    ChartSlice: z.object({ label: ChartLabel, value: limits ? z.number().min(0) : ChartNumber }),
    ChartSeries: (points: z.ZodArray<typeof ChartPoint>) =>
      z.object({
        label: ChartLabel.optional(),
        data: points,
        role: z.literal("reference").optional(),
      }),
    ChartPoints: list(ChartPoint, 0, CLOUD_AI_CHART_MAX_VALUES),
    ChartBins: z
      .union([
        limits ? z.number().int().min(1).max(CLOUD_AI_CHART_MAX_VALUES) : z.number().int().min(1),
        limits
          ? z
              .array(z.number())
              .min(2)
              .max(CLOUD_AI_CHART_MAX_VALUES + 1)
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

const chartKinds = (limits = true) => {
  const {
    ChartNumber,
    list,
    ChartAxis,
    ChartBins,
    ChartCategory,
    ChartCommon,
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
  const numberFormat = cloudAiNumberFormatSchema();
  return z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("bar"),
      ...ChartCommon,
      data: list(ChartCategory, 1, CLOUD_AI_CHART_MAX_VALUES),
      yAxis: ChartAxis.optional(),
      colorByBar: z.boolean().optional(),
      showValues: z.boolean().optional(),
      legend: z.boolean().optional(),
      references: ChartReferences.optional(),
    }),
    z.object({
      kind: z.literal("line"),
      ...ChartCommon,
      series: list(
        ChartSeries(
          limits
            ? ChartPoints.min(2, "A line needs at least two points per series; show single values as a bar or scatter chart.")
            : ChartPoints,
        ).extend({ style: z.enum(["solid", "dashed", "dotted"]).optional() }),
        1,
        CLOUD_AI_CHART_MAX_SERIES,
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
      ...ChartCommon,
      series: list(ChartSeries(limits ? ChartPoints.min(1) : ChartPoints), 1, CLOUD_AI_CHART_MAX_SERIES),
      xAxis: ChartAxis.optional(),
      yAxis: ChartAxis.optional(),
      legend: z.boolean().optional(),
      references: ChartReferences.optional(),
    }),
    z.object({
      kind: z.enum(["pie", "donut"]),
      ...ChartCommon,
      data: list(ChartSlice, 1, CLOUD_AI_CHART_MAX_VALUES),
      legend: z.boolean().optional(),
      showLabels: z.boolean().optional(),
      format: numberFormat.optional(),
    }),
    z.object({
      kind: z.literal("histogram"),
      ...ChartCommon,
      data: list(ChartNumber, 1, CLOUD_AI_CHART_MAX_VALUES),
      bins: ChartBins.optional(),
      references: ChartReferences.optional(),
    }),
    z.object({
      kind: z.literal("gauge"),
      ...ChartCommon,
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
      ...ChartCommon,
      data: list(ChartNumber, 2, CLOUD_AI_CHART_MAX_VALUES),
      area: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("boxplot"),
      ...ChartCommon,
      data: list(ChartBox, 1, CLOUD_AI_CHART_MAX_VALUES),
      yAxis: ChartAxis.optional(),
      references: ChartReferences.optional(),
    }),
    z.object({
      kind: z.literal("heatmap"),
      ...ChartCommon,
      data: list(ChartCell, 1, CLOUD_AI_VIEW_MAX_MARKS),
      format: numberFormat.optional(),
      showValues: z.boolean().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
    }),
    z.object({
      kind: z.literal("barGauge"),
      ...ChartCommon,
      // The shared renderer draws 280 units high and a bar gauge row is 28 units, so 8 rows fit without a taller drawing.
      data: list(ChartBarGauge, 1, CLOUD_AI_CHART_MAX_SERIES, `Use at most ${CLOUD_AI_CHART_MAX_SERIES} bar gauge items.`),
      min: z.number().optional(),
      max: z.number().optional(),
      unit: ChartUnit.optional(),
      format: numberFormat.optional(),
      thresholds: ChartThresholds.optional(),
    }),
    z.object({
      kind: z.literal("stat"),
      ...ChartCommon,
      value: ChartNumber,
      format: numberFormat.optional(),
      unit: ChartUnit.optional(),
      delta: limits ? z.number().optional() : ChartNumber,
      better: z.enum(["up", "down"]).optional(),
      sparkline: list(ChartNumber, 2, CLOUD_AI_CHART_MAX_VALUES).optional(),
    }),
  ]);
};

/** Checks run on complete input only, so out-of-range input fails on its bounds before anything is computed or drawn. */
const whenValid = { when: (payload: { issues: readonly unknown[] }) => payload.issues.length === 0 };

export const cloudAiChartSchema = () =>
  chartKinds().superRefine((chart, context) => {
    const total = cloudAiChartMarks(chart);
    const issue =
      total > CLOUD_AI_VIEW_MAX_MARKS
        ? `The chart has ${total} marks; the limit is ${CLOUD_AI_VIEW_MAX_MARKS}. Aggregate or split into several views.`
        : chartDataIssue(chart);
    if (issue) context.addIssue({ code: "custom", message: issue });
  }, whenValid);
/** Apps retain the renderer's permissive data contract, except values that would stall tick generation. */
export const cloudAiAppChartSchema = () =>
  chartKinds(false).superRefine((chart, context) => {
    const issue = chartSteppingIssue(chart);
    if (issue) context.addIssue({ code: "custom", message: issue });
  }, whenValid);
const ChartSchema = /* @__PURE__ */ cloudAiChartSchema();

/** One chart as the renderers read it: a `cloud.chart()` kind with its options. */
export type CloudAiChartInput = z.output<ReturnType<typeof chartKinds>>;

/**
 * Reads one chart without drawing it; undefined when it is not a chart. Writers have drawn it once already, so
 * renderers draw only for display.
 */
export const parseCloudAiChartInput = (value: unknown): CloudAiChartInput | undefined => {
  const parsed = ChartSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export const cloudAiGroupSchema = () => {
  const { ChartCommon } = chartParts();
  return z
    .strictObject({
      ...ChartCommon,
      charts: z
        .array(cloudAiChartSchema())
        .min(2, "Use at least 2 charts in a group.")
        .max(CLOUD_AI_GROUP_MAX_CHARTS, `Use at most ${CLOUD_AI_GROUP_MAX_CHARTS} charts in a group.`),
      linkX: z.boolean().optional(),
      layout: z.enum(["stack", "grid"]).optional(),
    })
    .superRefine((group, context) => {
      const total = group.charts.reduce((sum, chart) => sum + cloudAiChartMarks(chart), 0);
      if (total > CLOUD_AI_VIEW_MAX_MARKS)
        context.addIssue({
          code: "custom",
          message: `The group has ${total} marks; the limit is ${CLOUD_AI_VIEW_MAX_MARKS}. Aggregate or split into several views.`,
        });
      if (
        group.linkX &&
        (group.charts.some((chart) => chart.kind !== "line") ||
          new Set(
            group.charts.flatMap((chart) =>
              chart.kind === "line" ? chart.series.flatMap((series) => series.data.map((point) => typeof point.x)) : [],
            ),
          ).size !== 1)
      )
        context.addIssue({ code: "custom", path: ["linkX"], message: "linkX links line charts with the same kind of x." });
    }, whenValid);
};

const flatChartSchema = () => {
  const { ChartAxis, ChartBins, ChartCommon, ChartLabel, ChartPoints, ChartSeries, ChartReferences, ChartThresholds, ChartUnit } =
    chartParts();
  return z.object({
    kind: cloudAiChartKindSchema().optional().describe("Single charts: kind. Omit for groups."),
    ...ChartCommon,
    // One item object preserves every kind's fields before canonical validation; unions would strip overlapping items.
    data: z
      .union([
        z
          .array(
            z.object({
              label: ChartLabel.optional(),
              value: z.number().optional(),
              values: z.array(z.number()).min(1).optional(),
              x: ChartLabel.optional(),
              y: ChartLabel.optional(),
              min: z.number().optional(),
              max: z.number().optional(),
            }),
          )
          .min(1)
          .max(CLOUD_AI_VIEW_MAX_MARKS),
        z.array(z.number()).min(1).max(CLOUD_AI_CHART_MAX_VALUES),
      ])
      .optional()
      .describe(
        "bar, pie, donut, barGauge: label/value (barGauge: min/max). boxplot: label/values. heatmap: x/y/value. histogram, sparkline: numbers.",
      ),
    series: z
      .array(ChartSeries(ChartPoints.min(1)).extend({ style: z.enum(["solid", "dashed", "dotted"]).optional() }))
      .min(1)
      .max(CLOUD_AI_CHART_MAX_SERIES)
      .optional()
      .describe("line, scatter: label/data, optional reference role; line: style. Line needs 2 points per series."),
    xAxis: ChartAxis.optional().describe("line, scatter: x axis."),
    yAxis: ChartAxis.optional().describe("bar, line, scatter, boxplot: y axis."),
    legend: z
      .boolean()
      .optional()
      .describe("bar (colorByBar), line, scatter, pie, donut: legend; defaults to several series or unlabeled slices."),
    colorByBar: z.boolean().optional().describe("bar: one palette color per bar."),
    showValues: z.boolean().optional().describe("bar, heatmap: print values."),
    area: z.boolean().optional().describe("line, sparkline: fill under the line."),
    smooth: z.boolean().optional().describe("line: smooth curves."),
    showLabels: z.boolean().optional().describe("pie, donut: name slices next to them."),
    bins: ChartBins.optional(),
    value: z.number().optional().describe("gauge, stat: value."),
    min: z.number().optional().describe("gauge, barGauge: scale start (default 0). heatmap: color minimum."),
    max: z.number().optional().describe("gauge, barGauge: scale end (default 100). heatmap: color maximum."),
    label: ChartLabel.optional().describe("gauge: what the value measures."),
    unit: ChartUnit.optional().describe("gauge, barGauge, stat: unit after value."),
    format: cloudAiNumberFormatSchema()
      .optional()
      .describe("gauge, barGauge, stat, heatmap, pie, donut: number format; percent values are fractions."),
    references: ChartReferences.optional().describe(
      "bar, line, scatter, histogram, boxplot: reference lines; x only for line, scatter, histogram.",
    ),
    thresholds: ChartThresholds.optional().describe("gauge, barGauge: ascending band bounds, within min/max."),
    delta: z.number().optional().describe("stat: change, in the value's units."),
    better: z.enum(["up", "down"]).optional().describe("stat: which direction improves the measure."),
    sparkline: z.array(z.number()).min(2).max(CLOUD_AI_CHART_MAX_VALUES).optional().describe("stat: recent values in order."),
  });
};
const chartInputSchema = () => {
  const flat = flatChartSchema();
  const groupSchema = cloudAiGroupSchema();
  return flat
    .extend({
      charts: z
        .array(flat.required({ kind: true }).strict())
        .min(2)
        .max(CLOUD_AI_GROUP_MAX_CHARTS)
        .optional()
        .describe(`Groups: 2..${CLOUD_AI_GROUP_MAX_CHARTS} related charts, each with a kind.`),
      linkX: z.boolean().optional().describe("Groups: share the x cursor between line charts with the same kind of x."),
      layout: z.enum(["stack", "grid"]).optional().describe("Groups: stack (default) or grid."),
    })
    .superRefine((value, context) => {
      if ((value.kind !== undefined) === (value.charts !== undefined)) {
        context.addIssue({ code: "custom", message: "Set exactly one of kind or charts." });
        return;
      }
      if (value.charts !== undefined) {
        const parsed = groupSchema.safeParse(value);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) context.addIssue({ code: "custom", message: issue.message, path: issue.path });
          return;
        }
        parsed.data.charts.forEach((chart, index) => {
          const issue = chartDrawingIssue(chart);
          if (issue) context.addIssue({ code: "custom", message: issue, path: ["charts", index] });
        });
      } else {
        if (value.linkX !== undefined || value.layout !== undefined)
          context.addIssue({ code: "custom", message: "linkX and layout belong to groups." });
        const parsed = ChartSchema.safeParse(value);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) context.addIssue({ code: "custom", message: issue.message, path: issue.path });
          return;
        }
        const issue = chartDrawingIssue(parsed.data);
        if (issue) context.addIssue({ code: "custom", message: issue });
      }
    }, whenValid);
};

/**
 * The `cloud.chart()` options of Studio code as plain data, without `width`, `height` and `format` functions, or a
 * group of such charts. Model providers accept only an object at the root of a tool schema, so every kind shares one
 * object and each field names the kinds it belongs to; the kind's or group's own rules are checked after that. Valid
 * input also draws: values outside a domain, values at or below zero on a log axis, or a pie too small for its legend
 * fail here instead of in the chat.
 */
export const CloudAiChartInputSchema = /* @__PURE__ */ chartInputSchema();
export const CloudAiChartOutputSchema = z.object({ displayed: z.boolean() });

const SurveyQuestionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("single"),
    id: z.string().min(1),
    label: z.string().min(1),
    required: z.boolean().default(false),
    options: z
      .array(z.object({ value: z.string().min(1), label: z.string().min(1) }))
      .min(2)
      .max(8),
  }),
  z.object({
    type: z.literal("multiple"),
    id: z.string().min(1),
    label: z.string().min(1),
    required: z.boolean().default(false),
    options: z
      .array(z.object({ value: z.string().min(1), label: z.string().min(1) }))
      .min(2)
      .max(8),
  }),
  z.object({
    type: z.literal("text"),
    id: z.string().min(1),
    label: z.string().min(1),
    required: z.boolean().default(false),
    placeholder: z.string().optional(),
  }),
  z.object({
    type: z.literal("rating"),
    id: z.string().min(1),
    label: z.string().min(1),
    required: z.boolean().default(false),
    min: z.number().int().min(0).default(1),
    max: z.number().int().max(10).default(5),
  }),
]);

export const CloudAiSurveyInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  submitLabel: z.string().default("Submit"),
  questions: z.array(SurveyQuestionSchema).min(1).max(8),
});
export const CloudAiSurveyOutputSchema = z.object({
  submitted: z.boolean(),
  answers: z.record(z.string(), z.unknown()).default({}),
});

export const CLOUD_AI_TEXT_EDITOR_MAX_CHARS = 20_000;
export const CLOUD_AI_TEXT_EDITOR_FEEDBACK_MAX_CHARS = 2_000;

export const CloudAiTextEditorInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(1_000).optional(),
  content: z.string().max(CLOUD_AI_TEXT_EDITOR_MAX_CHARS),
  format: z.enum(["plain", "markdown"]).default("plain"),
  submitLabel: z.string().trim().min(1).max(40).default("Continue"),
});

export const CloudAiTextEditorOutputSchema = z.discriminatedUnion("submitted", [
  z.object({
    submitted: z.literal(true),
    content: z.string().max(CLOUD_AI_TEXT_EDITOR_MAX_CHARS),
    format: z.enum(["plain", "markdown"]),
  }),
  z.object({
    submitted: z.literal(false),
    feedback: z.string().trim().min(1).max(CLOUD_AI_TEXT_EDITOR_FEEDBACK_MAX_CHARS),
  }),
]);

export const CloudAiLocalBashInputSchema = z.object({
  command: z.string().trim().min(1).max(20_000),
});

export const CloudAiLocalBashOutputSchema = z.object({
  status: z.enum(["completed", "denied", "failed", "timed_out"]),
  exitCode: z.number().int().nullable(),
  stdout: z.string().max(512 * 1024),
  stderr: z.string().max(512 * 1024),
  truncated: z.boolean(),
});

export type CloudAiCardInput = z.infer<typeof CloudAiCardInputSchema>;
export type CloudAiCardOutput = z.infer<typeof CloudAiCardOutputSchema>;
export type CloudAiChartOutput = z.infer<typeof CloudAiChartOutputSchema>;
export type CloudAiSurveyInput = z.infer<typeof CloudAiSurveyInputSchema>;
export type CloudAiSurveyOutput = z.infer<typeof CloudAiSurveyOutputSchema>;
export type CloudAiTextEditorInput = z.infer<typeof CloudAiTextEditorInputSchema>;
export type CloudAiTextEditorOutput = z.infer<typeof CloudAiTextEditorOutputSchema>;
export type CloudAiLocalBashInput = z.infer<typeof CloudAiLocalBashInputSchema>;
export type CloudAiLocalBashOutput = z.infer<typeof CloudAiLocalBashOutputSchema>;
