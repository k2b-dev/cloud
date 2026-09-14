import { z } from "zod";
import { LIMITS } from "../contracts";
import { ChartOptions } from "./chart-schema";

const text = z.string().max(LIMITS.text);
const key = z.string().min(1).max(180);
export const Scalar = z.union([text, z.number().finite(), z.boolean(), z.null()]);
export const Row = z.record(z.string().max(120), Scalar);
export type Row = z.infer<typeof Row>;
export const Format = z.discriminatedUnion("type", [
  z.object({ type: z.literal("number"), maximumFractionDigits: z.number().int().min(0).max(20).optional() }).strict(),
  z
    .object({
      type: z.literal("currency"),
      currency: z.string().regex(/^[A-Z]{3}$/),
      maximumFractionDigits: z.number().int().min(0).max(20).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("percent"),
      input: z.enum(["fraction", "percent"]),
      maximumFractionDigits: z.number().int().min(0).max(20).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("date"),
      timeZone: key.refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Invalid time zone"),
      style: z.enum(["short", "medium", "long"]).default("medium"),
    })
    .strict(),
]);
export type Format = z.infer<typeof Format>;
export const Column = z
  .object({
    key,
    label: text,
    format: Format.optional(),
    sortable: z.boolean().default(false),
    align: z.enum(["left", "center", "right"]).optional(),
  })
  .strict();
export const SourceContext = z
  .object({
    mode: z.enum(["snapshot", "live"]),
    asOf: z.iso.datetime(),
    sources: z
      .array(
        z
          .object({
            label: key,
            href: z
              .string()
              .url()
              .refine((value) => {
                const url = new URL(value);
                return url.protocol === "https:" && !url.username && !url.password;
              })
              .optional(),
            description: text.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    status: z.enum(["complete", "partial", "fixture"]).default("complete"),
    note: text.optional(),
  })
  .strict()
  .refine((value) => value.status === "complete" || Boolean(value.note?.trim()), "Partial and fixture data require an explanation");
export const Mark = z
  .object({
    role: z.enum(["point", "item", "bin", "box", "outlier", "value", "cell", "interval"]),
    index: z.number().int().nonnegative(),
    seriesIndex: z.number().int().nonnegative().optional(),
    key,
    rowKey: key,
    reference: z.boolean().optional(),
    tooltip: z
      .object({ title: text.optional(), rows: z.array(z.object({ label: text, value: text }).strict()).max(64) })
      .strict()
      .optional(),
  })
  .strict();
export const ChartPresentation = z
  .object({
    options: ChartOptions,
    marks: z.array(Mark).max(LIMITS.rows).optional(),
    formats: z.record(z.string().max(120), Format).optional(),
  })
  .strict();
export const ExplorerData = z
  .object({
    rows: z.array(Row).max(LIMITS.rows),
    rowKey: key,
    chart: z.union([
      z.object({ kind: z.enum(["bar", "pie", "donut"]), category: key, value: key }).strict(),
      z.object({ kind: z.enum(["line", "scatter"]), x: key, y: key, series: key.optional() }).strict(),
      ChartPresentation,
    ]),
    context: SourceContext.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const chart = data.chart;
    if ("kind" in chart) {
      const numericFields = "value" in chart ? [chart.value] : chart.kind === "scatter" ? [chart.x, chart.y] : [chart.y];
      for (const field of numericFields) {
        if (data.rows.some(row => typeof row[field] !== "number" || !Number.isFinite(row[field])))
          ctx.addIssue({code:"custom",message:`Chart field ${field} requires finite numbers`});
      }
      if ("category" in chart && data.rows.some(row => row[chart.category] === null || row[chart.category] === undefined))
        ctx.addIssue({code:"custom",message:`Missing chart field ${chart.category}`});
      if (chart.kind === "pie" || chart.kind === "donut") {
        if (data.rows.some(row => { const value = row[chart.value]; return typeof value === "number" && value <= 0; }))
          ctx.addIssue({code:"custom",message:"Pie and donut values must be positive; filter explicitly before rendering"});
      }
      if (chart.kind === "line") {
        const values = data.rows.map(row => row[chart.x]);
        if (!values.every(value => typeof value === "string" && value.length > 0) && !values.every(value => typeof value === "number" && Number.isFinite(value)))
          ctx.addIssue({code:"custom",message:`Line field ${chart.x} requires either finite numbers or nonempty category labels, without mixing types`});
      }
      if ("series" in chart && chart.series && data.rows.some(row => row[chart.series!] === null || row[chart.series!] === undefined))
        ctx.addIssue({code:"custom",message:`Missing series field ${chart.series}`});
    }
    const keys = data.rows.map((row) => row[data.rowKey]);
    if (keys.some((value) => typeof value !== "string" || !value) || new Set(keys).size !== keys.length)
      ctx.addIssue({ code: "custom", message: "Rows require unique nonempty string keys" });
    if ("options" in data.chart && !data.chart.marks)
      ctx.addIssue({
        code: "custom",
        message: "Prepared explorer charts require explicit mark-to-row mappings, including derived bins and groups",
      });
    if ("options" in data.chart && data.chart.marks?.some((mark) => !keys.includes(mark.rowKey)))
      ctx.addIssue({ code: "custom", message: "Every mark must reference a current row" });
  });
export type ExplorerData = z.infer<typeof ExplorerData>;
export const ExplorerRequest = z
  .object({ step: key.optional(), visibleKeys: z.array(key).max(200).optional(), referenceStep: key.optional() })
  .strict()
  .refine(
    (value) =>
      (!value.referenceStep || Boolean(value.step)) && (!value.visibleKeys || new Set(value.visibleKeys).size === value.visibleKeys.length),
    "Invalid explorer filters",
  );
export const ExplorerSnapshot = z.object({ request: ExplorerRequest, charts: z.record(key, ExplorerData) }).strict();
export type ExplorerSnapshot = z.infer<typeof ExplorerSnapshot>;
const common = {
  id: z.string().min(1).max(80),
  label: text.default(""),
  description: text.default(""),
  disabled: z.boolean().default(false),
  loading: z.boolean().default(false),
};
const option = z.object({ value: key, label: text }).strict();
const bounds = { min: z.number().finite().optional(), max: z.number().finite().optional(), step: z.number().positive().optional() };
export const DateRange = z
  .object({ start: z.iso.date().nullable(), end: z.iso.date().nullable() })
  .strict()
  .refine((value) => !value.start || !value.end || value.start <= value.end, "Date range is reversed");
export const AnalyticsNode = z
  .discriminatedUnion("type", [
    z.object({ ...common, type: z.literal("text"), value: text, markdown: z.boolean().default(false) }).strict(),
    z.object({ ...common, type: z.literal("stat"), label: text.min(1), value: z.number().finite().nullable().default(null), format: Format.optional(), trend: z.array(z.number().finite()).max(1000).optional() }).strict(),
    z
      .object({
        ...common,
        type: z.literal("button"),
        variant: z.enum(["primary", "secondary", "ghost", "text", "danger"]).default("secondary"),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal("filePicker"),
        accept: text.optional(),
        multiple: z.boolean().default(false),
        names: text.default(""),
      })
      .strict(),
    z.object({ ...common, type: z.literal("input"), value: text, placeholder: text.optional() }).strict(),
    z.object({ ...common, type: z.literal("select"), value: text, options: z.array(option).max(200) }).strict(),
    z.object({ ...common, type: z.literal("multiSelect"), value: z.array(key).max(200), options: z.array(option).max(200) }).strict(),
    z.object({ ...common, type: z.literal("number"), value: z.number().finite().nullable(), ...bounds }).strict(),
    z
      .object({
        ...common,
        type: z.literal("slider"),
        value: z.number().finite(),
        min: z.number().finite(),
        max: z.number().finite(),
        step: z.number().positive().default(1),
      })
      .strict(),
    z.object({ ...common, type: z.literal("dateRange"), value: DateRange }).strict(),
    z
      .object({
        ...common,
        type: z.literal("chart"),
        data: ChartPresentation,
        selectedKey: key.nullable().default(null),
        cursor: key.optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal("explorer"),
        data: ExplorerData,
        columns: z.array(Column).min(1).max(64),
        selectedKey: key.nullable().default(null),
        view: z.enum(["chart", "table"]).default("chart"),
        group: key.optional(),
        cursor: key.optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal("table"),
        rows: z.array(Row).max(LIMITS.rows),
        columns: z.array(Column).min(1).max(64),
        rowKey: key,
        selectedKey: key.nullable().default(null),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal("group"),
        comparison: z.boolean().default(false),
        snapshot: ExplorerSnapshot,
        desired: ExplorerRequest,
        selectedKey: key.nullable().default(null),
        error: text.optional(),
        steps: z
          .array(z.object({ key, label: text }).strict())
          .max(200)
          .optional(),
        series: z
          .array(z.object({ key, label: text }).strict())
          .max(200)
          .optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal("layout"),
        layout: z.enum(["row", "column", "grid", "section"]),
        children: z.array(key).max(LIMITS.nodes),
        minWidth: z.number().min(160).max(1200).default(320),
      })
      .strict(),
  ])
  .superRefine((node, ctx) => {
    if (node.type === "group" && !node.comparison && (node.snapshot.request.referenceStep || node.desired.referenceStep))
      ctx.addIssue({ code: "custom", message: "Comparisons are not enabled" });
    if ("options" in node && new Set(node.options.map((option) => option.value)).size !== node.options.length)
      ctx.addIssue({ code: "custom", message: "Option values must be unique" });
    if ("columns" in node && new Set(node.columns.map((column) => column.key)).size !== node.columns.length)
      ctx.addIssue({ code: "custom", message: "Column keys must be unique" });
    if (node.type === "table") {
      const keys = node.rows.map((row) => row[node.rowKey]);
      if (keys.some((value) => typeof value !== "string" || !value) || new Set(keys).size !== keys.length)
        ctx.addIssue({ code: "custom", message: "Rows require unique string keys" });
    }
    if (node.type === "select" && !node.options.some((option) => option.value === node.value))
      ctx.addIssue({ code: "custom", message: "Unknown select value" });
    if (
      node.type === "multiSelect" &&
      (new Set(node.value).size !== node.value.length || node.value.some((value) => !node.options.some((option) => option.value === value)))
    )
      ctx.addIssue({ code: "custom", message: "Unknown or duplicate selection" });
    if (
      (node.type === "number" || node.type === "slider") &&
      ((node.min !== undefined && node.max !== undefined && node.min > node.max) ||
        (node.value !== null && ((node.min !== undefined && node.value < node.min) || (node.max !== undefined && node.value > node.max))))
    )
      ctx.addIssue({ code: "custom", message: "Value is outside the configured range" });
  });
export type AnalyticsNode = z.infer<typeof AnalyticsNode>;
export const AnalyticsEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("change"), value: z.union([Scalar, z.array(key), DateRange]) }).strict(),
  z.object({ type: z.literal("select"), key: key.nullable() }).strict(),
  z.object({ type: z.literal("view"), value: z.enum(["chart", "table"]) }).strict(),
  z.object({ type: z.literal("request"), request: ExplorerRequest }).strict(),
  z.object({ type: z.literal("refresh") }).strict(),
  z.object({ type: z.literal("renderError"), message: text }).strict(),
]);
export type AnalyticsEvent = z.infer<typeof AnalyticsEvent>;

export function formatValue(value: z.infer<typeof Scalar> | undefined, format: Format | undefined, locale: string): string {
  if (value === null || value === undefined) return "—";
  if (!format) return String(value);
  if (format.type === "date") {
    if (typeof value !== "number" || !Number.isFinite(new Date(value).getTime())) throw new Error("Dates require epoch milliseconds");
    return new Intl.DateTimeFormat(locale, { timeZone: format.timeZone, dateStyle: format.style }).format(value);
  }
  if (typeof value !== "number") throw new Error("Numeric formats require numeric values");
  const digits = { maximumFractionDigits: format.maximumFractionDigits };
  if (format.type === "currency")
    return new Intl.NumberFormat(locale, { ...digits, style: "currency", currency: format.currency }).format(value);
  if (format.type === "percent")
    return new Intl.NumberFormat(locale, { ...digits, style: "percent" }).format(format.input === "percent" ? value / 100 : value);
  return new Intl.NumberFormat(locale, digits).format(value);
}
