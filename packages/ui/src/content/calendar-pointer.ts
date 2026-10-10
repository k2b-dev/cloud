import { suppressTextSelection } from "../internal/text-selection";

export const CALENDAR_SNAP_MINUTES = 15;

export const snapCalendarMinutes = (minutes: number, step = CALENDAR_SNAP_MINUTES): number => Math.round(minutes / step) * step;

export const calendarDayIndexAtPoint = (clientX: number, startX: number, width: number, days: number): number | null => {
  if (days <= 0 || width <= 0 || clientX < startX || clientX >= startX + width) return null;
  return Math.min(days - 1, Math.floor(((clientX - startX) / width) * days));
};

export const calendarMinuteAtPoint = (clientY: number, top: number, height: number, startHour: number, endHour: number): number => {
  const totalMinutes = Math.max(60, (endHour - startHour + 1) * 60);
  const ratio = height > 0 ? Math.min(1, Math.max(0, (clientY - top) / height)) : 0;
  return snapCalendarMinutes(startHour * 60 + ratio * totalMinutes);
};

export const calendarAutoScrollSpeed = (clientY: number, top: number, bottom: number, edge = 56, maximum = 18): number => {
  if (clientY < top + edge) return -Math.ceil(maximum * Math.min(1, (top + edge - clientY) / edge));
  if (clientY > bottom - edge) return Math.ceil(maximum * Math.min(1, (clientY - (bottom - edge)) / edge));
  return 0;
};

type CalendarPointerSessionOptions<T> = {
  event: PointerEvent;
  resolve: (clientX: number, clientY: number) => T | null;
  onActivate?: () => void;
  onPreview: (value: T) => void;
  onCommit: (value: T) => void;
  onCancel?: () => void;
  scrollContainer?: HTMLElement;
  threshold?: number;
};

let cancelActiveSession: (() => void) | null = null;

/**
 * Owns one pointer gesture from threshold crossing through commit or cancel.
 * Views provide geometry through `resolve`; this helper owns global cleanup,
 * pointer cancellation, Escape handling, and edge auto-scroll.
 */
export const startCalendarPointerSession = <T>(options: CalendarPointerSessionOptions<T>): (() => void) => {
  if (options.event.button !== 0 || !options.event.isPrimary) return () => {};

  cancelActiveSession?.();

  const pointerId = options.event.pointerId;
  const target = options.event.currentTarget instanceof HTMLElement ? options.event.currentTarget : null;
  const startX = options.event.clientX;
  const startY = options.event.clientY;
  // Leave enough room for normal click jitter before an event becomes a drag.
  const threshold = options.threshold ?? 6;
  let clientX = startX;
  let clientY = startY;
  let active = false;
  let finished = false;
  let latest: T | null = null;
  let scrollFrame = 0;
  let releaseTextSelection: (() => void) | null = null;

  const preview = () => {
    const value = options.resolve(clientX, clientY);
    if (value === null) return;
    latest = value;
    options.onPreview(value);
  };

  const autoScroll = () => {
    scrollFrame = 0;
    if (!active || !options.scrollContainer) return;
    const rect = options.scrollContainer.getBoundingClientRect();
    const speed = calendarAutoScrollSpeed(clientY, rect.top, rect.bottom);
    if (speed !== 0) {
      const before = options.scrollContainer.scrollTop;
      options.scrollContainer.scrollTop += speed;
      if (options.scrollContainer.scrollTop !== before) preview();
    }
    scrollFrame = requestAnimationFrame(autoScroll);
  };

  const cleanup = () => {
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("keydown", onKeyDown);
    if (target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
    releaseTextSelection?.();
    if (cancelActiveSession === cancel) cancelActiveSession = null;
  };

  const activate = () => {
    if (active) return;
    active = true;
    releaseTextSelection = suppressTextSelection(pointerId);
    target?.setPointerCapture?.(pointerId);
    options.onActivate?.();
    preview();
    if (options.scrollContainer) scrollFrame = requestAnimationFrame(autoScroll);
  };

  function cancel() {
    if (finished) return;
    finished = true;
    cleanup();
    if (active) options.onCancel?.();
  }

  function onMove(event: PointerEvent) {
    if (finished || event.pointerId !== pointerId) return;
    clientX = event.clientX;
    clientY = event.clientY;
    if (!active && Math.hypot(clientX - startX, clientY - startY) >= threshold) activate();
    if (!active) return;
    event.preventDefault();
    preview();
  }

  function onUp(event: PointerEvent) {
    if (finished || event.pointerId !== pointerId) return;
    finished = true;
    cleanup();
    if (active && latest !== null) options.onCommit(latest);
    else if (active) options.onCancel?.();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    cancel();
  }

  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", cancel);
  window.addEventListener("keydown", onKeyDown);
  cancelActiveSession = cancel;
  return cancel;
};
