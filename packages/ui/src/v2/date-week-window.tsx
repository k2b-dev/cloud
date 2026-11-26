import { createEffect, createMemo, createSignal, For, on, onMount } from "solid-js";
import { useLocale } from "../intl/locale";
import { addDays, addMonths, firstDayOfWeek, formatDate, formatDateRange, startOfWeek, todayDate, weekdayNames } from "./behavior/dates";
import { useDateMessages } from "./date-messages";
import { windowDays, windowEnd, windowShowing, windowWeeks } from "./date-weeks";
import { Icon } from "./marks";

export type WeekWindowProps = {
  /** The chosen day, a date key. */
  chosen?: string;
  /** The earliest and the latest day that can be picked; the window starts with the week of `min`. */
  min?: string;
  max?: string;
  /** The zone that says which day today is, the same on the server and in the browser; "UTC" by default. */
  timeZone?: string;
  label: string;
  autoFocus?: boolean;
  /** A day pressed or picked with Enter or Space, also the chosen one again. */
  onChoose: (key: string) => void;
};

/**
 * Six weeks from the week of `min` (else today) as ONE grid: a row of weekday heads and six rows of seven days, over
 * the ends of months; the first day of a month shows the month's short name. Core's calendar has no such view, so the
 * grid is drawn here, with core's week start, day arithmetic and names (`behavior/dates`): the keys of a date grid
 * (arrows by day and week, PageUp and PageDown by month, with Shift by year, Home and End to the week's ends, Enter and
 * Space pick), one tab stop, and the window moving by whole weeks to show the day the keys reach.
 */
export const WeekWindow = (props: WeekWindowProps) => {
  const t = useDateMessages();
  const locale = useLocale();
  const weekStartsOn = createMemo(() => firstDayOfWeek(locale()));
  const today = () => todayDate(props.timeZone ?? "UTC");
  const anchor = () => props.min ?? today();
  const home = () => startOfWeek(props.chosen && props.chosen > anchor() ? props.chosen : anchor(), weekStartsOn());
  const [start, setStart] = createSignal(home());
  // the window follows a new week start (another locale) and a new `min`, and shows a value set from elsewhere
  createEffect(on([weekStartsOn, () => props.min], () => setStart(home()), { defer: true }));
  createEffect(
    on(
      () => props.chosen,
      (key) => key && setStart((current) => windowShowing(current, key, weekStartsOn())),
      { defer: true },
    ),
  );
  const weeks = createMemo(() => windowWeeks(start()));
  const inWindow = (key: string) => key >= start() && key <= windowEnd(start());
  const pickable = (key: string) => !(props.min && key < props.min) && !(props.max && key > props.max);
  const clamp = (key: string) => (props.min && key < props.min ? props.min : props.max && key > props.max ? props.max : key);
  const [focused, setFocused] = createSignal<string>();
  /** The one day Tab reaches: the focused day, else the chosen one, else the first day that can be picked. */
  const tabStop = createMemo(() => {
    const candidates = [focused(), props.chosen, today()].filter((key): key is string => Boolean(key && inWindow(key) && pickable(key)));
    return candidates[0] ?? weeks().flat().find(pickable) ?? start();
  });
  let grid: HTMLDivElement | undefined;
  const focusDay = (key: string) => queueMicrotask(() => grid?.querySelector<HTMLElement>(`[data-value="${key}"]`)?.focus());
  /** Moves the focus to a day, within `min` and `max`; the window moves by whole weeks until it shows it. */
  const move = (key: string) => {
    const target = clamp(key);
    setFocused(target);
    setStart((current) => windowShowing(current, target, weekStartsOn()));
    focusDay(target);
  };
  const keydown = (event: KeyboardEvent, key: string) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const steps: Partial<Record<string, () => string>> = {
      ArrowLeft: () => addDays(key, -1),
      ArrowRight: () => addDays(key, 1),
      ArrowUp: () => addDays(key, -7),
      ArrowDown: () => addDays(key, 7),
      PageUp: () => addMonths(key, event.shiftKey ? -12 : -1),
      PageDown: () => addMonths(key, event.shiftKey ? 12 : 1),
      Home: () => startOfWeek(key, weekStartsOn()),
      End: () => addDays(startOfWeek(key, weekStartsOn()), 6),
    };
    const step = steps[event.key];
    if (step) {
      event.preventDefault();
      move(step());
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (pickable(key)) props.onChoose(key);
    }
  };
  // Six weeks back or ahead: never back past the week of `min`, never ahead past `max`. A blocked button keeps the focus
  // (`aria-disabled`, not `disabled`), so the focus never falls to the page.
  const pageBlocked = (direction: -1 | 1) =>
    direction < 0
      ? Boolean(props.min && start() <= startOfWeek(props.min, weekStartsOn()))
      : Boolean(props.max && addDays(start(), windowDays) > props.max);
  const page = (direction: -1 | 1) => {
    if (pageBlocked(direction)) return;
    const next = addDays(start(), direction * windowDays);
    const first = props.min ? startOfWeek(props.min, weekStartsOn()) : undefined;
    setStart(first && next < first ? first : next);
  };
  const rangeLabel = createMemo(() => formatDateRange(start(), windowEnd(start()), locale(), { month: "long", year: "numeric" }));
  const shortMonth = (key: string) => formatDate(key, locale(), { month: "short" }).replace(/\.$/, "");
  // a month's first day shows its short month ("Dez") and names it so too: the visible text is part of the name
  const dayLabel = (key: string) =>
    formatDate(key, locale(), { weekday: "long", day: "numeric", month: key.endsWith("-01") ? "short" : "long", year: "numeric" });
  const heads = createMemo(() => {
    const short = weekdayNames(locale(), "short", weekStartsOn());
    const long = weekdayNames(locale(), "long", weekStartsOn());
    return short.map((name, index) => ({ name, long: long[index] ?? name }));
  });
  onMount(() => {
    if (!props.autoFocus) return;
    // a popup takes the focus first; the day follows
    setTimeout(() => focusDay(tabStop()));
  });
  return (
    <div class="k2-cal" role="group" aria-label={props.label}>
      <div class="k2-cal-h">
        <button
          type="button"
          class="k2-btn"
          data-k2-part="Button"
          data-variant="ghost"
          data-icon-only=""
          aria-label={t().previousWeeks}
          title={t().previousWeeks}
          aria-disabled={pageBlocked(-1) ? "true" : undefined}
          onClick={() => page(-1)}
        >
          <Icon name="chevron-left" />
        </button>
        <div class="k2-cal-t" aria-live="polite">
          {rangeLabel()}
        </div>
        <button
          type="button"
          class="k2-btn"
          data-k2-part="Button"
          data-variant="ghost"
          data-icon-only=""
          aria-label={t().nextWeeks}
          title={t().nextWeeks}
          aria-disabled={pageBlocked(1) ? "true" : undefined}
          onClick={() => page(1)}
        >
          <Icon name="chevron-right" />
        </button>
      </div>
      <div ref={grid} class="k2-cal-grid" role="grid" aria-label={rangeLabel()} data-weeks="">
        <div class="k2-cal-row" role="row" data-head="">
          <For each={heads()}>
            {(head) => (
              <div class="k2-cal-wd" role="columnheader" aria-label={head.long}>
                {head.name}
              </div>
            )}
          </For>
        </div>
        <For each={weeks().map((week) => week.join(" "))}>
          {(week) => (
            <div class="k2-cal-row" role="row">
              <For each={week.split(" ")}>
                {(key) => {
                  const monthStart = key.endsWith("-01");
                  return (
                    <button
                      type="button"
                      role="gridcell"
                      class="k2-cal-day"
                      data-value={key}
                      data-selected={props.chosen === key ? "" : undefined}
                      data-today={today() === key ? "" : undefined}
                      data-disabled={pickable(key) ? undefined : ""}
                      data-month-start={monthStart ? "" : undefined}
                      aria-selected={props.chosen === key ? "true" : "false"}
                      aria-current={today() === key ? "date" : undefined}
                      aria-disabled={pickable(key) ? undefined : "true"}
                      aria-label={dayLabel(key)}
                      tabIndex={tabStop() === key ? 0 : -1}
                      onFocus={() => setFocused(key)}
                      onClick={() => {
                        if (!pickable(key)) return;
                        setFocused(key);
                        props.onChoose(key);
                      }}
                      onKeyDown={(event) => keydown(event, key)}
                    >
                      {monthStart ? shortMonth(key) : formatDate(key, locale(), { day: "numeric" })}
                    </button>
                  );
                }}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};
