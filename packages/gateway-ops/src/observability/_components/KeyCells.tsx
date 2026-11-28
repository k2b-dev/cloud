import { Cells, Text } from "@k2b/ui/v2";
import { For } from "solid-js";

/** One key number of a service page; `tone` marks a value that needs attention. */
export type KeyCell = { icon: string; label: string; value: string; meta?: string; tone?: "warn" | "bad" };

/** 2–4 key numbers side by side, stacked on the phone. */
export function KeyCells(props: { cells: KeyCell[] }) {
  return (
    <Cells>
      <For each={props.cells}>
        {(cell) => (
          <Cells.Cell
            icon={cell.icon}
            label={cell.label}
            value={cell.tone ? <Text tone={cell.tone}>{cell.value}</Text> : cell.value}
            meta={cell.meta}
          />
        )}
      </For>
    </Cells>
  );
}
