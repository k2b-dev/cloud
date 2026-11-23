/**
 * Column grips for v2 (`Workspace` columns, column lines in content, table width grips): behaviour only, on core's
 * `Resizable`. Core does the drag, the keys (arrows, Shift, Home, End), touch, Escape, and the push at the minimum: a
 * column at its minimum pushes the next one, down to that one's minimum, and a drag is computed from the widths at its
 * start, so on the way back the columns grow again in reverse order.
 *
 * Three things core does not do, so they are ours (see the source lines in the PR):
 * - px columns: core's layout is percent, so a sidebar would grow with the window. The widths in px are our state and
 *   reach core as a controlled layout, measured again when the group's width changes; only the last column takes it.
 * - px steps: core's `step` is percent; 8 px (Shift: 64 px) are converted with the measured width.
 * - Enter puts the column left of the grip back to its default; core's Enter collapses a panel.
 */
import { createResizableController, resizable } from "@ui-sdk/core/resizable";
import { type Accessor, createSignal, type JSX, onCleanup, onMount, splitProps } from "solid-js";
import { isServer } from "solid-js/web";
import { type PartProps, type Props, part, partId, usePrimitive } from "./adapter";
import { useBehaviorMessages } from "./messages";

export type ColumnSize = { min: number; default: number };

const STEP_PX = 8;
const LARGE_STEP_PX = 64;

export type ColumnResizeParts = {
  /** The group around the columns and grips. */
  Root: (props: PartProps) => JSX.Element;
  /** Column `index`; the column after the last fixed one (`index === columns.length`) fills the rest. */
  Panel: (props: PartProps & { index: number }) => JSX.Element;
  /** The grip right of column `index`. */
  Grip: (props: PartProps & { index: number }) => JSX.Element;
  /** The fixed columns' widths in px. */
  widths: Accessor<number[]>;
};

/**
 * Resizable columns: every column but the last has `{ min, default }` in px, the last fills the rest and keeps its
 * `min`. `label(i)` names grip `i` for screen readers; `onWidthsChange` hears the widths once a drag or keys end.
 */
export function createColumnResize(options: {
  columns: ColumnSize[];
  rest: { min: number };
  label: (index: number) => string;
  onWidthsChange?: (widths: number[]) => void;
}): ColumnResizeParts {
  const t = useBehaviorMessages();
  const controller = createResizableController();
  const [widths, setWidths] = createSignal(options.columns.map((column) => column.default));
  // The px the columns share, as core measures it: the panels, not the grips. 0 until measured (and on the server).
  const [space, setSpace] = createSignal(0);
  let root: HTMLElement | undefined;

  const percent = (px: number) => (px / space()) * 100;
  const layout = () => {
    if (!space()) return undefined;
    const fixed = widths().map(percent);
    return [...fixed, Math.max(0, 100 - fixed.reduce((sum, size) => sum + size, 0))];
  };
  // A drag or a key changes the layout; a change of the group's own width does not (`resize`), so the px stay.
  const onLayoutChange = (next: number[], details: { reason: string }) => {
    if (details.reason === "resize" || !space()) return;
    setWidths(next.slice(0, -1).map((size) => (size / 100) * space()));
  };
  const onLayoutCommit = () => options.onWidthsChange?.(widths());

  const handle = usePrimitive(resizable, () => ({
    controller,
    layout: layout(),
    step: space() ? percent(STEP_PX) : undefined,
    largeStep: space() ? percent(LARGE_STEP_PX) : undefined,
    onLayoutChange,
    onLayoutCommit,
  }));

  const measure = () => {
    if (!root) return;
    let total = 0;
    for (const panel of root.querySelectorAll<HTMLElement>(':scope > [data-slot="resizable-panel"]'))
      total += panel.getBoundingClientRect().width;
    setSpace(total);
  };
  if (!isServer) {
    onMount(() => {
      measure();
      if (!root || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(measure);
      observer.observe(root);
      onCleanup(() => observer.disconnect());
    });
  }

  return {
    widths,
    Root: (props) =>
      part(
        handle,
        "root",
        undefined,
        {
          ...props,
          ref: (el: HTMLElement) => {
            root = el;
          },
        },
        "div",
      ),
    Panel: (props) => {
      const [own, rest] = splitProps(props, ["index"]);
      // Core keys panels by id; panels without one would all be the same panel.
      const id = partId();
      const panelProps = (): Props => {
        const column = options.columns[own.index];
        return column ? { id, defaultSize: `${column.default}px`, minSize: `${column.min}px` } : { id, minSize: `${options.rest.min}px` };
      };
      return part(handle, "panel", panelProps, rest, "div");
    },
    Grip: (props) => {
      const [own, rest] = splitProps(props, ["index"]);
      const id = partId();
      return part(
        handle,
        "handle",
        () => ({ id }),
        {
          ...rest,
          "data-k2-grip": String(own.index),
          get "aria-label"() {
            return options.label(own.index);
          },
          // Core's aria-valuenow is percent; the width is spoken in px.
          get "aria-valuetext"() {
            return t().width({ px: Math.round(widths()[own.index] ?? 0) });
          },
          onKeyDown: (event: KeyboardEvent) => {
            const column = options.columns[own.index];
            if (event.key !== "Enter" || !column) return;
            // Runs before core's Enter (collapse), which preventDefault skips.
            event.preventDefault();
            controller.resize(own.index, `${column.default}px`);
          },
        },
        "div",
      );
    },
  };
}
