import type { ObjectListColumn } from "../../../field-types/object-list";

/** Long editors stay in the entry dialog even on a wide screen. */
export const objectListInlineColumn = (column: ObjectListColumn) =>
  !(column.detailsOnly && (column.formula || !column.required)) &&
  (Boolean(column.formula) || (column.type !== "longtext" && !(column.type === "select" && column.config.multiple)));

/** Control-sized budgets, including table padding; not a device breakpoint. */
export const objectListColumnWidth = (column: ObjectListColumn) => {
  if (column.type === "boolean") return 64;
  if (column.type === "date") return column.config.includeTime ? 240 : 184;
  if (column.type === "text" || column.type === "longtext") return column.width === "compact" ? 144 : 192;
  return 112;
};

export const objectListInlineWidth = (columns: ObjectListColumn[]) =>
  // Reserve both row actions (80px) and the table frame (2px).
  columns.length ? columns.reduce((width, column) => width + objectListColumnWidth(column), 82) : Infinity;
