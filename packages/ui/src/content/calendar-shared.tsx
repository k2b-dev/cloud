import { dates as calendar, type DateContext } from "@k2b/stdlib";
import type { JSX } from "solid-js";
import { createMemo, onCleanup, Show } from "solid-js";
import type { CalendarEvent, CalendarProps } from "./Calendar";
import { useCalendarMessages } from "./calendar-messages";

/** One piece of an event in one day, with the times of the whole event. */
export type NormalizedEvent = CalendarEvent & {
  startDate: Date;
  endDate: Date;
  dayKey: string;
  sourceStartDate: Date;
  sourceEndDate: Date;
};

/** A keyboard stop of the week grid. */
export type CalendarStop = { id: string; column: number; minute: number };

/** What the built-in views read from the props: they only ever link to built-in views. */
export type CalendarOwner = Omit<CalendarProps, "view" | "customViews" | "children">;

export const ownerDateConfig = (owner: CalendarOwner): DateContext => ({
  ...owner.dateConfig,
  timeZone: owner.timeZone ?? owner.dateConfig?.timeZone,
  firstDayOfWeek: owner.firstDayOfWeek ?? owner.dateConfig?.firstDayOfWeek ?? owner.dateConfig?.weekStartsOn ?? 1,
});

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;

export const parseDate = (value: Date | string, context?: DateContext): Date => {
  if (value instanceof Date) return new Date(value);
  if (dateOnlyPattern.test(value)) return calendar.parseCalendarDate(value, context);
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const [year, month = "1", day = "1"] = value.split("-");
  return new Date(Number(year), Number(month) - 1, Number(day), 12);
};

export const validDate = (value: Date): boolean => !Number.isNaN(value.getTime());

export const formatTime = (date: Date, context?: DateContext): string => calendar.formatTime(date, context);

export const eventHref = (props: CalendarOwner, event: CalendarEvent): string | undefined => props.getEventHref?.(event) ?? event.href;

/** Places a calendar popover below its anchor when there is room and above it otherwise, inside the viewport. */
export const placeCalendarPopover = (anchor: Element | DOMRect, popover: HTMLElement): void => {
  const margin = 8;
  const gap = 4;
  const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  const width = Math.min(popover.offsetWidth || 288, window.innerWidth - margin * 2);
  const height = popover.offsetHeight;
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
  const roomBelow = window.innerHeight - rect.bottom - gap - margin;
  const above = height > roomBelow && rect.top - gap - margin > roomBelow;
  const top = above ? Math.max(margin, rect.top - height - gap) : Math.min(rect.bottom + gap, window.innerHeight - height - margin);
  popover.style.left = `${left}px`;
  popover.style.top = `${Math.max(margin, top)}px`;
};

/** Follows a calendar link the way the calendar's own links do: through the host's navigation when it has one. */
export const followCalendarHref = (owner: CalendarOwner, href: string): void => {
  if (owner.onNavigateHref) owner.onNavigateHref(href);
  else window.location.assign(href);
};

/** Arms an existing entry or resize grip after a touch hold, leaving swipes to native scrolling. */
export const startCalendarEventGesture = (event: PointerEvent, begin: () => void): (() => void) => {
  if (event.button !== 0 || !event.isPrimary) return () => {};
  if (event.pointerType !== "touch") {
    begin();
    return () => {};
  }
  const target =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-calendar-event], .k2b-calendar-band__grip, .k2b-calendar-time-grid__resize")
      : null;
  let held = false;
  let clickTimer = 0;
  let released = false;
  const preventContextMenu = (next: Event) => next.preventDefault();
  const preventScroll = (next: TouchEvent) => {
    if (held) next.preventDefault();
  };
  const stopClick = (next: Event) => {
    next.preventDefault();
    next.stopPropagation();
    removeClick();
  };
  const removeClick = () => {
    window.clearTimeout(clickTimer);
    window.removeEventListener("click", stopClick, true);
    window.removeEventListener("pointerdown", removeClick, true);
  };
  const cleanup = () => {
    window.clearTimeout(timer);
    window.removeEventListener("pointermove", watch);
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
    window.removeEventListener("blur", finish);
    window.removeEventListener("keydown", escape);
    window.removeEventListener("contextmenu", preventContextMenu, true);
    document.removeEventListener("touchmove", preventScroll);
    if (target) delete target.dataset.touchHeld;
  };
  const finish = () => {
    cleanup();
    if (held) {
      held = false;
      released = true;
      // The host may replace the chip on commit. Swallow its trailing click even then, but never a new tap.
      window.addEventListener("pointerdown", removeClick, true);
      clickTimer = window.setTimeout(removeClick, 400);
    }
  };
  const release = (next: PointerEvent) => {
    if (next.pointerId === event.pointerId) finish();
  };
  const escape = (next: KeyboardEvent) => {
    if (next.key === "Escape") finish();
  };
  const watch = (next: PointerEvent) => {
    if (!held && next.pointerId === event.pointerId && Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) > 10)
      finish();
  };
  const timer = window.setTimeout(() => {
    held = true;
    if (target) target.dataset.touchHeld = "true";
    navigator.vibrate?.(8);
    window.addEventListener("click", stopClick, true);
    begin();
  }, 420);
  window.addEventListener("pointermove", watch);
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  window.addEventListener("blur", finish);
  window.addEventListener("keydown", escape);
  window.addEventListener("contextmenu", preventContextMenu, true);
  document.addEventListener("touchmove", preventScroll, { passive: false });
  return () => {
    cleanup();
    if (!released) removeClick();
  };
};

export const EventChip = (props: {
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
  /** Day and week views: what is left of a running event, such as "27 min left". */
  remaining?: string;
  /** Day and week views: the calendar draws the event's checkbox beside the chip. */
  checkbox?: boolean;
  /** Day and week views with `dayHours`: the chip is a band, a deadline, or an all-day entry of a timeline. */
  timeline?: boolean;
  /** Text after the content, such as the time of a deadline. */
  trailing?: JSX.Element;
  /** Day and week views: the time as they write it, such as "10:30–11:15", shown whatever the length. */
  timeLabel?: string;
  /** Day view: a band tall enough shows its place below the time. */
  showLocation?: boolean;
  /** Week view: the grid's one tab stop decides which chip takes Tab. */
  tabIndex?: number;
  /** A keyboard stop of the week grid: its id, its day column, and its minute for moving between columns. */
  stop?: CalendarStop;
  /** Day and week views: Space on the chip checks the box the calendar draws beside it, as on the box itself. */
  onCheck?: () => void;
  onMovePointerDown?: (event: PointerEvent, onActivate: () => void) => void;
}): JSX.Element => {
  const messages = useCalendarMessages();
  const dateConfig = createMemo(() => ownerDateConfig(props.owner));
  const color = () => props.event.color ?? "blue";
  const selected = () => Boolean(props.owner.selectedEventId) && props.owner.selectedEventId === props.event.id;
  const style = () => (props.event.colorHex ? { "--k2b-calendar-accent": props.event.colorHex } : undefined);
  const isInteractive = () => Boolean(props.owner.onEventActivate);
  const durationHours = () => (props.event.endDate.getTime() - props.event.startDate.getTime()) / 3_600_000;
  const short = () => Boolean(props.fill && !props.event.allDay && durationHours() < 0.75);
  const showTime = () => (props.timeLabel ? !props.event.allDay : !props.event.allDay && !props.compact && durationHours() >= 0.75);
  const showLocation = () =>
    Boolean(props.event.location && (props.showLocation ?? (!props.compact && !props.timeLabel && durationHours() >= 1.25)));
  const showDescription = () =>
    Boolean(
      props.event.description?.trim() && props.fill && !props.timeLabel && !props.event.allDay && !props.compact && durationHours() >= 1.5,
    );
  const timeLabel = () =>
    props.timeLabel ?? `${formatTime(props.event.startDate, dateConfig())} - ${formatTime(props.event.endDate, dateConfig())}`;
  const ariaLabel = () => {
    const label = props.label
      ? props.label
      : props.event.allDay
        ? props.event.title
        : props.event.endDate.getTime() <= props.event.startDate.getTime()
          ? // A deadline is a moment, not a span: it names one time.
            `${props.event.title}, ${formatTime(props.event.startDate, dateConfig())}`
          : messages().calendarEventTime({
              title: props.event.title,
              start: formatTime(props.event.startDate, dateConfig()),
              end: formatTime(props.event.endDate, dateConfig()),
            });
    return [label, props.remaining, props.event.accessibleDetail].filter(Boolean).join(", ");
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
      remaining: props.remaining,
      checkbox: props.checkbox ?? false,
      timeline: props.timeline ?? false,
    });
  const defaultContent = (
    <>
      <Show when={props.leadingTime}>
        <span class="k2b-calendar-event__time">{props.leadingTime}</span>
      </Show>
      <span class="k2b-calendar-event__title">
        <Show when={props.event.display === "marker" && !props.checkbox}>
          <span class="k2b-calendar-event__marker" aria-hidden="true" />
        </Show>
        {props.event.title}
      </span>
      <Show when={showTime() || props.remaining}>
        <span class="k2b-calendar-event__meta">
          <Show when={showTime()}>{timeLabel()}</Show>
          <Show when={props.remaining}>
            <span class="k2b-calendar-event__remaining">{showTime() ? ` · ${props.remaining}` : props.remaining}</span>
          </Show>
        </span>
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
      {props.trailing}
    </>
  );
  const canMove = () => props.event.editable !== false && Boolean(props.owner.onEventDrop);
  const canResize = () => props.event.editable !== false && props.event.display !== "marker" && Boolean(props.owner.onEventResize);
  const timedEditing = () => !props.event.allDay && Boolean(props.fill || props.timeline);
  const editInstructions = () =>
    [
      canMove() ? (timedEditing() ? messages().calendarMoveTimeKeys : messages().calendarMoveDayKeys) : undefined,
      canResize() ? (timedEditing() ? messages().calendarResizeTimeKeys : messages().calendarResizeDayKeys) : undefined,
      canMove() && props.onMovePointerDown ? messages().calendarTouchMove : undefined,
      canResize() && props.fill && !props.event.allDay ? messages().calendarTouchResize : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const onEditKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || !event.altKey || event.ctrlKey || event.metaKey) return false;
    const days = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const minutes = timedEditing() ? (event.key === "ArrowUp" ? -15 : event.key === "ArrowDown" ? 15 : 0) : 0;
    if ((!days && !minutes) || !(event.shiftKey ? canResize() : canMove())) return false;
    event.preventDefault();
    event.stopPropagation();
    const source = props.event;
    const shift = (date: Date) => {
      if (!days) return new Date(date.getTime() + minutes * 60_000);
      const timeZone = dateConfig().timeZone;
      if (timeZone) {
        // addDays is date-only. Keep the event's wall clock across DST, including sub-minute precision.
        const next = calendar.addZonedInstant(date, { timeZone, days, disambiguation: "compatible" });
        return new Date(new Date(next).getTime() + date.getUTCSeconds() * 1000 + date.getUTCMilliseconds());
      }
      const next = new Date(date);
      next.setDate(next.getDate() + days);
      return next;
    };
    const start = event.shiftKey ? source.sourceStartDate : shift(source.sourceStartDate);
    const end =
      event.shiftKey || source.allDay
        ? shift(source.sourceEndDate)
        : new Date(start.getTime() + source.sourceEndDate.getTime() - source.sourceStartDate.getTime());
    if (event.shiftKey && end <= start) return true;
    const change = { start, end, allDay: Boolean(source.allDay) };
    if (event.shiftKey) props.owner.onEventResize?.(source, change);
    else props.owner.onEventDrop?.(source, change);
    return true;
  };
  const isActionable = () => isInteractive() || canMove() || canResize();
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
  /** Space on an entry with a box checks it; Enter still opens the entry. */
  const onCheckKeyDown = (event: KeyboardEvent) => {
    if (onEditKeyDown(event)) return true;
    if (event.key !== " " || !props.onCheck || event.altKey || event.ctrlKey || event.metaKey) return false;
    event.preventDefault();
    props.onCheck();
    return true;
  };
  const onButtonKeyDown = (event: KeyboardEvent) => {
    if (onCheckKeyDown(event) || !isInteractive() || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    props.owner.onEventActivate?.(props.event);
  };
  let cancelTouch: (() => void) | undefined;
  onCleanup(() => cancelTouch?.());
  const onPointerDown = (event: PointerEvent) => {
    if (props.event.editable === false || !props.onMovePointerDown) return;
    event.stopPropagation();
    cancelTouch?.();
    cancelTouch = startCalendarEventGesture(event, () => {
      if (props.event.editable === false) return;
      props.onMovePointerDown?.(event, () => {
        if (event.pointerType !== "touch") suppressClickUntil = performance.now() + 400;
      });
    });
  };
  const attributes = () => ({
    class: "k2b-calendar-event",
    "data-calendar-event": "",
    "data-calendar-event-id": props.event.id,
    "data-color": props.event.colorHex ? undefined : color(),
    "data-selected": selected() ? "true" : undefined,
    "data-compact": props.compact ? "true" : undefined,
    "data-fill": props.fill ? "true" : undefined,
    "data-short": short() ? "true" : undefined,
    "data-moving": props.moving ? "true" : undefined,
    "data-editable": props.event.editable === false ? "false" : undefined,
    "data-continues-before": props.continuesBefore ? "true" : undefined,
    "data-continues-after": props.continuesAfter ? "true" : undefined,
    "data-bar": props.bar ? "true" : undefined,
    "data-display": props.event.display,
    "data-stop": props.stop?.id,
    "data-col": props.stop?.column,
    "data-minute": props.stop?.minute,
    style: style(),
    "aria-label": ariaLabel(),
    "aria-description": editInstructions(),
  });

  return props.href ? (
    <a
      {...attributes()}
      href={props.href}
      data-interactive={isInteractive() ? "true" : undefined}
      data-space-item-id={props.event.dataSpaceItemId}
      tabIndex={props.tabIndex}
      draggable={props.onMovePointerDown ? false : undefined}
      onClick={onClick}
      onDblClick={onDoubleClick}
      onDragStart={props.onMovePointerDown ? (event) => event.preventDefault() : undefined}
      onPointerDown={onPointerDown}
      onKeyDown={onCheckKeyDown}
    >
      {content()}
    </a>
  ) : isActionable() ? (
    <button
      {...attributes()}
      type="button"
      data-interactive="true"
      tabIndex={props.tabIndex}
      onClick={onClick}
      onDblClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onKeyDown={onButtonKeyDown}
    >
      {content()}
    </button>
  ) : (
    <div {...attributes()} role="group" tabIndex={props.tabIndex} onKeyDown={onCheckKeyDown}>
      {content()}
    </div>
  );
};

let measureContext: CanvasRenderingContext2D | null | undefined;
/** The width of a text in a font, from a canvas, so a bar can tell whether its title leaves room for a date hint. */
export const textWidth = (text: string, font: string): number => {
  measureContext ??= typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!measureContext) return Number.POSITIVE_INFINITY;
  measureContext.font = font;
  return measureContext.measureText(text).width;
};
