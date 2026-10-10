import { z } from "zod";
import { chartInputIssue } from "./chart-block";

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

const ChartTitle = z.string().trim().min(1).max(160);
const ChartLabel = z.string().trim().min(1).max(80);
const ChartDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/)
  .refine((value) => Number.isFinite(Date.parse(`${value.length === 10 ? `${value}T00:00` : value}Z`)), "Not a valid date.");
const ChartAxis = z.object({
  label: ChartLabel.optional(),
  domain: z.tuple([z.number(), z.number()]).optional().describe("Exact [min, max]; must contain every value."),
  ticks: z.number().int().min(2).max(12).optional(),
  scale: z.enum(["linear", "log"]).optional().describe("log needs values above zero."),
});
const ChartCategory = z.object({ label: ChartLabel, value: z.number() });
const ChartSlice = z.object({ label: ChartLabel, value: z.number().min(0) });
const ChartSeries = z.object({
  label: ChartLabel.optional(),
  data: z
    .array(
      z.object({
        x: z
          .union([z.number(), ChartDate])
          .describe("A number, a date YYYY-MM-DD, or a date and time YYYY-MM-DDTHH:mm in the user's time zone without an offset."),
        y: z.number(),
      }),
    )
    .min(1)
    .max(CLOUD_AI_CHART_MAX_VALUES),
});
const ChartCommon = {
  title: ChartTitle,
  subtitle: z.string().trim().min(1).max(300).optional().describe("Unit, period or source, shown under the title."),
};

const ChartKinds = z.discriminatedUnion("kind", [
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
    series: z.array(ChartSeries).min(1).max(CLOUD_AI_CHART_MAX_SERIES),
    xAxis: ChartAxis.optional(),
    yAxis: ChartAxis.optional(),
    legend: z.boolean().optional().describe("Defaults to true for several series."),
    area: z.boolean().optional(),
    smooth: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("scatter"),
    ...ChartCommon,
    series: z.array(ChartSeries).min(1).max(CLOUD_AI_CHART_MAX_SERIES),
    xAxis: ChartAxis.optional(),
    yAxis: ChartAxis.optional(),
    legend: z.boolean().optional().describe("Defaults to true for several series."),
  }),
  z.object({
    kind: z.enum(["pie", "donut"]),
    ...ChartCommon,
    data: z.array(ChartSlice).min(1).max(CLOUD_AI_CHART_MAX_VALUES),
    legend: z.boolean().optional().describe("Defaults to true unless showLabels is set."),
    showLabels: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("histogram"),
    ...ChartCommon,
    data: z.array(z.number()).min(1).max(CLOUD_AI_CHART_MAX_VALUES).describe("Raw observations; the chart counts them into bins."),
    bins: z
      .union([
        z.number().int().min(1).max(CLOUD_AI_CHART_MAX_VALUES),
        z
          .array(z.number())
          .min(2)
          .max(CLOUD_AI_CHART_MAX_VALUES + 1),
      ])
      .optional()
      .describe("A bin count or ascending bin edges."),
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

/**
 * The `cloud.chart()` options of Studio code as plain data, without `width`, `height` and `format` functions. Valid input
 * also renders: values outside a domain, a log axis with values at or below zero, or pie slices that add up to zero fail
 * here instead of in the chat.
 */
export const CloudAiChartInputSchema = ChartKinds.superRefine((chart, context) => {
  const issue = chartInputIssue(chart);
  if (issue) context.addIssue({ code: "custom", message: issue });
});
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
export type CloudAiChartInput = z.infer<typeof CloudAiChartInputSchema>;
export type CloudAiChartOutput = z.infer<typeof CloudAiChartOutputSchema>;
export type CloudAiSurveyInput = z.infer<typeof CloudAiSurveyInputSchema>;
export type CloudAiSurveyOutput = z.infer<typeof CloudAiSurveyOutputSchema>;
export type CloudAiTextEditorInput = z.infer<typeof CloudAiTextEditorInputSchema>;
export type CloudAiTextEditorOutput = z.infer<typeof CloudAiTextEditorOutputSchema>;
export type CloudAiLocalBashInput = z.infer<typeof CloudAiLocalBashInputSchema>;
export type CloudAiLocalBashOutput = z.infer<typeof CloudAiLocalBashOutputSchema>;
