import type { DateContext } from "@k2b/stdlib";
import { Checkbox, DataTable, type DataTableColumn, IconButton, Placeholder, Tooltip, useLocale } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import type { PublicField as Field, PublicGridRecord as GridRecord } from "../../../api/public-dto";
import type { AggregationSpec, ColumnSpec } from "../../../contracts";
import { effectiveDisplayField } from "../../../lookup-display";
import { fieldTypeIcon, fieldTypeLabel } from "../fields/field-type-meta";
import { FieldValue } from "./FieldValue";
import { fieldDisplayFormat, formatFieldValueText } from "./field-value-format";
import { tableMessages } from "./messages";

/**
 * DatabaseTable — minimal, presentational records table.
 *
 * Designed as a "dumb" component: it renders whatever rows the caller
 * gives it, and emits row clicks. No toolbar, no filter UI, no
 * sort headers, no add/edit/delete affordances, no detail-panel
 * mounting, no pagination controls. All of those belong to the
 * surrounding screen and are wired up there.
 *
 * This is the canonical records table renderer for Grids. It is kept
 * presentational so records pages, App blocks, and view pages
 * can share relation links, formatting, and aggregate footers without
 * dragging in page-specific toolbar or detail-panel state.
 *
 * Field values are rendered through `FieldValue`, including relation
 * labels from each record's pre-fetched `expanded` map. Zero render-time
 * DB calls — the batched-once `attachRelationExpansion` pass on the
 * server is the only roundtrip cost.
 */
type Props = {
  /** The list-call response. Items + schema + cursor in one prop. */
  result: { items: GridRecord[]; fields: Field[]; nextCursor: string | null };
  /** Parent base id — required for `<RecordLink>` hrefs. */
  baseId: string;
  /** Optional table UUID -> short id map so relation links use path routes. */
  /** Optional field catalog for resolving lookup target display types. */
  fieldsByTable?: Record<string, Field[]>;
  /**
   * Row click handler. Omit to render rows as non-interactive
   * (cursor stays default, no hover state). The records page passes
   * a handler that opens the detail panel; embedded surfaces pass a
   * handler that navigates to the records page with the row selected.
   */
  onRecordClick?: (record: GridRecord) => void;
  /** Highlighted row id — purely visual. */
  selectedId?: string | null;
  /** Short-lived live-refresh glow row ids — purely visual. */
  highlightedIds?: ReadonlySet<string>;
  /**
   * Optional saved-view column override. When set, dictates BOTH the
   * visible field set AND their order (instead of the default
   * `!hideInTable` + `position` rule). Per-column `format` lives here
   * too; used by date / number / currency / percent renderers to
   * pick up the view's saved style.
   */
  viewColumns?: ColumnSpec[];
  /** Hide the field-type subtitle in compact embedded surfaces. */
  showColumnSubtitles?: boolean;
  /**
   * Pre-resolved aggregate values keyed `<fieldId>__<agg>`. Drives a
   * footer row when paired with `aggregationSpecs`. Omit both to skip
   * the footer entirely (embedded records blocks do this).
   */
  aggregates?: Record<string, unknown>;
  /**
   * Aggregation specs that produced `aggregates`. Footer renders one
   * entry per spec under its target field's column (`*` specs land
   * under the leftmost visible field, Airtable-style).
   */
  aggregationSpecs?: AggregationSpec[];
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  scrollPreserveKey?: string;
  dateConfig?: DateContext;
  class?: string;
  adminMode?: boolean;
  onFieldSettings?: (field: Field) => void;
  onFieldMove?: (field: Field, direction: -1 | 1) => void;
  onViewColumnSettings?: (column: ColumnSpec, field: Field | null) => void;
  onViewColumnMove?: (column: ColumnSpec, direction: -1 | 1) => void;
  bulkSelection?: {
    selectedIds: ReadonlySet<string>;
    onToggleRecord: (recordId: string, selected: boolean) => void;
    onToggleVisible: (selected: boolean) => void;
  };
};

const isComputedColumn = (column: ColumnSpec): column is Extract<ColumnSpec, { kind: "computed" }> =>
  "kind" in column && column.kind === "computed";

const columnId = (column: ColumnSpec): string => (isComputedColumn(column) ? column.id : column.fieldId);

const BULK_SELECTION_COLUMN_ID = "__bulk_selection";

const SelectionCheckbox = (props: { checked: boolean; indeterminate?: boolean; label: string; onChange: (checked: boolean) => void }) => {
  return <Checkbox value={props.checked} indeterminate={props.indeterminate} aria-label={props.label} onValueChange={props.onChange} />;
};

export default function DatabaseTable(props: Props) {
  const locale = useLocale();
  const t = () => tableMessages.resolve([locale()]).t;
  /** Fields that actually render. When the caller passes `viewColumns`,
   *  it dictates BOTH visibility and order. Otherwise we fall back to
   *  the table-level default: every non-deleted, non-`hideInTable`
   *  field in `position` order — same rule the records page uses. */
  const computedField = (column: Extract<ColumnSpec, { kind: "computed" }>): Field => ({
    id: column.id,
    tableId: props.result.fields[0]?.tableId ?? "",
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

  const visibleColumns = (): Array<{ column: ColumnSpec; field: Field }> => {
    if (props.viewColumns) {
      const fieldsById = new Map(props.result.fields.map((f) => [f.id, f]));
      const entries: Array<{ column: ColumnSpec; field: Field }> = [];
      for (const column of props.viewColumns) {
        if (isComputedColumn(column)) {
          entries.push({ column, field: computedField(column) });
          continue;
        }
        const field = fieldsById.get(column.fieldId);
        if (field && !field.deletedAt) entries.push({ column, field });
      }
      return entries;
    }
    return props.result.fields
      .filter((field) => !field.deletedAt && !field.hideInTable)
      .sort((a, b) => a.position - b.position)
      .map((field) => ({ column: { fieldId: field.id }, field }));
  };

  const visibleFields = (): Field[] => visibleColumns().map((entry) => entry.field);

  /** Look up a per-column FormatSpec from the active viewColumns, if
   *  any. Drives date / number / currency / percent rendering. */
  const columnFormat = (fieldId: string) => {
    if (!props.viewColumns) return undefined;
    const col = props.viewColumns.find((c) => columnId(c) === fieldId);
    return col && "format" in col ? col.format : undefined;
  };

  const displayFormat = (field: Field) => fieldDisplayFormat(field, columnFormat(field.id));

  const columnLabel = (fieldId: string, fallback: string) => {
    if (!props.viewColumns) return fallback;
    const column = props.viewColumns.find((c) => columnId(c) === fieldId);
    return column && "label" in column ? column.label?.trim() || fallback : fallback;
  };

  const renderCell = (record: GridRecord, field: Field) => (
    <FieldValue
      field={field}
      value={record.data[field.id]}
      record={record}
      allFields={props.result.fields}
      baseId={props.baseId}
      fieldsByTable={props.fieldsByTable}
      dateConfig={props.dateConfig}
      format={displayFormat(field)}
      mode="table"
      linkLookup
      showBarcodeOpenAction
    />
  );

  const headerLabel = (field: Field, computed: boolean) => (
    <span class={`inline-flex min-w-0 items-center gap-1.5 ${computed ? "app-accent-text" : ""}`}>
      <i class={`${fieldTypeIcon(field.type, field.icon)} shrink-0 text-[13px] ${computed ? "" : "text-dimmed"}`} />
      <span class="truncate">{columnLabel(field.id, field.name)}</span>
    </span>
  );

  const visibleRecordIds = () => props.result.items.map((record) => record.id);
  const selectedVisibleCount = () => visibleRecordIds().filter((id) => props.bulkSelection?.selectedIds.has(id)).length;
  const allVisibleSelected = () => visibleRecordIds().length > 0 && selectedVisibleCount() === visibleRecordIds().length;
  const someVisibleSelected = () => selectedVisibleCount() > 0 && !allVisibleSelected();

  const selectionColumn = (): DataTableColumn<GridRecord> | null =>
    props.bulkSelection
      ? {
          id: BULK_SELECTION_COLUMN_ID,
          header: (
            <SelectionCheckbox
              checked={allVisibleSelected()}
              indeterminate={someVisibleSelected()}
              label={allVisibleSelected() ? t().clearVisible : t().selectVisible}
              onChange={props.bulkSelection.onToggleVisible}
            />
          ),
          value: (record) => record.id,
          class: "w-10 min-w-10 max-w-10",
          headerClass: "w-10 min-w-10 max-w-10",
          cellClass: "w-10 min-w-10 max-w-10",
        }
      : null;

  const dataColumns = (): DataTableColumn<GridRecord>[] =>
    visibleColumns().map(({ column, field }) => {
      const computed = isComputedColumn(column);
      return {
        id: field.id,
        header: headerLabel(field, computed),
        subtitle:
          props.showColumnSubtitles === false ? undefined : computed ? t().computed : fieldTypeLabel(field.type, locale()).toLowerCase(),
        value: (record) => record.data[field.id],
        headerClass: computed ? "bg-[var(--ui-selected)]" : undefined,
      };
    });

  const columns = (): DataTableColumn<GridRecord>[] => {
    const selection = selectionColumn();
    return selection ? [selection, ...dataColumns()] : dataColumns();
  };

  const shellClass = () => props.class;

  const renderAdminHeader = (field: Field, subtitle: JSX.Element | undefined, computed: boolean) => (
    <div class="flex flex-col gap-0.5 leading-tight">
      <span class={computed ? "app-accent-text font-semibold" : "font-semibold text-primary"}>{headerLabel(field, computed)}</span>
      <Show when={subtitle !== undefined}>
        <span class={computed ? "app-accent-text text-[10px] font-normal opacity-80" : "text-[10px] font-normal text-dimmed"}>
          {subtitle}
        </span>
      </Show>
    </div>
  );

  const footerCell = (field: Field) => {
    const displayField = effectiveDisplayField(field, props.fieldsByTable);
    const index = visibleFields().findIndex((f) => f.id === field.id);
    return (
      <For each={(props.aggregationSpecs ?? []).filter((s) => (s.fieldId === "*" ? index === 0 : s.fieldId === field.id))}>
        {(spec) => {
          const value = () => (props.aggregates ?? {})[`${spec.fieldId}__${spec.agg}`];
          const displayValue = () =>
            spec.fieldId === "*"
              ? String(value())
              : formatFieldValueText({
                  field: displayField,
                  value: value(),
                  fieldsByTable: props.fieldsByTable,
                  dateConfig: props.dateConfig,
                  format: displayFormat(field),
                  locale: locale(),
                });
          const fallbackLabel =
            {
              count: t().values,
              countEmpty: t().empty,
              countUnique: t().unique,
              sum: t().sum,
              avg: t().average,
              min: t().minimum,
              max: t().maximum,
              median: t().median,
              earliest: t().earliest,
              latest: t().latest,
            }[spec.agg] ?? spec.agg;
          const label = spec.label?.trim() || fallbackLabel;
          return (
            <Show when={value() !== undefined && value() !== null}>
              <Tooltip.Anchor content={`${spec.agg}${spec.label ? ` (${spec.label})` : ""}`}>
                <span class="block whitespace-nowrap">
                  <span class="font-medium text-secondary">{displayValue()}</span> <span>{label}</span>
                </span>
              </Tooltip.Anchor>
            </Show>
          );
        }}
      </For>
    );
  };

  return (
    <Show when={visibleFields().length > 0} fallback={<Placeholder surface="paper" description={<>{t().noVisibleFields}</>} />}>
      <DataTable
        ariaLabel={t().records}
        rows={props.result.items}
        columns={columns()}
        class={shellClass()}
        scrollPreserveKey={props.scrollPreserveKey}
        getRowId={(record) => record.id}
        selectedRowId={props.selectedId}
        onRowClick={props.onRecordClick}
        rowClass={(record) =>
          props.highlightedIds?.has(record.id)
            ? "font-medium outline outline-1 -outline-offset-1 outline-[var(--ui-border-strong)]"
            : undefined
        }
        empty={t().noRecords}
        hasMore={props.hasMore}
        loadingMore={props.loadingMore}
        onLoadMore={props.onLoadMore}
        cellContentClass="max-h-28 max-w-full overflow-auto pr-1"
        fillHeight
        renderCell={({ row, col }) => {
          if (col.id === BULK_SELECTION_COLUMN_ID && props.bulkSelection) {
            return (
              <SelectionCheckbox
                checked={props.bulkSelection.selectedIds.has(row.id)}
                label={t().selectRecord({ id: row.id })}
                onChange={(selected) => props.bulkSelection?.onToggleRecord(row.id, selected)}
              />
            );
          }
          const field = visibleFields().find((f) => f.id === col.id);
          return field ? renderCell(row, field) : "";
        }}
        renderHeader={({ col, render }) => {
          if (col.id === BULK_SELECTION_COLUMN_ID) return render();
          const entry = visibleColumns().find((item) => item.field.id === col.id);
          const field = entry?.field;
          const computed = entry ? isComputedColumn(entry.column) : false;
          const subtitle = typeof col.subtitle === "function" ? undefined : col.subtitle;
          const isColumnOrderEdit = !!props.viewColumns && !!props.onViewColumnMove;
          const isViewColumnEdit = !!props.onViewColumnSettings;
          const isFieldEdit = !!props.onFieldSettings;
          if (!props.adminMode || !field || (!isColumnOrderEdit && !isViewColumnEdit && !isFieldEdit)) return render();
          const index = visibleFields().findIndex((f) => f.id === field.id);
          const canMoveLeft = index > 0 && (isColumnOrderEdit || (!!props.onFieldMove && !props.viewColumns));
          const canMoveRight =
            index >= 0 && index < visibleFields().length - 1 && (isColumnOrderEdit || (!!props.onFieldMove && !props.viewColumns));
          return (
            <div class="flex min-w-0 items-start gap-2">
              <div class="min-w-0 flex-1">{renderAdminHeader(field, subtitle, computed)}</div>
              <div class="flex shrink-0 items-center gap-0">
                <Tooltip.Anchor content={t().moveColumnLeft}>
                  <IconButton
                    label={t().moveLeft({ name: field.name })}
                    size="xs"
                    class="app-accent-text h-6 w-6 shrink-0 hover:opacity-75"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (isColumnOrderEdit && entry) props.onViewColumnMove?.(entry.column, -1);
                      else props.onFieldMove?.(field, -1);
                    }}
                    disabled={!canMoveLeft}
                  >
                    <i class="ti ti-chevron-left text-xs" />
                  </IconButton>
                </Tooltip.Anchor>
                <Tooltip.Anchor content={t().moveColumnRight}>
                  <IconButton
                    label={t().moveRight({ name: field.name })}
                    size="xs"
                    class="app-accent-text h-6 w-6 shrink-0 hover:opacity-75"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (isColumnOrderEdit && entry) props.onViewColumnMove?.(entry.column, 1);
                      else props.onFieldMove?.(field, 1);
                    }}
                    disabled={!canMoveRight}
                  >
                    <i class="ti ti-chevron-right text-xs" />
                  </IconButton>
                </Tooltip.Anchor>
                <Tooltip.Anchor content={isViewColumnEdit ? t().columnSettings : t().fieldSettings}>
                  <IconButton
                    label={t().settingsFor({ kind: isViewColumnEdit ? t().columnSettings : t().fieldSettings, name: field.name })}
                    size="xs"
                    class="app-accent-text h-6 w-6 shrink-0 hover:opacity-75"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (isViewColumnEdit && entry)
                        props.onViewColumnSettings?.(entry.column, isComputedColumn(entry.column) ? null : field);
                      else props.onFieldSettings?.(field);
                    }}
                  >
                    <i class="ti ti-settings text-xs" />
                  </IconButton>
                </Tooltip.Anchor>
              </div>
            </div>
          );
        }}
        footer={
          (props.aggregationSpecs ?? []).length > 0
            ? {
                renderCell: ({ col }) => {
                  const field = visibleFields().find((f) => f.id === col.id);
                  return field ? footerCell(field) : "";
                },
              }
            : undefined
        }
      />
    </Show>
  );
}
