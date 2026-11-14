import { prefersReducedMotion } from "../motion";

export type SheetDetent = "half" | "full";

export type SheetMotionOptions = {
  /** The sheet's dialog element, `.k2b-bottom-sheet-frame`. */
  frame: HTMLElement;
  /** The panel inside the frame that holds the header, the body, and the footer. */
  panel: HTMLElement;
  handle: HTMLElement | null;
  /** Opens at half height and rests at half or full height; without, the sheet rests at its content's height. */
  detents: boolean;
  /** Whether a drag or the handle may close the sheet now. */
  canDismiss: () => boolean;
  /** Asks the owner to close, after the sheet slid out. When the owner keeps it, the sheet slides back. */
  dismiss: () => void | Promise<void>;
  onDetent?: (detent: SheetDetent) => void;
};

export type SheetMotion = {
  /** Once the dialog is open: measures the sheet and slides it in. */
  open: () => void;
  /** The handle's press: the other detent, or closing without detents. */
  press: () => void;
  /** Moves between detents from the keyboard. */
  step: (direction: "up" | "down") => void;
  dispose: () => void;
};

/** Opening and moving between detents, and closing, as in the approved prototype. */
const MOVE_MS = 280;
const CLOSE_MS = 220;
/** `--k2b-ease-out`: lands without overshoot. */
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
/** Half height is this share of the viewport; full height is the stylesheet's `92dvh` frame. */
const HALF_SHARE = 0.5;
/** Closed, the sheet waits this far below the edge, its shadow included. */
const OFFSCREEN_PX = 24;
/** A drag starts after this distance; below it a press stays a press. */
const DRAG_PX = 6;
/** Faster than this (px/ms), a release goes one detent in its direction, or closes below the lowest one. */
const STEP_SPEED = 0.4;
/** Faster than this downwards, a release closes from anywhere. */
const FLICK_SPEED = 2;
/** Below the lowest rest, a release this far down closes. */
const CLOSE_SHARE = 0.25;
/** A slow release projects the pointer this far ahead and picks the nearest detent. */
const PROJECTION_MS = 150;
/** A pointer that rested this long before it lifted carries no speed. */
const REST_MS = 80;
/** A finger that scrolled a list this recently keeps scrolling instead of dragging the sheet. */
const SCROLL_LOCK_MS = 100;
/** From this width an adaptive sheet is a centred dialog and does not move. */
const DIALOG_QUERY = "(min-width: 48rem)";

type SheetOwner = { suspend: () => void; resume: () => void };
/** The sheets on one dialog element, the visible one last. */
const sheetOwners = new WeakMap<HTMLElement, SheetOwner[]>();

const scrollerIn = (target: Element | null, panel: HTMLElement): HTMLElement | null => {
  for (let node = target; node && node !== panel; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
};

/**
 * Moves a bottom sheet with transform and opacity only. Its layout height is fixed when it opens (the content's height,
 * or the full height with detents) and never animates; the sheet slides by `--k2b-sheet-y`, the footer stays on the
 * screen's edge between half and full height by `--k2b-sheet-footer-y`, and the backdrop dims by `--k2b-sheet-dim`.
 * A glide is a Web Animation that ends on exactly those values, so it lands on its detent without a settle. A drag on
 * the handle or the header follows the pointer; a finger anywhere follows too, except where a list still scrolls.
 */
export function attachSheetMotion(options: SheetMotionOptions): SheetMotion {
  const { frame, panel, handle, detents } = options;
  const doc = frame.ownerDocument;
  const view = doc.defaultView;
  let layoutHeight = 0;
  let half = 0;
  let visible = 0;
  let detent: SheetDetent = detents ? "half" : "full";
  let animations: Animation[] = [];
  let closing = false;
  let disposed = false;
  /** A resize that arrived during a drag or a close; the next move measures first. */
  let stale = false;
  let lastScroll = -Infinity;
  const dialogQuery = typeof view?.matchMedia === "function" ? view.matchMedia(DIALOG_QUERY) : null;
  const moving = () => !(frame.classList.contains("is-adaptive") && dialogQuery?.matches);
  const footer = () => panel.querySelector<HTMLElement>(":scope > .k2b-panel-dialog__footer:last-child");

  // dialogCore shows every level of its stack in one dialog element: only the sheet on top may style and move it.
  const owners = sheetOwners.get(frame) ?? [];
  sheetOwners.set(frame, owners);
  const owner: SheetOwner = { suspend: () => suspend(), resume: () => resume() };
  const owning = () => !disposed && owners.at(-1) === owner;
  const claim = () => {
    frame.dataset.sheetMotion = "";
    if (detents) frame.dataset.sheetDetents = "";
    else delete frame.dataset.sheetDetents;
    if (detents) frame.dataset.sheetDetent = detent;
    else delete frame.dataset.sheetDetent;
  };
  /** Leaves the dialog element as the stylesheet draws it, for the level that shows next. */
  const vacate = () => {
    for (const animation of animations) animation.cancel();
    animations = [];
    for (const property of ["--k2b-sheet-y", "--k2b-sheet-dim", "--k2b-sheet-footer-y"]) frame.style.removeProperty(property);
    delete frame.dataset.sheetMotion;
    delete frame.dataset.sheetDetents;
    delete frame.dataset.sheetDetent;
    delete frame.dataset.sheetDragging;
  };

  const measure = () => {
    layoutHeight = frame.offsetHeight;
    half = detents ? Math.min(layoutHeight, Math.round((view?.innerHeight ?? layoutHeight) * HALF_SHARE)) : layoutHeight;
  };
  const rest = (at: SheetDetent) => (at === "half" ? half : layoutHeight);
  const lowest = () => (detents ? half : layoutHeight);
  /** Between half and full height the footer stays on the screen's edge; below half it rides along. */
  const footerAt = (seen: number) => Math.max(0, half - seen) - (layoutHeight - seen);
  const dimAt = (seen: number) => (lowest() > 0 ? Math.max(0, Math.min(1, seen / lowest())) : 1);
  const frameTransform = (seen: number) => `translate3d(-50%, ${layoutHeight - seen}px, 0)`;
  const footerTransform = (seen: number) => `translate3d(0, ${footerAt(seen)}px, 0)`;

  const put = (seen: number) => {
    if (!owning()) return;
    visible = seen;
    frame.style.setProperty("--k2b-sheet-y", `${layoutHeight - seen}px`);
    frame.style.setProperty("--k2b-sheet-dim", String(dimAt(seen)));
    if (detents) frame.style.setProperty("--k2b-sheet-footer-y", `${footerAt(seen)}px`);
  };

  /** A drag that catches a gliding sheet continues from where the eye sees it. */
  const stop = () => {
    if (!animations.length) return;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(frame).transform);
    for (const animation of animations) animation.cancel();
    animations = [];
    put(layoutHeight - matrix.m42);
  };

  const glide = (to: number, ms: number, done?: () => void) => {
    if (!owning()) return;
    stop();
    const from = visible;
    // A centred dialog never takes the sheet's coordinates, not even for one frame.
    const duration = prefersReducedMotion() || !moving() || layoutHeight === 0 || typeof frame.animate !== "function" ? 0 : ms;
    if (!duration || from === to) {
      put(to);
      done?.();
      return;
    }
    // Footer and backdrop bend at half height; a keyframe there keeps all three on the same curve.
    const at = detents && (from - half) * (to - half) < 0 ? (half - from) / (to - from) : null;
    const keyframes = <T extends Keyframe>(at_: (seen: number) => T): Keyframe[] =>
      at === null
        ? [at_(from), at_(to)]
        : [
            { ...at_(from), offset: 0 },
            { ...at_(half), offset: at },
            { ...at_(to), offset: 1 },
          ];
    const timing: KeyframeAnimationOptions = { duration, easing: EASE, fill: "forwards" };
    animations = [
      frame.animate(
        keyframes((seen) => ({ transform: frameTransform(seen) })),
        timing,
      ),
    ];
    const ownFooter = detents ? footer() : null;
    if (ownFooter)
      animations.push(
        ownFooter.animate(
          keyframes((seen) => ({ transform: footerTransform(seen) })),
          timing,
        ),
      );
    try {
      animations.push(
        frame.animate(
          keyframes((seen) => ({ opacity: dimAt(seen) })),
          { ...timing, pseudoElement: "::backdrop" },
        ),
      );
    } catch {
      // An engine that cannot animate the backdrop shows it at its resting dim.
    }
    const own = animations;
    own[0]!.onfinish = () => {
      if (animations !== own) return;
      put(to);
      for (const animation of own) animation.cancel();
      animations = [];
      done?.();
    };
  };

  const settle = (at: SheetDetent) => {
    detent = at;
    if (detents) frame.dataset.sheetDetent = at;
    options.onDetent?.(at);
  };
  const go = (at: SheetDetent) => {
    // A rotation or the keyboard changed the sizes while the sheet moved: the next rest uses the new ones.
    if (stale) {
      stale = false;
      measure();
    }
    glide(rest(at), MOVE_MS, () => settle(at));
  };
  /** At rest the sheet's content may have grown or shrunk; a move starts from its current size. */
  const remeasureAtRest = () => {
    if (animations.length || drag || closing) return;
    measure();
    visible = rest(detent);
  };

  const close = () => {
    if (closing || disposed || !owning()) return;
    if (!options.canDismiss()) {
      go(detent);
      return;
    }
    remeasureAtRest();
    closing = true;
    glide(-OFFSCREEN_PX, CLOSE_MS, () => {
      void Promise.resolve(options.dismiss()).finally(() => {
        closing = false;
        // A guard that keeps the sheet, such as unsaved changes, brings it back.
        if (!disposed && frame.isConnected) go(detent);
      });
    });
  };

  // One drag model for mouse and touch: the visible height follows the pointer; nothing is laid out per frame.
  let drag: { startY: number; y: number; time: number; speed: number; from: number; moved: boolean } | null = null;
  const begin = (y: number, time: number) => {
    // A sheet on its way out finishes leaving; its owner decides before anything moves it again.
    if (closing || !owning()) return;
    remeasureAtRest();
    stop();
    drag = { startY: y, y, time, speed: 0, from: visible, moved: false };
  };
  const follow = (y: number, time: number) => {
    // A move without a change of position, such as the one a release repeats, is no speed and keeps the last move's time.
    if (!drag || y === drag.y) return;
    const distance = drag.startY - y;
    if (!drag.moved) {
      if (Math.abs(distance) < DRAG_PX) return;
      drag.moved = true;
      frame.dataset.sheetDragging = "";
    }
    const elapsed = time - drag.time;
    if (elapsed > 0) drag.speed = drag.speed * 0.4 + ((y - drag.y) / elapsed) * 0.6;
    drag.y = y;
    drag.time = time;
    const floor = options.canDismiss() ? -OFFSCREEN_PX : lowest();
    put(Math.min(layoutHeight, Math.max(floor, drag.from + distance)));
  };
  /** Returns whether the gesture was a drag, so its click is not a press. */
  const release = (time: number, cancelled: boolean): boolean => {
    const ended = drag;
    drag = null;
    delete frame.dataset.sheetDragging;
    if (!ended) return false;
    if (!ended.moved || cancelled) {
      go(detent);
      return ended.moved;
    }
    // Positive is downwards, in px per ms.
    const speed = time - ended.time > REST_MS ? 0 : ended.speed;
    if (visible < lowest()) {
      if (options.canDismiss() && (speed > STEP_SPEED || lowest() - visible > lowest() * CLOSE_SHARE)) close();
      else go(detents ? "half" : "full");
      return true;
    }
    if (speed > FLICK_SPEED && options.canDismiss()) {
      close();
      return true;
    }
    if (!detents) {
      go("full");
      return true;
    }
    let next: SheetDetent;
    if (Math.abs(speed) > STEP_SPEED) next = speed > 0 ? "half" : "full";
    else {
      const projected = visible - speed * PROJECTION_MS;
      next = Math.abs(projected - layoutHeight) < Math.abs(projected - half) ? "full" : "half";
    }
    go(next);
    return true;
  };

  const cleanups: (() => void)[] = [];
  const on = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    listenerOptions?: AddEventListenerOptions,
  ) => {
    target.addEventListener(type, listener, listenerOptions);
    cleanups.push(() => target.removeEventListener(type, listener, listenerOptions));
  };

  // A mouse or a pen drags by the handle or the header; a finger uses the touch events below.
  let suppressClick = false;
  const header = panel.querySelector<HTMLElement>(":scope > .k2b-panel-dialog__header");
  for (const zone of [handle, header]) {
    if (!zone) continue;
    let pointer: number | null = null;
    on(zone, "pointerdown", (event) => {
      if (event.pointerType === "touch" || event.button !== 0 || event.isPrimary === false || !moving()) return;
      if (zone !== handle && event.target instanceof Element && event.target.closest("button, a, input, select, textarea")) return;
      suppressClick = false;
      pointer = event.pointerId;
      begin(event.clientY, event.timeStamp);
      zone.setPointerCapture?.(event.pointerId);
    });
    on(zone, "pointermove", (event) => {
      if (event.pointerId === pointer) follow(event.clientY, event.timeStamp);
    });
    on(zone, "pointerup", (event) => {
      if (event.pointerId !== pointer) return;
      pointer = null;
      follow(event.clientY, event.timeStamp);
      suppressClick = release(event.timeStamp, false) || suppressClick;
    });
    const cancel = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      pointer = null;
      release(event.timeStamp, true);
      // A cancelled gesture is no press either.
      suppressClick = true;
    };
    on(zone, "pointercancel", cancel);
    on(zone, "lostpointercapture", cancel);
  }

  // A finger: on the handle and the header it drags; in a list it scrolls first and drags only where the list cannot.
  let touch: { x: number; y: number; scroller: HTMLElement | null; decided: "drag" | "scroll" | "none" | null } | null = null;
  on(
    frame,
    "touchstart",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.touches.length !== 1 || !moving() || !target || !panel.contains(target)) {
        touch = null;
        return;
      }
      if (target.closest("input, textarea, select, [contenteditable], [data-sheet-no-drag]") || doc.getSelection()?.toString()) {
        touch = null;
        return;
      }
      const point = event.touches[0]!;
      touch = { x: point.clientX, y: point.clientY, scroller: scrollerIn(target, panel), decided: null };
    },
    { passive: true },
  );
  on(
    frame,
    "touchmove",
    (event) => {
      if (!touch) return;
      const point = event.touches[0];
      if (!point) return;
      const dx = point.clientX - touch.x;
      const dy = point.clientY - touch.y;
      if (touch.decided === null) {
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
        if (Math.abs(dx) > Math.abs(dy)) touch.decided = "none";
        else if (!touch.scroller) touch.decided = "drag";
        else if (event.timeStamp - lastScroll < SCROLL_LOCK_MS) touch.decided = "scroll";
        else if (dy > 0 && touch.scroller.scrollTop <= 0) touch.decided = "drag";
        else if (dy < 0 && detents && detent !== "full") touch.decided = "drag";
        else touch.decided = "scroll";
        if (touch.decided === "drag") begin(touch.y, event.timeStamp);
      }
      if (touch.decided !== "drag") return;
      event.preventDefault();
      follow(point.clientY, event.timeStamp);
    },
    { passive: false },
  );
  const touchEnd = (event: TouchEvent, cancelled: boolean) => {
    const dragged = touch?.decided === "drag" && release(event.timeStamp, cancelled);
    touch = null;
    if (!dragged) return;
    // The click that ends a drag does not press what lies under the finger.
    const swallow = (click: Event) => {
      click.preventDefault();
      click.stopPropagation();
    };
    frame.addEventListener("click", swallow, { capture: true, once: true });
    view?.setTimeout(() => frame.removeEventListener("click", swallow, { capture: true }), 350);
  };
  on(frame, "touchend", (event) => touchEnd(event, false));
  on(frame, "touchcancel", (event) => touchEnd(event, true));

  // Half height is a preview: the end of a list lies below the edge, so scrolling or tabbing into it grows the sheet.
  on(panel, "scroll", () => (lastScroll = performance.now()), { capture: true, passive: true });
  on(
    panel,
    "wheel",
    (event) => {
      if (detents && detent === "half" && event.deltaY > 0 && moving()) {
        event.preventDefault();
        go("full");
      }
    },
    { passive: false },
  );
  on(panel, "focusin", (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (detents && detent === "half" && !drag && moving() && target && target !== handle && target.matches(":focus-visible")) go("full");
  });
  if (handle) {
    on(handle, "click", (event) => {
      if (suppressClick && event.detail !== 0) {
        suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      suppressClick = false;
    });
  }

  // A rotation, the keyboard, or a resize moves the rest positions; a sheet that becomes a centred dialog stands still.
  const relayout = () => {
    if (!owning()) return;
    if (drag || closing) {
      stale = true;
      return;
    }
    // A glide in flight would land on the old sizes: it stops where it is and the sheet takes its new rest.
    for (const animation of animations) animation.cancel();
    animations = [];
    measure();
    put(rest(detent));
    if (detents) settle(detent);
  };
  view?.addEventListener("resize", relayout);
  cleanups.push(() => view?.removeEventListener("resize", relayout));
  dialogQuery?.addEventListener?.("change", relayout);
  cleanups.push(() => dialogQuery?.removeEventListener?.("change", relayout));

  /** Another level of the dialog stack covers this sheet: it stops moving and leaves the element to that level. */
  function suspend() {
    drag = null;
    touch = null;
    closing = false;
    vacate();
  }
  /** The level above closed: the sheet shows again at its rest, as it was. */
  function resume() {
    // After dialogCore has shown this level's content again, so the sheet measures itself visible.
    queueMicrotask(() => {
      if (!owning()) return;
      claim();
      measure();
      put(rest(detent));
    });
  }

  // Set before the dialog opens, so the stylesheet's own entry animation never starts.
  owners.at(-1)?.suspend();
  owners.push(owner);
  claim();

  return {
    open: () => {
      if (!owning()) return;
      // Every size is fixed before the first frame: the sheet slides in from below the edge and lands on its rest.
      measure();
      if (detents) settle("half");
      if (!moving()) {
        put(rest(detent));
        return;
      }
      put(-OFFSCREEN_PX);
      glide(rest(detent), MOVE_MS);
    },
    press: () => {
      if (!moving()) {
        if (options.canDismiss()) void options.dismiss();
        return;
      }
      if (detents) go(detent === "full" ? "half" : "full");
      else close();
    },
    step: (direction) => {
      if (detents && moving() && owning()) go(direction === "up" ? "full" : "half");
    },
    dispose: () => {
      if (disposed) return;
      const wasOwner = owning();
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      const index = owners.indexOf(owner);
      if (index >= 0) owners.splice(index, 1);
      // The dialog element outlives this sheet and shows the next level of the stack.
      if (wasOwner) {
        vacate();
        owners.at(-1)?.resume();
      }
    },
  };
}
