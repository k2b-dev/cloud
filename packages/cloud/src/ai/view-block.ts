import { computeDomain, extendDomainToNice, niceStep } from "@k2b/stdlib";
import { z } from "zod";
import { CloudResourceReferenceSchema } from "../contracts/capabilities";
import {
  type CloudAiChartRow,
  type CloudAiChartTable,
  chartDataIssue,
  chartDateTime,
  chartDrawingIssue,
  chartSteppingIssue,
  cloudAiNumberFormatters,
} from "./chart-block";
import {
  CLOUD_AI_CHART_MAX_SERIES,
  CLOUD_AI_CHART_MAX_VALUES,
  CLOUD_AI_GROUP_MAX_CHARTS,
  CLOUD_AI_VIEW_MAX_MARKS,
  type CloudAiChartInput,
  cloudAiChartKindSchema,
  cloudAiChartSchema,
  cloudAiGroupSchema,
  cloudAiNumberFormatSchema,
} from "./default-tool-contracts";

// Views have their own namespace so model write tools cannot replace computed results.
export const CLOUD_AI_VIEW_DIRECTORY = "/views";
// The suffix distinguishes declarative views from ordinary files in the folder.
export const CLOUD_AI_VIEW_SUFFIX = ".view.json";
// Readers load the whole file; even an eight-series chart needs only about 100 KB.
export const CLOUD_AI_VIEW_MAX_BYTES = 1024 * 1024;
// A table holds no more rows than the largest chart has marks.
export const CLOUD_AI_TABLE_MAX_ROWS = CLOUD_AI_CHART_MAX_SERIES * CLOUD_AI_CHART_MAX_VALUES;
// Capability table presentations use the same column bound.
export const CLOUD_AI_TABLE_MAX_COLUMNS = 100;

// StatGrid supports at most six columns.
export const CLOUD_AI_STATS_MAX_ITEMS = 6;
// A record shows this many fields before its viewport scrolls; its summary sizes only these.
export const CLOUD_AI_DETAILS_VIEWPORT_ITEMS = 12;
// Twelve rows hold about 22 lines; at the widest chat column a line holds about 110 characters, so a longer value fills
// the viewport at any width and its length counts no further.
export const CLOUD_AI_DETAILS_MAX_CHARS = 4096;

const referenceSchema = () => CloudResourceReferenceSchema.pick({ type: true, id: true, title: true, context: true, status: true });
const ReferenceSchema = /* @__PURE__ */ referenceSchema();
export type CloudAiViewReference = z.output<typeof ReferenceSchema>;
const cellTypeSchema = () => z.enum(["text", "number", "date", "datetime", "ref"]);
const cellSchema = () => z.union([z.string(), z.number(), z.null(), ReferenceSchema]);
const cellIssue = (
  type: z.output<ReturnType<typeof cellTypeSchema>>,
  cell: z.output<ReturnType<typeof cellSchema>>,
): string | undefined => {
  if (cell === null) return undefined;
  if (type === "number") return typeof cell === "number" ? undefined : "Expected a number or null.";
  // Text columns have always shown numbers as written, such as ids mixed with names.
  if (type === "text") return typeof cell !== "object" ? undefined : "Expected text, a number or null.";
  if (type === "ref") return typeof cell === "object" ? undefined : "Expected a Cloud reference or null.";
  const pattern = type === "date" ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
  if (typeof cell !== "string" || !pattern.test(cell) || chartDateTime(cell) === undefined)
    return type === "date" ? "Expected a valid YYYY-MM-DD date or null." : "Expected a valid wall-clock datetime or null.";
  return undefined;
};
const statsViewSchema = () =>
  z.strictObject({
    view: z.literal("stats"),
    title: z.string().trim().min(1).max(160),
    subtitle: z.string().trim().min(1).max(300).optional(),
    items: z
      .array(
        z
          .strictObject({
            label: z.string().trim().min(1).max(80),
            value: z.union([z.number(), z.string().trim().min(1).max(80)]),
            format: cloudAiNumberFormatSchema().optional(),
            sub: z.string().trim().min(1).max(80).optional(),
            delta: z.number().optional(),
            better: z.enum(["up", "down"]).optional(),
            sparkline: z.array(z.number()).min(2).max(CLOUD_AI_CHART_MAX_VALUES).optional(),
          })
          .superRefine((item, ctx) => {
            if (typeof item.value !== "number") {
              if (item.format !== undefined)
                ctx.addIssue({ code: "custom", path: ["format"], message: "Only number values may have a format." });
              if (item.delta !== undefined)
                ctx.addIssue({ code: "custom", path: ["delta"], message: "Only number values may have a delta." });
            }
            if (item.better !== undefined && item.delta === undefined)
              ctx.addIssue({ code: "custom", path: ["better"], message: "A better direction requires a delta." });
          }),
      )
      .min(1)
      .max(CLOUD_AI_STATS_MAX_ITEMS),
  });
const detailsViewSchema = () =>
  z.strictObject({
    view: z.literal("details"),
    title: z.string().trim().min(1).max(160),
    subtitle: z.string().trim().min(1).max(300).optional(),
    items: z
      .array(
        z
          .strictObject({
            label: z.string().trim().min(1).max(80),
            type: cellTypeSchema(),
            value: cellSchema(),
            format: cloudAiNumberFormatSchema().optional(),
          })
          .superRefine((item, ctx) => {
            const message = cellIssue(item.type, item.value);
            if (message) ctx.addIssue({ code: "custom", path: ["value"], message });
            if (item.format !== undefined && item.type !== "number")
              ctx.addIssue({ code: "custom", path: ["format"], message: "Only number fields may have a format." });
          }),
      )
      .min(1)
      .max(CLOUD_AI_TABLE_MAX_COLUMNS),
  });
const chartViewSchema = () => z.object({ view: z.literal("chart") }).and(cloudAiChartSchema());
const tableRowSchema = () => {
  const cell = cellSchema();
  // z.record drops __proto__; column ids must survive validation without changing the object's prototype.
  const row = z.unknown().transform((value, ctx) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
      ctx.addIssue({ code: "custom", message: "Expected a row object." });
      return z.NEVER;
    }
    const entries: [string, z.output<typeof cell>][] = [];
    for (const [id, input] of Object.entries(value)) {
      const parsed = cell.safeParse(input);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: [id, ...issue.path] });
      } else entries.push([id, parsed.data]);
    }
    return Object.fromEntries(entries);
  });
  return row;
};
const tableColumnsSchema = () => {
  return z
    .array(
      z.strictObject({
        id: z.string().trim().min(1).max(80),
        label: z.string().min(1).max(80).optional(),
        type: cellTypeSchema(),
        format: cloudAiNumberFormatSchema().optional(),
      }),
    )
    .min(1)
    .max(CLOUD_AI_TABLE_MAX_COLUMNS);
};
const tableViewSchema = () => {
  const row = tableRowSchema();
  return z
    .strictObject({
      view: z.literal("table"),
      title: z.string().trim().min(1).max(160),
      subtitle: z.string().trim().min(1).max(300).optional(),
      columns: tableColumnsSchema(),
      rows: z.array(row).max(CLOUD_AI_TABLE_MAX_ROWS),
      footer: row.optional(),
      sort: z.strictObject({ column: z.string(), direction: z.enum(["asc", "desc"]) }).optional(),
    })
    .superRefine((value, ctx) => {
      const columns = checkTableData(value, ctx);
      if (value.sort && !columns.has(value.sort.column))
        ctx.addIssue({ code: "custom", path: ["sort", "column"], message: "Unknown column id." });
    });
};
const checkTableData = (
  value: {
    columns: z.output<ReturnType<typeof tableColumnsSchema>>;
    rows: z.output<ReturnType<typeof tableRowSchema>>[];
    footer?: z.output<ReturnType<typeof tableRowSchema>>;
  },
  ctx: z.RefinementCtx,
) => {
  const columns = new Map(value.columns.map((column) => [column.id, column]));
  value.columns.forEach((column, index) => {
    if (value.columns.findIndex((entry) => entry.id === column.id) !== index)
      ctx.addIssue({ code: "custom", path: ["columns", index, "id"], message: "Column ids must be unique." });
    if (column.format && column.type !== "number")
      ctx.addIssue({ code: "custom", path: ["columns", index, "format"], message: "Only number columns may have a format." });
  });
  const checkRow = (cells: z.output<ReturnType<typeof tableRowSchema>>, path: (string | number)[]) => {
    for (const [id, cell] of Object.entries(cells)) {
      const column = columns.get(id);
      const message = column ? cellIssue(column.type, cell) : "Unknown column id.";
      if (message) ctx.addIssue({ code: "custom", path: [...path, id], message });
    }
  };
  value.rows.forEach((cells, index) => checkRow(cells, ["rows", index]));
  if (value.footer) checkRow(value.footer, ["footer"]);
  return columns;
};
const groupViewSchema = () => cloudAiGroupSchema().safeExtend({ view: z.literal("group") });
const GroupViewSchema = /* @__PURE__ */ groupViewSchema();
const ChartViewSchema = /* @__PURE__ */ chartViewSchema();
const TableViewSchema = /* @__PURE__ */ tableViewSchema();
const StatsViewSchema = /* @__PURE__ */ statsViewSchema();
const DetailsViewSchema = /* @__PURE__ */ detailsViewSchema();
export type CloudAiChartView = z.output<typeof ChartViewSchema>;
export type CloudAiTableView = z.output<typeof TableViewSchema>;
export type CloudAiGroupView = z.output<typeof GroupViewSchema>;
export type CloudAiStatsView = z.output<typeof StatsViewSchema>;
export type CloudAiDetailsView = z.output<typeof DetailsViewSchema>;
export type CloudAiView =
  | CloudAiChartView
  | CloudAiTableView
  | CloudAiGroupView
  | CloudAiStatsView
  | CloudAiDetailsView
  | CloudAiExplorerView;

const explorerViewSchema = () => {
  const common = { id: z.string().trim().min(1).max(40), label: z.string().trim().min(1).max(80), x: z.string() };
  const ys = z.union([z.string(), z.array(z.string()).min(1).max(CLOUD_AI_CHART_MAX_SERIES)]);
  const points = { ...common, y: ys, series: z.string().optional() };
  return z.strictObject({
    view: z.literal("explorer"),
    title: z.string().trim().min(1).max(160),
    subtitle: z.string().trim().min(1).max(300).optional(),
    columns: tableColumnsSchema(),
    rows: z.array(tableRowSchema()).max(CLOUD_AI_TABLE_MAX_ROWS),
    views: z
      .array(
        z.discriminatedUnion("kind", [
          z.strictObject({ ...common, kind: z.literal("bar"), y: z.string() }),
          z.strictObject({ ...points, kind: z.literal("line") }),
          z.strictObject({ ...points, kind: z.literal("scatter") }),
          z.strictObject({ ...common, kind: z.literal("heatmap"), y: z.string(), value: z.string() }),
        ]),
      )
      .min(1)
      .max(CLOUD_AI_GROUP_MAX_CHARTS),
    controls: z.strictObject({ filter: z.string().optional(), step: z.string().optional(), compare: z.boolean().optional() }).optional(),
  });
};
const ExplorerDataSchema = /* @__PURE__ */ explorerViewSchema();
export type CloudAiExplorerView = z.output<typeof ExplorerDataSchema>;
const ExplorerViewSchema = ExplorerDataSchema.superRefine((value, ctx) => {
  const columns = checkTableData(value, ctx);
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const reference = (id: string, path: (string | number)[], types?: readonly string[]) => {
    const column = columns.get(id);
    if (!column) issue(path, "Unknown column id; choose an id from columns.");
    // A reference opens an object; it has no value to plot, group or step by.
    else if (column.type === "ref") issue(path, "Reference columns show only in the table; choose a text, number or date column.");
    else if (types && !types.includes(column.type)) issue(path, `Choose a ${types.join(", ")} column.`);
  };
  const nonNull = (id: string, path: (string | number)[], max: number) => {
    reference(id, path);
    const cells = value.rows.map((row) => cloudAiViewScalarCellOf(row, id));
    if (cells.some((cell) => cell == null)) issue(path, "Every row needs a non-null cell in this column; fill missing cells first.");
    if (new Set(cells).size > max) issue(path, `Use at most ${max} distinct values in this column; aggregate or split the dataset.`);
  };
  if (value.controls?.filter !== undefined) nonNull(value.controls.filter, ["controls", "filter"], CLOUD_AI_CHART_MAX_SERIES);
  if (value.controls?.step !== undefined) nonNull(value.controls.step, ["controls", "step"], CLOUD_AI_CHART_MAX_VALUES);
  if (value.controls?.compare && value.controls.step === undefined)
    issue(["controls", "compare"], "Comparison needs controls.step; choose a step column.");
  value.views.forEach((chart, index) => {
    const path = ["views", index];
    if (value.views.findIndex((entry) => entry.id === chart.id) !== index)
      issue([...path, "id"], "View ids must be unique; choose a different id.");
    const point = chart.kind === "line" || chart.kind === "scatter";
    reference(chart.x, [...path, "x"], point ? ["number", "date", "datetime"] : undefined);
    const ys = Array.isArray(chart.y) ? chart.y : [chart.y];
    ys.forEach((id, i) => {
      const yPath = [...path, "y", ...(Array.isArray(chart.y) ? [i] : [])];
      reference(id, yPath, chart.kind === "heatmap" ? undefined : ["number"]);
      if (ys.indexOf(id) !== i) issue(yPath, "Y columns must be unique; remove the repeated column.");
    });
    if (chart.kind === "heatmap") reference(chart.value, [...path, "value"], ["number"]);
    if (point && chart.series !== undefined) {
      if (Array.isArray(chart.y)) issue([...path, "series"], "Series needs a single y column; use y as a column id.");
      nonNull(chart.series, [...path, "series"], CLOUD_AI_CHART_MAX_SERIES);
    }
    if (value.controls?.compare && !point) issue(path, "Comparison needs line or scatter views; change the kind or disable compare.");
    if (value.rows.length * ys.length > CLOUD_AI_VIEW_MAX_MARKS)
      issue(
        path,
        `The view has ${value.rows.length * ys.length} marks; the limit is ${CLOUD_AI_VIEW_MAX_MARKS}. Aggregate or split into several views.`,
      );
  });
  // Projection assumes typed cells and known columns; report those errors before computing axes.
  if (ctx.issues.length) return;
  const format = cloudAiViewCellFormatter(value.columns, "en");
  value.views.forEach((chart, index) => {
    if (chart.kind !== "bar" && chart.kind !== "heatmap") return;
    const seen = new Map<string | number | null, Set<string>>();
    for (const row of value.rows) {
      if (cloudAiViewScalarCellOf(row, chart.kind === "bar" ? chart.y : chart.value) == null) continue;
      const step = value.controls?.step === undefined ? null : cloudAiViewScalarCellOf(row, value.controls.step);
      const labels = chart.kind === "bar" ? [format(chart.x, row)] : [format(chart.x, row), format(chart.y, row)];
      const key = JSON.stringify(labels);
      const keys = seen.get(step) ?? new Set<string>();
      if (keys.has(key)) {
        issue(
          ["views", index],
          chart.kind === "bar"
            ? "Use one row per displayed x label in each step; aggregate rows first."
            : "Use one row per displayed x/y label pair in each step; aggregate rows first.",
        );
        break;
      }
      keys.add(key);
      seen.set(step, keys);
    }
  });
  if (ctx.issues.length) return;
  value.views.forEach((chart, index) => {
    if (chart.kind === "heatmap") return;
    const ys = Array.isArray(chart.y) ? chart.y : [chart.y];
    const counts = new Map<string | number | null, Map<string | number | null, number>>();
    let largest = 0;
    for (const row of value.rows) {
      if (chart.kind !== "bar" && cloudAiViewScalarCellOf(row, chart.x) == null) continue;
      const step = value.controls?.step === undefined ? null : cloudAiViewScalarCellOf(row, value.controls.step);
      for (const id of ys) {
        if (typeof cloudAiViewScalarCellOf(row, id) !== "number") continue;
        const series = chart.kind !== "bar" && chart.series !== undefined ? cloudAiViewScalarCellOf(row, chart.series) : id;
        let state = counts.get(step);
        if (!state) {
          state = new Map();
          counts.set(step, state);
        }
        const count = (state.get(series) ?? 0) + 1;
        state.set(series, count);
        largest = Math.max(largest, count);
      }
    }
    if (largest > CLOUD_AI_CHART_MAX_VALUES)
      issue(
        ["views", index],
        `The view draws ${largest} ${chart.kind === "bar" ? "bars" : "points in one series"} ${value.controls?.step === undefined ? "in total" : "in one step"}; the limit is ${CLOUD_AI_CHART_MAX_VALUES}. Aggregate the rows, keep the top ones, or add a step column.`,
      );
  });
  if (ctx.issues.length) return;
  const whole = cloudAiExplorerState(value, {}, "en");
  // Date axes vary by step. Group once; checking their points needs neither legends nor dataset-wide domains again.
  const stepRows = new Map<string | number | null, typeof value.rows>();
  if (value.controls?.step !== undefined)
    for (const row of value.rows) {
      const key = cloudAiViewScalarCellOf(row, value.controls.step);
      const rows = stepRows.get(key);
      if (rows) rows.push(row);
      else stepRows.set(key, [row]);
    }
  value.views.forEach((chart, index) => {
    const input = whole.charts[chart.id]!.input;
    // Check the whole fixed domain, including values whose other coordinate is null.
    let raw: CloudAiChartInput = input;
    if (input.kind === "bar")
      raw = { ...input, data: [...input.data, ...(input.yAxis?.domain ?? []).map((value) => ({ label: "", value }))], yAxis: undefined };
    if (input.kind === "line" || input.kind === "scatter") {
      const points = input.series.flatMap((series) => series.data);
      const xDomain = input.xAxis?.domain;
      const yDomain = input.yAxis?.domain;
      raw = {
        ...input,
        xAxis: undefined,
        yAxis: undefined,
        series: [
          {
            data: [
              ...points,
              ...(yDomain ?? []).map((y) => ({ x: points[0]?.x ?? xDomain?.[0] ?? 0, y })),
              ...(xDomain ?? []).map((x) => ({ x, y: yDomain?.[0] ?? 0 })),
            ],
          },
        ],
      };
    }
    const domains = [
      ...("xAxis" in input && input.xAxis?.domain ? [input.xAxis.domain] : []),
      ...("yAxis" in input && input.yAxis?.domain ? [input.yAxis.domain] : []),
    ];
    const stepping = domains.some(
      ([min, max]) =>
        min === undefined ||
        max === undefined ||
        !Number.isFinite(min) ||
        !Number.isFinite(max) ||
        min >= max ||
        !Number.isFinite(max - min),
    )
      ? "The values cannot form a finite axis; rescale them first."
      : chartSteppingIssue(raw);
    if (stepping) issue(["views", index], stepping);
    if (chart.kind === "heatmap" && input.kind === "heatmap") {
      const pairs = new Map(
        value.rows.map((row) => {
          const cell = { x: format(chart.x, row), y: format(chart.y, row), value: 0 };
          return [JSON.stringify([cell.x, cell.y]), cell];
        }),
      );
      const fit = chartDataIssue({ kind: "heatmap", title: chart.label, data: [...pairs.values()] });
      if (fit) issue(["views", index], fit);
    }
    if (
      (input.kind === "line" || input.kind === "scatter") &&
      columns.get(chart.x)!.type !== "number" &&
      value.controls?.step !== undefined
    ) {
      const ys = Array.isArray(chart.y) ? chart.y : [chart.y];
      stepRows.forEach((rows) => {
        const data: { x: string; y: number }[] = [];
        for (const row of rows) {
          const x = cloudAiViewScalarCellOf(row, chart.x);
          if (typeof x !== "string") continue;
          for (const id of ys) {
            const y = cloudAiViewScalarCellOf(row, id);
            if (typeof y === "number") data.push({ x, y });
          }
        }
        const error = chartSteppingIssue({ ...input, series: [{ data }] });
        if (error) issue(["views", index], error);
      });
    }
  });
});

const summarySchema = () =>
  z.discriminatedUnion("view", [
    z.object({
      view: z.literal("chart"),
      kind: cloudAiChartKindSchema(),
      title: z.string(),
      subtitle: z.string().optional(),
    }),
    z.object({
      view: z.literal("group"),
      title: z.string(),
      subtitle: z.string().optional(),
      linkX: z.boolean(),
      layout: z.enum(["stack", "grid"]),
      charts: z
        .array(z.object({ kind: cloudAiChartKindSchema(), title: z.string(), subtitle: z.string().optional() }))
        .min(2)
        .max(CLOUD_AI_GROUP_MAX_CHARTS),
    }),
    z.object({
      view: z.literal("explorer"),
      title: z.string(),
      subtitle: z.string().optional(),
      rows: z.number().int().nonnegative().max(CLOUD_AI_TABLE_MAX_ROWS),
      columns: z.number().int().min(1).max(CLOUD_AI_TABLE_MAX_COLUMNS),
      views: z
        .array(
          z.object({
            id: z.string().min(1).max(40),
            label: z.string().min(1).max(80),
            kind: z.enum(["bar", "line", "scatter", "heatmap"]),
          }),
        )
        .min(1)
        .max(CLOUD_AI_GROUP_MAX_CHARTS),
      step: z.boolean(),
      filter: z.boolean(),
      compare: z.boolean(),
    }),
    z.object({
      view: z.literal("table"),
      title: z.string(),
      subtitle: z.string().optional(),
      rows: z.number().int().nonnegative().max(CLOUD_AI_TABLE_MAX_ROWS),
      // The block reserves the totals row from the first frame.
      footer: z.boolean(),
      columns: z.number().int().min(1).max(CLOUD_AI_TABLE_MAX_COLUMNS),
    }),
    z.object({
      view: z.literal("stats"),
      title: z.string(),
      subtitle: z.string().optional(),
      items: z
        .array(z.object({ label: z.string(), sparkline: z.boolean(), sub: z.boolean(), delta: z.boolean() }))
        .min(1)
        .max(CLOUD_AI_STATS_MAX_ITEMS),
    }),
    z.object({
      view: z.literal("details"),
      title: z.string(),
      subtitle: z.string().optional(),
      items: z.number().int().min(1).max(CLOUD_AI_TABLE_MAX_COLUMNS),
      // The fields the viewport shows before it scrolls: label, whether the value is a reference pill, and the length
      // of its text, so the block reserves their wrapped height without their values.
      fields: z
        .array(z.object({ label: z.string(), ref: z.boolean(), chars: z.number().int().nonnegative().max(CLOUD_AI_DETAILS_MAX_CHARS) }))
        .min(1)
        .max(CLOUD_AI_DETAILS_VIEWPORT_ITEMS),
    }),
  ]);
export const CloudAiViewSummarySchema = /* @__PURE__ */ summarySchema();
export type CloudAiViewSummary = z.output<typeof CloudAiViewSummarySchema>;

const unknownViewSchema = () =>
  z.unknown().transform((_value, ctx) => {
    ctx.addIssue({ code: "custom", path: ["view"], message: "Expected one of chart, group, table, stats, details, explorer." });
    return z.NEVER;
  });
const UnknownViewSchema = /* @__PURE__ */ unknownViewSchema();
const parse = (value: unknown) => {
  if (typeof value === "object" && value !== null && "view" in value) {
    switch (value.view) {
      case "chart":
        return ChartViewSchema.safeParse(value);
      case "group":
        return GroupViewSchema.safeParse(value);
      case "table":
        return TableViewSchema.safeParse(value);
      case "stats":
        return StatsViewSchema.safeParse(value);
      case "details":
        return DetailsViewSchema.safeParse(value);
      case "explorer":
        return ExplorerViewSchema.safeParse(value);
    }
  }
  return UnknownViewSchema.safeParse(value);
};
export const parseCloudAiView = (value: unknown): CloudAiView | undefined => {
  const parsed = parse(value);
  return parsed.success ? parsed.data : undefined;
};
export const checkCloudAiView = (value: unknown): { view: CloudAiView } | { issues: string[] } => {
  const parsed = parse(value);
  if (!parsed.success)
    return {
      issues: parsed.error.issues.map((issue) => {
        const path = issue.path.reduce<string>(
          (text, part) => (typeof part === "number" ? `${text}[${part}]` : `${text}${text ? "." : ""}${String(part)}`),
          "",
        );
        return `${path || "view"}: ${issue.message.replace(/\.?$/, ".")}`;
      }),
    };
  if (parsed.data.view === "chart") {
    const issue = chartDrawingIssue(parsed.data);
    if (issue) return { issues: [`chart: ${issue}`] };
  }
  if (parsed.data.view === "group") {
    const issues = parsed.data.charts.flatMap((chart, index) => {
      const issue = chartDrawingIssue(chart);
      return issue ? [`charts[${index}]: ${issue}`] : [];
    });
    if (issues.length) return { issues };
  }
  return { view: parsed.data };
};
export const cloudAiViewSummary = (view: CloudAiView): CloudAiViewSummary => {
  const common = { title: view.title, ...(view.subtitle ? { subtitle: view.subtitle } : {}) };
  if (view.view === "explorer")
    return {
      view: "explorer",
      ...common,
      rows: view.rows.length,
      columns: view.columns.length,
      views: view.views.map(({ id, label, kind }) => ({ id, label, kind })),
      step: view.controls?.step !== undefined,
      filter: view.controls?.filter !== undefined,
      compare: view.controls?.compare ?? false,
    };
  if (view.view === "group")
    return {
      view: "group",
      ...common,
      linkX: view.linkX ?? false,
      layout: view.layout ?? "stack",
      charts: view.charts.map((chart) => ({
        kind: chart.kind,
        title: chart.title,
        ...(chart.subtitle ? { subtitle: chart.subtitle } : {}),
      })),
    };
  if (view.view === "stats")
    return {
      view: "stats",
      ...common,
      items: view.items.map((item) => ({
        label: item.label,
        sparkline: item.sparkline !== undefined,
        sub: item.sub !== undefined,
        delta: item.delta !== undefined,
      })),
    };
  if (view.view === "details")
    return {
      view: "details",
      ...common,
      items: view.items.length,
      // English text has about the length of the viewer's: dates and amounts differ by a character or two.
      fields: cloudAiDetailsRows({ ...view, items: view.items.slice(0, CLOUD_AI_DETAILS_VIEWPORT_ITEMS) }, "en-US").map((row) => ({
        label: row.label,
        ref: row.ref !== undefined,
        chars: Math.min(row.text.length, CLOUD_AI_DETAILS_MAX_CHARS),
      })),
    };
  return view.view === "chart"
    ? { view: "chart", kind: view.kind, ...common }
    : { view: "table", rows: view.rows.length, columns: view.columns.length, footer: view.footer !== undefined, ...common };
};
/** Tool arguments become the same canonical views as saved code-run files, without drawing on revalidation. */
export const parseCloudAiChartToolView = (args: unknown): CloudAiChartView | CloudAiGroupView | undefined => {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = Object.fromEntries(Object.entries(args));
  if ((value.kind !== undefined) === (value.charts !== undefined)) return undefined;
  if (value.charts !== undefined) {
    const { title, subtitle, charts, linkX, layout } = value;
    const parsed = GroupViewSchema.safeParse({ title, subtitle, charts, linkX, layout, view: "group" });
    return parsed.success ? parsed.data : undefined;
  }
  if (value.linkX !== undefined || value.layout !== undefined) return undefined;
  const parsed = ChartViewSchema.safeParse({ ...value, view: "chart" });
  return parsed.success ? parsed.data : undefined;
};
export const isAiViewPath = (path: string) => path === CLOUD_AI_VIEW_DIRECTORY || path.startsWith(`${CLOUD_AI_VIEW_DIRECTORY}/`);
export const isAiViewFile = (file: { path: string; origin: string }) =>
  file.origin === "assistant" && file.path.startsWith(`${CLOUD_AI_VIEW_DIRECTORY}/`) && file.path.endsWith(CLOUD_AI_VIEW_SUFFIX);

const viewDateFormatter = (locale: string) => {
  let dateFormat: Intl.DateTimeFormat | undefined;
  let shortTimeFormat: Intl.DateTimeFormat | undefined;
  let mediumTimeFormat: Intl.DateTimeFormat | undefined;
  return (type: "date" | "datetime", cell: string): string => {
    const options = { timeZone: "UTC", dateStyle: "medium" } as const;
    if (type === "date") {
      dateFormat ??= new Intl.DateTimeFormat(locale, options);
      return dateFormat.format(chartDateTime(cell));
    }
    if (cell.length > 16) {
      mediumTimeFormat ??= new Intl.DateTimeFormat(locale, { ...options, timeStyle: "medium" });
      return mediumTimeFormat.format(chartDateTime(cell));
    }
    shortTimeFormat ??= new Intl.DateTimeFormat(locale, { ...options, timeStyle: "short" });
    return shortTimeFormat.format(chartDateTime(cell));
  };
};

/**
 * The text of every stat tile, the same for the web chat and the terminal. A change carries its sign and a tone the
 * host colors: better or worse only when the view says which direction improves the measure.
 */
export function cloudAiStatsTiles(
  view: CloudAiStatsView,
  locale: string,
): {
  label: string;
  value: string;
  sub?: string;
  sparkline?: number[];
  delta?: { text: string; direction: "up" | "down" | "flat"; tone: "better" | "worse" | "neutral" };
}[] {
  return view.items.map((item) => {
    const format = cloudAiNumberFormatters(item.format, locale).value;
    const direction = item.delta === undefined || item.delta === 0 ? "flat" : item.delta > 0 ? "up" : "down";
    return {
      label: item.label,
      value: typeof item.value === "number" ? format(item.value) : item.value,
      ...(item.sub !== undefined ? { sub: item.sub } : {}),
      ...(item.sparkline !== undefined ? { sparkline: item.sparkline } : {}),
      ...(item.delta !== undefined
        ? {
            delta: {
              // -0 shows as 0, without a sign.
              text: `${item.delta > 0 ? "+" : ""}${format(item.delta === 0 ? 0 : item.delta)}`,
              direction,
              tone: !item.better || item.delta === 0 ? "neutral" : direction === item.better ? "better" : "worse",
            },
          }
        : {}),
    };
  });
}

/** The label and display text of every field of a record; a reference keeps its object so the host can open it. */
export function cloudAiDetailsRows(
  view: CloudAiDetailsView,
  locale: string,
): { label: string; text: string; ref?: CloudAiViewReference }[] {
  const date = viewDateFormatter(locale);
  return view.items.map((item) => {
    const value = item.value;
    if (value === null) return { label: item.label, text: "" };
    if (typeof value === "object") return { label: item.label, text: value.title ?? value.id, ref: value };
    // A number in a text field stays as written, as in a table's text column.
    const text =
      item.type === "number" && typeof value === "number"
        ? cloudAiNumberFormatters(item.format, locale).value(value)
        : (item.type === "date" || item.type === "datetime") && typeof value === "string"
          ? date(item.type, value)
          : String(value);
    return { label: item.label, text };
  });
}

export type CloudAiViewTable = CloudAiChartTable & { footer?: CloudAiChartRow };
// Column ids are data; missing cells must not read Object.prototype.
export const cloudAiViewCellOf = (cells: CloudAiTableView["rows"][number], id: string) => (Object.hasOwn(cells, id) ? cells[id]! : null);

/** Explorer encodings reject ref columns before projection; reference cells have no scalar value. */
export const cloudAiViewScalarCellOf = (cells: CloudAiTableView["rows"][number], id: string): string | number | null => {
  const cell = cloudAiViewCellOf(cells, id);
  return typeof cell === "object" ? null : cell;
};

export function cloudAiViewCellFormatter(columns: CloudAiTableView["columns"], locale: string) {
  const byId = new Map(columns.map((column) => [column.id, column]));
  const numberFormats = new Map(
    columns
      .filter((column) => column.type === "number")
      .map((column) => {
        return [column.id, cloudAiNumberFormatters(column.format, locale).value] as const;
      }),
  );
  const date = viewDateFormatter(locale);
  const formatCell = (
    column: CloudAiTableView["columns"][number],
    cell: Exclude<CloudAiTableView["rows"][number][string], null>,
  ): string => {
    if (typeof cell === "object") return cell.title ?? cell.id;
    if (column.type === "number" && typeof cell === "number") return numberFormats.get(column.id)!(cell);
    if ((column.type === "date" || column.type === "datetime") && typeof cell === "string") return date(column.type, cell);
    return String(cell);
  };
  return (id: string, cells: CloudAiTableView["rows"][number]): string => {
    const cell = cloudAiViewCellOf(cells, id);
    return cell == null ? "" : formatCell(byId.get(id)!, cell);
  };
}
/** Row keys are original row indices, so hosts resolve refs through view.rows[Number(row.key)][column.id] even after sorting. */
export function cloudAiViewTable(view: CloudAiTableView | CloudAiExplorerView, locale: string): CloudAiViewTable {
  const cellOf = cloudAiViewCellOf;
  const formatCell = cloudAiViewCellFormatter(view.columns, locale);
  const row = (cells: CloudAiTableView["rows"][number], key: string): CloudAiChartRow => ({
    key,
    cells: Object.fromEntries(view.columns.map((column) => [column.id, formatCell(column.id, cells)])),
    values: Object.fromEntries(
      view.columns.flatMap((column) => {
        const cell = cellOf(cells, column.id);
        return cell == null ? [] : [[column.id, typeof cell === "object" ? (cell.title ?? cell.id) : cell]];
      }),
    ),
  });
  const rows = view.rows.map((cells, index) => row(cells, String(index)));
  return {
    columns: view.columns.map((column) => ({ id: column.id, label: column.label ?? column.id, numeric: column.type === "number" })),
    // The view's own order, so every reader starts from the same rows.
    rows: "sort" in view && view.sort ? sortCloudAiViewRows(rows, { key: view.sort.column, direction: view.sort.direction }, locale) : rows,
    ...("footer" in view && view.footer ? { footer: row(view.footer, "footer") } : {}),
  };
}

/** Rows of a view table in the given order: numbers by value, text by the locale, empty cells last in both directions. */
export function sortCloudAiViewRows(
  rows: readonly CloudAiChartRow[],
  sort: { key: string; direction: "asc" | "desc" },
  locale: string,
): CloudAiChartRow[] {
  const collator = new Intl.Collator(locale, { numeric: true });
  // Column ids are data; a missing cell must not read an inherited property such as "constructor".
  const value = (row: CloudAiChartRow) => (Object.hasOwn(row.values, sort.key) ? row.values[sort.key] : undefined);
  return [...rows].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    if (av === undefined) return bv === undefined ? 0 : 1;
    if (bv === undefined) return -1;
    const comparison = typeof av === "number" && typeof bv === "number" ? av - bv : collator.compare(String(av), String(bv));
    return sort.direction === "asc" ? comparison : -comparison;
  });
}
export function cloudAiTableTsv(table: CloudAiViewTable): string {
  const cell = (text: string, numeric = false) => {
    const safe = !numeric && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[\t\r\n"]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [
    table.columns.map((column) => cell(column.label)).join("\t"),
    ...[...table.rows, ...(table.footer ? [table.footer] : [])].map((row) =>
      table.columns.map((column) => cell(row.cells[column.id] ?? "", column.numeric)).join("\t"),
    ),
  ].join("\n");
}

export type CloudAiExplorerRequest = { step?: string; visibleKeys?: readonly string[]; referenceStep?: string };
type Cell = string | number | null;
const distinct = (view: CloudAiExplorerView, id: string) => [...new Set(view.rows.map((row) => cloudAiViewScalarCellOf(row, id)))];

/** Localized step and filter choices in dataset order, initially showing the last step. */
export function cloudAiExplorerControls(view: CloudAiExplorerView, locale: string) {
  const format = cloudAiViewCellFormatter(view.columns, locale);
  const entries = (id: string | undefined) =>
    id === undefined ? [] : distinct(view, id).map((cell, position) => ({ key: String(position), label: format(id, { [id]: cell }) }));
  const steps = entries(view.controls?.step);
  const series = entries(view.controls?.filter).map((entry, color) => ({ ...entry, color }));
  const initial: CloudAiExplorerRequest = steps.length ? { step: steps.at(-1)!.key } : {};
  return { steps, series, initial };
}

type ExplorerChartState = {
  input: CloudAiChartInput;
  marks: number[][];
  legend: { label: string; color: number; style?: "solid" | "dashed"; reference?: boolean }[];
};

/** Project current and reference rows into every view, retaining dataset-wide axes and series palette slots. */
export function cloudAiExplorerState(
  view: CloudAiExplorerView,
  request: CloudAiExplorerRequest,
  locale: string,
): {
  rows: number[];
  charts: Record<string, ExplorerChartState>;
} {
  const format = cloudAiViewCellFormatter(view.columns, locale);
  const columns = new Map(view.columns.map((column) => [column.id, column]));
  const stepId = view.controls?.step;
  const filterId = view.controls?.filter;
  const steps = stepId === undefined ? [] : distinct(view, stepId);
  const filters = filterId === undefined ? [] : distinct(view, filterId);
  const stepValue = (key: string | undefined): Cell | undefined =>
    key === undefined ? undefined : steps.find((_, index) => String(index) === key);
  const current = stepValue(request.step);
  const reference = stepValue(request.referenceStep);
  // A reference on the shown step would only draw every point twice; it compares once the slider moves.
  const comparing = stepId !== undefined && reference !== undefined && request.referenceStep !== request.step;
  const visible = filterId === undefined || request.visibleKeys === undefined ? undefined : new Set(request.visibleKeys);
  const included = (index: number) =>
    !visible || visible.has(String(filters.indexOf(cloudAiViewScalarCellOf(view.rows[index]!, filterId!))));
  const currentRows = view.rows.flatMap((row, index) =>
    included(index) && (stepId === undefined || request.step === undefined || cloudAiViewScalarCellOf(row, stepId) === current)
      ? [index]
      : [],
  );
  const referenceRows = comparing
    ? view.rows.flatMap((row, index) => (included(index) && cloudAiViewScalarCellOf(row, stepId!) === reference ? [index] : []))
    : [];
  const shown = new Set([...currentRows, ...referenceRows]);
  const rows = view.rows.flatMap((_, index) => (shown.has(index) ? [index] : []));
  const numbers = (ids: string[]) =>
    view.rows.flatMap((row) =>
      ids.flatMap((id) => {
        const cell = cloudAiViewScalarCellOf(row, id);
        return typeof cell === "number" ? [cell] : [];
      }),
    );
  const domain = (values: number[], zero = false): [number, number] => {
    const [min, max] = computeDomain(zero ? [...values, 0] : values);
    const step = niceStep(max - min, 5);
    const ends = [Math.floor(min / step) * step, Math.ceil(max / step) * step];
    // Invalid input is inspected before rejection too; never enter the stdlib tick loop for unsafe ranges.
    if (!Number.isFinite(step) || step <= 0 || ends.some((end) => !Number.isFinite(end) || end + step === end || end - step === end))
      return [min, max];
    return extendDomainToNice(min, max, step).domain;
  };
  // A number x axis spans exactly the data, so months 1..12 do not start at a padded 0; value axes round to nice ends.
  const axis = (ids: string[], options: { zero?: boolean; exact?: boolean } = {}) => {
    const column = columns.get(ids[0]!)!;
    const values = column.type === "number" ? numbers(ids) : [];
    const [min, max] = values.length ? [Math.min(...values), Math.max(...values)] : [0, 0];
    return {
      ...(ids.length === 1 ? { label: column.label ?? column.id } : {}),
      ...(column.format ? { format: column.format } : {}),
      ...(column.type === "number" ? { domain: options.exact && min < max ? [min, max] : domain(values, options.zero) } : {}),
    };
  };
  const charts = view.views.map((chart): [string, ExplorerChartState] => {
    const title = chart.label;
    if (chart.kind === "bar") {
      const marks: number[][] = [[]];
      const data = rows.flatMap((index) => {
        const row = view.rows[index]!;
        const value = cloudAiViewScalarCellOf(row, chart.y);
        if (typeof value !== "number") return [];
        marks[0]!.push(index);
        return [{ label: format(chart.x, row), value }];
      });
      return [chart.id, { input: { kind: "bar", title, data, yAxis: axis([chart.y], { zero: true }) }, marks, legend: [] }];
    }
    if (chart.kind === "heatmap") {
      const marks: number[][] = [[]];
      const data = rows.flatMap((index) => {
        const row = view.rows[index]!;
        const value = cloudAiViewScalarCellOf(row, chart.value);
        if (typeof value !== "number") return [];
        marks[0]!.push(index);
        return [{ x: format(chart.x, row), y: format(chart.y, row), value }];
      });
      const [min, max] = computeDomain(numbers([chart.value]));
      return [chart.id, { input: { kind: "heatmap", title, data, min, max, format: columns.get(chart.value)!.format }, marks, legend: [] }];
    }
    const ys = Array.isArray(chart.y) ? chart.y : [chart.y];
    const groups = chart.series === undefined ? undefined : distinct(view, chart.series);
    const names = groups
      ? groups.map((cell) => format(chart.series!, { [chart.series!]: cell }))
      : ys.map((id) => columns.get(id)!.label ?? id);
    const series: { label: string; data: { x: string | number; y: number }[]; role?: "reference" }[] = [];
    const marks: number[][] = [];
    const legend: ExplorerChartState["legend"] = [];
    const stepLabel = (cell: Cell | undefined) => (stepId === undefined || cell === undefined ? "" : format(stepId, { [stepId]: cell }));
    const add = (indexes: number[], offset: number, reference = false) => {
      while (series.length < offset + names.length) {
        series.push({ label: "", data: [] });
        marks.push([]);
      }
      names.forEach((name, slot) => {
        series[offset + slot] = {
          label: comparing ? `${name} · ${stepLabel(reference ? stepValue(request.referenceStep) : current)}` : name,
          data: [],
          ...(reference ? { role: "reference" } : {}),
        };
      });
      for (const index of indexes) {
        const row = view.rows[index]!;
        ys.forEach((id, yIndex) => {
          const x = cloudAiViewScalarCellOf(row, chart.x);
          const y = cloudAiViewScalarCellOf(row, id);
          if (x == null || typeof y !== "number") return;
          const slot = offset + (groups ? groups.indexOf(cloudAiViewScalarCellOf(row, chart.series!)) : yIndex);
          series[slot]!.data.push({ x, y });
          marks[slot]!.push(index);
        });
      }
      names.forEach((_, slot) => {
        const entry = series[offset + slot]!;
        if (entry.data.length)
          legend.push({
            label: entry.label,
            color: slot % 8,
            ...(chart.kind === "line" ? { style: reference ? "dashed" : "solid" } : {}),
            ...(reference ? { reference: true } : {}),
          });
      });
    };
    add(currentRows, 0);
    if (comparing) add(referenceRows, 8, true);
    return [
      chart.id,
      { input: { kind: chart.kind, title, series, xAxis: axis([chart.x], { exact: true }), yAxis: axis(ys) }, marks, legend },
    ];
  });
  return { rows, charts: Object.fromEntries(charts) };
}
