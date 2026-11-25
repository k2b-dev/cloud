import { createEffect, createMemo, createSignal, createUniqueId, For, on, onMount, Show } from "solid-js";
import { dateKey } from "../inputs/date-picker";
import { useLocale } from "../intl/locale";
import { useCalendar } from "./behavior/calendar";
import { type TimeSegment, useTimeInput } from "./behavior/time-input";
import { Button } from "./button";
import { useDateMessages } from "./date-messages";
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
};

const monthOf = (key: string) => key.slice(0, 7);

/** The clock of a locale: 24 hours in German, twelve with AM and PM in American English (the browser's never counts). */
const hourCycleOf = (locale: string): 12 | 24 => {
  const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
  return cycle === "h11" || cycle === "h12" ? 12 : 24;
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
  const time = useTimeInput(() => ({ value: clock(), onValueChange: setClock, locale: locale(), hourCycle: hourCycleOf(locale()) }));
  const timeLabel = createUniqueId();
  const calendar = useCalendar(() => ({
    value: chosen() ?? null,
    month: month(),
    min: props.min,
    max: props.max,
    locale: locale(),
    timeZone: props.timeZone,
    onMonthChange: setMonth,
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
  return (
    <div class="k2-dpick" data-k2-part="DatePicker">
      <calendar.Root class="k2-cal" role="group" aria-label={props.label ?? t().calendar}>
        <div class="k2-cal-h">
          <calendar.Previous class="k2-btn" data-variant="ghost" data-icon-only="" aria-label={t().previousMonth} title={t().previousMonth}>
            <Icon name="chevron-left" />
          </calendar.Previous>
          <calendar.Heading class="k2-cal-t">{(state: { label?: string }) => state.label}</calendar.Heading>
          <calendar.Next class="k2-btn" data-variant="ghost" data-icon-only="" aria-label={t().nextMonth} title={t().nextMonth}>
            <Icon name="chevron-right" />
          </calendar.Next>
        </div>
        <calendar.Grid class="k2-cal-grid">
          {(state: { weekdays?: number[]; weeks?: { date: string; outside: boolean }[][] }) => (
            <>
              <calendar.Weekdays class="k2-cal-row" data-head="">
                <For each={state.weekdays ?? []}>
                  {(_, index) => (
                    <calendar.Weekday index={index()} class="k2-cal-wd">
                      {(head: { label?: string }) => head.label}
                    </calendar.Weekday>
                  )}
                </For>
              </calendar.Weekdays>
              <For each={(state.weeks ?? []).map((week) => week.map((cell) => cell.date).join(" "))}>
                {(week) => (
                  <calendar.Week class="k2-cal-row">
                    <For each={week.split(" ")}>
                      {(date) => (
                        <calendar.Day
                          value={date}
                          class="k2-cal-day"
                          // the chosen day again changes nothing in core, but it is a pick all the same: it closes
                          onClick={() => !props.time && date === chosen() && pickDay(date)}
                          onKeyDown={(event: KeyboardEvent) =>
                            !props.time && (event.key === "Enter" || event.key === " ") && date === chosen() && pickDay(date)
                          }
                        >
                          {(cell: { label?: string }) => cell.label}
                        </calendar.Day>
                      )}
                    </For>
                  </calendar.Week>
                )}
              </For>
            </>
          )}
        </calendar.Grid>
      </calendar.Root>
      <Show when={props.time}>
        <div class="k2-dpick-time">
          <span class="k2-dpick-label" id={timeLabel}>
            {t().time}
          </span>
          {/* core's time input: hour and minute as spinbuttons in the locale's clock (24 hours in German), never the
              browser's time field. Typing, the arrows and Backspace are core's; Enter applies, as "Übernehmen" does. The
              handlers run as native listeners on the segments, so they also work in a panel that stops keys. */}
          <time.Root class="k2-input k2-time" data-invalid={clock() === null ? "" : undefined} aria-labelledby={timeLabel}>
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
                      <time.Segment
                        segment={segment()}
                        class="k2-time-seg"
                        aria-valuetext={segment()?.empty ? t().empty : undefined}
                        onKeyDown={(event: KeyboardEvent) => {
                          if (event.key !== "Enter" || event.isComposing) return;
                          event.preventDefault();
                          apply();
                        }}
                      />
                    </Show>
                  );
                }}
              </For>
            )}
          </time.Root>
        </div>
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
