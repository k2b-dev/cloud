import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { useLocale } from "../intl/locale";
import { firstDayOfWeek, formatDate, weekdayNames } from "./behavior/dates";
import { useTip } from "./behavior/tip";
import { useDateMessages } from "./date-messages";
import { type HeatDay, heatGrid, heatMonths, heatTones } from "./heat-days";
import { custom } from "./marks";
import { PageLayer } from "./page-layer";

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
  /** A count in the app's words, such as `(count) => \`${count} Nachrichten\``; each day says it after its date. */
  unit: (count: number) => string;
  /** A second line for a day's tip, such as "6 eingehend · 4 gesendet"; nothing for a day without one. */
  detail?: (date: string) => string | undefined;
  /**
   * The line above the picture that sums it up, from the days it shows: their total and how many days that is, such
   * as "2.262 Mails in den letzten 12 Monaten · Ø 6 pro Tag".
   */
  summary?: (sum: { total: number; days: number }) => string;
  /**
   * The data colour of what the days belong to, which keeps 3:1 to the surface at its strongest; without it the
   * readable ink of the app (`--k2-app-ink`) where the platform sets one, else the colour of the app.
   */
  color?: string;
};

/**
 * A year of days as a picture: one column per week (the newest at the end of the writing direction), one row per
 * weekday, each day in a tone of one colour by its count on a scale all days share. It fits its place by layout
 * alone: the days shrink and never cut the newest weeks, up to 12 px each. The arrows walk the days; a day under the
 * pointer or in focus shows its date and count in one tip the whole picture shares.
 */
export const Heat = (props: HeatProps) => {
  const locale = useLocale();
  const t = useDateMessages();
  const weekStartsOn = createMemo(() => firstDayOfWeek(locale()));
  const grid = createMemo(() => heatGrid(props.days, props.today, weekStartsOn()));
  const months = createMemo(() => heatMonths(grid().rows));
  const names = createMemo(() => weekdayNames(locale(), "short", weekStartsOn()));
  const longNames = createMemo(() => weekdayNames(locale(), "long", weekStartsOn()));
  const count = (date: string) => grid().days.get(date)?.count ?? 0;
  const said = (date: string) =>
    t().heatDay({
      what: props.unit(count(date)),
      day: formatDate(date, locale(), { weekday: "short", day: "numeric", month: "short" }),
    });
  // One tip for the whole picture: every day is one of its triggers, and the day that opened it fills it.
  const [shown, setShown] = createSignal<string>();
  const tip = useTip(() => ({ onPayloadChange: (payload: unknown) => typeof payload === "string" && setShown(payload) }));
  let element: HTMLElement | undefined;
  // One Tab stop: the arrows walk the days (a week to the side, a day up or down), Home and End go to the ends of the
  // row. The days are kept by their date, so the focus keeps its place when the counts change.
  const walk = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
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
    <div
      class="k2-heat"
      data-k2-part="Heat"
      style={custom({ "--k2-c": props.color })}
      ref={(node) => {
        element = node;
      }}
    >
      <Show when={props.summary}>
        {(summary) => <span class="k2-heat-sum">{summary()({ total: grid().total, days: grid().span })}</span>}
      </Show>
      <div class="k2-heat-months" aria-hidden="true">
        <For each={months()}>
          {(month, index) => (
            <span
              style={custom({ "--k2-heat-at": `${month.week + 2} / span ${month.weeks}` })}
              data-shown={month.end || index() % 2 === 0 ? "always" : "room"}
              data-end={month.end ? "" : undefined}
            >
              {formatDate(month.date, locale(), { month: "short" })}
            </span>
          )}
        </For>
      </div>
      <div class="k2-heat-grid" role="grid" aria-label={props.label} aria-readonly="true" onKeyDown={walk}>
        <For each={grid().rows}>
          {(dates, row) => (
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
              <For each={dates}>
                {(date) => (
                  <span
                    role="gridcell"
                    data-heat-day=""
                    data-tone={grid().days.get(date)?.tone ?? 0}
                    aria-label={[said(date), props.detail?.(date)].filter(Boolean).join(", ")}
                    aria-current={date === props.today ? "date" : undefined}
                    tabIndex={date === props.today ? 0 : -1}
                    ref={(cell) => onCleanup(tip.bindTrigger(cell, date))}
                  />
                )}
              </For>
            </div>
          )}
        </For>
      </div>
      <div class="k2-heat-foot" aria-hidden="true">
        <span class="k2-heat-scale">
          <span>{t().heatLess}</span>
          <For each={Array.from({ length: heatTones + 1 }, (_, tone) => tone)}>{(tone) => <i data-tone={tone} />}</For>
          <span>{t().heatMore}</span>
        </span>
      </div>
      <PageLayer from={() => element}>
        <tip.Popup class="k2-tip" data-k2-part="Popover" side="top" sideOffset={6} collisionPadding={8}>
          <Show when={shown()}>
            {(date) => (
              <>
                <span class="k2-heat-tip">{said(date())}</span>
                <Show when={props.detail?.(date())}>{(detail) => <span class="k2-heat-tip">{detail()}</span>}</Show>
              </>
            )}
          </Show>
        </tip.Popup>
      </PageLayer>
    </div>
  );
};
