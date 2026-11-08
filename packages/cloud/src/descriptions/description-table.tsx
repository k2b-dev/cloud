import { ButtonLink, type DataTableColumn, type DataTableRenderCell } from "@k2b/ui";
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

/** Where each row leads, by row position, with Cloud's words for the column and its links. */
export type DescriptionRowLinks = { hrefs: readonly (string | undefined)[]; header: string; label: string };

const ROW_LINK_COLUMN = "__open";

/**
 * A description table's columns and rows as the typed table reads them. With row links a last column holds each row's
 * Open link; the link opens a new tab only for an address outside Cloud.
 */
export const descriptionTable = (spec: DescriptionObject, links?: DescriptionRowLinks) => {
  const columns = descriptionTableColumns(descriptionList(spec.columns).filter(descriptionObject));
  const linked = links?.hrefs.some(Boolean) ? links : undefined;
  const renderCell: DataTableRenderCell<DescriptionTableRow> = ({ row, col, value, render }) => {
    if (col.id !== ROW_LINK_COLUMN) return render(value);
    const href = linked?.hrefs[Number(row.key)];
    const external = href?.startsWith("https://");
    return href ? (
      <ButtonLink
        href={href}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
        variant="ghost"
        size="xs"
      >
        {linked?.label}
      </ButtonLink>
    ) : null;
  };
  return {
    columns: linked ? [...columns, { id: ROW_LINK_COLUMN, header: linked.header, sortable: false, value: () => null }] : columns,
    rows: descriptionList(spec.rows)
      .filter(descriptionObject)
      .map((cells, index): DescriptionTableRow => ({ key: String(index), cells })),
    ...(linked ? { renderCell } : {}),
  };
};
