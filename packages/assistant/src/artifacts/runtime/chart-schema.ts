import { z } from "zod";
import { LIMITS } from "../contracts";
const num = z.number().finite();
const text = z.string().max(LIMITS.text);
const flag = z.boolean().optional();
const values = <T extends z.ZodType>(schema: T) => z.array(schema).max(LIMITS.rows);
const axis = z
  .object({ ticks: num.min(1).max(100).optional(), label: text.optional(), scale: z.enum(["linear", "log"]).optional(), minorTicks: flag, domain: z.tuple([num, num]).refine(([min, max]) => min < max, "Axis domain must increase").optional() })
  .strict();
const point = z
  .object({
    x: num,
    y: num,
    size: num.optional(),
    errY: num.optional(),
    errYHigh: num.optional(),
    errYLow: num.optional(),
    errX: num.optional(),
    errXHigh: num.optional(),
    errXLow: num.optional(),
  })
  .strict();
const series = values(
  z
    .object({
      label: text.optional(),
      data: values(point),
      marker: z.enum(["circle", "square", "triangle", "diamond", "plus", "cross"]).optional(),
      lineStyle: z.enum(["solid", "dashed", "dotted", "dashdot"]).optional(),
    })
    .strict(),
);
const data = values(z.object({ label: text, value: num }).strict());
const references = values(z.object({ value: num, axis: z.enum(["x", "y"]).optional(), label: text.optional() }).strict()).optional();
// Color values are data, never arbitrary SVG/CSS resources.
const color = z.string().regex(/^(#[\da-fA-F]{3,8}|[a-zA-Z]+)$/);
const thresholds = values(z.object({ value: num, label: text.optional(), color: color.optional() }).strict()).optional();
const base = {
  title: text.optional(),
  subtitle: text.optional(),
  padding: z
    .union([
      num.nonnegative().max(200),
      z
        .object({
          top: num.nonnegative().max(200).optional(),
          right: num.nonnegative().max(200).optional(),
          bottom: num.nonnegative().max(200).optional(),
          left: num.nonnegative().max(200).optional(),
        })
        .strict(),
    ])
    .optional(),
};
const axes = { xAxis: axis.optional(), yAxis: axis.optional(), references };
export const ChartOptions = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...base,
        ...axes,
        kind: z.literal("line"),
        series,
        legend: flag,
        smooth: flag,
        area: flag,
        step: z.enum(["before", "after", "middle"]).optional(),
        autoVariant: flag,
        errorBand: flag,
        interactive: flag,
      })
      .strict(),
    z
      .object({
        ...base,
        ...axes,
        kind: z.literal("scatter"),
        series,
        legend: flag,
        autoVariant: flag,
        trendline: flag,
        sizeRange: z.tuple([num.positive(), num.positive()]).optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("bar"),
        data,
        yAxis: axis.optional(),
        references,
        legend: flag,
        colorByBar: flag,
        showValues: flag,
      })
      .strict(),
    z.object({ ...base, kind: z.literal("pie"), data, showLabels: flag, innerRadius: num.min(0).max(0.95).optional() }).strict(),
    z.object({ ...base, kind: z.literal("donut"), data, showLabels: flag, innerRadius: num.min(0).max(0.95).optional() }).strict(),
    z
      .object({
        kind: z.literal("sparkline"),
        data: z.union([values(num), values(point)]),
        smooth: flag,
        area: flag,
        showLast: flag,
        showMinMax: flag,
      })
      .strict(),
    z
      .object({
        ...base,
        ...axes,
        kind: z.literal("histogram"),
        data: values(num),
        bins: z.union([num.int().min(1).max(LIMITS.rows), values(num)]).optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("boxplot"),
        groups: values(z.object({ label: text, values: values(num) }).strict()),
        yAxis: axis.optional(),
        showOutliers: flag,
        references,
        colorByBox: flag,
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("gauge"),
        value: num,
        min: num.optional(),
        max: num.optional(),
        label: text.optional(),
        unit: text.optional(),
        thresholds,
        showNeedle: flag,
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("barGauge"),
        data: values(z.object({ label: text, value: num, min: num.optional(), max: num.optional(), unit: text.optional() }).strict()),
        min: num.optional(),
        max: num.optional(),
        unit: text.optional(),
        thresholds,
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("stat"),
        label: text,
        value: z.union([num, text]),
        unit: text.optional(),
        delta: z.union([num, text]).optional(),
        trend: z.enum(["up", "down", "neutral"]).optional(),
        sparkline: z.union([values(num), values(point)]).optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("heatmap"),
        data: values(z.object({ x: text, y: text, value: num }).strict()),
        xLabels: values(text).optional(),
        yLabels: values(text).optional(),
        min: num.optional(),
        max: num.optional(),
        showValues: flag,
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("map"),
        series: values(
          z
            .object({
              label: text.optional(),
              data: values(
                z
                  .object({
                    latitude: num.min(-90).max(90),
                    longitude: num.min(-180).max(180),
                    label: text.optional(),
                    size: num.optional(),
                  })
                  .strict(),
              ),
            })
            .strict(),
        ),
        viewport: z
          .object({ latitude: num, longitude: num, zoom: num.min(0).max(5) })
          .strict()
          .optional(),
        sizeRange: z.tuple([num.positive(), num.positive()]).optional(),
        legend: flag,
        interactive: flag,
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("stateTimeline"),
        rows: values(
          z
            .object({ label: text, intervals: values(z.object({ from: num, to: num, state: text, label: text.optional() }).strict()) })
            .strict(),
        ),
        states: values(z.object({ state: text, label: text.optional(), color: color.optional() }).strict()).optional(),
        xAxis: z.object({ label: text.optional() }).strict().optional(),
        legend: flag,
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    let count = 0;
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        count += v.length;
        v.forEach(walk);
      } else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(value);
    if (count > LIMITS.rows) ctx.addIssue({ code: "custom", message: `Charts support at most ${LIMITS.rows} data entries in total` });
  });
