import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Button } from "../actions/Button";
import { dialogCore } from "../feedback/dialog-core";
import { DialogHeader } from "../feedback/prompts";
import { LocaleProvider, useLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import {
  clampZoomPan,
  panZoomPan,
  ZOOM_PAN_FIT,
  ZOOM_PAN_STEP,
  type ZoomPanGeometry,
  type ZoomPanTransform,
  zoomZoomPanAt,
} from "./zoom-pan";

export type ZoomPanAction = {
  label: string;
  icon?: string;
  /** Runs the action; the button shows a pending state until a returned promise settles. Handle failures here. */
  onSelect: () => void | Promise<void>;
};

export type ZoomPanFullscreen = {
  /** Heading and accessible name of the fullscreen dialog. */
  title: string;
  /** Renders a fresh copy of the content for the dialog. Called once per opening. */
  content: () => JSX.Element;
  /** Actions shown in the fullscreen dialog, for example exports. */
  actions?: readonly ZoomPanAction[];
};

export type ZoomPanViewportProps = {
  /** Accessible name of the focusable viewport. */
  label: string;
  /** The zoomable content. Its first element is measured to keep it on screen. */
  children: JSX.Element;
  /** Enables the fullscreen control and the `F` shortcut. */
  fullscreen?: ZoomPanFullscreen;
  /** `hover` reveals the controls on hover, on focus, and while zoomed in. Touch screens always show them. */
  controls?: "visible" | "hover";
  class?: string;
  style?: JSX.CSSProperties;
};

const PAN_KEY_STEP = 48;
const DRAG_THRESHOLD = 4;
const PAN_KEYS: Record<string, readonly [number, number]> = {
  ArrowLeft: [PAN_KEY_STEP, 0],
  ArrowRight: [-PAN_KEY_STEP, 0],
  ArrowUp: [0, PAN_KEY_STEP],
  ArrowDown: [0, -PAN_KEY_STEP],
};

/** Current screen transform of the stage, including a running CSS transition. */
const renderedTransform = (stage: HTMLElement, fallback: ZoomPanTransform): ZoomPanTransform => {
  const match = /^matrix\(([^)]+)\)$/.exec(getComputedStyle(stage).transform ?? "");
  const values = match?.[1]?.split(",").map(Number);
  if (!values || values.length !== 6 || values.some((value) => !Number.isFinite(value)) || !values[0]) return fallback;
  return { scale: values[0], x: values[4] ?? 0, y: values[5] ?? 0 };
};

const ActionButton = (props: { action: ZoomPanAction }): JSX.Element => {
  const [pending, setPending] = createSignal(false);
  const run = async () => {
    if (pending()) return;
    setPending(true);
    try {
      await props.action.onSelect();
    } catch (error) {
      console.error("Zoom-pan action failed", error);
    } finally {
      setPending(false);
    }
  };
  return (
    <Button variant="secondary" loading={pending()} onClick={() => void run()}>
      <Show when={props.action.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
      {props.action.label}
    </Button>
  );
};

/**
 * Makes any content zoomable (fit to 8×) and pannable with buttons, Ctrl/Cmd +
 * wheel, pinch, drag, and keys. It applies a CSS transform, so vector content
 * stays crisp and is never re-rendered. The view always starts at fit.
 */
export function ZoomPanViewport(props: ZoomPanViewportProps): JSX.Element {
  const messages = useUiMessages();
  const locale = useLocale();
  const [transform, setTransform] = createSignal<ZoomPanTransform>(ZOOM_PAN_FIT);
  const [smooth, setSmooth] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  let root: HTMLDivElement | undefined;
  let stage: HTMLDivElement | undefined;
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { id: number; x: number; y: number; origin: ZoomPanTransform; moved: boolean } | undefined;
  let pinch: { distance: number; center: { x: number; y: number }; origin: ZoomPanTransform } | undefined;
  let suppressClick = false;

  const zoomed = () => transform().scale > 1;

  const geometry = (): ZoomPanGeometry => {
    const rect = root?.getBoundingClientRect();
    const width = rect?.width ?? 0;
    const height = rect?.height ?? 0;
    const content = stage?.firstElementChild?.getBoundingClientRect();
    if (!rect || !stage || !content || content.width <= 0 || content.height <= 0) {
      return { width, height, content: { left: 0, top: 0, width, height } };
    }
    const current = renderedTransform(stage, transform());
    return {
      width,
      height,
      content: {
        left: (content.left - rect.left - current.x) / current.scale,
        top: (content.top - rect.top - current.y) / current.scale,
        width: content.width / current.scale,
        height: content.height / current.scale,
      },
    };
  };

  const apply = (next: ZoomPanTransform, animate: boolean) => {
    setSmooth(animate);
    setTransform(next);
  };

  const local = (event: { clientX: number; clientY: number }) => {
    const rect = root?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const zoomBy = (factor: number, point?: { x: number; y: number }, animate = true) => {
    const box = geometry();
    const current = transform();
    apply(zoomZoomPanAt(current, current.scale * factor, point ?? { x: box.width / 2, y: box.height / 2 }, box), animate);
  };

  const reset = () => apply(ZOOM_PAN_FIT, true);

  const openFullscreen = () => {
    const fullscreen = props.fullscreen;
    if (!fullscreen) return;
    const currentLocale = locale();
    void dialogCore.open<void>(
      (close) => (
        <LocaleProvider locale={currentLocale}>
          <div class="k2b-dialog__panel k2b-dialog__stack">
            <DialogHeader title={fullscreen.title} close={() => close()} />
            <div class="k2b-zoom-pan-dialog">
              <ZoomPanViewport label={props.label}>{fullscreen.content()}</ZoomPanViewport>
              <Show when={fullscreen.actions?.length}>
                <footer class="k2b-dialog__actions">
                  <For each={fullscreen.actions}>{(action) => <ActionButton action={action} />}</For>
                </footer>
              </Show>
            </div>
          </div>
        </LocaleProvider>
      ),
      {
        panelClassName: "k2b-dialog k2b-dialog--full",
        ariaLabel: fullscreen.title,
        initialFocus: (dialog) => dialog.querySelector<HTMLElement>(".k2b-zoom-pan"),
      },
    );
  };

  const handleKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
    if (event.target !== root || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key;
    if (key === "+" || key === "=") zoomBy(ZOOM_PAN_STEP);
    else if (key === "-" || key === "_") zoomBy(1 / ZOOM_PAN_STEP);
    else if (key === "0") reset();
    else if ((key === "f" || key === "F") && props.fullscreen) openFullscreen();
    else {
      const delta = PAN_KEYS[key];
      // At fit the arrow keys keep scrolling the page.
      if (!delta || !zoomed()) return;
      apply(panZoomPan(transform(), delta[0], delta[1], geometry()), true);
    }
    event.preventDefault();
  };

  // Plain wheel keeps scrolling the page; Ctrl/Cmd + wheel (and trackpad pinch) zooms toward the pointer.
  const handleWheel: JSX.EventHandler<HTMLDivElement, WheelEvent> = (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const delta = Math.max(-50, Math.min(50, event.deltaY * lines));
    zoomBy(Math.exp(-delta / 100), local(event), false);
  };

  const handlePointerDown: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    if (event.button !== 0 || (event.target as Element).closest("button, a, input, select, textarea")) return;
    pointers.set(event.pointerId, local(event));
    if (pointers.size === 2) {
      const [first, second] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      pinch = {
        distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
        center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
        origin: transform(),
      };
      drag = undefined;
    } else if (pointers.size === 1 && zoomed()) {
      // Panning starts only above fit, so clicks and text selection keep working at fit.
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: transform(), moved: false };
    } else return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic or already released pointer cannot be captured; moves still arrive while inside.
    }
  };

  const handlePointerMove: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, local(event));
    if (pinch && pointers.size >= 2) {
      const [first, second] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const box = geometry();
      const scaled = zoomZoomPanAt(pinch.origin, pinch.origin.scale * (distance / pinch.distance), pinch.center, box);
      apply(panZoomPan(scaled, center.x - pinch.center.x, center.y - pinch.center.y, box), false);
      return;
    }
    if (drag?.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    setDragging(true);
    apply(panZoomPan(drag.origin, dx, dy, geometry()), false);
  };

  const handlePointerEnd: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = undefined;
    if (drag?.id !== event.pointerId) return;
    if (drag.moved) {
      // The click that follows this pointerup (if the browser sends one) comes in the same task.
      suppressClick = true;
      setTimeout(() => {
        suppressClick = false;
      });
    }
    drag = undefined;
    setDragging(false);
  };

  onMount(() => {
    const element = root;
    if (!element) return;
    // A drag must not also count as a click on the content or its owner.
    const click = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    // Keep a two-finger gesture for pinch zoom instead of page panning.
    const touchMove = (event: TouchEvent) => {
      if (event.touches.length > 1) event.preventDefault();
    };
    element.addEventListener("click", click, true);
    element.addEventListener("touchmove", touchMove, { passive: false });
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => apply(clampZoomPan(transform(), geometry()), false));
    observer?.observe(element);
    onCleanup(() => {
      element.removeEventListener("click", click, true);
      element.removeEventListener("touchmove", touchMove);
      observer?.disconnect();
    });
  });

  const control = (label: string, shortcut: string, icon: string, action: () => void) => (
    <button
      type="button"
      class="k2b-button k2b-icon-button"
      data-variant="secondary"
      aria-label={label}
      title={`${label} (${shortcut})`}
      onClick={action}
    >
      <i class={`ti ${icon}`} aria-hidden="true" />
    </button>
  );

  return (
    <div
      ref={root}
      class={`k2b-zoom-pan ${props.class ?? ""}`}
      style={props.style}
      role="group"
      aria-label={props.label}
      aria-description={messages().zoomPanKeys}
      tabIndex={0}
      data-controls={props.controls ?? "visible"}
      data-zoomed={zoomed() ? "true" : undefined}
      data-dragging={dragging() ? "true" : undefined}
      onKeyDown={handleKeyDown}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    >
      <div
        ref={stage}
        class="k2b-zoom-pan__stage"
        data-smooth={smooth() ? "true" : undefined}
        style={{ transform: `translate(${transform().x}px, ${transform().y}px) scale(${transform().scale})` }}
      >
        {props.children}
      </div>
      <div class="k2b-zoom-pan__controls">
        {control(messages().zoomIn, "+", "ti-plus", () => zoomBy(ZOOM_PAN_STEP))}
        {control(messages().zoomOut, "-", "ti-minus", () => zoomBy(1 / ZOOM_PAN_STEP))}
        {control(messages().resetZoom, "0", "ti-focus-centered", reset)}
        <Show when={props.fullscreen}>{control(messages().openFullscreen, "F", "ti-maximize", openFullscreen)}</Show>
      </div>
    </div>
  );
}
