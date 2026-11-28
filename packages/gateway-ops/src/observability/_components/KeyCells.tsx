import { Cells, type SparkProps, Text } from "@k2b/ui/v2";
import { For } from "solid-js";

/**
 * One key number of a service page; `tone` marks a value that needs attention, `href` leads to where it is looked at,
 * `trend` is its real history as small bars.
 */
export type KeyCell = {
  icon: string;
  label: string;
  value: string;
  meta?: string;
  tone?: "warn" | "bad";
  href?: string;
  trend?: SparkProps;
};

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
            href={cell.href}
            trend={cell.trend}
          />
        )}
      </For>
    </Cells>
  );
}
