import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Button, IconButton } from "../actions/Button";
import { CopyButton } from "../actions/CopyButton";
import { SelectChip } from "../inputs/SelectChip";
import { useLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import { DescriptionList } from "../surfaces/DescriptionList";
import { Paper } from "../surfaces/Paper";
import { ChartSnapshotView } from "./ChartSnapshotView";
import type { ChartCursor } from "./chart-cursor";
import { type ChartExplorerData, type ChartExplorerRow, validateChartExplorerData } from "./chart-explorer";
import { useChartMessages } from "./chart-messages";
import DataTable, { type DataTableSort } from "./DataTable";

export type ChartExplorerColumn<T> = {
  id: string;
  label: string;
  value: (row: T) => string;
  /** Optional table cell presentation; value remains the plain text used for copy/details. */
  render?: (row: T) => JSX.Element;
  /**
   * Explicit comparable value. Omit to leave the column unsortable.
   * Returning a number also exempts the cell from spreadsheet formula guarding on copy.
   */
  sortValue?: (row: T) => string | number | null;
  align?: "left" | "center" | "right";
};
/** One legend entry; `color` is the palette index the renderer gave the series (0 is `--stdlib-chart-c1`). */
export type ChartLegendEntry = {
  label: string;
  color: number;
  /** Line pattern of a line series; a solid series shows a filled swatch. */
  style?: "solid" | "dashed" | "dotted";
  /** A comparison series, drawn hollow like its marks. */
  reference?: boolean;
};
export type ChartExplorerProps<T extends ChartExplorerRow> = {
  cursor?: ChartCursor;
  title: string;
  /** Level of the title heading. Defaults to 3; a chart inside a titled group of charts sits one level below it. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  description?: JSX.Element;
  data: ChartExplorerData<T>;
  columns: readonly ChartExplorerColumn<T>[];
  view?: "chart" | "table";
  defaultView?: "chart" | "table";
  onViewChange?: (view: "chart" | "table") => void;
  /**
   * Several charts of the same rows. The switcher then lists each chart and the table; `chart` names the one `data`
   * holds, and `onChartChange` reports a pick, so the owner passes the matching data.
   */
  charts?: readonly { id: string; label: string }[];
  chart?: string;
  onChartChange?: (id: string) => void;
  /** Filter controls between the header and the viewport, such as ChartFilterControls. */
  controls?: JSX.Element;
  /** The table renders at most this many rows of the sorted order; sorting and Copy data use every row. */
  tableRows?: number;
  sort?: DataTableSort | null;
  defaultSort?: DataTableSort | null;
  onSortChange?: (sort: DataTableSort | null) => void;
  selectedKey?: string | null;
  onSelectedKeyChange?: (key: string | null) => void;
  /** false hides the complete local detail area for a shared selection panel. */
  renderDetails?: false | ((row: T) => JSX.Element);
  height?: string;
  /**
   * Series names below the chart, wrapping inside the fixed viewport height. Use it instead of the renderer's legend,
   * which draws in one row and runs out of narrow columns.
   */
  legend?: readonly ChartLegendEntry[];
  /** What the viewport shows without rows, for example while they load; defaults to "No data". */
  empty?: JSX.Element;
  class?: string;
};

const tsvCell = (value: string, numeric = false) => {
  const safe = !numeric && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[\t\r\n"]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export function ChartExplorer<T extends ChartExplorerRow>(props: ChartExplorerProps<T>) {
  const messages = useUiMessages();
  const chartMessages = useChartMessages();
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
  const shownRows = () => (props.tableRows === undefined ? rows() : rows().slice(0, props.tableRows));
  // Chart ids are data; a prefix keeps one named "table" apart from the table entry.
  const switcherValue = () => (view() === "table" || !props.charts?.length ? view() : `chart:${props.chart ?? props.charts[0]?.id}`);
  const switcherOptions = () =>
    props.charts?.length
      ? [
          ...props.charts.map((chart) => ({ value: `chart:${chart.id}`, label: chart.label })),
          { value: "table", label: chartMessages().chartData },
        ]
      : [
          { value: "chart", label: chartMessages().chartDiagram },
          { value: "table", label: chartMessages().chartData },
        ];
  const pick = (value: string) => {
    if (value === "table" || value === "chart") return setView(value);
    setView("chart");
    props.onChartChange?.(value.slice("chart:".length));
  };
  const copyText = () =>
    [
      props.columns.map((c) => tsvCell(c.label)).join("\t"),
      ...rows().map((row) => props.columns.map((c) => tsvCell(c.value(row), typeof c.sortValue?.(row) === "number")).join("\t")),
    ].join("\n");
  return (
    <section class={`k2b-chart-explorer ${props.class ?? ""}`} aria-labelledby={id}>
      <header class="k2b-chart-explorer__header">
        <div>
          <Dynamic component={`h${props.headingLevel ?? 3}`} id={id} class="k2b-chart-explorer__title">
            {props.title}
          </Dynamic>
          <Show when={props.description}>
            <div>{props.description}</div>
          </Show>
        </div>
        <div class="k2b-chart-explorer__actions">
          <CopyButton
            text={copyText()}
            label={chartMessages().chartCopyData}
            iconOnly
            size="sm"
            variant="ghost"
            disabled={!rows().length}
            onCopyError={() => setCopyFailed(true)}
            onCopied={() => setCopyFailed(false)}
          />
          <SelectChip<string>
            value={switcherValue()}
            onValueChange={pick}
            aria-label={chartMessages().chartView}
            options={switcherOptions()}
          />
        </div>
      </header>
      <Show when={copyFailed()}>
        <span role="alert">{chartMessages().chartCopyFailed}</span>
      </Show>
      {props.controls}
      <div
        class="k2b-chart-explorer__viewport"
        data-legend={view() === "chart" && props.legend?.length && data().rows.length > 0 ? "true" : undefined}
        data-capped={view() === "table" && shownRows().length < rows().length ? "true" : undefined}
        style={{ height: props.height ?? "18rem" }}
      >
        <Show when={data().rows.length > 0} fallback={<div class="k2b-chart__empty">{props.empty ?? messages().noData}</div>}>
          <Show
            when={view() === "chart"}
            fallback={
              <>
                <DataTable
                  rows={shownRows()}
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
                    return !custom && col.id === props.columns[0]?.id ? (
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
                        {props.columns.find((column) => column.id === col.id)?.label}
                        {/* The data table's own marker: inactive columns keep a dimmed arrow so the header reads as sortable. */}
                        <i
                          class={`k2b-data-table__sort-icon ti ${sort()?.key === col.id && sort()?.direction === "asc" ? "ti-arrow-up" : "ti-arrow-down"}`}
                          data-active={sort()?.key === col.id ? "true" : undefined}
                          aria-hidden="true"
                        />
                      </Button>
                    ) : (
                      render()
                    )
                  }
                />
                <Show when={shownRows().length < rows().length}>
                  <p class="k2b-chart-explorer__note">
                    {chartMessages().chartRowsShown({
                      shown: new Intl.NumberFormat(locale()).format(shownRows().length),
                      total: new Intl.NumberFormat(locale()).format(rows().length),
                    })}
                  </p>
                </Show>
              </>
            }
          >
            <ChartSnapshotView
              cursor={props.cursor}
              snapshot={data().chart}
              selectedKey={selected()}
              onSelect={select}
              style={props.legend?.length ? undefined : { height: "100%" }}
            />
            <Show when={props.legend?.length}>
              <ul class="k2b-chart-legend" aria-label={chartMessages().chartLegend}>
                <For each={props.legend}>
                  {(entry) => (
                    <li>
                      <span
                        class="k2b-chart-legend__swatch"
                        data-style={entry.style && entry.style !== "solid" ? entry.style : undefined}
                        data-reference={entry.reference ? "true" : undefined}
                        style={{ "--k2b-chart-legend-color": `var(--stdlib-chart-c${(Math.abs(Math.trunc(entry.color)) % 8) + 1})` }}
                        aria-hidden="true"
                      />
                      {entry.label}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
      </div>
      <Show when={props.renderDetails !== false}>
        <div class="k2b-chart-explorer__details" aria-live="polite">
          <Show when={selectedRow()}>
            {(row) => (
              <Paper class="k2b-chart-explorer__detail-paper">
                <div class="k2b-chart-explorer__detail-header">
                  <span>{chartMessages().chartSelectedDatum}</span>
                  <IconButton variant="text" size="sm" label={messages().clearSelection} onClick={() => select(null)}>
                    <i class="ti ti-x" aria-hidden="true" />
                  </IconButton>
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
