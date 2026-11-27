import { createMemo, createSignal, For } from "solid-js";
import { useLocale } from "../intl/locale";
import { firstDayOfWeek, formatDate, weekdayNames } from "./behavior/dates";
import { useDateMessages } from "./date-messages";
import { type HeatDay, heatMonths, heatRows, heatTones } from "./heat-days";
import { custom } from "./marks";

export type { HeatDay } from "./heat-days";

export type HeatProps = {
  /**
   * What happened per day, such as the mails received: one entry per day of the last 53 weeks, from one bounded
   * aggregate. A day without an entry counts 0; entries outside the 53 weeks are ignored.
   */
  days: readonly HeatDay[];
  /**
   * The last day, as a date key in the time zone of the person ("2026-11-27"). Its cell is marked, and the 53 weeks
   * end with its week. The server passes it, so the first paint and the browser agree.
   */
  today: string;
  /** The name of the picture, such as "Mails pro Tag". */
  label: string;
  /** A count in the app's words, such as `(count) => \`${count} Mails\``; each day says it with its date. */
  unit: (count: number) => string;
  /** The data colour of what the days belong to; without it the colour of the app. */
  color?: string;
};

/**
 * A year of days as a picture: one column per week (the newest at the end of the writing direction), one row per
 * weekday, each day in a tone of one colour by its count on a scale all days share. It fits its place by layout
 * alone: the days shrink and never cut the newest weeks, up to 12 px each. The arrows walk the days; each day says
 * its count and date, to a screen reader and in the line below the picture.
 */
export const Heat = (props: HeatProps) => {
  const locale = useLocale();
  const t = useDateMessages();
  const weekStartsOn = createMemo(() => firstDayOfWeek(locale()));
  const rows = createMemo(() => heatRows(props.days, props.today, weekStartsOn()));
  const months = createMemo(() => heatMonths(rows()));
  const names = createMemo(() => weekdayNames(locale(), "short", weekStartsOn()));
  const longNames = createMemo(() => weekdayNames(locale(), "long", weekStartsOn()));
  const said = (date: string, count: number) =>
    t().heatDay({
      what: props.unit(count),
      day: formatDate(date, locale(), { weekday: "short", day: "numeric", month: "short" }),
    });
  // what the pointer or the focus stands on, in words below the picture
  const [read, setRead] = createSignal("");
  const readCell = (target: EventTarget | null) => {
    const cell = target instanceof Element ? target.closest<HTMLElement>("[data-heat-day]") : null;
    if (cell) setRead(cell.getAttribute("aria-label") ?? "");
  };
  // One Tab stop: the arrows walk the days (a week to the side, a day up or down), Home and End go to the ends of the
  // row. The focus keeps its place in the grid when the data changes.
  const walk = (event: KeyboardEvent) => {
    const cell = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-heat-day]") : null;
    const grid = event.currentTarget as HTMLElement;
    if (!cell) return;
    const all = [...grid.querySelectorAll<HTMLElement>('[role="row"]')].map((row) => [
      ...row.querySelectorAll<HTMLElement>("[data-heat-day]"),
    ]);
    const row = all.findIndex((cells) => cells.includes(cell));
    const week = all[row]!.indexOf(cell);
    const rtl = getComputedStyle(grid).direction === "rtl";
    const moves: Record<string, () => [number, number]> = {
      ArrowLeft: () => [row, week + (rtl ? 1 : -1)],
      ArrowRight: () => [row, week + (rtl ? -1 : 1)],
      ArrowUp: () => (row > 0 ? [row - 1, week] : [6, week - 1]),
      ArrowDown: () => (row < 6 ? [row + 1, week] : [0, week + 1]),
      Home: () => [row, 0],
      End: () => [row, all[row]!.length - 1],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const [toRow, toWeek] = move();
    const next = all[toRow]?.[toWeek];
    if (!next) return;
    cell.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  };
  return (
    <div class="k2-heat" data-k2-part="Heat" style={custom({ "--k2-c": props.color })}>
      <div class="k2-heat-months" aria-hidden="true">
        <For each={months()}>
          {(month, index) => (
            <span
              style={custom({ "--k2-heat-at": `${month.week + 2} / span ${month.weeks}` })}
              data-shown={index() % 2 === 0 ? "always" : "room"}
            >
              {formatDate(month.date, locale(), { month: "short" })}
            </span>
          )}
        </For>
      </div>
      <div
        class="k2-heat-grid"
        role="grid"
        aria-label={props.label}
        aria-readonly="true"
        onKeyDown={walk}
        onPointerOver={(event) => readCell(event.target)}
        onPointerLeave={() => setRead("")}
        onFocusIn={(event) => readCell(event.target)}
        onFocusOut={() => setRead("")}
      >
        <For each={rows()}>
          {(cells, row) => (
            <div class="k2-heat-row" role="row">
              {/* every other weekday shows its short name; each names itself in full to a screen reader */}
              <span
                class="k2-heat-day"
                role="rowheader"
                aria-label={longNames()[row()]}
                data-shown={row() % 2 === 0 ? (row() % 4 === 0 ? "always" : "room") : undefined}
              >
                {names()[row()]}
              </span>
              <For each={cells}>
                {(cell) => (
                  <span
                    role="gridcell"
                    data-heat-day=""
                    data-tone={cell.tone}
                    aria-label={said(cell.date, cell.count)}
                    aria-current={cell.date === props.today ? "date" : undefined}
                    tabIndex={cell.date === props.today ? 0 : -1}
                  />
                )}
              </For>
            </div>
          )}
        </For>
      </div>
      <div class="k2-heat-foot" aria-hidden="true">
        <span class="k2-heat-read">{read()}</span>
        <span class="k2-heat-scale">
          <span>{t().heatLess}</span>
          <For each={Array.from({ length: heatTones + 1 }, (_, tone) => tone)}>{(tone) => <i data-tone={tone} />}</For>
          <span>{t().heatMore}</span>
        </span>
      </div>
    </div>
  );
};
