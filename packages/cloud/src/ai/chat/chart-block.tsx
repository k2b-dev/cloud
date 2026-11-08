import { createChartCursor, prepareChartSnapshot, useLocale } from "@k2b/ui";
import { createMemo, createUniqueId, Index, type JSX, Show } from "solid-js";
import {
  cloudAiChartLegend,
  cloudAiChartMarkKey,
  cloudAiChartReferenceMark,
  cloudAiChartRenderOptions,
  cloudAiChartRows,
  cloudAiChartTooltip,
  cloudAiChartXValueFormat,
} from "../chart-block";
import type { CloudAiChartInput } from "../default-tool-contracts";
import { type CloudGroupDescription, parseCloudAiChartToolView } from "../view-block";
import { ChartFrame, type DrawnChart, type GroupSummary } from "./chart-frame";
import { aiChatMessages } from "./messages";

type Kind = CloudAiChartInput["kind"];

/** Draws a chart for display and fills its table from that drawing; null when nothing can be drawn. */
const drawChart = (input: CloudAiChartInput, locale: string): DrawnChart | null => {
  try {
    const rows = cloudAiChartRows(input, locale);
    // The chat lays the legend out in HTML: the renderer's single SVG row runs out of a phone-wide column.
    const snapshot = prepareChartSnapshot(cloudAiChartRenderOptions(input, locale, { legend: "outside" }), {
      key: ({ datum }) => cloudAiChartMarkKey(datum),
      tooltip: ({ datum }) => {
        const row = rows.add(datum);
        return cloudAiChartTooltip(rows.columns(), row, input.kind);
      },
      reference: ({ datum }) => cloudAiChartReferenceMark(input, datum),
    });
    return snapshot.marks.length > 0 ? { input, table: rows.table(), snapshot, legend: cloudAiChartLegend(input, locale) } : null;
  } catch {
    return null;
  }
};

/**
 * A group of small charts under one heading. Every chart frame stands with the title and height of its summary from
 * the first frame, while the group loads (`group` undefined) and when it cannot be drawn (`group` null); a chart that
 * cannot be drawn alone shows unavailable in its own frame. With `linkX`, one cursor follows the pointer or a tap
 * across every chart. A grid puts two charts side by side once the chat column has room for both.
 */
function ChartGroupFrame(props: { summary: GroupSummary; group: CloudGroupDescription | null | undefined; empty?: JSX.Element }) {
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

const groupSummary = (group: CloudGroupDescription): GroupSummary => ({
  title: group.title,
  subtitle: group.subtitle,
  linkX: group.linkX ?? false,
  layout: group.layout ?? "stack",
  charts: group.charts.map((chart) => ({ kind: chart.kind, title: chart.title, subtitle: chart.subtitle })),
});

/**
 * One `chart` tool call: the shared chart with its data table and Copy data, or a group of them. The block takes its
 * full size with its first frame and keeps it, up to 40rem for a tall single chart; switching to the table scrolls
 * inside the same height. A call whose
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
    if (value?.view !== "chart") return null;
    const { view: _view, ...description } = value;
    return drawChart(description, locale());
  });
  const group = createMemo(() => {
    const value = view();
    if (value?.view !== "group") return undefined;
    const { view: _view, ...description } = value;
    return { block: "group" as const, ...description };
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
            <ChartFrame title={value().input.title} subtitle={value().input.subtitle} kind={value().input.kind} chart={value()} grow />
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
export function CloudChartGroupView(props: { summary: GroupSummary; group: CloudGroupDescription | null | undefined }) {
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
