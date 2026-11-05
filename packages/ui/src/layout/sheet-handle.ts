import { suppressTextSelection } from "../internal/text-selection";

export type SheetHandleOptions = {
  /** The sheet the handle sits on. It carries the current detent in `data-sheet-detent`. */
  sheet: HTMLElement;
  /** The detents' names, lowest first. The stylesheet gives each `[data-sheet-detent="…"]` its height. */
  detents: readonly string[];
  /** The detent the stylesheet draws while the sheet has no `data-sheet-detent`, such as in the server's markup. */
  initial: string;
  /** After a drag or a press moved the sheet to another detent, for example to rename the handle. */
  onChange?: (detent: string) => void;
  /** Without it, a drag stops at the lowest detent; with it, a drag well below that detent asks to close. */
  onDismiss?: () => void;
};

/** Below this distance a press stays a press and the click after it moves the sheet. */
const DRAG_THRESHOLD = 6;
/** How far ahead the release projects the pointer's speed, so a short flick reaches the next detent. */
const PROJECTION_MS = 120;
/** A pointer that rested this long before it lifted carries no speed into the snap. */
const REST_MS = 80;
/** A release below this share of the lowest detent dismisses, when the sheet may be dismissed. */
const DISMISS_SHARE = 0.6;

/**
 * Lets a sheet's handle drag it between detents. The handle stays a button: a press, by pointer, Enter or Space,
 * moves the sheet to the next detent up, and from the highest back to the lowest. A drag follows the pointer with an
 * inline height and, on release, snaps to the detent nearest to where the pointer's speed would carry it. The snap
 * animates with the sheet's own height transition, so reduced motion makes it instant. The stylesheet owns every
 * resting height, which keeps the server's first frame and a rotation correct without script; the handle measures
 * them when a drag starts.
 */
export function attachSheetHandle(handle: HTMLElement, options: SheetHandleOptions): () => void {
  const { sheet, detents } = options;
  const current = () => {
    const detent = sheet.dataset.sheetDetent;
    return detent && detents.includes(detent) ? detent : options.initial;
  };
  const set = (detent: string) => {
    const changed = detent !== current();
    sheet.dataset.sheetDetent = detent;
    if (changed) options.onChange?.(detent);
  };
  // Each detent's height as the stylesheet draws it now; the caller has turned the transition off.
  const measure = () => {
    const shown = sheet.dataset.sheetDetent;
    const heights = detents.map((detent) => {
      sheet.dataset.sheetDetent = detent;
      return sheet.getBoundingClientRect().height;
    });
    if (shown === undefined) delete sheet.dataset.sheetDetent;
    else sheet.dataset.sheetDetent = shown;
    return heights;
  };
  let drag:
    | {
        id: number;
        startY: number;
        startHeight: number;
        heights: number[];
        height: number;
        moved: boolean;
        y: number;
        time: number;
        /** Downward speed in px per ms. */
        speed: number;
        releaseSelection: () => void;
      }
    | undefined;
  let suppressClick = false;
  // Dropping the inline height and transition together lets the stylesheet's transition carry the sheet to its detent.
  const release = () => {
    sheet.style.removeProperty("height");
    sheet.style.removeProperty("transition");
    delete sheet.dataset.sheetDragging;
  };
  const finish = (commit: boolean, time?: number) => {
    const ended = drag;
    if (!ended) return;
    drag = undefined;
    ended.releaseSelection();
    if (handle.hasPointerCapture?.(ended.id)) handle.releasePointerCapture(ended.id);
    // A cancelled gesture sends no click; only a finished drag's click must not move the sheet again.
    if (!ended.moved || !commit) {
      release();
      return;
    }
    suppressClick = true;
    const speed = time !== undefined && time - ended.time > REST_MS ? 0 : ended.speed;
    const target = ended.height - speed * PROJECTION_MS;
    const lowest = ended.heights[0] ?? 0;
    if (options.onDismiss && ended.height < lowest && target < lowest * DISMISS_SHARE) {
      release();
      options.onDismiss();
      return;
    }
    let nearest = 0;
    for (const [index, height] of ended.heights.entries())
      if (Math.abs(height - target) < Math.abs((ended.heights[nearest] ?? 0) - target)) nearest = index;
    release();
    set(detents[nearest] ?? options.initial);
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || event.isPrimary === false || drag) return;
    suppressClick = false;
    // A press during a snap starts from where the sheet is now.
    const startHeight = sheet.getBoundingClientRect().height;
    sheet.style.transition = "none";
    const heights = measure();
    sheet.style.height = `${startHeight}px`;
    handle.setPointerCapture?.(event.pointerId);
    drag = {
      id: event.pointerId,
      startY: event.clientY,
      startHeight,
      heights,
      height: startHeight,
      moved: false,
      y: event.clientY,
      time: event.timeStamp,
      speed: 0,
      releaseSelection: suppressTextSelection(event.pointerId),
    };
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    // A move without a change of height, such as one a release sends first, is no speed.
    if (event.clientY === drag.y) return;
    const distance = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(distance) < DRAG_THRESHOLD) return;
    if (!drag.moved) {
      drag.moved = true;
      sheet.dataset.sheetDragging = "";
    }
    const elapsed = event.timeStamp - drag.time;
    if (elapsed > 0) drag.speed = drag.speed * 0.4 + ((event.clientY - drag.y) / elapsed) * 0.6;
    drag.y = event.clientY;
    drag.time = event.timeStamp;
    const highest = Math.max(...drag.heights);
    const lowest = options.onDismiss ? 0 : Math.min(...drag.heights);
    drag.height = Math.min(highest, Math.max(lowest, drag.startHeight - distance));
    sheet.style.height = `${drag.height}px`;
  };
  const up = (event: PointerEvent) => {
    if (drag && event.pointerId === drag.id) finish(true, event.timeStamp);
  };
  const cancel = (event: PointerEvent) => {
    if (drag && event.pointerId === drag.id) finish(false);
  };
  const click = (event: MouseEvent) => {
    // The click a drag's release produces does not move the sheet again; a keyboard click has no detail.
    if (suppressClick && event.detail !== 0) {
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    suppressClick = false;
    const index = detents.indexOf(current());
    set(detents[index + 1 < detents.length ? index + 1 : 0] ?? options.initial);
  };
  const touchAction = handle.style.touchAction;
  // The browser must not take the drag for a scroll or a page swipe.
  handle.style.touchAction = "none";
  handle.addEventListener("pointerdown", down);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", cancel);
  handle.addEventListener("lostpointercapture", cancel);
  handle.addEventListener("click", click);
  return () => {
    finish(false);
    handle.style.touchAction = touchAction;
    handle.removeEventListener("pointerdown", down);
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", cancel);
    handle.removeEventListener("lostpointercapture", cancel);
    handle.removeEventListener("click", click);
  };
}
