import { type DateContext, dates } from "@k2b/stdlib";
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { resolveUiMessages, useUiMessages } from "../intl/messages";
import { isWeekendKey } from "../intl/weekend";
import { formatDateInput } from "./date-input";
import { resolveDateInputMessages } from "./date-input-messages";
import {
  type DateRangeValue,
  dateKey,
  inRange,
  isRangeEdge,
  monthDate,
  monthNames,
  msUntilNextDay,
  pickerContext,
  resolveFocusDay,
  weekendBands,
  yearMonth,
} from "./date-picker";

type PanelView = "days" | "months";

/**
 * One month of days, with the year and month views. It loads when a date field first shows in the browser, so a page
 * that renders a date field carries only the field up front (the packed consumer budget); the period picker and the
 * phone sheet use it too.
 */
export function DatePickerPanel(props: {
  visibleMonth: () => Date;
  setVisibleMonth: (date: Date) => void;
  selected?: () => string | null | undefined;
  range?: () => DateRangeValue;
  focusDate?: () => string | null | undefined;
  onSelect: (date: string) => void;
  onDayPreview?: (date: string | null) => void;
  dateConfig?: DateContext;
  /** Earliest and latest selectable day as date keys. */
  min?: string;
  max?: string;
  /** Which month steps this panel offers; a second month beside it offers the other one. */
  nav?: "both" | "previous" | "next";
  /** Leaves the days of neighbouring months empty (`visibility: hidden`), so two months side by side never show a day twice. */
  hideOutside?: boolean;
  /** Whether a day is already on screen, also in a neighbouring panel; arrow keys then move there without paging. */
  isShown?: (date: Date) => boolean;
  /** Where keyboard navigation looks for the day to focus; the panel itself by default. */
  focusRoot?: () => HTMLElement | undefined;
}): JSX.Element {
  const messages = useUiMessages();
  const [view, setView] = createSignal<PanelView>("days");
  const context = createMemo(() => pickerContext(props.dateConfig));
  const month = createMemo(() => yearMonth(props.visibleMonth(), context()));
  // Always six weeks: typing moves an open calendar between months, and a month with fewer weeks would resize it.
  const weeks = createMemo(() => {
    const grid = [...dates.getMonthGrid(month().year, month().month, context())];
    while (grid.length < 6) {
      const last = grid[grid.length - 1]!.at(-1)!;
      grid.push(Array.from({ length: 7 }, (_, index) => dates.addDays(last, index + 1, context())));
    }
    return grid;
  });
  const blocked = (key: string) => Boolean((props.min && key < props.min) || (props.max && key > props.max));
  const inputMessages = createMemo(() => resolveDateInputMessages(context().locale));
  const weekdays = createMemo(() => dates.weekdays(context()));
  const months = createMemo(() => monthNames(context()));
  const dayNameFormatter = createMemo(
    () =>
      new Intl.DateTimeFormat(context().locale, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: context().timeZone,
      }),
  );
  const dayRows = createMemo(() => {
    const visibleMonth = props.visibleMonth();
    const dateContext = context();
    const formatter = dayNameFormatter();
    return weeks().map((week) =>
      week.map((day) => ({
        day,
        key: dates.formatDateKey(day, dateContext),
        outside: !dates.isSameMonth(day, visibleMonth, dateContext),
        label: formatter.format(day),
        number: dates.formatDayNumber(day, dateContext),
      })),
    );
  });
  // Today in the picker's time zone, the zone its values use. The browser reads
  // the clock again at the next midnight there, when a hidden tab becomes visible
  // again (timers may not fire on time while the device sleeps), and when the
  // date config changes. The mark and its timer share each reading, so neither
  // starts from an old one.
  const [clockCheck, checkClock] = createSignal<void>(undefined, { equals: false });
  const now = createMemo(() => {
    clockCheck();
    context();
    return new Date();
  });
  const todayKey = createMemo(() => dateKey(now(), context()));
  // The day's name is formatted in the date locale, so "today" joins it in the same language.
  const todayLabel = (date: string) => resolveUiMessages(context().locale).todayDate({ date });
  createEffect(() => {
    const timer = window.setTimeout(() => checkClock(), msUntilNextDay(now(), context()));
    onCleanup(() => window.clearTimeout(timer));
  });
  onMount(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") checkClock();
    };
    document.addEventListener("visibilitychange", refresh);
    onCleanup(() => document.removeEventListener("visibilitychange", refresh));
  });
  // The weekend columns of the locale, read from the first week so they follow the grid's first day of the week.
  const weekendColumns = createMemo(() => (dayRows()[0] ?? []).map((cell) => isWeekendKey(cell.key, context().locale)));
  const bands = createMemo(() => weekendBands(weekendColumns()));
  let calendar: HTMLElement | undefined;
  // Days that belong to the visible month; the roving tabindex must land on one
  // of them or the grid becomes unreachable by keyboard after month navigation.
  const monthDayKeys = createMemo(() =>
    dayRows()
      .flat()
      .filter((day) => !day.outside && !blocked(day.key))
      .map((day) => day.key),
  );
  // Remembers where arrow-key navigation left off so Tab returns to that day.
  const [focusedKey, setFocusedKey] = createSignal<string>();
  const defaultFocus = createMemo(() =>
    resolveFocusDay(monthDayKeys(), focusedKey() || props.focusDate?.() || props.selected?.() || todayKey()),
  );

  const moveMonth = (delta: number) => props.setVisibleMonth(dates.addMonths(props.visibleMonth(), delta, context()));
  const moveYear = (delta: number) => props.setVisibleMonth(monthDate(month().year + delta, month().month, context()));
  const previousLabel = () => (view() === "days" ? messages().previousMonth : messages().previousYear);
  const nextLabel = () => (view() === "days" ? messages().nextMonth : messages().nextYear);
  // A step whose whole month (or year) lies outside min/max is not offered.
  const stepBlocked = (delta: number) => {
    if (view() === "days") {
      const target = dateKey(dates.addMonths(props.visibleMonth(), delta, context()), context()).slice(0, 7);
      return Boolean((props.min && target < props.min.slice(0, 7)) || (props.max && target > props.max.slice(0, 7)));
    }
    const year = String(month().year + delta);
    return Boolean((props.min && year < props.min.slice(0, 4)) || (props.max && year > props.max.slice(0, 4)));
  };

  const focusDate = (date: Date) => {
    const targetKey = dateKey(date, context());
    if (blocked(targetKey)) return;
    const shown = props.isShown ? props.isShown(date) : dates.isSameMonth(date, props.visibleMonth(), context());
    if (!shown) props.setVisibleMonth(date);
    queueMicrotask(() =>
      (props.focusRoot?.() ?? calendar)?.querySelector<HTMLElement>(`[data-date-day="${targetKey}"]:not([data-hidden="true"])`)?.focus(),
    );
  };

  const handleDayKeyDown = (event: KeyboardEvent, day: Date) => {
    const deltas: Partial<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const delta = deltas[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      focusDate(dates.addDays(day, delta, context()));
      return;
    }
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      focusDate(dates.addMonths(day, event.key === "PageUp" ? -1 : 1, context()));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const buttons = Array.from(
        (event.currentTarget as HTMLButtonElement).closest(".k2b-date-grid")!.querySelectorAll<HTMLButtonElement>("[data-date-day]"),
      );
      const index = buttons.indexOf(event.currentTarget as HTMLButtonElement);
      const offset = event.key === "Home" ? -(index % 7) : 6 - (index % 7);
      focusDate(dates.addDays(day, offset, context()));
    }
  };

  return (
    <section ref={calendar} class="k2b-date-calendar" aria-label={messages().calendar}>
      <header class="k2b-date-calendar__header">
        <button
          type="button"
          class="k2b-date-calendar__nav"
          data-hidden={props.nav === "next" ? "true" : undefined}
          onClick={() => (view() === "days" ? moveMonth(-1) : moveYear(-1))}
          disabled={stepBlocked(-1)}
          aria-label={previousLabel()}
        >
          <i class="ti ti-chevron-left" aria-hidden="true" />
        </button>
        <button type="button" class="k2b-date-calendar__title" onClick={() => setView(view() === "days" ? "months" : "days")}>
          <Show when={view() === "days"} fallback={month().year}>
            {dates.formatMonthYear(props.visibleMonth(), context())}
          </Show>
        </button>
        <button
          type="button"
          class="k2b-date-calendar__nav"
          data-hidden={props.nav === "previous" ? "true" : undefined}
          onClick={() => (view() === "days" ? moveMonth(1) : moveYear(1))}
          disabled={stepBlocked(1)}
          aria-label={nextLabel()}
        >
          <i class="ti ti-chevron-right" aria-hidden="true" />
        </button>
      </header>

      <Show
        when={view() === "days"}
        fallback={
          <div class="k2b-date-months" role="group" aria-label={`Months in ${month().year}`}>
            <For each={months()}>
              {(name, index) => (
                <button
                  type="button"
                  aria-pressed={index() === month().month}
                  data-selected={index() === month().month ? "true" : undefined}
                  onClick={() => {
                    props.setVisibleMonth(monthDate(month().year, index(), context()));
                    setView("days");
                  }}
                >
                  {name}
                </button>
              )}
            </For>
          </div>
        }
      >
        {/* The weekend is a calm band behind its columns, from the weekday row through the last week. The band only
            paints a background, so it never moves a day. */}
        <div class="k2b-date-weekdays" aria-hidden="true">
          <For each={bands()}>
            {(band) => <span class="k2b-date-weekend" style={{ "grid-column": `${band.start + 1} / span ${band.span}` }} />}
          </For>
          <For each={weekdays()}>{(day, index) => <span data-weekend={weekendColumns()[index()] ? "true" : undefined}>{day}</span>}</For>
        </div>
        <div class="k2b-date-grid" role="grid">
          <For each={bands()}>
            {(band) => (
              <span
                class="k2b-date-weekend"
                aria-hidden="true"
                style={{ "grid-column": `${band.start + 1} / span ${band.span}`, "grid-row": `1 / span ${dayRows().length}` }}
              />
            )}
          </For>
          <For each={dayRows()}>
            {(week) => (
              // A week of a neighbouring month only, left empty beside a second month, is hidden as a whole.
              <div
                class="k2b-date-week"
                role="row"
                aria-hidden={props.hideOutside && week.every((cell) => cell.outside) ? "true" : undefined}
              >
                <For each={week}>
                  {(cell, cellIndex) => {
                    const selected = () => props.selected?.() === cell.key;
                    const range = () => props.range?.() ?? { start: null, end: null };
                    const active = () => selected() || isRangeEdge(cell.key, range());
                    const focusable = () => cell.key === defaultFocus();
                    const today = () => cell.key === todayKey();
                    const hidden = () => Boolean(props.hideOutside && cell.outside);
                    const label = () => {
                      const name = today() ? todayLabel(cell.label) : cell.label;
                      return blocked(cell.key) ? inputMessages().notSelectable({ date: name }) : name;
                    };
                    return (
                      <button
                        type="button"
                        role="gridcell"
                        data-date-day={cell.key}
                        data-date-focus={focusable() ? "true" : undefined}
                        data-outside={cell.outside ? "true" : undefined}
                        data-hidden={hidden() ? "true" : undefined}
                        data-weekend={weekendColumns()[cellIndex()] ? "true" : undefined}
                        data-in-range={inRange(cell.key, range()) && !active() ? "true" : undefined}
                        data-today={today() ? "true" : undefined}
                        aria-current={today() ? "date" : undefined}
                        aria-label={label()}
                        aria-selected={active()}
                        disabled={blocked(cell.key)}
                        tabIndex={focusable() ? 0 : -1}
                        onClick={() => props.onSelect(cell.key)}
                        onKeyDown={(event) => handleDayKeyDown(event, cell.day)}
                        onBlur={() => props.onDayPreview?.(null)}
                        onFocus={() => {
                          setFocusedKey(cell.key);
                          props.onDayPreview?.(cell.key);
                        }}
                        onPointerEnter={() => props.onDayPreview?.(cell.key)}
                        onPointerLeave={() => props.onDayPreview?.(null)}
                      >
                        {cell.number}
                      </button>
                    );
                  }}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.min || props.max}>
        <footer class="k2b-date-calendar__limits">
          <span>{props.min ? inputMessages().limitFrom({ date: formatDateInput(props.min, context().locale) }) : ""}</span>
          <span>{props.max ? inputMessages().limitUntil({ date: formatDateInput(props.max, context().locale) }) : ""}</span>
        </footer>
      </Show>
    </section>
  );
}
