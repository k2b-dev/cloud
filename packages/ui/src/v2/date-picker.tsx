import { createEffect, createMemo, createSignal, createUniqueId, For, on, onMount, Show } from "solid-js";
import { addDaysToKey } from "../inputs/date-input";
import { dateKey } from "../inputs/date-picker";
import { useLocale } from "../intl/locale";
import { dayOfWeekOfKey } from "../intl/weekend";
import { useCalendar } from "./behavior/calendar";
import { type TimeSegment, useTimeInput } from "./behavior/time-input";
import { hourCycleOf, timeExample } from "./behavior/time-text";
import { Button } from "./button";
import { useDateMessages } from "./date-messages";
import { firstDayOfWeek, weekStartOf, windowDays, windowEnd, windowShowing } from "./date-weeks";
import { Icon } from "./marks";

export type DatePickerProps = {
  /** The chosen day as a date key ("2026-11-24"); with `time` the wall time of a minute ("2026-11-24T09:00"). */
  value?: string;
  /**
   * Hour and minute under the month, in the wall time of `timeZone`. A pressed day is then only chosen: "Übernehmen" or
   * Enter in the time gives day and time together.
   */
  time?: boolean;
  /** With `time` and no value yet: the time a chosen day starts with, "00:00" by default. */
  defaultTime?: string;
  /** The earliest and the latest day that can be picked, as date keys. */
  min?: string;
  max?: string;
  /** The zone that says which day today is; with `time` the zone of the wall time too. The browser's by default. */
  timeZone?: string;
  /** The name of the calendar for assistive technology, such as the field it fills. */
  label?: string;
  /** Why the last pick did not apply; it stands under the calendar, and the picker stays as it is. */
  error?: string;
  /** A picked day, or with `time` day and time ("2026-11-24T09:00"). */
  onPick: (value: string) => void;
  /** Offers "Leeren", which takes the value out. */
  onClear?: () => void;
  /** Moves the focus to the chosen day (else today) once the picker shows, as an opened calendar does. */
  autoFocus?: boolean;
  /**
   * `months` (the default) shows whole months. `weeks` shows six weeks from the week of `min` (else today) onward, over
   * the ends of months, for a picker of a moment ahead ("Später", an expiry): no month of days that lie behind. The
   * first day of a month carries its short name; the arrows, PageUp and PageDown move the six weeks by whole weeks, and
   * the buttons by six.
   */
  view?: "months" | "weeks";
};

const monthOf = (key: string) => key.slice(0, 7);

/** What a grid of core lists: the weekdays in column order and its weeks of cells. */
type GridState = { weekdays?: number[]; weeks?: { date: string; outside: boolean }[][] };

/**
 * Core's time input in one clock: hour and minute as spinbuttons in the locale's clock (24 hours in German), never the
 * browser's time field. Typing, the arrows, Backspace and the segment keys are core's; the adapter reads a pasted time.
 */
const TimeField = (props: {
  value: string | null;
  onChange: (value: string | null) => void;
  locale: string;
  hourCycle: 12 | 24;
  labelledBy: string;
  emptyText: string;
  invalid: boolean;
  onUnreadable: () => void;
  /** A paste was read or a segment typed in: the mark of an unreadable paste goes. */
  onRead: () => void;
  onEnter: () => void;
}) => {
  const time = useTimeInput(() => ({
    value: props.value,
    onValueChange: props.onChange,
    locale: props.locale,
    hourCycle: props.hourCycle,
    emptyText: props.emptyText,
    onUnreadable: props.onUnreadable,
    onRead: props.onRead,
  }));
  return (
    <time.Root
      class="k2-input k2-time"
      data-invalid={props.invalid ? "" : undefined}
      aria-labelledby={props.labelledBy}
      // Enter applies what the segments hold once core has taken what was typed: a native listener on the group runs
      // after core's on the segment (also in a panel that stops keys) and before the form around it would be sent.
      // With Ctrl, Cmd or Alt core takes nothing, so nothing applies, and the form around is not sent either (core
      // would send it with the time from before); Shift+Enter is Enter.
      on:keydown={(event: KeyboardEvent) => {
        if (event.key !== "Enter" || event.isComposing) return;
        event.preventDefault();
        if (!event.ctrlKey && !event.metaKey && !event.altKey) props.onEnter();
      }}
      // what is typed into a segment comes as `beforeinput`, which core takes over (no `input` follows)
      on:beforeinput={() => props.onRead()}
    >
      {(state: { segments?: TimeSegment[] }) => (
        <For each={(state.segments ?? []).map((segment) => segment.key)}>
          {(key) => {
            const segment = () => (state.segments ?? []).find((each) => each.key === key);
            return (
              <Show
                when={segment()?.editable}
                fallback={
                  <time.Literal segment={segment()} class="k2-time-sep">
                    {segment()?.text}
                  </time.Literal>
                }
              >
                <time.Segment segment={segment()} class="k2-time-seg" />
              </Show>
            );
          }}
        </For>
      )}
    </time.Root>
  );
};

/**
 * A month of days to pick one from: the month and year in the words of the locale, the arrows for the month before
 * and after, six weeks so turning the month never changes the height, and with `time` hour and minute below. The keys
 * are a grid's: arrows by day and week, PageUp and PageDown by month (with Shift by year), Home and End to the week's
 * ends, Enter or Space picks; the week starts where the locale starts it.
 */
export const DatePicker = (props: DatePickerProps) => {
  const t = useDateMessages();
  const locale = useLocale();
  const day = () => props.value?.slice(0, 10) || undefined;
  const today = () => dateKey(new Date(), props.timeZone ? { timeZone: props.timeZone } : undefined);
  const [month, setMonth] = createSignal(monthOf(day() ?? today()));
  // a value set from elsewhere shows its month
  createEffect(on(day, (key) => key && setMonth(monthOf(key)), { defer: true }));
  // with `time` a pressed day is a draft until "Übernehmen"; without, it is the pick
  const [chosen, setChosen] = createSignal(day());
  createEffect(on(day, (key) => setChosen(key), { defer: true }));
  // the time as `HH:MM`, or `null` while a segment is empty or partly typed; a value set from elsewhere shows its time
  const initialTime = () => props.value?.slice(11, 16) || props.defaultTime || "00:00";
  const [clock, setClock] = createSignal<string | null>(initialTime());
  createEffect(
    on(
      () => props.value,
      () => setClock(initialTime()),
      { defer: true },
    ),
  );
  const [unreadableTime, setUnreadableTime] = createSignal(false);
  const changeClock = (next: string | null) => {
    setClock(next);
    setUnreadableTime(false);
  };
  const timeLabel = createUniqueId();
  // `view="weeks"`: six weeks from the first day of a week. Core holds three months, so every day of the window lies in
  // one of its grids (and has its keys); the picker shows only the window's days, as one grid of seven columns.
  const weeks = () => props.view === "weeks";
  const firstDay = createMemo(() => firstDayOfWeek(locale()));
  const anchor = () => props.min ?? today();
  const firstWindow = () => {
    const from = anchor();
    const key = day();
    return weekStartOf(key && key > from ? key : from, firstDay());
  };
  const [windowStart, setWindowStart] = createSignal(firstWindow());
  const inWindow = (key: string) => key >= windowStart() && key <= windowEnd(windowStart());
  /** Six weeks back or ahead; never back past the week of `min`, never ahead past `max`. */
  const page = (direction: -1 | 1) => {
    const next = addDaysToKey(windowStart(), direction * windowDays);
    const first = weekStartOf(anchor(), firstDay());
    if (direction < 0) setWindowStart(next < first ? first : next);
    else if (!props.max || next <= props.max) setWindowStart(next);
  };
  const pageBlocked = (direction: -1 | 1) =>
    direction < 0
      ? windowStart() <= weekStartOf(anchor(), firstDay())
      : Boolean(props.max && addDaysToKey(windowStart(), windowDays) > props.max);
  const rangeLabel = createMemo(() => {
    const at = (key: string) => Date.parse(`${key}T12:00:00Z`);
    return new Intl.DateTimeFormat(locale(), { month: "long", year: "numeric", timeZone: "UTC" }).formatRange(
      at(windowStart()),
      at(windowEnd(windowStart())),
    );
  });
  const shortMonth = (key: string) =>
    new Intl.DateTimeFormat(locale(), { month: "short", timeZone: "UTC" }).format(Date.parse(`${key}T12:00:00Z`)).replace(/\.$/, "");
  const calendar = useCalendar(() => ({
    value: chosen() ?? null,
    month: weeks() ? monthOf(windowStart()) : month(),
    months: weeks() ? 3 : 1,
    min: props.min,
    max: props.max,
    locale: locale(),
    timeZone: props.timeZone,
    onMonthChange: (next) => (weeks() ? undefined : setMonth(next)),
    // a day the keys reach outside the six weeks moves them by whole weeks until it shows
    onFocusedChange: (date) => weeks() && setWindowStart(windowShowing(windowStart(), date, firstDay())),
    onValueChange: (next) => {
      if (!next) return;
      setChosen(next);
      if (!props.time) pickDay(next);
    },
  }));
  /** Whether a day lies within `min` and `max`: a value the app still holds outside them is shown, never picked again. */
  const pickable = (key: string | undefined): key is string =>
    key !== undefined && !(props.min && key < props.min) && !(props.max && key > props.max);
  const pickDay = (key: string) => pickable(key) && props.onPick(key);
  const ready = createMemo(() => pickable(chosen()) && clock() !== null);
  const apply = () => {
    const key = chosen();
    const hhmm = clock();
    if (!pickable(key) || hhmm === null) return;
    props.onPick(`${key}T${hhmm}`);
  };
  onMount(() => {
    if (!props.autoFocus) return;
    // core moves the focus into a popup first; the day follows
    setTimeout(() => calendar.focus(chosen()));
  });
  const weekdayRow = (state: GridState) => (
    <calendar.Weekdays class={weeks() ? "k2-cal-flow" : "k2-cal-row"} data-head="">
      <For each={state.weekdays ?? []}>
        {(_, index) => (
          <calendar.Weekday index={index()} class="k2-cal-wd">
            {(head: { label?: string }) => head.label}
          </calendar.Weekday>
        )}
      </For>
    </calendar.Weekdays>
  );
  /** One day; in the six weeks it names its column, and the first of a month shows the month's short name. */
  const dayCell = (date: string, flow = false, offset = 0) => (
    <calendar.Day
      value={date}
      // the grid a day belongs to: with several months core lets only a grid's own days take the focus
      offset={offset}
      class="k2-cal-day"
      style={flow ? { "grid-column": String(((dayOfWeekOfKey(date) - firstDay() + 7) % 7) + 1) } : undefined}
      data-month-start={flow && date.endsWith("-01") ? "" : undefined}
      // a day is no submit button: in a form a press on it would send the form
      type="button"
      // the chosen day again changes nothing in core, but it is a pick all the same: it closes
      onClick={() => !props.time && date === chosen() && pickDay(date)}
      onKeyDown={(event: KeyboardEvent) =>
        !props.time && (event.key === "Enter" || event.key === " ") && date === chosen() && pickDay(date)
      }
    >
      {(cell: { label?: string }) => (flow && date.endsWith("-01") ? shortMonth(date) : cell.label)}
    </calendar.Day>
  );
  return (
    <div class="k2-dpick" data-k2-part="DatePicker">
      <calendar.Root class="k2-cal" role="group" aria-label={props.label ?? t().calendar}>
        <div class="k2-cal-h">
          {/* With `view="weeks"` the arrows move the six weeks by six: buttons of their own, since core's step turns a
              month and core keeps their state (`aria-disabled` is core's to set on its parts). */}
          <Show
            when={weeks()}
            fallback={
              <calendar.Previous
                class="k2-btn"
                data-variant="ghost"
                data-icon-only=""
                aria-label={t().previousMonth}
                title={t().previousMonth}
              >
                <Icon name="chevron-left" />
              </calendar.Previous>
            }
          >
            <Button variant="ghost" icon="chevron-left" label={t().previousWeeks} disabled={pageBlocked(-1)} onClick={() => page(-1)} />
          </Show>
          <calendar.Heading class="k2-cal-t">{(state: { label?: string }) => (weeks() ? rangeLabel() : state.label)}</calendar.Heading>
          <Show
            when={weeks()}
            fallback={
              <calendar.Next class="k2-btn" data-variant="ghost" data-icon-only="" aria-label={t().nextMonth} title={t().nextMonth}>
                <Icon name="chevron-right" />
              </calendar.Next>
            }
          >
            <Button variant="ghost" icon="chevron-right" label={t().nextWeeks} disabled={pageBlocked(1)} onClick={() => page(1)} />
          </Show>
        </div>
        <Show
          when={weeks()}
          fallback={
            <calendar.Grid class="k2-cal-grid">
              {(state: GridState) => (
                <>
                  {weekdayRow(state)}
                  <For each={(state.weeks ?? []).map((week) => week.map((cell) => cell.date).join(" "))}>
                    {(week) => (
                      <calendar.Week class="k2-cal-row">
                        <For each={week.split(" ")}>{(date) => dayCell(date)}</For>
                      </calendar.Week>
                    )}
                  </For>
                </>
              )}
            </calendar.Grid>
          }
        >
          {/* Six weeks as one grid of seven columns: core's three month grids flow into it (`display: contents`), each
              day of the window from the grid of its own month, so a week over the end of a month is one row. */}
          <div class="k2-cal-weeks">
            <For each={[0, 1, 2]}>
              {(offset) => (
                <calendar.Grid offset={offset} class="k2-cal-flow">
                  {(state: GridState) => (
                    <>
                      <Show when={offset === 0}>{weekdayRow(state)}</Show>
                      <For
                        each={(state.weeks ?? [])
                          .map((week) =>
                            week
                              .filter((cell) => !cell.outside && inWindow(cell.date))
                              .map((cell) => cell.date)
                              .join(" "),
                          )
                          .filter(Boolean)}
                      >
                        {(week) => (
                          <calendar.Week class="k2-cal-flow">
                            <For each={week.split(" ")}>{(date) => dayCell(date, true, offset)}</For>
                          </calendar.Week>
                        )}
                      </For>
                    </>
                  )}
                </calendar.Grid>
              )}
            </For>
          </div>
        </Show>
      </calendar.Root>
      <Show when={props.time}>
        <div class="k2-dpick-time">
          <span class="k2-dpick-label" id={timeLabel}>
            {t().time}
          </span>
          {/* A new clock (24 hours or AM/PM, when the locale changes) makes the field anew from the time it holds: core
              would keep the segments as typed in the old clock. */}
          <Show when={hourCycleOf(locale())} keyed>
            {(cycle) => (
              <TimeField
                value={clock()}
                onChange={changeClock}
                locale={locale()}
                hourCycle={cycle}
                labelledBy={timeLabel}
                emptyText={t().empty}
                invalid={clock() === null || unreadableTime()}
                onUnreadable={() => setUnreadableTime(true)}
                onRead={() => setUnreadableTime(false)}
                onEnter={apply}
              />
            )}
          </Show>
        </div>
      </Show>
      <Show when={props.time && unreadableTime()}>
        <p class="k2-dpick-error" role="alert">
          {t().timeUnreadable({ example: timeExample(locale()) })}
        </p>
      </Show>
      <Show when={props.error}>
        {(message) => (
          <p class="k2-dpick-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={props.time || props.onClear}>
        <div class="k2-dpick-foot">
          <Show when={props.onClear && props.value ? props.onClear : undefined}>
            {(clear) => (
              <Button variant="text" onClick={() => clear()()}>
                {t().clear}
              </Button>
            )}
          </Show>
          <Show when={props.time}>
            <span class="k2-dpick-end">
              <Button variant="primary" disabled={!ready()} onClick={apply}>
                {t().apply}
              </Button>
            </span>
          </Show>
        </div>
      </Show>
    </div>
  );
};
