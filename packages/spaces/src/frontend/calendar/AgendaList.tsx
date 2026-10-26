import { type DateContext, dates } from "@k2b/stdlib";
import { For, Show } from "solid-js";
import {
  CALENDAR_LIST_DAYS,
  type CalendarLookup,
  calendarKey,
  itemColor,
  itemKey,
  itemTitle,
  type SourcedCalendarItem,
  shiftDateKey,
} from "./calendar-model";
import { useCalendarViewMessages } from "./messages";

type Props = {
  date: string;
  items: readonly SourcedCalendarItem[];
  lookup: CalendarLookup;
  today: string;
  selectedKey?: string;
  dateConfig?: DateContext;
  onOpen: (item: SourcedCalendarItem, anchor: HTMLElement) => void;
};

type Row = { item: SourcedCalendarItem; sort: number; time: string; end: string | null };

/** The 14 days from the list's date, day by day: today always, other days only when they have something. */
export default function AgendaList(props: Props) {
  const t = useCalendarViewMessages();
  const locale = () => props.dateConfig?.locale ?? "en";
  const time = (instant: string) => dates.formatTime(instant, props.dateConfig);
  const keyOf = (instant: string) => dates.formatDateKey(new Date(instant), props.dateConfig);
  /** Rows of a day: all-day entries first, then by time. A multi-day entry shows on each of its days. */
  const rowsOn = (day: string): Row[] =>
    props.items
      .flatMap((item): Row[] => {
        if (item.type === "deadline") {
          if (item.due.kind === "date") return item.due.date === day ? [{ item, sort: -1, time: t.allDay, end: null }] : [];
          return keyOf(item.due.at) === day ? [{ item, sort: Date.parse(item.due.at), time: time(item.due.at), end: null }] : [];
        }
        if (item.time.kind === "date")
          return item.time.start <= day && item.time.end > day ? [{ item, sort: -1, time: t.allDay, end: null }] : [];
        const start = keyOf(item.time.start);
        const last = keyOf(new Date(Math.max(Date.parse(item.time.start), Date.parse(item.time.end) - 1)).toISOString());
        if (day < start || day > last) return [];
        return start === day
          ? [{ item, sort: Date.parse(item.time.start), time: time(item.time.start), end: time(item.time.end) }]
          : [{ item, sort: -1, time: t.allDay, end: null }];
      })
      .sort((left, right) => left.sort - right.sort);
  const days = () =>
    Array.from({ length: CALENDAR_LIST_DAYS }, (_, index) => shiftDateKey(props.date, index))
      .map((day) => ({ day, rows: rowsOn(day) }))
      .filter((entry) => entry.rows.length > 0 || entry.day === props.today);
  const dayName = (day: string) =>
    day === props.today
      ? t.today
      : day === shiftDateKey(props.today, 1)
        ? t.tomorrow
        : new Intl.DateTimeFormat(locale(), { weekday: "long", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
  const dayDate = (day: string) =>
    new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
  return (
    <div class="spaces-calendar-agenda">
      <For each={days()}>
        {(entry) => (
          <section class="spaces-calendar-agenda__day" data-today={entry.day === props.today ? "true" : undefined}>
            <h3>
              {dayName(entry.day)}
              <small>{dayDate(entry.day)}</small>
            </h3>
            <div class="spaces-calendar-agenda__rows">
              <Show when={entry.rows.length > 0} fallback={<p class="spaces-calendar-agenda__none">{t.nothing}</p>}>
                <For each={entry.rows}>
                  {(row) => {
                    const found = () => props.lookup.get(calendarKey(row.item.appId, row.item.calendarId));
                    const meta = () =>
                      [
                        found()?.calendar.name,
                        found()?.source.name,
                        row.item.type === "event" ? row.item.location : null,
                        row.item.type === "deadline" ? (row.item.done ? t.done : t.deadline) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ");
                    return (
                      <button
                        type="button"
                        class="spaces-calendar-agenda__row"
                        data-busy={row.item.type === "busy" ? "true" : undefined}
                        data-kind={row.item.type}
                        data-selected={props.selectedKey === itemKey(row.item) ? "true" : undefined}
                        data-cancelled={row.item.type !== "deadline" && row.item.status === "cancelled" ? "true" : undefined}
                        style={{ "--spaces-calendar-color": itemColor(row.item, found()?.calendar) }}
                        onClick={(event) => props.onOpen(row.item, event.currentTarget)}
                      >
                        <span class="spaces-calendar-agenda__time">
                          {row.time}
                          <Show when={row.end}>{(end) => <small>{end()}</small>}</Show>
                        </span>
                        <span class="spaces-calendar-agenda__dot" aria-hidden="true" />
                        <span class="spaces-calendar-agenda__copy">
                          <span class="spaces-calendar-agenda__title">
                            <Show when={row.item.type === "busy"}>
                              <i class="ti ti-lock" aria-hidden="true" />{" "}
                            </Show>
                            {itemTitle(row.item, t)}
                          </span>
                          <span class="spaces-calendar-agenda__meta">{meta()}</span>
                        </span>
                      </button>
                    );
                  }}
                </For>
              </Show>
            </div>
          </section>
        )}
      </For>
    </div>
  );
}
