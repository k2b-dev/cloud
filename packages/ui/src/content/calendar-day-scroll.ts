/**
 * Scroll rules of the day and week views, free of the DOM so they can be tested.
 *
 * The day view runs down through the days and stops gently at each day start: within `STOP_ZONE` pixels of one the
 * wheel slows down, and a scroll that rests close to one glides onto it. The week view scrolls sideways through the
 * days; a wheel or trackpad gesture keeps the axis it started on, and a resting scroll glides to the nearest day start
 * or, with end space, day end at the edge of the visible room.
 */

/** Pixels before and after a day start in which the wheel slows down. */
export const STOP_ZONE = 72;
/** How much of a wheel step remains right at a day start. */
export const STOP_MIN_FACTOR = 0.16;
/** A resting scroll this close to a day start glides onto it: a wheel or trackpad, and a finger that flings further. */
export const SETTLE_RADIUS = { wheel: 40, touch: 88 } as const;
/** A pause between wheel events that starts a new gesture. */
export const GESTURE_GAP_MS = 150;

/** A wheel delta in pixels, whatever unit the browser reports it in. */
export const wheelPixels = (delta: number, mode: number, page: number): number => delta * (mode === 1 ? 40 : mode === 2 ? page : 1);

/** The index of the last stop at or before a position; `stops` are sorted. */
export const stopIndexAt = (stops: readonly number[], position: number): number => {
  let low = 0;
  let high = stops.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (stops[middle]! <= position + 2) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
};

export const nearestStop = (stops: readonly number[], position: number): number | undefined => {
  if (stops.length === 0) return undefined;
  const index = stopIndexAt(stops, position);
  const candidates = [stops[index], stops[index + 1]].filter((value): value is number => value !== undefined);
  return candidates.reduce((best, value) => (Math.abs(value - position) < Math.abs(best - position) ? value : best), candidates[0]!);
};

/** How much of a wheel step moves the view at a position: less the closer it is to a stop, eased. */
export const stopFactor = (stops: readonly number[], position: number): number => {
  const stop = nearestStop(stops, position);
  if (stop === undefined) return 1;
  const distance = Math.abs(position - stop);
  if (distance >= STOP_ZONE) return 1;
  const share = distance / STOP_ZONE;
  return STOP_MIN_FACTOR + (1 - STOP_MIN_FACTOR) * share * share * (3 - 2 * share);
};

/**
 * Where a wheel step of `delta` pixels takes the view, braked near stops, or `undefined` when no stop lies within
 * reach and the browser scrolls as usual. The first stop at 0 brakes nothing: there is no day before it to leave.
 */
export const brakedScroll = (stops: readonly number[], position: number, delta: number): number | undefined => {
  if (delta === 0) return undefined;
  const direction = Math.sign(delta);
  const reach = [position - STOP_ZONE, position + delta + direction * STOP_ZONE].sort((left, right) => left - right);
  if (!stops.some((stop) => stop > 0 && stop >= reach[0]! && stop <= reach[1]!)) return undefined;
  let next = position;
  let left = Math.abs(delta);
  while (left > 0) {
    const step = Math.min(2, left);
    next += direction * step * stopFactor(stops, next);
    left -= step;
  }
  return next;
};

/** The stop a resting scroll glides onto, or `undefined` when it rests on one or too far from any. */
export const settleTarget = (stops: readonly number[], position: number, radius: number): number | undefined => {
  const stop = nearestStop(stops, position);
  if (stop === undefined) return undefined;
  const distance = Math.abs(position - stop);
  return distance > 0.5 && distance < radius ? stop : undefined;
};

/** How far a header has crossed its stop, 0 to 1, for the line that fills while a day start passes. */
export const stopCrossing = (stop: number, position: number): number => {
  const distance = Math.abs(stop - position);
  return distance < STOP_ZONE ? 1 - distance / STOP_ZONE : 0;
};

export type WheelAxis = "x" | "y";

/** The axis a wheel gesture takes from its first event: Shift turns a vertical wheel sideways. */
export const wheelAxis = (deltaX: number, deltaY: number, shiftKey: boolean): WheelAxis => {
  if (shiftKey && Math.abs(deltaY) > Math.abs(deltaX)) return "x";
  return Math.abs(deltaX) > Math.abs(deltaY) ? "x" : "y";
};

/** The sideways part of a wheel event on an axis, Shift turning the vertical delta into a sideways one. */
export const wheelDelta = (axis: WheelAxis, deltaX: number, deltaY: number, shiftKey: boolean): number => {
  if (axis === "y") return deltaY;
  return shiftKey && deltaX === 0 ? deltaY : deltaX;
};

/** The nearest day start, or with `room` the nearer day edge at either end of the visible room; ties keep the start. */
export const snapToColumn = (position: number, width: number, room?: number): number => {
  if (!(width > 0)) return position;
  const start = Math.round(position / width) * width;
  if (room === undefined) return start;
  const end = Math.round((position + room) / width) * width - room;
  return Math.abs(end - position) < Math.abs(start - position) ? end : start;
};
