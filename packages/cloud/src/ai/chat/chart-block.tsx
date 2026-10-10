import { ChartExplorer, type ChartExplorerColumn, prepareChartSnapshot, useLocale } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import {
  type CloudAiChartColumn,
  type CloudAiChartRow,
  cloudAiChartMarkKey,
  cloudAiChartRenderOptions,
  cloudAiChartRows,
} from "../chart-block";
import { parseCloudAiChartInput } from "../default-tool-contracts";
import { aiChatMessages } from "./messages";

const tooltip = (columns: CloudAiChartColumn[], row: CloudAiChartRow) => {
  const [first, ...rest] = columns;
  const named = first && !first.numeric;
  return {
    title: named ? row.cells[first.id] : undefined,
    rows: (named ? rest : columns).map((column) => ({ label: column.label, value: row.cells[column.id] ?? "" })),
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
    // The tool schema drew the chart once to accept it; here it is drawn once more, for display, and the table is
    // filled from that drawing.
    const input = parseCloudAiChartInput(JSON.parse(source()));
    if (!input) return null;
    try {
      const rows = cloudAiChartRows(input, locale());
      const snapshot = prepareChartSnapshot(cloudAiChartRenderOptions(input, locale()), {
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
