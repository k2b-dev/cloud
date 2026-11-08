import type { DescriptionJson } from "../descriptions";
import { blockDataAtPath } from "./bind";
import type { Block, CodePageNode } from "./schema";

/** A data block's content height: small 200 px, medium 300 px, large 400 px; panels in one row line up when they share one. */
export const BLOCK_PANEL_HEIGHTS = { sm: 200, md: 300, lg: 400 } as const;

type Chart = Extract<CodePageNode | Block, { kind: "Chart" }>;
type Stats = Extract<CodePageNode | Block, { kind: "Stats" }>;
type Table = Extract<CodePageNode | Block, { kind: "Table" }>;
type PageDetail = Extract<CodePageNode, { kind: "Detail" }>;

export const blockChartHeight = (item: Chart): number => {
  if (item.height) return BLOCK_PANEL_HEIGHTS[item.height];
  // Single values and trends need less room than a plot with axes, as in chat charts.
  const kind = item.description?.kind;
  return kind === "sparkline" ? 128 : kind === "stat" ? 160 : kind === "barGauge" ? 192 : BLOCK_PANEL_HEIGHTS.md;
};

/** Checked block data as JSON: optional fields that are absent leave no key behind. */
export const blockJson = (value: unknown): DescriptionJson => {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(blockJson);
  if (typeof value === "object")
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => (entry === undefined ? [] : [[key, blockJson(entry)]])));
  return null;
};

/** One table cell: a column names a key of a page row or a path into a bound row. */
const cell = (row: unknown, column: { key?: string; path?: readonly string[] }): unknown =>
  column.path ? blockDataAtPath(row, column.path) : column.key !== undefined ? blockDataAtPath(row, [column.key]) : undefined;
const scalar = (value: unknown) =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : value === undefined
      ? null
      : JSON.stringify(value);

/**
 * The portable description of a data block, the same JSON Chat, Pulse, Notebooks and Code pages draw: blocks add no
 * drawing of their own. Yes and No are words of the reader's language; dates read in the reader's zone.
 */
export function blockDescription(item: Chart | Stats | Table | PageDetail, words: { yes: string; no: string }, timeZone: string) {
  switch (item.kind) {
    case "Chart":
      // Without values a chart keeps its frame and title and says why: the description's empty form.
      return item.description ?? { kind: "bar", title: item.title ?? "", empty: item.empty };
    case "Stats":
      return { block: "stats", items: item.items.map(({ value, ...stat }) => ({ ...stat, value: value ?? "—" })) };
    case "Table": {
      const columns = item.columns.map((column, index) => ({ ...column, id: "key" in column && column.key ? column.key : `c${index}` }));
      const rows = (item.rows as readonly unknown[]).map((row) =>
        Object.fromEntries(columns.map((column) => [column.id, scalar(cell(row, column))])),
      );
      return {
        block: "table",
        title: item.title,
        ...(item.subtitle ? { subtitle: item.subtitle } : {}),
        ...(item.search ? { search: true } : {}),
        columns: columns.map(({ key: _key, path: _path, ...column }: (typeof columns)[number] & { path?: unknown }) => {
          // A column without a type that holds only numbers reads as numbers: right-aligned, in the reader's language.
          const values = rows.map((row) => row[column.id]).filter((value) => value !== null && value !== undefined);
          const numeric = column.format !== undefined || (values.length > 0 && values.every((value) => typeof value === "number"));
          const type = column.type === "datetime" ? "date" : (column.type ?? (numeric ? "number" : undefined));
          return { ...column, ...(type ? { type } : {}), ...(type === "date" ? { timeZone } : {}) };
        }),
        rows,
      };
    }
    case "Detail":
      return {
        block: "details",
        title: item.title,
        items: item.items.map((row) =>
          typeof row.value === "number"
            ? { label: row.label, type: "number", value: row.value, ...(row.format ? { format: row.format } : {}) }
            : { label: row.label, type: "text", value: typeof row.value === "boolean" ? (row.value ? words.yes : words.no) : row.value },
        ),
      };
  }
}
