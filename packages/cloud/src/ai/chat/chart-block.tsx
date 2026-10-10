import { ChartExplorer, type ChartExplorerColumn, prepareChartSnapshot, useLocale } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import {
  type CloudAiChartColumn,
  type CloudAiChartRow,
  cloudAiChartMarkKey,
  cloudAiChartRenderOptions,
  cloudAiChartTable,
} from "../chart-block";
import { CloudAiChartInputSchema } from "../default-tool-contracts";
import { aiChatMessages } from "./messages";

const tooltip = (columns: CloudAiChartColumn[], row: CloudAiChartRow | undefined) => {
  const [first, ...rest] = columns;
  const named = first && !first.numeric;
  return {
    title: named && row ? row.cells[first.id] : undefined,
    rows: (named ? rest : columns).map((column) => ({ label: column.label, value: row?.cells[column.id] ?? "" })),
  };
};

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
    const parsed = CloudAiChartInputSchema.safeParse(JSON.parse(source()));
    if (!parsed.success) return null;
    try {
      const table = cloudAiChartTable(parsed.data, locale());
      const rows = new Map(table.rows.map((row) => [row.key, row]));
      const snapshot = prepareChartSnapshot(cloudAiChartRenderOptions(parsed.data, locale()), {
        key: ({ datum }) => cloudAiChartMarkKey(datum),
        tooltip: ({ datum }) => tooltip(table.columns, rows.get(cloudAiChartMarkKey(datum))),
      });
      return { input: parsed.data, table, snapshot };
    } catch {
      return null;
    }
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
      {(value) => (
        <ChartExplorer
          title={value().input.title}
          description={value().input.subtitle ? <span class="text-sm text-secondary">{value().input.subtitle}</span> : undefined}
          height={value().input.kind === "sparkline" ? "8rem" : "18rem"}
          data={{ chart: value().snapshot, rows: value().table.rows }}
          columns={value().table.columns.map(
            (column): ChartExplorerColumn<CloudAiChartRow> => ({
              id: column.id,
              label: column.label,
              value: (row) => row.cells[column.id] ?? "",
              sortValue: (row) => row.values[column.id] ?? null,
              align: column.numeric ? "right" : "left",
            }),
          )}
          renderDetails={false}
        />
      )}
    </Show>
  );
}
