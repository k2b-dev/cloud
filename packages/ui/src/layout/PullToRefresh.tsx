import { createSignal, type JSX, onCleanup, onMount } from "solid-js";
import { useUiMessages } from "../intl/messages";

/** Android's SwipeRefreshLayout triggers at 64dp; the pull is damped to half the input travel. */
const THRESHOLD = 64;
const MAX_DISTANCE = 96;
const RESISTANCE = 0.5;
/** A trackpad has no release event, so an idle gap ends the wheel gesture. */
const WHEEL_IDLE_MS = 300;
const LINE_HEIGHT = 16;

export type PullToRefreshState = "idle" | "pulling" | "ready" | "refreshing";

export type PullToRefreshProps = {
  /** Reloads the wrapped content. The indicator stays busy until the promise settles. */
  onRefresh: () => Promise<void>;
  disabled?: boolean;
  /** Status text announced while refreshing. Defaults to the shared "Refreshing" message. */
  label?: string;
  class?: string;
  /** Exactly one scroll container; the gesture only starts while it is scrolled to the top. */
  children: JSX.Element;
};

const INTERACTIVE = "a, button, input, textarea, select, [contenteditable], [role='button']";

/**
 * Turns a downward pull on a scroll container that is already at its top into
 * one `onRefresh` call. Touch pulls, mouse or pen drags on non-interactive
 * space, and trackpad or wheel overscroll share one gesture model. The gesture
 * is an enhancement: keep a keyboard-reachable refresh (a button or the page
 * reload) next to it.
 */
export function PullToRefresh(props: PullToRefreshProps): JSX.Element {
  const messages = useUiMessages();
  const [state, setState] = createSignal<PullToRefreshState>("idle");
  const [distance, setDistance] = createSignal(0);
  let root!: HTMLDivElement;

  const active = () => !props.disabled && state() !== "refreshing";
  const atTop = (target: EventTarget | null) => {
    for (let node = target instanceof Element ? target : null; node && node !== root; node = node.parentElement)
      if (node.scrollTop > 0) return false;
    return true;
  };
  const interactive = (target: EventTarget | null) => target instanceof Element && target.closest(INTERACTIVE) !== null;
  /** Keeps the drag alive when the pointer leaves the wrapper; a pointer that is already gone must not end the gesture. */
  const capture = (id: number) => {
    try {
      root.setPointerCapture(id);
    } catch {}
  };

  const reset = () => {
    setDistance(0);
    setState("idle");
  };
  const pull = (travel: number) => {
    const next = Math.min(MAX_DISTANCE, Math.max(0, travel * RESISTANCE));
    setDistance(next);
    setState(next >= THRESHOLD ? "ready" : next > 0 ? "pulling" : "idle");
  };
  const refresh = async () => {
    if (state() === "refreshing") return;
    setState("refreshing");
    setDistance(THRESHOLD);
    try {
      await props.onRefresh();
    } finally {
      reset();
    }
  };
  const release = () => {
    if (state() === "ready") void refresh();
    else if (state() !== "refreshing") reset();
  };
  const abort = () => {
    if (state() !== "refreshing") reset();
  };

  let wheelTravel = 0;
  let wheelTimer: ReturnType<typeof setTimeout> | undefined;
  const endWheel = () => {
    wheelTravel = 0;
    abort();
  };
  const onWheel = (event: WheelEvent) => {
    if (!active()) return;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(endWheel, WHEEL_IDLE_MS);
    if (event.deltaY >= 0 || !atTop(event.target)) return endWheel();
    const scale = event.deltaMode === 1 ? LINE_HEIGHT : event.deltaMode === 2 ? root.clientHeight : 1;
    wheelTravel -= event.deltaY * scale;
    pull(wheelTravel);
    if (state() === "ready") {
      wheelTravel = 0;
      void refresh();
    }
  };

  let pointer: { id: number; startY: number } | null = null;
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch" || event.button !== 0 || !active() || interactive(event.target) || !atTop(event.target)) return;
    pointer = { id: event.pointerId, startY: event.clientY };
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    const travel = event.clientY - pointer.startY;
    if (travel <= 0 && state() === "idle") return;
    if (state() === "idle") capture(pointer.id);
    pull(travel);
    if (state() !== "idle") event.preventDefault();
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    pointer = null;
    release();
  };
  const onPointerCancel = (event: PointerEvent) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    pointer = null;
    abort();
  };

  let touch: { id: number; startY: number } | null = null;
  const onTouchStart = (event: TouchEvent) => {
    const first = event.touches[0];
    if (!first || event.touches.length !== 1 || !active() || !atTop(event.target)) return;
    touch = { id: first.identifier, startY: first.clientY };
  };
  const onTouchMove = (event: TouchEvent) => {
    if (!touch) return;
    const current = Array.from(event.touches).find((item) => item.identifier === touch?.id);
    if (!current) return;
    const travel = current.clientY - touch.startY;
    if (travel <= 0 && state() === "idle") {
      touch = null;
      return;
    }
    pull(travel);
    if (state() !== "idle" && event.cancelable) event.preventDefault();
  };
  const onTouchEnd = () => {
    if (!touch) return;
    touch = null;
    release();
  };
  const onTouchCancel = () => {
    if (!touch) return;
    touch = null;
    abort();
  };

  onMount(() => {
    root.addEventListener("wheel", onWheel, { passive: true });
    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerup", onPointerUp);
    root.addEventListener("pointercancel", onPointerCancel);
    root.addEventListener("touchstart", onTouchStart, { passive: true });
    root.addEventListener("touchmove", onTouchMove, { passive: false });
    root.addEventListener("touchend", onTouchEnd);
    root.addEventListener("touchcancel", onTouchCancel);
    onCleanup(() => {
      clearTimeout(wheelTimer);
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerup", onPointerUp);
      root.removeEventListener("pointercancel", onPointerCancel);
      root.removeEventListener("touchstart", onTouchStart);
      root.removeEventListener("touchmove", onTouchMove);
      root.removeEventListener("touchend", onTouchEnd);
      root.removeEventListener("touchcancel", onTouchCancel);
    });
  });

  const className = () => (props.class?.trim() ? `k2b-pull-to-refresh ${props.class.trim()}` : "k2b-pull-to-refresh");
  const progress = () => Math.min(1, distance() / THRESHOLD);

  return (
    <div
      ref={root}
      class={className()}
      data-state={state()}
      style={{ "--k2b-pull-to-refresh-distance": `${distance()}px`, "--k2b-pull-to-refresh-progress": String(progress()) }}
    >
      <div class="k2b-pull-to-refresh__indicator" role="status" aria-live="polite">
        <span class="k2b-pull-to-refresh__icon" aria-hidden="true">
          <i class={state() === "refreshing" ? "ti ti-loader-2 k2b-spin" : "ti ti-refresh"} />
        </span>
        <span class="k2b-sr-only">{state() === "refreshing" ? (props.label ?? messages().refreshing) : ""}</span>
      </div>
      {props.children}
    </div>
  );
}

export default PullToRefresh;
