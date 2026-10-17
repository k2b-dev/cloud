import {
  ChartExplorer,
  type ChartExplorerColumn,
  type ChartLegendEntry,
  type ChartSnapshot,
  createChartCursor,
  prepareChartSnapshot,
  useLocale,
} from "@k2b/ui";
import { createMemo, createUniqueId, Index, type JSX, Show } from "solid-js";
import {
  type CloudAiChartRow,
  type CloudAiChartTable,
  cloudAiChartLegend,
  cloudAiChartMarkKey,
  cloudAiChartReferenceMark,
  cloudAiChartRenderOptions,
  cloudAiChartRows,
  cloudAiChartTooltip,
  cloudAiChartXValueFormat,
} from "../chart-block";
import type { CloudAiChartInput } from "../default-tool-contracts";
import { type CloudAiGroupView, parseCloudAiChartToolView } from "../view-block";
import { aiChatMessages } from "./messages";

type Kind = CloudAiChartInput["kind"];
type DrawnChart = { input: CloudAiChartInput; table: CloudAiChartTable; snapshot: ChartSnapshot; legend: ChartLegendEntry[] };

/** Draws a chart for display and fills its table from that drawing; null when nothing can be drawn. */
const drawChart = (input: CloudAiChartInput, locale: string): DrawnChart | null => {
  try {
    const rows = cloudAiChartRows(input, locale);
    // The chat lays the legend out in HTML: the renderer's single SVG row runs out of a phone-wide column.
    const snapshot = prepareChartSnapshot(cloudAiChartRenderOptions(input, locale, { legend: "outside" }), {
      key: ({ datum }) => cloudAiChartMarkKey(datum),
      tooltip: ({ datum }) => {
        const row = rows.add(datum);
        return cloudAiChartTooltip(rows.columns(), row);
      },
      reference: ({ datum }) => cloudAiChartReferenceMark(input, datum),
    });
    return snapshot.marks.length > 0 ? { input, table: rows.table(), snapshot, legend: cloudAiChartLegend(input, locale) } : null;
  } catch {
    return null;
  }
};

/**
 * Single values and trends need less room than a plot with axes. Bar gauges hold at most eight 28-unit rows of the
 * 280-unit drawing; at 12rem a row is still taller than its text.
 */
const chartHeight = (kind: Kind) => (kind === "sparkline" ? "8rem" : kind === "stat" ? "10rem" : kind === "barGauge" ? "12rem" : "18rem");

function ChartFrame(props: {
  title: string;
  subtitle?: string;
  kind: Kind;
  chart: DrawnChart | null;
  empty?: JSX.Element;
  cursor?: ReturnType<typeof createChartCursor>;
  /** A chart of a titled group: its title sits one heading level and one size below the group's. */
  nested?: boolean;
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
      headingLevel={props.nested ? 4 : 3}
      description={props.subtitle ? <span class="text-sm text-secondary">{props.subtitle}</span> : undefined}
      height={chartHeight(props.kind)}
      data={props.chart ? { chart: props.chart.snapshot, rows: props.chart.table.rows } : { chart: emptySnapshot(props.kind), rows: [] }}
      columns={columns()}
      legend={props.chart?.legend.length ? props.chart.legend : undefined}
      cursor={props.cursor}
      empty={props.empty}
      renderDetails={false}
      class={props.nested ? "[&_h4]:text-sm!" : undefined}
    />
  );
}

const emptySnapshot = (kind: Kind): ChartSnapshot => ({
  kind,
  svg: "",
  width: 480,
  height: 280,
  stretch: true,
  marks: [],
});

type GroupSummary = {
  title: string;
  subtitle?: string;
  linkX: boolean;
  layout: "stack" | "grid";
  charts: { kind: Kind; title: string; subtitle?: string }[];
};

/**
 * A group of small charts under one heading. Every chart frame stands with the title and height of its summary from
 * the first frame, while the group loads (`group` undefined) and when it cannot be drawn (`group` null); a chart that
 * cannot be drawn alone shows unavailable in its own frame. With `linkX`, one cursor follows the pointer or a tap
 * across every chart. A grid puts two charts side by side once the chat column has room for both.
 */
function ChartGroupFrame(props: { summary: GroupSummary; group: CloudAiGroupView | null | undefined; empty?: JSX.Element }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const id = `cloud-chart-group-${createUniqueId()}`;
  const drawn = createMemo(() => props.group?.charts.map((input) => drawChart(input, locale())) ?? []);
  // One cursor per group, owned by the component; the first chart's x format titles the shared tooltip.
  const cursor = createChartCursor({
    formatX: (x) => {
      const first = props.group?.charts[0];
      return first ? cloudAiChartXValueFormat(first, locale())(x) : String(x);
    },
  });
  return (
    <section class="@container grid min-w-0 gap-3" aria-labelledby={id}>
      <header class="min-w-0">
        <h3 id={id} class="m-0 text-base font-semibold">
          {props.group?.title ?? props.summary.title}
        </h3>
        <Show when={props.group ? props.group.subtitle : props.summary.subtitle}>
          {(subtitle) => <span class="text-sm text-secondary">{subtitle()}</span>}
        </Show>
      </header>
      <div class={`grid min-w-0 gap-6 ${props.summary.layout === "grid" ? "@2xl:grid-cols-2" : ""}`}>
        <Index each={props.summary.charts}>
          {(chart, index) => (
            <ChartFrame
              title={props.group?.charts[index]?.title ?? chart().title}
              subtitle={props.group ? props.group.charts[index]?.subtitle : chart().subtitle}
              kind={chart().kind}
              chart={drawn()[index] ?? null}
              cursor={props.summary.linkX ? cursor : undefined}
              nested
              empty={props.empty ?? <span role="status">{t().chartUnavailable}</span>}
            />
          )}
        </Index>
      </div>
    </section>
  );
}

const groupSummary = (group: CloudAiGroupView): GroupSummary => ({
  title: group.title,
  subtitle: group.subtitle,
  linkX: group.linkX ?? false,
  layout: group.layout ?? "stack",
  charts: group.charts.map((chart) => ({ kind: chart.kind, title: chart.title, subtitle: chart.subtitle })),
});

/**
 * One `chart` tool call: the shared chart with its data table and Copy data, or a group of them. The block takes its
 * full size with its first frame and keeps it; switching to the table scrolls inside the same height. A call whose
 * arguments are not a valid chart shows nothing while it runs, because the model gets the validation error and the
 * call fails.
 */
export function CloudChartBlock(props: { args: unknown; completed: boolean }) {
  const locale = useLocale();
  // Live updates replace the block with equal arguments; only a real change redraws.
  const source = createMemo(() => JSON.stringify(props.args ?? null));
  const view = createMemo(() => parseCloudAiChartToolView(JSON.parse(source())));
  // The tool schema drew the chart once to accept it; here it is drawn once more, for display, and the table is
  // filled from that drawing.
  const chart = createMemo(() => {
    const value = view();
    return value?.view === "chart" ? drawChart(value, locale()) : null;
  });
  const group = createMemo(() => {
    const value = view();
    return value?.view === "group" ? value : undefined;
  });
  return (
    <Show
      when={group()}
      fallback={
        <Show
          when={chart()}
          fallback={
            <Show when={props.completed}>
              <p class="text-sm text-secondary">{aiChatMessages(locale()).chartUnavailable}</p>
            </Show>
          }
        >
          {(value) => (
            <ChartFrame title={value().input.title} subtitle={value().input.subtitle} kind={value().input.kind} chart={value()} />
          )}
        </Show>
      }
    >
      {(value) => <ChartGroupFrame summary={groupSummary(value())} group={value()} />}
    </Show>
  );
}

/**
 * A chart view file: the frame stands with the title, actions and height of its `present` summary from the first frame,
 * while the file loads (`input` undefined) and when it cannot be drawn (`input` null).
 */
export function CloudChartView(props: {
  summary: { title: string; subtitle?: string; kind: Kind };
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

/** A group view file, sized by its `present` summary like a chart view. */
export function CloudChartGroupView(props: { summary: GroupSummary; group: CloudAiGroupView | null | undefined }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  return (
    <ChartGroupFrame
      summary={props.summary}
      group={props.group}
      empty={props.group ? undefined : <span role="status">{props.group === undefined ? t().viewLoading : t().viewUnavailable}</span>}
    />
  );
}
