import { ChartExplorer, type ChartExplorerColumn, type ChartSnapshot, prepareChartSnapshot, useLocale } from "@k2b/ui";
import { createMemo, type JSX, Show } from "solid-js";
import {
  type CloudAiChartColumn,
  type CloudAiChartRow,
  type CloudAiChartTable,
  cloudAiChartMarkKey,
  cloudAiChartRenderOptions,
  cloudAiChartRows,
} from "../chart-block";
import { type CloudAiChartInput, parseCloudAiChartInput } from "../default-tool-contracts";
import { aiChatMessages } from "./messages";

const tooltip = (columns: CloudAiChartColumn[], row: CloudAiChartRow) => {
  const [first, ...rest] = columns;
  const named = first && !first.numeric;
  return {
    title: named ? row.cells[first.id] : undefined,
    rows: (named ? rest : columns).map((column) => ({ label: column.label, value: row.cells[column.id] ?? "" })),
  };
};

type DrawnChart = { input: CloudAiChartInput; table: CloudAiChartTable; snapshot: ChartSnapshot };

/** Draws a chart for display and fills its table from that drawing; null when nothing can be drawn. */
const drawChart = (input: CloudAiChartInput, locale: string): DrawnChart | null => {
  try {
    const rows = cloudAiChartRows(input, locale);
    const snapshot = prepareChartSnapshot(cloudAiChartRenderOptions(input, locale), {
      key: ({ datum }) => cloudAiChartMarkKey(datum),
      tooltip: ({ datum }) => {
        const row = rows.add(datum);
        return tooltip(rows.columns(), row);
      },
    });
    return snapshot.marks.length > 0 ? { input, table: rows.table(), snapshot } : null;
  } catch {
    return null;
  }
};

const chartHeight = (kind: CloudAiChartInput["kind"]) => (kind === "sparkline" ? "8rem" : "18rem");

function ChartFrame(props: {
  title: string;
  subtitle?: string;
  kind: CloudAiChartInput["kind"];
  chart: DrawnChart | null;
  empty?: JSX.Element;
}) {
  const locale = useLocale();
  const columns = () =>
    props.chart
      ? props.chart.table.columns.map(
          (column): ChartExplorerColumn<CloudAiChartRow> => ({
            id: column.id,
            label: column.label,
            value: (row) => row.cells[column.id] ?? "",
            sortValue: (row) => row.values[column.id] ?? null,
            align: column.numeric ? "right" : "left",
          }),
        )
      : // A frame without a drawing keeps the explorer's header and height; its one column is never shown.
        [{ id: "value", label: aiChatMessages(locale()).chartUnavailable, value: () => "" }];
  return (
    <ChartExplorer
      title={props.title}
      description={props.subtitle ? <span class="text-sm text-secondary">{props.subtitle}</span> : undefined}
      height={chartHeight(props.kind)}
      data={props.chart ? { chart: props.chart.snapshot, rows: props.chart.table.rows } : { chart: emptySnapshot(props.kind), rows: [] }}
      columns={columns()}
      empty={props.empty}
      renderDetails={false}
    />
  );
}

const emptySnapshot = (kind: CloudAiChartInput["kind"]): ChartSnapshot => ({
  kind,
  svg: "",
  width: 480,
  height: 280,
  stretch: true,
  marks: [],
});

/**
 * One `chart` tool call: the shared chart with its data table and Copy data. The block takes its full size with its
 * first frame and keeps it; switching to the table scrolls inside the same height. A call whose arguments are not a
 * valid chart shows nothing while it runs, because the model gets the validation error and the call fails.
 */
export function CloudChartBlock(props: { args: unknown; completed: boolean }) {
  const locale = useLocale();
  // Live updates replace the block with equal arguments; only a real change redraws.
  const source = createMemo(() => JSON.stringify(props.args ?? null));
  const chart = createMemo(() => {
    // The tool schema drew the chart once to accept it; here it is drawn once more, for display, and the table is
    // filled from that drawing.
    const input = parseCloudAiChartInput(JSON.parse(source()));
    return input ? drawChart(input, locale()) : null;
  });
  return (
    <Show
      when={chart()}
      fallback={
        <Show when={props.completed}>
          <p class="text-sm text-secondary">{aiChatMessages(locale()).chartUnavailable}</p>
        </Show>
      }
    >
      {(value) => <ChartFrame title={value().input.title} subtitle={value().input.subtitle} kind={value().input.kind} chart={value()} />}
    </Show>
  );
}

/**
 * A chart view file: the frame stands with the title, actions and height of its `present` summary from the first frame,
 * while the file loads (`input` undefined) and when it cannot be drawn (`input` null).
 */
export function CloudChartView(props: {
  summary: { title: string; subtitle?: string; kind: CloudAiChartInput["kind"] };
  input: CloudAiChartInput | null | undefined;
}) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const chart = createMemo(() => (props.input ? drawChart(props.input, locale()) : null));
  return (
    <ChartFrame
      title={chart()?.input.title ?? props.summary.title}
      subtitle={chart() ? chart()?.input.subtitle : props.summary.subtitle}
      kind={props.summary.kind}
      chart={chart()}
      empty={<span role="status">{props.input === undefined ? t().viewLoading : t().viewUnavailable}</span>}
    />
  );
}
