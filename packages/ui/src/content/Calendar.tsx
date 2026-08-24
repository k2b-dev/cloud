import { Link, type LinkNavigateEvent } from "@k2b/ssr/nav";
import { dates as calendar, type DateContext } from "@k2b/stdlib";
import type { JSX, ParentProps } from "solid-js";
import { createMemo, createSignal, For, mergeProps, onCleanup, onMount, Show } from "solid-js";
import { Button } from "../actions/Button";
import SegmentedControl from "../actions/SegmentedControl";
import { useDateConfigLocale } from "../intl/locale";
import { layoutCalendarIntervals } from "./calendar-event-layout";
import { calendarDayIndexAtPoint, calendarMinuteAtPoint, startCalendarPointerSession } from "./calendar-pointer";

export type CalendarView = "day" | "week" | "month" | "year" | "mobile-month";

export type CalendarEventColor = "blue" | "emerald" | "amber" | "red" | "violet" | "cyan" | "zinc";

export type CalendarEvent = {
  id: string;
  title: string;
  start: Date | string;
  end?: Date | string;
  allDay?: boolean;
  color?: CalendarEventColor;
  colorHex?: string;
  href?: string;
  dataSpaceItemId?: string;
  meta?: string;
  description?: string;
  display?: "event" | "background";
  location?: string;
  calendarName?: string;
  attendees?: CalendarAttendee[];
  resources?: CalendarResource[];
  recurrence?: CalendarRecurrence;
};

export type CalendarAttendee = {
  name: string;
  status?: "accepted" | "declined" | "tentative" | "needs-action";
};

export type CalendarResource = {
  name: string;
  kind?: "room" | "equipment" | "link" | "other";
};

export type CalendarRecurrence = {
  rrule: string;
  exdate?: Array<Date | string>;
  recurrenceId?: Date | string;
};

export type CalendarLabels = Partial<{
  today: string;
  day: string;
  week: string;
  month: string;
  year: string;
  allDay: string;
  noEvents: string;
  previous: string;
  next: string;
}>;

export type CalendarEventRenderContext = {
  compact: boolean;
  fill: boolean;
  start: Date;
  end: Date;
  allDay: boolean;
  durationHours: number;
  timeLabel: string;
};

export type CalendarProps = {
  date: Date | string;
  events: CalendarEvent[];
  view?: CalendarView;
  views?: CalendarView[];
  labels?: CalendarLabels;
  /** stdlib date context used for timezone-aware rendering and calendar math. */
  dateConfig?: DateContext;
  /** Convenience override for dateConfig.timeZone. */
  timeZone?: string;
  firstDayOfWeek?: 0 | 1;
  withWeekNumbers?: boolean;
  startHour?: number;
  endHour?: number;
  visibleStartHour?: number;
  visibleEndHour?: number;
  allDayMaxHeightRem?: number;
  hideAllDay?: boolean;
  selectedDate?: Date | string;
  selectedEventId?: string;
  dayBadges?: Record<string, CalendarDayBadge>;
  getViewHref?: (view: CalendarView) => string;
  getDateHref?: (date: Date, view: CalendarView) => string;
  getEventHref?: (event: CalendarEvent) => string | undefined;
  renderEvent?: (event: CalendarEvent, context: CalendarEventRenderContext) => JSX.Element;
  /** Progressively enhance canonical calendar links after the app has loaded their target state. */
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
  /** Progressively enhance canonical links without a document view transition. */
  onNavigateHref?: (href: string) => void;
  /** Optionally preload the target behind a canonical calendar link. */
  onPrefetch?: (href: string) => void;
  navigationPending?: boolean;
  onViewChange?: (view: CalendarView) => void;
  onDateChange?: (date: Date, view: CalendarView) => void;
  /** One activation contract for pointer and keyboard input. */
  onEventActivate?: (event: CalendarEvent) => void;
  /** Pointer gesture used for activation. Keyboard activation is always immediate. */
  eventActivation?: "single" | "double";
  onEventDrop?: (event: CalendarEvent, next: CalendarEventTimeChange) => void;
  onEventResize?: (event: CalendarEvent, next: CalendarEventTimeChange) => void;
  onSlotActivate?: (slot: CalendarEventTimeChange) => void;
  /** Pointer gesture used for empty slots. Keyboard activation is always immediate. */
  slotActivation?: "single" | "double";
  toolbarActions?: JSX.Element;
  toolbarContent?: JSX.Element;
  class?: string;
};

export type CalendarEventTimeChange = {
  start: Date;
  end: Date;
  allDay?: boolean;
};

export type CalendarDayBadge = {
  icon?: string;
  label: string;
};

type NormalizedEvent = CalendarEvent & {
  startDate: Date;
  endDate: Date;
  dayKey: string;
  sourceStartDate: Date;
  sourceEndDate: Date;
};

type CalendarPreview = CalendarEventTimeChange & {
  id: string;
  title?: string;
};

type TimedEventLayout = {
  event: NormalizedEvent;
  lane: number;
  lanes: number;
  groupId: number;
  groupStartDate: Date;
  groupEndDate: Date;
};

type TimedOverflowLayout = {
  groupId: number;
  hiddenEvents: NormalizedEvent[];
  groupStartDate: Date;
  groupEndDate: Date;
};

const labels: Required<CalendarLabels> = {
  today: "Today",
  day: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
  allDay: "All day",
  noEvents: "No events",
  previous: "Previous",
  next: "Next",
};

const ownerDateConfig = (owner: CalendarProps): DateContext => ({
  ...owner.dateConfig,
  timeZone: owner.timeZone ?? owner.dateConfig?.timeZone,
  firstDayOfWeek: owner.firstDayOfWeek ?? owner.dateConfig?.firstDayOfWeek ?? owner.dateConfig?.weekStartsOn ?? 1,
});

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;

const parseDate = (value: Date | string, context?: DateContext): Date => {
  if (value instanceof Date) return new Date(value);
  if (dateOnlyPattern.test(value)) return calendar.parseCalendarDate(value, context);
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const [year, month = "1", day = "1"] = value.split("-");
  return new Date(Number(year), Number(month) - 1, Number(day), 12);
};

const validDate = (value: Date): boolean => !Number.isNaN(value.getTime());

const weekNumber = (date: Date): number => {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
};
const zonedWeekNumber = (date: Date, context?: DateContext): number => {
  if (!context?.timeZone) return weekNumber(date);
  const [year = "1970", month = "1", day = "1"] = calendar.formatDateKey(date, context).split("-");
  return weekNumber(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))));
};

const formatTime = (date: Date, context?: DateContext): string => calendar.formatTime(date, context);
const formatDay = (date: Date, context?: DateContext): string =>
  date.toLocaleDateString(context?.locale ?? "en", { weekday: "short", day: "numeric", timeZone: context?.timeZone });
const formatMonth = (date: Date, context?: DateContext): string => calendar.formatMonthYear(date, context);
const zonedYearMonth = (date: Date, context?: DateContext): { year: number; month: number } => {
  const [year = "1970", month = "1"] = calendar.formatDateKey(date, context).split("-");
  return { year: Number(year), month: Number(month) - 1 };
};
const zonedMonthDate = (year: number, month: number, context?: DateContext): Date => {
  const value = `${year}-${String(month + 1).padStart(2, "0")}-01T12:00`;
  if (!context?.timeZone) return parseDate(value);
  return new Date(calendar.zonedDateTimeToInstant(value, context.timeZone, { disambiguation: "compatible" }));
};

const startOfDay = (date: Date, context?: DateContext): Date => calendar.startOfDay(date, context);
const endOfDay = (date: Date, context?: DateContext): Date => calendar.endOfDay(date, context);
const isStartOfDay = (date: Date, context?: DateContext): boolean => date.getTime() === startOfDay(date, context).getTime();
const addMinutes = (date: Date, minutes: number): Date => new Date(date.getTime() + minutes * 60 * 1000);
const zonedHour = (date: Date, context?: DateContext): number => {
  if (!context?.timeZone) return date.getHours() + date.getMinutes() / 60;
  const value = calendar.instantToZonedInput(date, context.timeZone);
  return Number(value.slice(11, 13)) + Number(value.slice(14, 16)) / 60;
};
const zonedSlot = (day: Date, hour: number, context?: DateContext): Date => {
  return zonedMinuteSlot(day, hour * 60, context);
};
const zonedMinuteSlot = (day: Date, minuteOfDay: number, context?: DateContext): Date => {
  const bounded = Math.max(0, Math.min(23 * 60 + 59, minuteOfDay));
  const hour = Math.floor(bounded / 60);
  const minute = bounded % 60;
  const value = `${calendar.formatDateKey(day, context)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (!context?.timeZone) return parseDate(value);
  return new Date(calendar.zonedDateTimeToInstant(value, context.timeZone, { disambiguation: "compatible" }));
};
const normalizeEvents = (events: CalendarEvent[], context?: DateContext): NormalizedEvent[] =>
  events.flatMap((event) => {
    const startDate = parseDate(event.start, context);
    if (!validDate(startDate)) return [];
    const parsedEnd = event.end ? parseDate(event.end, context) : null;
    const endDate = parsedEnd && validDate(parsedEnd) ? parsedEnd : new Date(startDate.getTime() + 60 * 60 * 1000);
    const duration = Math.max(60 * 60 * 1000, endDate.getTime() - startDate.getTime());
    const rangeEnd = endDate > startDate ? endDate : new Date(startDate.getTime() + duration);
    const startKey = calendar.formatDateKey(startDate, context);
    const endKey = calendar.formatDateKey(rangeEnd, context);
    if (!event.allDay && startKey === endKey) {
      return [
        {
          ...event,
          startDate,
          endDate: rangeEnd,
          sourceStartDate: startDate,
          sourceEndDate: rangeEnd,
          dayKey: startKey,
        },
      ];
    }
    const lastDay =
      event.allDay && isStartOfDay(rangeEnd, context)
        ? calendar.addDays(startOfDay(rangeEnd, context), -1, context)
        : startOfDay(rangeEnd, context);
    const days: NormalizedEvent[] = [];
    for (let day = startOfDay(startDate, context); day <= lastDay; day = calendar.addDays(day, 1, context)) {
      const segmentStart = day.getTime() === startOfDay(startDate, context).getTime() ? startDate : startOfDay(day, context);
      const segmentEnd = day.getTime() === startOfDay(rangeEnd, context).getTime() ? rangeEnd : endOfDay(day, context);
      days.push({
        ...event,
        startDate: segmentStart,
        endDate: segmentEnd,
        sourceStartDate: startDate,
        sourceEndDate: rangeEnd,
        dayKey: calendar.formatDateKey(day, context),
        allDay: event.allDay,
      });
    }
    return days;
  });

const eventHref = (props: CalendarProps, event: CalendarEvent): string | undefined => props.getEventHref?.(event) ?? event.href;

const moveEventTo = (event: NormalizedEvent, target: Date, allDay = false, context?: DateContext): CalendarEventTimeChange => {
  const duration = Math.max(30 * 60 * 1000, event.sourceEndDate.getTime() - event.sourceStartDate.getTime());
  const start = allDay ? startOfDay(target, context) : new Date(target);
  start.setSeconds(0, 0);
  return { start, end: new Date(start.getTime() + duration), allDay };
};

const moveEventToDay = (event: NormalizedEvent, day: Date, context?: DateContext): CalendarEventTimeChange => {
  if (event.allDay) return moveEventTo(event, startOfDay(day, context), true, context);
  const localStart = context?.timeZone ? calendar.instantToZonedInput(event.sourceStartDate, context.timeZone) : null;
  const hour = localStart ? Number(localStart.slice(11, 13)) : event.sourceStartDate.getHours();
  const minute = localStart ? Number(localStart.slice(14, 16)) : event.sourceStartDate.getMinutes();
  return moveEventTo(event, zonedMinuteSlot(day, hour * 60 + minute, context), false, context);
};

const eventTimeChanged = (event: NormalizedEvent, next: CalendarEventTimeChange): boolean =>
  event.sourceStartDate.getTime() !== next.start.getTime() ||
  event.sourceEndDate.getTime() !== next.end.getTime() ||
  Boolean(event.allDay) !== Boolean(next.allDay);

const previewSegments = (preview: CalendarPreview | null, days: Date[], context?: DateContext): NormalizedEvent[] =>
  preview
    ? normalizeEvents(
        [
          {
            id: `preview-${preview.id}`,
            title: preview.title ?? "",
            start: preview.start,
            end: preview.end,
            allDay: preview.allDay,
            color: "blue",
          },
        ],
        context,
      ).filter((event) => days.some((day) => event.dayKey === calendar.formatDateKey(day, context)))
    : [];

const timedEventLayouts = (events: NormalizedEvent[]): TimedEventLayout[] => {
  return layoutCalendarIntervals(events, (event) => ({
    start: event.startDate.getTime(),
    end: event.endDate.getTime(),
  })).map(({ item: event, lane, lanes, groupId, groupStart, groupEnd }) => ({
    event,
    lane,
    lanes,
    groupId,
    groupStartDate: new Date(groupStart),
    groupEndDate: new Date(groupEnd),
  }));
};

const EventChip = (props: {
  event: NormalizedEvent;
  owner: CalendarProps;
  href?: string;
  compact?: boolean;
  fill?: boolean;
  moving?: boolean;
  onMovePointerDown?: (event: PointerEvent, onActivate: () => void) => void;
}): JSX.Element => {
  const dateConfig = createMemo(() => ownerDateConfig(props.owner));
  const color = () => props.event.color ?? "blue";
  const selected = () => Boolean(props.owner.selectedEventId) && props.owner.selectedEventId === props.event.id;
  const style = () => (props.event.colorHex ? { "--k2b-calendar-accent": props.event.colorHex } : undefined);
  const isInteractive = () => Boolean(props.owner.onEventActivate);
  const durationHours = () => (props.event.endDate.getTime() - props.event.startDate.getTime()) / 3_600_000;
  const short = () => Boolean(props.fill && !props.event.allDay && durationHours() < 0.75);
  const showTime = () => !props.event.allDay && !props.compact && durationHours() >= 0.75;
  const showLocation = () => Boolean(props.event.location && !props.compact && durationHours() >= 1.25);
  const showDescription = () =>
    Boolean(props.event.description?.trim() && props.fill && !props.event.allDay && !props.compact && durationHours() >= 1.5);
  const timeLabel = () => `${formatTime(props.event.startDate, dateConfig())} - ${formatTime(props.event.endDate, dateConfig())}`;
  const renderedEvent = () =>
    props.owner.renderEvent?.(props.event, {
      compact: props.compact ?? false,
      fill: props.fill ?? false,
      start: props.event.startDate,
      end: props.event.endDate,
      allDay: props.event.allDay ?? false,
      durationHours: durationHours(),
      timeLabel: timeLabel(),
    });
  const defaultContent = (
    <>
      <span class="k2b-calendar-event__title">{props.event.title}</span>
      <Show when={showTime()}>
        <span class="k2b-calendar-event__meta">{timeLabel()}</span>
      </Show>
      <Show when={showLocation()}>
        <span class="k2b-calendar-event__meta">{props.event.location}</span>
      </Show>
      <Show when={showDescription()}>
        <span class="k2b-calendar-event__description">{props.event.description}</span>
      </Show>
    </>
  );
  const content = () => renderedEvent() ?? defaultContent;
  const isActionable = () => isInteractive() || Boolean(props.onMovePointerDown);
  let suppressClickUntil = 0;
  const onClick = (event: MouseEvent) => {
    if (performance.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!props.owner.onEventActivate || props.owner.eventActivation === "double") return;
    event.preventDefault();
    event.stopPropagation();
    props.owner.onEventActivate(props.event);
  };
  const onDoubleClick = (event: MouseEvent) => {
    if (!props.owner.onEventActivate || props.owner.eventActivation !== "double") return;
    event.preventDefault();
    event.stopPropagation();
    props.owner.onEventActivate(props.event);
  };
  const onButtonKeyDown = (event: KeyboardEvent) => {
    if (!isInteractive() || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    props.owner.onEventActivate?.(props.event);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    if (props.onMovePointerDown) event.stopPropagation();
    props.onMovePointerDown?.(event, () => {
      suppressClickUntil = performance.now() + 400;
    });
  };

  return props.href ? (
    <a
      href={props.href}
      class="k2b-calendar-event"
      data-calendar-event=""
      data-color={props.event.colorHex ? undefined : color()}
      data-selected={selected() ? "true" : undefined}
      data-compact={props.compact ? "true" : undefined}
      data-fill={props.fill ? "true" : undefined}
      data-short={short() ? "true" : undefined}
      data-moving={props.moving ? "true" : undefined}
      data-interactive={isInteractive() ? "true" : undefined}
      data-display={props.event.display}
      data-space-item-id={props.event.dataSpaceItemId}
      style={style()}
      draggable={props.onMovePointerDown ? false : undefined}
      onClick={onClick}
      onDblClick={onDoubleClick}
      onDragStart={props.onMovePointerDown ? (event) => event.preventDefault() : undefined}
      onPointerDown={onPointerDown}
      aria-label={`${props.event.title}${props.event.allDay ? "" : `, ${formatTime(props.event.startDate, dateConfig())} to ${formatTime(props.event.endDate, dateConfig())}`}`}
    >
      {content()}
    </a>
  ) : isActionable() ? (
    <button
      type="button"
      class="k2b-calendar-event"
      data-calendar-event=""
      data-color={props.event.colorHex ? undefined : color()}
      data-selected={selected() ? "true" : undefined}
      data-compact={props.compact ? "true" : undefined}
      data-fill={props.fill ? "true" : undefined}
      data-short={short() ? "true" : undefined}
      data-moving={props.moving ? "true" : undefined}
      data-interactive="true"
      data-display={props.event.display}
      style={style()}
      onClick={onClick}
      onDblClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onKeyDown={onButtonKeyDown}
      aria-label={`${props.event.title}${props.event.allDay ? "" : `, ${formatTime(props.event.startDate, dateConfig())} to ${formatTime(props.event.endDate, dateConfig())}`}`}
    >
      {content()}
    </button>
  ) : (
    <div
      class="k2b-calendar-event"
      role="group"
      data-calendar-event=""
      data-color={props.event.colorHex ? undefined : color()}
      data-selected={selected() ? "true" : undefined}
      data-compact={props.compact ? "true" : undefined}
      data-fill={props.fill ? "true" : undefined}
      data-short={short() ? "true" : undefined}
      data-moving={props.moving ? "true" : undefined}
      data-interactive={undefined}
      data-display={props.event.display}
      style={style()}
      aria-label={`${props.event.title}${props.event.allDay ? "" : `, ${formatTime(props.event.startDate, dateConfig())} to ${formatTime(props.event.endDate, dateConfig())}`}`}
    >
      {content()}
    </div>
  );
};

const slotInteractionProps = (
  owner: CalendarProps,
  slot: () => CalendarEventTimeChange,
  suppressed?: () => boolean,
  nativeControl = false,
) => {
  const isSlotChild = (event: Event) => {
    if (!(event.target instanceof Element)) return false;
    const control = event.target.closest("a,button,[data-calendar-event]");
    return Boolean(control && control !== event.currentTarget);
  };
  const interactive = Boolean(owner.onSlotActivate);
  const activate = (event: Event) => {
    if (!owner.onSlotActivate || isSlotChild(event) || suppressed?.()) return;
    event.preventDefault();
    owner.onSlotActivate(slot());
  };
  return {
    role: interactive && !nativeControl ? ("button" as const) : undefined,
    tabIndex: interactive && !nativeControl ? 0 : undefined,
    onClick: (event: MouseEvent) => {
      if (owner.slotActivation === "double") return;
      activate(event);
    },
    onDblClick: (event: MouseEvent) => {
      if (owner.slotActivation !== "double") return;
      activate(event);
    },
    onKeyDown: nativeControl
      ? undefined
      : (event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") activate(event);
        },
  };
};

type CalendarNavigationLinkProps = ParentProps<{
  owner: CalendarProps;
  href: string;
  anchorProps?: Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "children" | "href" | "onClick"> & {
    "data-divider"?: string;
    "data-outside"?: string;
    "data-size"?: string;
    "data-today"?: string;
    "data-variant"?: string;
  };
}>;

/** A real anchor is the baseline; the optional handler only enhances it after hydration. */
const CalendarNavigationLink = (props: CalendarNavigationLinkProps): JSX.Element => {
  const preload = () => props.owner.onPrefetch?.(props.href);
  const navigateHref: JSX.EventHandler<HTMLAnchorElement, MouseEvent> = (event) => {
    const anchor = event.currentTarget;
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (anchor.target && anchor.target !== "_self") ||
      anchor.hasAttribute("download") ||
      new URL(anchor.href).origin !== window.location.origin
    ) {
      return;
    }
    event.preventDefault();
    props.owner.onNavigateHref?.(props.href);
  };
  return props.owner.onNavigateHref ? (
    <a {...props.anchorProps} href={props.href} onClick={navigateHref} onPointerEnter={preload} onFocus={preload}>
      {props.children}
    </a>
  ) : props.owner.onNavigate ? (
    <Link
      {...props.anchorProps}
      href={props.href}
      scroll="preserve"
      onNavigate={props.owner.onNavigate}
      onPointerEnter={preload}
      onFocus={preload}
    >
      {props.children}
    </Link>
  ) : (
    <a {...props.anchorProps} href={props.href} onPointerEnter={preload} onFocus={preload}>
      {props.children}
    </a>
  );
};

const CalendarViewLinks = (props: {
  owner: CalendarProps;
  view: CalendarView;
  options: Array<{ value: CalendarView; label: string }>;
}): JSX.Element => {
  const refs: HTMLAnchorElement[] = [];
  const selectRelative = (currentIndex: number, direction: -1 | 1) => {
    if (props.options.length === 0) return;
    refs[(currentIndex + direction + props.options.length) % props.options.length]?.click();
  };
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      selectRelative(index, 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      selectRelative(index, -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      refs[event.key === "Home" ? 0 : props.options.length - 1]?.click();
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="Calendar view"
      aria-orientation="horizontal"
      class="k2b-segmented-control k2b-calendar-view-switcher"
    >
      <For each={props.options}>
        {(option, index) => {
          const active = () => (props.view === "mobile-month" ? "month" : props.view) === option.value;
          const href = () => props.owner.getViewHref?.(option.value) ?? "#";
          return (
            <CalendarNavigationLink
              owner={props.owner}
              href={href()}
              anchorProps={{
                ref: (element) => {
                  refs[index()] = element;
                },
                role: "radio",
                "aria-checked": active(),
                tabIndex: active() ? 0 : -1,
                class: "k2b-segmented-control__option",
                "data-divider":
                  index() < props.options.length - 1 &&
                  !active() &&
                  (props.view === "mobile-month" ? "month" : props.view) !== props.options[index() + 1]?.value
                    ? "true"
                    : undefined,
                onKeyDown: (event) => onKeyDown(event, index()),
              }}
            >
              {option.label}
            </CalendarNavigationLink>
          );
        }}
      </For>
    </div>
  );
};

const adjacentCalendarDate = (date: Date, view: CalendarView, direction: -1 | 1, dateConfig: DateContext) => {
  if (view === "year") return calendar.addMonths(date, direction * 12, dateConfig);
  if (view === "month" || view === "mobile-month") return calendar.addMonths(date, direction, dateConfig);
  return calendar.addDays(date, direction * (view === "day" ? 1 : 7), dateConfig);
};

const CalendarHeader = (props: { date: Date; view: CalendarView; labels: Required<CalendarLabels>; owner: CalendarProps }): JSX.Element => {
  const dateConfig = () => ownerDateConfig(props.owner);
  const previous = () => adjacentCalendarDate(props.date, props.view, -1, dateConfig());
  const next = () => adjacentCalendarDate(props.date, props.view, 1, dateConfig());
  const title = () => {
    if (props.view === "year")
      return new Intl.DateTimeFormat(dateConfig().locale ?? "en", { year: "numeric", timeZone: dateConfig().timeZone }).format(props.date);
    if (props.view === "day")
      return props.date.toLocaleDateString(dateConfig().locale ?? "en", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: dateConfig().timeZone,
      });
    if (props.view === "week")
      return `${formatDay(calendar.startOfWeek(props.date, dateConfig()), dateConfig())} - ${formatDay(calendar.addDays(calendar.startOfWeek(props.date, dateConfig()), 6, dateConfig()), dateConfig())}`;
    return formatMonth(props.date, dateConfig());
  };
  const goDate = (date: Date) => props.owner.onDateChange?.(date, props.view);
  const goView = (view: CalendarView) => {
    if (props.owner.onViewChange) {
      props.owner.onViewChange(view);
      return;
    }
    const href = props.owner.getViewHref?.(view);
    if (href) window.location.href = href;
  };
  const navButton = (date: Date, icon: string, label: string) => {
    const href = props.owner.getDateHref?.(date, props.view);
    return (props.owner.onNavigateHref || props.owner.onNavigate) && href ? (
      <CalendarNavigationLink
        owner={props.owner}
        href={href}
        anchorProps={{ "aria-label": label, title: label, class: "k2b-calendar-header__nav-button" }}
      >
        <i class={`ti ${icon}`} />
      </CalendarNavigationLink>
    ) : props.owner.onDateChange ? (
      <button type="button" aria-label={label} class="k2b-calendar-header__nav-button" onClick={() => goDate(date)}>
        <i class={`ti ${icon}`} />
      </button>
    ) : (
      <CalendarNavigationLink
        owner={props.owner}
        href={href ?? "#"}
        anchorProps={{ "aria-label": label, title: label, class: "k2b-calendar-header__nav-button" }}
      >
        <i class={`ti ${icon}`} />
      </CalendarNavigationLink>
    );
  };
  const todayButton = () => {
    const today = calendar.today(dateConfig());
    const href = props.owner.getDateHref?.(today, props.view);
    const label = <span class="k2b-button__label">{props.labels.today}</span>;
    return (props.owner.onNavigateHref || props.owner.onNavigate) && href ? (
      <CalendarNavigationLink
        owner={props.owner}
        href={href}
        anchorProps={{ class: "k2b-button k2b-calendar-header__today", "data-size": "sm", "data-variant": "input" }}
      >
        {label}
      </CalendarNavigationLink>
    ) : props.owner.onDateChange ? (
      <Button type="button" variant="input" size="sm" class="k2b-calendar-header__today" onClick={() => goDate(today)}>
        {props.labels.today}
      </Button>
    ) : (
      <CalendarNavigationLink
        owner={props.owner}
        href={href ?? "#"}
        anchorProps={{ class: "k2b-button k2b-calendar-header__today", "data-size": "sm", "data-variant": "input" }}
      >
        {label}
      </CalendarNavigationLink>
    );
  };
  const viewOptions = createMemo(() =>
    (
      [
        { value: "day", label: props.labels.day },
        { value: "week", label: props.labels.week },
        { value: "month", label: props.labels.month },
        { value: "year", label: props.labels.year },
      ] satisfies Array<{ value: CalendarView; label: string }>
    ).filter((option) => !props.owner.views || props.owner.views.includes(option.value)),
  );

  return (
    <header class="k2b-calendar-header">
      <div class="k2b-calendar-header__navigation">
        {navButton(previous(), "ti-chevron-left", props.labels.previous)}
        {navButton(next(), "ti-chevron-right", props.labels.next)}
        <div class="k2b-calendar-header__title">{title()}</div>
      </div>
      <div class="k2b-calendar-header__actions">
        {todayButton()}
        <Show
          when={!props.owner.onViewChange && props.owner.getViewHref}
          fallback={
            <SegmentedControl
              value={() => (props.view === "mobile-month" ? "month" : props.view)}
              onValueChange={goView}
              ariaLabel="Calendar view"
              options={viewOptions()}
            />
          }
        >
          <CalendarViewLinks owner={props.owner} view={props.view} options={viewOptions()} />
        </Show>
        {props.owner.toolbarActions}
      </div>
      <Show when={props.owner.navigationPending}>
        <span class="k2b-calendar-header__progress" aria-hidden="true" />
      </Show>
    </header>
  );
};

const MonthView = (props: {
  owner: CalendarProps;
  date: Date;
  now: Date;
  events: NormalizedEvent[];
  labels: Required<CalendarLabels>;
}): JSX.Element => {
  const dateConfig = createMemo(() => ownerDateConfig(props.owner));
  const [movePreview, setMovePreview] = createSignal<CalendarPreview | null>(null);
  const [movingEventId, setMovingEventId] = createSignal("");
  let cancelInteraction: (() => void) | undefined;
  let suppressSlotClickUntil = 0;
  const month = createMemo(() => zonedYearMonth(props.date, dateConfig()));
  const weeks = createMemo(() => calendar.getMonthGrid(month().year, month().month, dateConfig()));
  const weekdays = createMemo(() => calendar.weekdays(dateConfig()));
  const todayKey = createMemo(() => calendar.formatDateKey(props.now, dateConfig()));
  const eventsByDay = createMemo(() => {
    const grouped = new Map<string, NormalizedEvent[]>();
    for (const event of props.events) {
      const events = grouped.get(event.dayKey);
      if (events) events.push(event);
      else grouped.set(event.dayKey, [event]);
    }
    return grouped;
  });
  const clearMove = () => {
    setMovePreview(null);
    setMovingEventId("");
  };
  const dayAtPoint = (clientX: number, clientY: number): Date | null => {
    const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-calendar-day-key]");
    const dayKey = target?.dataset.calendarDayKey;
    return dayKey ? calendar.parseCalendarDate(dayKey, dateConfig()) : null;
  };
  const startMove = (pointerEvent: PointerEvent, event: NormalizedEvent, markDragged: () => void) => {
    if (!props.owner.onEventDrop) return;
    cancelInteraction?.();
    cancelInteraction = startCalendarPointerSession({
      event: pointerEvent,
      resolve: (clientX, clientY) => {
        const day = dayAtPoint(clientX, clientY);
        return day ? { id: event.id, ...moveEventToDay(event, day, dateConfig()) } : null;
      },
      onActivate: () => {
        markDragged();
        suppressSlotClickUntil = performance.now() + 400;
        setMovingEventId(event.id);
      },
      onPreview: setMovePreview,
      onCommit: (next) => {
        clearMove();
        if (eventTimeChanged(event, next)) props.owner.onEventDrop?.(event, next);
      },
      onCancel: clearMove,
    });
  };
  onCleanup(() => cancelInteraction?.());
  return (
    <div class="k2b-calendar-month" style={{ "grid-template-rows": `auto repeat(${weeks().length}, minmax(5rem, 1fr))` }}>
      <div class="k2b-calendar-month__weekdays" data-week-numbers={props.owner.withWeekNumbers ? "true" : undefined}>
        <Show when={props.owner.withWeekNumbers}>
          <div class="k2b-calendar-month__weekday">Wk</div>
        </Show>
        <For each={weekdays()}>{(day) => <div class="k2b-calendar-month__weekday">{day}</div>}</For>
      </div>
      <For each={weeks()}>
        {(week) => (
          <div class="k2b-calendar-month__week" data-week-numbers={props.owner.withWeekNumbers ? "true" : undefined}>
            <Show when={props.owner.withWeekNumbers}>
              <div class="k2b-calendar-month__week-number">{zonedWeekNumber(week[0]!, dateConfig())}</div>
            </Show>
            <For each={week}>
              {(day) => {
                const dayKey = calendar.formatDateKey(day, dateConfig());
                const events = eventsByDay().get(dayKey) ?? [];
                const href = props.owner.getDateHref?.(day, "day");
                const dayBadge = props.owner.dayBadges?.[dayKey];
                const sameMonth = calendar.isSameMonth(day, props.date, dateConfig());
                const isToday = dayKey === todayKey();
                const dayLabel = day.toLocaleDateString(dateConfig().locale ?? "en", {
                  weekday: "long",
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                  timeZone: dateConfig().timeZone,
                });
                const eventStack = createMemo(() => {
                  const preview = movePreview();
                  const previewForDay = preview && calendar.formatDateKey(preview.start, dateConfig()) === dayKey ? preview : null;
                  const candidates = previewForDay ? events.filter((event) => event.id !== previewForDay.id) : events;
                  const visibleLimit = previewForDay ? 2 : 3;
                  return {
                    preview: previewForDay,
                    visibleEvents: candidates.slice(0, visibleLimit),
                    hiddenCount: Math.max(0, candidates.length - visibleLimit),
                  };
                });
                return (
                  <div
                    class="k2b-calendar-month__day"
                    data-calendar-day-key={dayKey}
                    data-outside={!sameMonth ? "true" : undefined}
                    data-drop-preview={
                      movePreview()?.start && calendar.formatDateKey(movePreview()!.start, dateConfig()) === dayKey ? "true" : undefined
                    }
                  >
                    <Show
                      when={props.owner.onSlotActivate}
                      fallback={
                        <Show when={href}>
                          {(dayHref) => (
                            <CalendarNavigationLink
                              owner={props.owner}
                              href={dayHref()}
                              anchorProps={{ class: "k2b-calendar-month__day-target", "aria-label": `Open ${dayLabel}` }}
                            />
                          )}
                        </Show>
                      }
                    >
                      <button
                        type="button"
                        class="k2b-calendar-month__day-target"
                        data-interactive="true"
                        aria-label={`Create event on ${dayLabel}`}
                        {...slotInteractionProps(
                          props.owner,
                          () => {
                            const start = startOfDay(day, dateConfig());
                            return { start, end: calendar.addDays(start, 1, dateConfig()), allDay: true };
                          },
                          () => performance.now() < suppressSlotClickUntil,
                          true,
                        )}
                      />
                    </Show>
                    <div class="k2b-calendar-month__day-header">
                      <Show
                        when={props.owner.onSlotActivate && href}
                        fallback={
                          <span
                            class="k2b-calendar-month__day-number"
                            data-today={isToday ? "true" : undefined}
                            data-outside={!sameMonth ? "true" : undefined}
                          >
                            {calendar.formatDayNumber(day, dateConfig())}
                          </span>
                        }
                      >
                        {(dayHref) => (
                          <CalendarNavigationLink
                            owner={props.owner}
                            href={dayHref()}
                            anchorProps={{
                              class: "k2b-calendar-month__day-number",
                              "data-today": isToday ? "true" : undefined,
                              "data-outside": !sameMonth ? "true" : undefined,
                              "aria-label": `Open ${dayLabel}`,
                            }}
                          >
                            {calendar.formatDayNumber(day, dateConfig())}
                          </CalendarNavigationLink>
                        )}
                      </Show>
                      <Show when={dayBadge}>
                        {(badge) => (
                          <span class="k2b-calendar-month__badge">
                            <Show when={badge().icon}>{(icon) => <i class={`k2b-calendar-month__badge-icon ti ti-${icon()}`} />}</Show>
                            {badge().label}
                          </span>
                        )}
                      </Show>
                    </div>
                    <div class="k2b-calendar-month__events">
                      <Show when={eventStack().preview}>
                        <div class="k2b-calendar-preview">
                          {props.events.find((event) => event.id === eventStack().preview!.id)?.title ?? "Move event"}
                        </div>
                      </Show>
                      <For each={eventStack().visibleEvents}>
                        {(event) => (
                          <EventChip
                            event={event}
                            owner={props.owner}
                            href={eventHref(props.owner, event)}
                            compact
                            moving={movingEventId() === event.id}
                            onMovePointerDown={
                              props.owner.onEventDrop
                                ? (pointerEvent, markDragged) => startMove(pointerEvent, event, markDragged)
                                : undefined
                            }
                          />
                        )}
                      </For>
                      <Show when={eventStack().hiddenCount > 0}>
                        <CalendarNavigationLink owner={props.owner} href={href ?? "#"} anchorProps={{ class: "k2b-calendar-month__more" }}>
                          +{eventStack().hiddenCount} more
                        </CalendarNavigationLink>
                      </Show>
                    </div>
                    <div class="k2b-calendar-month__dots">
                      <For each={events.slice(0, 4)}>
                        {(event) => (
                          <span
                            class="k2b-calendar-dot"
                            data-color={event.colorHex ? undefined : (event.color ?? "blue")}
                            style={event.colorHex ? { "background-color": event.colorHex } : undefined}
                          />
                        )}
                      </For>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        )}
      </For>
    </div>
  );
};

const TimeGridView = (props: {
  owner: CalendarProps;
  date: Date;
  now: Date;
  events: NormalizedEvent[];
  labels: Required<CalendarLabels>;
  days: Date[];
}): JSX.Element => {
  const dateConfig = createMemo(() => ownerDateConfig(props.owner));
  const gridStartHour = () => props.owner.visibleStartHour ?? 0;
  const gridEndHour = () => props.owner.visibleEndHour ?? 23;
  const businessStartHour = () => props.owner.startHour ?? 8;
  const businessEndHour = () => props.owner.endHour ?? 18;
  const hours = createMemo(() => Array.from({ length: gridEndHour() - gridStartHour() + 1 }, (_, index) => gridStartHour() + index));
  const [timePreview, setTimePreview] = createSignal<CalendarPreview | null>(null);
  const [movingEventId, setMovingEventId] = createSignal("");
  const [expandedOverflow, setExpandedOverflow] = createSignal("");
  let scrollContainer: HTMLDivElement | undefined;
  let timeGrid: HTMLDivElement | undefined;
  let timeGutter: HTMLDivElement | undefined;
  let defaultHourMarker: HTMLDivElement | undefined;
  let cancelInteraction: (() => void) | undefined;
  let suppressSlotClickUntil = 0;
  const slotEnd = (start: Date) => addMinutes(start, 60);
  const previewEvents = createMemo(() => previewSegments(timePreview(), props.days, dateConfig()));
  const eventsByDay = createMemo(() => {
    const grouped = new Map<string, { allDay: NormalizedEvent[]; timed: NormalizedEvent[] }>();
    for (const event of props.events) {
      const bucket = grouped.get(event.dayKey) ?? { allDay: [], timed: [] };
      (event.allDay ? bucket.allDay : bucket.timed).push(event);
      grouped.set(event.dayKey, bucket);
    }
    return grouped;
  });
  const clearInteraction = () => {
    setTimePreview(null);
    setMovingEventId("");
  };
  const dayAtPoint = (clientX: number, clientY: number): Date | null => {
    const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-calendar-day-key]");
    const dayKey = target?.dataset.calendarDayKey;
    return dayKey ? calendar.parseCalendarDate(dayKey, dateConfig()) : null;
  };
  const timeAtPoint = (clientX: number, clientY: number): Date | null => {
    if (!timeGrid || !timeGutter) return null;
    const gridRect = timeGrid.getBoundingClientRect();
    const gutterRect = timeGutter.getBoundingClientRect();
    const dayIndex = calendarDayIndexAtPoint(clientX, gutterRect.right, gridRect.right - gutterRect.right, props.days.length);
    if (dayIndex === null) return null;
    const minute = Math.min(
      gridEndHour() * 60 + 45,
      calendarMinuteAtPoint(clientY, gridRect.top, gridRect.height, gridStartHour(), gridEndHour()),
    );
    return zonedMinuteSlot(props.days[dayIndex]!, minute, dateConfig());
  };
  const beginInteraction = (options: Parameters<typeof startCalendarPointerSession<CalendarPreview>>[0]) => {
    cancelInteraction?.();
    cancelInteraction = startCalendarPointerSession(options);
  };
  const startTimedMove = (pointerEvent: PointerEvent, event: NormalizedEvent, markDragged: () => void) => {
    if (!props.owner.onEventDrop) return;
    const pointerStart = timeAtPoint(pointerEvent.clientX, pointerEvent.clientY) ?? event.sourceStartDate;
    const duration = Math.max(15 * 60_000, event.sourceEndDate.getTime() - event.sourceStartDate.getTime());
    const offsetMinutes = Math.max(
      0,
      Math.min(duration / 60_000, Math.round((pointerStart.getTime() - event.sourceStartDate.getTime()) / 900_000) * 15),
    );
    beginInteraction({
      event: pointerEvent,
      scrollContainer,
      resolve: (clientX, clientY) => {
        const pointer = timeAtPoint(clientX, clientY);
        if (!pointer) return null;
        const start = new Date(pointer.getTime() - offsetMinutes * 60_000);
        return { id: event.id, title: event.title, start, end: new Date(start.getTime() + duration), allDay: false };
      },
      onActivate: () => {
        markDragged();
        suppressSlotClickUntil = performance.now() + 400;
        setMovingEventId(event.id);
      },
      onPreview: setTimePreview,
      onCommit: (next) => {
        clearInteraction();
        if (eventTimeChanged(event, next)) props.owner.onEventDrop?.(event, next);
      },
      onCancel: clearInteraction,
    });
  };
  const startAllDayMove = (pointerEvent: PointerEvent, event: NormalizedEvent, markDragged: () => void) => {
    if (!props.owner.onEventDrop) return;
    beginInteraction({
      event: pointerEvent,
      resolve: (clientX, clientY) => {
        const day = dayAtPoint(clientX, clientY);
        return day ? { id: event.id, title: event.title, ...moveEventTo(event, startOfDay(day, dateConfig()), true, dateConfig()) } : null;
      },
      onActivate: () => {
        markDragged();
        suppressSlotClickUntil = performance.now() + 400;
        setMovingEventId(event.id);
      },
      onPreview: setTimePreview,
      onCommit: (next) => {
        clearInteraction();
        if (eventTimeChanged(event, next)) props.owner.onEventDrop?.(event, next);
      },
      onCancel: clearInteraction,
    });
  };
  const startRange = (pointerEvent: PointerEvent) => {
    if (!props.owner.onSlotActivate || pointerEvent.pointerType === "touch") return;
    const anchor = timeAtPoint(pointerEvent.clientX, pointerEvent.clientY);
    if (!anchor) return;
    beginInteraction({
      event: pointerEvent,
      scrollContainer,
      resolve: (clientX, clientY) => {
        const current = timeAtPoint(clientX, clientY);
        if (!current) return null;
        const start = current < anchor ? current : anchor;
        const endBase = current < anchor ? anchor : current;
        return { id: "calendar-create-preview", start, end: addMinutes(endBase, 15), allDay: false };
      },
      onActivate: () => {
        suppressSlotClickUntil = performance.now() + 400;
      },
      onPreview: setTimePreview,
      onCommit: (next) => {
        clearInteraction();
        props.owner.onSlotActivate?.(next);
      },
      onCancel: clearInteraction,
    });
  };
  const timeRangeLayout = (startDate: Date, endDate: Date) => {
    const start = zonedHour(startDate, dateConfig());
    const end = zonedHour(endDate, dateConfig());
    const visibleStart = Math.max(gridStartHour(), start);
    const visibleEnd = Math.min(gridEndHour() + 1, end);
    const total = Math.max(1, gridEndHour() - gridStartHour() + 1);
    return {
      top: Math.max(0, ((visibleStart - gridStartHour()) / total) * 100),
      height: Math.max(1.25, ((visibleEnd - visibleStart) / total) * 100),
    };
  };
  const eventLayout = (event: NormalizedEvent) => timeRangeLayout(event.startDate, event.endDate);
  const isDayView = () => props.days.length === 1;
  const visibleLaneCount = (lanes: number) => (isDayView() ? lanes : Math.min(lanes, 3));
  const overflowLayouts = (layouts: TimedEventLayout[]): TimedOverflowLayout[] => {
    if (isDayView()) return [];
    const groups = new Map<number, TimedOverflowLayout>();
    for (const layout of layouts) {
      if (layout.lane < visibleLaneCount(layout.lanes)) continue;
      const existing = groups.get(layout.groupId);
      if (existing) existing.hiddenEvents.push(layout.event);
      else
        groups.set(layout.groupId, {
          groupId: layout.groupId,
          hiddenEvents: [layout.event],
          groupStartDate: layout.groupStartDate,
          groupEndDate: layout.groupEndDate,
        });
    }
    return [...groups.values()];
  };
  const dayColumnMinWidth = (layouts: TimedEventLayout[]) => {
    if (!isDayView()) return undefined;
    const lanes = Math.max(1, ...layouts.map((layout) => layout.lanes));
    return `${Math.max(32, lanes * 12)}rem`;
  };
  const laneStyle = (layoutItem: TimedEventLayout) => {
    if (isDayView()) {
      const laneWidth = 100 / layoutItem.lanes;
      return {
        left: `calc(${layoutItem.lane * laneWidth}% + 0.25rem)`,
        width: `calc(${laneWidth}% - 0.5rem)`,
      };
    }
    const visibleLanes = visibleLaneCount(layoutItem.lanes);
    return {
      left: `${layoutItem.lanes <= 1 ? 0 : (28 / Math.max(1, visibleLanes - 1)) * layoutItem.lane}%`,
      width: `${layoutItem.lanes <= 1 ? 100 : layoutItem.lanes > visibleLanes ? 68 : 72}%`,
    };
  };
  const currentTimeLine = (day: Date) => {
    const now = props.now;
    if (calendar.formatDateKey(day, dateConfig()) !== calendar.formatDateKey(now, dateConfig())) return null;
    const hour = zonedHour(now, dateConfig());
    if (hour < gridStartHour() || hour > gridEndHour() + 1) return null;
    return ((hour - gridStartHour()) / Math.max(1, gridEndHour() - gridStartHour() + 1)) * 100;
  };
  onCleanup(() => cancelInteraction?.());
  onMount(() => {
    requestAnimationFrame(() => {
      if (!scrollContainer || !defaultHourMarker) return;
      const targetTop = defaultHourMarker.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top;
      scrollContainer.scrollTo({ top: Math.max(0, scrollContainer.scrollTop + targetTop), behavior: "smooth" });
    });
  });
  return (
    <div class="k2b-calendar-time-grid">
      <div class="k2b-calendar-time-grid__days" style={{ "grid-template-columns": `4rem repeat(${props.days.length}, minmax(0, 1fr))` }}>
        <div />
        <For each={props.days}>
          {(day) => {
            const dayBadge = props.owner.dayBadges?.[calendar.formatDateKey(day, dateConfig())];
            const today = () => calendar.isToday(day, dateConfig());
            return (
              <CalendarNavigationLink
                owner={props.owner}
                href={props.owner.getDateHref?.(day, "day") ?? "#"}
                anchorProps={{ class: "k2b-calendar-time-grid__day" }}
              >
                <span class="k2b-calendar-time-grid__day-label" data-today={today() ? "true" : undefined}>
                  {formatDay(day, dateConfig())}
                </span>
                <Show when={dayBadge}>
                  {(badge) => (
                    <span class="k2b-calendar-time-grid__badge">
                      <Show when={badge().icon}>{(icon) => <i class={`k2b-calendar-time-grid__badge-icon ti ti-${icon()}`} />}</Show>
                      {badge().label}
                    </span>
                  )}
                </Show>
              </CalendarNavigationLink>
            );
          }}
        </For>
      </div>
      <Show when={!props.owner.hideAllDay}>
        <div
          class="k2b-calendar-time-grid__all-day"
          style={{
            "grid-template-columns": `4rem repeat(${props.days.length}, minmax(0, 1fr))`,
            "max-height": `${props.owner.allDayMaxHeightRem ?? 7}rem`,
          }}
        >
          <div class="k2b-calendar-time-grid__all-day-label">{props.labels.allDay}</div>
          <For each={props.days}>
            {(day) => {
              const dayKey = calendar.formatDateKey(day, dateConfig());
              const allDay = () => eventsByDay().get(dayKey)?.allDay ?? [];
              const previewAllDay = previewEvents().filter((event) => event.dayKey === dayKey && event.allDay);
              return (
                <div
                  class="k2b-calendar-time-grid__all-day-cell"
                  data-calendar-day-key={dayKey}
                  data-drop-preview={
                    timePreview()?.allDay && calendar.formatDateKey(timePreview()!.start, dateConfig()) === dayKey ? "true" : undefined
                  }
                  data-interactive={props.owner.onSlotActivate ? "true" : undefined}
                  {...slotInteractionProps(
                    props.owner,
                    () => {
                      const start = startOfDay(day, dateConfig());
                      return { start, end: calendar.addDays(start, 1, dateConfig()), allDay: true };
                    },
                    () => performance.now() < suppressSlotClickUntil,
                  )}
                >
                  <div class="k2b-calendar-time-grid__all-day-events">
                    <For each={previewAllDay}>{(event) => <div class="k2b-calendar-preview">{event.title}</div>}</For>
                    <For each={allDay()}>
                      {(event) => (
                        <EventChip
                          event={event}
                          owner={props.owner}
                          href={eventHref(props.owner, event)}
                          compact
                          moving={movingEventId() === event.id}
                          onMovePointerDown={
                            props.owner.onEventDrop
                              ? (pointerEvent, markDragged) => startAllDayMove(pointerEvent, event, markDragged)
                              : undefined
                          }
                        />
                      )}
                    </For>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
      <div ref={scrollContainer} class="k2b-calendar-time-grid__scroll">
        <div
          ref={timeGrid}
          class="k2b-calendar-time-grid__grid"
          style={{ "grid-template-columns": `4rem repeat(${props.days.length}, minmax(0, 1fr))` }}
        >
          <div
            ref={timeGutter}
            class="k2b-calendar-time-grid__gutter"
            style={{ "grid-template-rows": `repeat(${hours().length}, minmax(4rem, 1fr))` }}
          >
            <For each={hours()}>
              {(hour) => (
                <div
                  ref={(element) => {
                    if (hour === businessStartHour()) defaultHourMarker = element;
                  }}
                  class="k2b-calendar-time-grid__hour"
                  data-outside-business={hour < businessStartHour() || hour > businessEndHour() ? "true" : undefined}
                >
                  {`${hour}`.padStart(2, "0")}:00
                </div>
              )}
            </For>
          </div>
          <For each={props.days}>
            {(day) => {
              const dayKey = calendar.formatDateKey(day, dateConfig());
              const layouts = createMemo(() => timedEventLayouts(eventsByDay().get(dayKey)?.timed ?? []));
              return (
                <div
                  class="k2b-calendar-time-grid__column"
                  style={{
                    "min-width": dayColumnMinWidth(layouts()),
                    "grid-template-rows": `repeat(${hours().length}, minmax(4rem, 1fr))`,
                  }}
                >
                  <Show when={currentTimeLine(day) !== null}>
                    <div class="k2b-calendar-time-grid__now" style={{ top: `${currentTimeLine(day) ?? 0}%` }} />
                  </Show>
                  <For each={hours()}>
                    {(hour) => (
                      <div
                        class="k2b-calendar-time-grid__slot"
                        data-outside-business={hour < businessStartHour() || hour > businessEndHour() ? "true" : undefined}
                        data-interactive={props.owner.onSlotActivate ? "true" : undefined}
                        {...slotInteractionProps(
                          props.owner,
                          () => {
                            const start = zonedSlot(day, hour, dateConfig());
                            return { start, end: slotEnd(start), allDay: false };
                          },
                          () => performance.now() < suppressSlotClickUntil,
                        )}
                        onPointerDown={startRange}
                      />
                    )}
                  </For>
                  <For each={previewEvents().filter((event) => event.dayKey === dayKey && !event.allDay)}>
                    {(event) => {
                      const layout = eventLayout(event);
                      const short = event.endDate.getTime() - event.startDate.getTime() < 60 * 60_000;
                      return (
                        <div
                          class="k2b-calendar-preview k2b-calendar-preview--timed"
                          data-short={short ? "true" : undefined}
                          style={{ top: `${layout.top}%`, height: `${layout.height}%` }}
                        >
                          <div class="k2b-calendar-preview__content">
                            <Show when={event.title}>
                              <div class="k2b-calendar-preview__title">{event.title}</div>
                            </Show>
                            <div class="k2b-calendar-preview__label">
                              {formatTime(event.startDate, dateConfig())} - {formatTime(event.endDate, dateConfig())}
                            </div>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                  <For each={layouts()}>
                    {(layoutItem) => {
                      if (!isDayView() && layoutItem.lane >= visibleLaneCount(layoutItem.lanes)) return null;
                      const event = layoutItem.event;
                      const layout = eventLayout(event);
                      const position = laneStyle(layoutItem);
                      const resizeStart = (pointerEvent: PointerEvent) => {
                        if (!props.owner.onEventResize) return;
                        pointerEvent.preventDefault();
                        pointerEvent.stopPropagation();
                        beginInteraction({
                          event: pointerEvent,
                          scrollContainer,
                          threshold: 1,
                          resolve: (clientX, clientY) => {
                            const pointer = timeAtPoint(clientX, clientY);
                            if (!pointer) return null;
                            const minimumEnd = addMinutes(event.sourceStartDate, 15);
                            const end = pointer > minimumEnd ? pointer : minimumEnd;
                            return { id: event.id, title: event.title, start: event.sourceStartDate, end, allDay: false };
                          },
                          onActivate: () => {
                            suppressSlotClickUntil = performance.now() + 400;
                            setMovingEventId(event.id);
                          },
                          onPreview: setTimePreview,
                          onCommit: (next) => {
                            clearInteraction();
                            if (eventTimeChanged(event, next)) props.owner.onEventResize?.(event, next);
                          },
                          onCancel: clearInteraction,
                        });
                      };
                      return (
                        <div
                          class="k2b-calendar-time-grid__event-position"
                          style={{
                            top: `${layout.top}%`,
                            height: `${layout.height}%`,
                            left: position.left,
                            width: position.width,
                            "z-index": String(20 + layoutItem.lane),
                          }}
                        >
                          <div class="k2b-calendar-time-grid__event-frame">
                            <EventChip
                              event={event}
                              owner={props.owner}
                              href={eventHref(props.owner, event)}
                              fill
                              moving={movingEventId() === event.id}
                              onMovePointerDown={
                                props.owner.onEventDrop
                                  ? (pointerEvent, markDragged) => startTimedMove(pointerEvent, event, markDragged)
                                  : undefined
                              }
                            />
                            <Show when={props.owner.onEventResize}>
                              <button
                                type="button"
                                aria-label="Resize event"
                                draggable={false}
                                class="k2b-calendar-time-grid__resize"
                                onPointerDown={resizeStart}
                                onDragStart={(event) => event.preventDefault()}
                              >
                                <span class="k2b-calendar-time-grid__resize-icon" aria-hidden="true" />
                              </button>
                            </Show>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                  <For each={overflowLayouts(layouts())}>
                    {(overflow) => {
                      const layout = timeRangeLayout(overflow.groupStartDate, overflow.groupEndDate);
                      const key = `${dayKey}-${overflow.groupId}`;
                      const hiddenTitle = () =>
                        overflow.hiddenEvents.map((event) => `${formatTime(event.startDate, dateConfig())} ${event.title}`).join("\n");
                      return (
                        <>
                          <button
                            type="button"
                            class="k2b-calendar-time-grid__overflow"
                            style={{ top: `${layout.top}%`, height: `${layout.height}%` }}
                            title={hiddenTitle()}
                            aria-label={`${overflow.hiddenEvents.length} hidden overlapping events`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setExpandedOverflow(expandedOverflow() === key ? "" : key);
                            }}
                          >
                            <span class="k2b-calendar-time-grid__overflow-count">+{overflow.hiddenEvents.length}</span>
                          </button>
                          <Show when={expandedOverflow() === key}>
                            <div class="k2b-calendar-time-grid__overflow-menu" style={{ top: `${layout.top}%` }}>
                              <div class="k2b-calendar-time-grid__overflow-title">
                                {formatTime(overflow.groupStartDate, dateConfig())} - {formatTime(overflow.groupEndDate, dateConfig())}
                              </div>
                              <For each={overflow.hiddenEvents}>
                                {(event) => <EventChip event={event} owner={props.owner} href={eventHref(props.owner, event)} compact />}
                              </For>
                            </div>
                          </Show>
                        </>
                      );
                    }}
                  </For>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
};

const YearView = (props: { owner: CalendarProps; date: Date; now: Date; events: NormalizedEvent[] }): JSX.Element => {
  const dateConfig = createMemo(() => ownerDateConfig(props.owner));
  const year = createMemo(() => zonedYearMonth(props.date, dateConfig()).year);
  const todayKey = createMemo(() => calendar.formatDateKey(props.now, dateConfig()));
  const eventsByDay = createMemo(() => {
    const grouped = new Map<string, NormalizedEvent[]>();
    for (const event of props.events) {
      const events = grouped.get(event.dayKey);
      if (events) events.push(event);
      else grouped.set(event.dayKey, [event]);
    }
    return grouped;
  });
  const months = createMemo(() => {
    const context = dateConfig();
    return Array.from({ length: 12 }, (_, month) => {
      const date = zonedMonthDate(year(), month, context);
      return {
        date,
        label: date.toLocaleDateString(context.locale ?? "en", { month: "long", timeZone: context.timeZone }),
        days: calendar
          .getMonthGrid(year(), month, context)
          .flat()
          .map((day) => {
            const key = calendar.formatDateKey(day, context);
            return {
              date: day,
              events: eventsByDay().get(key) ?? [],
              isToday: key === todayKey(),
              outside: !calendar.isSameMonth(day, date, context),
              number: calendar.formatDayNumber(day, context),
            };
          }),
      };
    });
  });

  return (
    <div class="k2b-calendar-year">
      <For each={months()}>
        {(month) => (
          <div class="k2b-calendar-year__month">
            <div class="k2b-calendar-year__title">{month.label}</div>
            <div class="k2b-calendar-year__grid">
              <For each={month.days}>
                {(day) => (
                  <CalendarNavigationLink
                    owner={props.owner}
                    href={props.owner.getDateHref?.(day.date, "day") ?? "#"}
                    anchorProps={{
                      class: "k2b-calendar-year__day",
                      "data-today": day.isToday ? "true" : undefined,
                      "data-outside": day.outside ? "true" : undefined,
                    }}
                  >
                    {day.number}
                    <Show when={day.events[0]}>
                      {(event) => (
                        <span
                          class="k2b-calendar-year__indicator"
                          data-color={event().colorHex ? undefined : (event().color ?? "blue")}
                          data-today={day.isToday ? "true" : undefined}
                          style={event().colorHex ? { "background-color": day.isToday ? "white" : event().colorHex } : undefined}
                        />
                      )}
                    </Show>
                  </CalendarNavigationLink>
                )}
              </For>
            </div>
          </div>
        )}
      </For>
    </div>
  );
};

const MobileMonthView = (props: {
  owner: CalendarProps;
  date: Date;
  now: Date;
  selectedDate: Date;
  events: NormalizedEvent[];
  labels: Required<CalendarLabels>;
}): JSX.Element => {
  const dateConfig = createMemo(() => ownerDateConfig(props.owner));
  const selectedDateKey = createMemo(() => calendar.formatDateKey(props.selectedDate, dateConfig()));
  const selectedEvents = createMemo(() => props.events.filter((event) => event.dayKey === selectedDateKey()));
  return (
    <div class="k2b-calendar-mobile-month">
      <MonthView
        owner={{ ...props.owner, withWeekNumbers: false }}
        date={props.date}
        now={props.now}
        events={props.events}
        labels={props.labels}
      />
      <div class="k2b-calendar-mobile-month__agenda">
        <div class="k2b-calendar-mobile-month__title">
          {props.selectedDate.toLocaleDateString(dateConfig().locale ?? "en", {
            weekday: "long",
            month: "long",
            day: "numeric",
            timeZone: dateConfig().timeZone,
          })}
        </div>
        <Show when={selectedEvents().length > 0} fallback={<div class="k2b-calendar-mobile-month__empty">{props.labels.noEvents}</div>}>
          <div class="k2b-calendar-mobile-month__events">
            <For each={selectedEvents()}>
              {(event) => <EventChip event={event} owner={props.owner} href={eventHref(props.owner, event)} />}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};

const CalendarBody = (props: { children: JSX.Element }): JSX.Element => <div class="k2b-calendar-body">{props.children}</div>;

const Calendar = (props: CalendarProps): JSX.Element => {
  // Subviews derive their date config from the owner props, so the inherited
  // render locale is merged here once; an explicit dateConfig.locale wins.
  const localizedConfig = useDateConfigLocale(() => props.dateConfig);
  const owner = mergeProps(props, {
    get dateConfig(): DateContext {
      return localizedConfig();
    },
  });
  const view = () => props.view ?? "month";
  const dateConfig = createMemo(() => ownerDateConfig(owner));
  const safeDate = (value: Date | string) => {
    const parsed = parseDate(value, dateConfig());
    return validDate(parsed) ? parsed : calendar.today(dateConfig());
  };
  const date = createMemo(() => safeDate(props.date));
  const selectedDate = createMemo(() => safeDate(props.selectedDate ?? props.date));
  const [now, setNow] = createSignal(new Date());
  const normalizedEvents = createMemo(() => normalizeEvents(props.events, dateConfig()));
  const mergedLabels = createMemo(() => ({ ...labels, ...props.labels }));
  const days = createMemo(() => {
    if (view() === "day") return [date()];
    return calendar.getWeekDays(date(), dateConfig());
  });
  onMount(() => {
    const updateNow = () => setNow(new Date());
    const interval = window.setInterval(updateNow, 60_000);
    document.addEventListener("visibilitychange", updateNow);
    onCleanup(() => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", updateNow);
    });
  });

  return (
    <section class={`k2b-content-calendar ${props.class ?? ""}`} aria-busy={props.navigationPending ? "true" : undefined}>
      <CalendarHeader date={date()} view={view()} labels={mergedLabels()} owner={owner} />
      {props.toolbarContent}
      <Show
        when={view() !== "month"}
        fallback={
          <CalendarBody>
            <MonthView owner={owner} date={date()} now={now()} events={normalizedEvents()} labels={mergedLabels()} />
          </CalendarBody>
        }
      >
        <Show
          when={view() !== "year"}
          fallback={
            <CalendarBody>
              <YearView owner={owner} date={date()} now={now()} events={normalizedEvents()} />
            </CalendarBody>
          }
        >
          <Show
            when={view() !== "mobile-month"}
            fallback={
              <CalendarBody>
                <MobileMonthView
                  owner={owner}
                  date={date()}
                  now={now()}
                  selectedDate={selectedDate()}
                  events={normalizedEvents()}
                  labels={mergedLabels()}
                />
              </CalendarBody>
            }
          >
            <TimeGridView owner={owner} date={date()} now={now()} events={normalizedEvents()} labels={mergedLabels()} days={days()} />
          </Show>
        </Show>
      </Show>
    </section>
  );
};

export default Calendar;
