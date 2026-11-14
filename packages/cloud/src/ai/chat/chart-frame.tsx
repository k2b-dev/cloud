import {
  ChartExplorer,
  type ChartExplorerColumn,
  type ChartLegendEntry,
  type ChartSnapshot,
  type createChartCursor,
  useLocale,
} from "@k2b/ui";
import type { JSX } from "solid-js";
import type { CloudAiChartRow, CloudAiChartTable } from "../chart-block";
import type { CloudAiChartInput } from "../default-tool-contracts";
import { aiChatMessages } from "./messages";

type Kind = CloudAiChartInput["kind"];
export type DrawnChart = { input: CloudAiChartInput; table: CloudAiChartTable; snapshot: ChartSnapshot; legend: ChartLegendEntry[] };
/**
 * Single values and trends need less room than a plot with axes. Bar gauges hold at most eight 28-unit rows of the
 * 280-unit drawing; at 12rem a row is still taller than its text.
 */
export const chartHeight = (kind: Kind) =>
  kind === "sparkline" ? "8rem" : kind === "stat" ? "10rem" : kind === "barGauge" ? "12rem" : "18rem";
/** A drawing taller than the usual 280 units, such as many bar rows, grows its frame up to 40rem and scrolls inside. */
const grownHeight = (kind: Kind, chart: DrawnChart | null) =>
  chart && chart.snapshot.height > 280 ? `min(40rem, max(${chartHeight(kind)}, ${chart.snapshot.height}px))` : chartHeight(kind);

export function ChartFrame(props: {
  title: string;
  subtitle?: string;
  kind: Kind;
  chart: DrawnChart | null;
  empty?: JSX.Element;
  cursor?: ReturnType<typeof createChartCursor>;
  /** A chart of a titled group: its title sits one heading level and one size below the group's. */
  nested?: boolean;
  /**
   * The frame takes the drawing's height (`grownHeight`). Only for a drawing present with the first frame: a frame
   * that waits for its data keeps the kind's height, so the data never moves the chat.
   */
  grow?: boolean;
  /** The first-use tool placeholder reserves the same renderer-derived height. */
  height?: number;
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
      height={
        props.height !== undefined && props.height > 280
          ? `min(40rem, max(${chartHeight(props.kind)}, ${props.height}px))`
          : props.grow
            ? grownHeight(props.kind, props.chart)
            : chartHeight(props.kind)
      }
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

export type GroupSummary = {
  title: string;
  subtitle?: string;
  linkX: boolean;
  layout: "stack" | "grid";
  charts: { kind: Kind; title: string; subtitle?: string }[];
};
