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
/** The data table has its own entry; chart entries are prefixed so a view named "table" stays apart. */
const TABLE = "table";
const chartKey = (id: string) => `view:${id}`;

const emptySnapshot = (kind: ChartSnapshot["kind"]): ChartSnapshot => ({
  kind,
  svg: "",
  width: 480,
  height: 280,
  stretch: true,
  marks: [],
});

/**
 * One state of the explorer as snapshots: each view drawn from the rows the request shows, plus the table of those
 * rows. A view that cannot be drawn for this state gets no rows, so its frame shows why instead of an empty plot.
 */
function explorerSnapshot(view: CloudAiExplorerView, table: CloudAiChartRow[], request: CloudAiExplorerRequest, locale: string) {
  const state = cloudAiExplorerState(view, request, locale);
  const rows = state.rows.map((index) => table[index]!);
  const columnLabel = (id: string) => view.columns.find((column) => column.id === id)?.label ?? id;
  const charts: Charts = { [TABLE]: { chart: emptySnapshot("bar"), rows } };
  const failed = new Set<string>();
  for (const spec of view.views) {
    const chart = state.charts[spec.id];
    if (!chart) continue;
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
      const shown = new Set(rows.map((row) => row.key));
      if (!snapshot.marks.every((mark) => shown.has(mark.rowKey))) throw new Error("A mark has no row");
      charts[chartKey(spec.id)] = { chart: snapshot, rows };
    } catch {
      failed.add(spec.id);
      charts[chartKey(spec.id)] = { chart: emptySnapshot(spec.kind), rows: [] };
    }
  }
  return { snapshot: { request: { ...request }, charts }, legends: state.charts, failed };
}
type ExplorerState = ReturnType<typeof explorerSnapshot>;

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
  // Legends and undrawable views belong to the snapshot createChartExplorer adopted, not to the latest request.
  const states = new WeakMap<Charts, ExplorerState>();
  const build = (request: ChartExplorerRequest) => {
    const next = explorerSnapshot(props.input, table(), request, locale());
    states.set(next.snapshot.charts, next);
    return next.snapshot;
  };
  const explorer = createChartExplorer<Charts>({ snapshot: () => build(controls().initial), load: build });
  const state = () => states.get(explorer.snapshot().charts);
  const [chart, setChart] = createSignal(props.input.views[0]!.id);
  const [view, setView] = createSignal<"chart" | "table">("chart");
  const current = () => (view() === "table" ? TABLE : chartKey(chart()));
  const columns = createMemo(() =>
    props.input.columns.map(
      (column): ChartExplorerColumn<CloudAiChartRow> => ({
        id: column.id,
        label: column.label ?? column.id,
        value: (row) => row.cells[column.id] ?? "",
        sortValue: (row) => row.values[column.id] ?? null,
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
      data={explorer.snapshot().charts[current()]!}
      columns={columns()}
      charts={props.input.views}
      chart={chart()}
      onChartChange={setChart}
      view={view()}
      onViewChange={setView}
      legend={view() === "chart" ? state()?.legends[chart()]?.legend : undefined}
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
                ? controls().series.map((entry) => ({ ...entry, color: `var(--stdlib-chart-c${(entry.color % 8) + 1})` }))
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
      empty={<span role="status">{view() === "chart" && state()?.failed.has(chart()) ? t().explorerUndrawable : t().explorerNoRows}</span>}
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
