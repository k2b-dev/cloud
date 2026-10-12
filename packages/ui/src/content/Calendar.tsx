import { Link, type LinkNavigateEvent } from "@k2b/ssr/nav";
import { dates as calendar, type DateContext } from "@k2b/stdlib";
import type { JSX, ParentProps } from "solid-js";
import { createComputed, createEffect, createMemo, createSignal, For, mergeProps, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { Button } from "../actions/Button";
import type { DropdownAction, DropdownChoice, DropdownItem, DropdownSection } from "../actions/Dropdown";
import { GestureMenu } from "../actions/GestureMenu";
import SegmentedControl from "../actions/SegmentedControl";
import { useDateConfigLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import { CalendarDayView } from "./CalendarDayView";
import { CalendarWeekView } from "./CalendarWeekView";
import { addDayKeys } from "./calendar-days";
import { openCalendarGoTo, openCalendarShortcuts } from "./calendar-dialogs";
import { layoutCalendarIntervals } from "./calendar-event-layout";
import { useCalendarMessages } from "./calendar-messages";
import { fitMonthWeek, layoutMonthWeek, monthLaneCapacity } from "./calendar-month-layout";
import {
  MONTH_ROW_BLOCK,
  MONTH_ROWS_IN_VIEW,
  monthFocusRow,
  monthOfWeek,
  monthRenderWindow,
  monthRevealTop,
  monthRowOf,
  monthTodayDirection,
  monthVisibleRows,
  monthWeekKeys,
} from "./calendar-month-scroll";
import { calendarDayIndexAtPoint, calendarMinuteAtPoint, startCalendarPointerSession } from "./calendar-pointer";
import {
  type CalendarOwner,
  EventChip,
  eventHref,
  followCalendarHref,
  formatTime,
  type NormalizedEvent,
  ownerDateConfig,
  parseDate,
  placeCalendarPopover,
  textWidth,
  validDate,
} from "./calendar-shared";
import { compactGermanDate, reducedMotion, type TimeViewHandle, type TodayDirection } from "./calendar-time-view";

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
  /**
   * Day and week views with `dayHours`: the state of the entry's checkbox, such as a to-do's. Leave it out for entries
   * without one. With `onEventCheck` the reader can change it.
   */
  checked?: boolean;
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
  /** Day and week views: what is left of the event that is running now, such as "27 min left". */
  remaining?: string;
  /** Day and week views: the calendar draws the event's checkbox beside this content, so leave yours out. */
  checkbox?: boolean;
  /**
   * Day and week views with `dayHours`: the event is a band, a deadline, or an all-day entry of a timeline. Render the
   * title in `k2b-calendar-event__title` and the time in `k2b-calendar-event__meta` there, so the views size them.
   */
  timeline?: boolean;
};

/** The days a host loaded events for, from the first day `from` up to `to`, both `YYYY-MM-DD` or dates. */
export type CalendarRange = { from: Date | string; to: Date | string };

/**
 * An action the calendar offers for keyboard shortcuts, the command palette, and its shortcuts dialog. The calendar
 * publishes its own through `onCommandsChange`; the host registers them with its shortcut dispatcher.
 */
export type CalendarCommand = {
  /** Unique on the page, such as `calendar.today`. */
  id: string;
  label: string;
  /** One key combination: a key such as `h`, or modifiers and a key such as `shift+n`. */
  shortcut?: string;
  /** One sentence for the command palette and the help, such as "Show today in the calendar". */
  description?: string;
  icon?: string;
  run: () => void;
};

/** An entry dragged into the day or week view from outside the calendar, such as a task from a list below it. */
export type CalendarExternalDrag = {
  title: string;
  color?: CalendarEventColor;
  colorHex?: string;
  /** The length it gets in the calendar. */
  minutes: number;
};

/** Actions of the calendar that the host starts from its own controls. */
export type CalendarController = {
  /**
   * Opens the quick create at the selection, or where a new entry fits: today at the next full hour while today is
   * shown, else at 09:00 of the first shown day. `create` reaches `renderQuickCreate` as in the month view's menu.
   */
  quickCreate: (create?: string) => void;
  /** The time a new entry takes, by the rule of `quickCreate`; all-day for days selected in the month view. */
  createTarget: () => CalendarEventTimeChange;
  /**
   * Day and week views with `dayHours`: follows a pointer that pressed an entry outside the calendar, shows where it
   * would go and whether it fits the free time there, and calls `onDrop` with the time where it is released. Escape
   * or a release outside the days cancels.
   */
  dragIn: (event: PointerEvent, item: CalendarExternalDrag, onDrop: (slot: CalendarEventTimeChange) => void) => void;
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
  /**
   * Waking hours `[start, end]` of the day and week views, such as `[6, 22]`. With them, a day runs from `start` to
   * `start` of the next day, so the night after `end` belongs to the day before. The day view becomes one stream of
   * days down the page and the week view a strip of days to scroll sideways; nights fold unless an entry lies in them.
   * `startHour`, `endHour`, and the visible hours do not apply then.
   */
  dayHours?: readonly [start: number, end: number];
  /** Loaded days of the continuous month view and the day/week views with `dayHours`, with an exclusive end. */
  range?: CalendarRange;
  /** Called once when the reader nears the first loaded day, again once `range.from` moved. */
  onLoadEarlier?: () => unknown;
  /** Called once when the reader nears the last loaded day, again once `range.to` moved. */
  onLoadLater?: () => unknown;
  /**
   * Scrolling views: the first and last visible day, and the focus date, after positioning and when they change.
   * Day/week views use their first day as focus. Continuous month uses the first selected day inside its focus month,
   * else today when in that month, else its first. Month rows count as visible when more than half is on screen.
   */
  onVisibleDateChange?: (date: Date, last: Date, focus: Date) => void;
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
  /**
   * Changes the checkbox of an entry with `checked`; leave it out when the reader may not change it. The box shows the
   * change at once; a returned promise that rejects puts it back.
   */
  onEventCheck?: (event: CalendarEvent, checked: boolean) => void | Promise<unknown>;
  /** Pointer gesture used for empty slots. Keyboard activation is always immediate. */
  slotActivation?: "single" | "double";
  /**
   * Month view: the selected days changed. `null` when no day is selected, for example after paging to another month
   * or switching to another view.
   */
  onSelectionChange?: (range: CalendarEventTimeChange | null) => void;
  /**
   * Month view: the application's entries of the menu that a right-click, Shift+F10, or a long press opens on a day or
   * on the selected days. The calendar heads them with the days and adds Open day, Open week, and Clear selection;
   * without this prop the menu has only those. `quickCreate` opens the quick create at the days, passing `create` on to
   * `renderQuickCreate`.
   */
  selectionMenu?: (range: CalendarEventTimeChange, controls: CalendarSelectionControls) => readonly DropdownItem[];
  /**
   * Month view: the content of the quick create at the selected days. It opens quietly after a click, keeping the
   * focus in the grid until the person types or tabs into it (Space still lists the day), and with the focus after a
   * drag, a double-click, Enter, N, or `quickCreate`.
   */
  renderQuickCreate?: (range: CalendarEventTimeChange, controls: CalendarQuickCreateControls) => JSX.Element;
  toolbarActions?: JSX.Element;
  /** Application controls, such as filters, right after the period title. */
  toolbarContent?: JSX.Element;
  /** The application's own commands, such as New event, listed after the calendar's in its shortcuts dialog. */
  commands?: readonly CalendarCommand[];
  /**
   * Receives the calendar's commands and `commands` whenever they change, to register them with the host's shortcut
   * dispatcher: Today (H), Next (J) and Previous (K), the views (1 to 4), and Go to (G). The calendar then also offers
   * its shortcuts dialog. Without a dispatcher the commands have no keys.
   */
  onCommandsChange?: (commands: readonly CalendarCommand[]) => void;
  /** Receives the calendar's controller once it mounts. */
  controller?: (controller: CalendarController) => void;
  class?: string;
};

export type CalendarSelectionControls = {
  /** Opens the quick create at the days of the menu; `create` names what to create, as the application defines it. */
  quickCreate: (create?: string) => void;
};

export type CalendarQuickCreateControls = {
  /** What the person asked to create through `quickCreate`; absent after a click, a drag, or the keyboard. */
  create?: string;
  /**
   * Closes the quick create, returns the focus to the selected day only while the focus is still in the quick create, and
   * leaves a newer selection in place; once another quick create replaced it, nothing.
   */
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
  /** Handles a plain click in place, such as gliding to a loaded day; `true` keeps the link from navigating. */
  intercept?: () => boolean;
  anchorProps?: Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "children" | "href" | "onClick"> & {
    "data-direction"?: string;
    "data-divider"?: string;
    "data-outside"?: string;
    "data-size"?: string;
    "data-today"?: string;
    "data-variant"?: string;
  };
}>;

const plainClick = (event: MouseEvent) =>
  !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** A real anchor is the baseline; the optional handler only enhances it after hydration. */
const CalendarNavigationLink = (props: CalendarNavigationLinkProps): JSX.Element => {
  const preload = () => props.owner.onPrefetch?.(props.href);
  const intercepted = (event: MouseEvent) => {
    if (!props.intercept || !plainClick(event) || !props.intercept()) return false;
    event.preventDefault();
    return true;
  };
  const navigateHref: JSX.EventHandler<HTMLAnchorElement, MouseEvent> = (event) => {
    if (intercepted(event)) return;
    const anchor = event.currentTarget;
    if (
      !plainClick(event) ||
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
      onClick={(event) => void intercepted(event)}
      onPointerEnter={preload}
      onFocus={preload}
    >
      {props.children}
    </Link>
  ) : (
    <a {...props.anchorProps} href={props.href} onClick={(event) => void intercepted(event)} onPointerEnter={preload} onFocus={preload}>
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
  const calendarMessages = useCalendarMessages();
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
      aria-label={calendarMessages().calendarView}
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

/**
 * The same day some months later, or the last day of that month when it is shorter: a step from January 31 lands on
 * February 28, never in March. stdlib's `addMonths` runs over into the next month.
 */
const addMonthsClamped = (date: Date, months: number, dateConfig: DateContext): Date => {
  const moved = calendar.addMonths(date, months, dateConfig);
  if (calendar.formatDateKey(moved, dateConfig).slice(8) === calendar.formatDateKey(date, dateConfig).slice(8)) return moved;
  return calendar.addDays(calendar.startOfMonth(moved, dateConfig), -1, dateConfig);
};

/** Custom views page by day, like the day view. */
const adjacentCalendarDate = (date: Date, view: string, direction: -1 | 1, dateConfig: DateContext) => {
  if (view === "year") return addMonthsClamped(date, direction * 12, dateConfig);
  if (view === "month" || view === "mobile-month") return addMonthsClamped(date, direction, dateConfig);
  return calendar.addDays(date, direction * (view === "week" ? 7 : 1), dateConfig);
};

/** Opens a view at a day through the host's callbacks. Hosts may keep the view and the date apart, so both hear it. */
const openViewAt = <V extends string>(
  owner: Pick<CalendarProps<V>, "onViewChange" | "onDateChange">,
  date: Date,
  view: CalendarView | V,
) => {
  owner.onViewChange?.(view);
  owner.onDateChange?.(date, view);
};

/** What the header reads from the active view beyond the props: the days a day or week view shows, and its moves. */
type CalendarHeaderNav = {
  /** The day or week view with `dayHours`, which scrolls through its days by itself. */
  timeView: () => TimeViewHandle | null;
  monthView: () => MonthHandle | null;
  /** The commands of the shortcuts dialog; without them the header shows no shortcuts button. */
  commands: () => readonly CalendarCommand[];
  openShortcuts: () => void;
};

const dayTitleOptions: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric" };
const weekTitleOptions: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };

/** Where today lies from the shown day or week before its view measured: the arrow of the Today button, or nothing. */
const todayDirectionOf = (view: string, date: Date, context: DateContext): TodayDirection => {
  const today = calendar.formatDateKey(new Date(), context);
  if (view === "week") {
    const start = calendar.formatDateKey(calendar.startOfWeek(date, context), context);
    const end = calendar.formatDateKey(calendar.addDays(calendar.startOfWeek(date, context), 6, context), context);
    return today < start ? "left" : today > end ? "right" : "";
  }
  const shown = calendar.formatDateKey(date, context);
  return today < shown ? "up" : today > shown ? "down" : "";
};

const CalendarHeader = <V extends string>(props: {
  date: Date;
  view: CalendarView | V;
  labels: Required<CalendarLabels>;
  owner: CalendarProps<V>;
  focusDay?: Date | null;
  nav: CalendarHeaderNav;
}): JSX.Element => {
  const calendarMessages = useCalendarMessages();
  const dateConfig = () => ownerDateConfig(props.owner);
  const timeView = () => props.nav.timeView();
  const monthView = () => props.nav.monthView();
  const scrollingView = () => timeView() ?? monthView();
  const parseKey = (key: string) => calendar.parseCalendarDate(key, dateConfig());
  /** The date the header pages from: the first day a day or week view shows, else the date. */
  const base = () => {
    const shown = timeView()?.visibleKeys().first;
    return shown ? parseKey(shown) : (monthView()?.stepFrom() ?? props.date);
  };
  const previous = () => adjacentCalendarDate(base(), props.view, -1, dateConfig());
  const next = () => adjacentCalendarDate(base(), props.view, 1, dateConfig());
  /** The day view's title, such as "Fri, Oct 9, 2026" or "Fr, 9. Okt 2026". */
  const formatDayTitle = (date: Date) =>
    compactGermanDate(
      new Intl.DateTimeFormat(dateConfig().locale ?? "en", { ...dayTitleOptions, timeZone: dateConfig().timeZone }).format(date),
      dateConfig().locale,
      true,
    );
  const formatRange = (from: Date, to: Date) =>
    compactGermanDate(
      new Intl.DateTimeFormat(dateConfig().locale ?? "en", { ...weekTitleOptions, timeZone: dateConfig().timeZone }).formatRange(from, to),
      dateConfig().locale,
    );
  /** The day and week views with `dayHours` name the days they show, also on the server before they measured. */
  const timeMode = () => Boolean(props.owner.dayHours) && (props.view === "day" || props.view === "week");
  const title = () => {
    const shown = timeView()?.visibleKeys();
    if (timeMode() && props.view === "day") return formatDayTitle(shown ? parseKey(shown.first) : props.date);
    if (timeMode()) {
      const start = shown ? parseKey(shown.first) : calendar.startOfWeek(props.date, dateConfig());
      return formatRange(start, shown ? parseKey(shown.last) : calendar.addDays(start, 6, dateConfig()));
    }
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
    return formatMonth(monthView()?.focusMonth() ?? props.date, dateConfig());
  };
  /**
   * The titles this view can show around the current date: the months of the year, the weeks of the month and across
   * each month boundary, or a day of each weekday in every month. Their widest one sets the title's width.
   */
  const titleWidths = createMemo(() => {
    const context = dateConfig();
    if (props.view === "year") return [];
    const { year } = zonedYearMonth(props.date, context);
    if (props.view === "month" || props.view === "mobile-month")
      return Array.from({ length: 12 }, (_, month) => formatMonth(zonedMonthDate(year, month, context), context));
    if (props.view === "week") {
      const first = calendar.startOfWeek(calendar.startOfMonth(props.date, context), context);
      const weeks = Array.from({ length: 6 }, (_, week) => {
        const start = calendar.addDays(first, week * 7, context);
        if (timeMode()) return formatRange(start, calendar.addDays(start, 6, context));
        return `${formatDay(start, context)} - ${formatDay(calendar.addDays(start, 6, context), context)}`;
      });
      if (timeMode()) {
        return [
          ...weeks,
          ...Array.from({ length: 12 }, (_, month) => {
            const day28 = calendar.addDays(zonedMonthDate(year, month, context), 27, context);
            return formatRange(day28, calendar.addDays(day28, 6, context));
          }),
        ];
      }
      return weeks;
    }
    return Array.from({ length: 12 }, (_, month) => month).flatMap((month) => {
      const first = zonedMonthDate(year, month, context);
      return Array.from({ length: 7 }, (_, offset) =>
        timeMode()
          ? formatDayTitle(calendar.addDays(first, 21 + offset, context))
          : calendar.addDays(first, 21 + offset, context).toLocaleDateString(context.locale ?? "en", {
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
    // Like the switcher's links, the other views open at the day selected in the month view.
    const day = props.focusDay;
    if (day && props.owner.onDateChange && view !== props.view) {
      openViewAt(props.owner, day, view);
      return;
    }
    if (props.owner.onViewChange) {
      props.owner.onViewChange(view);
      return;
    }
    const href = props.owner.getViewHref?.(view);
    if (href) window.location.href = href;
  };
  const navButton = (date: Date, icon: string, label: string, direction: -1 | 1) => {
    const href = props.owner.getDateHref?.(date, props.view);
    const step = () => scrollingView()?.step(direction) ?? false;
    const title = props.nav.commands().length > 0 ? `${label} (${direction > 0 ? "J" : "K"})` : label;
    return (props.owner.onNavigateHref || props.owner.onNavigate) && href ? (
      <CalendarNavigationLink
        owner={props.owner}
        href={href}
        intercept={step}
        anchorProps={{ "aria-label": label, title, class: "k2b-calendar-header__nav-button" }}
      >
        <i class={`ti ${icon}`} />
      </CalendarNavigationLink>
    ) : props.owner.onDateChange ? (
      <button
        type="button"
        aria-label={label}
        title={title}
        class="k2b-calendar-header__nav-button"
        onClick={() => {
          if (!step()) goDate(date);
        }}
      >
        <i class={`ti ${icon}`} />
      </button>
    ) : (
      <CalendarNavigationLink
        owner={props.owner}
        href={href ?? "#"}
        intercept={step}
        anchorProps={{ "aria-label": label, title, class: "k2b-calendar-header__nav-button" }}
      >
        <i class={`ti ${icon}`} />
      </CalendarNavigationLink>
    );
  };
  /**
   * In the day and week views that scroll through their days, Today points where today lies, or shows a calm dot while
   * it is on screen; the icon keeps its place either way. The other views name their period in the title.
   */
  const direction = () =>
    timeMode() || monthView()
      ? (scrollingView()?.todayDirection() ?? todayDirectionOf(String(props.view), props.date, dateConfig())) || "here"
      : undefined;
  /** One arrow that the stylesheet turns toward today, or the dot while today shows. */
  const todayIcon = () => (
    <Show when={direction()}>
      {(current) => (
        <Show when={current() !== "here"} fallback={<i class="ti ti-point k2b-calendar-header__today-direction" aria-hidden="true" />}>
          <i class="ti ti-arrow-narrow-right k2b-calendar-header__today-direction" aria-hidden="true" />
        </Show>
      )}
    </Show>
  );
  const todayButton = () => {
    const today = calendar.today(dateConfig());
    const href = props.owner.getDateHref?.(today, props.view);
    const intercept = () => scrollingView()?.today() ?? false;
    const title = () => (props.nav.commands().length > 0 ? `${props.labels.today} (H)` : undefined);
    const label = (
      <>
        {todayIcon()}
        <span class="k2b-button__label">{props.labels.today}</span>
      </>
    );
    return (props.owner.onNavigateHref || props.owner.onNavigate) && href ? (
      <CalendarNavigationLink
        owner={props.owner}
        href={href}
        intercept={intercept}
        anchorProps={{
          class: "k2b-button k2b-calendar-header__today",
          "data-size": "sm",
          "data-variant": "input",
          "data-direction": direction(),
          title: title(),
        }}
      >
        {label}
      </CalendarNavigationLink>
    ) : props.owner.onDateChange ? (
      <Button
        type="button"
        variant="input"
        size="sm"
        class="k2b-calendar-header__today"
        data-direction={direction()}
        title={title()}
        onClick={() => {
          if (!intercept()) goDate(today);
        }}
      >
        {todayIcon()}
        {props.labels.today}
      </Button>
    ) : (
      <CalendarNavigationLink
        owner={props.owner}
        href={href ?? "#"}
        intercept={intercept}
        anchorProps={{
          class: "k2b-button k2b-calendar-header__today",
          "data-size": "sm",
          "data-variant": "input",
          "data-direction": direction(),
          title: title(),
        }}
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
        {navButton(previous(), "ti-chevron-left", props.labels.previous, -1)}
        {navButton(next(), "ti-chevron-right", props.labels.next, 1)}
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
              class="k2b-calendar-view-switcher"
              value={() => (props.view === "mobile-month" ? "month" : props.view)}
              onValueChange={goView}
              ariaLabel={calendarMessages().calendarView}
              options={viewOptions()}
            />
          }
        >
          <CalendarViewLinks owner={props.owner} view={props.view} options={viewOptions()} focusDay={props.focusDay} />
        </Show>
        {props.owner.toolbarActions}
        <Show when={props.nav.commands().length > 0}>
          <button
            type="button"
            class="k2b-calendar-header__shortcuts"
            aria-label={calendarMessages().calendarShortcuts}
            title={calendarMessages().calendarShortcuts}
            onClick={() => props.nav.openShortcuts()}
          >
            <i class="ti ti-keyboard" aria-hidden="true" />
          </button>
        </Show>
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
  const calendarMessages = useCalendarMessages();
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
          <div class="k2b-calendar-month__weekday">{calendarMessages().weekShort}</div>
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
                                "aria-label": calendarMessages().openDate({ label: dayLabel }),
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
                        aria-label={calendarMessages().createEventOn({ label: dayLabel })}
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
                              "aria-label": calendarMessages().openDate({ label: dayLabel }),
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
                          {props.events.find((event) => event.id === eventStack().preview!.id)?.title ?? calendarMessages().moveEvent}
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
                          {calendarMessages().calendarMoreEvents({ count: eventStack().hiddenCount })}
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

/** What the calendar's controller and header ask of the month view; the rest serves the month that scrolls. */
type MonthHandle = Pick<CalendarController, "quickCreate" | "createTarget"> & {
  /** The quiet quick create waits for the person to type its title. */
  typing: () => boolean;
  continuous: () => boolean;
  /** The 1st of the month in the middle of the view, which the title names. */
  focusMonth: () => Date;
  /** The 1st of the month the next step goes on from: where quick repeated steps head, else the month in focus. */
  stepFrom: () => Date;
  /** The day the view stands for, as `onVisibleDateChange` reports it as `focus`. */
  focusDay: () => Date;
  step: (direction: -1 | 1) => boolean;
  goTo: (key: string) => boolean;
  today: () => boolean;
  todayDirection: () => TodayDirection;
};

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
  /** Receives what the calendar's controller asks of the month view. */
  register?: (handle: MonthHandle | null) => void;
}): JSX.Element => {
  const calendarMessages = useCalendarMessages();
  const dateConfig = createMemo(() => ownerDateConfig(props.owner));
  const continuous = createMemo(() => Boolean(props.owner.range));
  const [mounted, setMounted] = createSignal(false);
  const hostMonthKey = () => calendar.formatDateKey(calendar.startOfMonth(props.date, dateConfig()), dateConfig());
  const [focusMonthKey, setFocusMonthKey] = createSignal(untrack(hostMonthKey));
  // The shown month and its grid change only with the month, so a refresh of the same month keeps every cell and its
  // focus.
  const month = createMemo(
    () => zonedYearMonth(continuous() ? calendar.parseCalendarDate(focusMonthKey(), dateConfig()) : props.date, dateConfig()),
    undefined,
    {
      equals: (previous, next) => previous.year === next.year && previous.month === next.month,
    },
  );
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
  const [capacities, setCapacities] = createSignal<number[]>([]);
  const [cellWidth, setCellWidth] = createSignal(0);
  const [barFont, setBarFont] = createSignal("");
  const [anchorKey, setAnchorKey] = createSignal<string | null>(null);
  const [focusKey, setFocusKey] = createSignal<string | null>(null);
  const [focusedCellKey, setFocusedCellKey] = createSignal<string | null>(null);
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
  const hostKey = () => calendar.formatDateKey(props.date, dateConfig());
  const loadedRange = createMemo(() => {
    const range = props.owner.range;
    const keyOf = (value: Date | string) => calendar.formatDateKey(parseDate(value, dateConfig()), dateConfig());
    return range ? { first: keyOf(range.from), to: keyOf(range.to) } : { first: hostMonthKey(), to: hostMonthKey() };
  });
  const loadedWeeks = createMemo(() => monthWeekKeys(loadedRange().first, loadedRange().to, dateConfig().firstDayOfWeek ?? 1));
  const loaded = (key: string) => key >= loadedRange().first && key < loadedRange().to;
  // The first paint starts at the month's first week. Mount adds the earlier weeks and positions synchronously.
  const trackWeeks = createMemo(() => {
    const all = loadedWeeks();
    const anchor = monthRowOf(all, hostMonthKey());
    return mounted() || anchor === undefined ? all : all.slice(anchor);
  });
  const [scrollTop, setScrollTop] = createSignal(0);
  const [rowHeight, setRowHeight] = createSignal(80);
  const [viewHeight, setViewHeight] = createSignal(400);
  const [labelShown, setLabelShown] = createSignal(false);
  const [pulseKey, setPulseKey] = createSignal("");
  let scroller: HTMLDivElement | undefined;
  let weekdayElement: HTMLDivElement | undefined;
  let ready = false;
  let positioned = false;
  let silentTop: number | null = null;
  let frame = 0;
  let labelTimer = 0;
  let reportTimer = 0;
  let queueTimer = 0;
  let glideTimer = 0;
  let arrivalTimer = 0;
  let pulseTimer = 0;
  /** The month that quick repeated steps head for; the next step and the arrows' links go on from it. */
  const [queuedMonth, setQueuedMonth] = createSignal<string | null>(null);
  let pendingTarget: string | null = null;
  let glideTarget: { week: string; offset: number; expires: number } | null = null;
  let pulseOnArrival = false;
  let reported = "";
  let reportedFocus = "";
  let askedEarlier = "";
  let askedLater = "";

  const scrollFocusDay = createMemo(() => {
    const first = focusMonthKey();
    const range = selection();
    const selected = range && range.last >= first ? (range.first > first ? range.first : first) : null;
    if (selected?.slice(0, 7) === first.slice(0, 7)) return selected;
    return todayKey().slice(0, 7) === first.slice(0, 7) ? todayKey() : first;
  });
  const visibleRange = createMemo(() => {
    const weeks = trackWeeks();
    const rows = monthVisibleRows(scrollTop(), viewHeight(), rowHeight(), weeks.length);
    const first = weeks[rows.first] ?? focusMonthKey();
    return { first, last: addDayKeys(weeks[Math.max(rows.first, rows.end - 1)] ?? first, 6) };
  });
  const renderWindow = createMemo(
    () =>
      mounted()
        ? monthRenderWindow(scrollTop(), viewHeight(), rowHeight(), trackWeeks().length)
        : { first: 0, end: Math.min(trackWeeks().length, MONTH_ROW_BLOCK * 2) },
    undefined,
    { equals: (left, right) => left.first === right.first && left.end === right.end },
  );
  /** The window's weeks, and those of the focused day, the selection's moving end, and an open popover's day. */
  const renderedWeeks = createMemo(() => {
    const weeks = trackWeeks();
    const window = renderWindow();
    const keys = new Set(weeks.slice(window.first, window.end));
    for (const key of [focusKey(), focusedCellKey(), popover()?.anchor.dataset.calendarDayKey]) {
      const row = key ? monthRowOf(weeks, key) : undefined;
      if (row !== undefined) keys.add(weeks[row]!);
    }
    return [...keys].sort();
  });
  // Rows keep their elements, but the list moves a kept row when the window passes it, and a browser drops the focus
  // from an element that moves. The focused element takes it back once the rows are in place.
  let refocus: Element | null = null;
  createComputed(
    on(
      renderedWeeks,
      () => {
        const active = typeof document === "undefined" ? null : document.activeElement;
        refocus = active && scroller?.contains(active) ? active : null;
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      renderedWeeks,
      () => {
        const element = refocus;
        refocus = null;
        if (element instanceof HTMLElement && element.isConnected && document.activeElement !== element)
          element.focus({ preventScroll: true });
      },
      { defer: true },
    ),
  );
  const placeOfToday = (): TodayDirection => {
    const weeks = trackWeeks();
    const row = monthRowOf(weeks, todayKey());
    return row === undefined
      ? todayKey() < (weeks[0] ?? focusMonthKey())
        ? "up"
        : "down"
      : monthTodayDirection(row, scrollTop(), viewHeight(), rowHeight());
  };
  const measureScroll = () => {
    if (!scroller) return;
    const row = scroller.querySelector<HTMLElement>(".k2b-calendar-month__week");
    const height = row?.getBoundingClientRect().height;
    if (height && height > 0) setRowHeight(height);
    setViewHeight(Math.max(0, scroller.clientHeight - (weekdayElement?.getBoundingClientRect().height ?? 0)));
  };
  const loadMore = (edge: "earlier" | "later") => {
    if (!ready || (edge === "earlier" && glideTarget)) return;
    const range = loadedRange();
    if (edge === "earlier" && props.owner.onLoadEarlier && askedEarlier !== range.first) {
      askedEarlier = range.first;
      void props.owner.onLoadEarlier();
    }
    if (edge === "later" && props.owner.onLoadLater && askedLater !== range.to) {
      askedLater = range.to;
      void props.owner.onLoadLater();
    }
  };
  const reportVisible = () => {
    if (!ready) return;
    const { first, last } = untrack(visibleRange);
    const focus = untrack(scrollFocusDay);
    const value = `${first}/${last}/${focus}`;
    if (reported === value) return;
    reported = value;
    window.clearTimeout(reportTimer);
    reportTimer = window.setTimeout(() => {
      reportedFocus = focus;
      props.owner.onVisibleDateChange?.(parseKey(first), parseKey(last), parseKey(focus));
    }, 250);
  };
  const keepLabel = () => {
    window.clearTimeout(labelTimer);
    labelTimer = window.setTimeout(() => setLabelShown(false), 650);
  };
  const readScroll = (showLabel = true) => {
    if (!scroller) return;
    const top = scroller.scrollTop;
    setScrollTop(top);
    const weeks = trackWeeks();
    const week = weeks[monthFocusRow(top, viewHeight(), rowHeight(), weeks.length)];
    if (week) {
      const next = monthOfWeek(week);
      if (next !== untrack(focusMonthKey)) {
        setFocusMonthKey(next);
        if (showLabel && ready) {
          setLabelShown(true);
          keepLabel();
        }
      }
    }
    reportVisible();
  };
  const pulseToday = () => {
    if (reducedMotion()) return;
    setPulseKey(todayKey());
    window.clearTimeout(pulseTimer);
    pulseTimer = window.setTimeout(() => setPulseKey(""), 1000);
  };
  const finishGlide = () => {
    if (!scroller) return;
    const target = glideTarget;
    const row = target ? monthRowOf(trackWeeks(), target.week) : undefined;
    // A clamped glide may still be waiting for more weeks below; scrollend is not arrival then.
    if (target && row !== undefined && Math.abs(scroller.scrollTop - (row * rowHeight() + target.offset)) > 1) return;
    glideTarget = null;
    setQueuedMonth(null);
    window.clearTimeout(queueTimer);
    window.clearTimeout(glideTimer);
    window.clearTimeout(arrivalTimer);
    readScroll();
    if (pulseOnArrival) {
      pulseOnArrival = false;
      pulseToday();
    }
  };
  const cancelGlide = () => {
    if (!glideTarget || !scroller) return;
    // A reader's wheel or touch takes over from navigation, including any target waiting for more weeks.
    glideTarget = null;
    pulseOnArrival = false;
    setQueuedMonth(null);
    for (const timer of [queueTimer, glideTimer, arrivalTimer]) window.clearTimeout(timer);
    scroller.scrollTo({ top: scroller.scrollTop, behavior: "instant" });
  };
  const issueGlide = (top: number, smooth: boolean) => {
    if (!scroller) return;
    const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const target = Math.max(0, Math.min(top, maximum));
    if (smooth && !reducedMotion() && Math.abs(target - scroller.scrollTop) > viewHeight() * 3) {
      scroller.scrollTop = target - Math.sign(target - scroller.scrollTop) * viewHeight();
      readScroll();
    }
    scroller.scrollTo({ top: target, behavior: smooth && !reducedMotion() ? "smooth" : "instant" });
    if (top > maximum + 1) loadMore("later");
    if (!smooth || reducedMotion()) {
      readScroll();
      finishGlide();
    }
  };
  const glide = (top: number, smooth = true) => {
    if (!scroller) return;
    const row = Math.max(0, Math.min(trackWeeks().length - 1, Math.floor(top / rowHeight())));
    const week = trackWeeks()[row];
    if (!week) return;
    // A target past the loaded weeks waits for them however long they take; the reader's own scrolling ends the wait.
    const waiting = top > scroller.scrollHeight - scroller.clientHeight + 1;
    glideTarget = { week, offset: top - row * rowHeight(), expires: waiting ? Number.POSITIVE_INFINITY : performance.now() + 1600 };
    window.clearTimeout(glideTimer);
    window.clearTimeout(arrivalTimer);
    if (!waiting)
      glideTimer = window.setTimeout(() => {
        glideTarget = null;
        pulseOnArrival = false;
      }, 1600);
    arrivalTimer = window.setTimeout(finishGlide, 900);
    issueGlide(top, smooth);
  };
  const positionMonth = (key: string, smooth = true, reveal = false) => {
    if (!continuous() || !loaded(key) || !scroller) return false;
    const weeks = trackWeeks();
    const first = monthRowOf(weeks, `${key.slice(0, 7)}-01`);
    const row = monthRowOf(weeks, key);
    if (first === undefined || row === undefined) return false;
    const top = first * rowHeight();
    glide(reveal ? (monthRevealTop(row, top, viewHeight(), rowHeight()) ?? top) : top, smooth);
    return true;
  };
  const goToMonth = (key: string) => positionMonth(key, true, true);
  const stepMonth = (direction: -1 | 1) => {
    if (!continuous() || !scroller) return false;
    const target = calendar.formatDateKey(
      calendar.addMonths(parseKey(queuedMonth() ?? focusMonthKey()), direction, dateConfig()),
      dateConfig(),
    );
    if (!positionMonth(target)) return false;
    // Instant positioning may finish during positionMonth; queue afterwards so rapid clicks still accumulate.
    setQueuedMonth(target);
    window.clearTimeout(queueTimer);
    queueTimer = window.setTimeout(() => setQueuedMonth(null), 1200);
    return true;
  };
  const goToday = () => {
    if (!continuous() || !loaded(todayKey()) || !scroller) return false;
    pulseOnArrival = !reducedMotion();
    if (positionMonth(todayKey())) return true;
    pulseOnArrival = false;
    return false;
  };
  const revealDay = (key: string) => {
    const row = monthRowOf(trackWeeks(), key);
    if (row === undefined || !scroller) return;
    const top = monthRevealTop(row, scroller.scrollTop, viewHeight(), rowHeight());
    if (top !== undefined) glide(top);
  };
  const onScroll = () => {
    if (!ready || !scroller) return;
    // Initial positioning and range rebasing are not the reader asking for more weeks.
    if (silentTop !== null && Math.abs(scroller.scrollTop - silentTop) < 1) return;
    silentTop = null;
    if (untrack(labelShown)) keepLabel();
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        readScroll();
        if (!scroller) return;
        if (scroller.scrollTop < MONTH_ROWS_IN_VIEW * rowHeight()) loadMore("earlier");
        if (scroller.scrollTop + viewHeight() > (trackWeeks().length - MONTH_ROWS_IN_VIEW * 2) * rowHeight()) loadMore("later");
      });
  };
  // Capture the old track before render effects change its height, then restore the same week and pixel below.
  let previousWeeks: string[] = [];
  let savedAnchor: { week: string; delta: number } | null = null;
  createComputed(
    on(
      loadedWeeks,
      (weeks) => {
        if (!untrack(mounted) || !scroller) return;
        const top = scroller.scrollTop;
        const row = Math.floor(top / untrack(rowHeight));
        const week = previousWeeks[row];
        savedAnchor = week ? { week, delta: top - row * untrack(rowHeight) } : null;
        const next = week ? monthRowOf(weeks, week) : undefined;
        // Move the render window before DOM updates, so even a larger rebase retains the visible rows' elements.
        if (next !== undefined && savedAnchor) setScrollTop(next * untrack(rowHeight) + savedAnchor.delta);
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      loadedWeeks,
      () => {
        if (!untrack(mounted) || !scroller) return;
        measureScroll();
        previousWeeks = untrack(trackWeeks);
        if (pendingTarget && loaded(pendingTarget)) {
          const key = pendingTarget;
          pendingTarget = null;
          positioned = positionMonth(key, positioned) || positioned;
          if (pendingKey === key) {
            pendingKey = null;
            select(key);
            queueMicrotask(() => focusCell(key));
          }
        } else {
          const row = savedAnchor ? monthRowOf(previousWeeks, savedAnchor.week) : undefined;
          if (row !== undefined && savedAnchor) scroller.scrollTop = row * untrack(rowHeight) + savedAnchor.delta;
          if (glideTarget && performance.now() < glideTarget.expires) {
            const target = monthRowOf(previousWeeks, glideTarget.week);
            if (target !== undefined) issueGlide(target * untrack(rowHeight) + glideTarget.offset, true);
          }
        }
        savedAnchor = null;
        silentTop = scroller.scrollTop;
        readScroll(false);
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      hostKey,
      (key) => {
        if (!continuous() || !untrack(mounted) || !scroller || key === reportedFocus) return;
        pendingTarget = loaded(key) ? null : key;
        if (pendingTarget) return;
        const visible = untrack(visibleRange);
        if (key.slice(0, 7) !== untrack(focusMonthKey).slice(0, 7) || key < visible.first || key > visible.last) positionMonth(key);
        if (pendingKey === key) {
          pendingKey = null;
          select(key);
          queueMicrotask(() => focusCell(key));
        }
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      scrollFocusDay,
      () => {
        if (continuous()) reportVisible();
      },
      { defer: true },
    ),
  );
  // The scrolling starts once the grid is on the page, also when a host passes `range` only later.
  createEffect(
    on(continuous, (active) => {
      if (!active || !scroller) return;
      setMounted(true);
      measureScroll();
      previousWeeks = trackWeeks();
      const row = monthRowOf(previousWeeks, hostMonthKey());
      if (row !== undefined && loaded(hostKey())) scroller.scrollTop = row * rowHeight();
      // Too few weeks below the month, such as the days of another view while the month's own load, cannot put its
      // first week on top yet; the month goes there once its weeks arrive.
      positioned = row !== undefined && Math.abs(scroller.scrollTop - row * rowHeight()) < 1;
      if (!positioned) pendingTarget = hostKey();
      readScroll(false);
      silentTop = scroller.scrollTop;
      ready = true;
      reportVisible();
      scroller.addEventListener("scrollend", finishGlide);
      const resize =
        typeof ResizeObserver === "undefined"
          ? undefined
          : new ResizeObserver(() => {
              if (!scroller) return;
              const height = untrack(rowHeight);
              const position = scroller.scrollTop / height;
              measureScroll();
              if (height !== untrack(rowHeight)) {
                scroller.scrollTop = position * untrack(rowHeight);
                if (glideTarget) {
                  const target = monthRowOf(untrack(trackWeeks), glideTarget.week);
                  if (target !== undefined) issueGlide(target * untrack(rowHeight) + glideTarget.offset, true);
                }
                silentTop = scroller.scrollTop;
              }
              readScroll(false);
            });
      resize?.observe(scroller);
      const element = scroller;
      onCleanup(() => {
        resize?.disconnect();
        element.removeEventListener("scrollend", finishGlide);
        for (const timer of [labelTimer, reportTimer, queueTimer, glideTimer, arrivalTimer, pulseTimer]) window.clearTimeout(timer);
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        ready = false;
        setMounted(false);
      });
    }),
  );

  const visibleKeys = createMemo(() =>
    continuous()
      ? renderedWeeks().flatMap((key) => Array.from({ length: 7 }, (_, day) => addDayKeys(key, day)))
      : weeks().flatMap((week) => week.map((entry) => entry.key)),
  );
  const rovingKey = createMemo(() => {
    const keys = visibleKeys();
    const focus = focusKey() ?? (continuous() ? focusedCellKey() : null);
    if (focus && keys.includes(focus)) return focus;
    if (keys.includes(todayKey()) && (!continuous() || (todayKey() >= visibleRange().first && todayKey() <= visibleRange().last)))
      return todayKey();
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
  // Selection survives scrolling; only paging starts a month without it. Switching views clears the host's selection.
  createEffect(on(selection, (range) => props.owner.onSelectionChange?.(range ? rangeOf(range) : null), { defer: true }));
  onCleanup(() => {
    if (untrack(selection)) props.owner.onSelectionChange?.(null);
  });
  createEffect(on(selection, (range) => props.onFocusDay?.(range ? parseKey(range.first) : null)));
  createEffect(
    on(
      month,
      () => {
        if (continuous()) return;
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
    return calendarMessages().calendarEventTime({
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
    return calendarMessages().calendarSelectedDays({ start: shortDayLabel(range.first), end: shortDayLabel(range.last), count: days });
  };
  const viewAvailable = (view: CalendarView) => !props.owner.views || props.owner.views.includes(view);
  const viewHref = (key: string, view: CalendarView) => (viewAvailable(view) ? props.owner.getDateHref?.(parseKey(key), view) : undefined);
  /** Whether the calendar can open another view at a day: through a link, or through the host's date change. */
  const canOpenView = (view: CalendarView) => viewAvailable(view) && Boolean(props.owner.getDateHref || props.owner.onDateChange);
  const openView = (key: string, view: CalendarView) => {
    const href = viewHref(key, view);
    if (href) followCalendarHref(props.owner, href);
    else openViewAt(props.owner, parseKey(key), view);
  };
  /** The calendar's own entries of the day menu, Open day and Open week, need no application entries. */
  const hasMenu = () => Boolean(props.owner.selectionMenu) || canOpenView("day") || canOpenView("week");

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
  /** Whether the focus is in the popover, or fell to the page as it hid: only then does a close return it. */
  const focusInPopover = () => popoverElement?.contains(document.activeElement) || document.activeElement === document.body;
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
  /**
   * The day to create on without a selection. The month that scrolls takes the day it stands for, today or the 1st of
   * the month in focus, never a day the keyboard last visited in another month.
   */
  const unselectedKey = () => (continuous() ? scrollFocusDay() : rovingKey());
  /** Enter, a double-click, and N create on the selection, with the quick create or the host's own create action. */
  const createOnSelection = () => {
    const range = selection();
    if (!range) return;
    if (openCreate(range, { active: true })) return;
    if (props.owner.onSlotActivate) props.owner.onSlotActivate(rangeOf(range));
  };
  onMount(() =>
    props.register?.({
      quickCreate: (create) => {
        const range = selection() ?? { first: unselectedKey(), last: unselectedKey() };
        select(range.first, range.last);
        if (!openCreate(range, { active: true, create })) props.owner.onSlotActivate?.(rangeOf(range));
      },
      createTarget: () => rangeOf(selection() ?? { first: unselectedKey(), last: unselectedKey() }),
      typing: () => popover()?.kind === "create" && !createActive(),
      continuous,
      focusMonth: () => parseKey(focusMonthKey()),
      stepFrom: () => parseKey(queuedMonth() ?? focusMonthKey()),
      focusDay: () => parseKey(scrollFocusDay()),
      step: stepMonth,
      goTo: goToMonth,
      today: goToday,
      todayDirection: placeOfToday,
    }),
  );
  onCleanup(() => props.register?.(null));
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
    const href = props.owner.getDateHref?.(date, "month");
    // Only a month that is on its way may select the day, so a host that cannot page never leaves one behind.
    if (props.owner.onDateChange) {
      pendingKey = target;
      props.owner.onDateChange(date, "month");
    } else if (href) {
      pendingKey = target;
      followCalendarHref(props.owner, href);
    }
  };
  const moveFocus = (key: string, extend: boolean) => {
    if (continuous() ? !loaded(key) : !visibleKeys().includes(key)) {
      pageTo(key);
      return;
    }
    if (extend) select(anchorKey() ?? focusKey() ?? key, key);
    else select(key);
    if (continuous()) {
      revealDay(key);
      queueMicrotask(() => focusCell(key));
    } else focusCell(key);
    followSelection();
  };
  const onCellKeyDown = (event: KeyboardEvent, key: string) => {
    if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return;
    const current = popover();
    const quiet = current?.kind === "create" && !createActive();
    // The quiet quick create takes over once the person types or tabs into it. Space stays the grid's key for the day
    // list; N is a title's first letter like any other, as the quick create it would open is already there.
    if (quiet && ((event.key === "Tab" && !event.shiftKey) || (PRINTABLE_KEY.test(event.key) && event.key !== " "))) {
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
      const target = calendar.formatDateKey(addMonthsClamped(day, event.key === "PageUp" ? -1 : 1, dateConfig()), dateConfig());
      if (continuous() && loaded(target)) {
        moveFocus(target, event.shiftKey);
        // The month's first week goes on top, unless the day lies in a sixth week that would then stay out of view.
        goToMonth(target);
      } else pageTo(target);
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
    if (hasMenu() && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
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
  /** The day under the pointer: a bar that spans several days sits in the cell of its first day. */
  const pressedKey = (event: MouseEvent, key: string) => dayKeyAtPoint(event.clientX, event.clientY) ?? key;
  const onCellPointerDown = (event: PointerEvent, key: string) => {
    lastPointer = event.pointerType;
    // The menu acts on the pressed day, or on the selection when the press is inside it.
    menuKey = pressedKey(event, key);
    if (event.pointerType !== "mouse" || event.button !== 0 || event.shiftKey || fromControl(event)) return;
    cancelInteraction?.();
    cancelInteraction = startCalendarPointerSession({
      event,
      scrollContainer: continuous() ? scroller : undefined,
      // A drag along the last row on screen selects its days; the view scrolls once the pointer came from inside.
      armAutoScroll: true,
      resolve: (clientX, clientY) => dayKeyAtPoint(clientX, clientY),
      onActivate: () => {
        suppressClickUntil = performance.now() + 400;
        closePopover(false);
        select(key);
      },
      onPreview: (current) => select(key, current),
      onCommit: (current) => {
        // The click that ends a long drag, such as one that scrolled the view, must not select the pressed day again.
        suppressClickUntil = performance.now() + 400;
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
    if (!hasMenu()) return [];
    const range = selection() ?? { first: unselectedKey(), last: unselectedKey() };
    const own =
      props.owner.selectionMenu?.(rangeOf(range), {
        quickCreate: (create) => {
          select(range.first, range.last);
          if (!openCreate(range, { active: true, create })) props.owner.onSlotActivate?.(rangeOf(range));
        },
      }) ?? [];
    const actions = own.filter((item): item is DropdownAction | DropdownChoice => !("items" in item));
    const sections = own.filter((item): item is DropdownSection => "items" in item);
    const navigation: DropdownAction[] = [
      ...(canOpenView("day")
        ? [{ label: calendarMessages().calendarOpenDay, icon: "ti ti-zoom-in", action: () => openView(range.first, "day") }]
        : []),
      ...(canOpenView("week")
        ? [{ label: calendarMessages().calendarOpenWeek, icon: "ti ti-calendar-week", action: () => openView(range.first, "week") }]
        : []),
      ...(range.first !== range.last
        ? [{ label: calendarMessages().calendarClearSelection, icon: "ti ti-x", action: () => select(null) }]
        : []),
    ];
    const groups: DropdownSection[] = [{ items: actions }, ...sections, { items: navigation }].filter(
      (section) => section.items.length > 0,
    );
    // The first group names the days the menu acts on, also when the calendar's own entries are all it has.
    const [first, ...rest] = groups;
    return first && !first.sectionLabel ? [{ ...first, sectionLabel: selectionHeading(range) }, ...rest] : groups;
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
      scrollContainer: continuous() ? scroller : undefined,
      armAutoScroll: true,
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
        // The click that ends a long move, such as one that scrolled the view, must not open the entry.
        markDragged();
        suppressClickUntil = performance.now() + 400;
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

  const weekRow = (week: () => { day: Date; key: string }[], weekIndex: () => number) => {
    const layout = createMemo(() =>
      layoutMonthWeek(
        week().map((entry) => entry.key),
        items().map((item) => ({ item, firstKey: item.firstKey, lastKey: item.lastKey, bar: item.bar })),
      ),
    );
    // The continuous rows are all as high as the first, so they share its measured capacity.
    const capacity = () => capacities()[continuous() ? 0 : weekIndex()] ?? MONTH_DEFAULT_LANES;
    const fit = createMemo(() => fitMonthWeek(layout(), capacity()));
    const weekHref = () => viewHref(week()[0]!.key, "week");
    const weekNumber = () => zonedWeekNumber(week()[0]!.day, dateConfig());
    return (
      <div
        class="k2b-calendar-month__week"
        role="row"
        data-week-key={continuous() ? week()[0]?.key : undefined}
        // Only some weeks render, and not in their order, so each continuous row names its place below the weekdays.
        aria-rowindex={continuous() ? weekIndex() + 2 : undefined}
        style={continuous() ? { "--k2b-calendar-week-index": String(weekIndex()) } : undefined}
        data-week-numbers={props.owner.withWeekNumbers ? "true" : undefined}
      >
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
                    title={calendarMessages().calendarOpenWeekNumber({ week: weekNumber() })}
                    aria-label={calendarMessages().calendarOpenWeekNumber({ week: weekNumber() })}
                    onClick={() => openView(week()[0]!.key, "week")}
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
                    title: calendarMessages().calendarOpenWeekNumber({ week: weekNumber() }),
                    "aria-label": calendarMessages().calendarOpenWeekNumber({ week: weekNumber() }),
                  }}
                >
                  {weekNumber()}
                </CalendarNavigationLink>
              )}
            </Show>
          </div>
        </Show>
        <For each={week()}>
          {({ day, key }, column) => {
            const dayBadge = props.owner.dayBadges?.[key];
            const sameMonth = () => calendar.isSameMonth(day, continuous() ? parseKey(focusMonthKey()) : props.date, dateConfig());
            const label = dayLabel(day);
            const bars = createMemo(() => fit().bars.filter((bar) => bar.startColumn === column()));
            const cell = () => fit().cells[column()] ?? { top: 0, shown: [], hidden: 0 };
            return (
              <div
                ref={(element) => {
                  cells.set(key, element);
                  onCleanup(() => {
                    if (cells.get(key) === element) cells.delete(key);
                  });
                }}
                class="k2b-calendar-month__day"
                role="gridcell"
                tabIndex={rovingKey() === key ? 0 : -1}
                aria-label={label}
                aria-selected={within(selection(), key) ? "true" : "false"}
                aria-current={key === todayKey() ? "date" : undefined}
                data-calendar-day-key={key}
                data-outside={!sameMonth() ? "true" : undefined}
                data-month-first={continuous() && key.endsWith("-01") ? "true" : undefined}
                data-month-top={continuous() && Number(key.slice(8)) <= 7 ? "true" : undefined}
                data-weekend={column() > 4 ? "true" : undefined}
                data-past={key < todayKey() ? "true" : undefined}
                data-selected={selectionPart(key)}
                data-drop-preview={within(dropRange(), key) ? "true" : undefined}
                onClick={(event) => onCellClick(event, key)}
                onDblClick={(event) => onCellDoubleClick(event, key)}
                onPointerDown={(event) => onCellPointerDown(event, key)}
                onContextMenu={(event) => {
                  // The pressed day takes the focus, so closing the menu with Escape returns there.
                  menuKey = pressedKey(event, key);
                  if (hasMenu()) focusCell(menuKey);
                }}
                onKeyDown={(event) => onCellKeyDown(event, key)}
              >
                <div class="k2b-calendar-month__day-header">
                  <span
                    class="k2b-calendar-month__day-number"
                    data-pulse={continuous() && pulseKey() === key ? "true" : undefined}
                    data-today={key === todayKey() ? "true" : undefined}
                    data-outside={!sameMonth() ? "true" : undefined}
                  >
                    {continuous() && key.endsWith("-01")
                      ? shortDayLabel(key).replace(/\.$/, "")
                      : calendar.formatDayNumber(day, dateConfig())}
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
                    if (column() === 0) observeLanes(element, continuous() ? 0 : weekIndex());
                  }}
                >
                  <For each={bars()}>
                    {(bar) => {
                      const span = bar.endColumn - bar.startColumn + 1;
                      const startHint = () => {
                        if (!bar.continuesBefore) return undefined;
                        const hint = calendarMessages().calendarContinuesFrom(hintDate(bar.item.firstKey));
                        return hintFits(bar.item.event.title, hint, span) ? hint : undefined;
                      };
                      const endHint = () => {
                        if (!bar.continuesAfter) return undefined;
                        const hint = calendarMessages().calendarContinuesUntil(hintDate(bar.item.lastKey));
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
                            props.owner.onEventDrop ? (pointerEvent, markDragged) => startMove(pointerEvent, item, markDragged) : undefined
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
                      aria-label={calendarMessages().calendarMoreEventsOn({ count: cell().hidden, label })}
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
                      <span class="k2b-calendar-month__more-long">{calendarMessages().calendarMoreEvents({ count: cell().hidden })}</span>
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
  };

  const weekdayRow = () => (
    <div
      ref={weekdayElement}
      class="k2b-calendar-month__weekdays"
      role="row"
      data-week-numbers={props.owner.withWeekNumbers ? "true" : undefined}
    >
      <Show when={props.owner.withWeekNumbers}>
        <div class="k2b-calendar-month__weekday" role="columnheader">
          {calendarMessages().weekShort}
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
  );

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
      {weekdayRow()}
      <For each={weeks()}>{(week, index) => weekRow(() => week, index)}</For>
    </div>
  );

  const continuousRow = (key: string) => {
    const days = createMemo(() =>
      Array.from({ length: 7 }, (_, offset) => {
        const dayKey = addDayKeys(key, offset);
        return { day: parseKey(dayKey), key: dayKey };
      }),
    );
    return weekRow(days, () => monthRowOf(trackWeeks(), key) ?? 0);
  };
  const continuousGrid = () => (
    <div class="k2b-calendar-month-viewport">
      <div
        ref={scroller}
        class="k2b-calendar-month"
        role="grid"
        aria-label={formatMonth(parseKey(focusMonthKey()), dateConfig())}
        aria-multiselectable="true"
        data-lanes="true"
        data-continuous="true"
        aria-rowcount={trackWeeks().length + 1}
        onScroll={onScroll}
        onWheel={cancelGlide}
        onPointerDown={cancelGlide}
        onFocusIn={(event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          const key = target.closest("[data-calendar-day-key]")?.getAttribute("data-calendar-day-key");
          if (key) setFocusedCellKey(key);
        }}
        style={{ "--k2b-calendar-lane": `${MONTH_LANE_REM}rem`, "--k2b-calendar-lane-gap": `${MONTH_LANE_GAP_REM}rem` }}
      >
        {weekdayRow()}
        <div class="k2b-calendar-month__track" role="rowgroup" style={{ "--k2b-calendar-weeks": String(trackWeeks().length) }}>
          <For each={renderedWeeks()}>{continuousRow}</For>
        </div>
      </div>
      <div class="k2b-calendar-month__scroll-label" aria-hidden="true" data-show={labelShown() ? "true" : "false"}>
        {formatMonth(parseKey(focusMonthKey()), dateConfig())}
      </div>
    </div>
  );

  const dayList = (dayKey: string) => {
    const day = parseKey(dayKey);
    const href = viewHref(dayKey, "day");
    // Read where it renders, so a refresh while the list is open updates it as it does the grid.
    const entries = () => dayEntries(dayKey);
    return (
      <div class="k2b-calendar-day-list">
        <div class="k2b-calendar-day-list__title">{dayLabel(day)}</div>
        <Show
          when={entries().length > 0}
          fallback={<p class="k2b-calendar-day-list__empty">{calendarMessages().calendarNothingPlanned}</p>}
        >
          <ul class="k2b-calendar-day-list__events">
            <For each={entries()}>
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
                  {calendarMessages().calendarOpenDay}
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
                {calendarMessages().calendarOpenDay}
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
              {calendarMessages().calendarNewEvent}
            </Button>
          </Show>
        </div>
      </div>
    );
  };

  const viewGrid = () => (continuous() ? continuousGrid() : grid());
  return (
    <>
      <Show when={hasMenu()} fallback={viewGrid()}>
        <GestureMenu
          items={menuItems()}
          label={calendarMessages().calendarSelectionActions}
          tabIndex={-1}
          onOpen={onMenuOpen}
          class="k2b-calendar-month-menu"
        >
          {viewGrid()}
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
          return calendarMessages().calendarQuickCreate;
        })()}
        data-kind={popover()?.kind}
        data-quiet={popover()?.kind === "create" && !createActive() ? "true" : undefined}
        onFocusIn={() => setCreateActive(true)}
        onToggle={(event) => {
          // A late close of the popover that another opening already replaced keeps the new one. Focus returns to the
          // grid only from inside the popover, never from what a click outside it chose.
          if (event.newState !== "closed" || !popover() || event.currentTarget.matches(":popover-open")) return;
          closePopover(focusInPopover());
        }}
      >
        {/* Keyed: another day or another selection replaces the content while the popover stays open. A late close, such
            as after a slow save, closes only the quick create that asked for it. */}
        <Show when={popover()} keyed>
          {(value) =>
            value.kind === "create"
              ? props.owner.renderQuickCreate?.(rangeOf(value.range), {
                  create: value.create,
                  close: () => {
                    if (popover() === value) closePopover(focusInPopover());
                  },
                })
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
  const calendarMessages = useCalendarMessages();
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
  let daysRow: HTMLDivElement | undefined;
  let allDayRow: HTMLDivElement | undefined;
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
    // The gutter stays in view while the days scroll sideways under it, so the days start one gutter after the grid.
    if (clientX < gutterRect.right) return null;
    const daysLeft = gridRect.left + gutterRect.width;
    const dayIndex = calendarDayIndexAtPoint(clientX, daysLeft, gridRect.right - daysLeft, props.days.length);
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
  // A week shares 36 rem between its days; a single day takes 12 rem per overlapping lane. The 40 rem grid is wider
  // than one or two lanes, so only three or more make the day scroll, and one lane fits beside a tablet drawer.
  const columnTemplate = createMemo(() => {
    let dayMin = "var(--k2b-calendar-day-min)";
    if (isDayView()) {
      const day = props.days[0]!;
      const layouts = timedEventLayouts(eventsByDay().get(calendar.formatDateKey(day, dateConfig()))?.timed ?? []);
      dayMin = `${Math.max(1, ...layouts.map((layout) => layout.lanes)) * 12}rem`;
    }
    return `4rem repeat(${props.days.length}, minmax(${dayMin}, 1fr))`;
  });
  // The hours scroll sideways themselves; the day and all-day rows follow, also when focus scrolls one of them.
  // A row's scroll event from our own write arrives a frame late; echoing it back would undo a smooth scroll or fling.
  const followed = new WeakMap<HTMLElement, number>();
  const followColumns = (source: HTMLElement) => {
    if (followed.get(source) === source.scrollLeft) return;
    followed.delete(source);
    for (const row of [scrollContainer, daysRow, allDayRow]) {
      if (!row || row === source || row.scrollLeft === source.scrollLeft) continue;
      row.scrollLeft = source.scrollLeft;
      followed.set(row, row.scrollLeft);
    }
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
    <div class="k2b-calendar-time-grid" data-view={isDayView() ? "day" : "week"}>
      <div
        ref={daysRow}
        class="k2b-calendar-time-grid__days"
        style={{ "grid-template-columns": columnTemplate() }}
        onScroll={(event) => followColumns(event.currentTarget)}
      >
        <div class="k2b-calendar-time-grid__corner" />
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
          ref={allDayRow}
          class="k2b-calendar-time-grid__all-day"
          onScroll={(event) => followColumns(event.currentTarget)}
          style={{
            "grid-template-columns": columnTemplate(),
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
      <div
        ref={scrollContainer}
        class="k2b-calendar-time-grid__scroll k2b-detail-trail"
        onScroll={(event) => followColumns(event.currentTarget)}
      >
        <div ref={timeGrid} class="k2b-calendar-time-grid__grid" style={{ "grid-template-columns": columnTemplate() }}>
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
                                aria-label={calendarMessages().resizeEvent}
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
                            aria-label={calendarMessages().hiddenOverlappingEvents({ count: overflow.hiddenEvents.length })}
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
  const calendarMessages = useCalendarMessages();
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
    noEvents: calendarMessages().noEvents,
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

  // The day and week views with `dayHours` scroll through their days; the header and the commands ask them first.
  const [timeView, setTimeView] = createSignal<TimeViewHandle | null>(null);
  const [monthCreate, setMonthCreate] = createSignal<MonthHandle | null>(null);
  const monthView = () => (monthCreate()?.continuous() ? monthCreate() : null);
  const scrollingView = () => timeView() ?? monthView();
  const timeMode = () => Boolean(props.dayHours) && (view() === "day" || view() === "week");
  const parseKey = (key: string) => calendar.parseCalendarDate(key, dateConfig());
  /** The first shown day of a day or week view, or the selected day of the month view, for the other views. */
  const shownDay = () => {
    const first = timeView()?.visibleKeys().first;
    if (first) return parseKey(first);
    return view() === "month" ? (focusDay() ?? monthView()?.focusDay() ?? null) : null;
  };
  const go = (target: Date, nextView: CalendarView | V) => {
    const href = props.getDateHref?.(target, nextView);
    if (href) followCalendarHref(owner, href);
    else openViewAt(props, target, nextView);
  };
  const step = (direction: -1 | 1) => {
    if (scrollingView()?.step(direction)) return;
    go(adjacentCalendarDate(monthView()?.stepFrom() ?? shownDay() ?? date(), view(), direction, dateConfig()), view());
  };
  const goToday = () => {
    if (scrollingView()?.today()) return;
    go(calendar.today(dateConfig()), view());
  };
  const goView = (nextView: CalendarView) => {
    const day = shownDay();
    if (day) {
      go(day, nextView);
      return;
    }
    const href = props.getViewHref?.(nextView);
    if (href) followCalendarHref(owner, href);
    else props.onViewChange?.(nextView);
  };
  const goToKey = (key: string) => {
    if (scrollingView()?.goTo(key)) return;
    go(parseKey(key), view());
  };
  const openGoTo = () =>
    void openCalendarGoTo({
      messages: calendarMessages(),
      today: calendar.formatDateKey(new Date(), dateConfig()),
      describe: (key) =>
        parseKey(key).toLocaleDateString(dateConfig().locale ?? "en", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: dateConfig().timeZone,
        }),
      onGo: goToKey,
    });
  const ownCommands = createMemo((): CalendarCommand[] => {
    const text = calendarMessages();
    const available = (["day", "week", "month", "year"] as const).filter((option) => !props.views || props.views.includes(option));
    const viewLabels = { day: mergedLabels().day, week: mergedLabels().week, month: mergedLabels().month, year: mergedLabels().year };
    return [
      {
        id: "calendar.today",
        label: text.calendarCommandToday,
        description: text.calendarCommandTodayDescription,
        shortcut: "h",
        icon: "ti ti-calendar-event",
        run: goToday,
      },
      {
        id: "calendar.next",
        label: text.calendarCommandNext,
        description: text.calendarCommandNextDescription,
        shortcut: "j",
        icon: "ti ti-chevron-right",
        run: () => step(1),
      },
      {
        id: "calendar.previous",
        label: text.calendarCommandPrevious,
        description: text.calendarCommandPreviousDescription,
        shortcut: "k",
        icon: "ti ti-chevron-left",
        run: () => step(-1),
      },
      ...available.map((option, index) => ({
        id: `calendar.view.${option}`,
        label: text.calendarCommandView({ view: viewLabels[option] }),
        description: text.calendarCommandViewDescription({ view: viewLabels[option] }),
        shortcut: String(index + 1),
        icon: "ti ti-layout-columns",
        run: () => goView(option),
      })),
      {
        id: "calendar.goto",
        label: text.calendarCommandGoTo,
        description: text.calendarCommandGoToDescription,
        shortcut: "g",
        icon: "ti ti-calendar-search",
        run: openGoTo,
      },
    ];
  });
  const allCommands = createMemo(() => [...ownCommands(), ...(props.commands ?? [])]);
  /** While the month's quiet quick create waits for typing, a single key is the first letter of a title. */
  const typing = () => view() === "month" && (monthCreate()?.typing() ?? false);
  createEffect(() => {
    const commands = typing()
      ? allCommands().map((command) => (command.shortcut && singleKey(command.shortcut) ? { ...command, shortcut: undefined } : command))
      : allCommands();
    untrack(() => props.onCommandsChange?.(commands));
  });
  // The arrow keys page like J and K while the keyboard is in the calendar or nowhere, unless something there uses
  // them, such as the grid of the week or the month.
  let root: HTMLElement | undefined;
  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!props.onCommandsChange || custom() || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      const target = event.target;
      const inCalendar = target instanceof Element && Boolean(root?.contains(target));
      if (!inCalendar && target !== document.body && target !== document.documentElement) return;
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox], [popover], [role=dialog]")
      )
        return;
      event.preventDefault();
      step(event.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });
  const headerNav: CalendarHeaderNav = {
    timeView,
    monthView,
    commands: () => (props.onCommandsChange ? allCommands() : []),
    // The arrow keys page like J and K, so the list names them beside those keys.
    openShortcuts: () =>
      void openCalendarShortcuts(
        allCommands(),
        calendarMessages(),
        custom() ? {} : { "calendar.next": "arrowright", "calendar.previous": "arrowleft" },
      ),
  };
  const controller: CalendarController = {
    quickCreate: (create) => {
      const active = timeView();
      if (active) active.controller.quickCreate(create);
      else monthCreate()?.quickCreate(create);
    },
    createTarget: () => {
      const active = timeView()?.controller.createTarget() ?? monthCreate()?.createTarget();
      if (active) return active;
      const start = calendar.today(dateConfig());
      return { start, end: calendar.addDays(start, 1, dateConfig()), allDay: true };
    },
    dragIn: (event, item, onDrop) => timeView()?.controller.dragIn(event, item, onDrop),
  };
  onMount(() => props.controller?.(controller));
  const timeProps = (timeViewName: "day" | "week") => ({
    owner,
    view: timeViewName,
    get date() {
      return date();
    },
    get now() {
      return now();
    },
    get events() {
      return props.events;
    },
    get labels() {
      return mergedLabels();
    },
    get hours() {
      return props.dayHours ?? ([0, 24] as const);
    },
    register: setTimeView,
  });

  return (
    <section ref={root} class={`k2b-content-calendar ${props.class ?? ""}`} aria-busy={props.navigationPending ? "true" : undefined}>
      <CalendarHeader
        date={date()}
        view={view()}
        labels={mergedLabels()}
        owner={owner}
        focusDay={view() === "month" || timeView() ? shownDay() : null}
        nav={headerNav}
      />
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
                register={setMonthCreate}
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
              <Show
                when={timeMode()}
                fallback={
                  <TimeGridView owner={owner} date={date()} now={now()} events={normalizedEvents()} labels={mergedLabels()} days={days()} />
                }
              >
                <Show when={view() === "day"} fallback={<CalendarWeekView {...timeProps("week")} />}>
                  <CalendarDayView {...timeProps("day")} />
                </Show>
              </Show>
            </Show>
          </Show>
        </Show>
      </Show>
    </section>
  );
};

/** A shortcut without Ctrl, Meta, or Mod, which typing would set off. */
const singleKey = (shortcut: string) => !/(^|\+)(ctrl|meta|mod)\+/i.test(shortcut);

/** JSX infers the values of `customViews`; inference from the last signature, as in `createComponent`, sees plain props. */
function Calendar<V extends string = never>(props: CalendarProps<V>): JSX.Element;
function Calendar(props: CalendarProps): JSX.Element;
function Calendar(props: CalendarProps<string>): JSX.Element {
  return CalendarRoot(props);
}

export default Calendar;
