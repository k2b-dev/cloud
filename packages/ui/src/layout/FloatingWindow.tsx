import { createEffect, createMemo, createSignal, createUniqueId, type JSX, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { Portal, render } from "solid-js/web";
import { IconButton } from "../actions/Button";
import { returnFocus, ringOnReturn } from "../internal/focus-return";
import { getK2bPortalRoot } from "../internal/portal";
import { RenderErrorBoundary } from "../internal/render-error";
import { suppressTextSelection } from "../internal/text-selection";
import { showTruncatedTitle } from "../internal/truncated-title";
import {
  FLOATING_WINDOW_BAR,
  FLOATING_WINDOW_VIEWPORT_GAP,
  type FloatingWindowBounds,
  type FloatingWindowRect,
  type FloatingWindowSize,
  fitFloatingWindowRect,
  layoutFloatingWindowDock,
  maximizedFloatingWindowRect,
} from "./floating-window-geometry";
import { useFloatingWindowMessages } from "./floating-window-messages";

export { type FloatingWindowBounds, type FloatingWindowRect, fitFloatingWindowRect } from "./floating-window-geometry";

type ResizeEdge = "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** `minimized` is a bar at the bottom edge with the content kept alive; `maximized` covers the area above a scrim. */
export type FloatingWindowState = "normal" | "minimized" | "maximized";

export type FloatingWindowProps = {
  /** One line in the header; a long title ends with an ellipsis and shows in full on hover. */
  title: string;
  icon?: string;
  /** A short status right after the title, such as "Saved". On a phone it sits below the title. */
  status?: JSX.Element;
  /**
   * Actions of the content in the header, such as Send, after the title and before the window controls. A minimized bar
   * hides them. On a phone sheet they stand at the end of the header, within reach above the keyboard.
   */
  actions?: JSX.Element;
  children: JSX.Element;
  onClose: () => void;
  /** The current state when the application owns it; pair it with `onStateChange`. */
  state?: FloatingWindowState;
  /** The state the window opens in when the application does not own it. Defaults to `normal`. */
  defaultState?: FloatingWindowState;
  /** Called when the person minimizes, maximizes, or restores the window. */
  onStateChange?: (state: FloatingWindowState) => void;
  /** Where the window stands, in viewport pixels, such as a remembered place. Without it the window places itself. */
  rect?: FloatingWindowRect;
  /** Called when the person moved or resized the window, with its new place. */
  onRectChange?: (rect: FloatingWindowRect) => void;
  /**
   * Where a window without `rect` opens: `center` (default) in the middle of the area, or `dock` at the bottom end, in
   * one row with minimized windows, until the person moves it.
   */
  placement?: "center" | "dock";
  /** The element whose box the window lives in: it stays inside it, docks at its bottom, and maximizes over it. Defaults to the viewport. */
  area?: () => HTMLElement | null | undefined;
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

/** Every docked window of the page, in the order the windows opened, so a row never reorders when one restores. */
type DockMember = { area: () => HTMLElement | undefined; docked: () => boolean; size: () => FloatingWindowSize };
const [dockMembers, setDockMembers] = createSignal<readonly DockMember[]>([]);

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
const sameRect = (a: FloatingWindowRect | undefined, b: FloatingWindowRect | undefined) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
const tabbable =
  'a[href],button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),[contenteditable="true"],[tabindex]:not([tabindex="-1"])';

export default function FloatingWindow(props: FloatingWindowProps): JSX.Element {
  const floatingWindowMessages = useFloatingWindowMessages();
  const minWidth = () => props.minWidth ?? 360;
  const minHeight = () => props.minHeight ?? 320;
  const [mobile, setMobile] = createSignal(false);
  const [layer, setLayer] = createSignal(FLOATING_WINDOW_LAYER_BASE);
  const layerOwner: LayerOwner = { setLayer };
  const [ownState, setOwnState] = createSignal<FloatingWindowState>(untrack(() => props.defaultState ?? "normal"));
  const state = () => props.state ?? ownState();
  const [areaElement, setAreaElement] = createSignal<HTMLElement>();
  const [bounds, setBounds] = createSignal<Required<FloatingWindowBounds> & { radius: string }>({
    x: 0,
    y: 0,
    width: typeof window === "undefined" ? 1024 : window.innerWidth,
    height: typeof window === "undefined" ? 768 : window.innerHeight,
    radius: "0px",
  });
  /** The place the person or the application gave the window; unset while it places itself. */
  const [placed, setPlaced] = createSignal<FloatingWindowRect | undefined>();
  const titleId = `k2b-floating-window-${createUniqueId()}`;
  let frame: HTMLElement | undefined;
  let titleButton: HTMLButtonElement | undefined;
  let maximizeButton: HTMLButtonElement | undefined;
  let body: HTMLDivElement | undefined;
  /** The last focused element of the content, where the focus returns when the window comes back from the bar. */
  let contentFocus: HTMLElement | undefined;
  let stopPointerInteraction: (() => void) | undefined;
  const fit = (value: FloatingWindowRect) => fitFloatingWindowRect(value, minWidth(), minHeight(), bounds());
  const ownSize = () => {
    const area = bounds();
    return fit({ x: area.x, y: area.y, width: props.initialWidth ?? 720, height: props.initialHeight ?? 640 });
  };
  const docked = () => state() === "minimized" || (state() === "normal" && !placed() && !mobile() && props.placement === "dock");
  const dockMember: DockMember = {
    area: areaElement,
    docked,
    size: () => (state() === "minimized" ? FLOATING_WINDOW_BAR : ownSize()),
  };
  const dockRect = createMemo(() => {
    if (!docked()) return undefined;
    const row = dockMembers().filter((member) => member.area() === areaElement() && member.docked());
    return layoutFloatingWindowDock(
      row.map((member) => member.size()),
      bounds(),
    )[row.indexOf(dockMember)];
  });
  /** The window's box, or nothing while it is a full-screen sheet on a phone. */
  const frameRect = createMemo<FloatingWindowRect | undefined>(
    () => {
      if (mobile() && state() !== "minimized") return undefined;
      if (state() === "maximized") return maximizedFloatingWindowRect(bounds());
      const dock = dockRect();
      if (dock) return dock;
      const own = placed();
      if (own) return own;
      const size = ownSize();
      const area = bounds();
      return fit({ ...size, x: area.x + (area.width - size.width) / 2, y: area.y + (area.height - size.height) / 2 });
    },
    undefined,
    { equals: sameRect },
  );
  const modal = () => state() === "maximized" || (mobile() && state() === "normal");

  const front = () => bringLayerToFront(layerOwner);
  const stopActivePointerInteraction = () => stopPointerInteraction?.();
  const close = () => {
    stopActivePointerInteraction();
    props.onClose();
  };
  const commitRect = (next: FloatingWindowRect) => {
    setPlaced(next);
    props.onRectChange?.(next);
  };
  const focusInside = () => {
    const active = document.activeElement;
    return active instanceof HTMLElement && frame?.contains(active) ? active : undefined;
  };
  const changeState = (next: FloatingWindowState) => {
    const previous = state();
    if (next === previous) return;
    stopActivePointerInteraction();
    const hadFocus = focusInside();
    setOwnState(next);
    props.onStateChange?.(next);
    front();
    // The focus follows the window: onto the bar when it minimizes, back to where it was when the content returns.
    queueMicrotask(() => {
      if (state() !== next) return;
      if (next === "minimized") {
        if (hadFocus || document.activeElement === document.body) titleButton?.focus({ preventScroll: true });
        return;
      }
      const current = focusInside();
      if (current && current !== titleButton) return;
      const target = contentFocus?.isConnected && body?.contains(contentFocus) ? contentFocus : frame;
      target?.focus({ preventScroll: true });
    });
  };
  const trackPointerInteraction = (start: PointerEvent, move: (event: PointerEvent) => void) => {
    stopActivePointerInteraction();
    const pointerId = start.pointerId;
    const captureTarget = start.currentTarget as HTMLElement;
    captureTarget.setPointerCapture?.(pointerId);
    const releaseTextSelection = suppressTextSelection(pointerId);
    const stop = () => {
      releaseTextSelection();
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
      if (event.pointerId !== pointerId) return;
      stop();
      const current = placed();
      if (current) props.onRectChange?.(current);
    };
    stopPointerInteraction = stop;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  createEffect(
    on(
      () => props.rect,
      (rect) => {
        if (rect) setPlaced(fit(rect));
      },
    ),
  );

  onMount(() => {
    registerLayer(layerOwner);
    setDockMembers((members) => [...members, dockMember]);
    let observer: ResizeObserver | undefined;
    const measure = () => {
      const area = props.area?.() ?? undefined;
      if (area !== areaElement()) {
        observer?.disconnect();
        if (area) observer?.observe(area);
        setAreaElement(area);
      }
      const box = area?.getBoundingClientRect();
      const next = box
        ? { x: box.left, y: box.top, width: box.width, height: box.height, radius: getComputedStyle(area!).borderRadius }
        : { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, radius: "0px" };
      const current = bounds();
      if (next.x !== current.x || next.y !== current.y || next.width !== current.width || next.height !== current.height) setBounds(next);
      setMobile(window.innerWidth < MOBILE_BREAKPOINT);
      setPlaced((rect) => (rect ? fit(rect) : rect));
    };
    observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined;
    measure();
    if (!placed() && props.placement !== "dock") {
      const size = ownSize();
      const area = bounds();
      setPlaced(fit({ ...size, x: area.x + (area.width - size.width) / 2, y: area.y + (area.height - size.height) / 2 }));
    }
    const escape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || state() === "minimized") return;
      if (!(event.target instanceof Node && frame?.contains(event.target))) return;
      event.preventDefault();
      if (state() === "maximized" && !mobile()) changeState("normal");
      else close();
    };
    window.addEventListener("resize", measure);
    window.addEventListener("keydown", escape);
    // The content may already have placed the focus, such as an editor that opened with the window.
    const focus = requestAnimationFrame(() => {
      if (state() !== "minimized" && !focusInside()) frame?.focus();
    });
    onCleanup(() => {
      stopActivePointerInteraction();
      observer?.disconnect();
      releaseLayer(layerOwner);
      setDockMembers((members) => members.filter((member) => member !== dockMember));
      cancelAnimationFrame(focus);
      window.removeEventListener("resize", measure);
      window.removeEventListener("keydown", escape);
    });
  });

  /** While the window covers the area, Tab cycles inside it. */
  const trapTab = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || !modal() || !frame) return;
    const stops = [...frame.querySelectorAll<HTMLElement>(tabbable)].filter((element) => element.getClientRects().length > 0);
    const first = stops[0];
    const last = stops.at(-1);
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === frame)) {
      last.focus();
      event.preventDefault();
    } else if (!event.shiftKey && active === last) {
      first.focus();
      event.preventDefault();
    }
  };

  const moveBy = (deltaX: number, deltaY: number) => {
    const current = frameRect();
    if (current) commitRect(fit({ ...current, x: current.x + deltaX, y: current.y + deltaY }));
  };
  const movable = () => !mobile() && state() === "normal";
  const beginMove = (event: PointerEvent) => {
    if (!movable() || event.button !== 0 || (event.target as Element).closest("button:not([data-window-move])")) return;
    const origin = frameRect();
    if (!origin) return;
    const start = { x: event.clientX, y: event.clientY };
    front();
    const move = (next: PointerEvent) =>
      setPlaced(fit({ ...origin, x: origin.x + next.clientX - start.x, y: origin.y + next.clientY - start.y }));
    trackPointerInteraction(event, move);
    event.preventDefault();
  };
  const resized = (edge: ResizeEdge, deltaX: number, deltaY: number): FloatingWindowRect | undefined => {
    const current = frameRect();
    if (!current) return undefined;
    const area = bounds();
    let { x, y, width, height } = current;
    if (edge.includes("left")) {
      const next = clamp(width - deltaX, minWidth(), area.x + area.width - FLOATING_WINDOW_VIEWPORT_GAP - x);
      x += width - next;
      width = next;
    }
    if (edge.includes("right")) width += deltaX;
    if (edge.includes("top")) {
      const next = clamp(height - deltaY, minHeight(), area.y + area.height - FLOATING_WINDOW_VIEWPORT_GAP - y);
      y += height - next;
      height = next;
    }
    if (edge.includes("bottom")) height += deltaY;
    return fit({ x, y, width, height });
  };
  const beginResize = (edge: ResizeEdge, event: PointerEvent) => {
    if (!movable() || event.button !== 0) return;
    let previous = { x: event.clientX, y: event.clientY };
    front();
    const move = (next: PointerEvent) => {
      const rect = resized(edge, next.clientX - previous.x, next.clientY - previous.y);
      if (rect) setPlaced(rect);
      previous = { x: next.clientX, y: next.clientY };
    };
    trackPointerInteraction(event, move);
    event.preventDefault();
  };
  const arrows = (event: KeyboardEvent, action: (x: number, y: number) => void) => {
    if (!movable()) return;
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
  const titleLabel = () =>
    state() === "minimized"
      ? floatingWindowMessages().restoreWindow({ title: props.title })
      : movable()
        ? floatingWindowMessages().moveWindow({ title: props.title })
        : props.title;

  const view = (
    <>
      <Show when={state() === "maximized" && !mobile()}>
        <div
          class="k2b-floating-window-scrim"
          aria-hidden="true"
          style={{
            left: `${bounds().x}px`,
            top: `${bounds().y}px`,
            width: `${bounds().width}px`,
            height: `${bounds().height}px`,
            "border-radius": bounds().radius,
            "z-index": layer(),
          }}
          onClick={() => changeState("normal")}
        />
      </Show>
      <section
        ref={frame}
        class={`k2b-floating-window ${props.class ?? ""}`}
        data-mobile={mobile() ? "true" : undefined}
        data-state={state()}
        style={{
          "--k2b-window-accent": props.accent,
          left: frameRect() ? `${frameRect()!.x}px` : undefined,
          top: frameRect() ? `${frameRect()!.y}px` : undefined,
          width: frameRect() ? `${frameRect()!.width}px` : undefined,
          height: frameRect() ? `${frameRect()!.height}px` : undefined,
          "z-index": layer(),
        }}
        role="dialog"
        aria-modal={modal() ? "true" : "false"}
        aria-labelledby={titleId}
        tabIndex={-1}
        onPointerDown={front}
        onKeyDown={trapTab}
        onFocusIn={(event) => {
          if (event.target instanceof HTMLElement && body?.contains(event.target)) contentFocus = event.target;
        }}
      >
        <header onPointerDown={beginMove}>
          <Show when={props.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
          <div class="k2b-floating-window__heading">
            <button
              ref={titleButton}
              type="button"
              data-window-move
              class="k2b-floating-window__title"
              aria-label={titleLabel()}
              onClick={() => {
                if (state() === "minimized") changeState("normal");
              }}
              onKeyDown={(event) => arrows(event, moveBy)}
            >
              <span id={titleId} onPointerEnter={showTruncatedTitle}>
                {props.title}
              </span>
            </button>
            <Show when={props.status !== undefined && state() !== "minimized"}>
              <span class="k2b-floating-window__status">{props.status}</span>
            </Show>
          </div>
          <Show when={props.actions !== undefined && state() !== "minimized"}>
            <div class="k2b-floating-window__actions">{props.actions}</div>
          </Show>
          <div class="k2b-floating-window__controls">
            <Show when={!mobile()}>
              <Show when={state() !== "minimized"}>
                <IconButton size="sm" label={floatingWindowMessages().minimizeWindow} onClick={() => changeState("minimized")}>
                  <i class="ti ti-minus" aria-hidden="true" />
                </IconButton>
              </Show>
              <IconButton
                ref={maximizeButton}
                size="sm"
                label={state() === "maximized" ? floatingWindowMessages().restoreSize : floatingWindowMessages().maximizeWindow}
                onClick={() => changeState(state() === "maximized" ? "normal" : "maximized")}
              >
                <i class={state() === "maximized" ? "ti ti-arrows-diagonal-minimize-2" : "ti ti-arrows-diagonal"} aria-hidden="true" />
              </IconButton>
            </Show>
            <IconButton size="sm" class="k2b-floating-window__close" label={floatingWindowMessages().closeWindow} onClick={close}>
              <i class="ti ti-x" aria-hidden="true" />
            </IconButton>
          </div>
        </header>
        <div ref={body} class="k2b-floating-window__body">
          {props.children}
        </div>
        <Show when={movable()}>
          {handles.map(([edge, cursor]) =>
            edge === "bottom-right" ? (
              <button
                type="button"
                class="k2b-floating-window__resize"
                data-edge={edge}
                style={{ cursor }}
                aria-label={floatingWindowMessages().resizeWindow}
                onPointerDown={(event) => beginResize(edge, event)}
                onKeyDown={(event) =>
                  arrows(event, (x, y) => {
                    const rect = resized(edge, x, y);
                    if (rect) commitRect(rect);
                  })
                }
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
    </>
  );
  return <Portal mount={typeof document === "undefined" ? undefined : getK2bPortalRoot(props.resolveScope?.())}>{view}</Portal>;
}

export const openFloatingWindow = (
  view: (close: FloatingWindowClose) => JSX.Element,
  options: OpenFloatingWindowOptions,
): FloatingWindowClose => {
  if (typeof document === "undefined") throw new Error("Floating windows are browser-only");
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const previousRing = ringOnReturn(previousFocus);
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
    returnFocus(previousFocus, previousRing);
  };
  dispose = render(
    () => (
      <FloatingWindow {...options} resolveScope={options.resolveScope ?? (() => owner)} onClose={close}>
        <RenderErrorBoundary content={() => view(close)} />
      </FloatingWindow>
    ),
    owner,
  );
  return close;
};
