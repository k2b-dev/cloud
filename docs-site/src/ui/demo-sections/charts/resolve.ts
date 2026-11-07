import {
  type ChartInput,
  chartKinds,
  chartLegend,
  chartMarkKey,
  chartReferenceMark,
  chartRenderOptions,
  chartRows,
  chartTable,
  chartTooltip,
} from "@k2b/editor/charts";
import type { ChartExplorerColumn, ChartLegendEntry, ChartProps, ChartSnapshot } from "@k2b/ui";
import * as ui from "@k2b/ui";
import { prepareChartSnapshot } from "@k2b/ui";
import type { JSX } from "solid-js";
import type { JsonValue } from "./examples/types";

export type ShowcaseRow = { key: string; cells: Record<string, string>; values: Record<string, string | number> };

/** How the showcase draws one portable description. Every path is pure, so the server and the browser agree. */
export type ShowcaseDrawing =
  /** A chart kind of the portable description: prepared geometry, typed rows and the legend. */
  | {
      mode: "snapshot";
      snapshot: ChartSnapshot;
      rows: ShowcaseRow[];
      columns: ChartExplorerColumn<ShowcaseRow>[];
      legend: ChartLegendEntry[];
    }
  /** A kind only the Solid component draws today, from the same JSON props. */
  | { mode: "live"; props: ChartProps; rows: ShowcaseRow[]; columns: ChartExplorerColumn<ShowcaseRow>[] }
  /** A Cloud block: `{ block: … }`. */
  | { mode: "block"; block: string; spec: { [key: string]: JsonValue } }
  /** Not drawable in this build: the kind or one of its options is still missing. */
  | { mode: "slot"; kind: string; reason: string };

type JsonObject = { [key: string]: JsonValue };
const object = (value: JsonValue | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** Kinds that the Solid `Chart` draws but the portable description does not list yet. */
const liveKinds = new Set(["map", "stateTimeline"]);
/**
 * The @k2b/ui component that draws each Cloud block from the same props as its description. A block whose component
 * this build does not export shows its slot, and appears by itself once the component lands.
 */
export const blockComponents: Record<string, string> = { budget: "BudgetList", balance: "BalanceSummary", flow: "FlowAmount" };
const isComponent = (value: unknown): value is (props: Record<string, unknown>) => JSX.Element => typeof value === "function";
export const blockComponent = (block: string) => {
  const name = blockComponents[block];
  const component = name ? Reflect.get(ui, name) : undefined;
  return isComponent(component) ? component : undefined;
};
/** Blocks this site can draw; the other blocks show their slot. */
const drawableBlock = (block: string) => block === "stats" || block === "table" || blockComponent(block) !== undefined;

/** Names of options the schema dropped: a description it does not fully know must not draw as a smaller chart. */
const lostKeys = (source: JsonValue, parsed: unknown, path = ""): string[] => {
  if (Array.isArray(source))
    return Array.isArray(parsed) ? source.flatMap((item, index) => lostKeys(item, parsed[index], `${path}[${index}]`)) : [];
  if (!object(source) || typeof parsed !== "object" || parsed === null) return [];
  const target = parsed as Record<string, unknown>;
  return Object.entries(source).flatMap(([key, value]) =>
    key in target ? lostKeys(value, target[key], path ? `${path}.${key}` : key) : [path ? `${path}.${key}` : key],
  );
};

const columnsOf = (columns: { id: string; label: string; numeric: boolean }[]): ChartExplorerColumn<ShowcaseRow>[] =>
  columns.map((column) => ({
    id: column.id,
    label: column.label,
    value: (row) => row.cells[column.id] ?? "",
    sortValue: (row) => row.values[column.id] ?? null,
    align: column.numeric ? "right" : "left",
  }));

const number = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });

/** Typed rows for the kinds that only the Solid component draws. */
const liveRows = (spec: JsonObject): { columns: ChartExplorerColumn<ShowcaseRow>[]; rows: ShowcaseRow[] } => {
  if (spec.kind === "map") {
    const rows = (Array.isArray(spec.series) ? spec.series : []).flatMap((series, seriesIndex) =>
      object(series) && Array.isArray(series.data)
        ? series.data.filter(object).map((point, index) => ({
            key: `${seriesIndex}-${index}`,
            cells: {
              label: String(point.label ?? ""),
              latitude: `${number.format(Number(point.latitude))}°`,
              longitude: `${number.format(Number(point.longitude))}°`,
              size: point.size === undefined ? "" : number.format(Number(point.size)),
            },
            values: {
              label: String(point.label ?? ""),
              latitude: Number(point.latitude),
              longitude: Number(point.longitude),
              size: Number(point.size ?? 0),
            },
          }))
        : [],
    );
    return {
      columns: columnsOf([
        { id: "label", label: "Place", numeric: false },
        { id: "latitude", label: "Latitude", numeric: true },
        { id: "longitude", label: "Longitude", numeric: true },
        { id: "size", label: "Size", numeric: true },
      ]),
      rows,
    };
  }
  const states = new Map(
    (Array.isArray(spec.states) ? spec.states : [])
      .filter(object)
      .map((state) => [String(state.state), String(state.label ?? state.state)]),
  );
  const rows = (Array.isArray(spec.rows) ? spec.rows : []).flatMap((row, rowIndex) =>
    object(row) && Array.isArray(row.intervals)
      ? row.intervals.filter(object).map((interval, index) => {
          const from = Number(interval.from),
            to = Number(interval.to);
          const state = states.get(String(interval.state)) ?? String(interval.state);
          return {
            key: `${rowIndex}-${index}`,
            cells: {
              row: String(row.label),
              state,
              from: number.format(from),
              to: number.format(to),
              duration: number.format(to - from),
              detail: String(interval.tooltip ?? ""),
            },
            values: { row: String(row.label), state, from, to, duration: to - from, detail: String(interval.tooltip ?? "") },
          };
        })
      : [],
  );
  return {
    columns: columnsOf([
      { id: "row", label: "Row", numeric: false },
      { id: "state", label: "State", numeric: false },
      { id: "from", label: "From", numeric: true },
      { id: "to", label: "To", numeric: true },
      { id: "duration", label: "Duration", numeric: true },
      { id: "detail", label: "Detail", numeric: false },
    ]),
    rows,
  };
};

/** Draws a portable description the way Chat and Notebooks draw it: one parse, one renderer, one table. */
export function resolveDrawing(spec: JsonValue, locale = "en"): ShowcaseDrawing {
  // A list of amounts with a direction, `[{ type: "flow", value, currency }]`, is the flow block.
  if (Array.isArray(spec) && spec.length && spec.every((entry) => object(entry) && entry.type === "flow"))
    return blockComponent("flow")
      ? { mode: "block", block: "flow", spec: { block: "flow", items: spec } }
      : { mode: "slot", kind: "flow", reason: "This block arrives with its catalog step." };
  if (!object(spec)) return { mode: "slot", kind: "unknown", reason: "The description is not an object." };
  if (typeof spec.block === "string")
    return drawableBlock(spec.block)
      ? { mode: "block", block: spec.block, spec }
      : { mode: "slot", kind: spec.block, reason: "This block arrives with its catalog step." };
  const kind = typeof spec.kind === "string" ? spec.kind : "unknown";
  if (liveKinds.has(kind)) {
    const { title: _title, subtitle: _subtitle, ...props } = spec;
    return { mode: "live", props: props as unknown as ChartProps, ...liveRows(spec) };
  }
  const parsed = chartKinds().safeParse(spec);
  if (!parsed.success) {
    // The kind exists when the schema complains about fields rather than about the kind itself.
    const known = !parsed.error.issues.some((issue) => issue.path.length === 0 || issue.path[0] === "kind");
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0]).filter((key): key is string => typeof key === "string"))];
    return {
      mode: "slot",
      kind,
      reason: known
        ? `Its options ${fields.length ? fields.join(", ") : "in this form"} arrive with their catalog step.`
        : "The kind arrives with its catalog step.",
    };
  }
  const lost = lostKeys(spec, parsed.data);
  if (lost.length) return { mode: "slot", kind, reason: `Its options ${lost.join(", ")} arrive with their catalog step.` };
  const input: ChartInput = parsed.data;
  if (input.kind === "balanceFlow") {
    const drawing = chartRenderOptions(input, locale);
    if (drawing.kind !== "balanceFlow") throw new Error("Expected a balance flow drawing");
    const table = chartTable(input, locale);
    return {
      mode: "live",
      props: { ...drawing, title: input.title, subtitle: input.subtitle },
      rows: table.rows,
      columns: columnsOf(table.columns),
    };
  }
  const table = chartRows(input, locale);
  const snapshot = prepareChartSnapshot(chartRenderOptions(input, locale, { legend: "outside" }), {
    key: ({ datum }) => chartMarkKey(datum),
    // Add the row first: it may introduce the columns its own tooltip names.
    tooltip: ({ datum }) => {
      const row = table.add(datum);
      return chartTooltip(table.columns(), row);
    },
    reference: ({ datum }) => chartReferenceMark(input, datum),
  });
  const { columns, rows } = table.table();
  return { mode: "snapshot", snapshot, rows, columns: columnsOf(columns), legend: chartLegend(input, locale) };
}

export const specTitle = (spec: JsonValue, fallback: string) => (object(spec) && typeof spec.title === "string" ? spec.title : fallback);
export const specSubtitle = (spec: JsonValue, fallback?: string) =>
  object(spec) && typeof spec.subtitle === "string" ? spec.subtitle : fallback;
