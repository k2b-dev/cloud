import type { DateContext } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { type Column, type OnNavigate, Table } from "@k2b/ui/v2";
import { createMemo } from "solid-js";
import type { PublicField as Field, PublicGridRecord as GridRecord } from "../../../api/public-dto";
import type { ColumnSpec, SortSpec } from "../../../contracts";
import { effectiveDisplayField } from "../../../lookup-display";
import { recordDisplayTitle, recordTitleField } from "../records/record-display";
import { FieldValue } from "../table/FieldValue";
import { fieldDisplayFormat, formatFieldValueText } from "../table/field-value-format";
import { recordsScreenMessages } from "./screen-messages";

type ComputedColumn = Extract<ColumnSpec, { kind: "computed" }>;
const isComputed = (column: ColumnSpec): column is ComputedColumn => "kind" in column && column.kind === "computed";
const columnKey = (column: ColumnSpec) => (isComputed(column) ? column.id : column.fieldId);

/** Widths by what a column holds: single values stay narrow, text takes room; the last column takes the rest. */
const NARROW = new Set(["boolean"]);
const NUMERIC = new Set(["number", "percent", "duration", "rollup"]);
const DATES = new Set(["date", "created_at", "updated_at"]);
const widthOf = (type: string) =>
  NARROW.has(type)
    ? { min: 64, default: 88 }
    : NUMERIC.has(type)
      ? { min: 80, default: 120 }
      : DATES.has(type)
        ? { min: 96, default: 132 }
        : { min: 120, default: 220 };

export type RecordsTableProps = {
  items: GridRecord[];
  fields: Field[];
  baseId: string;
  fieldsByTable: Record<string, Field[]>;
  relationLabels: Record<string, string>;
  /** A saved view's columns: they decide which fields show, their order, labels and formats. */
  viewColumns?: ColumnSpec[];
  /** The record the address has open. */
  selectedRecordId: string | null;
  /** The address that opens a record, and how it opens in place. */
  recordHref: (record: GridRecord) => string;
  onOpenRecord: (record: GridRecord) => void;
  /** The sort of the query: the first entry marks its column. */
  sort?: SortSpec[];
  /** Sorts by a field; absent where the order is fixed (a saved view, the bin). */
  onSort?: (fieldId: string, direction: "asc" | "desc") => void;
  bulkSelection?: {
    selectedIds: ReadonlySet<string>;
    onToggleRecord: (recordId: string, selected: boolean) => void;
    onToggleVisible: (selected: boolean) => void;
  };
  empty?: { icon: string; text: string; action?: { label: string; icon?: string; onClick?: () => void } };
  dateConfig?: DateContext;
};

/**
 * The records of a table or view on v2: one column per shown field, a box column while workflows can run on a
 * selection, the open record tinted, the sort in the column heads, and two lines per record on the phone.
 */
export default function RecordsTable(props: RecordsTableProps) {
  const locale = useLocale();
  const t = () => recordsScreenMessages.resolve([locale()]).t;

  const computedField = (column: ComputedColumn): Field => ({
    id: column.id,
    tableId: props.fields[0]?.tableId ?? "",
    name: column.label,
    description: null,
    icon: "ti ti-calculator",
    type: "formula",
    config: { expression: column.expression },
    position: 0,
    required: false,
    presentable: false,
    hideInTable: false,
    defaultValue: null,
    indexed: false,
    uniqueConstraint: false,
    deletedAt: null,
    createdAt: "",
    updatedAt: "",
  });

  /** The fields that show, in order: a view's columns decide, else every visible field by position. */
  const shown = createMemo((): Array<{ column: ColumnSpec; field: Field }> => {
    if (props.viewColumns) {
      const byId = new Map(props.fields.map((field) => [field.id, field]));
      return props.viewColumns.flatMap((column): Array<{ column: ColumnSpec; field: Field }> => {
        if (isComputed(column)) return [{ column, field: computedField(column) }];
        const field = byId.get(column.fieldId);
        return field && !field.deletedAt ? [{ column, field }] : [];
      });
    }
    return props.fields
      .filter((field) => !field.deletedAt && !field.hideInTable)
      .sort((a, b) => a.position - b.position)
      .map((field) => ({ column: { fieldId: field.id }, field }));
  });

  const formatOf = (column: ColumnSpec, field: Field) => fieldDisplayFormat(field, "format" in column ? column.format : undefined);
  const labelOf = (column: ColumnSpec, field: Field) => ("label" in column ? column.label?.trim() || field.name : field.name);
  const text = (record: GridRecord, field: Field, column: ColumnSpec) =>
    formatFieldValueText({
      field,
      value: record.data[field.id],
      fieldsByTable: props.fieldsByTable,
      relationLabels: props.relationLabels,
      dateConfig: props.dateConfig,
      format: formatOf(column, field),
      locale: locale(),
    });

  /** The first sort by a field, which the column heads show. */
  const fieldSort = () => {
    const first = props.sort?.[0];
    return first && "fieldId" in first ? first : undefined;
  };
  const sorted = () => {
    const first = fieldSort();
    if (!first) return undefined;
    const index = shown().findIndex((entry) => columnKey(entry.column) === first.fieldId);
    return index < 0
      ? undefined
      : { column: index, direction: first.direction === "desc" ? ("descending" as const) : ("ascending" as const) };
  };

  const columns = createMemo((): Column<GridRecord>[] =>
    shown().map(({ column, field }, index) => {
      const display = effectiveDisplayField(field, props.fieldsByTable);
      const numeric = NUMERIC.has(display.type) || ["decimal", "percent"].includes(formatOf(column, field)?.kind ?? "");
      const first = fieldSort();
      const onSort = props.onSort;
      return {
        title: labelOf(column, field),
        width: widthOf(display.type),
        align: numeric ? "end" : "start",
        // the first column names the record; the others leave on the phone, which shows two lines instead
        drop: index > 0,
        cell: (record) => (
          <FieldValue
            field={field}
            value={record.data[field.id]}
            record={record}
            allFields={props.fields}
            baseId={props.baseId}
            fieldsByTable={props.fieldsByTable}
            relationLabels={props.relationLabels}
            dateConfig={props.dateConfig}
            format={formatOf(column, field)}
            mode="table"
            linkLookup
            showBarcodeOpenAction
          />
        ),
        ...(onSort && !isComputed(column)
          ? {
              sort: {
                onSort: () => onSort(field.id, first?.fieldId === field.id && first.direction === "asc" ? "desc" : "asc"),
              },
            }
          : {}),
      };
    }),
  );

  /** The record's name for its box and the phone: the title field, else the short id. */
  const title = (record: GridRecord) =>
    recordDisplayTitle({
      fields: props.fields,
      record,
      fieldsByTable: props.fieldsByTable,
      relationLabels: props.relationLabels,
      dateConfig: props.dateConfig,
      viewColumns: props.viewColumns,
    });
  /** The phone's second line: the next two shown fields with a value. */
  const second = (record: GridRecord) => {
    const titleId = recordTitleField(props.fields)?.id;
    return shown()
      .filter((entry) => entry.field.id !== titleId)
      .map((entry) => text(record, entry.field, entry.column).trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(" · ");
  };

  const open = (record: GridRecord) => {
    const navigate: OnNavigate = () => props.onOpenRecord(record);
    return { href: props.recordHref(record), onNavigate: navigate };
  };

  const bulk = () => props.bulkSelection;
  return (
    <Table
      label={t().records}
      rows={props.items}
      rowKey={(record) => record.id}
      sticky
      current={props.selectedRecordId ?? undefined}
      sort={sorted()}
      columns={columns()}
      open={open}
      empty={props.empty}
      phone={(record) => ({ lines: [title(record), second(record)] })}
      select={
        bulk()
          ? {
              selected: props.items.filter((record) => bulk()?.selectedIds.has(record.id)).map((record) => record.id),
              all: t().allRecords,
              row: title,
              onChange: (keys) => {
                const selection = bulk();
                if (!selection) return;
                const next = new Set(keys);
                if (next.size === props.items.length) return selection.onToggleVisible(true);
                if (next.size === 0) return selection.onToggleVisible(false);
                for (const record of props.items)
                  if (next.has(record.id) !== selection.selectedIds.has(record.id))
                    selection.onToggleRecord(record.id, next.has(record.id));
              },
            }
          : undefined
      }
    />
  );
}
