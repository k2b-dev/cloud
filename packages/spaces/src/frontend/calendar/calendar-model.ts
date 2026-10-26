import type { CalendarDescriptor, CalendarItem } from "@k2b/cloud/contracts";
import { type DateContext, dates } from "@k2b/stdlib";
import type { CalendarEvent } from "@k2b/ui";
import type { calendarViewMessages } from "./messages";

type Messages = ReturnType<typeof calendarViewMessages.resolve>["t"];

export const CLOUD_CALENDAR_PATH = "/app/spaces/calendar";
export const CLOUD_CALENDAR_VIEWS = ["day", "week", "month", "list"] as const;
export type CloudCalendarView = (typeof CLOUD_CALENDAR_VIEWS)[number];
/** The widest range one events request covers: the six weeks of a month view, the Spaces route's budget. */
export const CALENDAR_REQUEST_DAYS = 42;
/** The list shows two weeks from its date. */
export const CALENDAR_LIST_DAYS = 14;
/** The widest range the scrolling views hold, as in a Space's calendar; past it they stop loading. */
export const CALENDAR_MAX_DAYS = 366;
/** The view asks every source again this often while it is open. */
export const CALENDAR_REFRESH_MS = 5 * 60 * 1000;
/** Busy-only entries carry no color of their own. */
export const BUSY_COLOR = "#71717a";
const DAY_MS = 24 * 60 * 60 * 1000;

export type CalendarSourceError = { code: string; retryable: boolean };
/** One app that offers calendars, with the calendars this person may see. */
export type CalendarSourceView = {
  appId: string;
  name: string;
  icon: string | null;
  state: "ok" | "failed";
  error: CalendarSourceError | null;
  calendars: CalendarDescriptor[];
};
export type CalendarReadState = "ok" | "pending" | "failed" | "truncated";
export type CalendarSourceRead = { appId: string; state: CalendarReadState; error: CalendarSourceError | null };
export type SourcedCalendarItem = CalendarItem & { appId: string };
export type CalendarRange = { from: string; to: string };
/** What the page shows, as its URL says: `null` selection means the default calendars. */
export type CloudCalendarRoute = { view: CloudCalendarView; date: string; selection: string[] | null };

export const calendarKey = (appId: string, calendarId: string) => `${appId}:${calendarId}`;
/** Splits at the first colon: app IDs have none, calendar IDs may. */
export const splitCalendarKey = (key: string): { appId: string; calendarId: string } | null => {
  const at = key.indexOf(":");
  return at > 0 && at < key.length - 1 ? { appId: key.slice(0, at), calendarId: key.slice(at + 1) } : null;
};
export const itemKey = (item: SourcedCalendarItem) => `${item.appId}:${item.calendarId}:${item.id}`;

const isView = (value: string | null): value is CloudCalendarView => CLOUD_CALENDAR_VIEWS.includes(value as CloudCalendarView);
const isDateKey = (value: string | null): value is string =>
  value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));

/** Reads the view, its date, and the chosen calendars from the page URL; anything unreadable falls back to the default. */
export const parseCloudCalendarRoute = (url: URL, dateConfig?: DateContext): CloudCalendarRoute => {
  const view = url.searchParams.get("view");
  const date = url.searchParams.get("date");
  return {
    view: isView(view) ? view : "week",
    date: isDateKey(date) ? date : dates.formatDateKey(dates.today(dateConfig), dateConfig),
    selection: url.searchParams.has("cal") ? [...new Set(url.searchParams.getAll("cal").filter((key) => splitCalendarKey(key)))] : null,
  };
};

/** The page URL of a route. A changed choice of calendars is part of it; `cal=` alone means none. */
export const cloudCalendarHref = (route: CloudCalendarRoute): string => {
  const params = new URLSearchParams({ view: route.view, date: route.date });
  if (route.selection) {
    if (route.selection.length === 0) params.append("cal", "");
    for (const key of route.selection) params.append("cal", key);
  }
  return `${CLOUD_CALENDAR_PATH}?${params.toString()}`;
};

/** The calendars a person sees without a choice of their own: those their source suggests. */
export const defaultSelection = (sources: readonly CalendarSourceView[]): string[] =>
  sources.flatMap((source) =>
    source.calendars.filter((calendar) => calendar.suggested).map((calendar) => calendarKey(source.appId, calendar.id)),
  );

/** The route's choice, or the default; `null` when it equals the default, so the URL stays short. */
export const normalizeSelection = (selection: readonly string[], sources: readonly CalendarSourceView[]): string[] | null => {
  const fallback = defaultSelection(sources);
  const same = selection.length === fallback.length && fallback.every((key) => selection.includes(key));
  return same ? null : [...selection];
};

/** A `YYYY-MM-DD` key some days later or earlier, independent of any time zone. */
export const shiftDateKey = (key: string, days: number): string => {
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};
export const nextDateKey = (key: string): string => shiftDateKey(key, 1);

const midnight = (key: string, days: number, dateConfig?: DateContext) =>
  dates.addDays(dates.parseCalendarDate(key, dateConfig), days, dateConfig).toISOString();
const dayOf = (instant: string, dateConfig?: DateContext) => dates.formatDateKey(new Date(instant), dateConfig);

/**
 * The days the first load of a view covers, each within one request: the day view a week before and three after,
 * the week view the week before and the two after, the month view the six weeks of its grid, and the list its 14 days.
 */
export const viewWindow = (view: CloudCalendarView, date: string, dateConfig?: DateContext): CalendarRange => {
  if (view === "list") return { from: midnight(date, 0, dateConfig), to: midnight(date, CALENDAR_LIST_DAYS, dateConfig) };
  if (view === "day") return { from: midnight(date, -7, dateConfig), to: midnight(date, 22, dateConfig) };
  const context = { weekStartsOn: 1 as const, ...dateConfig };
  if (view === "month") {
    const first = dates.startOfWeek(dates.startOfMonth(dates.parseCalendarDate(date, context), context), context);
    const key = dates.formatDateKey(first, context);
    return { from: midnight(key, 0, context), to: midnight(key, CALENDAR_REQUEST_DAYS, context) };
  }
  const start = dates.formatDateKey(dates.startOfWeek(dates.parseCalendarDate(date, context), context), context);
  return { from: midnight(start, -7, context), to: midnight(start, 21, context) };
};

/** The block before or after the loaded days: a week for the day and week views, six weeks for the month. */
export const nextBlock = (
  range: CalendarRange,
  edge: "earlier" | "later",
  view: CloudCalendarView,
  dateConfig?: DateContext,
): CalendarRange | null => {
  if (view === "list") return null;
  const days = view === "month" ? CALENDAR_REQUEST_DAYS : 7;
  const block =
    edge === "earlier"
      ? { from: midnight(dayOf(range.from, dateConfig), -days, dateConfig), to: range.from }
      : { from: range.to, to: midnight(dayOf(range.to, dateConfig), days, dateConfig) };
  const from = edge === "earlier" ? block.from : range.from;
  const to = edge === "earlier" ? range.to : block.to;
  return Date.parse(to) - Date.parse(from) > CALENDAR_MAX_DAYS * DAY_MS ? null : block;
};

/** Splits loaded days into requests of at most six weeks, for a refresh or a retry. */
export const requestRanges = (range: CalendarRange, dateConfig?: DateContext): CalendarRange[] => {
  const ranges: CalendarRange[] = [];
  let from = range.from;
  while (Date.parse(from) < Date.parse(range.to)) {
    const end = midnight(dayOf(from, dateConfig), CALENDAR_REQUEST_DAYS, dateConfig);
    const to = Date.parse(end) < Date.parse(range.to) ? end : range.to;
    ranges.push({ from, to });
    from = to;
  }
  return ranges;
};

/** The instants an item covers: an event its time, a deadline the point it is due. */
const itemSpan = (item: CalendarItem, dateConfig?: DateContext): { start: number; end: number } => {
  if (item.type === "deadline") {
    if (item.due.kind === "instant") {
      const at = Date.parse(item.due.at);
      return { start: at, end: at };
    }
    const start = Date.parse(midnight(item.due.date, 0, dateConfig));
    return { start, end: start };
  }
  if (item.time.kind === "instant") return { start: Date.parse(item.time.start), end: Date.parse(item.time.end) };
  return { start: Date.parse(midnight(item.time.start, 0, dateConfig)), end: Date.parse(midnight(item.time.end, 0, dateConfig)) };
};

/** Whether a source placed an item in a range: events overlap it, deadlines are due inside it. */
export const itemInRange = (item: CalendarItem, range: CalendarRange, dateConfig?: DateContext): boolean => {
  const { start, end } = itemSpan(item, dateConfig);
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  return start === end ? start >= from && start < to : start < to && end > from;
};

/**
 * Adds freshly read items: they replace what the read covered for its calendars, items of other days and other
 * calendars stay. Every item appears once, also when windows overlap.
 */
export const mergeItems = (
  current: readonly SourcedCalendarItem[],
  incoming: readonly SourcedCalendarItem[],
  read: { range: CalendarRange; calendars: ReadonlySet<string> },
  dateConfig?: DateContext,
): SourcedCalendarItem[] => {
  const kept = current.filter(
    (item) => !read.calendars.has(calendarKey(item.appId, item.calendarId)) || !itemInRange(item, read.range, dateConfig),
  );
  const byKey = new Map(kept.map((item) => [itemKey(item), item]));
  for (const item of incoming) byKey.set(itemKey(item), item);
  return [...byKey.values()];
};

export const extendRange = (range: CalendarRange, block: CalendarRange): CalendarRange => ({
  from: Date.parse(block.from) < Date.parse(range.from) ? block.from : range.from,
  to: Date.parse(block.to) > Date.parse(range.to) ? block.to : range.to,
});

export type CalendarLookup = Map<string, { source: CalendarSourceView; calendar: CalendarDescriptor }>;
export const calendarLookup = (sources: readonly CalendarSourceView[]): CalendarLookup =>
  new Map(
    sources.flatMap((source) =>
      source.calendars.map((calendar) => [calendarKey(source.appId, calendar.id), { source, calendar }] as const),
    ),
  );

/** A calendar of Spaces names its Space; other apps name the app and the calendar. */
export const calendarLabel = (source: CalendarSourceView, calendar: CalendarDescriptor) =>
  source.appId === "spaces" ? calendar.name : `${source.name} · ${calendar.name}`;

/** The color of an item: its calendar's, or a calm gray for what only says busy. */
export const itemColor = (item: CalendarItem, calendar: CalendarDescriptor | undefined) =>
  item.type === "busy" ? BUSY_COLOR : (calendar?.color ?? BUSY_COLOR);

export const itemTitle = (item: CalendarItem, t: Messages) => (item.type === "busy" ? t.busy : item.title);

/** The shared calendar's entry for an item; dates stay dates, so the calendar keeps them in the person's days. */
export const toCalendarEvent = (item: SourcedCalendarItem, lookup: CalendarLookup, t: Messages): CalendarEvent => {
  const entry = lookup.get(calendarKey(item.appId, item.calendarId));
  const base = {
    id: itemKey(item),
    title: itemTitle(item, t),
    colorHex: itemColor(item, entry?.calendar),
    calendarName: entry ? calendarLabel(entry.source, entry.calendar) : undefined,
  };
  if (item.type === "deadline") {
    const due = item.due;
    return {
      ...base,
      start: due.kind === "date" ? due.date : due.at,
      end: due.kind === "date" ? nextDateKey(due.date) : due.at,
      allDay: due.kind === "date",
      display: "marker",
      checked: item.done,
      accessibleDetail: [t.deadline, item.done ? t.done : null, base.calendarName].filter(Boolean).join(", "),
    };
  }
  const time = item.time;
  const cancelled = item.status === "cancelled";
  return {
    ...base,
    start: time.start,
    end: time.end,
    allDay: time.kind === "date",
    location: item.type === "event" ? (item.location ?? undefined) : undefined,
    accessibleDetail: [cancelled ? t.cancelled : null, base.calendarName].filter(Boolean).join(", "),
  };
};

export type CalendarStatus =
  | { kind: "loading"; count: number; total: number }
  | { kind: "failed"; apps: string[]; count: number }
  | { kind: "truncated" }
  | { kind: "busy"; names: string[] }
  | null;

/**
 * The one line of status the head shows, most urgent first: calendars still loading, sources that failed, a read
 * that hit its budget, then calendars that show only busy time.
 */
export const calendarStatus = (
  selection: readonly string[],
  sources: readonly CalendarSourceView[],
  reads: ReadonlyMap<string, CalendarSourceRead>,
): CalendarStatus => {
  const lookup = calendarLookup(sources);
  const chosen = selection.flatMap((key) => {
    const entry = lookup.get(key);
    return entry ? [{ key, ...entry }] : [];
  });
  const stateOf = (appId: string) => reads.get(appId)?.state ?? "pending";
  const loading = chosen.filter((entry) => stateOf(entry.source.appId) === "pending").length;
  if (loading > 0) return { kind: "loading", count: loading, total: chosen.length };
  // A source that could not even list its calendars counts as failed, whatever the person chose.
  const failed = [
    ...new Set([
      ...sources.filter((source) => source.state === "failed").map((source) => source.name),
      ...chosen.filter((entry) => stateOf(entry.source.appId) === "failed").map((entry) => entry.source.name),
    ]),
  ];
  if (failed.length > 0) return { kind: "failed", apps: failed, count: failed.length };
  if (chosen.some((entry) => stateOf(entry.source.appId) === "truncated")) return { kind: "truncated" };
  const busy = chosen.filter((entry) => entry.calendar.visibility === "busy").map((entry) => calendarLabel(entry.source, entry.calendar));
  return busy.length > 0 ? { kind: "busy", names: busy } : null;
};
