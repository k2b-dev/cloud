import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show, untrack, type JSX } from "solid-js";
import { Button } from "../actions/Button";
import { CopyButton } from "../actions/CopyButton";
import { FilterChip } from "../actions/FilterChip";
import { Paper } from "../surfaces/Paper";
import { DescriptionList } from "../surfaces/DescriptionList";
import { SelectChip } from "../inputs/SelectChip";
import { Slider } from "../inputs/ChoiceInputs";
import { useUiMessages } from "../intl/messages";
import { useLocale } from "../intl/locale";
import DataTable, { type DataTableSort } from "./DataTable";
import { ChartSnapshotView } from "./ChartSnapshotView";
import type { ChartSnapshot } from "./chart-snapshot";

export type ChartExplorerRequest = { step: string; visibleKeys: readonly string[] };
export type ChartExplorerSnapshot<T> = {
  request: ChartExplorerRequest;
  chart: ChartSnapshot;
  rows: readonly T[];
};
export type ChartExplorerColumn<T> = {
  id: string;
  label: string;
  value: (row: T) => string;
  /** Explicit comparable value. Omit to leave the column unsortable. */
  sortValue?: (row: T) => string | number | null;
  align?: "left" | "center" | "right";
};
export type ChartExplorerProps<T> = {
  title: string;
  description?: JSX.Element;
  snapshot: ChartExplorerSnapshot<T>;
  steps?: readonly { key: string; label: string }[];
  dimensionLabel?: string;
  legend?: readonly {
    key: string;
    label: string;
    color: string;
    marker?: "circle" | "square" | "triangle" | "diamond" | "plus" | "cross";
  }[];
  /** Return an atomically prepared SVG and its matching rows. Aborted/stale results are ignored. */
  load?: (request: ChartExplorerRequest, signal: AbortSignal) => Promise<ChartExplorerSnapshot<T>>;
  columns: readonly ChartExplorerColumn<T>[];
  getRowKey: (row: T) => string;
  selectedKey?: string | null;
  onSelectedKeyChange?: (key: string | null) => void;
  renderDetails?: (row: T) => JSX.Element;
  height?: string;
  class?: string;
};

const sameRequest = (a: ChartExplorerRequest, b: ChartExplorerRequest) =>
  a.step === b.step && a.visibleKeys.length === b.visibleKeys.length && a.visibleKeys.every((k) => b.visibleKeys.includes(k));
const tsvCell = (value: string) => (/[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

export function ChartExplorer<T>(props: ChartExplorerProps<T>) {
  const messages = useUiMessages();
  const locale = useLocale();
  const id = `k2b-chart-explorer-${createUniqueId()}`;
  const [snapshot, setSnapshot] = createSignal(props.snapshot);
  const [desired, setDesired] = createSignal(props.snapshot.request);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [copyFailed, setCopyFailed] = createSignal(false);
  const [keyboardSteps, setKeyboardSteps] = createSignal(false);
  let pointerFocus = false;
  const [localSelection, setLocalSelection] = createSignal<string | null>(null);
  const [view, setView] = createSignal<"chart" | "table">("chart");
  const [sort, setSort] = createSignal<DataTableSort | null>(null);
  let pending: AbortController | undefined;
  const marksByKey = createMemo(() => new Map(snapshot().chart.marks.map((mark) => [mark.key, mark])));
  const rowsByKey = createMemo(() => new Map(snapshot().rows.map((row) => [props.getRowKey(row), row])));
  const rawSelected = () => (props.selectedKey !== undefined ? props.selectedKey : localSelection());
  const selected = () => (marksByKey().has(rawSelected() ?? "") ? rawSelected() : null);
  const selectedRow = () => rowsByKey().get(selected() ?? "");
  const select = (key: string | null) => {
    if (key !== null && !marksByKey().has(key)) return;
    setLocalSelection(key);
    props.onSelectedKeyChange?.(key);
  };
  const validate = (next: ChartExplorerSnapshot<T>) => {
    const keys = next.rows.map(props.getRowKey);
    const keySet = new Set(keys);
    if (keys.some((key) => !key) || keySet.size !== keys.length || next.chart.marks.some((m) => !keySet.has(m.key))) {
      throw new Error("Chart rows require unique keys and a row for every chart mark");
    }
  };
  const uniqueKeys = (items: readonly { key: string }[]) =>
    items.every((item) => item.key.length > 0) && new Set(items.map((item) => item.key)).size === items.length;
  if (!uniqueKeys(props.steps ?? []) || !uniqueKeys(props.legend ?? []))
    throw new Error("Chart steps and legend entries require unique nonempty keys");
  if (
    !props.columns.length ||
    props.columns.some((column) => !column.id) ||
    new Set(props.columns.map((column) => column.id)).size !== props.columns.length
  ) {
    throw new Error("Chart columns require unique nonempty IDs and at least one column");
  }
  validate(props.snapshot);
  createEffect(() => {
    const next = props.snapshot;
    untrack(() => {
      validate(next);
      pending?.abort();
      pending = undefined;
      setSnapshot(next);
      setDesired(next.request);
      setLoading(false);
      setFailed(false);
    });
  });
  createEffect(() => {
    if (rawSelected() !== null && selected() === null) select(null);
  });
  onCleanup(() => pending?.abort());
  const request = async (next: ChartExplorerRequest) => {
    if (!props.load) return;
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    setDesired(next);
    setFailed(false);
    if (sameRequest(next, snapshot().request)) {
      pending = undefined;
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await props.load(next, controller.signal);
      if (controller.signal.aborted || pending !== controller) return;
      if (!sameRequest(result.request, next)) throw new Error("Chart response does not match the requested filters");
      validate(result);
      setSnapshot(result);
    } catch {
      if (!controller.signal.aborted && pending === controller) setFailed(true);
    } finally {
      if (!controller.signal.aborted && pending === controller) {
        setLoading(false);
        pending = undefined;
      }
    }
  };
  const rows = createMemo(() => {
    const result = [...snapshot().rows];
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
  const stepLabel = (key: string) => props.steps?.find((step) => step.key === key)?.label ?? key;
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
            iconOnly={false}
            size="sm"
            variant="secondary"
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
      <Show when={props.steps?.length}>
        <div
          class="k2b-chart-explorer__dimension"
          data-keyboard={keyboardSteps() ? "true" : undefined}
          onPointerDown={() => {
            pointerFocus = true;
            setKeyboardSteps(false);
          }}
          onKeyDown={() => {
            pointerFocus = false;
            setKeyboardSteps(true);
          }}
          onFocusIn={(event) => {
            if (!pointerFocus && event.target.matches(":focus-visible")) setKeyboardSteps(true);
          }}
          onFocusOut={() => {
            pointerFocus = false;
            setKeyboardSteps(false);
          }}
        >
          <Slider
            id={`${id}-dimension`}
            showValue={false}
            aria-describedby={`${id}-steps`}
            label={props.dimensionLabel ?? messages().range}
            min={0}
            max={Math.max(0, (props.steps?.length ?? 1) - 1)}
            step={1}
            value={Math.max(0, props.steps?.findIndex((step) => step.key === desired().step) ?? 0)}
            disabled={!props.load || (props.steps?.length ?? 0) < 2}
            formatValue={(index) => props.steps?.[index]?.label ?? ""}
            aria-valuetext={stepLabel(desired().step)}
            onValueChange={(index) => {
              const step = props.steps?.[index];
              if (step) void request({ ...desired(), step: step.key });
            }}
          />
          <output class="k2b-chart-explorer__dimension-value" for={`${id}-dimension`}>
            {stepLabel(desired().step)}
          </output>
          <div id={`${id}-steps`} class="k2b-chart-explorer__steps">
            <For each={props.steps}>
              {(step) => <span data-current={step.key === desired().step ? "true" : undefined}>{step.label}</span>}
            </For>
          </div>
        </div>
      </Show>
      <div class="k2b-chart-explorer__legend">
        <Show when={props.legend?.length}>
          <FilterChip
            label={messages().chartSeries}
            icon="ti ti-chart-dots"
            disabled={!props.load}
            value={desired().visibleKeys}
            defaultValue={props.legend?.map((item) => item.key) ?? []}
            isActive={desired().visibleKeys.length !== props.legend?.length}
            options={[
              { multiple: true, options: (props.legend ?? []).map((item) => ({ value: item.key, label: item.label, color: item.color })) },
            ]}
            onValueChange={(visibleKeys) => void request({ ...desired(), visibleKeys })}
          />
        </Show>
        <div class="k2b-chart-explorer__status" role="status">
          <Show when={loading()}>{messages().loading} </Show>
          <Show when={failed()}>
            {messages().couldNotLoadData}{" "}
            <Button variant="text" size="sm" onClick={() => void request(desired())}>
              {messages().retry}
            </Button>
          </Show>
          <Show when={loading() || failed()}>
            {" "}
            · {messages().chartPreviousData}
            <Show when={props.steps?.length}>: {stepLabel(snapshot().request.step)}</Show>
          </Show>
        </div>
      </div>
      <Show when={copyFailed()}>
        <span role="alert">{messages().chartCopyFailed}</span>
      </Show>
      <div class="k2b-chart-explorer__viewport" style={{ height: props.height ?? "18rem" }} aria-busy={loading()}>
        <Show when={snapshot().rows.length > 0} fallback={<div class="k2b-chart__empty">{messages().noData}</div>}>
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
                getRowId={props.getRowKey}
                selectedRowId={selected()}
                sort={sort()}
                fillHeight
                surface="paper"
                onRowClick={(row) => select(props.getRowKey(row))}
                renderCell={({ row, col, value, render }) =>
                  col.id === props.columns[0]?.id ? (
                    <Button
                      variant="text"
                      size="sm"
                      disabled={!marksByKey().has(props.getRowKey(row))}
                      onClick={() => select(props.getRowKey(row))}
                    >
                      {render(value)}
                    </Button>
                  ) : (
                    render(value)
                  )
                }
                renderHeader={({ col, render }) =>
                  col.sortable ? (
                    <Button
                      variant="text"
                      size="sm"
                      onClick={() =>
                        setSort({ key: col.id, direction: sort()?.key === col.id && sort()?.direction === "asc" ? "desc" : "asc" })
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
            <ChartSnapshotView snapshot={snapshot().chart} selectedKey={selected()} onSelect={select} style={{ height: "100%" }} />
          </Show>
        </Show>
      </div>
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
                  items={props.columns.map((column) => ({ term: column.label, description: column.value(row()) }))}
                />
              )}
            </Paper>
          )}
        </Show>
      </div>
    </section>
  );
}
