import { z } from "zod";
import { chartDataIssue, chartDrawingIssue, cloudAiChartMarks } from "./chart-block";

// Chart-only browser consumers must not initialize unrelated visual tool schemas.
const ToneSchema = /* @__PURE__ */ (() => z.enum(["neutral", "blue", "teal", "green", "amber", "red"]))();

export const CloudAiCardInputSchema = /* @__PURE__ */ (() =>
  z.object({
    title: z.string().min(1),
    value: z.string().min(1).describe("The figure or status itself, short enough to read at a glance: about 20 characters."),
    emoji: z.string().max(8).optional().describe("Optional single emoji shown next to the card content. Omit when none fits."),
    caption: z.string().optional().describe("Optional scope or time range of the value in one short line."),
    tone: ToneSchema.default("teal"),
    trendLabel: z.string().min(1).optional(),
    trendValue: z.string().min(1).optional(),
    trendDirection: z.enum(["up", "down", "flat"]).default("flat"),
  }))();
export const CloudAiCardOutputSchema = /* @__PURE__ */ (() => z.object({ displayed: z.boolean() }))();

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

import {
  type ChartInput as CloudAiChartInput,
  type ChartDateFormat as CloudAiDateFormat,
  type ChartFormat as CloudAiFormat,
  type ChartNumberFormat as CloudAiNumberFormat,
  chartAcceptsLocale,
  chartKinds,
  chartLocaleSchema,
  chartParts,
  chartSchema,
  chartKindSchema as cloudAiChartKindSchema,
  chartFormatSchema as cloudAiFormatSchema,
  chartNumberFormatSchema as cloudAiNumberFormatSchema,
} from "@k2b/editor/charts";

export type { CloudAiChartInput, CloudAiDateFormat, CloudAiFormat, CloudAiNumberFormat };
// Portable formats and chart types retain their existing Cloud export names.
export { cloudAiChartKindSchema, cloudAiFormatSchema, cloudAiNumberFormatSchema };

const chartLimits = { maxSeries: CLOUD_AI_CHART_MAX_SERIES, maxValues: CLOUD_AI_CHART_MAX_VALUES, maxMarks: CLOUD_AI_VIEW_MAX_MARKS };

/** Checks run on complete input only, so out-of-range input fails on its bounds before anything is computed or drawn. */
const whenValid = { when: (payload: { issues: readonly unknown[] }) => payload.issues.length === 0 };

export const cloudAiChartSchema = () =>
  chartKinds(chartLimits).superRefine((chart, context) => {
    const total = cloudAiChartMarks(chart);
    const issue =
      total > CLOUD_AI_VIEW_MAX_MARKS
        ? `The chart has ${total} marks; the limit is ${CLOUD_AI_VIEW_MAX_MARKS}. Aggregate or split into several views.`
        : chartDataIssue(chart);
    if (issue) context.addIssue({ code: "custom", message: issue });
  }, whenValid);
/** Apps retain the renderer's permissive data contract, except values that would stall tick generation. */
export const cloudAiAppChartSchema = chartSchema;
const ChartSchema = /* @__PURE__ */ cloudAiChartSchema();

/**
 * Reads one chart without drawing it; undefined when it is not a chart. Writers have drawn it once already, so
 * renderers draw only for display.
 */
export const parseCloudAiChartInput = (value: unknown): CloudAiChartInput | undefined => {
  const parsed = ChartSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export const cloudAiGroupSchema = () => {
  const { ChartCommon } = chartParts(chartLimits);
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
  const {
    ChartAxis,
    ChartBins,
    ChartCommon,
    ChartLabel,
    ChartPoints,
    ChartSeries,
    ChartReferences,
    ChartThresholds,
    ChartUnit,
    ChartTooltip,
  } = chartParts(chartLimits);
  return z.object({
    kind: cloudAiChartKindSchema().optional().describe("Single charts: kind. Omit for groups."),
    ...ChartCommon,
    tooltip: ChartTooltip.optional(),
    groups: z.array(ChartLabel).max(CLOUD_AI_CHART_MAX_SERIES).optional().describe("treemap: group names."),
    labels: z.array(ChartLabel).length(2).optional().describe("pareto: current and previous period labels."),

    nodes: z
      .array(
        z.object({
          id: z.string().min(1),
          label: ChartLabel,
          tone: z.enum(["in", "out", "muted", "blue", "green", "amber", "red", "violet", "tax"]).optional(),
        }),
      )
      .max(CLOUD_AI_CHART_MAX_VALUES)
      .optional()
      .describe("sankey: unique nodes; labels name each stage."),
    links: z
      .array(z.object({ source: z.string(), target: z.string(), value: z.number().positive() }))
      .max(CLOUD_AI_VIEW_MAX_MARKS)
      .optional()
      .describe("sankey: positive flows between existing node ids, without cycles."),
    layout: z
      .enum(["columns", "rows", "grouped", "stacked", "calendar"])
      .optional()
      .describe("bar: columns, rows, grouped or stacked. area: stacked. heatmap: calendar."),
    scale: z.enum(["sequential", "diverging"]).optional().describe("Calendar heatmap color scale; domain includes all days."),
    locale: chartLocaleSchema().optional(),
    // One item object preserves every kind's fields before canonical validation; unions would strip overlapping items.
    data: z
      .union([
        z
          .array(
            z.object({
              label: ChartLabel.optional(),
              value: z.number().nullable().optional(),
              group: ChartLabel.optional(),
              prev: z.number().optional(),
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
        z
          .array(z.array(z.union([z.string(), z.number(), z.null()])).length(2))
          .min(1)
          .max(CLOUD_AI_VIEW_MAX_MARKS),
      ])
      .optional()
      .describe(
        "bar, pie, donut, barGauge: label/value (barGauge: min/max). boxplot: label/values. heatmap: x/y/value, or calendar [YYYY-MM-DD,number] pairs. histogram, sparkline: numbers.",
      ),
    start: z.object({ label: ChartLabel, value: z.number() }).optional().describe("waterfall: opening balance."),
    steps: z
      .array(z.object({ label: ChartLabel, value: z.number() }))
      .max(CLOUD_AI_VIEW_MAX_MARKS - 2)
      .optional()
      .describe("waterfall: positive inflows and negative outflows."),
    end: z.strictObject({ label: ChartLabel }).optional().describe("waterfall: closing label; balance is calculated."),
    x: z
      .array(z.union([ChartLabel, z.number()]))
      .max(CLOUD_AI_CHART_MAX_VALUES)
      .optional()
      .describe("bar, area: aligned category labels or numeric X values."),
    compare: z.object({ label: ChartLabel, data: z.array(z.number().nullable()).max(CLOUD_AI_CHART_MAX_VALUES) }).optional(),
    share: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
    tone: z.enum(["in", "out"]).optional(),
    normalize: z.boolean().optional().describe("stacked bar, area: normalize positive totals to 100 percent."),
    rows: z
      .array(
        z.object({
          group: ChartLabel.optional(),
          label: ChartLabel,
          values: z.array(z.number().nonnegative().nullable()).max(CLOUD_AI_CHART_MAX_SERIES),
        }),
      )
      .max(CLOUD_AI_CHART_MAX_VALUES)
      .optional()
      .describe("hbar: grouped rows of aligned segment values."),
    series: z
      .array(
        z.union([
          ChartLabel,
          ChartSeries(ChartPoints.min(1)).extend({ style: z.enum(["solid", "dashed", "dotted"]).optional() }),
          z.object({ label: ChartLabel, data: z.array(z.number().nullable()).max(CLOUD_AI_CHART_MAX_VALUES) }),
        ]),
      )
      .min(1)
      .max(CLOUD_AI_CHART_MAX_SERIES)
      .optional()
      .describe(
        "area: nonnegative aligned label/data matching x; bar: aligned label/data counts; hbar: series names. line, scatter: label/data points, optional reference role; line: style. Line needs 2 points per series.",
      ),
    xAxis: ChartAxis.extend({ ordered: z.boolean().optional() })
      .optional()
      .describe("line, scatter: x axis. bar: label titles categories; ordered keeps their sequence."),
    yAxis: ChartAxis.optional().describe("bar, line, scatter, boxplot: y axis; label names the value, format sets units."),
    legend: z
      .union([
        z.boolean(),
        z
          .array(z.object({ tone: z.enum(["in", "out", "muted", "blue", "green", "amber", "red", "violet", "tax"]), label: ChartLabel }))
          .max(CLOUD_AI_CHART_MAX_SERIES),
      ])
      .optional()
      .describe("sankey: explicit {tone,label}[] color meanings. Other kinds: boolean legend."),
    colorByBar: z.boolean().optional().describe("bar: one palette color per bar."),
    showValues: z.boolean().optional().describe("bar: print values, by default when they stay readable. heatmap: print values."),
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
      .describe("area, waterfall, gauge, barGauge, stat, heatmap, pie, donut: number format; percent values are fractions."),
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
      layout: z
        .enum(["stack", "grid", "columns", "rows", "grouped", "stacked", "calendar"])
        .optional()
        .describe(
          "Groups: stack/grid. Bar: columns, rows, grouped or stacked. Area: stacked. heatmap: calendar uses ISO date/value pairs.",
        ),
    })
    .superRefine((value, context) => {
      if ((value.kind !== undefined) === (value.charts !== undefined)) {
        context.addIssue({ code: "custom", message: "Set exactly one of kind or charts." });
        return;
      }
      if (value.charts !== undefined) {
        value.charts.forEach((chart, index) => {
          if ((chart.layout === "calendar" && chart.kind !== "heatmap") || (chart.locale !== undefined && !chartAcceptsLocale(chart)))
            context.addIssue({
              code: "custom",
              message: "Unsupported calendar layout or locale.",
              path: ["charts", index],
            });
        });
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
        if (
          value.linkX !== undefined ||
          (value.layout !== undefined && value.kind !== "bar" && value.kind !== "area" && value.layout !== "calendar")
        )
          context.addIssue({ code: "custom", message: "linkX belongs to groups; layouts belong to bar, area or calendar heatmap charts." });
        if (value.locale !== undefined && !chartAcceptsLocale(value))
          context.addIssue({ code: "custom", message: "Unsupported chart locale." });
        if (value.layout === "calendar" && value.kind !== "heatmap")
          context.addIssue({ code: "custom", message: "calendar layout belongs to heatmaps." });
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
export const CloudAiChartOutputSchema = /* @__PURE__ */ (() => z.object({ displayed: z.boolean() }))();

const SurveyQuestionSchema = /* @__PURE__ */ (() =>
  z.discriminatedUnion("type", [
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
  ]))();

export const CloudAiSurveyInputSchema = /* @__PURE__ */ (() =>
  z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    submitLabel: z.string().default("Submit"),
    questions: z.array(SurveyQuestionSchema).min(1).max(8),
  }))();
export const CloudAiSurveyOutputSchema = /* @__PURE__ */ (() =>
  z.object({
    submitted: z.boolean(),
    answers: z.record(z.string(), z.unknown()).default({}),
  }))();

export const CLOUD_AI_TEXT_EDITOR_MAX_CHARS = 20_000;
export const CLOUD_AI_TEXT_EDITOR_FEEDBACK_MAX_CHARS = 2_000;

export const CloudAiTextEditorInputSchema = /* @__PURE__ */ (() =>
  z.object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1_000).optional(),
    content: z.string().max(CLOUD_AI_TEXT_EDITOR_MAX_CHARS),
    format: z.enum(["plain", "markdown"]).default("plain"),
    submitLabel: z.string().trim().min(1).max(40).default("Continue"),
  }))();

export const CloudAiTextEditorOutputSchema = /* @__PURE__ */ (() =>
  z.discriminatedUnion("submitted", [
    z.object({
      submitted: z.literal(true),
      content: z.string().max(CLOUD_AI_TEXT_EDITOR_MAX_CHARS),
      format: z.enum(["plain", "markdown"]),
    }),
    z.object({
      submitted: z.literal(false),
      feedback: z.string().trim().min(1).max(CLOUD_AI_TEXT_EDITOR_FEEDBACK_MAX_CHARS),
    }),
  ]))();

export const CloudAiLocalBashInputSchema = /* @__PURE__ */ (() =>
  z.object({
    command: z.string().trim().min(1).max(20_000),
  }))();

export const CloudAiLocalBashOutputSchema = /* @__PURE__ */ (() =>
  z.object({
    status: z.enum(["completed", "denied", "failed", "timed_out"]),
    exitCode: z.number().int().nullable(),
    stdout: z.string().max(512 * 1024),
    stderr: z.string().max(512 * 1024),
    truncated: z.boolean(),
    /** Local file with the complete output when the client returned only its beginning and end. */
    outputPath: z.string().max(4096).optional(),
  }))();

export type CloudAiCardInput = z.infer<typeof CloudAiCardInputSchema>;
export type CloudAiCardOutput = z.infer<typeof CloudAiCardOutputSchema>;
export type CloudAiChartOutput = z.infer<typeof CloudAiChartOutputSchema>;
export type CloudAiSurveyInput = z.infer<typeof CloudAiSurveyInputSchema>;
export type CloudAiSurveyOutput = z.infer<typeof CloudAiSurveyOutputSchema>;
export type CloudAiTextEditorInput = z.infer<typeof CloudAiTextEditorInputSchema>;
export type CloudAiTextEditorOutput = z.infer<typeof CloudAiTextEditorOutputSchema>;
export type CloudAiLocalBashInput = z.infer<typeof CloudAiLocalBashInputSchema>;
export type CloudAiLocalBashOutput = z.infer<typeof CloudAiLocalBashOutputSchema>;
