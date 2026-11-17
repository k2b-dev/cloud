/**
 * Rules of the typed time field: what a text means as a 24-hour clock time `HH:mm`, the minute grid of `step`, and
 * the bounds `min` and `max`. `24:00` is a time only where `max` allows it, as the end of a day.
 */

export type TimeTextResult = { kind: "empty" } | { kind: "time"; value: string } | { kind: "error" };
export type TimeLimitError = { code: "earliest"; time: string } | { code: "latest"; time: string };

const DAY_END = 24 * 60;
const pad = (value: number) => String(value).padStart(2, "0");

/** `HH:mm` from minutes after midnight; 1440 is `24:00`. */
export const timeFromMinutes = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** Minutes after midnight of an `HH:mm` value, or `null` for anything else. `24:00` is 1440. */
export const timeToMinutes = (value: string | null | undefined): number | null => {
  const match = value ? /^(\d{2}):(\d{2})$/.exec(value) : null;
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[2]) <= 59 && minutes <= DAY_END ? minutes : null;
};

/**
 * Keeps what can still become a time while someone types: up to four digits and one separator after the hour.
 * `.`, `h` and a space count as the separator and become `:`.
 */
export const filterTimeText = (value: string): string => {
  let hours = "";
  let minutes = "";
  let separated = false;
  for (const character of value) {
    if (/\d/.test(character)) {
      if (separated) {
        if (minutes.length < 2) minutes += character;
      } else if (hours.length < 4) hours += character;
    } else if (/[:.h\s]/i.test(character) && !separated && hours.length >= 1 && hours.length <= 2) {
      separated = true;
    }
  }
  return separated ? `${hours}:${minutes}` : hours;
};

/**
 * What a typed text means: `9` and `09` are 09:00, `930` and `0930` are 09:30, `9:5` is 09:05. Hours above 24 and
 * minutes above 59 are no time; `24:00` is, and the bounds decide whether it is allowed.
 */
export const parseTimeText = (text: string): TimeTextResult => {
  const value = text.trim();
  if (!value) return { kind: "empty" };
  const parts = /^(\d{1,2})(?:[:.h\s](\d{1,2})?)?$/i.exec(value) ?? /^(\d{1,2})(\d{2})$/.exec(value);
  if (!parts) return { kind: "error" };
  const hours = Number(parts[1]);
  const minutes = Number(parts[2] ?? 0);
  if (minutes > 59 || hours * 60 + minutes > DAY_END) return { kind: "error" };
  return { kind: "time", value: timeFromMinutes(hours * 60 + minutes) };
};

/**
 * The nearest time on the grid of `step` minutes, counted from `min` (or midnight). A time of the day that would round
 * up to midnight takes the last grid line before it instead, so snapping never leaves the day.
 */
export const snapTime = (value: string, step: number | undefined, min?: string): string => {
  const minutes = timeToMinutes(value);
  if (minutes === null || !step || step <= 1) return value;
  const anchor = timeToMinutes(min) ?? 0;
  let snapped = Math.round((minutes - anchor) / step) * step + anchor;
  if (snapped >= DAY_END && minutes < DAY_END) snapped -= step;
  return timeFromMinutes(Math.max(0, snapped));
};

/** Why a time lies outside `min`/`max`; without `max`, 23:59 is the last time of the day. */
export const timeLimitError = (value: string, limits: { min?: string; max?: string }): TimeLimitError | undefined => {
  const minutes = timeToMinutes(value);
  if (minutes === null) return undefined;
  const min = timeToMinutes(limits.min);
  const max = timeToMinutes(limits.max) ?? DAY_END - 1;
  if (min !== null && minutes < min) return { code: "earliest", time: timeFromMinutes(min) };
  if (minutes > max) return { code: "latest", time: timeFromMinutes(max) };
  return undefined;
};
