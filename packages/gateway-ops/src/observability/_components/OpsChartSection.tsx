import { ChartSnapshotView, useLocale } from "@k2b/ui";
import { Canvas, Empty, Failed, Section, Table } from "@k2b/ui/v2";
import { createSignal, type JSX, Show } from "solid-js";
import type { OperationalChart } from "../../frontend/operational-charts";
import { gatewayOpsMessages } from "../../messages";

/** Height of the drawing: a bar gauge lists up to ten rows, a line chart needs less. */
const heightOf = (chart: OperationalChart) => (chart.data.chart.kind === "barGauge" ? 320 : 240);

/**
 * One server-prepared chart as a titled part of a v2 page. The drawing comes with the first HTML (no loading state);
 * "Show as table" shows the same rows as a table, for reading exact values and for screen readers.
 */
export function OpsChartSection(props: {
  chart: OperationalChart;
  icon: string;
  /** The text when there are no rows. */
  empty: string;
  /** What follows the drawing in the section, such as links to filter by a bar. */
  children?: JSX.Element;
}) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  const [table, setTable] = createSignal(false);
  const [selected, setSelected] = createSignal<string | null>(null);
  const line = () => props.chart.data.chart.kind === "line";
  return (
    <Section
      icon={props.icon}
      title={props.chart.title}
      summary={props.chart.description}
      actions={
        props.chart.error || props.chart.data.rows.length === 0
          ? undefined
          : [{ label: table() ? t().showAsChart : t().showAsTable, onClick: () => setTable(!table()) }]
      }
    >
      <Show
        when={table()}
        fallback={
          <Canvas label={props.chart.title} height={heightOf(props.chart)}>
            <Show when={!props.chart.error} fallback={<Failed text={props.chart.error ?? ""} onRetry={() => location.reload()} />}>
              <Show when={props.chart.data.rows.length > 0} fallback={<Empty icon="chart-bar-off" text={props.empty} />}>
                <ChartSnapshotView
                  snapshot={props.chart.data.chart}
                  selectedKey={selected()}
                  onSelect={(key) => setSelected(selected() === key ? null : key)}
                  style={{ height: "100%" }}
                />
              </Show>
            </Show>
          </Canvas>
        }
      >
        <Table
          label={props.chart.title}
          rows={[...props.chart.data.rows]}
          rowKey={(row) => row.key}
          columns={[
            ...(line()
              ? [
                  {
                    title: t().time,
                    width: { min: 140, default: 180 },
                    cell: (row: (typeof props.chart.data.rows)[number]) =>
                      row.at === undefined ? "—" : `${new Date(row.at).toLocaleString(locale(), { timeZone: "UTC" })} UTC`,
                  },
                ]
              : []),
            { title: t().series, width: { min: 140, default: 240 }, cell: (row) => row.label },
            { title: t().chartValue, align: "end" as const, cell: (row) => row.formatted },
          ]}
        />
      </Show>
      {props.children}
    </Section>
  );
}
