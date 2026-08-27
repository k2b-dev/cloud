import { createSignal, createUniqueId, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Portal, render } from "solid-js/web";
import { getK2bPortalRoot } from "../internal/portal";
import { useUiMessages } from "../intl/messages";
import { FLOATING_WINDOW_VIEWPORT_GAP, type FloatingWindowRect, fitFloatingWindowRect } from "./floating-window-geometry";

export { type FloatingWindowRect, fitFloatingWindowRect } from "./floating-window-geometry";

type ResizeEdge = "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type FloatingWindowProps = {
  title: string;
  icon?: string;
  children: JSX.Element;
  onClose: () => void;
  initialWidth?: number;
  initialHeight?: number;
  minWidth?: number;
  minHeight?: number;
  accent?: string;
  class?: string;
  resolveScope?: () => HTMLElement | null | undefined;
};
export type OpenFloatingWindowOptions = Omit<FloatingWindowProps, "children" | "onClose">;
export type FloatingWindowClose = () => void;

const MOBILE_BREAKPOINT = 640;
const FLOATING_WINDOW_LAYER_BASE = 80;
type LayerOwner = { setLayer: (layer: number) => void };
const activeLayers: LayerOwner[] = [];
const syncLayers = () => {
  activeLayers.forEach((owner, index) => owner.setLayer(FLOATING_WINDOW_LAYER_BASE + index));
};
const registerLayer = (owner: LayerOwner) => {
  activeLayers.push(owner);
  syncLayers();
};
const releaseLayer = (owner: LayerOwner) => {
  const index = activeLayers.indexOf(owner);
  if (index < 0) return;
  activeLayers.splice(index, 1);
  syncLayers();
};
const bringLayerToFront = (owner: LayerOwner) => {
  const index = activeLayers.indexOf(owner);
  if (index < 0 || index === activeLayers.length - 1) return;
  activeLayers.splice(index, 1);
  activeLayers.push(owner);
  syncLayers();
};
const isTopLayer = (owner: LayerOwner) => activeLayers.at(-1) === owner;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

export default function FloatingWindow(props: FloatingWindowProps): JSX.Element {
  const messages = useUiMessages();
  const minWidth = () => props.minWidth ?? 360;
  const minHeight = () => props.minHeight ?? 320;
  const [mobile, setMobile] = createSignal(false);
  const [layer, setLayer] = createSignal(FLOATING_WINDOW_LAYER_BASE);
  const layerOwner: LayerOwner = { setLayer };
  const [rect, setRect] = createSignal<FloatingWindowRect>({
    x: FLOATING_WINDOW_VIEWPORT_GAP,
    y: FLOATING_WINDOW_VIEWPORT_GAP,
    width: props.initialWidth ?? 720,
    height: props.initialHeight ?? 640,
  });
  const titleId = `k2b-floating-window-${createUniqueId()}`;
  let frame: HTMLElement | undefined;
  let stopPointerInteraction: (() => void) | undefined;
  const fit = (value: FloatingWindowRect) =>
    fitFloatingWindowRect(value, minWidth(), minHeight(), { width: window.innerWidth, height: window.innerHeight });
  const front = () => bringLayerToFront(layerOwner);
  const stopActivePointerInteraction = () => stopPointerInteraction?.();
  const close = () => {
    stopActivePointerInteraction();
    props.onClose();
  };
  const trackPointerInteraction = (start: PointerEvent, move: (event: PointerEvent) => void) => {
    stopActivePointerInteraction();
    const pointerId = start.pointerId;
    const captureTarget = start.currentTarget as HTMLElement;
    captureTarget.setPointerCapture?.(pointerId);
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      if (captureTarget.hasPointerCapture?.(pointerId)) captureTarget.releasePointerCapture(pointerId);
      if (stopPointerInteraction === stop) stopPointerInteraction = undefined;
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerId === pointerId) move(event);
    };
    const onEnd = (event: PointerEvent) => {
      if (event.pointerId === pointerId) stop();
    };
    stopPointerInteraction = stop;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  onMount(() => {
    registerLayer(layerOwner);
    const viewport = () => {
      const compact = window.innerWidth < MOBILE_BREAKPOINT;
      setMobile(compact);
      if (!compact) setRect((current) => fit(current));
    };
    setRect((current) => fit({ ...current, x: (window.innerWidth - current.width) / 2, y: (window.innerHeight - current.height) / 2 }));
    viewport();
    const escape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || !isTopLayer(layerOwner)) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("resize", viewport);
    window.addEventListener("keydown", escape);
    const focus = requestAnimationFrame(() => frame?.focus());
    onCleanup(() => {
      stopActivePointerInteraction();
      releaseLayer(layerOwner);
      cancelAnimationFrame(focus);
      window.removeEventListener("resize", viewport);
      window.removeEventListener("keydown", escape);
    });
  });

  const moveBy = (deltaX: number, deltaY: number) =>
    setRect((current) => fit({ ...current, x: current.x + deltaX, y: current.y + deltaY }));
  const beginMove = (event: PointerEvent) => {
    if (mobile() || event.button !== 0 || (event.target as Element).closest("button:not([data-window-move])")) return;
    const origin = rect();
    const start = { x: event.clientX, y: event.clientY };
    front();
    const move = (next: PointerEvent) =>
      setRect(fit({ ...origin, x: origin.x + next.clientX - start.x, y: origin.y + next.clientY - start.y }));
    trackPointerInteraction(event, move);
    event.preventDefault();
  };
  const resizeBy = (edge: ResizeEdge, deltaX: number, deltaY: number) => {
    const current = rect();
    let { x, y, width, height } = current;
    if (edge.includes("left")) {
      const next = clamp(width - deltaX, minWidth(), window.innerWidth - FLOATING_WINDOW_VIEWPORT_GAP - x);
      x += width - next;
      width = next;
    }
    if (edge.includes("right")) width += deltaX;
    if (edge.includes("top")) {
      const next = clamp(height - deltaY, minHeight(), window.innerHeight - FLOATING_WINDOW_VIEWPORT_GAP - y);
      y += height - next;
      height = next;
    }
    if (edge.includes("bottom")) height += deltaY;
    setRect(fit({ x, y, width, height }));
  };
  const beginResize = (edge: ResizeEdge, event: PointerEvent) => {
    if (mobile() || event.button !== 0) return;
    let previous = { x: event.clientX, y: event.clientY };
    front();
    const move = (next: PointerEvent) => {
      resizeBy(edge, next.clientX - previous.x, next.clientY - previous.y);
      previous = { x: next.clientX, y: next.clientY };
    };
    trackPointerInteraction(event, move);
    event.preventDefault();
  };
  const arrows = (event: KeyboardEvent, action: (x: number, y: number) => void) => {
    const step = event.shiftKey ? 24 : 8;
    const delta =
      event.key === "ArrowLeft"
        ? [-step, 0]
        : event.key === "ArrowRight"
          ? [step, 0]
          : event.key === "ArrowUp"
            ? [0, -step]
            : event.key === "ArrowDown"
              ? [0, step]
              : undefined;
    if (!delta) return;
    action(delta[0]!, delta[1]!);
    event.preventDefault();
  };
  const handles: readonly [ResizeEdge, string][] = [
    ["left", "ew-resize"],
    ["right", "ew-resize"],
    ["top", "ns-resize"],
    ["bottom", "ns-resize"],
    ["top-left", "nwse-resize"],
    ["top-right", "nesw-resize"],
    ["bottom-left", "nesw-resize"],
    ["bottom-right", "nwse-resize"],
  ];

  const view = (
    <section
      ref={frame}
      class={`k2b-floating-window ${props.class ?? ""}`}
      data-mobile={mobile() ? "true" : undefined}
      style={
        mobile()
          ? {
              "--k2b-window-accent": props.accent,
              inset: "0.5rem",
              width: "auto",
              height: "auto",
              "z-index": layer(),
            }
          : {
              "--k2b-window-accent": props.accent,
              left: `${rect().x}px`,
              top: `${rect().y}px`,
              width: `${rect().width}px`,
              height: `${rect().height}px`,
              "z-index": layer(),
            }
      }
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      onPointerDown={front}
    >
      <header onPointerDown={beginMove}>
        <Show when={props.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
        <button
          type="button"
          data-window-move
          class="k2b-floating-window__title"
          aria-label={messages().moveWindow({ title: props.title })}
          onKeyDown={(event) => arrows(event, moveBy)}
        >
          <span id={titleId}>{props.title}</span>
        </button>
        <button type="button" class="k2b-icon-button" aria-label={messages().closeWindow} onClick={close}>
          <i class="ti ti-x" aria-hidden="true" />
        </button>
      </header>
      <div class="k2b-floating-window__body">{props.children}</div>
      <Show when={!mobile()}>
        {handles.map(([edge, cursor]) =>
          edge === "bottom-right" ? (
            <button
              type="button"
              class="k2b-floating-window__resize"
              data-edge={edge}
              style={{ cursor }}
              aria-label={messages().resizeWindow}
              onPointerDown={(event) => beginResize(edge, event)}
              onKeyDown={(event) => arrows(event, (x, y) => resizeBy(edge, x, y))}
            />
          ) : (
            // Cloud exposes a single keyboard-resizable corner; the remaining
            // edges stay pointer-only so the window adds one tab stop, not eight.
            <div
              class="k2b-floating-window__resize"
              data-edge={edge}
              style={{ cursor }}
              aria-hidden="true"
              onPointerDown={(event) => beginResize(edge, event)}
            />
          ),
        )}
      </Show>
    </section>
  );
  return <Portal mount={typeof document === "undefined" ? undefined : getK2bPortalRoot(props.resolveScope?.())}>{view}</Portal>;
}

export const openFloatingWindow = (
  view: (close: FloatingWindowClose) => JSX.Element,
  options: OpenFloatingWindowOptions,
): FloatingWindowClose => {
  if (typeof document === "undefined") throw new Error("Floating windows are browser-only");
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const owner = document.createElement("div");
  owner.className = "k2b-ui";
  document.body.appendChild(owner);
  let dispose: (() => void) | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    dispose?.();
    owner.remove();
    previousFocus?.focus();
  };
  dispose = render(
    () => (
      <FloatingWindow {...options} resolveScope={options.resolveScope ?? (() => owner)} onClose={close}>
        {view(close)}
      </FloatingWindow>
    ),
    owner,
  );
  return close;
};
