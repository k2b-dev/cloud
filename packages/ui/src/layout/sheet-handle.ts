import { suppressTextSelection } from "../internal/text-selection";
import { prefersReducedMotion } from "../motion";

export type SheetHandleOptions = {
  /**
   * The sheet the handle sits on, anchored at its bottom edge. It carries the current detent in `data-sheet-detent`.
   * Its container clips with `overflow: clip`, so the part that slides below the edge never scrolls into view.
   */
  sheet: HTMLElement;
  /** The detents' names, lowest first. The stylesheet gives each `[data-sheet-detent="…"]` its height. */
  detents: readonly string[];
  /** The detent the stylesheet draws while the sheet has no `data-sheet-detent`, such as in the server's markup. */
  initial: string;
  /** When a drag or a press sends the sheet to another detent, as it starts to glide, for example to rename the handle. */
  onChange?: (detent: string) => void;
  /**
   * Without it, a drag stops at the lowest detent; with it, a drag well below that detent slides the sheet out and
   * then asks to close. When the sheet is still shown afterwards, as when the owner asks first, it returns.
   */
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
/** Gliding to a detent and out, as `BottomSheet` does. */
const MOVE_MS = 280;
const CLOSE_MS = 220;
/** `--k2b-ease-out`: lands without overshoot. */
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

/**
 * Lets a sheet's handle drag it between detents. The handle stays a button: a press, by pointer, Enter or Space,
 * moves the sheet to the next detent up, and from the highest back to the lowest.
 *
 * The sheet moves by transform only, like `BottomSheet`. When a drag or a glide starts, its layout height is pinned
 * at the highest detent and a transform shows the visible part; the content inside does not lay out again on every
 * frame. A release glides to the detent nearest to where the pointer's speed would carry it; then the stylesheet's
 * height for that detent takes over in one step that looks the same. Reduced motion makes every glide instant. The
 * stylesheet owns every resting height, which keeps the server's first frame and a rotation correct without script;
 * it must not transition `height`.
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
  /** The painted height; an environment without layout, such as a test DOM, reports 0 and every move is instant. */
  const heightOf = () => Number(sheet.getBoundingClientRect().height) || 0;
  // Each detent's height as the stylesheet draws it now, while the transition is off.
  const measure = () => {
    const shown = sheet.dataset.sheetDetent;
    const heights = detents.map((detent) => {
      sheet.dataset.sheetDetent = detent;
      return heightOf();
    });
    if (shown === undefined) delete sheet.dataset.sheetDetent;
    else sheet.dataset.sheetDetent = shown;
    return heights;
  };

  /** While the sheet moves: its pinned layout height and how much of it shows above the edge. */
  let pinned: { heights: number[]; highest: number; visible: number } | undefined;
  let animation: Animation | undefined;
  /** The detent the running glide lands on; a press that catches it lets it land there. */
  let goal: string | undefined;
  const offset = (highest: number, visible: number) => `translate3d(0, ${highest - visible}px, 0)`;
  const put = (visible: number) => {
    if (!pinned) return;
    pinned.visible = visible;
    sheet.style.transform = offset(pinned.highest, visible);
  };
  /** Holds a gliding sheet where the eye sees it. */
  const stop = () => {
    const running = animation;
    if (!running || !pinned) return;
    const at = typeof DOMMatrixReadOnly === "function" ? new DOMMatrixReadOnly(getComputedStyle(sheet).transform).m42 : 0;
    animation = undefined;
    running.cancel();
    put(pinned.highest - at);
  };
  // When the owner hides the sheet while it moves, as a close button or navigation does, the move ends without
  // landing: no detent, no `onDismiss`, nothing left for the next opening.
  const hidden =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          if (pinned && sheet.getClientRects().length === 0) unpin();
        })
      : undefined;
  const pin = () => {
    if (pinned) {
      stop();
      return pinned;
    }
    const visible = heightOf();
    sheet.style.transition = "none";
    const heights = measure();
    pinned = { heights, highest: Math.max(visible, ...heights), visible };
    sheet.style.height = `${pinned.highest}px`;
    put(visible);
    hidden?.observe(sheet);
    return pinned;
  };
  const unpin = () => {
    animation?.cancel();
    animation = undefined;
    goal = undefined;
    delete sheet.dataset.sheetDragging;
    if (!pinned) return;
    pinned = undefined;
    hidden?.unobserve(sheet);
    sheet.style.removeProperty("height");
    sheet.style.removeProperty("transform");
    // The stylesheet's resting height arrives in this one layout, not through a transition.
    void sheet.offsetHeight;
    sheet.style.removeProperty("transition");
  };
  const glide = (to: number, ms: number, done: () => void) => {
    const state = pinned;
    if (!state) {
      done();
      return;
    }
    stop();
    const from = state.visible;
    const duration = prefersReducedMotion() || typeof sheet.animate !== "function" ? 0 : ms;
    if (!duration || Math.abs(from - to) < 0.5) {
      put(to);
      done();
      return;
    }
    const running = sheet.animate([{ transform: offset(state.highest, from) }, { transform: offset(state.highest, to) }], {
      duration,
      easing: EASE,
      fill: "forwards",
    });
    animation = running;
    // A cancelled glide rejects `finished`; nothing waits on it.
    running.finished.catch(() => {});
    running.onfinish = () => {
      if (animation !== running) return;
      animation = undefined;
      put(to);
      running.cancel();
      done();
    };
  };
  // The detent and its name change when the move starts, so assistive technology hears the press at once; the pinned
  // height keeps the stylesheet's new height from showing until the glide lands.
  const moveTo = (detent: string) => {
    const state = pin();
    goal = detent;
    set(detent);
    glide(state.heights[detents.indexOf(detent)] ?? state.visible, MOVE_MS, unpin);
  };
  const dismiss = () => {
    goal = undefined;
    glide(0, CLOSE_MS, () => {
      options.onDismiss?.();
      // The owner kept the sheet on screen: it returns to its lowest detent.
      if (sheet.isConnected && sheet.getClientRects().length > 0) moveTo(detents[0] ?? options.initial);
      else unpin();
    });
  };

  let drag:
    | {
        id: number;
        startY: number;
        /** The visible height when the drag took the sheet. */
        from: number;
        moved: boolean;
        y: number;
        time: number;
        /** Downward speed in px per ms. */
        speed: number;
        releaseSelection: () => void;
      }
    | undefined;
  let suppressClick = false;
  let resume: ReturnType<typeof setTimeout> | undefined;
  const finish = (commit: boolean, time?: number) => {
    const ended = drag;
    if (!ended) return;
    drag = undefined;
    ended.releaseSelection();
    if (handle.hasPointerCapture?.(ended.id)) handle.releasePointerCapture(ended.id);
    // A cancelled gesture sends no click: a cancelled drag returns, and a caught glide lands where it was going.
    if (!commit) {
      if (pinned) moveTo(ended.moved ? current() : (goal ?? current()));
      return;
    }
    // A press that caught a glide waits for its click, which switches as every press does; without one, as when the
    // pointer left the handle, the glide lands where it was going.
    if (!ended.moved) {
      if (pinned)
        resume = setTimeout(() => {
          if (pinned && !animation) moveTo(goal ?? current());
        });
      return;
    }
    suppressClick = true;
    const state = pinned;
    if (!state) return;
    delete sheet.dataset.sheetDragging;
    const speed = time !== undefined && time - ended.time > REST_MS ? 0 : ended.speed;
    const target = state.visible - speed * PROJECTION_MS;
    const lowest = state.heights[0] ?? 0;
    if (options.onDismiss && state.visible < lowest && target < lowest * DISMISS_SHARE) {
      dismiss();
      return;
    }
    let nearest = 0;
    for (const [index, height] of state.heights.entries())
      if (Math.abs(height - target) < Math.abs((state.heights[nearest] ?? 0) - target)) nearest = index;
    moveTo(detents[nearest] ?? options.initial);
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || event.isPrimary === false || drag) return;
    suppressClick = false;
    // A press during a glide catches the sheet where it is now.
    stop();
    handle.setPointerCapture?.(event.pointerId);
    drag = {
      id: event.pointerId,
      startY: event.clientY,
      from: 0,
      moved: false,
      y: event.clientY,
      time: event.timeStamp,
      speed: 0,
      releaseSelection: suppressTextSelection(event.pointerId),
    };
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    // A move without a change of position, such as one a release sends first, is no speed.
    if (event.clientY === drag.y) return;
    const distance = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(distance) < DRAG_THRESHOLD) return;
    if (!drag.moved) {
      drag.moved = true;
      goal = undefined;
      drag.from = pin().visible;
      sheet.dataset.sheetDragging = "";
    }
    const elapsed = event.timeStamp - drag.time;
    if (elapsed > 0) drag.speed = drag.speed * 0.4 + ((event.clientY - drag.y) / elapsed) * 0.6;
    drag.y = event.clientY;
    drag.time = event.timeStamp;
    const state = pinned;
    if (!state) return;
    const lowest = options.onDismiss ? 0 : Math.min(...state.heights);
    put(Math.min(state.highest, Math.max(lowest, drag.from - distance)));
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
    clearTimeout(resume);
    const index = detents.indexOf(current());
    moveTo(detents[index + 1 < detents.length ? index + 1 : 0] ?? options.initial);
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
    clearTimeout(resume);
    unpin();
    hidden?.disconnect();
    handle.style.touchAction = touchAction;
    handle.removeEventListener("pointerdown", down);
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", cancel);
    handle.removeEventListener("lostpointercapture", cancel);
    handle.removeEventListener("click", click);
  };
}
