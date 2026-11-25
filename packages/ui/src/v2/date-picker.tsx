import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import { dateKey } from "../inputs/date-picker";
import { useLocale } from "../intl/locale";
import { useCalendar } from "./behavior/calendar";
import { Button } from "./button";
import { useDateMessages } from "./date-messages";
import { Icon } from "./marks";
import { caretInHour, formatTime, parseTime, stepTime, usesDayPeriods } from "./time-text";

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
  // the time as `HH:MM`, and as the field writes it in the locale; what is typed is read on Enter or when it is left
  const initialTime = () => props.value?.slice(11, 16) || props.defaultTime || "00:00";
  const [clock, setClock] = createSignal(initialTime());
  const [typed, setTyped] = createSignal(formatTime(initialTime(), locale()));
  const [unreadable, setUnreadable] = createSignal(false);
  const show = (hhmm: string) => {
    setClock(hhmm);
    setTyped(formatTime(hhmm, locale()));
    setUnreadable(false);
  };
  createEffect(
    on(
      () => props.value,
      () => show(initialTime()),
      { defer: true },
    ),
  );
  /** Reads what is typed; an unreadable text marks the field and keeps the last time. */
  const read = (): string | undefined => {
    const hhmm = parseTime(typed(), locale());
    if (hhmm === undefined) setUnreadable(true);
    else show(hhmm);
    return hhmm;
  };
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
      if (!props.time) props.onPick(next);
    },
  }));
  const ready = createMemo(() => Boolean(chosen()) && !unreadable());
  const apply = () => {
    const key = chosen();
    const hhmm = read();
    if (!key || hhmm === undefined) return;
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
                          onClick={() => !props.time && date === chosen() && props.onPick(date)}
                          onKeyDown={(event: KeyboardEvent) =>
                            !props.time && (event.key === "Enter" || event.key === " ") && date === chosen() && props.onPick(date)
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
        <label class="k2-dpick-time">
          <span class="k2-dpick-label">{t().time}</span>
          {/* text in the locale's own clock (24 hours in German), never the browser's time field: no AM/PM from an
              English browser, no spinners; the arrows turn the hour or the minute the caret stands in */}
          <span class="k2-input" data-invalid={unreadable() ? "" : undefined}>
            <input
              type="text"
              autocomplete="off"
              inputmode={usesDayPeriods(locale()) ? "text" : "decimal"}
              spellcheck={false}
              placeholder={formatTime("00:00", locale())}
              value={typed()}
              aria-invalid={unreadable() ? "true" : undefined}
              onInput={(event) => {
                setTyped(event.currentTarget.value);
                setUnreadable(false);
              }}
              onChange={() => read()}
              onKeyDown={(event) => {
                if (event.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  apply();
                  return;
                }
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                const input = event.currentTarget;
                const part = caretInHour(input.value, input.selectionStart ?? 0) ? "hour" : "minute";
                show(stepTime(parseTime(input.value, locale()) ?? clock(), part, event.key === "ArrowUp" ? 1 : -1));
                // the caret stays in the part it turns
                const text = formatTime(clock(), locale());
                const end = text.search(/\d\D/) + 1;
                queueMicrotask(() => input.setSelectionRange(part === "hour" ? end : text.length, part === "hour" ? end : text.length));
              }}
            />
          </span>
        </label>
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
