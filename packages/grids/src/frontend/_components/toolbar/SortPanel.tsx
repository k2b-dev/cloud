import { Button, IconButton, Select } from "@k2b/ui";
import { createMemo, Index } from "solid-js";
import type { PublicField as Field } from "../../../api/public-dto";
import type { RecordMetaSortKey, RecordQuery } from "../../../contracts";
import { fieldChoiceGroupsFor, fieldOption } from "../fields/field-type-meta";

export type SortRow = NonNullable<RecordQuery["sort"]>[number];
type Direction = SortRow["direction"];

/**
 * Strict-controlled input — three props, no apply / dirty / URL logic.
 * The surrounding GridToolbar handles "commit". Use `isSortRowComplete`
 * to validate rows from the outside.
 */
type Props = {
  fields: Field[];
  rows: () => SortRow[];
  onRowsChange: (next: SortRow[]) => void;
};

const SORTABLE_TYPES = new Set(["text", "longtext", "id", "number", "percent", "duration", "date", "boolean"]);

const RECORD_SORTS: Array<{ key: RecordMetaSortKey; label: string; description: string; icon: string }> = [
  { key: "createdAt", label: "Created time", description: "Record metadata", icon: "ti ti-clock-plus" },
  { key: "updatedAt", label: "Modified time", description: "Record metadata", icon: "ti ti-clock-edit" },
  { key: "deletedAt", label: "Deleted time", description: "Record metadata · deleted records", icon: "ti ti-clock-x" },
];

const sortableFields = (fields: Field[]): Field[] => fields.filter((f) => !f.deletedAt && SORTABLE_TYPES.has(f.type));

export const isSortRowComplete = (row: SortRow, fields: Field[]): boolean =>
  row.source === "record"
    ? RECORD_SORTS.some((item) => item.key === row.key)
    : Boolean(row.fieldId && fields.some((f) => f.id === row.fieldId));

/** Build a blank sort row for the first sortable field. */
export const blankSortRow = (fields: Field[]): SortRow | null => {
  const usable = sortableFields(fields);
  const first = usable[0];
  if (!first) return { source: "record", key: "createdAt", direction: "desc" };
  return { fieldId: first.id, direction: "asc" };
};

const targetId = (row: SortRow): string => (row.source === "record" ? `record:${row.key}` : `field:${row.fieldId}`);

const rowFromTarget = (target: string, direction: Direction): SortRow => {
  if (target.startsWith("record:")) {
    return { source: "record", key: target.slice("record:".length) as RecordMetaSortKey, direction };
  }
  return { fieldId: target.slice("field:".length), direction };
};

const isTimeRow = (row: SortRow, fieldsById: Map<string, Field>): boolean =>
  row.source === "record" || fieldsById.get(row.fieldId)?.type === "date";

const isNumericRow = (row: SortRow, fieldsById: Map<string, Field>): boolean =>
  row.source !== "record" && ["number", "percent", "duration"].includes(fieldsById.get(row.fieldId)?.type ?? "");

const directionOptions = (row: SortRow, fieldsById: Map<string, Field>) => {
  if (isTimeRow(row, fieldsById)) {
    return [
      { id: "desc", label: "Newest first", description: "Latest values at the top", icon: "ti ti-sort-descending" },
      { id: "asc", label: "Oldest first", description: "Earliest values at the top", icon: "ti ti-sort-ascending" },
    ];
  }
  if (isNumericRow(row, fieldsById)) {
    return [
      { id: "asc", label: "Low to high", description: "Smallest values first", icon: "ti ti-sort-ascending-numbers" },
      { id: "desc", label: "High to low", description: "Largest values first", icon: "ti ti-sort-descending-numbers" },
    ];
  }
  return [
    { id: "asc", label: "A → Z", description: "Alphabetical order", icon: "ti ti-sort-ascending-letters" },
    { id: "desc", label: "Z → A", description: "Reverse alphabetical order", icon: "ti ti-sort-descending-letters" },
  ];
};

export default function SortPanel(props: Props) {
  const fields = createMemo(() => sortableFields(props.fields));
  const fieldsById = createMemo(() => new Map(props.fields.map((field) => [field.id, field])));
  const sortOptions = createMemo(() => [
    ...fields().map((field) => ({ ...fieldOption(field), id: `field:${field.id}` })),
    ...RECORD_SORTS.map((item) => ({
      id: `record:${item.key}`,
      label: item.label,
      description: item.description,
      icon: item.icon,
      groups: ["system"],
    })),
  ]);

  const updateTarget = (index: number, target: string) => {
    const current = props.rows()[index];
    if (!current) return;
    props.onRowsChange(props.rows().map((row, i) => (i === index ? rowFromTarget(target, row.direction) : row)));
  };

  const updateDirection = (index: number, direction: Direction) => {
    props.onRowsChange(props.rows().map((row, i) => (i === index ? ({ ...row, direction } as SortRow) : row)));
  };

  const addRow = () => {
    const blank = blankSortRow(props.fields);
    if (blank) props.onRowsChange([...props.rows(), blank]);
  };

  const removeRow = (index: number) => props.onRowsChange(props.rows().filter((_, i) => i !== index));

  return (
    <div class="flex flex-col gap-1.5">
      <Index each={props.rows()}>
        {(rowSignal, index) => (
          <div class="flex flex-wrap items-center gap-1.5 text-xs">
            {/* Fixed-width label keeps "sort by" / "then" in the same column. */}
            <span class="w-12 shrink-0 text-dimmed">{index === 0 ? "sort" : "then"}</span>
            <div class="w-64 shrink-0">
              <Select
                aria-label={`Sort ${index + 1} field`}
                value={() => targetId(rowSignal())}
                onValueChange={(v) => {
                  if (v !== null) updateTarget(index, v);
                }}
                options={sortOptions()}
                groups={fieldChoiceGroupsFor(fields(), ["system"])}
                groupsAriaLabel="Filter sort fields"
                placeholder="Sort by"
              />
            </div>
            <div class="w-44 shrink-0">
              <Select
                aria-label={`Sort ${index + 1} direction`}
                value={() => rowSignal().direction}
                onValueChange={(v) => updateDirection(index, v as Direction)}
                options={directionOptions(rowSignal(), fieldsById())}
              />
            </div>
            <IconButton
              variant="ghost"
              size="xs"
              class="text-dimmed hover:text-red-500"
              onClick={() => removeRow(index)}
              label="Remove sort"
            >
              <i class="ti ti-x" />
            </IconButton>
          </div>
        )}
      </Index>

      <div class="flex items-center gap-1">
        <Button variant="success" size="sm" type="button" onClick={addRow}>
          <i class="ti ti-plus" /> Add
        </Button>
      </div>
    </div>
  );
}
