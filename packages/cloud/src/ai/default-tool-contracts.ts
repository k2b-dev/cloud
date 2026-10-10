import { z } from "zod";
import { chartDataIssue, chartDateTime, chartDrawingIssue } from "./chart-block";

const ToneSchema = z.enum(["neutral", "blue", "teal", "green", "amber", "red"]);

export const CloudAiCardInputSchema = z.object({
  title: z.string().min(1),
  value: z.string().min(1),
  emoji: z.string().max(8).optional().describe("Optional single emoji shown next to the card content. Omit when none fits."),
  caption: z.string().optional(),
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

// Every chart schema is built by a function whose call is marked pure. Bundles that only use other exports of this
// module, such as every Studio app frame through `@k2b/cloud/ai/browser`, can then leave the chart contract out.
const chartParts = () => {
  const ChartLabel = z.string().trim().min(1).max(80);
  const ChartDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/)
    .refine((value) => chartDateTime(value) !== undefined, "Not a valid date.");
  const ChartPoint = z.object({
    x: z
      .union([z.number(), ChartDate])
      .describe(
        "A number, a date YYYY-MM-DD, or a date and time YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss in the user's time zone without an offset.",
      ),
    y: z.number(),
  });
  return {
    ChartLabel,
    ChartAxis: z.object({
      label: ChartLabel.optional(),
      domain: z.array(z.number()).length(2).optional().describe("Exact [min, max]; must contain every value."),
      ticks: z.number().int().min(2).max(12).optional(),
      scale: z.enum(["linear", "log"]).optional().describe("log needs values above zero."),
    }),
    ChartCategory: z.object({ label: ChartLabel, value: z.number() }),
    ChartSlice: z.object({ label: ChartLabel, value: z.number().min(0) }),
    ChartSeries: (points: z.ZodArray<typeof ChartPoint>) => z.object({ label: ChartLabel.optional(), data: points }),
    ChartPoints: z.array(ChartPoint).max(CLOUD_AI_CHART_MAX_VALUES),
    ChartBins: z
      .union([
        z.number().int().min(1).max(CLOUD_AI_CHART_MAX_VALUES),
        z
          .array(z.number())
          .min(2)
          .max(CLOUD_AI_CHART_MAX_VALUES + 1),
      ])
      .describe("A bin count or ascending bin edges."),
    ChartCommon: {
      title: z.string().trim().min(1).max(160),
      subtitle: z.string().trim().min(1).max(300).optional().describe("Unit, period or source, shown under the title."),
    },
  };
};

const chartKinds = () => {
  const { ChartAxis, ChartBins, ChartCategory, ChartCommon, ChartLabel, ChartPoints, ChartSeries, ChartSlice } = chartParts();
  return z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("bar"),
      ...ChartCommon,
      data: z.array(ChartCategory).min(1).max(CLOUD_AI_CHART_MAX_VALUES),
      yAxis: ChartAxis.optional(),
      colorByBar: z.boolean().optional(),
      showValues: z.boolean().optional(),
      legend: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("line"),
      ...ChartCommon,
      series: z
        .array(
          ChartSeries(ChartPoints.min(2, "A line needs at least two points per series; show single values as a bar or scatter chart.")),
        )
        .min(1)
        .max(CLOUD_AI_CHART_MAX_SERIES),
      xAxis: ChartAxis.optional(),
      yAxis: ChartAxis.optional(),
      legend: z.boolean().optional(),
      area: z.boolean().optional(),
      smooth: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("scatter"),
      ...ChartCommon,
      series: z
        .array(ChartSeries(ChartPoints.min(1)))
        .min(1)
        .max(CLOUD_AI_CHART_MAX_SERIES),
      xAxis: ChartAxis.optional(),
      yAxis: ChartAxis.optional(),
      legend: z.boolean().optional(),
    }),
    z.object({
      kind: z.enum(["pie", "donut"]),
      ...ChartCommon,
      data: z.array(ChartSlice).min(1).max(CLOUD_AI_CHART_MAX_VALUES),
      legend: z.boolean().optional(),
      showLabels: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("histogram"),
      ...ChartCommon,
      data: z.array(z.number()).min(1).max(CLOUD_AI_CHART_MAX_VALUES),
      bins: ChartBins.optional(),
    }),
    z.object({
      kind: z.literal("gauge"),
      ...ChartCommon,
      value: z.number(),
      min: z.number().optional(),
      max: z.number().optional(),
      label: ChartLabel.optional(),
      unit: z.string().trim().min(1).max(12).optional(),
    }),
    z.object({
      kind: z.literal("sparkline"),
      ...ChartCommon,
      data: z.array(z.number()).min(2).max(CLOUD_AI_CHART_MAX_VALUES),
      area: z.boolean().optional(),
    }),
  ]);
};

/** Checks run on complete input only, so out-of-range input fails on its bounds before anything is computed or drawn. */
const whenValid = { when: (payload: { issues: readonly unknown[] }) => payload.issues.length === 0 };

const chartSchema = () =>
  chartKinds().superRefine((chart, context) => {
    const issue = chartDataIssue(chart);
    if (issue) context.addIssue({ code: "custom", message: issue });
  }, whenValid);
const ChartSchema = /* @__PURE__ */ chartSchema();

/** One chart as the renderers read it: a `cloud.chart()` kind with its options. */
export type CloudAiChartInput = z.output<ReturnType<typeof chartKinds>>;

/**
 * Reads the arguments of a `chart` call without drawing them; undefined when they are not a chart. The tool schema
 * has drawn them once already, so renderers draw only for display.
 */
export const parseCloudAiChartInput = (value: unknown): CloudAiChartInput | undefined => {
  const parsed = ChartSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const chartInputSchema = () => {
  const { ChartAxis, ChartBins, ChartCategory, ChartCommon, ChartLabel, ChartPoints, ChartSeries } = chartParts();
  return z
    .object({
      kind: z.enum(["bar", "line", "scatter", "pie", "donut", "histogram", "gauge", "sparkline"]),
      ...ChartCommon,
      data: z
        .union([z.array(ChartCategory).min(1).max(CLOUD_AI_CHART_MAX_VALUES), z.array(z.number()).min(1).max(CLOUD_AI_CHART_MAX_VALUES)])
        .optional()
        .describe("bar, pie, donut: [{ label, value }]. histogram: raw observations to count into bins. sparkline: values in order."),
      series: z
        .array(ChartSeries(ChartPoints.min(1)))
        .min(1)
        .max(CLOUD_AI_CHART_MAX_SERIES)
        .optional()
        .describe("line and scatter: one entry per series. A line needs at least two points per series."),
      xAxis: ChartAxis.optional().describe("line and scatter."),
      yAxis: ChartAxis.optional().describe("bar, line and scatter."),
      legend: z
        .boolean()
        .optional()
        .describe(
          "bar (with colorByBar), line, scatter, pie, donut. Defaults to true for several series, and for pie and donut unless showLabels is set.",
        ),
      colorByBar: z.boolean().optional().describe("bar: one palette color per bar."),
      showValues: z.boolean().optional().describe("bar: print each value on its bar."),
      area: z.boolean().optional().describe("line and sparkline: fill the area under the line."),
      smooth: z.boolean().optional().describe("line."),
      showLabels: z.boolean().optional().describe("pie and donut: name each slice next to it instead of in a legend."),
      bins: ChartBins.optional().describe("histogram: a bin count or ascending bin edges."),
      value: z.number().optional().describe("gauge: the value to show."),
      min: z.number().optional().describe("gauge: start of the scale, default 0."),
      max: z.number().optional().describe("gauge: end of the scale, default 100."),
      label: ChartLabel.optional().describe("gauge: what the value measures."),
      unit: z.string().trim().min(1).max(12).optional().describe("gauge: unit after the value."),
    })
    .superRefine((value, context) => {
      const parsed = ChartSchema.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) context.addIssue({ code: "custom", message: issue.message, path: issue.path });
        return;
      }
      const issue = chartDrawingIssue(parsed.data);
      if (issue) context.addIssue({ code: "custom", message: issue });
    }, whenValid);
};

/**
 * The `cloud.chart()` options of Studio code as plain data, without `width`, `height` and `format` functions. Model
 * providers accept only an object at the root of a tool schema, so every kind shares one object and each field names
 * the kinds it belongs to; the kind's own rules are checked after that. Valid input also draws: values outside a
 * domain, values at or below zero on a log axis, or a pie too small for its legend fail here instead of in the chat.
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
