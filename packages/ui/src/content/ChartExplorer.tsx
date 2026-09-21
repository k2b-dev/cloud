import { createEffect, createMemo, createSignal, createUniqueId, type JSX, Show } from "solid-js";
import { Button } from "../actions/Button";
import { CopyButton } from "../actions/CopyButton";
import { SelectChip } from "../inputs/SelectChip";
import { useLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import { DescriptionList } from "../surfaces/DescriptionList";
import { Paper } from "../surfaces/Paper";
import { ChartSnapshotView } from "./ChartSnapshotView";
import type { ChartCursor } from "./chart-cursor";
import { type ChartExplorerData, type ChartExplorerRow, validateChartExplorerData } from "./chart-explorer";
import DataTable, { type DataTableSort } from "./DataTable";

export type ChartExplorerColumn<T> = {
  id: string;
  label: string;
  value: (row: T) => string;
  /** Optional table cell presentation; value remains the plain text used for copy/details. */
  render?: (row: T) => JSX.Element;
  /** Explicit comparable value. Omit to leave the column unsortable. */
  sortValue?: (row: T) => string | number | null;
  align?: "left" | "center" | "right";
};
export type ChartExplorerProps<T extends ChartExplorerRow> = {
  cursor?: ChartCursor;
  title: string;
  description?: JSX.Element;
  data: ChartExplorerData<T>;
  columns: readonly ChartExplorerColumn<T>[];
  view?: "chart" | "table";
  defaultView?: "chart" | "table";
  onViewChange?: (view: "chart" | "table") => void;
  sort?: DataTableSort | null;
  defaultSort?: DataTableSort | null;
  onSortChange?: (sort: DataTableSort | null) => void;
  selectedKey?: string | null;
  onSelectedKeyChange?: (key: string | null) => void;
  /** false hides the complete local detail area for a shared selection panel. */
  renderDetails?: false | ((row: T) => JSX.Element);
  height?: string;
  class?: string;
};

const tsvCell = (value: string) => (/[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

export function ChartExplorer<T extends ChartExplorerRow>(props: ChartExplorerProps<T>) {
  const messages = useUiMessages();
  const locale = useLocale();
  const id = `k2b-chart-explorer-${createUniqueId()}`;
  const data = () => props.data;
  const [copyFailed, setCopyFailed] = createSignal(false);
  const [localSelection, setLocalSelection] = createSignal<string | null>(null);
  const [localView, setLocalView] = createSignal(props.defaultView ?? "chart");
  const [localSort, setLocalSort] = createSignal<DataTableSort | null>(props.defaultSort ?? null);
  const view = () => props.view ?? localView();
  const sort = () => (props.sort === undefined ? localSort() : props.sort);
  const setView = (value: "chart" | "table") => {
    if (props.view === undefined) setLocalView(value);
    props.onViewChange?.(value);
  };
  const setSort = (value: DataTableSort | null) => {
    if (props.sort === undefined) setLocalSort(value);
    props.onSortChange?.(value);
  };
  const rowsByKey = createMemo(() => new Map(data().rows.map((row) => [row.key, row])));
  const rawSelected = () => (props.selectedKey !== undefined ? props.selectedKey : localSelection());
  const selected = () => (rowsByKey().has(rawSelected() ?? "") ? rawSelected() : null);
  const selectedRow = () => rowsByKey().get(selected() ?? "");
  const select = (key: string | null) => {
    if (key !== null && !rowsByKey().has(key)) return;
    setLocalSelection(key);
    props.onSelectedKeyChange?.(key);
  };
  if (
    !props.columns.length ||
    props.columns.some((column) => !column.id) ||
    new Set(props.columns.map((column) => column.id)).size !== props.columns.length
  ) {
    throw new Error("Chart columns require unique nonempty IDs and at least one column");
  }
  validateChartExplorerData(data());
  createEffect(() => validateChartExplorerData(data()));
  createEffect(() => {
    if (props.selectedKey === undefined && rawSelected() !== null && selected() === null) select(null);
  });
  const rows = createMemo(() => {
    const result = [...data().rows];
    const order = sort();
    const column = props.columns.find((c) => c.id === order?.key);
    const value = column?.sortValue;
    if (!order || !value) return result;
    const collator = new Intl.Collator(locale(), { numeric: true });
    return result.sort((a, b) => {
      const av = value(a),
        bv = value(b);
      if (av === null) return bv === null ? 0 : 1;
      if (bv === null) return -1;
      const comparison = typeof av === "number" && typeof bv === "number" ? av - bv : collator.compare(String(av), String(bv));
      return order.direction === "asc" ? comparison : -comparison;
    });
  });
  const copyText = () =>
    [
      props.columns.map((c) => tsvCell(c.label)).join("\t"),
      ...rows().map((row) => props.columns.map((c) => tsvCell(c.value(row))).join("\t")),
    ].join("\n");
  return (
    <section class={`k2b-chart-explorer ${props.class ?? ""}`} aria-labelledby={id}>
      <header class="k2b-chart-explorer__header">
        <div>
          <h3 id={id}>{props.title}</h3>
          <Show when={props.description}>
            <div>{props.description}</div>
          </Show>
        </div>
        <div class="k2b-chart-explorer__actions">
          <CopyButton
            text={copyText()}
            label={messages().chartCopyData}
            iconOnly
            size="sm"
            variant="ghost"
            disabled={!rows().length}
            onCopyError={() => setCopyFailed(true)}
            onCopied={() => setCopyFailed(false)}
          />
          <SelectChip<"chart" | "table">
            value={view()}
            onValueChange={setView}
            aria-label={messages().chartView}
            options={[
              { value: "chart", label: messages().chartDiagram },
              { value: "table", label: messages().chartData },
            ]}
          />
        </div>
      </header>
      <Show when={copyFailed()}>
        <span role="alert">{messages().chartCopyFailed}</span>
      </Show>
      <div class="k2b-chart-explorer__viewport" style={{ height: props.height ?? "18rem" }}>
        <Show when={data().rows.length > 0} fallback={<div class="k2b-chart__empty">{messages().noData}</div>}>
          <Show
            when={view() === "chart"}
            fallback={
              <DataTable
                rows={rows()}
                columns={props.columns.map((column) => ({
                  id: column.id,
                  header: column.label,
                  value: column.value,
                  align: column.align,
                  sortable: Boolean(column.sortValue),
                }))}
                ariaLabelledBy={id}
                getRowId={(row) => row.key}
                selectedRowId={selected()}
                sort={sort()}
                fillHeight
                surface="paper"
                onRowClick={(row) => select(row.key)}
                renderCell={({ row, col, value, render }) => {
                  const custom = props.columns.find((column) => column.id === col.id)?.render;
                  const cell = () => (custom ? custom(row) : render(value));
                  return col.id === props.columns[0]?.id ? (
                    <Button variant="text" size="sm" onClick={() => select(row.key)}>
                      {cell()}
                    </Button>
                  ) : (
                    cell()
                  );
                }}
                renderHeader={({ col, render }) =>
                  col.sortable ? (
                    <Button
                      variant="text"
                      size="sm"
                      onClick={() =>
                        setSort({
                          key: col.id,
                          direction: sort()?.key === col.id && sort()?.direction === "asc" ? "desc" : "asc",
                        })
                      }
                    >
                      {props.columns.find((column) => column.id === col.id)?.label}{" "}
                      <span class="k2b-chart-explorer__sort-icon" aria-hidden="true">
                        {sort()?.key === col.id ? (sort()?.direction === "asc" ? "↑" : "↓") : "↕"}
                      </span>
                    </Button>
                  ) : (
                    render()
                  )
                }
              />
            }
          >
            <ChartSnapshotView
              cursor={props.cursor}
              snapshot={data().chart}
              selectedKey={selected()}
              onSelect={select}
              style={{ height: "100%" }}
            />
          </Show>
        </Show>
      </div>
      <Show when={props.renderDetails !== false}>
        <div class="k2b-chart-explorer__details" aria-live="polite">
          <Show when={selectedRow()}>
            {(row) => (
              <Paper class="k2b-chart-explorer__detail-paper">
                <div class="k2b-chart-explorer__detail-header">
                  <span>{messages().chartSelectedDatum}</span>
                  <Button
                    variant="text"
                    size="sm"
                    aria-label={messages().clearSelection}
                    title={messages().clearSelection}
                    onClick={() => select(null)}
                  >
                    <i class="ti ti-x" aria-hidden="true" />
                  </Button>
                </div>
                {props.renderDetails ? (
                  props.renderDetails(row())
                ) : (
                  <DescriptionList
                    columns={3}
                    size="sm"
                    items={props.columns.map((column) => ({
                      term: column.label,
                      description: column.value(row()),
                    }))}
                  />
                )}
              </Paper>
            )}
          </Show>
        </div>
      </Show>
    </section>
  );
}
