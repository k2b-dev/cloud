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
/**
 * The latest read of an explorer's rows, kept apart from the rows on screen. Loading and a failure keep shown rows;
 * without rows they take the viewport's place at its height.
 */
export type ChartFrameRequest = {
  status: "idle" | "loading" | "error";
  /** A host sentence for a failure, such as "The query timed out." */
  reason?: string;
  /** The range being read, such as "Last 90 days"; while it differs from `range` the subtitle names it. */
  requestedRange?: string;
};
export type ChartExplorerProps<T extends ChartExplorerRow> = {
  cursor?: ChartCursor;
  title: string;
  /** Level of the title heading. Defaults to 3; a chart inside a titled group of charts sits one level below it. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  description?: JSX.Element;
  /** Owner actions in the header before Copy data, such as showing the query behind the chart. */
  actions?: JSX.Element;
  /**
   * Rows and the prepared chart. Without `chart`, `children` draws the chart view, such as a live `<Chart>`; the
   * table and Copy data still come from the typed rows.
   */
  data: ChartExplorerData<T> | { rows: readonly T[] };
  /** The chart view when `data` has no prepared chart. */
  children?: JSX.Element;
  columns: readonly ChartExplorerColumn<T>[];
  /**
   * The read in flight or the last one that failed. With it the explorer shows loading, empty, failure and stale
   * data in place: the title and subtitle stay, the viewport keeps its height, and nothing moves between states.
   */
  request?: ChartFrameRequest;
  /** When the shown rows were read, formatted by the host ("09:12"); named only when a newer read failed. */
  asOf?: string;
  /** The range the shown rows cover, such as "Last 30 days". */
  range?: string;
  /** Try again after a failure. Without it a failure has no button. */
  onRetry?: () => void;
  /**
   * The padding of the frame around the explorer. The table view then reaches the frame's left, right and bottom
   * edges without a border of its own, and the frame keeps its height.
   */
  inset?: string;
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
  /**
   * What the viewport shows without rows; defaults to "No data". With `request`, write one sentence that says why,
   * such as "No newsletter was sent in this period."
   */
  empty?: JSX.Element;
  class?: string;
};

// Only the copied text can prove that a cell is a number; a numeric sort key cannot.
const plainNumber = /^[-+]?\p{Sc}?\s?\d[\d.,\s]*(?:\s?(?:%|\p{Sc}))?$/u;
const tsvCell = (value: string) => {
  const safe = /^[=+\-@\t\r]/.test(value) && !plainNumber.test(value) ? `'${value}` : value;
  return /[\t\r\n"]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export function ChartExplorer<T extends ChartExplorerRow>(props: ChartExplorerProps<T>) {
  const messages = useUiMessages();
  const chartMessages = useChartMessages();
  const locale = useLocale();
  let legendHost: HTMLDivElement | undefined;
  const id = `k2b-chart-explorer-${createUniqueId()}`;
  const data = () => props.data;
  const snapshot = () => ("chart" in props.data ? props.data.chart : undefined);
  /** Without `request` the explorer behaves as before: rows or the empty slot. */
  const state = () => {
    if (!props.request) return undefined;
    const status = props.request.status;
    if (data().rows.length) return status === "error" ? "stale" : status === "loading" ? "refreshing" : "data";
    return status === "idle" ? "empty" : status;
  };
  const switching = () =>
    state() === "refreshing" && props.request?.requestedRange !== undefined && props.request.requestedRange !== props.range;
  const legendValue = (index: number) => {
    const marks = snapshot()?.marks ?? [];
    let latest = -Infinity;
    for (const mark of marks) latest = Math.max(latest, mark.datum.anchor[0]);
    const valueField =
      snapshot()?.kind === "area"
        ? marks.some((mark) => mark.datum.values.some((field) => field.key === "percent"))
          ? "percent"
          : "value"
        : "y";
    const field = marks
      .find((mark) => mark.datum.seriesIndex === index && mark.datum.anchor[0] === latest)
      ?.datum.values.find((field) => field.key === valueField);
    return field
      ? (field.formatted ??
          (typeof field.value === "number"
            ? new Intl.NumberFormat(locale(), { maximumFractionDigits: 6 }).format(field.value)
            : field.value))
      : "—";
  };

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
  const validate = () => {
    const chart = snapshot();
    if (chart) validateChartExplorerData({ chart, rows: data().rows });
    else if (new Set(data().rows.map((row) => row.key)).size !== data().rows.length || data().rows.some((row) => !row.key))
      throw new Error("Chart data requires unique row/mark keys and a row for every mark.rowKey");
  };
  validate();
  createEffect(validate);
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
      ...rows().map((row) => props.columns.map((c) => tsvCell(c.value(row))).join("\t")),
    ].join("\n");
  const tableView = () => view() === "table" && data().rows.length > 0 && state() !== "loading" && state() !== "error";
  const retryButton = (variant: "secondary" | "text") => (
    <Show when={props.onRetry}>
      {(retry) => (
        <Button variant={variant} size="sm" onClick={() => retry()()}>
          <Show when={variant === "secondary"}>
            <i class="ti ti-refresh" aria-hidden="true" />
          </Show>
          {messages().tryAgain}
        </Button>
      )}
    </Show>
  );
  return (
    <section
      class={`k2b-chart-explorer ${props.class ?? ""}`}
      aria-labelledby={id}
      aria-busy={state() === "loading" || state() === "refreshing" ? "true" : undefined}
      data-state={state()}
      data-inset={props.inset ? "true" : undefined}
      style={props.inset ? { "--k2b-chart-explorer-inset": props.inset } : undefined}
    >
      <header class="k2b-chart-explorer__header">
        <div>
          <Dynamic component={`h${props.headingLevel ?? 3}`} id={id} class="k2b-chart-explorer__title">
            {props.title}
          </Dynamic>
          {/* With a request the subtitle is one reserved line and a polite live region: stale and loading replace its
              text without moving anything, and a screen reader hears that the shown values are out of date. */}
          <Show when={props.description || state()}>
            <div
              class="k2b-chart-explorer__description"
              classList={{ "k2b-chart-explorer__status-line": state() === "stale" || state() === "loading" || switching() }}
              data-tone={state() === "stale" ? "warning" : undefined}
              role={state() ? "status" : undefined}
            >
              <Show when={state() === "stale" || state() === "loading" || switching()} fallback={props.description}>
                <Show
                  when={state() === "stale"}
                  fallback={
                    <span>
                      {switching()
                        ? chartMessages().chartLoadingRange({ range: props.request!.requestedRange! })
                        : chartMessages().chartLoading}
                    </span>
                  }
                >
                  <i class="ti ti-clock-exclamation" aria-hidden="true" />
                  <span>
                    {[props.asOf ? chartMessages().chartAsOf({ time: props.asOf }) : undefined, chartMessages().chartRefreshFailed]
                      .filter(Boolean)
                      .join(" · ")}
                    {props.onRetry ? " · " : ""}
                  </span>
                  {retryButton("text")}
                </Show>
              </Show>
            </div>
          </Show>
        </div>
        <div class="k2b-chart-explorer__actions">
          {props.actions}
          {/* Without rows the view controls keep their place but are hidden, so the header never rewraps. */}
          <span class="k2b-chart-explorer__views" inert={state() && !data().rows.length ? true : undefined}>
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
            {/* The switcher keeps the width of its longest view, so picking one never rewraps the header. */}
            <SelectChip<string>
              stableWidth
              value={switcherValue()}
              onValueChange={pick}
              aria-label={chartMessages().chartView}
              options={switcherOptions()}
            />
          </span>
        </div>
      </header>
      <Show when={copyFailed()}>
        <span role="alert">{chartMessages().chartCopyFailed}</span>
      </Show>
      {props.controls}
      <div
        ref={legendHost}
        class="k2b-chart-explorer__viewport"
        data-view={tableView() ? "table" : undefined}
        data-legend={view() === "chart" && props.legend?.length && data().rows.length > 0 ? "true" : undefined}
        data-capped={tableView() && shownRows().length < rows().length ? "true" : undefined}
        style={{ height: tableView() && props.inset ? `calc(${props.height ?? "18rem"} + ${props.inset})` : (props.height ?? "18rem") }}
      >
        <Show
          when={state() !== "loading" && state() !== "error" && data().rows.length > 0}
          fallback={
            <Show
              when={state() === "loading"}
              fallback={
                <Show
                  when={state() === "error"}
                  fallback={
                    <Show when={state() === "empty"} fallback={<div class="k2b-chart__empty">{props.empty ?? messages().noData}</div>}>
                      <div class="k2b-chart-explorer__state" data-state="empty">
                        <span class="k2b-chart-explorer__state-icon" aria-hidden="true">
                          <i class="ti ti-chart-bar-off" />
                        </span>
                        <p>{props.empty ?? messages().noData}</p>
                      </div>
                    </Show>
                  }
                >
                  <div class="k2b-chart-explorer__state" data-state="error" role="alert">
                    <span class="k2b-chart-explorer__state-icon" aria-hidden="true">
                      <i class="ti ti-alert-circle" />
                    </span>
                    <p>
                      {chartMessages().chartLoadFailed}
                      <br />
                      {props.request?.reason ?? chartMessages().chartLoadFailedKept}
                    </p>
                    {retryButton("secondary")}
                  </div>
                </Show>
              }
            >
              <div class="k2b-chart-explorer__skeleton" role="status" aria-label={chartMessages().chartLoading}>
                <For each={[0.45, 0.62, 0.55, 0.72, 0.6, 0.8, 0.66, 0.88, 0.63, 0.78, 0.7, 0.95]}>
                  {(height) => <span style={{ height: `${height * 100}%` }} />}
                </For>
              </div>
            </Show>
          }
        >
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
                  surface={props.inset ? "plain" : "paper"}
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
            <Show when={snapshot()} fallback={<div class="k2b-chart-explorer__chart">{props.children}</div>}>
              {(chart) => (
                <ChartSnapshotView
                  cursor={props.cursor}
                  legend={() => legendHost}
                  snapshot={chart()}
                  selectedKey={selected()}
                  onSelect={select}
                  style={props.legend?.length ? undefined : { height: "100%" }}
                />
              )}
            </Show>

            <Show when={props.legend?.length}>
              <ul class="k2b-chart-legend" aria-label={chartMessages().chartLegend}>
                <For each={props.legend}>
                  {(entry, index) => (
                    <li>
                      <span
                        class="k2b-chart-legend__swatch"
                        data-style={entry.style && entry.style !== "solid" ? entry.style : undefined}
                        data-reference={entry.reference ? "true" : undefined}
                        style={{ "--k2b-chart-legend-color": `var(--stdlib-chart-c${(Math.abs(Math.trunc(entry.color)) % 8) + 1})` }}
                        aria-hidden="true"
                      />
                      <span data-chart-legend-label>{entry.label}</span>
                      <Show when={snapshot()?.kind === "area" || snapshot()?.kind === "line"}>
                        <b
                          data-chart-legend-value
                          data-series-index={index()}
                          data-field={
                            snapshot()?.kind === "area"
                              ? snapshot()?.marks.some((mark) => mark.datum.values.some((field) => field.key === "percent"))
                                ? "percent"
                                : "value"
                              : "y"
                          }
                          data-default={legendValue(index())}
                        >
                          {legendValue(index())}
                        </b>
                      </Show>
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
