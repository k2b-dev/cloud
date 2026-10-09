import { dates as calendar, type DateContext } from "@k2b/stdlib";
import { layoutCalendarIntervals } from "./calendar-event-layout";

/** A color token of the shared calendar palette, or a hex color such as a label color. */
export type TimelineColor = "blue" | "emerald" | "amber" | "red" | "violet" | "cyan" | "zinc" | `#${string}`;

export type TimelineItem = {
  /** Unique among the items. */
  id: string;
  label: string;
  /** A date-only string (`2026-10-08`) is a day in the time zone; anything else is an instant. */
  start: Date | string;
  /** End of a band. Without it, the item is a point in time. For all-day items, a midnight end is exclusive. */
  end?: Date | string;
  allDay?: boolean;
  /** `band` (default) shows the duration; `marker` shows a point in time at `start`, such as a deadline. */
  kind?: "band" | "marker";
  color?: TimelineColor;
  /** Extra text such as a place or a category: read with the item and shown where there is room. */
  detail?: string;
  /** Checkbox state. Leave it out for items without a checkbox. */
  checked?: boolean;
  /** Link target; without it the item is a button. */
  href?: string;
};

/**
 * A place on the main axis as the count of each unit before it: hours of waking time, nights, folds of empty days,
 * day headings, and all-day rows. The axis gives every unit its size, so one model serves both axes.
 */
export type TimelineSpan = readonly [hours: number, nights: number, folds: number, heads: number, rows: number];
export type TimelineUnits = TimelineSpan;

export const TIMELINE_UNIT_NAMES = ["hour", "night", "fold", "head", "row"] as const;
/** Waking hours; the night between them is folded. */
export const TIMELINE_WAKE_HOURS = [6, 22] as const;
/** Visible lanes of overlapping bands and of all-day items; more overlaps collapse into a "+n" entry in the last lane. */
export const TIMELINE_BAND_LANES = 3;
export const TIMELINE_ALL_DAY_LANES = 2;
/** Visible items stacked in one night or fold; more collapse into a "+n" entry in the last place. */
export const TIMELINE_FOLD_LANES = 3;
/** Free time shorter than this gets no label. */
const MIN_GAP = 3_600_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const ZERO: TimelineSpan = [0, 0, 0, 0, 0];
const NIGHT: TimelineSpan = [0, 1, 0, 0, 0];
const FOLD: TimelineSpan = [0, 0, 1, 0, 0];
const HEAD: TimelineSpan = [0, 0, 0, 1, 0];
const ROW: TimelineSpan = [0, 0, 0, 0, 1];
const hours = (ms: number): TimelineSpan => [ms / HOUR, 0, 0, 0, 0];

export const addSpan = (a: TimelineSpan, b: TimelineSpan): TimelineSpan => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
  a[3] + b[3],
  a[4] + b[4],
];
export const subtractSpan = (a: TimelineSpan, b: TimelineSpan): TimelineSpan => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
  a[3] - b[3],
  a[4] - b[4],
];
const scaleSpan = (a: TimelineSpan, factor: number): TimelineSpan => [
  a[0] * factor,
  a[1] * factor,
  a[2] * factor,
  a[3] * factor,
  a[4] * factor,
];
export const spanPx = (span: TimelineSpan, units: TimelineUnits): number =>
  span[0] * units[0] + span[1] * units[1] + span[2] * units[2] + span[3] * units[3] + span[4] * units[4];

const round = (value: number) => Math.round(value * 10_000) / 10_000;
/** The span as a CSS length over the `--k2b-timeline-<unit>` sizes the axis sets. */
export const spanCss = (span: TimelineSpan): string => {
  const terms = span.flatMap((count, index) =>
    Math.abs(count) < 1e-6 ? [] : [`${round(count)} * var(--k2b-timeline-${TIMELINE_UNIT_NAMES[index]})`],
  );
  return terms.length === 0 ? "0px" : `calc(${terms.join(" + ")})`;
};

export type TimelineSegment = {
  kind: "head" | "row" | "wake" | "night" | "fold";
  t0: number;
  t1: number;
  at: TimelineSpan;
  size: TimelineSpan;
  group: number;
};

type EntryBase = {
  /** Entry id: the item id, or for a "+n" entry `more:<first hidden id>`, made unique among the item ids. */
  id: string;
  group: number;
  /** The item's own times, also beyond the loaded range; for all-day entries, group indexes. */
  start: number;
  end: number;
  /** Main-axis place relative to the group, and length. */
  at: TimelineSpan;
  size: TimelineSpan;
  lane: number;
  lanes: number;
};

export type TimelineItemEntry = EntryBase & {
  kind: "band" | "marker" | "folded" | "all-day";
  item: TimelineItem;
  /** For all-day items: the first and last day of the item inside the range. */
  firstKey: string;
  lastKey: string;
};

export type TimelineMoreEntry = EntryBase & {
  kind: "more";
  area: "band" | "fold" | "all-day";
  hidden: TimelineItemEntry[];
};

export type TimelineEntry = TimelineItemEntry | TimelineMoreEntry;

export type TimelineGroup = {
  index: number;
  /** `day:<date>` or `fold:<first>:<last>`; stable while the group keeps its days. */
  key: string;
  kind: "day" | "fold";
  firstKey: string;
  lastKey: string;
  t0: number;
  t1: number;
  /** Times the group's entries reach, beyond its own span for items in a neighbouring fold or over several days. */
  reach: [number, number];
  at: TimelineSpan;
  size: TimelineSpan;
  /** The group reserves a row for all-day items (vertical axis only). */
  row: boolean;
  today: boolean;
  past: boolean;
  /** List order: all-day items, then timed entries by start. */
  entries: TimelineEntry[];
  /** All-day entries of earlier groups that cover this group too. */
  echoes: TimelineEntry[];
  hours: Array<{ time: number; at: TimelineSpan }>;
  folds: Array<{ kind: "night" | "fold"; at: TimelineSpan; size: TimelineSpan }>;
  gaps: Array<{ at: TimelineSpan; end: number; hours: number; long: boolean }>;
};

export type TimelineModel = {
  from: number;
  to: number;
  segments: TimelineSegment[];
  groups: TimelineGroup[];
  total: TimelineSpan;
  entries: Map<string, TimelineEntry>;
  /** Keyboard order of every entry id. */
  order: string[];
  posOf: (time: number) => TimelineSpan;
  /** The time at a pixel offset along the main axis. */
  timeAt: (px: number, units: TimelineUnits) => number;
};

const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
export const parseTimelineTime = (value: Date | string | undefined, context?: DateContext): number => {
  if (value === undefined) return Number.NaN;
  if (value instanceof Date) return value.getTime();
  if (dateOnly.test(value)) return calendar.parseCalendarDate(value, context).getTime();
  return new Date(value).getTime();
};

const pad = (value: number) => String(value).padStart(2, "0");
const zoneFormats = new Map<string, Intl.DateTimeFormat>();
/** Wall-clock parts of an instant in a time zone, with one cached formatter per zone: a year of items calls this often. */
const zonedParts = (time: number, timeZone: string): [number, number, number, number, number, number] => {
  let format = zoneFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    zoneFormats.set(timeZone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(time)) if (part.type !== "literal") parts[part.type] = Number(part.value);
  return [parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0];
};
const zoneOffset = (time: number, timeZone: string): number => {
  const [year, month, day, hour, minute, second] = zonedParts(time, timeZone);
  return Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(time / 1_000) * 1_000;
};

/** The day (`YYYY-MM-DD`) of an instant in the context's time zone. */
export const timelineDayKey = (time: number, context?: DateContext): string => {
  if (!context?.timeZone) {
    const date = new Date(time);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  const [year, month, day] = zonedParts(time, context.timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
};

export const shiftDayKey = (key: string, days: number): string => {
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

/**
 * The instant of a whole hour (0–24) on a day in the context's time zone. As stdlib's `compatible` disambiguation, a
 * repeated hour resolves to its first occurrence and a skipped one to the time after the gap.
 */
export const timelineHourOf = (key: string, hour: number, context?: DateContext): number => {
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  if (!context?.timeZone) return new Date(year, month - 1, day, hour).getTime();
  const zone = context.timeZone;
  const wall = Date.UTC(year, month - 1, day, hour);
  // The offsets a day before and after are the ones on either side of a clock change at this time.
  const before = wall - zoneOffset(wall - DAY, zone);
  const after = wall - zoneOffset(wall + DAY, zone);
  const valid = [before, after].filter((time) => zoneOffset(time, zone) === wall - time);
  return valid.length > 0 ? Math.min(...valid) : before;
};

type Normalized = {
  item: TimelineItem;
  start: number;
  end: number;
  allDay: boolean;
  point: boolean;
  firstKey: string;
  lastKey: string;
};

const normalize = (item: TimelineItem, keyOf: (time: number) => string, context?: DateContext): Normalized | null => {
  const start = parseTimelineTime(item.start, context);
  if (!Number.isFinite(start)) return null;
  const parsedEnd = parseTimelineTime(item.end, context);
  const firstKey = keyOf(start);
  if (item.allDay) {
    const end = Number.isFinite(parsedEnd) && parsedEnd > start ? parsedEnd : start;
    const endKey = keyOf(end);
    const exclusive = end > start && timelineHourOf(endKey, 0, context) === end;
    const lastKey = exclusive ? shiftDayKey(endKey, -1) : endKey;
    return { item, start, end, allDay: true, point: false, firstKey, lastKey: lastKey < firstKey ? firstKey : lastKey };
  }
  const point = item.kind === "marker" || !Number.isFinite(parsedEnd) || parsedEnd <= start;
  return { item, start, end: point ? start : parsedEnd, allDay: false, point, firstKey, lastKey: firstKey };
};

const byStart = (a: { start: number; end: number; id: string }, b: { start: number; end: number; id: string }) =>
  a.start - b.start || b.end - a.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Lays out overlapping entries in at most `max` lanes. Where a cluster needs more, the entries beyond the last lane and
 * the ones they meet in it collapse into "+n" entries in the last lane, one per run of overlapping hidden entries.
 */
const laneEntries = (entries: TimelineItemEntry[], max: number): TimelineItemEntry[][] => {
  const clusters = new Map<number, Array<{ entry: TimelineItemEntry; lane: number; lanes: number }>>();
  for (const layout of layoutCalendarIntervals(entries, (entry) => entry)) {
    const cluster = clusters.get(layout.groupId) ?? [];
    cluster.push({ entry: layout.item, lane: layout.lane, lanes: layout.lanes });
    clusters.set(layout.groupId, cluster);
  }
  const runs: TimelineItemEntry[][] = [];
  for (const cluster of clusters.values()) {
    const lanes = cluster[0]?.lanes ?? 1;
    if (lanes <= max) {
      for (const { entry, lane } of cluster) {
        entry.lane = lane;
        entry.lanes = lanes;
      }
      continue;
    }
    // The last visible lane keeps its entries where they meet nothing beyond it.
    const beyond = cluster.filter(({ lane }) => lane >= max).map(({ entry }) => entry);
    const hidden: TimelineItemEntry[] = [];
    for (const { entry, lane } of cluster) {
      const overlapsBeyond = beyond.some((other) => other.start < entry.end && entry.start < other.end);
      if (lane >= max || (lane === max - 1 && overlapsBeyond)) hidden.push(entry);
      else {
        entry.lane = lane;
        entry.lanes = max;
      }
    }
    // Runs of hidden entries that overlap each other become one "+n" entry each.
    let run: TimelineItemEntry[] | undefined;
    let runEnd = Number.NEGATIVE_INFINITY;
    for (const entry of hidden.sort(byStart)) {
      const { start, end } = entry;
      if (run && start < runEnd) {
        run.push(entry);
        runEnd = Math.max(runEnd, end);
      } else {
        run = [entry];
        runs.push(run);
        runEnd = end;
      }
    }
  }
  return runs;
};

export type TimelineModelInput = {
  from: number;
  to: number;
  /** The current day (`YYYY-MM-DD`), which always stays open. */
  today: string;
  items: readonly TimelineItem[];
  context?: DateContext;
};

/**
 * Builds the filmstrip: waking hours (6–22) are proportional, every night is one fold, and a run of days without
 * timed items is one fold. Positions depend only on the times and the items, never on measurement.
 */
export const buildTimelineModel = ({ from, to, today, items, context }: TimelineModelInput): TimelineModel => {
  const [wakeStart, wakeEnd] = TIMELINE_WAKE_HOURS;

  const segments: TimelineSegment[] = [];
  const groups: TimelineGroup[] = [];
  const groupOfKey = new Map<string, number>();
  const valid = Number.isFinite(from) && Number.isFinite(to) && to > from;
  const firstKey = valid ? timelineDayKey(from, context) : "";
  const lastKey = valid ? timelineDayKey(to - 1, context) : "";
  const todayKey = today;
  const wake = new Map<string, [number, number]>();
  const wakeOf = (key: string): [number, number] => {
    let value = wake.get(key);
    if (!value) {
      // Clocks change at night, so the waking hours of a day are whole hours after its 06:00.
      const open = timelineHourOf(key, wakeStart, context);
      value = [open, open + (wakeEnd - wakeStart) * HOUR];
      wake.set(key, value);
    }
    return value;
  };
  // Day keys of loaded times by binary search over the midnights, instead of a time-zone lookup per item.
  const dayKeys: string[] = [];
  const midnights: number[] = [];
  for (let key = firstKey; valid && key <= shiftDayKey(lastKey, 1); key = shiftDayKey(key, 1)) {
    dayKeys.push(key);
    midnights.push(timelineHourOf(key, 0, context));
  }
  const keyOf = (t: number): string => {
    if (midnights.length < 2 || t < midnights[0]! || t >= midnights.at(-1)!) return timelineDayKey(t, context);
    let low = 0;
    let high = midnights.length - 2;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (midnights[middle]! <= t) low = middle;
      else high = middle - 1;
    }
    return dayKeys[low]!;
  };
  const normalized = items.flatMap((item) => normalize(item, keyOf, context) ?? []);

  // Days with timed items in their waking hours stay open; today always does. So does a day at either edge whose
  // waking hours are loaded only in part: whether it is empty is not known yet, and folding it now would reshape it
  // when the rest loads.
  const busy = new Set<string>([todayKey]);
  if (valid) {
    const [firstOpen, firstClose] = wakeOf(firstKey);
    if (from > firstOpen && from < firstClose) busy.add(firstKey);
    const [lastOpen, lastClose] = wakeOf(lastKey);
    if (to > lastOpen && to < lastClose) busy.add(lastKey);
  }
  const covered = new Set<string>();
  for (const entry of valid ? normalized : []) {
    if (entry.allDay) {
      const first = entry.firstKey < firstKey ? firstKey : entry.firstKey;
      const last = entry.lastKey > lastKey ? lastKey : entry.lastKey;
      for (let key = first; key <= last; key = shiftDayKey(key, 1)) covered.add(key);
      continue;
    }
    const start = Math.max(entry.start, from);
    const end = Math.min(entry.end, to);
    if (entry.point ? entry.start < from || entry.start >= to : end <= start) continue;
    const last = keyOf(entry.point ? start : end - 1);
    for (let key = keyOf(start); key <= last; key = shiftDayKey(key, 1)) {
      const [open, close] = wakeOf(key);
      if (entry.point ? start >= open && start < close : start < close && end > open) busy.add(key);
    }
  }

  let pos = ZERO;
  let time = from;
  const push = (kind: TimelineSegment["kind"], t0: number, t1: number, size: TimelineSpan) => {
    segments.push({ kind, t0, t1, at: pos, size, group: groups.length - 1 });
    pos = addSpan(pos, size);
  };
  const openGroup = (kind: TimelineGroup["kind"], first: string, last: string) => {
    let row = false;
    for (let key = first; key <= last; key = shiftDayKey(key, 1)) {
      groupOfKey.set(key, groups.length);
      row ||= covered.has(key);
    }
    groups.push({
      index: groups.length,
      key: kind === "day" ? `day:${first}` : `fold:${first}:${last}`,
      kind,
      firstKey: first,
      lastKey: last,
      t0: time,
      t1: time,
      reach: [time, time],
      at: pos,
      size: ZERO,
      row,
      today: first <= todayKey && todayKey <= last,
      past: last < todayKey,
      entries: [],
      echoes: [],
      hours: [],
      folds: [],
      gaps: [],
    });
    push("head", time, time, HEAD);
    if (row) push("row", time, time, ROW);
  };

  // Every loaded day gets a group, also one whose time an earlier night already reaches to the end: its items are
  // placed in that night.
  for (let key = firstKey; valid && key <= lastKey; ) {
    const next = shiftDayKey(key, 1);
    if (busy.has(key)) {
      const [open, close] = wakeOf(key);
      openGroup("day", key, key);
      if (time < to && time < open) {
        const end = Math.min(open, to);
        push("night", time, end, NIGHT);
        time = end;
      }
      if (time < to && time < close) {
        const end = Math.min(close, to);
        push("wake", time, end, hours(end - time));
        time = end;
      }
      // The night after a day belongs to the fold when empty days follow.
      if (time < to && (next > lastKey || busy.has(next))) {
        const end = Math.min(wakeOf(next)[0], to);
        push("night", time, end, NIGHT);
        time = end;
      }
      key = next;
      continue;
    }
    let last = key;
    while (shiftDayKey(last, 1) <= lastKey && !busy.has(shiftDayKey(last, 1))) last = shiftDayKey(last, 1);
    openGroup("fold", key, last);
    const end = Math.min(wakeOf(shiftDayKey(last, 1))[0], to);
    push("fold", time, end, FOLD);
    time = end;
    key = shiftDayKey(last, 1);
  }
  const total = pos;
  for (const [index, group] of groups.entries()) {
    const next = groups[index + 1];
    group.t1 = next ? next.t0 : to;
    group.size = subtractSpan(next ? next.at : total, group.at);
    group.reach = [group.t0, group.t1];
  }

  const timed = segments.filter((segment) => segment.t1 > segment.t0);
  const segmentAt = (t: number): TimelineSegment | undefined => {
    let low = 0;
    let high = timed.length - 1;
    let found: TimelineSegment | undefined;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const segment = timed[middle]!;
      if (segment.t0 <= t) {
        found = segment;
        low = middle + 1;
      } else high = middle - 1;
    }
    return found;
  };
  const posOf = (t: number): TimelineSpan => {
    const segment = segmentAt(t);
    if (!segment) return timed[0]?.at ?? ZERO;
    if (t >= segment.t1) return addSpan(segment.at, segment.size);
    return addSpan(segment.at, scaleSpan(segment.size, (t - segment.t0) / (segment.t1 - segment.t0)));
  };
  const timeAt = (px: number, units: TimelineUnits): number => {
    for (const segment of segments) {
      const start = spanPx(segment.at, units);
      const size = spanPx(segment.size, units);
      if (px < start + size || segment === segments.at(-1)) {
        if (segment.t1 === segment.t0 || size <= 0) return segment.t0;
        return segment.t0 + Math.max(0, Math.min(1, (px - start) / size)) * (segment.t1 - segment.t0);
      }
    }
    return from;
  };

  // Decorations: hour ticks, folds, and free time per waking segment.
  const relative = (group: TimelineGroup, span: TimelineSpan) => subtractSpan(span, group.at);
  for (const segment of segments) {
    const group = groups[segment.group]!;
    if (segment.kind === "night" || segment.kind === "fold")
      group.folds.push({ kind: segment.kind, at: relative(group, segment.at), size: segment.size });
    if (segment.kind !== "wake") continue;
    // Clocks change at night, so waking hours are whole hours after the day's 06:00.
    const open = wakeOf(keyOf(segment.t0))[0];
    for (let hour = 0; hour < wakeEnd - wakeStart; hour++) {
      const tick = open + hour * HOUR;
      if (tick >= segment.t0 && tick < segment.t1) group.hours.push({ time: tick, at: relative(group, posOf(tick)) });
    }
  }

  // Entries.
  const entries = new Map<string, TimelineEntry>();
  const bands: TimelineItemEntry[] = [];
  const allDay: TimelineItemEntry[] = [];
  const timedEntries: TimelineItemEntry[] = [];
  const foldStacks = new Map<TimelineSegment, TimelineItemEntry[]>();
  for (const entry of valid ? normalized : []) {
    if (entries.has(entry.item.id)) continue;
    if (entry.allDay) {
      const first = entry.firstKey < firstKey ? firstKey : entry.firstKey;
      const last = entry.lastKey > lastKey ? lastKey : entry.lastKey;
      if (first > last) continue;
      const groupIndex = groupOfKey.get(first);
      const lastGroup = groupOfKey.get(last);
      if (groupIndex === undefined || lastGroup === undefined) continue;
      const group = groups[groupIndex]!;
      const end = groups[lastGroup]!;
      const placed: TimelineItemEntry = {
        kind: "all-day",
        id: entry.item.id,
        item: entry.item,
        group: groupIndex,
        start: groupIndex,
        end: lastGroup + 1,
        at: ZERO,
        size: subtractSpan(addSpan(end.at, end.size), group.at),
        lane: 0,
        lanes: 1,
        firstKey: first,
        lastKey: last,
      };
      entries.set(placed.id, placed);
      allDay.push(placed);
      continue;
    }
    // Placed by the part inside the range, labelled by the item's own times.
    const start = entry.point ? entry.start : Math.max(entry.start, from);
    const end = entry.point ? entry.start : Math.min(entry.end, to);
    if (entry.point ? start < from || start >= to : end <= start) continue;
    const groupIndex = groupOfKey.get(keyOf(start));
    if (groupIndex === undefined) continue;
    const group = groups[groupIndex]!;
    const startSegment = segmentAt(start);
    const endSegment = entry.point ? startSegment : segmentAt(end - 1);
    const folded = startSegment !== undefined && startSegment.kind !== "wake" && startSegment === endSegment;
    const at = folded ? startSegment.at : posOf(start);
    const placed: TimelineItemEntry = {
      kind: folded ? "folded" : entry.point ? "marker" : "band",
      id: entry.item.id,
      item: entry.item,
      group: groupIndex,
      start: entry.start,
      end: entry.end,
      at: relative(group, at),
      size: folded ? startSegment.size : entry.point ? ZERO : subtractSpan(posOf(end), at),
      lane: 0,
      lanes: 1,
      firstKey: keyOf(start),
      lastKey: keyOf(start),
    };
    entries.set(placed.id, placed);
    timedEntries.push(placed);
    if (placed.kind === "band") bands.push(placed);
    if (folded) foldStacks.set(startSegment, [...(foldStacks.get(startSegment) ?? []), placed]);
  }

  // Items inside a fold stack in its middle, in time order, in up to three places; the rest share a "+n" entry.
  const foldRuns: TimelineItemEntry[][] = [];
  for (const stack of foldStacks.values()) {
    stack.sort(byStart);
    const shown = stack.length > TIMELINE_FOLD_LANES ? TIMELINE_FOLD_LANES - 1 : stack.length;
    for (const [lane, entry] of stack.slice(0, shown).entries()) {
      entry.lane = lane;
      entry.lanes = Math.min(stack.length, TIMELINE_FOLD_LANES);
    }
    if (shown < stack.length) foldRuns.push(stack.slice(shown));
  }

  const more: TimelineMoreEntry[] = [];
  // Item ids are the application's, so a "+n" id steps aside where an item already has it.
  const ids = new Set(normalized.map((entry) => entry.item.id));
  const collapse = (runs: TimelineItemEntry[][], area: TimelineMoreEntry["area"], lanes: number) => {
    for (const run of runs) {
      const first = run[0]!;
      const group = groups[first.group]!;
      let start = first.start;
      let end = first.end;
      for (const entry of run) {
        start = Math.min(start, entry.start);
        end = Math.max(end, entry.end);
      }
      let id = `more:${first.id}`;
      for (let suffix = 2; ids.has(id); suffix++) id = `more:${first.id}:${suffix}`;
      ids.add(id);
      // A fold's "+n" takes the place of the fold; all-day entries count in groups, `end` is the index after their last.
      const lastGroup = area === "all-day" ? groups[Math.max(first.group, end - 1)]! : group;
      const placed: TimelineMoreEntry = {
        kind: "more",
        area,
        id,
        hidden: run,
        group: first.group,
        start,
        end,
        at: area === "band" ? relative(group, posOf(start)) : area === "fold" ? first.at : ZERO,
        size:
          area === "band"
            ? subtractSpan(posOf(end), posOf(start))
            : area === "fold"
              ? first.size
              : subtractSpan(addSpan(lastGroup.at, lastGroup.size), group.at),
        lane: lanes - 1,
        lanes,
      };
      for (const hidden of run) entries.delete(hidden.id);
      entries.set(placed.id, placed);
      more.push(placed);
    }
  };
  collapse(laneEntries(bands, TIMELINE_BAND_LANES), "band", TIMELINE_BAND_LANES);
  collapse(foldRuns, "fold", TIMELINE_FOLD_LANES);
  collapse(laneEntries(allDay, TIMELINE_ALL_DAY_LANES), "all-day", TIMELINE_ALL_DAY_LANES);

  const visibleAllDay = [...allDay.filter((entry) => entries.has(entry.id)), ...more.filter((entry) => entry.area === "all-day")];
  for (const entry of visibleAllDay.sort(byStart)) {
    groups[entry.group]!.entries.push(entry);
    for (let index = entry.start + 1; index < entry.end; index++) groups[index]?.echoes.push(entry);
  }
  const visibleTimed = [...timedEntries.filter((entry) => entries.has(entry.id)), ...more.filter((entry) => entry.area !== "all-day")];
  for (const entry of visibleTimed.sort(byStart)) groups[entry.group]!.entries.push(entry);
  for (const group of groups) {
    for (const entry of group.entries) {
      const allDayEntry = entry.kind === "all-day" || (entry.kind === "more" && entry.area === "all-day");
      const [start, end] = allDayEntry ? [group.t0, groups[entry.end - 1]!.t1] : [entry.start, entry.end];
      group.reach = [Math.min(group.reach[0], start), Math.max(group.reach[1], end)];
    }
  }

  // Free time: gaps of an hour or more between bands within waking hours.
  const busyBands = bands.toSorted(byStart);
  for (const segment of timed) {
    if (segment.kind !== "wake") continue;
    const group = groups[segment.group]!;
    let cursor = segment.t0;
    const addGap = (end: number) => {
      if (end - cursor < MIN_GAP) return;
      group.gaps.push({
        at: relative(group, posOf((cursor + end) / 2)),
        end,
        hours: Math.round(((end - cursor) / HOUR) * 2) / 2,
        long: end - cursor >= 3 * HOUR,
      });
    };
    for (const band of busyBands) {
      if (band.end <= segment.t0 || band.start >= segment.t1) continue;
      addGap(Math.max(cursor, band.start));
      cursor = Math.max(cursor, band.end);
    }
    addGap(segment.t1);
  }

  return {
    from,
    to,
    segments,
    groups,
    total,
    entries,
    order: groups.flatMap((group) => group.entries.map((entry) => entry.id)),
    posOf,
    timeAt,
  };
};
