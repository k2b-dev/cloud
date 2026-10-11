import { z } from "zod";
import { type CloudAiChartRow, type CloudAiChartTable, chartDateTime, chartDrawingIssue, cloudAiNumberFormatters } from "./chart-block";
import {
  CLOUD_AI_CHART_MAX_SERIES,
  CLOUD_AI_CHART_MAX_VALUES,
  CLOUD_AI_GROUP_MAX_CHARTS,
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

const chartViewSchema = () => z.object({ view: z.literal("chart") }).and(cloudAiChartSchema());
const tableViewSchema = () => {
  const cell = z.union([z.string(), z.number(), z.null()]);
  // z.record drops __proto__; column ids must survive validation without changing the object's prototype.
  const row = z.unknown().transform((value, ctx) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
      ctx.addIssue({ code: "custom", message: "Expected a row object." });
      return z.NEVER;
    }
    const entries: [string, string | number | null][] = [];
    for (const [id, input] of Object.entries(value)) {
      const parsed = cell.safeParse(input);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: [id, ...issue.path] });
      } else entries.push([id, parsed.data]);
    }
    return Object.fromEntries(entries);
  });
  return z
    .strictObject({
      view: z.literal("table"),
      title: z.string().trim().min(1).max(160),
      subtitle: z.string().trim().min(1).max(300).optional(),
      columns: z
        .array(
          z.strictObject({
            id: z.string().trim().min(1).max(80),
            label: z.string().min(1).max(80).optional(),
            type: z.enum(["text", "number", "date", "datetime"]),
            format: cloudAiNumberFormatSchema().optional(),
          }),
        )
        .min(1)
        .max(CLOUD_AI_TABLE_MAX_COLUMNS),
      rows: z.array(row).max(CLOUD_AI_TABLE_MAX_ROWS),
      footer: row.optional(),
      sort: z.strictObject({ column: z.string(), direction: z.enum(["asc", "desc"]) }).optional(),
    })
    .superRefine((value, ctx) => {
      const columns = new Map(value.columns.map((column) => [column.id, column]));
      value.columns.forEach((column, index) => {
        if (value.columns.findIndex((entry) => entry.id === column.id) !== index)
          ctx.addIssue({ code: "custom", path: ["columns", index, "id"], message: "Column ids must be unique." });
        if (column.format && column.type !== "number")
          ctx.addIssue({ code: "custom", path: ["columns", index, "format"], message: "Only number columns may have a format." });
      });
      const checkRow = (cells: z.output<typeof row>, path: (string | number)[]) => {
        for (const [id, cell] of Object.entries(cells)) {
          const column = columns.get(id);
          let message: string | undefined;
          if (!column) message = "Unknown column id.";
          else if (cell === null) continue;
          else if (column.type === "number" && typeof cell !== "number") message = "Expected a number or null.";
          else if (column.type === "date" || column.type === "datetime") {
            const pattern = column.type === "date" ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
            if (typeof cell !== "string" || !pattern.test(cell) || chartDateTime(cell) === undefined)
              message =
                column.type === "date" ? "Expected a valid YYYY-MM-DD date or null." : "Expected a valid wall-clock datetime or null.";
          }
          if (message) ctx.addIssue({ code: "custom", path: [...path, id], message });
        }
      };
      value.rows.forEach((cells, index) => checkRow(cells, ["rows", index]));
      if (value.footer) checkRow(value.footer, ["footer"]);
      if (value.sort && !columns.has(value.sort.column))
        ctx.addIssue({ code: "custom", path: ["sort", "column"], message: "Unknown column id." });
    });
};
const groupViewSchema = () => cloudAiGroupSchema().safeExtend({ view: z.literal("group") });
const GroupViewSchema = /* @__PURE__ */ groupViewSchema();
const ChartViewSchema = /* @__PURE__ */ chartViewSchema();
const TableViewSchema = /* @__PURE__ */ tableViewSchema();
export type CloudAiChartView = z.output<typeof ChartViewSchema>;
export type CloudAiTableView = z.output<typeof TableViewSchema>;
export type CloudAiGroupView = z.output<typeof GroupViewSchema>;
export type CloudAiView = CloudAiChartView | CloudAiTableView | CloudAiGroupView;

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
      view: z.literal("table"),
      title: z.string(),
      subtitle: z.string().optional(),
      rows: z.number().int().nonnegative().max(CLOUD_AI_TABLE_MAX_ROWS),
      // The block reserves the totals row from the first frame.
      footer: z.boolean(),
      columns: z.number().int().min(1).max(CLOUD_AI_TABLE_MAX_COLUMNS),
    }),
  ]);
export const CloudAiViewSummarySchema = /* @__PURE__ */ summarySchema();
export type CloudAiViewSummary = z.output<typeof CloudAiViewSummarySchema>;

const parse = (value: unknown) => {
  if (typeof value === "object" && value !== null && "view" in value && value.view === "chart") return ChartViewSchema.safeParse(value);
  if (typeof value === "object" && value !== null && "view" in value && value.view === "group") return GroupViewSchema.safeParse(value);
  return TableViewSchema.safeParse(value);
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

export type CloudAiViewTable = CloudAiChartTable & { footer?: CloudAiChartRow };
export function cloudAiViewTable(view: CloudAiTableView, locale: string): CloudAiViewTable {
  // Missing cells stay null even when a column id names an Object.prototype property.
  const cellOf = (cells: CloudAiTableView["rows"][number], id: string) => (Object.hasOwn(cells, id) ? cells[id] : null);
  const numberFormats = new Map(
    view.columns
      .filter((column) => column.type === "number")
      .map((column) => {
        return [column.id, cloudAiNumberFormatters(column.format, locale).value] as const;
      }),
  );
  let dateFormat: Intl.DateTimeFormat | undefined;
  let shortTimeFormat: Intl.DateTimeFormat | undefined;
  let mediumTimeFormat: Intl.DateTimeFormat | undefined;
  const formatCell = (column: CloudAiTableView["columns"][number], cell: string | number): string => {
    if (column.type === "number" && typeof cell === "number") return numberFormats.get(column.id)!(cell);
    if ((column.type === "date" || column.type === "datetime") && typeof cell === "string") {
      const options = { timeZone: "UTC", dateStyle: "medium" } as const;
      if (column.type === "date") {
        dateFormat ??= new Intl.DateTimeFormat(locale, options);
        return dateFormat.format(chartDateTime(cell));
      }
      if (cell.length > 16) {
        mediumTimeFormat ??= new Intl.DateTimeFormat(locale, { ...options, timeStyle: "medium" });
        return mediumTimeFormat.format(chartDateTime(cell));
      }
      shortTimeFormat ??= new Intl.DateTimeFormat(locale, { ...options, timeStyle: "short" });
      return shortTimeFormat.format(chartDateTime(cell));
    }
    return String(cell);
  };
  const row = (cells: CloudAiTableView["rows"][number], key: string): CloudAiChartRow => ({
    key,
    cells: Object.fromEntries(
      view.columns.map((column) => [column.id, cellOf(cells, column.id) == null ? "" : formatCell(column, cellOf(cells, column.id)!)]),
    ),
    values: Object.fromEntries(
      view.columns.flatMap((column) => (cellOf(cells, column.id) == null ? [] : [[column.id, cellOf(cells, column.id)!]])),
    ),
  });
  const rows = view.rows.map((cells, index) => row(cells, String(index)));
  return {
    columns: view.columns.map((column) => ({ id: column.id, label: column.label ?? column.id, numeric: column.type === "number" })),
    // The view's own order, so every reader starts from the same rows.
    rows: view.sort ? sortCloudAiViewRows(rows, { key: view.sort.column, direction: view.sort.direction }, locale) : rows,
    ...(view.footer ? { footer: row(view.footer, "footer") } : {}),
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
