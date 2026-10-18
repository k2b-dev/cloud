import { suppressTextSelection } from "../internal/text-selection";

export type ResizeSeparatorOptions = {
  min: number;
  max: number;
  value: () => number;
  /** Pixels per value unit. Defaults to 1. */
  unit?: number;
  step?: number;
  largeStep?: number;
  grow: "start" | "end";
  collapseBelow?: number;
  onResize: (value: number) => void;
  onResizeEnd?: (value: number) => void;
  onCollapseIntent?: (armed: boolean) => void;
  onCollapse?: () => void;
  onDragChange?: (dragging: boolean) => void;
};

/** Adds resizing to a server-rendered separator; orientation comes from aria-orientation. */
export function attachResizeSeparator(element: HTMLElement, options: ResizeSeparatorOptions): () => void {
  const clamp = (value: number) => Math.min(options.max, Math.max(options.min, value));
  const setAria = (value: number) => element.setAttribute("aria-valuenow", String(Math.round(value * 100) / 100));
  const vertical = () => element.getAttribute("aria-orientation") !== "horizontal";
  const direction = () => (options.grow === "end" ? 1 : -1) * (vertical() && getComputedStyle(element).direction === "rtl" ? -1 : 1);
  let drag: { id: number; start: number; value: number; current: number; armed: boolean; releaseSelection: () => void } | undefined;
  const resize = (raw: number) => {
    const value = clamp(raw);
    setAria(value);
    options.onResize(value);
    return value;
  };
  const finish = (commit: boolean) => {
    if (!drag) return;
    const ended = drag;
    drag = undefined;
    element.removeAttribute("data-active");
    ended.releaseSelection();
    if (element.hasPointerCapture?.(ended.id)) element.releasePointerCapture(ended.id);
    options.onDragChange?.(false);
    if (ended.armed) options.onCollapseIntent?.(false);
    if (!commit) resize(ended.value);
    else if (ended.armed) options.onCollapse?.();
    else options.onResizeEnd?.(ended.current);
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || event.isPrimary === false || drag) return;
    event.preventDefault();
    element.focus();
    drag = {
      id: event.pointerId,
      start: vertical() ? event.clientX : event.clientY,
      value: options.value(),
      current: options.value(),
      armed: false,
      releaseSelection: suppressTextSelection(event.pointerId),
    };
    element.setPointerCapture?.(event.pointerId);
    element.dataset.active = "true";
    options.onDragChange?.(true);
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    const raw = drag.value + (((vertical() ? event.clientX : event.clientY) - drag.start) * direction()) / (options.unit ?? 1);
    const armed = options.collapseBelow !== undefined && raw < options.collapseBelow;
    if (armed !== drag.armed) {
      drag.armed = armed;
      options.onCollapseIntent?.(armed);
    }
    drag.current = resize(raw);
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId === drag?.id) finish(true);
  };
  const cancelPointer = (event: PointerEvent) => {
    if (event.pointerId === drag?.id) finish(false);
  };
  const cancel = () => finish(false);
  const key = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || drag) return;
    const decrease = vertical() ? "ArrowLeft" : "ArrowUp";
    const increase = vertical() ? "ArrowRight" : "ArrowDown";
    const step = event.shiftKey ? (options.largeStep ?? (options.step ?? 1) * 4) : (options.step ?? 1);
    let value: number;
    if (event.key === "Home") value = options.min;
    else if (event.key === "End") value = options.max;
    else if (event.key === decrease || event.key === increase)
      value = options.value() + (event.key === increase ? 1 : -1) * direction() * step;
    else return;
    event.preventDefault();
    const resized = resize(value);
    options.onResizeEnd?.(resized);
  };
  setAria(clamp(options.value()));
  element.addEventListener("pointerdown", down);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancelPointer);
  element.addEventListener("lostpointercapture", cancelPointer);
  element.addEventListener("keydown", key);
  window.addEventListener("blur", cancel);
  return () => {
    cancel();
    element.removeEventListener("pointerdown", down);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancelPointer);
    element.removeEventListener("lostpointercapture", cancelPointer);
    element.removeEventListener("keydown", key);
    window.removeEventListener("blur", cancel);
  };
}
