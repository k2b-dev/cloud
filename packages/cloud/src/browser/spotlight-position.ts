import type { DialogRender } from "@k2b/ui";

export type SpotlightPosition = { x: number; y: number };
const STORAGE_KEY = "cloud.spotlight.position.v1";
const MARGIN = 12;
const SNAP_DISTANCE = 24;

export const readSpotlightPosition = (value: string | null): SpotlightPosition | null => {
  try {
    const position: unknown = JSON.parse(value ?? "null");
    if (!position || typeof position !== "object" || !("x" in position) || !("y" in position)) return null;
    const { x, y } = position;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  } catch {
    return null;
  }
};

/** Cloud owns the desktop policy and persistence; the UI host owns modality and focus. */
export const attachSpotlightPosition = (host: HTMLElement, context: Parameters<DialogRender<void>>[1]) => {
  const { dialog } = context;
  const desktop = window.matchMedia("(min-width: 64rem) and (hover: hover) and (pointer: fine)");
  const enabled = () => desktop.matches && navigator.maxTouchPoints === 0;
  const active = () => host.parentElement?.style.display !== "none" && dialog.classList.contains("cloud-search-dialog");
  let stored: SpotlightPosition | null = null;
  try {
    stored = readSpotlightPosition(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    /* Storage can be disabled; dragging still works for this opening. */
  }
  let anchor = { x: 0, y: 0 };
  let bounds = { x: 0, y: 0 };
  let position: SpotlightPosition | null = null;
  let drag: {
    id: number;
    start: SpotlightPosition;
    origin: SpotlightPosition;
    previous: SpotlightPosition | null;
    handle: HTMLElement;
  } | null = null;

  const home = document.createElement("div");
  home.className = "cloud-global-search__home";
  home.setAttribute("aria-hidden", "true");
  host.append(home);
  const clamp = (point: SpotlightPosition) => {
    const rect = dialog.getBoundingClientRect();
    return {
      x: Math.max(MARGIN, Math.min(window.innerWidth - rect.width - MARGIN, point.x)),
      y: Math.max(MARGIN, Math.min(window.innerHeight - rect.height - MARGIN, point.y)),
    };
  };
  const renderPosition = () => {
    if (!active()) return;
    // Preserve the preferred point when growing upward to keep the panel on screen.
    context.setPosition(position ? clamp(position) : null);
    const rect = dialog.getBoundingClientRect();
    home.style.left = `${anchor.x - rect.x - dialog.clientLeft}px`;
    home.style.top = `${anchor.y - rect.y - dialog.clientTop}px`;
    home.style.width = `${rect.width}px`;
    home.style.height = `${Math.min(rect.height, window.innerHeight - 2 * anchor.y)}px`;
  };
  const apply = (next: SpotlightPosition | null) => {
    position = next;
    context.setModal(next === null);
    renderPosition();
  };
  const persist = () => {
    stored = position
      ? {
          x: bounds.x ? (position.x - MARGIN) / bounds.x : 0,
          y: bounds.y ? (position.y - MARGIN) / bounds.y : 0,
        }
      : null;
    try {
      if (stored) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* No persistence when storage is unavailable. */
    }
  };
  const layout = () => {
    if (!active()) return;
    context.setPosition(null);
    const rect = dialog.getBoundingClientRect();
    anchor = { x: rect.x, y: rect.y };
    // Vertical persistence describes the preferred top edge, independent of result height.
    bounds = { x: Math.max(0, window.innerWidth - rect.width - 2 * MARGIN), y: Math.max(0, window.innerHeight - 2 * MARGIN) };
    host.dataset.movable = String(enabled());
    apply(enabled() && stored ? { x: MARGIN + stored.x * bounds.x, y: MARGIN + stored.y * bounds.y } : null);
  };
  const finish = () => {
    if (!drag) return;
    const handle = drag.handle;
    const id = drag.id;
    drag = null;
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    delete host.dataset.dragging;
    persist();
  };
  const down = (event: PointerEvent) => {
    const handle = event.target;
    if (
      !enabled() ||
      !active() ||
      event.pointerType !== "mouse" ||
      event.button !== 0 ||
      !(handle instanceof HTMLElement) ||
      !handle.hasAttribute("data-search-grip")
    )
      return;
    event.preventDefault();
    const rect = dialog.getBoundingClientRect();
    drag = {
      id: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin: { x: rect.x, y: rect.y },
      previous: position,
      handle,
    };
    handle.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.start.x;
    const dy = event.clientY - drag.start.y;
    if (!host.dataset.dragging && Math.hypot(dx, dy) < 3) return;
    host.dataset.dragging = "true";
    const next = clamp({ x: drag.origin.x + dx, y: drag.origin.y + dy });
    apply(Math.hypot(next.x - anchor.x, next.y - anchor.y) <= SNAP_DISTANCE ? null : next);
    // Switching native modality releases capture. Retain the same drag across that switch.
    if (!drag.handle.hasPointerCapture(event.pointerId)) drag.handle.setPointerCapture(event.pointerId);
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId === drag?.id) finish();
  };
  const cancel = () => {
    if (!drag) return;
    apply(drag.previous);
    finish();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !drag) return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };
  const resize = () => {
    finish();
    layout();
  };
  const reset = () => {
    cancel();
    apply(null);
    persist();
  };
  host.addEventListener("pointerdown", down);
  const doubleClick = (event: MouseEvent) => {
    if (event.target instanceof HTMLElement && event.target.hasAttribute("data-search-grip")) reset();
  };
  host.addEventListener("dblclick", doubleClick);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", finish);
  window.addEventListener("keydown", escape, true);
  window.addEventListener("resize", resize);
  desktop.addEventListener("change", resize);
  // Mount happens before the native dialog is shown by the host.
  const frame = requestAnimationFrame(layout);
  const observer = new MutationObserver(layout);
  observer.observe(dialog, { attributes: true, attributeFilter: ["class"] });
  const sizeObserver = new ResizeObserver(renderPosition);
  sizeObserver.observe(dialog);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    sizeObserver.disconnect();
    home.remove();
    finish();
    host.removeEventListener("pointerdown", down);
    host.removeEventListener("dblclick", doubleClick);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", finish);
    window.removeEventListener("keydown", escape, true);
    window.removeEventListener("resize", resize);
    desktop.removeEventListener("change", resize);
  };
};
