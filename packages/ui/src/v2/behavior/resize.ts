/**
 * Column grips for v2 (`Workspace` columns, column lines in content, table width grips): behaviour only.
 *
 * Core's `Resizable` works in percent, takes Enter for collapsing, and moves only the two panels beside a handle, so
 * the concept's grip is ours, on core's `bindDrag` for the pointer:
 * - every column but the last has `{ min, default }` in px; the last fills the rest and keeps its `min`;
 * - a column that reaches its minimum pushes the next one, down to that one's minimum, in both directions; each move is
 *   computed from the widths at its start, so on the way back the columns grow again in reverse order;
 * - keys on the focused grip: arrows 8 px, with Shift 64 px, Home and End to the limits, Enter puts the column left of
 *   the grip back to its default; a run of keys counts as one move until the grip loses focus;
 * - Escape during a pointer drag puts every column back.
 */
import { bindDrag } from "@ui-sdk/core";
import { createSignal, onCleanup } from "solid-js";
import { useBehaviorMessages } from "./messages";
import { cascade } from "./resize-cascade";

export type ColumnSize = { min: number; default: number };

const STEP_PX = 8;
const LARGE_STEP_PX = 64;

/**
 * Widths of resizable columns and the behaviour of the grips between them. Render column `i` with `widths()[i]` px
 * (the last column fills the rest), put `container` on the element around them, and spread `grip(i)` on the grip
 * right of column `i`. `label(i)` names the grip for screen readers.
 */
export function createColumnResize(options: {
  columns: ColumnSize[];
  rest: { min: number };
  label: (index: number) => string;
  onWidthsChange?: (widths: number[]) => void;
}) {
  const t = useBehaviorMessages();
  const [widths, setWidths] = createSignal(options.columns.map((column) => column.default));
  const [dragging, setDragging] = createSignal<number | null>(null);
  const mins = () => [...options.columns.map((column) => column.min), options.rest.min];
  let container: HTMLElement | undefined;
  let stop: (() => void) | undefined;
  onCleanup(() => stop?.());

  /** Every column's width now, the last included: what the container holds beside the fixed columns. */
  const current = () => {
    const fixed = widths();
    const total = container?.clientWidth ?? 0;
    return [...fixed, Math.max(0, total - fixed.reduce((sum, width) => sum + width, 0))];
  };
  const apply = (all: number[]) => {
    const next = all.slice(0, -1).map((width) => Math.round(width));
    if (next.every((width, index) => width === widths()[index])) return;
    setWidths(next);
    options.onWidthsChange?.(next);
  };
  /** The furthest the grip can travel each way from `start`. */
  const limits = (start: number[], grip: number) => {
    const all = mins();
    const sum = (from: number, to: number) =>
      start.slice(from, to).reduce((total, width, index) => total + Math.max(0, width - (all[from + index] ?? 0)), 0);
    return { left: -sum(0, grip + 1), right: sum(grip + 1, start.length) };
  };

  // A run of keys is one move from the widths at its start, so the cascade unwinds in reverse on the way back.
  let keyStart: number[] | undefined;
  let keyDelta = 0;

  const grip = (index: number) => ({
    role: "separator" as const,
    "aria-orientation": "vertical" as const,
    get "aria-label"() {
      return options.label(index);
    },
    get "aria-valuenow"() {
      return widths()[index];
    },
    get "aria-valuemin"() {
      return options.columns[index]?.min;
    },
    // The maximum depends on the container's width, which the server does not know, so there is no `aria-valuemax`
    // (ARIA's default of 100 would be read as the limit); the width is spoken in px instead.
    get "aria-valuetext"() {
      return t().width({ px: widths()[index] ?? 0 });
    },
    tabindex: 0,
    get "data-dragging"() {
      return dragging() === index ? "" : undefined;
    },
    onPointerDown: (event: PointerEvent) => {
      if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return;
      event.preventDefault();
      const start = current();
      const from = event.clientX;
      // A pointer move ends a run of keys: the next key starts from the widths the drag left.
      keyStart = undefined;
      keyDelta = 0;
      stop = bindDrag(event.currentTarget, event, {
        cancelOnEscape: true,
        onStart: () => {
          setDragging(index);
        },
        onMove: ({ x }) => apply(cascade(start, mins(), index, x - from)),
        onEnd: (_event, canceled) => {
          stop = undefined;
          setDragging(null);
          if (canceled) apply(start);
        },
      });
    },
    onKeyDown: (event: KeyboardEvent) => {
      keyStart ??= current();
      const start = keyStart;
      const bounds = limits(start, index);
      const step = event.shiftKey ? LARGE_STEP_PX : STEP_PX;
      if (event.key === "ArrowLeft") keyDelta = Math.max(bounds.left, keyDelta - step);
      else if (event.key === "ArrowRight") keyDelta = Math.min(bounds.right, keyDelta + step);
      else if (event.key === "Home") keyDelta = bounds.left;
      else if (event.key === "End") keyDelta = bounds.right;
      else if (event.key === "Enter") {
        const target = options.columns[index]?.default ?? start[index] ?? 0;
        keyDelta = Math.min(bounds.right, Math.max(bounds.left, target - (start[index] ?? 0)));
      } else return;
      event.preventDefault();
      apply(cascade(start, mins(), index, keyDelta));
    },
    onBlur: () => {
      keyStart = undefined;
      keyDelta = 0;
    },
  });

  return {
    widths,
    dragging,
    grip,
    container: (el: HTMLElement) => {
      container = el;
    },
  };
}
