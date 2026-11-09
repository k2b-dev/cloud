/** A swipe locks its axis after this distance, and dismisses past the distance or above the speed (px/ms). */
const SWIPE_AXIS_PX = 4;
const SWIPE_DISMISS_PX = 45;
const SWIPE_DISMISS_SPEED = 0.11;
/** After a swipe, the click that ends it does not reach the toast's controls. */
const SWIPE_CLICK_GUARD_MS = 350;

export type ToastGestureContext = {
  /** The toast's slot in the stack, which carries the motion. */
  slot: HTMLElement;
  /** Closes the toast; `true` after a swipe flew it out. */
  dismiss: (swiped: boolean) => void;
  /** Pauses every timer while a pointer presses the card. */
  hold: (held: boolean) => void;
  /** A tap on a touch screen fans the stack out or folds it. */
  tap: (rail: HTMLElement) => void;
};

export type ToastGestures = {
  /** Handles a pointer event that arrived before this module loaded, in order. */
  replay: (event: PointerEvent) => void;
  /** Lets go of a gesture in progress, as when the toast closes in the middle of it. */
  release: () => void;
};

/** A click that only ends a swipe or a tap does not press the control under the finger. */
const swallowNextClick = (card: HTMLElement): void => {
  const stop = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  card.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => card.removeEventListener("click", stop, { capture: true }), SWIPE_CLICK_GUARD_MS);
};

/** Wrong-direction travel follows the finger less and less, so the toast resists instead of moving away. */
const resisted = (distance: number): number => distance / (1.5 + Math.abs(distance) / 20);

/**
 * Swiping towards the nearest screen edge dismisses a toast: down or right at the bottom edge, up or sideways at the
 * top. A tap on a touch screen fans the stack out or folds it. Swiping is a shortcut; the close button stays. The
 * toast module loads this with the first press on a toast.
 */
export const attachToastGestures = (card: HTMLElement, context: ToastGestureContext): ToastGestures => {
  const { slot } = context;
  let gesture: { id: number; x: number; y: number; at: number; axis: "x" | "y" | null; dx: number; dy: number } | null = null;
  const rail = () => slot.parentElement;
  const allowed = (direction: "left" | "right" | "up" | "down") =>
    rail()?.dataset.edge === "top" ? direction !== "down" : direction === "right" || direction === "down";
  const swipe = (x: number, y: number) => {
    slot.style.setProperty("--k2b-toast-swipe-x", `${x}px`);
    slot.style.setProperty("--k2b-toast-swipe-y", `${y}px`);
  };

  const down = (event: PointerEvent) => {
    if (event.button !== 0 || card.dataset.closing) return;
    const target = event.target instanceof Element ? event.target : null;
    // A mouse selects the message and presses the controls; a finger can start a swipe anywhere.
    if (event.pointerType === "mouse" && target?.closest("a, button, .k2b-toast__content")) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp, axis: null, dx: 0, dy: 0 };
    context.hold(true);
  };
  const move = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.axis) {
      if (Math.abs(dx) < SWIPE_AXIS_PX && Math.abs(dy) < SWIPE_AXIS_PX) return;
      gesture.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      try {
        card.setPointerCapture?.(event.pointerId);
      } catch {
        // A move handed over after its pointer lifted has nothing left to capture.
      }
      slot.dataset.swiping = "true";
    }
    gesture.dx = dx;
    gesture.dy = dy;
    const x = gesture.axis === "x" ? (allowed(dx > 0 ? "right" : "left") ? dx : resisted(dx)) : 0;
    const y = gesture.axis === "y" ? (allowed(dy > 0 ? "down" : "up") ? dy : resisted(dy)) : 0;
    swipe(x, y);
    slot.style.setProperty("--k2b-toast-fade", String(Math.max(0.35, 1 - Math.hypot(x, y) / 220)));
  };
  const release = () => {
    if (!gesture) return;
    gesture = null;
    delete slot.dataset.swiping;
    slot.style.setProperty("--k2b-toast-fade", "1");
    context.hold(false);
  };
  const end = (event: PointerEvent, cancelled: boolean) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const ended = gesture;
    release();
    const owner = rail();
    if (ended.axis && !cancelled) {
      swallowNextClick(card);
      const distance = ended.axis === "x" ? ended.dx : ended.dy;
      const direction = ended.axis === "x" ? (distance > 0 ? "right" : "left") : distance > 0 ? "down" : "up";
      const speed = Math.abs(distance) / Math.max(1, event.timeStamp - ended.at);
      if (allowed(direction) && (Math.abs(distance) >= SWIPE_DISMISS_PX || speed > SWIPE_DISMISS_SPEED)) {
        slot.style.setProperty(
          ended.axis === "x" ? "--k2b-toast-swipe-x" : "--k2b-toast-swipe-y",
          `${Math.sign(distance) * (ended.axis === "x" ? 110 : 140)}%`,
        );
        context.dismiss(true);
        return;
      }
    } else if (!ended.axis && !cancelled && event.pointerType !== "mouse" && owner) {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest("a, button")) context.tap(owner);
    }
    swipe(0, 0);
  };
  // Before its axis locks, a gesture has no pointer capture: a pointer that leaves the card ends it, so it never pauses the timers for good.
  const leave = (event: PointerEvent) => {
    if (gesture && !gesture.axis) end(event, true);
  };
  const handlers: Record<string, (event: PointerEvent) => void> = {
    pointerdown: down,
    pointermove: move,
    pointerup: (event) => end(event, false),
    pointercancel: (event) => end(event, true),
    lostpointercapture: (event) => end(event, true),
    pointerleave: leave,
  };
  for (const [type, handler] of Object.entries(handlers)) card.addEventListener(type, handler as EventListener);
  return { replay: (event) => handlers[event.type]?.(event), release };
};
