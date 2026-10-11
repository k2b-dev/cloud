import { z } from "zod";
import { CloudResourceReferenceSchema } from "../contracts/capabilities";
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

// StatGrid supports at most six columns.
export const CLOUD_AI_STATS_MAX_ITEMS = 6;
// A record shows this many fields before its viewport scrolls; its summary sizes only these.
export const CLOUD_AI_DETAILS_VIEWPORT_ITEMS = 12;
// Twelve rows hold about 22 lines; at the widest chat column a line holds about 110 characters, so a longer value fills
// the viewport at any width and its length counts no further.
export const CLOUD_AI_DETAILS_MAX_CHARS = 4096;

const referenceSchema = () => CloudResourceReferenceSchema.pick({ type: true, id: true, title: true });
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
const tableViewSchema = () => {
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
            type: cellTypeSchema(),
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
          const message = column ? cellIssue(column.type, cell) : "Unknown column id.";
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
const StatsViewSchema = /* @__PURE__ */ statsViewSchema();
const DetailsViewSchema = /* @__PURE__ */ detailsViewSchema();
export type CloudAiChartView = z.output<typeof ChartViewSchema>;
export type CloudAiTableView = z.output<typeof TableViewSchema>;
export type CloudAiGroupView = z.output<typeof GroupViewSchema>;
export type CloudAiStatsView = z.output<typeof StatsViewSchema>;
export type CloudAiDetailsView = z.output<typeof DetailsViewSchema>;
export type CloudAiView = CloudAiChartView | CloudAiTableView | CloudAiGroupView | CloudAiStatsView | CloudAiDetailsView;

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
    ctx.addIssue({ code: "custom", path: ["view"], message: "Expected one of chart, group, table, stats, details." });
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
/** Row keys are original row indices, so hosts resolve refs through view.rows[Number(row.key)][column.id] even after sorting. */
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
  const row = (cells: CloudAiTableView["rows"][number], key: string): CloudAiChartRow => ({
    key,
    cells: Object.fromEntries(
      view.columns.map((column) => [column.id, cellOf(cells, column.id) == null ? "" : formatCell(column, cellOf(cells, column.id)!)]),
    ),
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
