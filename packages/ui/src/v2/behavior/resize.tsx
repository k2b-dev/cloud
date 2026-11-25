/**
 * Column grips for v2 (`Workspace` columns, column lines in content, table width grips): behaviour only, on core's
 * `Resizable`. Core does the drag, touch, Escape and the separator's ARIA, and the push at the minimum during a drag:
 * a column at its minimum pushes the next one, down to that one's minimum, and the drag is computed from the widths at
 * its start, so on the way back the columns grow again in reverse order.
 *
 * Ours, where core differs from the concept (source lines in the PR):
 * - px columns: core's layout is percent, so a sidebar would grow with the window. The widths in px are our state and
 *   reach core as a controlled layout, measured again when the group's width changes; only the last column takes it.
 * - keys: arrows 8 px (Shift 64 px), Home, End, and Enter back to the column's default, with the same push; a run of
 *   keys counts as one move from the widths at its start, so the columns unwind in reverse on the way back. Core's
 *   keys are percent steps from the current widths, and its Enter collapses a panel.
 *
 * Grips take no layout width (negative margins equal to their width): core sizes panels in percent of the whole group
 * but measures its space as the sum of the panels, so a grip with width would make every fixed column too wide.
 */
import { bindDrag } from "@ui-sdk/core";
import { resizable } from "@ui-sdk/core/resizable";
import { type Accessor, createSignal, type JSX, mergeProps, onCleanup, onMount, splitProps } from "solid-js";
import { isServer } from "solid-js/web";
import { type PartProps, type Props, part, partId, usePrimitive } from "./adapter";
import { useBehaviorMessages } from "./messages";
import { cascade, limits } from "./resize-cascade";

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

/** Runs an author's Solid handler: a function, or a `[handler, data]` pair. */
const callAuthor = (handler: unknown, event: Event) => {
  if (typeof handler === "function") handler(event);
  else if (Array.isArray(handler) && typeof handler[0] === "function") handler[0](handler[1], event);
};

/**
 * Resizable columns: every column but the last has `{ min, default }` in px, the last fills the rest and keeps its
 * `min`. `label(i)` names grip `i` for screen readers; `onWidthsChange` hears the widths (whole px) once a drag or a
 * key ends.
 */
export function createColumnResize(options: {
  columns: ColumnSize[];
  rest: { min: number };
  label: (index: number) => string;
  onWidthsChange?: (widths: number[]) => void;
}): ColumnResizeParts {
  const t = useBehaviorMessages();
  const [widths, setWidths] = createSignal(options.columns.map((column) => column.default));
  // The px the columns share, as core measures it: the panels, not the grips. 0 until measured (and on the server).
  const [space, setSpace] = createSignal(0);
  let root: HTMLElement | undefined;
  const mins = () => [...options.columns.map((column) => column.min), options.rest.min];
  /** Every column's width now, the last included. */
  const current = () => [...widths(), Math.max(0, space() - widths().reduce((sum, width) => sum + width, 0))];
  const commit = () => options.onWidthsChange?.(widths().map((width) => Math.round(width)));

  const layout = () => {
    if (!space()) return undefined;
    const fixed = widths().map((px) => (px / space()) * 100);
    return [...fixed, Math.max(0, 100 - fixed.reduce((sum, size) => sum + size, 0))];
  };
  // A drag changes the layout; a change of the group's own width does not (`resize`), so the px stay.
  const onLayoutChange = (next: number[], details: { reason: string }) => {
    if (details.reason === "resize" || !space()) return;
    setWidths(next.slice(0, -1).map((size) => (size / 100) * space()));
  };
  const handle = usePrimitive(resizable, () => ({ layout: layout(), onLayoutChange, onLayoutCommit: commit }));

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

  // A run of keys is one move from the widths at its start; a pointer press or leaving the grip ends it.
  let keyStart: number[] | undefined;
  let keyDelta = 0;
  const endKeys = () => {
    keyStart = undefined;
    keyDelta = 0;
  };
  const keydown = (event: KeyboardEvent, index: number) => {
    if (!space() || event.altKey || event.ctrlKey || event.metaKey) return;
    const start = keyStart ?? current();
    const bounds = limits(start, mins(), index);
    const step = event.shiftKey ? LARGE_STEP_PX : STEP_PX;
    let delta: number;
    if (event.key === "ArrowLeft") delta = Math.max(bounds.left, keyDelta - step);
    else if (event.key === "ArrowRight") delta = Math.min(bounds.right, keyDelta + step);
    else if (event.key === "Home") delta = bounds.left;
    else if (event.key === "End") delta = bounds.right;
    else if (event.key === "Enter") {
      const target = options.columns[index]?.default ?? start[index] ?? 0;
      delta = Math.min(bounds.right, Math.max(bounds.left, target - (start[index] ?? 0)));
    } else return;
    // Ours instead of core's keys, which preventDefault skips.
    event.preventDefault();
    keyStart = start;
    keyDelta = delta;
    setWidths(cascade(start, mins(), index, delta).slice(0, -1));
    commit();
  };

  return {
    widths,
    Root: (props) =>
      part(
        handle,
        "root",
        undefined,
        mergeProps(props, {
          ref: (el: HTMLElement) => {
            root = el;
            props.ref?.(el);
          },
        }),
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
      const [own, rest] = splitProps(props, ["index", "onKeyDown", "onPointerDown", "onBlur"]);
      const id = partId();
      return part(
        handle,
        "handle",
        () => ({ id }),
        mergeProps(rest, {
          "data-k2-grip": String(own.index),
          get "aria-label"() {
            return options.label(own.index);
          },
          // Core's aria-valuenow is percent; the width is spoken in px.
          get "aria-valuetext"() {
            return t().width({ px: Math.round(widths()[own.index] ?? 0) });
          },
          // The author's handler runs first and may preventDefault, as on every part.
          onKeyDown: (event: KeyboardEvent) => {
            callAuthor(own.onKeyDown, event);
            if (!event.defaultPrevented) keydown(event, own.index);
          },
          onPointerDown: (event: PointerEvent) => {
            callAuthor(own.onPointerDown, event);
            endKeys();
          },
          onBlur: (event: FocusEvent) => {
            callAuthor(own.onBlur, event);
            endKeys();
          },
        }),
        "div",
      );
    },
  };
}

// ── One grip, one column ─────────────────────────────────────────────────────────────────────────────────────────

export type GripOptions = {
  /** The grip's name, such as the column's: "Liste". */
  label: Accessor<string>;
  /** The column's width in px: what the grip says and moves. */
  value: Accessor<number>;
  onChange: (px: number) => void;
  /** The narrowest the column gets. */
  min: Accessor<number>;
  /** The width Enter puts the column back to: its default. */
  reset: Accessor<number>;
  /** 1: the column stands left of the grip and grows as the grip moves right; -1: it stands right of the grip. */
  direction: Accessor<1 | -1>;
  /**
   * The page now: the column's rendered width (its flex may hold it below its value) and the most it may take beside
   * the columns around it. Nothing while it is not laid out (hidden on the phone).
   */
  measure: (grip: HTMLElement) => { now: number; max: number } | undefined;
  /** The box whose size changes the room: the most is measured again when it resizes. */
  room: (grip: HTMLElement) => Element | null | undefined;
};

/**
 * The behaviour of one column grip (a seam between panes, a table head): a separator that moves the width of one
 * column in px, while the columns around it give way by their own layout. ui-sdk's `bindDrag` follows the pointer
 * (capture, a drag outside the window, Escape puts the width back, no click on release); keys move 8 px (Shift 64),
 * Home and End go to the minimum and the most, Enter back to the default. `Resizable` does not fit here: it lays out
 * a flex group in percent, and these columns are px widths in a stylesheet, one of them in a table.
 *
 * The server and the first render say the width and the minimum; the most depends on the window and comes once the
 * page is live, as `aria-valuemax`. Spread the result on the grip element.
 */
export function useGrip(options: GripOptions) {
  const t = useBehaviorMessages();
  const [max, setMax] = createSignal<number>();
  const [dragging, setDragging] = createSignal(false);
  let grip: HTMLElement | undefined;
  let stop: (() => void) | undefined;
  const read = () => {
    const now = grip && options.measure(grip);
    if (now) setMax(Math.round(Math.max(now.max, options.min())));
    return now;
  };
  const clamp = (px: number, most: number) => Math.round(Math.min(Math.max(px, options.min()), Math.max(most, options.min())));
  // where a move starts: the width the column has, which its flex may hold below its value
  const start = (now: number) => Math.min(options.value(), now);

  if (!isServer) {
    onMount(() => {
      read();
      const room = grip && options.room(grip);
      if (!room || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(() => read());
      observer.observe(room);
      onCleanup(() => observer.disconnect());
    });
    onCleanup(() => stop?.());
  }

  const keydown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const now = read();
    if (!now) return;
    const step = (event.shiftKey ? LARGE_STEP_PX : STEP_PX) * options.direction();
    let next: number;
    if (event.key === "ArrowLeft") next = start(now.now) - step;
    else if (event.key === "ArrowRight") next = start(now.now) + step;
    else if (event.key === "Home") next = options.min();
    else if (event.key === "End") next = now.max;
    else if (event.key === "Enter") next = options.reset();
    else return;
    event.preventDefault();
    options.onChange(clamp(next, now.max));
  };

  const pointerdown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary || !grip || stop) return;
    const now = read();
    if (!now) return;
    // no text selection while dragging; the focus still comes to the grip, so the keys go on from here
    event.preventDefault();
    grip.focus({ preventScroll: true });
    const before = options.value();
    const from = start(now.now);
    const x = event.clientX;
    setDragging(true);
    stop = bindDrag(grip, event, {
      cancelOnEscape: true,
      onMove: (sample) => options.onChange(clamp(from + (sample.x - x) * options.direction(), now.max)),
      onEnd: (_, canceled) => {
        stop = undefined;
        setDragging(false);
        if (canceled) options.onChange(before);
      },
    });
  };

  return {
    ref: (element: HTMLElement) => {
      grip = element;
    },
    role: "separator" as const,
    tabindex: "0",
    get "aria-label"() {
      return options.label();
    },
    "aria-orientation": "vertical" as const,
    get "aria-valuemin"() {
      return options.min();
    },
    get "aria-valuenow"() {
      return Math.round(options.value());
    },
    get "aria-valuemax"() {
      return max();
    },
    get "aria-valuetext"() {
      return t().width({ px: Math.round(options.value()) });
    },
    get "data-dragging"() {
      return dragging() ? "" : undefined;
    },
    onPointerDown: pointerdown,
    onKeyDown: keydown,
  };
}
