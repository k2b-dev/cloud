import type { DataTableColumn } from "@k2b/ui";
import type { DescriptionJson as JsonValue } from "./json";

/**
 * The plain parts of a description table: its rows and typed columns. Light enough to draw a table's frame and the
 * room its rows take before the table's search, grouping and sorting code arrives.
 */

export type DescriptionObject = { [key: string]: JsonValue };
export const descriptionObject = (value: JsonValue | undefined): value is DescriptionObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const descriptionList = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);
export const descriptionText = (value: JsonValue | undefined) =>
  typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);

export type DescriptionTableRow = { key: string; cells: DescriptionObject };

/** Column fields the typed table reads. */
const typedColumnKeys = ["type", "format", "states", "max", "priority", "delta", "timeZone"] as const;

/** Table columns from a description: types, formats, states and priorities pass as they are to the typed table. */
export const descriptionTableColumns = (columns: DescriptionObject[]): DataTableColumn<DescriptionTableRow>[] =>
  columns.map((column) =>
    Object.assign(
      {
        id: descriptionText(column.id),
        header: descriptionText(column.label),
        value: (row: DescriptionTableRow) => row.cells[descriptionText(column.id)] ?? null,
        sortable: true,
        align: ["number", "amount", "bar", "flow", "delta"].includes(descriptionText(column.type)) ? ("right" as const) : ("left" as const),
      },
      Object.fromEntries(typedColumnKeys.filter((key) => key in column).map((key) => [key, column[key]])),
    ),
  );

/** A description table's columns and rows as the typed table reads them. */
export const descriptionTable = (spec: DescriptionObject) => ({
  columns: descriptionTableColumns(descriptionList(spec.columns).filter(descriptionObject)),
  rows: descriptionList(spec.rows)
    .filter(descriptionObject)
    .map((cells, index): DescriptionTableRow => ({ key: String(index), cells })),
});
