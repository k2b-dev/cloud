/**
 * Column grips for v2 (the seams of `Workspace` and `Pane.Split`, the column grips of a table head): behaviour only.
 * ui-sdk's `bindDrag` follows the pointer; the keys, the px widths and the separator's values are ours, because the
 * columns are px widths in the stylesheet that their neighbours give way to, which `Resizable` (a flex group in
 * percent) does not model.
 */
import { bindDrag } from "@ui-sdk/core";
import { type Accessor, createSignal, onCleanup, onMount } from "solid-js";
import { isServer } from "solid-js/web";
import { useBehaviorMessages } from "./messages";

const STEP_PX = 8;
const LARGE_STEP_PX = 64;

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
