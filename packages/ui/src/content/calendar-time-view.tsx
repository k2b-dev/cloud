import { dates as calendar, type DateContext } from "@k2b/stdlib";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { announce } from "../feedback/announce";
import type { CalendarController, CalendarEvent, CalendarEventTimeChange, CalendarExternalDrag, CalendarLabels } from "./Calendar";
import {
  addDayKeys,
  buildDays,
  type CalendarDayHours,
  clockAt,
  DAY_MINUTES,
  type DayEntry,
  type DayGap,
  type DayGeometry,
  type DayLane,
  type DayModel,
  type DaySpan,
  dayKeyOf,
  dayLanes,
  dayMinuteAt,
  dayTopTerms,
  dayYTerms,
  freeGaps,
  GAP_LABEL_MINUTES,
  GAP_LONG_MINUTES,
  gapProposal,
  instantInDay,
  instantsInDay,
  minuteInDay,
  readDayGeometry,
  resizedInDay,
  snapMinutes,
  subtractTerms,
  termsCss,
  wakeMinutes,
} from "./calendar-days";
import { useCalendarMessages } from "./calendar-messages";
import { startCalendarPointerSession } from "./calendar-pointer";
import {
  type CalendarOwner,
  type CalendarStop,
  EventChip,
  eventHref,
  type NormalizedEvent,
  ownerDateConfig,
  parseDate,
  placeCalendarPopover,
  validDate,
} from "./calendar-shared";

/**
 * Shared state and parts of the day and week views with `dayHours`: the time model of the loaded days, the selection,
 * the quick create, pointer gestures, and the pieces both views draw into a day's timeline.
 */

export type TodayDirection = "left" | "right" | "up" | "down" | "";

/** What the header and the calendar's controller ask of the active day or week view. */
export type TimeViewHandle = {
  /** The first and last day the reader sees. */
  visibleKeys: () => { first: string; last: string };
  /** Moves by a day (day view) or a week (week view) when that is loaded; `false` leaves it to the header's link. */
  step: (direction: -1 | 1) => boolean;
  /** Shows a day when it is loaded; `false` leaves it to navigation. */
  goTo: (key: string) => boolean;
  /** Shows today and now when they are loaded. */
  today: () => boolean;
  todayDirection: () => TodayDirection;
  controller: CalendarController;
};

export type TimeViewProps = {
  owner: CalendarOwner;
  view: "day" | "week";
  date: Date;
  now: Date;
  events: readonly CalendarEvent[];
  labels: Required<CalendarLabels>;
  hours: CalendarDayHours;
  register: (handle: TimeViewHandle | null) => void;
};

export type TimeSelection = { key: string; start?: number; end?: number };

type Ghost = {
  key: string;
  start: number;
  end: number;
  title: string;
  time: string;
  colorHex?: string;
  color?: string;
  warn?: boolean;
  fit?: { fits: boolean; text: string };
};

type QuickCreate = {
  range: CalendarEventTimeChange;
  anchor: Element | DOMRect;
  create?: string;
  key: string;
  start?: number;
  end?: number;
};

export type BodyHit = { key: string; element: HTMLElement; geometry: DayGeometry; minute: number };

const COLOR_TOKENS: Record<string, string> = {
  blue: "#3b82f6",
  emerald: "#10b981",
  amber: "#f59e0b",
  red: "#ef4444",
  violet: "#8b5cf6",
  cyan: "#06b6d4",
  zinc: "#a1a1aa",
};
export const eventAccent = (event: Pick<CalendarEvent, "color" | "colorHex">): string =>
  event.colorHex ?? COLOR_TOKENS[event.color ?? "blue"]!;

/** Minimum minutes an overlap counts for a band, about the height of its title. */
const LANE_MINUTES = 20;

export const reducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Swallows the click a browser sends right after a gesture ends, never the next one. */
export const swallowNextClick = () => {
  const stop = (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 120);
};

export const createTimeView = (props: TimeViewProps) => {
  const messages = useCalendarMessages();
  const dateConfig = createMemo((): DateContext => ownerDateConfig(props.owner));
  const hours = () => props.hours;
  const wake = createMemo(() => wakeMinutes(props.hours));
  const keyOf = (date: Date) => calendar.formatDateKey(date, dateConfig());
  const parseKey = (key: string) => calendar.parseCalendarDate(key, dateConfig());

  /** The loaded days: the host's range, or the day or the week of the date. */
  const range = createMemo(
    () => {
      const context = dateConfig();
      const loaded = props.owner.range;
      if (loaded) {
        const from = parseDate(loaded.from, context);
        const to = parseDate(loaded.to, context);
        if (validDate(from) && validDate(to)) {
          const first = calendar.formatDateKey(from, context);
          const last = calendar.formatDateKey(new Date(Math.max(from.getTime(), to.getTime() - 1)), context);
          return { first, last };
        }
      }
      const key = calendar.formatDateKey(props.date, context);
      if (props.view === "day") return { first: key, last: key };
      const start = calendar.formatDateKey(calendar.startOfWeek(props.date, context), context);
      return { first: start, last: addDayKeys(start, 6) };
    },
    undefined,
    { equals: (left, right) => left.first === right.first && left.last === right.last },
  );
  const anchorKey = createMemo(() => keyOf(props.date));

  /** Checkbox states the reader just set, shown until the host's events agree or drop the entry. */
  const [checks, setChecks] = createSignal<Record<string, boolean>>({});
  const [justChecked, setJustChecked] = createSignal<ReadonlySet<string>>(new Set());
  createEffect(
    on(
      () => props.events,
      (events) => {
        const current = untrack(checks);
        const ids = Object.keys(current);
        if (ids.length === 0) return;
        const next = { ...current };
        for (const id of ids) {
          const event = events.find((candidate) => candidate.id === id);
          if (!event || event.checked === current[id]) delete next[id];
        }
        setChecks(next);
      },
      { defer: true },
    ),
  );
  const checkedOf = (event: CalendarEvent): boolean | undefined =>
    event.checked === undefined ? undefined : (checks()[event.id] ?? event.checked);
  /** What Space on an entry's chip does: check its box, where it has one the reader may change. */
  const checkOf = (event: CalendarEvent) =>
    checkedOf(event) !== undefined && props.owner.onEventCheck ? () => toggleCheck(event) : undefined;
  const forgetJustChecked = (id: string) =>
    setJustChecked((value) => {
      if (!value.has(id)) return value;
      const rest = new Set(value);
      rest.delete(id);
      return rest;
    });
  /** Today's day for a moment after its last open to-do was checked off, which its heading celebrates. */
  const [cheered, setCheered] = createSignal<string | null>(null);
  let cheerTimer = 0;
  // The server renders the view too, and has no window.
  onCleanup(() => clearTimeout(cheerTimer));
  /** The entries with a checkbox on a day: its deadlines, the to-dos planned into its hours, and the ones due all day. */
  const dueOn = (key: string) => {
    const model = dayOf(key);
    return [
      ...model.markers.map((marker) => marker.item),
      ...model.bands.map((band) => band.item),
      ...model.spans.filter((span) => span.marker && span.firstKey === key).map((span) => span.item),
    ].filter((item) => item.checked !== undefined);
  };
  const toggleCheck = (event: CalendarEvent) => {
    const current = checkedOf(event);
    if (current === undefined || !props.owner.onEventCheck) return;
    const next = !current;
    setChecks((value) => ({ ...value, [event.id]: next }));
    if (next) {
      setJustChecked((value) => new Set([...value, event.id]));
      window.setTimeout(() => forgetJustChecked(event.id), 1100);
      const today = nowKey();
      const due = dueOn(today);
      if (due.includes(event) && due.every((item) => checkedOf(item))) {
        // The heading shows it only for a moment, so a screen reader hears it once instead.
        announce(messages().calendarAllDone);
        setCheered(today);
        window.clearTimeout(cheerTimer);
        cheerTimer = window.setTimeout(() => setCheered(null), 2200);
      }
    } else setCheered(null);
    // A change the host refuses puts the box back as it was.
    void Promise.resolve(props.owner.onEventCheck(event, next)).catch(() => {
      forgetJustChecked(event.id);
      if (next) setCheered(null);
      setChecks((value) => {
        if (value[event.id] !== next) return value;
        const rest = { ...value };
        delete rest[event.id];
        return rest;
      });
    });
  };

  const entries = createMemo((): DayEntry<CalendarEvent>[] => {
    const context = dateConfig();
    return props.events.flatMap((event) => {
      const start = parseDate(event.start, context);
      if (!validDate(start)) return [];
      const marker = event.display === "marker";
      const parsedEnd = event.end ? parseDate(event.end, context) : null;
      let end = parsedEnd && validDate(parsedEnd) && parsedEnd > start ? parsedEnd : null;
      if (!end)
        end = event.allDay
          ? calendar.addDays(calendar.startOfDay(start, context), 1, context)
          : marker
            ? start
            : new Date(start.getTime() + 3_600_000);
      return [{ item: event, start, end, allDay: Boolean(event.allDay), marker }];
    });
  });
  const days = createMemo(() => buildDays(range().first, range().last, entries(), props.hours, dateConfig()));
  const emptyModel = (key: string): DayModel<CalendarEvent> => ({ key, bands: [], markers: [], spans: [], night: false, empty: true });
  const dayOf = (key: string) => days().get(key) ?? emptyModel(key);
  const sourceOf = createMemo(() => new Map(entries().map((entry) => [entry.item, entry])));

  /** The day that holds now: before the start hour still the day before. */
  const nowKey = createMemo(() => dayKeyOf(props.now, props.hours, dateConfig()));
  const nowMinute = createMemo(() => minuteInDay(nowKey(), props.now, props.hours, dateConfig()));
  /** Now as a minute of a day: past days lie wholly before it, coming days after. */
  const nowIn = (key: string) => (key === nowKey() ? nowMinute() : key < nowKey() ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
  const calendarToday = createMemo(() => keyOf(props.now));
  const clock = (minute: number) => clockAt(minute, props.hours);
  const duration = (minutes: number) => messages().calendarDuration({ minutes: Math.max(1, Math.round(minutes)) });
  const instant = (key: string, minute: number) => instantInDay(key, minute, props.hours, dateConfig());
  const slot = (key: string, start: number, end: number) => instantsInDay(key, start, end, props.hours, dateConfig());
  const dayStartMinute = (hour: number) => Math.max(0, (hour - props.hours[0]) * 60);

  /** A day's timed piece as the event chip reads it. */
  const normalized = (event: CalendarEvent, key: string): NormalizedEvent => {
    const source = sourceOf().get(event);
    const start = source?.start ?? parseDate(event.start, dateConfig());
    const end = source?.end ?? start;
    return { ...event, startDate: start, endDate: end, sourceStartDate: start, sourceEndDate: end, dayKey: key };
  };

  const [selection, setSelection] = createSignal<TimeSelection | null>(null);
  const [touchDraft, setTouchDraft] = createSignal<{ key: string; start: number; end: number } | null>(null);
  const [activeKey, setActiveKey] = createSignal<string | null>(null);
  const [ghost, setGhost] = createSignal<Ghost | null>(null);
  const [movingId, setMovingId] = createSignal("");
  const [dragging, setDragging] = createSignal<"" | "move" | "start" | "end" | "draw" | "external">("");
  const [nightOverrides, setNightOverrides] = createSignal<Record<string, boolean>>({});
  const [quick, setQuick] = createSignal<QuickCreate | null>(null);

  const rangeOfSelection = (value: TimeSelection): CalendarEventTimeChange =>
    value.start === undefined || value.end === undefined
      ? { start: parseKey(value.key), end: calendar.addDays(parseKey(value.key), 1, dateConfig()), allDay: true }
      : { ...slot(value.key, value.start, value.end), allDay: false };
  createEffect(on(selection, (value) => props.owner.onSelectionChange?.(value ? rangeOfSelection(value) : null), { defer: true }));
  onCleanup(() => {
    if (untrack(selection)) props.owner.onSelectionChange?.(null);
  });

  // Body elements of the days on screen, for pointer positions.
  const bodies = new Map<string, { element: HTMLElement; expanded: () => boolean }>();
  const registerBody = (key: string, element: HTMLElement, expanded: () => boolean) => {
    bodies.set(key, { element, expanded });
    onCleanup(() => {
      if (bodies.get(key)?.element === element) bodies.delete(key);
    });
  };
  const bodyAt = (clientX: number, clientY: number): BodyHit | null => {
    for (const [key, body] of bodies) {
      if (!body.element.isConnected) continue;
      const rect = body.element.getBoundingClientRect();
      if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) continue;
      const geometry = readDayGeometry(body.element, wake(), body.expanded());
      return { key, element: body.element, geometry, minute: dayMinuteAt(geometry, clientY - rect.top) };
    }
    return null;
  };
  const limitOf = (key: string) => (bodies.get(key)?.expanded() ? DAY_MINUTES : wake());
  const nightOpen = (key: string, model: DayModel<CalendarEvent>) => nightOverrides()[key] ?? model.night;
  const setNight = (key: string, open: boolean) => setNightOverrides((value) => ({ ...value, [key]: open }));

  /** The gap under a minute while dragging, and whether `need` minutes fit it; the gap shows "fits" or how much is missing. */
  const fitAt = (key: string, minute: number, need: number, span?: { start: number; end: number }) => {
    const gap = freeGaps(dayOf(key).bands, wake(), Number.NEGATIVE_INFINITY).find(
      (candidate) => minute >= candidate.start && minute < candidate.end,
    );
    if (!gap) return null;
    const fits = gap.end - gap.start >= need;
    if (fits && span && (span.start < gap.start || span.end > gap.end)) return null;
    return {
      gap,
      fits,
      text: fits ? messages().calendarFits : messages().calendarTooShort({ duration: duration(need - (gap.end - gap.start)) }),
    };
  };
  const [gapHit, setGapHit] = createSignal<{ key: string; start: number; fits: boolean; text: string } | null>(null);
  const overlapAt = (key: string, start: number, end: number, except?: string) =>
    dayOf(key).bands.find((band) => band.item.id !== except && band.start < end && band.end > start)?.item ?? null;

  const openQuickCreate = (key: string, start: number | undefined, end: number | undefined, anchor: Element | DOMRect, create?: string) => {
    const range = rangeOfSelection({ key, start, end });
    setTouchDraft(null);
    if (!props.owner.renderQuickCreate) {
      props.owner.onSlotActivate?.(range);
      return;
    }
    setSelection({ key, start, end });
    setQuick({ range, anchor, create, key, start, end });
  };
  const canCreate = () => Boolean(props.owner.renderQuickCreate || props.owner.onSlotActivate);

  /** The time a new entry takes: the selection, today's next full hour while today shows, else 09:00 of the first day. */
  const createTarget = (visible: { first: string; last: string }): { key: string; start: number; end: number } => {
    const current = selection();
    if (current && current.start !== undefined && current.end !== undefined)
      return { key: current.key, start: current.start, end: current.end };
    const nine = dayStartMinute(9);
    const nextHour = (key: string) => {
      const minute = Math.ceil((nowMinute() + 1) / 60) * 60;
      return key === nowKey() ? (minute <= wake() - 60 ? minute : null) : nine;
    };
    let key: string;
    let start: number | null;
    if (current) {
      key = current.key;
      start = key === nowKey() ? nextHour(key) : nine;
    } else if (nowKey() >= visible.first && nowKey() <= visible.last) {
      key = nowKey();
      start = nextHour(key);
    } else {
      key = visible.first;
      start = nine;
    }
    if (start === null) {
      key = addDayKeys(key, 1);
      start = nine;
    }
    return { key, start, end: start + 60 };
  };

  // Pointer gestures: moving and resizing bands and markers, drawing a new event, and dragging entries in.
  let cancelGesture: (() => void) | undefined;
  onCleanup(() => cancelGesture?.());
  const step = (event: { shiftKey: boolean }) => (event.shiftKey ? 5 : 15);
  const shiftHeld = { current: false };
  const trackShift = (event: KeyboardEvent) => {
    shiftHeld.current = event.shiftKey;
  };
  onMount(() => {
    window.addEventListener("keydown", trackShift, true);
    window.addEventListener("keyup", trackShift, true);
    onCleanup(() => {
      window.removeEventListener("keydown", trackShift, true);
      window.removeEventListener("keyup", trackShift, true);
    });
  });
  const endGesture = () => {
    setGhost(null);
    setGapHit(null);
    setMovingId("");
    setDragging("");
  };

  const startMove = (pointerEvent: PointerEvent, event: CalendarEvent, key: string, start: number, end: number, scroller?: HTMLElement) => {
    const marker = event.display === "marker";
    if (!props.owner.onEventDrop) return;
    const body = bodies.get(key);
    if (!body) return;
    const rect = body.element.getBoundingClientRect();
    const geometry = readDayGeometry(body.element, wake(), body.expanded());
    const grab = dayMinuteAt(geometry, pointerEvent.clientY - rect.top) - start;
    const length = end - start;
    cancelGesture?.();
    cancelGesture = startCalendarPointerSession({
      event: pointerEvent,
      scrollContainer: scroller,
      resolve: (clientX, clientY) => {
        const hit = bodyAt(clientX, clientY);
        if (!hit) return null;
        const limit = limitOf(hit.key);
        const from = Math.max(
          0,
          Math.min(limit - Math.max(length, 15), snapMinutes(hit.minute - grab, step({ shiftKey: shiftHeld.current }))),
        );
        return { key: hit.key, start: from, end: from + length };
      },
      onActivate: () => {
        setMovingId(event.id);
        setDragging("move");
        setSelection(null);
      },
      onPreview: (next) => {
        const clash = marker ? null : overlapAt(next.key, next.start, next.end, event.id);
        const fit = marker ? null : fitAt(next.key, next.start + (next.end - next.start) / 2, next.end - next.start, next);
        setGapHit(fit ? { key: next.key, start: fit.gap.start, fits: fit.fits, text: fit.text } : null);
        const time = marker
          ? messages().calendarDue({ time: clock(next.start) })
          : `${clock(next.start)}–${clock(next.end)} · ${duration(next.end - next.start)}`;
        setGhost({
          key: next.key,
          start: next.start,
          end: marker ? next.start + 20 : next.end,
          title: event.title,
          time: clash ? `${time} · ${messages().calendarOverlaps({ title: clash.title })}` : time,
          colorHex: eventAccent(event),
          warn: Boolean(clash),
          fit: fit ? { fits: fit.fits, text: fit.text } : undefined,
        });
      },
      onCommit: (next) => {
        endGesture();
        swallowNextClick();
        if (next.key === key && next.start === start && next.end === end) return;
        const source = sourceOf().get(event);
        // A moved entry keeps its real length, also when it lands across a clock change.
        const startDate = instant(next.key, next.start);
        const endDate = marker
          ? startDate
          : source
            ? new Date(startDate.getTime() + source.end.getTime() - source.start.getTime())
            : slot(next.key, next.start, next.end).end;
        if (source && source.start.getTime() === startDate.getTime() && source.end.getTime() === endDate.getTime()) return;
        props.owner.onEventDrop?.(event, { start: startDate, end: endDate, allDay: false });
      },
      onCancel: endGesture,
    });
  };

  const startResize = (
    pointerEvent: PointerEvent,
    event: CalendarEvent,
    key: string,
    start: number,
    end: number,
    edge: "start" | "end",
    scroller?: HTMLElement,
  ) => {
    if (!props.owner.onEventResize) return;
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    const body = bodies.get(key);
    if (!body) return;
    cancelGesture?.();
    cancelGesture = startCalendarPointerSession({
      event: pointerEvent,
      scrollContainer: scroller,
      threshold: 1,
      resolve: (_clientX, clientY) => {
        const rect = body.element.getBoundingClientRect();
        const geometry = readDayGeometry(body.element, wake(), body.expanded());
        const minute = snapMinutes(dayMinuteAt(geometry, clientY - rect.top), step({ shiftKey: shiftHeld.current }));
        const limit = limitOf(key);
        const size = step({ shiftKey: shiftHeld.current });
        return edge === "end"
          ? { start, end: Math.max(start + size, Math.min(limit, minute)) }
          : { start: Math.max(0, Math.min(end - size, minute)), end };
      },
      onActivate: () => {
        setMovingId(event.id);
        setDragging(edge);
      },
      onPreview: (next) =>
        setGhost({
          key,
          start: next.start,
          end: next.end,
          title: event.title,
          time: `${clock(next.start)}–${clock(next.end)} · ${duration(next.end - next.start)}`,
          colorHex: eventAccent(event),
        }),
      onCommit: (next) => {
        endGesture();
        swallowNextClick();
        if (next.start === start && next.end === end) return;
        const source = sourceOf().get(event);
        const range = source ? resizedInDay(source, edge, key, next, props.hours, dateConfig()) : slot(key, next.start, next.end);
        props.owner.onEventResize?.(event, { ...range, allDay: false });
      },
      onCancel: endGesture,
    });
  };

  /** Drawing on free time: a new event with its live length, on a 15-minute grid, with Shift on 5 minutes. */
  const startDraw = (pointerEvent: PointerEvent, key: string, scroller?: HTMLElement) => {
    if (!canCreate() || pointerEvent.pointerType !== "mouse") return;
    const body = bodies.get(key);
    if (!body) return;
    const minuteAt = (clientY: number) => {
      const rect = body.element.getBoundingClientRect();
      const geometry = readDayGeometry(body.element, wake(), body.expanded());
      return Math.max(0, Math.min(limitOf(key), dayMinuteAt(geometry, clientY - rect.top)));
    };
    const origin = minuteAt(pointerEvent.clientY);
    cancelGesture?.();
    cancelGesture = startCalendarPointerSession({
      event: pointerEvent,
      scrollContainer: scroller,
      resolve: (_clientX, clientY) => {
        const size = step({ shiftKey: shiftHeld.current });
        const minute = minuteAt(clientY);
        const from = Math.floor(Math.min(origin, minute) / size) * size;
        let to = Math.ceil(Math.max(origin, minute) / size) * size;
        if (to - from < size) to = from + size;
        return { start: from, end: Math.min(to, limitOf(key)) };
      },
      onActivate: () => {
        setDragging("draw");
        setSelection(null);
        setTouchDraft(null);
      },
      onPreview: (next) =>
        setGhost({
          key,
          start: next.start,
          end: next.end,
          title: messages().calendarNewEvent,
          time: `${clock(next.start)}–${clock(next.end)} · ${duration(next.end - next.start)}`,
        }),
      onCommit: (next) => {
        const anchor = document.querySelector<HTMLElement>(".k2b-calendar-ghost[data-live]")?.getBoundingClientRect() ?? body.element;
        endGesture();
        swallowNextClick();
        openQuickCreate(key, next.start, next.end, anchor);
      },
      onCancel: endGesture,
    });
  };

  /** Follows a pointer that pressed an entry outside the calendar into its free time. */
  const dragIn = (
    pointerEvent: PointerEvent,
    item: CalendarExternalDrag,
    onDrop: (slot: CalendarEventTimeChange) => void,
    scroller?: HTMLElement,
  ) => {
    const length = Math.max(15, Math.round(item.minutes));
    const color = item.colorHex ?? COLOR_TOKENS[item.color ?? "blue"]!;
    let token: HTMLElement | undefined;
    let spring: { element: Element; timer: number } | undefined;
    let held = pointerEvent.pointerType === "mouse";
    const preventScroll = (event: TouchEvent) => {
      if (held) event.preventDefault();
    };
    const cleanup = () => {
      token?.remove();
      token = undefined;
      if (spring) window.clearTimeout(spring.timer);
      spring = undefined;
      document.removeEventListener("touchmove", preventScroll);
      endGesture();
    };
    const begin = () => {
      cancelGesture?.();
      cancelGesture = startCalendarPointerSession({
        event: pointerEvent,
        scrollContainer: scroller,
        armAutoScroll: true,
        threshold: held && pointerEvent.pointerType !== "mouse" ? 1 : 6,
        resolve: (clientX, clientY) => {
          const hit = bodyAt(clientX, clientY);
          if (!hit || hit.minute >= limitOf(hit.key)) return { key: "", start: 0, end: 0, clash: null };
          const fit = fitAt(hit.key, hit.minute, length);
          let start = snapMinutes(hit.minute - length / 2, 15);
          if (fit?.fits) start = Math.max(fit.gap.start, Math.min(fit.gap.end - length, start));
          start = Math.max(0, Math.min(limitOf(hit.key) - length, start));
          return { key: hit.key, start, end: start + length, clash: overlapAt(hit.key, start, start + length), fit };
        },
        onActivate: () => {
          setDragging("external");
          setSelection(null);
          token = document.createElement("div");
          token.className = "k2b-calendar-token";
          token.textContent = item.title;
          token.style.setProperty("--k2b-calendar-accent", color);
          token.setAttribute("aria-hidden", "true");
          document.body.append(token);
        },
        onMove: (clientX, clientY) => {
          if (token) token.style.transform = `translate(${clientX + 12}px, ${clientY + 10}px)`;
          // A folded run of empty days opens when the entry rests on it.
          const empty = document.elementFromPoint(clientX, clientY)?.closest("[data-calendar-unfold]");
          if (empty && spring?.element !== empty) {
            if (spring) window.clearTimeout(spring.timer);
            spring = { element: empty, timer: window.setTimeout(() => (empty as HTMLElement).click(), 650) };
          } else if (!empty && spring) {
            window.clearTimeout(spring.timer);
            spring = undefined;
          }
        },
        onPreview: (next) => {
          if (token) token.dataset.hidden = next.key ? "true" : "false";
          if (!next.key) {
            setGhost(null);
            setGapHit(null);
            return;
          }
          setGapHit(next.fit ? { key: next.key, start: next.fit.gap.start, fits: next.fit.fits, text: next.fit.text } : null);
          const time = `${clock(next.start)}–${clock(next.end)} · ${duration(length)}`;
          setGhost({
            key: next.key,
            start: next.start,
            end: next.end,
            title: item.title,
            time: next.clash ? `${time} · ${messages().calendarOverlaps({ title: next.clash.title })}` : time,
            colorHex: color,
            warn: Boolean(next.clash),
            fit: next.fit ? { fits: next.fit.fits, text: next.fit.text } : undefined,
          });
        },
        onCommit: (next) => {
          cleanup();
          swallowNextClick();
          if (next.key) onDrop({ ...slot(next.key, next.start, next.end), allDay: false });
        },
        onCancel: cleanup,
      });
    };
    if (held) {
      begin();
      return;
    }
    // A finger first holds the entry still, so a short swipe keeps scrolling the list it sits in.
    const origin = { x: pointerEvent.clientX, y: pointerEvent.clientY };
    const target =
      pointerEvent.target instanceof HTMLElement ? pointerEvent.target.closest<HTMLElement>("li, [data-calendar-drag-source]") : null;
    const abort = () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", watch);
      window.removeEventListener("pointerup", abort);
      window.removeEventListener("pointercancel", abort);
      if (target) delete target.dataset.lifted;
    };
    const watch = (event: PointerEvent) => {
      if (event.pointerId === pointerEvent.pointerId && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) abort();
    };
    const timer = window.setTimeout(() => {
      abort();
      held = true;
      if (target) target.dataset.lifted = "true";
      navigator.vibrate?.(8);
      document.addEventListener("touchmove", preventScroll, { passive: false });
      begin();
    }, 420);
    window.addEventListener("pointermove", watch);
    window.addEventListener("pointerup", abort);
    window.addEventListener("pointercancel", abort);
  };

  return {
    props,
    messages,
    dateConfig,
    hours,
    wake,
    range,
    anchorKey,
    days,
    dayOf,
    keyOf,
    parseKey,
    nowKey,
    nowMinute,
    nowIn,
    calendarToday,
    clock,
    duration,
    instant,
    normalized,
    checkedOf,
    toggleCheck,
    checkOf,
    justChecked,
    cheered,
    selection,
    setSelection,
    touchDraft,
    setTouchDraft,
    activeKey,
    setActiveKey,
    ghost,
    gapHit,
    movingId,
    dragging,
    nightOpen,
    setNight,
    quick,
    setQuick,
    openQuickCreate,
    canCreate,
    createTarget,
    rangeOfSelection,
    registerBody,
    bodyAt,
    limitOf,
    startMove,
    startResize,
    startDraw,
    dragIn,
    dayStartMinute,
  };
};

export type TimeView = ReturnType<typeof createTimeView>;

/**
 * German short dates read "Fr 9. Okt", without the dots of the abbreviations; with `comma`, a title such as
 * "Fr, 9. Okt 2026" keeps the comma after the day.
 */
export const compactGermanDate = (text: string, locale: string | undefined, comma = false) =>
  locale?.startsWith("de")
    ? text
        .replace(comma ? /\b(Mo|Di|Mi|Do|Fr|Sa|So)\./g : /\b(Mo|Di|Mi|Do|Fr|Sa|So)\.,?/g, "$1")
        .replace(/\b(Jan|Feb|Mär|Apr|Jun|Jul|Aug|Sep|Sept|Okt|Nov|Dez)\./g, "$1")
    : text;

/** A short day such as "Fri 9" or "Fr 9.", in the calendar's locale. */
export const shortDay = (view: TimeView, key: string, withMonth = false) =>
  compactGermanDate(
    view.parseKey(key).toLocaleDateString(view.dateConfig().locale ?? "en", {
      weekday: "short",
      day: "numeric",
      ...(withMonth ? { month: "short" } : {}),
      timeZone: view.dateConfig().timeZone,
    }),
    view.dateConfig().locale,
  );

/** A long day such as "Friday, October 9", with the year when it is not this year's. */
export const longDay = (view: TimeView, key: string) =>
  view.parseKey(key).toLocaleDateString(view.dateConfig().locale ?? "en", {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(key.slice(0, 4) !== view.calendarToday().slice(0, 4) ? { year: "numeric" } : {}),
    timeZone: view.dateConfig().timeZone,
  });

const CHECK_PATH = "M4.6 8.3l2.3 2.3 4.6-4.9";

/** A to-do's checkbox: it draws its check, and the title beside it strikes through. */
export const TimeCheck = (props: { view: TimeView; event: CalendarEvent; tabIndex?: number }) => {
  const checked = () => props.view.checkedOf(props.event) ?? false;
  const box = (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.75" y="1.75" width="12.5" height="12.5" rx="3.5" />
      <path d={CHECK_PATH} />
    </svg>
  );
  return (
    <Show
      when={props.view.props.owner.onEventCheck}
      fallback={
        <span class="k2b-calendar-check" data-checked={checked() ? "true" : undefined} aria-hidden="true">
          {box}
        </span>
      }
    >
      <button
        type="button"
        class="k2b-calendar-check"
        role="checkbox"
        aria-checked={checked() ? "true" : "false"}
        aria-label={props.view.messages().calendarDone({ title: props.event.title })}
        tabIndex={props.tabIndex}
        data-checked={checked() ? "true" : undefined}
        data-just-checked={props.view.justChecked().has(props.event.id) ? "true" : undefined}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.view.toggleCheck(props.event);
        }}
      >
        {box}
      </button>
    </Show>
  );
};

/** A timed entry in a day's timeline: a band as long as the entry, side by side with overlapping ones. */
export const TimeBand = (props: {
  view: TimeView;
  band: DayLane<CalendarEvent>;
  dayKey: string;
  expanded: boolean;
  compact?: boolean;
  /** Day view: a tall band shows its place. */
  showLocation?: boolean;
  /** The height of an hour on a wide screen, for the band's size class and title lines. */
  hourPx: number;
  tabIndex?: number;
  stop?: CalendarStop;
  scroller?: () => HTMLElement | undefined;
}) => {
  const view = props.view;
  const event = () => props.band.item;
  const wake = () => view.wake();
  const limit = () => (props.expanded ? DAY_MINUTES : wake());
  const visibleStart = () => Math.max(0, props.band.start);
  const visibleEnd = () => Math.min(limit(), props.band.end);
  const top = () => dayTopTerms(wake(), props.expanded, visibleStart());
  const bottom = () => dayYTerms(wake(), props.expanded, visibleEnd());
  const now = () => view.nowIn(props.dayKey);
  const running = () => now() >= props.band.start && now() < props.band.end && Number.isFinite(now());
  const past = () => now() >= props.band.end;
  const length = () => props.band.end - props.band.start;
  const pixels = () => (length() / 60) * props.hourPx - 2;
  const size = () => (pixels() < 27 ? "xs" : pixels() < 40 ? "s" : "m");
  const checked = () => view.checkedOf(event());
  const remaining = () => (running() ? view.messages().calendarRemaining({ duration: view.duration(props.band.end - now()) }) : undefined);
  const lines = () => Math.max(1, Math.floor((pixels() - 24) / 15));
  return (
    <div
      class="k2b-calendar-band"
      data-calendar-entry={event().id}
      data-size={size()}
      data-past={past() ? "true" : undefined}
      data-running={running() ? "true" : undefined}
      data-checked={checked() ? "true" : undefined}
      data-checkbox={checked() !== undefined ? "true" : undefined}
      data-just-checked={view.justChecked().has(event().id) ? "true" : undefined}
      data-cut-bottom={props.band.end > limit() ? "true" : undefined}
      data-moving={view.movingId() === event().id ? "true" : undefined}
      data-display={event().display}
      style={{
        "--k2b-calendar-accent": eventAccent(event()),
        "--k2b-calendar-lane": String(props.band.lane),
        "--k2b-calendar-lanes": String(props.band.lanes),
        "--k2b-calendar-lines": String(lines()),
        "--k2b-calendar-progress": running() ? `${(((now() - props.band.start) / length()) * 100).toFixed(1)}%` : undefined,
        top: `calc(${termsCss(top())} + 1px)`,
        height: `max(var(--k2b-calendar-band-min), calc(${termsCss(subtractTerms(bottom(), top()))} - 2px))`,
      }}
    >
      <Show when={running()}>
        <span class="k2b-calendar-band__fill" aria-hidden="true" />
      </Show>
      <Show when={checked() !== undefined}>
        <TimeCheck view={view} event={event()} tabIndex={props.tabIndex === undefined ? undefined : -1} />
      </Show>
      <EventChip
        event={view.normalized(event(), props.dayKey)}
        owner={view.props.owner}
        href={eventHref(view.props.owner, event())}
        fill
        timeline
        compact={props.compact}
        timeLabel={`${view.clock(props.band.start)}–${view.clock(props.band.end)}`}
        showLocation={props.showLocation && size() === "m" && pixels() >= 64}
        remaining={remaining()}
        checkbox={checked() !== undefined}
        onCheck={view.checkOf(event())}
        moving={view.movingId() === event().id}
        tabIndex={props.tabIndex}
        stop={props.stop}
        onMovePointerDown={
          view.props.owner.onEventDrop
            ? (pointerEvent) => view.startMove(pointerEvent, event(), props.dayKey, props.band.start, props.band.end, props.scroller?.())
            : undefined
        }
      />
      <Show when={view.props.owner.onEventResize}>
        <span
          class="k2b-calendar-band__grip"
          data-edge="start"
          aria-hidden="true"
          onPointerDown={(pointerEvent) =>
            view.startResize(pointerEvent, event(), props.dayKey, props.band.start, props.band.end, "start", props.scroller?.())
          }
        />
        <Show when={props.band.end <= limit()}>
          <span
            class="k2b-calendar-band__grip"
            data-edge="end"
            aria-hidden="true"
            onPointerDown={(pointerEvent) =>
              view.startResize(pointerEvent, event(), props.dayKey, props.band.start, props.band.end, "end", props.scroller?.())
            }
          />
        </Show>
      </Show>
    </div>
  );
};

/** A point in time such as a deadline: a dashed line across the day and a pill with its checkbox and title. */
export const TimeMarker = (props: {
  view: TimeView;
  event: CalendarEvent;
  minute: number;
  dayKey: string;
  expanded: boolean;
  above: boolean;
  showTime: boolean;
  tabIndex?: number;
  stop?: CalendarStop;
  scroller?: () => HTMLElement | undefined;
}) => {
  const view = props.view;
  const checked = () => view.checkedOf(props.event);
  const past = () => view.nowIn(props.dayKey) >= props.minute;
  return (
    <div
      class="k2b-calendar-marker"
      data-calendar-entry={props.event.id}
      data-past={past() ? "true" : undefined}
      data-overdue={past() && checked() === false ? "true" : undefined}
      data-checked={checked() ? "true" : undefined}
      data-just-checked={view.justChecked().has(props.event.id) ? "true" : undefined}
      data-above={props.above ? "true" : undefined}
      data-moving={view.movingId() === props.event.id ? "true" : undefined}
      style={{ "--k2b-calendar-accent": eventAccent(props.event), top: termsCss(dayTopTerms(view.wake(), props.expanded, props.minute)) }}
    >
      <span class="k2b-calendar-marker__line" aria-hidden="true" />
      <span class="k2b-calendar-marker__pill">
        <Show when={checked() !== undefined}>
          <TimeCheck view={view} event={props.event} tabIndex={props.tabIndex === undefined ? undefined : -1} />
        </Show>
        <EventChip
          event={view.normalized(props.event, props.dayKey)}
          owner={view.props.owner}
          href={eventHref(view.props.owner, props.event)}
          compact
          timeline
          checkbox={checked() !== undefined}
          onCheck={view.checkOf(props.event)}
          tabIndex={props.tabIndex}
          stop={props.stop}
          trailing={
            <Show when={props.showTime}>
              <span class="k2b-calendar-marker__time">{view.clock(props.minute)}</span>
            </Show>
          }
          onMovePointerDown={
            view.props.owner.onEventDrop
              ? (pointerEvent) => view.startMove(pointerEvent, props.event, props.dayKey, props.minute, props.minute, props.scroller?.())
              : undefined
          }
        />
      </span>
    </div>
  );
};

/** Free time between entries, labelled from an hour on; activating it creates there. */
export const TimeGap = (props: {
  view: TimeView;
  gap: DayGap;
  dayKey: string;
  expanded: boolean;
  /** A deadline pill near the middle moves the label aside. */
  aside: boolean;
  tabIndex?: number;
  stop?: CalendarStop;
}) => {
  const view = props.view;
  const length = () => props.gap.end - props.gap.start;
  const proposal = () => gapProposal(props.gap, view.hours());
  const label = () => view.messages().calendarFree({ duration: view.duration(length()) });
  const hit = () => {
    const current = view.gapHit();
    return current && current.key === props.dayKey && current.start === props.gap.start ? current : null;
  };
  const top = () => dayYTerms(view.wake(), props.expanded, props.gap.start);
  /** Shorter free time is hidden until something is dragged into it, so it is no keyboard stop. */
  const labelled = () => length() >= GAP_LABEL_MINUTES;
  const stop = () => (labelled() ? props.stop : undefined);
  return (
    <div
      class="k2b-calendar-gap"
      data-short={labelled() ? undefined : "true"}
      data-long={length() >= GAP_LONG_MINUTES ? "true" : undefined}
      data-past={props.gap.past ? "true" : undefined}
      data-aside={props.aside ? "true" : undefined}
      data-hit={hit() ? (hit()!.fits ? "fit" : "short") : undefined}
      style={{ top: termsCss(top()), height: termsCss(subtractTerms(dayYTerms(view.wake(), props.expanded, props.gap.end), top())) }}
    >
      <span class="k2b-calendar-gap__zone" aria-hidden="true" />
      <Show when={view.canCreate()}>
        <button
          type="button"
          class="k2b-calendar-gap__button"
          tabIndex={labelled() ? (props.tabIndex ?? (props.gap.past ? -1 : 0)) : -1}
          data-stop={stop()?.id}
          data-col={stop()?.column}
          data-minute={stop()?.minute}
          aria-label={view.messages().calendarFreeAction({
            duration: view.duration(length()),
            from: view.clock(props.gap.start),
            to: view.clock(props.gap.end),
            start: view.clock(proposal()[0]),
            end: view.clock(proposal()[1]),
          })}
          title={view.messages().calendarCreateAt({ start: view.clock(proposal()[0]), end: view.clock(proposal()[1]) })}
          onClick={(event) => {
            event.stopPropagation();
            view.openQuickCreate(props.dayKey, proposal()[0], proposal()[1], event.currentTarget);
          }}
        >
          <i class="ti ti-plus" aria-hidden="true" />
          <span class="k2b-calendar-gap__text">{hit() ? hit()!.text : label()}</span>
        </button>
      </Show>
    </div>
  );
};

/** The preview of a drag, a draw, or an entry dragged in, and the selected slot. */
export const TimeOverlays = (props: { view: TimeView; dayKey: string; expanded: boolean }) => {
  const view = props.view;
  const ghost = () => {
    const current = view.ghost();
    return current && current.key === props.dayKey ? current : null;
  };
  const selected = () => {
    const current = view.selection();
    return current && current.key === props.dayKey && current.start !== undefined && current.end !== undefined ? current : null;
  };
  const draft = () => {
    const current = view.touchDraft();
    return current && current.key === props.dayKey ? current : null;
  };
  const box = (start: number, end: number) => {
    const top = dayTopTerms(view.wake(), props.expanded, start);
    return { top: termsCss(top), height: termsCss(subtractTerms(dayYTerms(view.wake(), props.expanded, end), top)) };
  };
  return (
    <>
      <Show when={selected()}>
        {(slot) => <span class="k2b-calendar-slot" style={box(slot().start!, slot().end!)} aria-hidden="true" />}
      </Show>
      <Show when={draft()}>
        {(slot) => (
          <div class="k2b-calendar-draft" style={box(slot().start, slot().end)}>
            <span
              class="k2b-calendar-draft__grip"
              data-edge="start"
              aria-hidden="true"
              onPointerDown={(event) => startDraftResize(view, event, "start")}
            />
            <button
              type="button"
              class="k2b-calendar-draft__open"
              aria-label={view.messages().calendarCreateAt({ start: view.clock(slot().start), end: view.clock(slot().end) })}
              onClick={(event) => view.openQuickCreate(slot().key, slot().start, slot().end, event.currentTarget)}
            >
              <i class="ti ti-plus" aria-hidden="true" />
              <span>
                {view.clock(slot().start)}–{view.clock(slot().end)} · {view.duration(slot().end - slot().start)}
              </span>
            </button>
            <span
              class="k2b-calendar-draft__grip"
              data-edge="end"
              aria-hidden="true"
              onPointerDown={(event) => startDraftResize(view, event, "end")}
            />
          </div>
        )}
      </Show>
      <Show when={ghost()}>
        {(current) => (
          <div
            class="k2b-calendar-ghost"
            data-live="true"
            data-size={current().end - current().start < 40 ? "s" : "m"}
            data-warn={current().warn ? "true" : undefined}
            style={{ ...box(current().start, current().end), "--k2b-calendar-accent": current().colorHex ?? "var(--k2b-action)" }}
            aria-hidden="true"
          >
            <span class="k2b-calendar-ghost__title">{current().title}</span>
            <span class="k2b-calendar-ghost__time">{current().time}</span>
            <Show when={current().fit}>
              {(fit) => (
                <span class="k2b-calendar-ghost__fit" data-fit={fit().fits ? "fit" : "short"}>
                  {fit().text}
                </span>
              )}
            </Show>
          </div>
        )}
      </Show>
    </>
  );
};

/** The handles of a tapped slot change its start or end. */
const startDraftResize = (view: TimeView, pointerEvent: PointerEvent, edge: "start" | "end") => {
  const draft = view.touchDraft();
  if (!draft) return;
  pointerEvent.preventDefault();
  pointerEvent.stopPropagation();
  startCalendarPointerSession({
    event: pointerEvent,
    threshold: 1,
    resolve: (clientX, clientY) => {
      const hit = view.bodyAt(clientX, clientY);
      if (!hit || hit.key !== draft.key) return null;
      const minute = snapMinutes(hit.minute, 15);
      const current = view.touchDraft() ?? draft;
      return edge === "end"
        ? { ...current, end: Math.max(current.start + 15, Math.min(view.limitOf(draft.key), minute)) }
        : { ...current, start: Math.max(0, Math.min(current.end - 15, minute)) };
    },
    onPreview: (next) => {
      view.setTouchDraft(next);
      view.setSelection({ key: next.key, start: next.start, end: next.end });
    },
    onCommit: () => swallowNextClick(),
  });
};

/** Free time of a day with the gap of now trimmed, as both views draw it. */
export const dayGaps = (view: TimeView, key: string) => freeGaps(view.dayOf(key).bands, view.wake(), view.nowIn(key));

/** The bands of a day with their lanes, cut to what its timeline draws. */
export const dayBands = (view: TimeView, key: string, expanded: boolean) => {
  const limit = expanded ? DAY_MINUTES : view.wake();
  const visible = view.dayOf(key).bands.filter((band) => Math.min(limit, band.end) > Math.max(0, band.start));
  return dayLanes(visible, LANE_MINUTES);
};

/** Entries the folded night hides, as chips with their time. */
export const foldedEntries = (view: TimeView, key: string) => {
  const model = view.dayOf(key);
  const wake = view.wake();
  return [
    ...model.bands
      .filter((band) => band.end > wake)
      .map((band) => ({
        event: band.item,
        time: band.start >= wake ? view.clock(band.start) : view.messages().calendarUntil({ time: view.clock(band.end) }),
      })),
    ...model.markers.filter((marker) => marker.minute >= wake).map((marker) => ({ event: marker.item, time: view.clock(marker.minute) })),
  ];
};

/** The quick create at a slot or gap, as in the month view. */
export const TimeQuickCreate = (props: { view: TimeView }) => {
  const view = props.view;
  let element: HTMLDivElement | undefined;
  let returnFocus: HTMLElement | null = null;
  createEffect(() => {
    const current = view.quick();
    if (!element) return;
    if (!current) {
      if (element.matches(":popover-open")) element.hidePopover();
      return;
    }
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!element.matches(":popover-open")) element.showPopover();
    queueMicrotask(() => {
      if (view.quick() !== current || !element?.isConnected) return;
      placeCalendarPopover(current.anchor, element);
      element.querySelector<HTMLElement>("input,textarea,select,button,a[href],[tabindex]:not([tabindex='-1'])")?.focus();
    });
  });
  const close = (restore: boolean) => {
    if (!view.quick()) return;
    view.setQuick(null);
    view.setSelection(null);
    if (restore && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  return (
    <div
      ref={element}
      class="k2b-calendar-popover"
      popover="auto"
      role="dialog"
      aria-label={view.messages().calendarQuickCreate}
      data-kind="create"
      onToggle={(event) => {
        if (event.newState !== "closed" || !view.quick() || event.currentTarget.matches(":popover-open")) return;
        close(event.currentTarget.contains(document.activeElement) || document.activeElement === document.body);
      }}
    >
      <Show when={view.quick()} keyed>
        {(value) =>
          view.props.owner.renderQuickCreate?.(value.range, {
            create: value.create,
            close: () => {
              if (view.quick() === value) close(true);
            },
          })
        }
      </Show>
    </div>
  );
};

/** All-day entries of a day as chips: bars with torn ends where they go on, and points due that day. */
export const AllDayChips = (props: { view: TimeView; dayKey: string; spans: readonly DaySpan<CalendarEvent>[] }) => {
  const view = props.view;
  return (
    <For each={props.spans}>
      {(span) => {
        const event = span.item;
        const checked = () => view.checkedOf(event);
        return (
          <span
            class="k2b-calendar-allday-chip"
            data-bar={span.marker ? undefined : "true"}
            data-checkbox={checked() !== undefined ? "true" : undefined}
            data-checked={checked() ? "true" : undefined}
            data-just-checked={view.justChecked().has(event.id) ? "true" : undefined}
            style={{ "--k2b-calendar-accent": eventAccent(event) }}
          >
            <Show when={checked() !== undefined}>
              <TimeCheck view={view} event={event} />
            </Show>
            <EventChip
              event={view.normalized(event, props.dayKey)}
              owner={view.props.owner}
              href={eventHref(view.props.owner, event)}
              compact
              timeline
              bar={!span.marker}
              checkbox={checked() !== undefined}
              onCheck={view.checkOf(event)}
              continuesBefore={span.firstKey < props.dayKey}
              continuesAfter={span.lastKey > props.dayKey}
            />
          </span>
        );
      }}
    </For>
  );
};

/** Hour labels and lines of a day's timeline with the night open, and the date at midnight. */
export const nightHours = (wake: number) => {
  const hours: number[] = [];
  for (let minute = wake + 60; minute < DAY_MINUTES; minute += 60) hours.push(minute);
  return hours;
};

export const isNearNow = (view: TimeView, key: string, minute: number) => key === view.nowKey() && Math.abs(view.nowMinute() - minute) < 14;

/** Whether a marker sits right above a band's start, so its pill goes above the line. */
export const markerAbove = (model: DayModel<CalendarEvent>, minute: number) =>
  model.bands.some((band) => band.start >= minute - 10 && band.start <= minute + 20);

/** Whether a deadline pill sits near the middle of a gap, so the gap's label moves aside. */
export const gapAside = (model: DayModel<CalendarEvent>, gap: DayGap) => {
  const middle = (gap.start + gap.end) / 2;
  return model.markers.some(
    (marker) => marker.minute > gap.start - 10 && marker.minute < gap.end + 10 && Math.abs(marker.minute - middle) < 25,
  );
};

/** A day's counts for its header: events and all-day entries, to-dos and deadlines. */
export const daySummary = (view: TimeView, key: string) => {
  const model = view.dayOf(key);
  const isTask = (event: CalendarEvent) => event.display === "marker" || event.checked !== undefined;
  const all = [
    ...model.bands.map((band) => band.item),
    ...model.markers.map((marker) => marker.item),
    ...model.spans.map((span) => span.item),
  ];
  const tasks = all.filter(isTask).length;
  return view.messages().calendarDaySummary({ events: all.length - tasks, tasks });
};

/** What starts within the next hour today, such as "Planning in 12 min". */
export const soonNote = (view: TimeView, key: string) => {
  if (key !== view.nowKey()) return "";
  const now = view.nowMinute();
  const next = view
    .dayOf(key)
    .bands.filter((band) => band.start > now && band.start - now <= 60 && !view.checkedOf(band.item))
    .sort((left, right) => left.start - right.start)[0];
  return next ? view.messages().calendarSoon({ title: next.item.title, duration: view.duration(next.start - now) }) : "";
};

/** The busy minutes of a day's waking hours, merged, with the color of the first entry, for the thin load line. */
export const dayLoad = (view: TimeView, key: string) => {
  const pieces = view
    .dayOf(key)
    .bands.map((band) => ({ start: Math.max(0, band.start), end: Math.min(view.wake(), band.end), color: eventAccent(band.item) }))
    .filter((piece) => piece.end > piece.start)
    .sort((left, right) => left.start - right.start);
  const merged: typeof pieces = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last && piece.start <= last.end) last.end = Math.max(last.end, piece.end);
    else merged.push({ ...piece });
  }
  return merged;
};

/** Day keys of the week that holds a day, from its first day. */
export const weekKeysOf = (view: TimeView, key: string) => {
  const start = view.keyOf(calendar.startOfWeek(view.parseKey(key), view.dateConfig()));
  return Array.from({ length: 7 }, (_, index) => addDayKeys(start, index));
};
