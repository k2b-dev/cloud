import { Link, type LinkNavigateEvent } from "@k2b/ssr/nav";
import { dates as calendar, type DateContext } from "@k2b/stdlib";
import type { JSX, ParentProps } from "solid-js";
import { createEffect, createMemo, createSignal, For, mergeProps, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { Button } from "../actions/Button";
import type { DropdownAction, DropdownChoice, DropdownItem, DropdownSection } from "../actions/Dropdown";
import { GestureMenu } from "../actions/GestureMenu";
import SegmentedControl from "../actions/SegmentedControl";
import { useDateConfigLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import { layoutCalendarIntervals } from "./calendar-event-layout";
import { fitMonthWeek, layoutMonthWeek, monthLaneCapacity } from "./calendar-month-layout";
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
  /**
   * `marker` draws a point in time, such as a deadline, as a colored marker
   * beside its title instead of a filled band.
   */
  display?: "event" | "background" | "marker";
  /**
   * Short text the accessible name adds after the title and time, for state the event shows only visually, such as
   * a priority flag in custom `renderEvent` content.
   */
  accessibleDetail?: string;
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
  /** Month view: the start time to show before the title of a one-day timed entry; absent on bars and elsewhere. */
  leadingTime?: string;
};

/** A view the application adds to the switcher; the calendar shows its header and toolbar, the application the body. */
export type CalendarCustomView<V extends string = string> = {
  value: V;
  label: string;
};

export type CalendarProps<V extends string = never> = {
  date: Date | string;
  events: CalendarEvent[];
  view?: CalendarView | V;
  views?: CalendarView[];
  /** Views after the built-in ones. While one is active, `children` is the body and the header pages by day. */
  customViews?: CalendarCustomView<V>[];
  /** The body of the active custom view. */
  children?: JSX.Element;
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
  // Methods, not function properties: props for custom views stay assignable to the plain props the overloads expose.
  getViewHref?(view: CalendarView | V): string;
  getDateHref?(date: Date, view: CalendarView | V): string;
  getEventHref?: (event: CalendarEvent) => string | undefined;
  renderEvent?: (event: CalendarEvent, context: CalendarEventRenderContext) => JSX.Element;
  /** Progressively enhance canonical calendar links after the app has loaded their target state. */
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
  /** Progressively enhance canonical links without a document view transition. */
  onNavigateHref?: (href: string) => void;
  /** Optionally preload the target behind a canonical calendar link. */
  onPrefetch?: (href: string) => void;
  navigationPending?: boolean;
  onViewChange?(view: CalendarView | V): void;
  onDateChange?(date: Date, view: CalendarView | V): void;
  /** One activation contract for pointer and keyboard input. */
  onEventActivate?: (event: CalendarEvent) => void;
  /** Pointer gesture used for activation. Keyboard activation is always immediate. */
  eventActivation?: "single" | "double";
  onEventDrop?: (event: CalendarEvent, next: CalendarEventTimeChange) => void;
  onEventResize?: (event: CalendarEvent, next: CalendarEventTimeChange) => void;
  onSlotActivate?: (slot: CalendarEventTimeChange) => void;
  /** Pointer gesture used for empty slots. Keyboard activation is always immediate. */
  slotActivation?: "single" | "double";
  /** Month view: the selected days changed. `null` when no day is selected, for example after paging to another month. */
  onSelectionChange?: (range: CalendarEventTimeChange | null) => void;
  /**
   * Month view: the application's entries of the menu that a right-click, Shift+F10, or a long press opens on a day or
   * on the selected days. The calendar heads them with the days and adds Open day, Open week, and Clear selection.
   * `quickCreate` opens the quick create at the days, passing `create` on to `renderQuickCreate`.
   */
  selectionMenu?: (range: CalendarEventTimeChange, controls: CalendarSelectionControls) => readonly DropdownItem[];
  /**
   * Month view: the content of the quick create at the selected days. It opens quietly after a click, keeping the
   * focus in the grid until the person types or tabs into it, and with the focus after a drag, a double-click, Enter,
   * N, or `quickCreate`.
   */
  renderQuickCreate?: (range: CalendarEventTimeChange, controls: CalendarQuickCreateControls) => JSX.Element;
  toolbarActions?: JSX.Element;
  /** Application controls, such as filters, right after the period title. */
  toolbarContent?: JSX.Element;
  class?: string;
};

export type CalendarSelectionControls = {
  /** Opens the quick create at the days of the menu; `create` names what to create, as the application defines it. */
  quickCreate: (create?: string) => void;
};

export type CalendarQuickCreateControls = {
  /** What the person asked to create through `quickCreate`; absent after a click, a drag, or the keyboard. */
  create?: string;
  /** Closes the quick create and returns the focus to the selected day. */
  close: () => void;
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

/** What the built-in views read from the props: they only ever link to built-in views. */
type CalendarOwner = Omit<CalendarProps, "view" | "customViews" | "children">;

const ownerDateConfig = (owner: CalendarOwner): DateContext => ({
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

const eventHref = (props: CalendarOwner, event: CalendarEvent): string | undefined => props.getEventHref?.(event) ?? event.href;

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
  owner: CalendarOwner;
  href?: string;
  compact?: boolean;
  fill?: boolean;
  moving?: boolean;
  /** Replaces the title and time at the start of the accessible name, for example with the dates a long event spans. */
  label?: string;
  /** A bar of a long event that goes on before or after the week row it sits in. */
  continuesBefore?: boolean;
  continuesAfter?: boolean;
  /** Month view: an all-day or multi-day entry drawn as a bar. */
  bar?: boolean;
  /** Short dates at the torn ends of a bar, where it continues in another week row. */
  hintStart?: string;
  hintEnd?: string;
  /** Month view: the start time before the title. */
  leadingTime?: string;
  onMovePointerDown?: (event: PointerEvent, onActivate: () => void) => void;
}): JSX.Element => {
  const messages = useUiMessages();
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
  const ariaLabel = () => {
    const label = props.label
      ? props.label
      : props.event.allDay
        ? props.event.title
        : messages().calendarEventTime({
            title: props.event.title,
            start: formatTime(props.event.startDate, dateConfig()),
            end: formatTime(props.event.endDate, dateConfig()),
          });
    return props.event.accessibleDetail ? `${label}, ${props.event.accessibleDetail}` : label;
  };
  const renderedEvent = () =>
    props.owner.renderEvent?.(props.event, {
      compact: props.compact ?? false,
      fill: props.fill ?? false,
      start: props.event.startDate,
      end: props.event.endDate,
      allDay: props.event.allDay ?? false,
      durationHours: durationHours(),
      timeLabel: timeLabel(),
      leadingTime: props.leadingTime,
    });
  const defaultContent = (
    <>
      <Show when={props.leadingTime}>
        <span class="k2b-calendar-event__time">{props.leadingTime}</span>
      </Show>
      <span class="k2b-calendar-event__title">
        <Show when={props.event.display === "marker"}>
          <span class="k2b-calendar-event__marker" aria-hidden="true" />
        </Show>
        {props.event.title}
      </span>
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
  const content = () => (
    <>
      <Show when={props.hintStart}>
        <span class="k2b-calendar-event__hint" data-edge="start" aria-hidden="true">
          {props.hintStart}
        </span>
      </Show>
      {renderedEvent() ?? defaultContent}
      <Show when={props.hintEnd}>
        <span class="k2b-calendar-event__hint" data-edge="end" aria-hidden="true">
          {props.hintEnd}
        </span>
      </Show>
    </>
  );
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
      data-continues-before={props.continuesBefore ? "true" : undefined}
      data-continues-after={props.continuesAfter ? "true" : undefined}
      data-bar={props.bar ? "true" : undefined}
      data-interactive={isInteractive() ? "true" : undefined}
      data-display={props.event.display}
      data-space-item-id={props.event.dataSpaceItemId}
      style={style()}
      draggable={props.onMovePointerDown ? false : undefined}
      onClick={onClick}
      onDblClick={onDoubleClick}
      onDragStart={props.onMovePointerDown ? (event) => event.preventDefault() : undefined}
      onPointerDown={onPointerDown}
      aria-label={ariaLabel()}
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
      data-continues-before={props.continuesBefore ? "true" : undefined}
      data-continues-after={props.continuesAfter ? "true" : undefined}
      data-bar={props.bar ? "true" : undefined}
      data-interactive="true"
      data-display={props.event.display}
      style={style()}
      onClick={onClick}
      onDblClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onKeyDown={onButtonKeyDown}
      aria-label={ariaLabel()}
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
      data-continues-before={props.continuesBefore ? "true" : undefined}
      data-continues-after={props.continuesAfter ? "true" : undefined}
      data-bar={props.bar ? "true" : undefined}
      data-interactive={undefined}
      data-display={props.event.display}
      style={style()}
      aria-label={ariaLabel()}
    >
      {content()}
    </div>
  );
};

const slotInteractionProps = (
  owner: CalendarOwner,
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
  owner: CalendarOwner;
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

const CalendarViewLinks = <V extends string>(props: {
  owner: CalendarProps<V>;
  view: CalendarView | V;
  options: Array<{ value: CalendarView | V; label: string }>;
  /** The day selected in the month view: the other views open at it. */
  focusDay?: Date | null;
}): JSX.Element => {
  const messages = useUiMessages();
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
      aria-label={messages().calendarView}
      aria-orientation="horizontal"
      class="k2b-segmented-control k2b-calendar-view-switcher"
    >
      <For each={props.options}>
        {(option, index) => {
          const active = () => (props.view === "mobile-month" ? "month" : props.view) === option.value;
          const href = () => {
            const day = props.focusDay;
            const atDay = day && !active() ? props.owner.getDateHref?.(day, option.value) : undefined;
            return atDay ?? props.owner.getViewHref?.(option.value) ?? "#";
          };
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

/** Custom views page by day, like the day view. */
const adjacentCalendarDate = (date: Date, view: string, direction: -1 | 1, dateConfig: DateContext) => {
  if (view === "year") return calendar.addMonths(date, direction * 12, dateConfig);
  if (view === "month" || view === "mobile-month") return calendar.addMonths(date, direction, dateConfig);
  return calendar.addDays(date, direction * (view === "week" ? 7 : 1), dateConfig);
};

const CalendarHeader = <V extends string>(props: {
  date: Date;
  view: CalendarView | V;
  labels: Required<CalendarLabels>;
  owner: CalendarProps<V>;
  focusDay?: Date | null;
}): JSX.Element => {
  const messages = useUiMessages();
  const dateConfig = () => ownerDateConfig(props.owner);
  const previous = () => adjacentCalendarDate(props.date, props.view, -1, dateConfig());
  const next = () => adjacentCalendarDate(props.date, props.view, 1, dateConfig());
  const title = () => {
    if (props.view === "year")
      return new Intl.DateTimeFormat(dateConfig().locale ?? "en", { year: "numeric", timeZone: dateConfig().timeZone }).format(props.date);
    if (props.view !== "week" && props.view !== "month" && props.view !== "mobile-month")
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
  /**
   * The titles this view can show around the current date: the months of the year, the weeks of the month, or a day
   * of each weekday in every month. Their widest one sets the title's width.
   */
  const titleWidths = createMemo(() => {
    const context = dateConfig();
    if (props.view === "year") return [];
    const { year } = zonedYearMonth(props.date, context);
    if (props.view === "month" || props.view === "mobile-month")
      return Array.from({ length: 12 }, (_, month) => formatMonth(zonedMonthDate(year, month, context), context));
    if (props.view === "week") {
      const first = calendar.startOfWeek(calendar.startOfMonth(props.date, context), context);
      return Array.from({ length: 6 }, (_, week) => {
        const start = calendar.addDays(first, week * 7, context);
        return `${formatDay(start, context)} - ${formatDay(calendar.addDays(start, 6, context), context)}`;
      });
    }
    return Array.from({ length: 12 }, (_, month) => month).flatMap((month) => {
      const first = zonedMonthDate(year, month, context);
      return Array.from({ length: 7 }, (_, offset) =>
        calendar.addDays(first, 21 + offset, context).toLocaleDateString(context.locale ?? "en", {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
          timeZone: context.timeZone,
        }),
      );
    });
  });
  const goDate = (date: Date) => props.owner.onDateChange?.(date, props.view);
  const goView = (view: CalendarView | V) => {
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
  const viewOptions = createMemo(
    (): Array<{ value: CalendarView | V; label: string }> => [
      ...(
        [
          { value: "day", label: props.labels.day },
          { value: "week", label: props.labels.week },
          { value: "month", label: props.labels.month },
          { value: "year", label: props.labels.year },
        ] satisfies Array<{ value: CalendarView; label: string }>
      ).filter((option) => !props.owner.views || props.owner.views.includes(option.value)),
      ...(props.owner.customViews ?? []),
    ],
  );

  return (
    <header class="k2b-calendar-header">
      <div class="k2b-calendar-header__navigation">
        {navButton(previous(), "ti-chevron-left", props.labels.previous)}
        {navButton(next(), "ti-chevron-right", props.labels.next)}
        <div class="k2b-calendar-header__title">
          <span>{title()}</span>
          {/* The widest title of the view reserves its width, so paging never moves what follows the title. */}
          <For each={titleWidths()}>
            {(candidate) => (
              <span class="k2b-calendar-header__title-size" aria-hidden="true">
                {candidate}
              </span>
            )}
          </For>
        </div>
      </div>
      <Show when={props.owner.toolbarContent}>
        <div class="k2b-calendar-header__content">{props.owner.toolbarContent}</div>
      </Show>
      <div class="k2b-calendar-header__actions">
        {todayButton()}
        <Show
          when={!props.owner.onViewChange && props.owner.getViewHref}
          fallback={
            <SegmentedControl
              value={() => (props.view === "mobile-month" ? "month" : props.view)}
              onValueChange={goView}
              ariaLabel={messages().calendarView}
              options={viewOptions()}
            />
          }
        >
          <CalendarViewLinks owner={props.owner} view={props.view} options={viewOptions()} focusDay={props.focusDay} />
        </Show>
        {props.owner.toolbarActions}
      </div>
      <Show when={props.owner.navigationPending}>
        <span class="k2b-calendar-header__progress" aria-hidden="true" />
      </Show>
    </header>
  );
};

/** The compact month of `mobile-month`: a picker whose days link to their agenda. */
const MonthPickerView = (props: {
  owner: CalendarOwner;
  date: Date;
  now: Date;
  events: NormalizedEvent[];
  labels: Required<CalendarLabels>;
  compact?: boolean;
}): JSX.Element => {
  const messages = useUiMessages();
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
    <div
      class="k2b-calendar-month"
      // The mobile month is a bounded picker: finger-sized weeks that keep the selected day's agenda close below.
      style={{ "grid-template-rows": `auto repeat(${weeks().length}, ${props.compact ? "minmax(2.75rem, auto)" : "minmax(5rem, 1fr)"})` }}
    >
      <div class="k2b-calendar-month__weekdays" data-week-numbers={props.owner.withWeekNumbers ? "true" : undefined}>
        <Show when={props.owner.withWeekNumbers}>
          <div class="k2b-calendar-month__weekday">{messages().weekShort}</div>
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
                              anchorProps={{
                                class: "k2b-calendar-month__day-target",
                                "aria-label": messages().openDate({ label: dayLabel }),
                              }}
                            />
                          )}
                        </Show>
                      }
                    >
                      <button
                        type="button"
                        class="k2b-calendar-month__day-target"
                        data-interactive="true"
                        aria-label={messages().createEventOn({ label: dayLabel })}
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
                              "aria-label": messages().openDate({ label: dayLabel }),
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
                          {props.events.find((event) => event.id === eventStack().preview!.id)?.title ?? messages().moveEvent}
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
                          {messages().calendarMoreEvents({ count: eventStack().hiddenCount })}
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

/** One entry of the month grid: its whole range, and the days it covers as `YYYY-MM-DD` keys. */
type MonthItem = {
  /** Identifies the entry across the week rows it spans. */
  key: string;
  event: NormalizedEvent;
  firstKey: string;
  lastKey: string;
  /** All-day and multi-day entries are bars; the others stack in their day. */
  bar: boolean;
  /** Pieces of the entry per day, for the day list. */
  days: Map<string, NormalizedEvent>;
};

type MonthSelection = { first: string; last: string };

type MonthPopover =
  | { kind: "day"; dayKey: string; anchor: HTMLElement }
  | { kind: "create"; range: MonthSelection; anchor: HTMLElement; create?: string };

/** Lane height and gap of the month entries, in rem; the stylesheet reads both from the grid's custom properties. */
const MONTH_LANE_REM = 1.25;
const MONTH_LANE_GAP_REM = 0.125;
/** Rows drawn before the browser has measured the cells, as in the server response. */
const MONTH_DEFAULT_LANES = 3;
/** Room a bar keeps beside its title and date hint: padding, torn edge, gap, and an icon such as a task box or a flag. */
const MONTH_HINT_SLACK_REM = 2.25;

const dayKeyNumber = (key: string): number => {
  const [year = "1970", month = "1", day = "1"] = key.split("-");
  return Date.UTC(Number(year), Number(month) - 1, Number(day)) / 86_400_000;
};

const orderedSelection = (anchor: string, focus: string): MonthSelection =>
  anchor <= focus ? { first: anchor, last: focus } : { first: focus, last: anchor };

/** Groups the per-day pieces of the events back into one entry each: bars first, then the others by time. */
const monthItems = (events: NormalizedEvent[]): MonthItem[] => {
  const items = new Map<string, MonthItem>();
  for (const piece of events) {
    const key = `${piece.id}\u0000${piece.sourceStartDate.getTime()}`;
    const item = items.get(key);
    if (item) {
      if (piece.dayKey < item.firstKey) item.firstKey = piece.dayKey;
      if (piece.dayKey > item.lastKey) item.lastKey = piece.dayKey;
      item.days.set(piece.dayKey, piece);
      continue;
    }
    items.set(key, {
      key,
      event: { ...piece, startDate: piece.sourceStartDate, endDate: piece.sourceEndDate },
      firstKey: piece.dayKey,
      lastKey: piece.dayKey,
      bar: false,
      days: new Map([[piece.dayKey, piece]]),
    });
  }
  for (const item of items.values())
    item.bar = item.firstKey !== item.lastKey || Boolean(item.event.allDay && item.event.display !== "marker");
  return [...items.values()].sort(
    (left, right) =>
      Number(right.bar) - Number(left.bar) ||
      left.event.sourceStartDate.getTime() - right.event.sourceStartDate.getTime() ||
      left.event.title.localeCompare(right.event.title),
  );
};

/** Places a calendar popover below its anchor when there is room and above it otherwise, inside the viewport. */
const placeCalendarPopover = (anchor: HTMLElement, popover: HTMLElement): void => {
  const margin = 8;
  const gap = 4;
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(popover.offsetWidth || 288, window.innerWidth - margin * 2);
  const height = popover.offsetHeight;
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
  const roomBelow = window.innerHeight - rect.bottom - gap - margin;
  const above = height > roomBelow && rect.top - gap - margin > roomBelow;
  const top = above ? Math.max(margin, rect.top - height - gap) : Math.min(rect.bottom + gap, window.innerHeight - height - margin);
  popover.style.left = `${left}px`;
  popover.style.top = `${Math.max(margin, top)}px`;
};

let measureContext: CanvasRenderingContext2D | null | undefined;
/** The width of a text in a font, from a canvas, so a bar can tell whether its title leaves room for a date hint. */
const textWidth = (text: string, font: string): number => {
  measureContext ??= typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!measureContext) return Number.POSITIVE_INFINITY;
  measureContext.font = font;
  return measureContext.measureText(text).width;
};

/** Follows a calendar link the way the calendar's own links do: through the host's navigation when it has one. */
const followCalendarHref = (owner: CalendarOwner, href: string): void => {
  if (owner.onNavigateHref) owner.onNavigateHref(href);
  else window.location.assign(href);
};

const PRINTABLE_KEY = /^.$/u;

/**
 * The month grid. A click selects a day and never navigates, a drag or Shift selects a range, and the arrow keys move
 * the selection. The quick create opens at the selection: quietly after a click, with the focus after a drag, a
 * double-click, Enter, or N. Every event is one bar per week row in a lane it keeps on each of its days, and each
 * cell shows as many entries as its height holds.
 */
const MonthView = (props: {
  owner: CalendarOwner;
  date: Date;
  now: Date;
  events: NormalizedEvent[];
  labels: Required<CalendarLabels>;
  /** The first selected day, for the view switcher; `null` without a selection. */
  onFocusDay?: (date: Date | null) => void;
}): JSX.Element => {
  const messages = useUiMessages();
  const dateConfig = createMemo(() => ownerDateConfig(props.owner));
  // The shown month and its grid change only with the month, so a refresh of the same month keeps every cell and its
  // focus.
  const month = createMemo(() => zonedYearMonth(props.date, dateConfig()), undefined, {
    equals: (previous, next) => previous.year === next.year && previous.month === next.month,
  });
  const weeks = createMemo(
    () =>
      calendar
        .getMonthGrid(month().year, month().month, dateConfig())
        .map((week) => week.map((day) => ({ day, key: calendar.formatDateKey(day, dateConfig()) }))),
    undefined,
    { equals: (previous, next) => previous.map((week) => week[0]?.key).join() === next.map((week) => week[0]?.key).join() },
  );
  const weekdays = createMemo(() => calendar.weekdays(dateConfig()));
  const todayKey = createMemo(() => calendar.formatDateKey(props.now, dateConfig()));
  const items = createMemo(() => monthItems(props.events));
  const weekLayouts = createMemo(() =>
    weeks().map((week) =>
      layoutMonthWeek(
        week.map((entry) => entry.key),
        items().map((item) => ({ item, firstKey: item.firstKey, lastKey: item.lastKey, bar: item.bar })),
      ),
    ),
  );
  const [capacities, setCapacities] = createSignal<number[]>([]);
  const [cellWidth, setCellWidth] = createSignal(0);
  const [barFont, setBarFont] = createSignal("");
  const [anchorKey, setAnchorKey] = createSignal<string | null>(null);
  const [focusKey, setFocusKey] = createSignal<string | null>(null);
  const [popover, setPopover] = createSignal<MonthPopover | null>(null);
  /** Whether the quick create holds the focus; until then the grid keeps it. */
  const [createActive, setCreateActive] = createSignal(false);
  const [linkedItem, setLinkedItem] = createSignal("");
  const [movePreview, setMovePreview] = createSignal<CalendarPreview | null>(null);
  const [movingEventId, setMovingEventId] = createSignal("");
  const cells = new Map<string, HTMLElement>();
  let popoverElement: HTMLDivElement | undefined;
  let cancelInteraction: (() => void) | undefined;
  let suppressClickUntil = 0;
  let lastPointer = "mouse";
  let menuKey: string | null = null;
  /** The day to select once paging with Page Up or Page Down has shown its month. */
  let pendingKey: string | null = null;

  const selection = createMemo((): MonthSelection | null => {
    const anchor = anchorKey();
    const focus = focusKey();
    return anchor && focus ? orderedSelection(anchor, focus) : null;
  });
  const parseKey = (key: string) => calendar.parseCalendarDate(key, dateConfig());
  const rangeOf = (range: MonthSelection): CalendarEventTimeChange => ({
    start: parseKey(range.first),
    end: calendar.addDays(parseKey(range.last), 1, dateConfig()),
    allDay: true,
  });
  const visibleKeys = createMemo(() => weeks().flatMap((week) => week.map((entry) => entry.key)));
  const rovingKey = createMemo(() => {
    const keys = visibleKeys();
    const focus = focusKey();
    if (focus && keys.includes(focus)) return focus;
    if (keys.includes(todayKey())) return todayKey();
    return calendar.formatDateKey(zonedMonthDate(month().year, month().month, dateConfig()), dateConfig());
  });
  const dropRange = createMemo((): MonthSelection | null => {
    const preview = movePreview();
    if (!preview) return null;
    const keys = previewSegments(preview, visibleKeys().map(parseKey), dateConfig()).map((piece) => piece.dayKey);
    if (keys.length === 0) return null;
    keys.sort();
    return { first: keys[0]!, last: keys[keys.length - 1]! };
  });
  const within = (range: MonthSelection | null, key: string) => Boolean(range && key >= range.first && key <= range.last);
  /** Where a day sits in the selection: alone, at its start or end, or in between. */
  const selectionPart = (key: string) => {
    const range = selection();
    if (!range || !within(range, key)) return undefined;
    if (range.first === range.last) return "single";
    return key === range.first ? "start" : key === range.last ? "end" : "middle";
  };

  const select = (anchor: string | null, focus: string | null = anchor) => {
    setAnchorKey(anchor);
    setFocusKey(focus);
  };
  // The host learns every change of the selected days, and a new month starts without a selection.
  createEffect(on(selection, (range) => props.owner.onSelectionChange?.(range ? rangeOf(range) : null), { defer: true }));
  createEffect(on(selection, (range) => props.onFocusDay?.(range ? parseKey(range.first) : null)));
  createEffect(
    on(
      month,
      () => {
        setPopover(null);
        const key = pendingKey;
        pendingKey = null;
        if (key && visibleKeys().includes(key)) {
          select(key);
          queueMicrotask(() => focusCell(key));
        } else select(null);
      },
      { defer: true },
    ),
  );

  const dayLabel = (day: Date) =>
    day.toLocaleDateString(dateConfig().locale ?? "en", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: dateConfig().timeZone,
    });
  const shortDayLabel = (key: string, withMonth = true) =>
    parseKey(key).toLocaleDateString(dateConfig().locale ?? "en", {
      day: "numeric",
      ...(withMonth ? { month: "short" } : {}),
      timeZone: dateConfig().timeZone,
    });
  const monthDayLabel = (date: Date, withTime: boolean) =>
    date.toLocaleString(dateConfig().locale ?? "en", {
      month: "long",
      day: "numeric",
      ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
      timeZone: dateConfig().timeZone,
    });
  /** A long event names the days it spans; a one-day event keeps the chip's own title and time. */
  const itemLabel = (item: MonthItem): string | undefined => {
    if (item.firstKey === item.lastKey) return undefined;
    const allDay = Boolean(item.event.allDay);
    return messages().calendarEventTime({
      title: item.event.title,
      start: monthDayLabel(allDay ? parseKey(item.firstKey) : item.event.sourceStartDate, !allDay),
      end: monthDayLabel(allDay ? parseKey(item.lastKey) : item.event.sourceEndDate, !allDay),
    });
  };
  /** The start time before the title of a one-day entry; bars and all-day entries show none. */
  const leadingTime = (item: MonthItem) =>
    item.bar || item.event.allDay ? undefined : formatTime(item.event.sourceStartDate, dateConfig());
  /** The day at a torn end of a bar, with its month when that day lies outside the shown month. */
  const hintDate = (target: string) => ({
    day: Number(target.slice(8, 10)),
    month:
      Number(target.slice(0, 4)) === month().year && Number(target.slice(5, 7)) === month().month + 1
        ? undefined
        : parseKey(target)
            .toLocaleDateString(dateConfig().locale ?? "en", { month: "short", timeZone: dateConfig().timeZone })
            .replace(/\.$/, ""),
  });
  const selectionHeading = (range: MonthSelection) => {
    if (range.first === range.last)
      return parseKey(range.first).toLocaleDateString(dateConfig().locale ?? "en", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: dateConfig().timeZone,
      });
    const days = dayKeyNumber(range.last) - dayKeyNumber(range.first) + 1;
    return messages().calendarSelectedDays({ start: shortDayLabel(range.first), end: shortDayLabel(range.last), count: days });
  };
  const viewAvailable = (view: CalendarView) => !props.owner.views || props.owner.views.includes(view);
  const viewHref = (key: string, view: CalendarView) => (viewAvailable(view) ? props.owner.getDateHref?.(parseKey(key), view) : undefined);
  /** Whether the calendar can open another view at a day: through a link, or through the host's date change. */
  const canOpenView = (view: CalendarView) => viewAvailable(view) && Boolean(props.owner.getDateHref || props.owner.onDateChange);
  const openView = (key: string, view: CalendarView) => {
    const href = viewHref(key, view);
    if (href) followCalendarHref(props.owner, href);
    else props.owner.onDateChange?.(parseKey(key), view);
  };

  /** The day cell under a point, from the cells' boxes: a bar lies over days that are not its parent. */
  const dayKeyAtPoint = (clientX: number, clientY: number): string | null => {
    for (const [key, cell] of cells) {
      if (!cell.isConnected) continue;
      const rect = cell.getBoundingClientRect();
      if (clientX >= rect.left && clientX < rect.right && clientY >= rect.top && clientY < rect.bottom) return key;
    }
    return null;
  };
  const focusCell = (key: string) => cells.get(key)?.focus({ preventScroll: true });
  const closePopover = (restoreFocus = true) => {
    if (!popover()) return;
    setPopover(null);
    setCreateActive(false);
    if (restoreFocus) focusCell(rovingKey());
  };
  const popoverFocusable = () =>
    popoverElement?.querySelector<HTMLElement>("input,textarea,select,button,a[href],[tabindex]:not([tabindex='-1'])") ?? null;

  /**
   * Opens the quick create at the selection. Quietly, it only shows beside the grid, which keeps the focus until the
   * person types or tabs into it; otherwise it takes the focus at once.
   */
  const openCreate = (range: MonthSelection, options: { active: boolean; create?: string }) => {
    if (!props.owner.renderQuickCreate) return false;
    const anchor = cells.get(focusKey() && within(range, focusKey()!) ? focusKey()! : range.last);
    if (!anchor) return false;
    setCreateActive(options.active);
    setPopover({ kind: "create", range, anchor, create: options.create });
    return true;
  };
  const activateCreate = () => {
    if (popover()?.kind !== "create") return false;
    setCreateActive(true);
    popoverFocusable()?.focus();
    return true;
  };
  /** Enter, a double-click, and N create on the selection, with the quick create or the host's own create action. */
  const createOnSelection = () => {
    const range = selection();
    if (!range) return;
    if (openCreate(range, { active: true })) return;
    if (props.owner.onSlotActivate) props.owner.onSlotActivate(rangeOf(range));
  };
  const openDayList = (key: string) => {
    const anchor = cells.get(key);
    if (!anchor) return;
    setCreateActive(true);
    setPopover({ kind: "day", dayKey: key, anchor });
  };
  /** A quiet quick create follows the selection; any other popover closes when the selection changes. */
  const followSelection = () => {
    const current = popover();
    const range = selection();
    if (!current) return;
    if (current.kind === "create" && !createActive() && range) openCreate(range, { active: false });
    else closePopover(false);
  };

  const pageTo = (target: string) => {
    const date = parseKey(target);
    pendingKey = target;
    const href = props.owner.getDateHref?.(date, "month");
    if (props.owner.onDateChange) props.owner.onDateChange(date, "month");
    else if (href) followCalendarHref(props.owner, href);
  };
  const moveFocus = (key: string, extend: boolean) => {
    if (!visibleKeys().includes(key)) {
      pageTo(key);
      return;
    }
    if (extend) select(anchorKey() ?? focusKey() ?? key, key);
    else select(key);
    focusCell(key);
    followSelection();
  };
  const onCellKeyDown = (event: KeyboardEvent, key: string) => {
    if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return;
    const current = popover();
    const quiet = current?.kind === "create" && !createActive();
    // The quiet quick create takes over once the person types or tabs into it.
    if (quiet && ((event.key === "Tab" && !event.shiftKey) || PRINTABLE_KEY.test(event.key))) {
      const field = popoverFocusable();
      if (field) {
        if (event.key === "Tab") event.preventDefault();
        setCreateActive(true);
        field.focus();
        return;
      }
    }
    const day = parseKey(key);
    const shift = (days: number) => calendar.formatDateKey(calendar.addDays(day, days, dateConfig()), dateConfig());
    const weekday = (dayKeyNumber(key) - dayKeyNumber(calendar.formatDateKey(calendar.startOfWeek(day, dateConfig()), dateConfig()))) % 7;
    const target =
      event.key === "ArrowLeft"
        ? shift(-1)
        : event.key === "ArrowRight"
          ? shift(1)
          : event.key === "ArrowUp"
            ? shift(-7)
            : event.key === "ArrowDown"
              ? shift(7)
              : event.key === "Home"
                ? shift(-weekday)
                : event.key === "End"
                  ? shift(6 - weekday)
                  : null;
    if (target) {
      event.preventDefault();
      moveFocus(target, event.shiftKey);
      return;
    }
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      pageTo(calendar.formatDateKey(calendar.addMonths(day, event.key === "PageUp" ? -1 : 1, dateConfig()), dateConfig()));
      return;
    }
    if (event.key === "Enter" || ((event.key === "n" || event.key === "N") && !event.shiftKey)) {
      event.preventDefault();
      if (!within(selection(), key)) select(key);
      createOnSelection();
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      if (!within(selection(), key)) select(key);
      openDayList(key);
      return;
    }
    if (event.key === "Escape") {
      if (current) closePopover(false);
      else if (selection()) select(null);
      else return;
      event.preventDefault();
      return;
    }
    // The keyboard opens the day's menu where the day is, as a right-click there would.
    if (props.owner.selectionMenu && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
      event.preventDefault();
      event.stopPropagation();
      menuKey = key;
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      event.currentTarget?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 12, clientY: rect.top + 12 }),
      );
    }
  };

  const fromControl = (event: Event) =>
    event.target instanceof Element && Boolean(event.target.closest("a,button,[data-calendar-event],.k2b-calendar-month__lanes > *"));
  const onCellClick = (event: MouseEvent, key: string) => {
    if (fromControl(event) || performance.now() < suppressClickUntil) return;
    // A second tap on the one selected day opens the quick create, as a double-click does with a mouse.
    if (lastPointer === "touch") {
      const range = selection();
      if (range && range.first === key && range.last === key && openCreate(range, { active: true })) return;
      select(key);
      closePopover(false);
      return;
    }
    if (event.shiftKey && anchorKey()) select(anchorKey(), key);
    else select(key);
    focusCell(key);
    const range = selection();
    if (range) openCreate(range, { active: false });
  };
  const onCellDoubleClick = (event: MouseEvent, key: string) => {
    if (fromControl(event) || lastPointer === "touch") return;
    event.preventDefault();
    if (!within(selection(), key)) select(key);
    if (popover()?.kind === "create") activateCreate();
    else createOnSelection();
  };
  const onCellPointerDown = (event: PointerEvent, key: string) => {
    lastPointer = event.pointerType;
    // The menu acts on the pressed day, or on the selection when the press is inside it.
    menuKey = key;
    if (event.pointerType !== "mouse" || event.button !== 0 || event.shiftKey || fromControl(event)) return;
    cancelInteraction?.();
    cancelInteraction = startCalendarPointerSession({
      event,
      resolve: (clientX, clientY) => dayKeyAtPoint(clientX, clientY),
      onActivate: () => {
        suppressClickUntil = performance.now() + 400;
        closePopover(false);
        select(key);
      },
      onPreview: (current) => select(key, current),
      onCommit: (current) => {
        select(key, current);
        focusCell(current);
        const range = orderedSelection(key, current);
        openCreate(range, { active: range.first !== range.last });
      },
      onCancel: () => select(key),
    });
  };
  const onMenuOpen = () => {
    closePopover(false);
    const key = menuKey;
    if (key && !within(selection(), key)) select(key);
  };
  // Until a day is selected, the menu acts on the day that takes focus, so it is never empty.
  const menuItems = createMemo((): DropdownItem[] => {
    if (!props.owner.selectionMenu) return [];
    const range = selection() ?? { first: rovingKey(), last: rovingKey() };
    const own = props.owner.selectionMenu(rangeOf(range), {
      quickCreate: (create) => {
        select(range.first, range.last);
        if (!openCreate(range, { active: true, create })) props.owner.onSlotActivate?.(rangeOf(range));
      },
    });
    const actions = own.filter((item): item is DropdownAction | DropdownChoice => !("items" in item));
    const sections = own.filter((item): item is DropdownSection => "items" in item);
    const navigation: DropdownAction[] = [
      ...(canOpenView("day")
        ? [{ label: messages().calendarOpenDay, icon: "ti ti-zoom-in", action: () => openView(range.first, "day") }]
        : []),
      ...(canOpenView("week")
        ? [{ label: messages().calendarOpenWeek, icon: "ti ti-calendar-week", action: () => openView(range.first, "week") }]
        : []),
      ...(range.first !== range.last ? [{ label: messages().calendarClearSelection, icon: "ti ti-x", action: () => select(null) }] : []),
    ];
    return [{ sectionLabel: selectionHeading(range), items: actions }, ...sections, { items: navigation }].filter(
      (section) => section.items.length > 0,
    );
  });

  const clearMove = () => {
    setMovePreview(null);
    setMovingEventId("");
  };
  const startMove = (pointerEvent: PointerEvent, item: MonthItem, markDragged: () => void) => {
    if (!props.owner.onEventDrop) return;
    const event = item.event;
    const grabbed = dayKeyAtPoint(pointerEvent.clientX, pointerEvent.clientY) ?? item.firstKey;
    const firstDay = startOfDay(event.sourceStartDate, dateConfig());
    cancelInteraction?.();
    cancelInteraction = startCalendarPointerSession({
      event: pointerEvent,
      resolve: (clientX, clientY) => {
        const key = dayKeyAtPoint(clientX, clientY);
        if (!key) return null;
        // The event moves by as many days as the pointer, wherever on the bar it was grabbed.
        const day = calendar.addDays(firstDay, dayKeyNumber(key) - dayKeyNumber(grabbed), dateConfig());
        return { id: event.id, title: event.title, ...moveEventToDay(event, day, dateConfig()) };
      },
      onActivate: () => {
        markDragged();
        suppressClickUntil = performance.now() + 400;
        closePopover(false);
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

  // Each week row measures the room below its day numbers; the rows only resize with the grid, never with content.
  let observer: ResizeObserver | undefined;
  const lanesOf = new WeakMap<Element, number>();
  const measure = (element: Element, week: number) => {
    const style = getComputedStyle(element);
    const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const capacity = monthLaneCapacity(element.clientHeight, MONTH_LANE_REM * rootSize, MONTH_LANE_GAP_REM * rootSize);
    setCapacities((current) => {
      if (current[week] === capacity) return current;
      const next = [...current];
      next[week] = capacity;
      return next;
    });
    if (week === 0) {
      setCellWidth(element.clientWidth);
      setBarFont(`600 ${0.6875 * rootSize}px ${style.fontFamily}`);
    }
  };
  const observeLanes = (element: HTMLElement, week: number) => {
    lanesOf.set(element, week);
    if (typeof ResizeObserver === "undefined") return;
    observer ??= new ResizeObserver((entries) => {
      for (const entry of entries) {
        const index = lanesOf.get(entry.target);
        if (index !== undefined) measure(entry.target, index);
      }
    });
    observer.observe(element);
    onCleanup(() => observer?.unobserve(element));
  };
  /** A date hint shows only when the bar holds its title and the hint whole; screen readers get the range anyway. */
  const hintFits = (title: string, hint: string, span: number) => {
    const width = cellWidth();
    const font = barFont();
    if (width <= 0 || !font) return false;
    const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return textWidth(title, font) + textWidth(hint, font) + MONTH_HINT_SLACK_REM * rootSize <= span * width;
  };

  createEffect(() => {
    const current = popover();
    const element = popoverElement;
    if (!element) return;
    if (!current) {
      if (element.matches(":popover-open")) element.hidePopover();
      return;
    }
    if (!element.matches(":popover-open")) element.showPopover();
    const focus = untrack(createActive);
    queueMicrotask(() => {
      if (popover() !== current || !element.isConnected) return;
      placeCalendarPopover(current.anchor, element);
      if (focus) popoverFocusable()?.focus();
    });
  });
  onMount(() => {
    const reposition = () => {
      const current = popover();
      if (current && popoverElement) placeCalendarPopover(current.anchor, popoverElement);
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    onCleanup(() => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    });
  });
  onCleanup(() => {
    cancelInteraction?.();
    observer?.disconnect();
  });

  const dayEntries = (dayKey: string) => items().filter((item) => item.days.has(dayKey));
  /** Every bar of a long entry lights up with the one under the pointer. */
  const linkProps = (item: MonthItem) => ({
    onPointerEnter: (event: PointerEvent) => {
      if (event.pointerType === "mouse") setLinkedItem(item.key);
    },
    onPointerLeave: () => {
      if (linkedItem() === item.key) setLinkedItem("");
    },
  });

  const grid = () => (
    <div
      class="k2b-calendar-month"
      role="grid"
      aria-label={formatMonth(props.date, dateConfig())}
      aria-multiselectable="true"
      data-lanes="true"
      style={{
        "grid-template-rows": `auto repeat(${weeks().length}, minmax(5rem, 1fr))`,
        "--k2b-calendar-lane": `${MONTH_LANE_REM}rem`,
        "--k2b-calendar-lane-gap": `${MONTH_LANE_GAP_REM}rem`,
      }}
    >
      <div class="k2b-calendar-month__weekdays" role="row" data-week-numbers={props.owner.withWeekNumbers ? "true" : undefined}>
        <Show when={props.owner.withWeekNumbers}>
          <div class="k2b-calendar-month__weekday" role="columnheader">
            {messages().weekShort}
          </div>
        </Show>
        <For each={weekdays()}>
          {(day, index) => (
            <div class="k2b-calendar-month__weekday" role="columnheader" data-weekend={index() > 4 ? "true" : undefined}>
              {day}
            </div>
          )}
        </For>
      </div>
      <For each={weeks()}>
        {(week, weekIndex) => {
          const fit = createMemo(() =>
            fitMonthWeek(weekLayouts()[weekIndex()] ?? { bars: [], singles: [] }, capacities()[weekIndex()] ?? MONTH_DEFAULT_LANES),
          );
          const weekHref = () => viewHref(week[0]!.key, "week");
          const weekNumber = () => zonedWeekNumber(week[0]!.day, dateConfig());
          return (
            <div class="k2b-calendar-month__week" role="row" data-week-numbers={props.owner.withWeekNumbers ? "true" : undefined}>
              <Show when={props.owner.withWeekNumbers}>
                <div class="k2b-calendar-month__week-number" role="rowheader">
                  <Show
                    when={weekHref()}
                    fallback={
                      <Show when={canOpenView("week")} fallback={weekNumber()}>
                        <button
                          type="button"
                          class="k2b-calendar-month__week-link"
                          tabIndex={-1}
                          title={messages().calendarOpenWeekNumber({ week: weekNumber() })}
                          aria-label={messages().calendarOpenWeekNumber({ week: weekNumber() })}
                          onClick={() => openView(week[0]!.key, "week")}
                        >
                          {weekNumber()}
                        </button>
                      </Show>
                    }
                  >
                    {(href) => (
                      <CalendarNavigationLink
                        owner={props.owner}
                        href={href()}
                        anchorProps={{
                          class: "k2b-calendar-month__week-link",
                          tabIndex: -1,
                          title: messages().calendarOpenWeekNumber({ week: weekNumber() }),
                          "aria-label": messages().calendarOpenWeekNumber({ week: weekNumber() }),
                        }}
                      >
                        {weekNumber()}
                      </CalendarNavigationLink>
                    )}
                  </Show>
                </div>
              </Show>
              <For each={week}>
                {({ day, key }, column) => {
                  const dayBadge = props.owner.dayBadges?.[key];
                  const sameMonth = calendar.isSameMonth(day, props.date, dateConfig());
                  const label = dayLabel(day);
                  const bars = createMemo(() => fit().bars.filter((bar) => bar.startColumn === column()));
                  const cell = () => fit().cells[column()] ?? { top: 0, shown: [], hidden: 0 };
                  return (
                    <div
                      ref={(element) => cells.set(key, element)}
                      class="k2b-calendar-month__day"
                      role="gridcell"
                      tabIndex={rovingKey() === key ? 0 : -1}
                      aria-label={label}
                      aria-selected={within(selection(), key) ? "true" : "false"}
                      aria-current={key === todayKey() ? "date" : undefined}
                      data-calendar-day-key={key}
                      data-outside={!sameMonth ? "true" : undefined}
                      data-weekend={column() > 4 ? "true" : undefined}
                      data-past={key < todayKey() ? "true" : undefined}
                      data-selected={selectionPart(key)}
                      data-drop-preview={within(dropRange(), key) ? "true" : undefined}
                      onClick={(event) => onCellClick(event, key)}
                      onDblClick={(event) => onCellDoubleClick(event, key)}
                      onPointerDown={(event) => onCellPointerDown(event, key)}
                      onContextMenu={() => {
                        menuKey = key;
                      }}
                      onKeyDown={(event) => onCellKeyDown(event, key)}
                    >
                      <div class="k2b-calendar-month__day-header">
                        <span
                          class="k2b-calendar-month__day-number"
                          data-today={key === todayKey() ? "true" : undefined}
                          data-outside={!sameMonth ? "true" : undefined}
                        >
                          {calendar.formatDayNumber(day, dateConfig())}
                        </span>
                        <Show when={dayBadge}>
                          {(badge) => (
                            <span class="k2b-calendar-month__badge">
                              <Show when={badge().icon}>{(icon) => <i class={`k2b-calendar-month__badge-icon ti ti-${icon()}`} />}</Show>
                              {badge().label}
                            </span>
                          )}
                        </Show>
                      </div>
                      <div
                        class="k2b-calendar-month__lanes"
                        ref={(element) => {
                          if (column() === 0) observeLanes(element, weekIndex());
                        }}
                      >
                        <For each={bars()}>
                          {(bar) => {
                            const span = bar.endColumn - bar.startColumn + 1;
                            const startHint = () => {
                              if (!bar.continuesBefore) return undefined;
                              const hint = messages().calendarContinuesFrom(hintDate(bar.item.firstKey));
                              return hintFits(bar.item.event.title, hint, span) ? hint : undefined;
                            };
                            const endHint = () => {
                              if (!bar.continuesAfter) return undefined;
                              const hint = messages().calendarContinuesUntil(hintDate(bar.item.lastKey));
                              return hintFits(`${bar.item.event.title}${startHint() ?? ""}`, hint, span) ? hint : undefined;
                            };
                            return (
                              <div
                                class="k2b-calendar-month__segment"
                                style={{ "--k2b-calendar-span": String(span), "--k2b-calendar-row": String(bar.lane) }}
                                data-bar="true"
                                data-linked={linkedItem() === bar.item.key && bar.item.firstKey !== bar.item.lastKey ? "true" : undefined}
                                data-continues-before={bar.continuesBefore ? "true" : undefined}
                                data-continues-after={bar.continuesAfter ? "true" : undefined}
                                {...linkProps(bar.item)}
                              >
                                <EventChip
                                  event={bar.item.event}
                                  owner={props.owner}
                                  href={eventHref(props.owner, bar.item.event)}
                                  label={itemLabel(bar.item)}
                                  compact
                                  bar
                                  continuesBefore={bar.continuesBefore}
                                  continuesAfter={bar.continuesAfter}
                                  hintStart={startHint()}
                                  hintEnd={endHint()}
                                  moving={movingEventId() === bar.item.event.id}
                                  onMovePointerDown={
                                    props.owner.onEventDrop
                                      ? (pointerEvent, markDragged) => startMove(pointerEvent, bar.item, markDragged)
                                      : undefined
                                  }
                                />
                              </div>
                            );
                          }}
                        </For>
                        <For each={cell().shown}>
                          {(item, index) => (
                            <div
                              class="k2b-calendar-month__segment"
                              style={{ "--k2b-calendar-span": "1", "--k2b-calendar-row": String(cell().top + index()) }}
                            >
                              <EventChip
                                event={item.event}
                                owner={props.owner}
                                href={eventHref(props.owner, item.event)}
                                compact
                                leadingTime={leadingTime(item)}
                                moving={movingEventId() === item.event.id}
                                onMovePointerDown={
                                  props.owner.onEventDrop
                                    ? (pointerEvent, markDragged) => startMove(pointerEvent, item, markDragged)
                                    : undefined
                                }
                              />
                            </div>
                          )}
                        </For>
                        <Show when={cell().hidden > 0}>
                          <button
                            type="button"
                            class="k2b-calendar-month__more"
                            tabIndex={-1}
                            style={{ "--k2b-calendar-row": String(cell().top + cell().shown.length) }}
                            aria-label={messages().calendarMoreEventsOn({ count: cell().hidden, label })}
                            aria-haspopup="dialog"
                            aria-expanded={(() => {
                              const current = popover();
                              return current?.kind === "day" && current.dayKey === key;
                            })()}
                            onClick={() => {
                              const current = popover();
                              if (current?.kind === "day" && current.dayKey === key) closePopover(false);
                              else openDayList(key);
                            }}
                          >
                            <span class="k2b-calendar-month__more-long">{messages().calendarMoreEvents({ count: cell().hidden })}</span>
                            <span class="k2b-calendar-month__more-short">+{cell().hidden}</span>
                          </button>
                        </Show>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          );
        }}
      </For>
    </div>
  );

  const dayList = (dayKey: string) => {
    const day = parseKey(dayKey);
    const href = viewHref(dayKey, "day");
    const entries = dayEntries(dayKey);
    return (
      <div class="k2b-calendar-day-list">
        <div class="k2b-calendar-day-list__title">{dayLabel(day)}</div>
        <Show when={entries.length > 0} fallback={<p class="k2b-calendar-day-list__empty">{messages().calendarNothingPlanned}</p>}>
          <ul class="k2b-calendar-day-list__events">
            <For each={entries}>
              {(item) => (
                <li>
                  <EventChip
                    event={item.event}
                    owner={props.owner}
                    href={eventHref(props.owner, item.event)}
                    label={itemLabel(item)}
                    compact
                    bar={item.bar}
                    leadingTime={leadingTime(item)}
                  />
                </li>
              )}
            </For>
          </ul>
        </Show>
        <div class="k2b-calendar-day-list__actions">
          <Show
            when={href}
            fallback={
              <Show when={canOpenView("day")}>
                <Button type="button" variant="ghost" size="sm" onClick={() => openView(dayKey, "day")}>
                  <i class="ti ti-zoom-in" aria-hidden="true" />
                  {messages().calendarOpenDay}
                </Button>
              </Show>
            }
          >
            {(dayHref) => (
              <CalendarNavigationLink
                owner={props.owner}
                href={dayHref()}
                anchorProps={{ class: "k2b-button", "data-variant": "ghost", "data-size": "sm" }}
              >
                <i class="ti ti-zoom-in" aria-hidden="true" />
                {messages().calendarOpenDay}
              </CalendarNavigationLink>
            )}
          </Show>
          <Show when={props.owner.renderQuickCreate}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                select(dayKey);
                openCreate({ first: dayKey, last: dayKey }, { active: true });
              }}
            >
              <i class="ti ti-plus" aria-hidden="true" />
              {messages().calendarNewEvent}
            </Button>
          </Show>
        </div>
      </div>
    );
  };

  return (
    <>
      <Show when={props.owner.selectionMenu} fallback={grid()}>
        <GestureMenu
          items={menuItems()}
          label={messages().calendarSelectionActions}
          tabIndex={-1}
          onOpen={onMenuOpen}
          class="k2b-calendar-month-menu"
        >
          {grid()}
        </GestureMenu>
      </Show>
      <div
        ref={popoverElement}
        class="k2b-calendar-popover"
        popover="auto"
        role="dialog"
        aria-label={(() => {
          const current = popover();
          if (current?.kind === "day") return dayLabel(parseKey(current.dayKey));
          return messages().calendarQuickCreate;
        })()}
        data-kind={popover()?.kind}
        data-quiet={popover()?.kind === "create" && !createActive() ? "true" : undefined}
        onFocusIn={() => setCreateActive(true)}
        onToggle={(event) => {
          // A late close of the popover that another opening already replaced keeps the new one. Focus returns to the
          // grid only from inside the popover, never from what a click outside it chose.
          if (event.newState !== "closed" || !popover() || event.currentTarget.matches(":popover-open")) return;
          const inside = event.currentTarget.contains(document.activeElement) || document.activeElement === document.body;
          closePopover(inside);
        }}
      >
        {/* Keyed: another day or another selection replaces the content while the popover stays open. */}
        <Show when={popover()} keyed>
          {(value) =>
            value.kind === "create"
              ? props.owner.renderQuickCreate?.(rangeOf(value.range), { create: value.create, close: () => closePopover() })
              : dayList(value.dayKey)
          }
        </Show>
      </div>
    </>
  );
};

const TimeGridView = (props: {
  owner: CalendarOwner;
  date: Date;
  now: Date;
  events: NormalizedEvent[];
  labels: Required<CalendarLabels>;
  days: Date[];
}): JSX.Element => {
  const messages = useUiMessages();
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
      // Reduced motion jumps to the business hours instead of gliding there, like every transition of the library.
      const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      scrollContainer.scrollTo({ top: Math.max(0, scrollContainer.scrollTop + targetTop), behavior });
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
                                aria-label={messages().resizeEvent}
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
                            aria-label={messages().hiddenOverlappingEvents({ count: overflow.hiddenEvents.length })}
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

const YearView = (props: { owner: CalendarOwner; date: Date; now: Date; events: NormalizedEvent[] }): JSX.Element => {
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
  owner: CalendarOwner;
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
      <MonthPickerView
        owner={{ ...props.owner, withWeekNumbers: false }}
        date={props.date}
        now={props.now}
        events={props.events}
        labels={props.labels}
        compact
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

const CalendarRoot = <V extends string = never>(props: CalendarProps<V>): JSX.Element => {
  const messages = useUiMessages();
  // Subviews derive their date config from the owner props, so the inherited
  // render locale is merged here once; an explicit dateConfig.locale wins.
  const localizedConfig = useDateConfigLocale(() => props.dateConfig);
  const owner = mergeProps(props, {
    get dateConfig(): DateContext {
      return localizedConfig();
    },
  });
  const view = () => props.view ?? "month";
  const custom = () => props.customViews?.some((option) => option.value === view()) ?? false;
  const dateConfig = createMemo(() => ownerDateConfig(owner));
  const safeDate = (value: Date | string) => {
    const parsed = parseDate(value, dateConfig());
    return validDate(parsed) ? parsed : calendar.today(dateConfig());
  };
  const date = createMemo(() => safeDate(props.date));
  const selectedDate = createMemo(() => safeDate(props.selectedDate ?? props.date));
  const [now, setNow] = createSignal(new Date());
  /** The first day selected in the month view, so the view switcher opens the other views at it. */
  const [focusDay, setFocusDay] = createSignal<Date | null>(null);
  const normalizedEvents = createMemo(() => normalizeEvents(props.events, dateConfig()));
  const mergedLabels = createMemo<Required<CalendarLabels>>(() => ({
    today: messages().today,
    day: messages().day,
    week: messages().week,
    month: messages().month,
    year: messages().year,
    allDay: messages().allDay,
    noEvents: messages().noEvents,
    previous: messages().previous,
    next: messages().next,
    ...props.labels,
  }));
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
      <CalendarHeader date={date()} view={view()} labels={mergedLabels()} owner={owner} focusDay={view() === "month" ? focusDay() : null} />
      <Show when={!custom()} fallback={<CalendarBody>{props.children}</CalendarBody>}>
        <Show
          when={view() !== "month"}
          fallback={
            <CalendarBody>
              <MonthView
                owner={owner}
                date={date()}
                now={now()}
                events={normalizedEvents()}
                labels={mergedLabels()}
                onFocusDay={setFocusDay}
              />
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
      </Show>
    </section>
  );
};

/** JSX infers the values of `customViews`; inference from the last signature, as in `createComponent`, sees plain props. */
function Calendar<V extends string = never>(props: CalendarProps<V>): JSX.Element;
function Calendar(props: CalendarProps): JSX.Element;
function Calendar(props: CalendarProps<string>): JSX.Element {
  return CalendarRoot(props);
}

export default Calendar;
