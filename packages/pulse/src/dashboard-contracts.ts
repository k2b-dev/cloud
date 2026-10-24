import { z } from "zod";
import { sqlParameterNames, validateSqlInput } from "./sql-params";

export const DASHBOARD_MAX_PANELS = 36;
export const DASHBOARD_MAX_SERIES = 8;
export const DASHBOARD_MAX_POINTS = 480;
export const DASHBOARD_MAX_MARKS = 3_840;
export const DASHBOARD_CACHE_ENTRIES = 500;
export const DASHBOARD_CACHE_BYTES = 64 * 1024 * 1024;
export const DASHBOARD_REFRESH_MS = 60_000;

export const NUMBER_METADATA_COLUMNS = ["unit", "detail", "detailTone"] as const;
const Column = z.string().min(1).max(120);
const DashboardPanelFields = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .describe("Stable panel ID within this dashboard."),
    title: z.string().trim().min(1).max(120).describe("Visible panel title."),
    description: z.string().max(1_000).default("").describe("Short explanation of the result and unit."),
    section: z.string().max(120).default("").describe("Section heading; number panels appear in the summary row."),
    sectionIcon: z
      .string()
      .regex(/^ti ti-[a-z0-9-]+$/)
      .optional()
      .describe("Tabler icon class shared by panels in this section."),
    sectionDescription: z.string().max(240).optional().describe("Section caption describing sources or cadence."),
    sectionColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional()
      .describe("Section icon tint as a six-digit hex color."),
    kind: z.enum(["number", "line", "bar", "table", "funnel"]).describe("How to display the selected SQL columns."),
    sql: z.string().describe("Read-only SQL; :from, :to and :bucket follow the dashboard range."),
    params: z.record(z.string(), z.string()).default({}).describe("Values for other named SQL parameters; base_tz is reserved."),
    columns: z.array(Column).min(1).max(32).describe("Exact output columns to display, in order."),
    x: Column.optional().describe("Time or category column, included in columns."),
    series: Column.optional().describe("Column that splits line or bar values into series."),
    unit: z.string().max(32).default("").describe("Display unit for numeric values."),
    threshold: z.number().finite().optional().describe("Optional horizontal reference value."),
    width: z.enum(["third", "half", "full"]).default("third").describe("Panel width in the responsive grid."),
  })
  .strict();
export const PublicDashboardPanelSchema = DashboardPanelFields.omit({ sql: true, params: true });
export const DashboardPanelSchema = DashboardPanelFields.superRefine((panel, context) => {
  if (new Set(panel.columns).size !== panel.columns.length)
    context.addIssue({ code: "custom", path: ["columns"], message: "Column names must be unique" });
  for (const key of ["x", "series"] as const)
    if (panel[key] && !panel.columns.includes(panel[key]))
      context.addIssue({ code: "custom", path: [key], message: "The column must be included in columns" });
  if (["line", "bar", "funnel"].includes(panel.kind) && !panel.x)
    context.addIssue({ code: "custom", path: ["x"], message: "Choose the time or category column" });
  const values = panel.columns.filter(
    (column) =>
      column !== panel.x &&
      column !== panel.series &&
      !(panel.kind === "number" && NUMBER_METADATA_COLUMNS.some((name) => name === column)),
  );
  if (panel.kind !== "table" && !values.length)
    context.addIssue({ code: "custom", path: ["columns"], message: "Choose at least one value column" });
  if (panel.kind === "number" && (values.length !== 1 || panel.series))
    context.addIssue({ code: "custom", path: ["columns"], message: "A number panel needs exactly one value column" });
  if (panel.kind === "funnel" && (values.length !== 1 || panel.series))
    context.addIssue({ code: "custom", path: ["columns"], message: "A funnel needs one category and one value column" });
  try {
    const params = { ...panel.params };
    for (const name of sqlParameterNames(panel.sql)) {
      if (name === "from") params.from = "2026-01-01T00:00:00Z";
      if (name === "to") params.to = "2026-01-02T00:00:00Z";
      if (name === "bucket") params.bucket = "5m";
    }
    validateSqlInput(panel.sql, params);
  } catch (error) {
    context.addIssue({ code: "custom", path: ["sql"], message: error instanceof Error ? error.message : "Invalid SQL" });
  }
});
export const DashboardDefinitionSchema = z
  .object({
    panels: z
      .array(DashboardPanelSchema)
      .max(DASHBOARD_MAX_PANELS)
      .describe("Ordered panels, at most 36, each with SQL and its projection."),
  })
  .strict()
  .superRefine((definition, context) => {
    if (new Set(definition.panels.map((panel) => panel.id)).size !== definition.panels.length)
      context.addIssue({ code: "custom", path: ["panels"], message: "Panel IDs must be unique" });
    const sections = new Map<string, string>();
    for (const [index, panel] of definition.panels.entries()) {
      if (!panel.section || panel.kind === "number") continue;
      const metadata = JSON.stringify([panel.sectionIcon, panel.sectionDescription, panel.sectionColor]);
      if (sections.has(panel.section) && sections.get(panel.section) !== metadata)
        context.addIssue({
          code: "custom",
          path: ["panels", index, "section"],
          message: "Panels in one section must share its presentation",
        });
      sections.set(panel.section, metadata);
    }
  });
export const DashboardSaveSchema = z
  .object({
    name: z.string().trim().min(1).max(120).describe("Visible dashboard name."),
    definition: DashboardDefinitionSchema.describe("Complete dashboard definition replacing the previous revision."),
    expectedRevision: z.number().int().positive().optional().describe("Current revision from dashboard.read; required for an update."),
  })
  .strict();
export type DashboardPanel = z.infer<typeof DashboardPanelSchema>;
export type DashboardDefinition = z.infer<typeof DashboardDefinitionSchema>;
export type Dashboard = {
  id: string;
  baseId: string;
  name: string;
  definition: DashboardDefinition;
  revision: number;
  published: boolean;
  createdAt: string;
  updatedAt: string;
};
export type DashboardWindow = { from: string; to: string; bucket: string };
export const DashboardRangeSchema = z
  .object({
    range: z.enum(["24h", "7d", "30d", "90d"]).default("24h"),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((value) => !!value.from === !!value.to, "Provide both from and to");
export type DashboardRange = z.input<typeof DashboardRangeSchema>;
/** Round both bounds to a shared grid, keeping every chart below 480 points. */
export const dashboardWindow = (input: DashboardRange, now: Date): DashboardWindow => {
  const range = DashboardRangeSchema.parse(input);
  const days = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 }[range.range];
  const to = range.to ? Date.parse(range.to) : now.getTime();
  const from = range.from ? Date.parse(range.from) : to - days * 86_400_000;
  if (to <= from) throw new Error("The end must be after the start");
  const minutes = Math.max(1, Math.ceil((to - from) / DASHBOARD_MAX_POINTS / 60_000));
  const step = minutes * 60_000;
  const start = Math.floor(from / step) * step;
  const end = Math.max(start + step, Math.floor(to / step) * step);
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString(), bucket: `${minutes}m` };
};
export const dashboardParameters = (panel: DashboardPanel, window: DashboardWindow) => {
  const params = { ...panel.params };
  for (const name of sqlParameterNames(panel.sql)) {
    if (name === "from") params.from = window.from;
    if (name === "to") params.to = window.to;
    if (name === "bucket") params.bucket = window.bucket;
  }
  return params;
};
/** Presentation-only edits retain a publication; SQL and output changes do not. */
export const dashboardExposure = (definition: DashboardDefinition): string =>
  JSON.stringify(
    definition.panels
      .map(({ id, sql, params, columns, kind, x, series, unit, threshold }) => ({
        id,
        sql,
        params: Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))),
        columns,
        kind,
        x,
        series,
        unit,
        threshold,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
