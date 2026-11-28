import { ChartSnapshotView, useLocale } from "@k2b/ui";
import { Canvas, Empty, Failed, Section, Table } from "@k2b/ui/v2";
import { createSignal, type JSX, Show } from "solid-js";
import { gatewayOpsMessages } from "../../messages";
import type { OpsChart } from "./ops-chart";

/**
 * One server-prepared chart as a titled part of a v2 page. The drawing comes with the first HTML (no loading state);
 * "Show as table" shows the same values as a table, for exact numbers and for screen readers.
 */
export function OpsChartSection(props: {
  chart: OpsChart;
  icon: string;
  /** The text when there are no values. */
  empty: string;
  /** Height of the drawing in px. */
  height?: number;
  children?: JSX.Element;
}) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  const [table, setTable] = createSignal(false);
  const [selected, setSelected] = createSignal<string | null>(null);
  const rows = () => props.chart.table.rows;
  return (
    <Section
      icon={props.icon}
      title={props.chart.title}
      summary={props.chart.description}
      actions={
        props.chart.error || rows().length === 0
          ? undefined
          : [{ label: table() ? t().showAsChart : t().showAsTable, onClick: () => setTable(!table()) }]
      }
    >
      <Show
        when={table()}
        fallback={
          <Canvas label={props.chart.title} height={props.height ?? 240}>
            <Show when={!props.chart.error} fallback={<Failed text={props.chart.error ?? ""} onRetry={() => location.reload()} />}>
              <Show when={rows().length > 0} fallback={<Empty icon="chart-bar-off" text={props.empty} />}>
                <ChartSnapshotView
                  snapshot={props.chart.snapshot}
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
          rows={rows()}
          rowKey={(row) => row.key}
          columns={props.chart.table.columns.map((column, index) => ({
            title: column.title,
            align: column.end ? ("end" as const) : undefined,
            cell: (row: { cells: string[] }) => row.cells[index] ?? "—",
          }))}
        />
      </Show>
      {props.children}
    </Section>
  );
}
