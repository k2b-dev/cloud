import {
  ChartExplorer,
  type ChartExplorerColumn,
  type ChartExplorerData,
  type ChartExplorerRequest,
  ChartFilterControls,
  type ChartSnapshot,
  createChartExplorer,
  prepareChartSnapshot,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, type JSX, Show } from "solid-js";
import { type CloudAiChartRow, cloudAiChartMarkKey, cloudAiChartReferenceMark, cloudAiChartRenderOptions } from "../chart-block";
import {
  type CloudAiExplorerRequest,
  type CloudAiExplorerView,
  type CloudAiViewSummary,
  cloudAiExplorerControls,
  cloudAiExplorerState,
  cloudAiViewCellOf,
  cloudAiViewTable,
} from "../view-block";
import { aiChatMessages } from "./messages";
import { ReferenceText } from "./reference-text";

type ExplorerSummary = Extract<CloudAiViewSummary, { view: "explorer" }>;
type Charts = Record<string, ChartExplorerData<CloudAiChartRow>>;

/** Rows the table renders inline, as table views do; sorting and Copy data use all of them. */
const VISIBLE_ROWS = 100;
/** Every explorer chart kind draws a plot with axes, so all share the chart block's viewport. */
const HEIGHT = "18rem";
/** createChartExplorer holds the shown rows as its only entry; views are drawn from them on demand. */
const TABLE = "table";

const emptySnapshot = (kind: ChartSnapshot["kind"]): ChartSnapshot => ({
  kind,
  svg: "",
  width: 480,
  height: 280,
  stretch: true,
  marks: [],
});

/** One state of the explorer: the rows its request shows, as the table, and every view projected from them. */
function explorerState(view: CloudAiExplorerView, table: CloudAiChartRow[], request: CloudAiExplorerRequest, locale: string) {
  const state = cloudAiExplorerState(view, request, locale);
  const rows = state.rows.map((index) => table[index]!);
  const charts: Charts = { [TABLE]: { chart: emptySnapshot("bar"), rows } };
  return { snapshot: { request: { ...request }, charts }, rows, charts: state.charts };
}
type ExplorerState = ReturnType<typeof explorerState>;

/**
 * One view of a state, drawn. Drawing is the expensive part, so only a view someone shows is drawn. A view that
 * draws no mark of the shown rows returns undefined, so its frame says why instead of showing an empty plot.
 */
function drawExplorerView(
  view: CloudAiExplorerView,
  spec: CloudAiExplorerView["views"][number],
  table: CloudAiChartRow[],
  state: ExplorerState,
  locale: string,
): ChartExplorerData<CloudAiChartRow> | undefined {
  const chart = state.charts[spec.id];
  if (!chart) return undefined;
  const columnLabel = (id: string) => view.columns.find((column) => column.id === id)?.label ?? id;
  const rowOf = (datum: { seriesIndex?: number; index: number }) => chart.marks[datum.seriesIndex ?? 0]?.[datum.index];
  // The tooltip names what this view encodes; the table and Copy data carry every column.
  const encoded = (seriesIndex: number) => {
    const ys = Array.isArray(spec.y) ? spec.y : [spec.y];
    // Several y columns are one series each; with a series column every series shows the single y.
    const y = spec.kind === "line" || spec.kind === "scatter" ? ys[ys.length > 1 ? seriesIndex % 8 : 0] : spec.y;
    return [
      spec.x,
      ...(y ? [y] : []),
      ...(spec.kind === "heatmap" ? [spec.value] : []),
      ...(spec.kind !== "heatmap" && spec.kind !== "bar" && spec.series ? [spec.series] : []),
      ...(view.controls?.step ? [view.controls.step] : []),
    ];
  };
  try {
    const snapshot = prepareChartSnapshot(cloudAiChartRenderOptions(chart.input, locale, { legend: "outside" }), {
      key: ({ datum }) => cloudAiChartMarkKey(datum),
      rowKey: ({ datum }) => String(rowOf(datum)),
      tooltip: ({ datum }) => {
        const row = table[rowOf(datum) ?? -1];
        const series =
          chart.input.kind === "line" || chart.input.kind === "scatter" ? chart.input.series[datum.seriesIndex ?? 0] : undefined;
        return {
          title: series?.label ?? (row ? row.cells[spec.x] : undefined),
          rows: row
            ? [...new Set(encoded(datum.seriesIndex ?? 0))].map((id) => ({ label: columnLabel(id), value: row.cells[id] ?? "" }))
            : [],
        };
      },
      reference: ({ datum }) => cloudAiChartReferenceMark(chart.input, datum),
    });
    // createChartExplorer rejects a mark without a row; such a view shows why instead of failing the block.
    const shown = new Set(state.rows.map((row) => row.key));
    if (!snapshot.marks.length || !snapshot.marks.every((mark) => shown.has(mark.rowKey))) return undefined;
    return { chart: snapshot, rows: state.rows };
  } catch {
    return undefined;
  }
}

const hasControls = (summary: ExplorerSummary) => summary.step || summary.filter;

/** The frame of an explorer whose file is loading or unavailable, at the size the loaded explorer takes. */
function ExplorerPlaceholder(props: { summary: ExplorerSummary; message: JSX.Element }) {
  const locale = useLocale();
  return (
    <ChartExplorer
      title={props.summary.title}
      description={props.summary.subtitle ? <span class="text-sm text-secondary">{props.summary.subtitle}</span> : undefined}
      height={HEIGHT}
      data={{ chart: emptySnapshot(props.summary.views[0]?.kind ?? "bar"), rows: [] }}
      columns={[{ id: "value", label: aiChatMessages(locale()).chartUnavailable, value: () => "" }]}
      charts={props.summary.views}
      chart={props.summary.views[0]?.id}
      controls={
        hasControls(props.summary) ? (
          <ChartFilterControls
            request={{ step: props.summary.step ? "0" : undefined }}
            displayedRequest={{}}
            steps={props.summary.step ? [{ key: "0", label: "" }] : undefined}
            series={props.summary.filter ? [{ key: "0", label: "", color: "var(--stdlib-chart-c1)" }] : undefined}
            compare={props.summary.compare}
            dimensionLabel={"\u00a0"}
            seriesLabel={"\u00a0"}
            disabled
            onRequest={() => {}}
          />
        ) : undefined
      }
      empty={props.message}
      renderDetails={false}
    />
  );
}

/**
 * The loaded explorer. Every filter, step and comparison is computed here from the file's rows; the selection is
 * shared by every view and the table, and all of it is local to this block.
 */
function LoadedExplorer(props: { summary: ExplorerSummary; input: CloudAiExplorerView }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const table = createMemo(() => cloudAiViewTable({ ...props.input, view: "table" }, locale()).rows);
  const controls = createMemo(() => cloudAiExplorerControls(props.input, locale()));
  // createChartExplorer owns the request and the selection over the shown rows; each view is drawn when shown, once
  // per state, so a filter or step change draws one view instead of all of them.
  const states = new WeakMap<Charts, { state: ExplorerState; drawn: Map<string, ChartExplorerData<CloudAiChartRow> | undefined> }>();
  const build = (request: ChartExplorerRequest) => {
    const next = explorerState(props.input, table(), request, locale());
    states.set(next.snapshot.charts, { state: next, drawn: new Map() });
    return next.snapshot;
  };
  const explorer = createChartExplorer<Charts>({ snapshot: () => build(controls().initial), load: build });
  const [chart, setChart] = createSignal(props.input.views[0]!.id);
  const [view, setView] = createSignal<"chart" | "table">("chart");
  const spec = () => props.input.views.find((entry) => entry.id === chart()) ?? props.input.views[0]!;
  const shown = createMemo(() => {
    const charts = explorer.snapshot().charts;
    const entry = states.get(charts)!;
    if (view() === "table") return { data: charts[TABLE]!, failed: false };
    const id = spec().id;
    if (!entry.drawn.has(id)) entry.drawn.set(id, drawExplorerView(props.input, spec(), table(), entry.state, locale()));
    const data = entry.drawn.get(id);
    return data ? { data, failed: false } : { data: { chart: emptySnapshot(spec().kind), rows: [] }, failed: true };
  });
  const legend = () =>
    view() === "chart" && !shown().failed ? states.get(explorer.snapshot().charts)?.state.charts[spec().id]?.legend : undefined;
  // Swatches name chart colors only where the shown view colors its series by the filter column.
  const colored = () => {
    const current = spec();
    return view() === "chart" && (current.kind === "line" || current.kind === "scatter") && current.series === props.input.controls?.filter;
  };
  const columns = createMemo(() =>
    props.input.columns.map(
      (column): ChartExplorerColumn<CloudAiChartRow> => ({
        id: column.id,
        label: column.label ?? column.id,
        value: (row) => row.cells[column.id] ?? "",
        sortValue: (row) => (Object.hasOwn(row.values, column.id) ? (row.values[column.id] ?? null) : null),
        align: column.type === "number" ? "right" : "left",
        ...(column.type === "ref"
          ? {
              render: (row: CloudAiChartRow) => {
                const cells = props.input.rows[Number(row.key)];
                const cell = cells ? cloudAiViewCellOf(cells, column.id) : null;
                const text = row.cells[column.id] ?? "";
                return cell && typeof cell === "object" ? <ReferenceText text={text} reference={cell} /> : text;
              },
            }
          : {}),
      }),
    ),
  );
  const columnLabel = (id: string | undefined) =>
    id === undefined ? undefined : (props.input.columns.find((column) => column.id === id)?.label ?? id);
  return (
    <ChartExplorer<CloudAiChartRow>
      title={props.input.title}
      description={props.input.subtitle ? <span class="text-sm text-secondary">{props.input.subtitle}</span> : undefined}
      height={HEIGHT}
      data={shown().data}
      columns={columns()}
      charts={props.input.views}
      chart={chart()}
      onChartChange={setChart}
      view={view()}
      onViewChange={setView}
      legend={legend()}
      selectedKey={explorer.selectedKey()}
      onSelectedKeyChange={explorer.select}
      tableRows={VISIBLE_ROWS}
      controls={
        hasControls(props.summary) ? (
          <ChartFilterControls
            request={explorer.desired()}
            displayedRequest={explorer.snapshot().request}
            steps={controls().steps.length ? controls().steps : props.summary.step ? [{ key: "0", label: "" }] : undefined}
            series={
              controls().series.length
                ? controls().series.map(({ key, label, color }) => ({
                    key,
                    label,
                    ...(colored() ? { color: `var(--stdlib-chart-c${(color % 8) + 1})` } : {}),
                  }))
                : props.summary.filter
                  ? [{ key: "0", label: "", color: "var(--stdlib-chart-c1)" }]
                  : undefined
            }
            disabled={!props.input.rows.length}
            compare={props.summary.compare}
            dimensionLabel={columnLabel(props.input.controls?.step)}
            seriesLabel={columnLabel(props.input.controls?.filter)}
            onRequest={explorer.setRequest}
          />
        ) : undefined
      }
      empty={
        <span role="status">
          {shown().failed && explorer.snapshot().charts[TABLE]!.rows.length ? t().explorerUndrawable : t().explorerNoRows}
        </span>
      }
      renderDetails={false}
    />
  );
}

/**
 * An explorer view file: one dataset, several charts of it, a shared selection, local filters and the table of the
 * rows shown. It stands at its final size from the `present` summary while the file loads (`input` undefined) and
 * when it is unavailable (`input` null).
 */
export function CloudExplorerView(props: { summary: ExplorerSummary; input: CloudAiExplorerView | null | undefined }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  return (
    <Show
      when={props.input}
      keyed
      fallback={
        <ExplorerPlaceholder
          summary={props.summary}
          message={<span role="status">{props.input === undefined ? t().viewLoading : t().viewUnavailable}</span>}
        />
      }
    >
      {(input) => <LoadedExplorer summary={props.summary} input={input} />}
    </Show>
  );
}
