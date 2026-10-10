import { dates as calendar, type DateContext } from "@k2b/stdlib";
import { layoutCalendarIntervals } from "./calendar-event-layout";

/**
 * The time model of the day and week views with `dayHours`: a day runs from its start hour to the same hour of the next
 * day, so the night after the waking hours belongs to the day before it. Every place in a day is a count of minutes on
 * the wall clock after that start, which keeps a day 24 hours long on the clock across a change to or from summer
 * time. The functions here are pure and work on `YYYY-MM-DD` day keys in the calendar's time zone.
 */

/** Waking hours: `start` begins the day, `end` begins its night, which lasts until `start` of the next day. */
export type CalendarDayHours = readonly [start: number, end: number];

export const DAY_MINUTES = 1440;
/** Free time from this length on is labelled, such as "1 hr free"; shorter gaps show only while dragging into them. */
export const GAP_LABEL_MINUTES = 60;
/** Free time from this length on stands out. */
export const GAP_LONG_MINUTES = 180;

const pad = (value: number) => String(value).padStart(2, "0");

/** Days since 1970-01-01 of a `YYYY-MM-DD` key; day keys need no time zone for this. */
export const dayKeyNumber = (key: string): number => {
  const [year = "1970", month = "1", day = "1"] = key.split("-");
  return Date.UTC(Number(year), Number(month) - 1, Number(day)) / 86_400_000;
};

export const keyOfDayNumber = (value: number): string => new Date(value * 86_400_000).toISOString().slice(0, 10);

export const addDayKeys = (key: string, days: number): string => keyOfDayNumber(dayKeyNumber(key) + days);

/** Every key from `first` to `last`, both included. */
export const dayKeyRange = (first: string, last: string): string[] => {
  const keys: string[] = [];
  for (let day = dayKeyNumber(first), end = dayKeyNumber(last); day <= end; day++) keys.push(keyOfDayNumber(day));
  return keys;
};

/** The wall clock of an instant in the calendar's time zone, as `YYYY-MM-DDTHH:mm`. */
export const wallClock = (instant: Date, context?: DateContext): string => {
  if (context?.timeZone) return calendar.instantToZonedInput(instant, context.timeZone);
  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}T${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
};

/** The instant of a wall clock in the calendar's time zone; a time a clock change skips moves forward, as clocks do. */
export const wallInstant = (wall: string, context?: DateContext): Date => {
  if (context?.timeZone) return new Date(calendar.zonedDateTimeToInstant(wall, context.timeZone, { disambiguation: "compatible" }));
  return new Date(wall);
};

const wallMinutes = (wall: string) => Number(wall.slice(11, 13)) * 60 + Number(wall.slice(14, 16));

/** Minutes on the wall clock from the start of the day `key` to the instant; negative before it, above 1440 after it. */
export const minuteInDay = (key: string, instant: Date, hours: CalendarDayHours, context?: DateContext): number => {
  const wall = wallClock(instant, context);
  return (dayKeyNumber(wall.slice(0, 10)) - dayKeyNumber(key)) * DAY_MINUTES + wallMinutes(wall) - hours[0] * 60;
};

/** The instant at a minute of the day `key`. */
export const instantInDay = (key: string, minute: number, hours: CalendarDayHours, context?: DateContext): Date => {
  const total = Math.round(minute) + hours[0] * 60;
  const day = Math.floor(total / DAY_MINUTES);
  const rest = total - day * DAY_MINUTES;
  return wallInstant(`${addDayKeys(key, day)}T${pad(Math.floor(rest / 60))}:${pad(rest % 60)}`, context);
};

/** The day an instant belongs to: before the start hour it is still the night of the day before. */
export const dayKeyOf = (instant: Date, hours: CalendarDayHours, context?: DateContext): string => {
  const wall = wallClock(instant, context);
  return wallMinutes(wall) < hours[0] * 60 ? addDayKeys(wall.slice(0, 10), -1) : wall.slice(0, 10);
};

/** The wall-clock time `HH:mm` at a minute of a day. */
export const clockAt = (minute: number, hours: CalendarDayHours): string => {
  const total = (((Math.round(minute) + hours[0] * 60) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
};

/** Minutes of the waking hours, from the start of the day to the start of its night. */
export const wakeMinutes = (hours: CalendarDayHours): number => ((((hours[1] - hours[0]) % 24) + 24) % 24) * 60 || DAY_MINUTES;

/** One entry the views place: a timed event, an all-day event, or a point in time such as a deadline. */
export type DayEntry<T> = {
  item: T;
  start: Date;
  /** For all-day entries the midnight after their last day. */
  end: Date;
  allDay: boolean;
  /** A point in time at `start`; an all-day point is due on its day. */
  marker: boolean;
};

/** A timed entry of one day, in minutes of that day. */
export type DayBand<T> = { item: T; start: number; end: number };
export type DayMarker<T> = { item: T; minute: number };
/** An entry of the all-day row: all-day events, timed events over several days, and points due on a day. */
export type DaySpan<T> = { item: T; firstKey: string; lastKey: string; marker: boolean };

export type DayModel<T> = {
  key: string;
  bands: DayBand<T>[];
  markers: DayMarker<T>[];
  spans: DaySpan<T>[];
  /** Something lies in the night, so it opens by default. */
  night: boolean;
  empty: boolean;
};

/** Where an entry goes: one day's timeline, or the all-day row over its days. */
export const placeEntry = <T>(
  entry: DayEntry<T>,
  hours: CalendarDayHours,
  context?: DateContext,
):
  | { kind: "band"; key: string; band: DayBand<T> }
  | { kind: "marker"; key: string; marker: DayMarker<T> }
  | { kind: "span"; span: DaySpan<T> } => {
  if (entry.allDay) {
    const firstKey = wallClock(entry.start, context).slice(0, 10);
    const endWall = wallClock(entry.end, context);
    // The end of an all-day entry is the midnight after its last day.
    const lastKey = entry.end > entry.start && endWall.slice(11) === "00:00" ? addDayKeys(endWall.slice(0, 10), -1) : endWall.slice(0, 10);
    return { kind: "span", span: { item: entry.item, firstKey, lastKey: lastKey < firstKey ? firstKey : lastKey, marker: entry.marker } };
  }
  const key = dayKeyOf(entry.start, hours, context);
  const start = minuteInDay(key, entry.start, hours, context);
  if (entry.marker) return { kind: "marker", key, marker: { item: entry.item, minute: start } };
  const lastKey = dayKeyOf(new Date(Math.max(entry.start.getTime(), entry.end.getTime() - 60_000)), hours, context);
  if (lastKey !== key) return { kind: "span", span: { item: entry.item, firstKey: key, lastKey, marker: false } };
  let end = minuteInDay(key, entry.end, hours, context);
  // In the hour a clock change repeats, the wall clock can end before it starts; the entry keeps its real length.
  const real = Math.round((entry.end.getTime() - entry.start.getTime()) / 60_000);
  if (end <= start && real > 0) end = start + real;
  return { kind: "band", key, band: { item: entry.item, start, end: Math.max(end, start) } };
};

/** The model of each day from `first` to `last`. */
export const buildDays = <T>(
  first: string,
  last: string,
  entries: readonly DayEntry<T>[],
  hours: CalendarDayHours,
  context?: DateContext,
): Map<string, DayModel<T>> => {
  const days = new Map<string, DayModel<T>>();
  for (const key of dayKeyRange(first, last)) days.set(key, { key, bands: [], markers: [], spans: [], night: false, empty: true });
  const wake = wakeMinutes(hours);
  for (const entry of entries) {
    const placed = placeEntry(entry, hours, context);
    if (placed.kind === "band") {
      const day = days.get(placed.key);
      if (!day) continue;
      day.bands.push(placed.band);
      if (placed.band.end > wake) day.night = true;
    } else if (placed.kind === "marker") {
      const day = days.get(placed.key);
      if (!day) continue;
      day.markers.push(placed.marker);
      if (placed.marker.minute >= wake) day.night = true;
    } else {
      const from = placed.span.firstKey < first ? first : placed.span.firstKey;
      const to = placed.span.lastKey > last ? last : placed.span.lastKey;
      for (const key of from <= to ? dayKeyRange(from, to) : []) days.get(key)?.spans.push(placed.span);
    }
  }
  for (const day of days.values()) {
    day.bands.sort((left, right) => left.start - right.start || right.end - left.end);
    day.markers.sort((left, right) => left.minute - right.minute);
    day.empty = day.bands.length === 0 && day.markers.length === 0 && day.spans.length === 0;
  }
  return days;
};

export type DayGap = { start: number; end: number; past: boolean };

/**
 * Free time of a day's waking hours between its timed entries. `now` is the current minute of this day, `Infinity`
 * for a day that is over, and `-Infinity` for one still ahead. The gap that holds now starts at the next quarter hour.
 */
export const freeGaps = <T>(bands: readonly DayBand<T>[], wake: number, now: number, minimum = 15): DayGap[] => {
  const busy = bands
    .map((band) => [Math.max(0, band.start), Math.min(wake, band.end)] as const)
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0]);
  const gaps: DayGap[] = [];
  const push = (start: number, end: number) => {
    let from = start;
    if (from < now && end > now) from = Math.min(end, Math.ceil(now / 15) * 15);
    if (end - from >= minimum) gaps.push({ start: from, end, past: end <= now });
  };
  let cursor = 0;
  for (const [start, end] of busy) {
    if (start > cursor) push(cursor, start);
    cursor = Math.max(cursor, end);
  }
  if (wake > cursor) push(cursor, wake);
  return gaps;
};

/**
 * What activating free time creates: a gap up to two hours whole, a longer one an hour from its start. A gap from the
 * start of the day that leaves room proposes 09:00, so "16 hrs free" never becomes a 16-hour event.
 */
export const gapProposal = (gap: Pick<DayGap, "start" | "end">, hours: CalendarDayHours): [start: number, end: number] => {
  if (gap.end - gap.start <= 120) return [gap.start, gap.end];
  const nine = (9 - hours[0]) * 60;
  const start = gap.start === 0 && nine > 0 && gap.end - 60 >= nine ? nine : gap.start;
  return [start, start + 60];
};

export type DayLane<T> = DayBand<T> & { lane: number; lanes: number };

/** Overlapping bands side by side; a band counts at least `minimum` minutes long, as its drawn height does. */
export const dayLanes = <T>(bands: readonly DayBand<T>[], minimum: number): DayLane<T>[] =>
  layoutCalendarIntervals(bands, (band) => ({ start: band.start, end: Math.max(band.end, band.start + minimum) })).map(
    ({ item, lane, lanes }) => ({ ...item, lane, lanes }),
  );

export type DayGroup = { kind: "day"; key: string } | { kind: "empty"; keys: string[] };

/** The days of the stream: each day with something in it alone, runs of empty days as one. Today never folds. */
export const dayGroups = (
  keys: readonly string[],
  empty: (key: string) => boolean,
  today: string,
  unfolded: ReadonlySet<string>,
): DayGroup[] => {
  const groups: DayGroup[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (unfolded.has(run[0]!)) for (const key of run) groups.push({ kind: "day", key });
    else groups.push({ kind: "empty", keys: run });
    run = [];
  };
  for (const key of keys) {
    if (empty(key) && key !== today) run.push(key);
    else {
      flush();
      groups.push({ kind: "day", key });
    }
  }
  flush();
  return groups;
};

/** Pixel sizes of a day's timeline: waking hours at full height, the night at half, below a bar or folded into a row. */
export type DayGeometry = {
  hour: number;
  nightHour: number;
  nightBar: number;
  fold: number;
  wake: number;
  expanded: boolean;
};

/** The top of a minute. */
export const dayY = (geometry: DayGeometry, minute: number): number => {
  const { hour, nightHour, nightBar, fold, wake, expanded } = geometry;
  const awake = (wake / 60) * hour;
  if (minute <= wake) return (Math.max(0, minute) / 60) * hour;
  if (!expanded) return awake + fold / 2;
  return awake + nightBar + ((Math.min(minute, DAY_MINUTES) - wake) / 60) * nightHour;
};

/** The top of something that starts at a minute: from the start of the night on, below the night's bar. */
export const dayTopY = (geometry: DayGeometry, minute: number): number =>
  minute >= geometry.wake && geometry.expanded ? dayY(geometry, Math.max(minute, geometry.wake + 1e-6)) : dayY(geometry, minute);

/** The minute at a height, the inverse of `dayY`; the night's bar and a folded night map to the start of the night. */
export const dayMinuteAt = (geometry: DayGeometry, y: number): number => {
  const { hour, nightHour, nightBar, wake, expanded } = geometry;
  const awake = (wake / 60) * hour;
  if (y <= awake) return (Math.max(0, y) / hour) * 60;
  if (!expanded || y < awake + nightBar) return wake;
  return Math.min(DAY_MINUTES, wake + ((y - awake - nightBar) / nightHour) * 60);
};

export const dayHeight = (geometry: DayGeometry): number =>
  (geometry.wake / 60) * geometry.hour +
  (geometry.expanded ? geometry.nightBar + ((DAY_MINUTES - geometry.wake) / 60) * geometry.nightHour : geometry.fold);

/** The last minute the timeline draws: the end of the night when it is open, else the start of the night. */
export const dayLimit = (geometry: DayGeometry): number => (geometry.expanded ? DAY_MINUTES : geometry.wake);

/** Rounds to the step, the 15 or 5 minutes a pointer snaps to. */
export const snapMinutes = (minute: number, step: number): number => Math.round(minute / step) * step;

/**
 * A height in a day's timeline as counts of the four sizes the stylesheet sets: waking hours, night hours, the night's
 * bar, and the folded night row. The views draw with these, so a phone's smaller hours need no script.
 */
export type DayTerms = readonly [hours: number, nightHours: number, nightBars: number, folds: number];

/** `dayY` as terms. */
export const dayYTerms = (wake: number, expanded: boolean, minute: number): DayTerms => {
  if (minute <= wake) return [Math.max(0, minute) / 60, 0, 0, 0];
  if (!expanded) return [wake / 60, 0, 0, 0.5];
  return [wake / 60, (Math.min(minute, DAY_MINUTES) - wake) / 60, 1, 0];
};

/** `dayTopY` as terms. */
export const dayTopTerms = (wake: number, expanded: boolean, minute: number): DayTerms =>
  minute >= wake && expanded ? [wake / 60, (Math.min(minute, DAY_MINUTES) - wake) / 60, 1, 0] : dayYTerms(wake, expanded, minute);

/** `dayHeight` as terms. */
export const dayHeightTerms = (wake: number, expanded: boolean): DayTerms =>
  expanded ? [wake / 60, (DAY_MINUTES - wake) / 60, 1, 0] : [wake / 60, 0, 0, 1];

export const subtractTerms = (left: DayTerms, right: DayTerms): DayTerms => [
  left[0] - right[0],
  left[1] - right[1],
  left[2] - right[2],
  left[3] - right[3],
];

const TERM_SIZES = ["--k2b-calendar-hour", "--k2b-calendar-night-hour", "--k2b-calendar-night-bar", "--k2b-calendar-fold"] as const;

/** Terms as a CSS length over the sizes of the stylesheet. */
export const termsCss = (terms: DayTerms): string => {
  const parts = terms.flatMap((count, index) =>
    Math.abs(count) < 1e-6 ? [] : [`${Math.round(count * 10_000) / 10_000} * var(${TERM_SIZES[index]})`],
  );
  return parts.length === 0 ? "0px" : `calc(${parts.join(" + ")})`;
};

/** The pixel sizes of the terms where an element draws its timeline, for pointer positions. */
export const readDayGeometry = (element: Element, wake: number, expanded: boolean): DayGeometry => {
  const style = getComputedStyle(element);
  const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  // Custom properties keep the units they were written in, such as "3.5rem".
  const size = (name: string, fallback: number) => {
    const value = style.getPropertyValue(name).trim();
    const number = Number.parseFloat(value);
    if (!Number.isFinite(number)) return fallback;
    if (value.endsWith("rem")) return number * rootSize;
    if (value.endsWith("em")) return number * (Number.parseFloat(style.fontSize) || rootSize);
    return number;
  };
  return {
    hour: size(TERM_SIZES[0], 56),
    nightHour: size(TERM_SIZES[1], 28),
    nightBar: size(TERM_SIZES[2], 32),
    fold: size(TERM_SIZES[3], 40),
    wake,
    expanded,
  };
};
