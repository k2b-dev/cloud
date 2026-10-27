import type { CalendarDescriptor } from "@k2b/cloud/contracts";
import { type DateContext, dates } from "@k2b/stdlib";
import { ButtonLink, IconButton } from "@k2b/ui";
import { For, Show } from "solid-js";
import { summarizeRecurrence } from "@/presentation/recurrence";
import { type CalendarSourceView, itemColor, itemTitle, nextDateKey, type SourcedCalendarItem, shiftDateKey } from "./calendar-model";
import { useCalendarViewMessages } from "./messages";

type Props = {
  item: SourcedCalendarItem;
  source: CalendarSourceView | undefined;
  calendar: CalendarDescriptor | undefined;
  dateConfig?: DateContext;
  onClose: () => void;
};

const dayLabel = (key: string, dateConfig: DateContext | undefined, weekday: "long" | "short") =>
  new Intl.DateTimeFormat(dateConfig?.locale ?? "en", {
    weekday,
    day: "numeric",
    month: weekday === "long" ? "long" : "short",
    timeZone: "UTC",
  }).format(new Date(`${key}T12:00:00Z`));

const instantDay = (instant: string, dateConfig?: DateContext) =>
  new Intl.DateTimeFormat(dateConfig?.locale ?? "en", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: dateConfig?.timeZone,
  }).format(new Date(instant));

const timeIn = (instant: string, zone: string | undefined, locale: string | undefined) =>
  new Intl.DateTimeFormat(locale ?? "en", { hour: "2-digit", minute: "2-digit", timeZone: zone }).format(new Date(instant));

/** The city of an IANA zone, as people say it: "America/Chicago" is "Chicago". */
const zoneName = (zone: string) => zone.split("/").at(-1)?.replaceAll("_", " ") ?? zone;

/** One event, deadline, or busy time of any source: when, how often, where, and where it comes from. */
export default function EventDetail(props: Props) {
  const t = useCalendarViewMessages();
  const locale = () => props.dateConfig?.locale;
  const title = () => itemTitle(props.item, t);
  const when = (): { main: string; sub: string } => {
    const item = props.item;
    if (item.type === "deadline") {
      if (item.due.kind === "date") return { main: dayLabel(item.due.date, props.dateConfig, "long"), sub: t.deadline };
      return {
        main: instantDay(item.due.at, props.dateConfig),
        sub: t.due({ time: timeIn(item.due.at, props.dateConfig?.timeZone, locale()) }),
      };
    }
    const time = item.time;
    if (time.kind === "date") {
      const last = shiftDateKey(time.end, -1);
      const single = nextDateKey(time.start) === time.end;
      return {
        main: single
          ? dayLabel(time.start, props.dateConfig, "long")
          : `${dayLabel(time.start, props.dateConfig, "short")} – ${dayLabel(last, props.dateConfig, "short")}`,
        sub: t.allDay,
      };
    }
    const own = `${timeIn(time.start, props.dateConfig?.timeZone, locale())}–${timeIn(time.end, props.dateConfig?.timeZone, locale())}`;
    const zone = time.timeZone;
    const differs =
      zone !== null &&
      zone !== props.dateConfig?.timeZone &&
      timeIn(time.start, zone, locale()) !== timeIn(time.start, props.dateConfig?.timeZone, locale());
    // A timed event over midnight names both days, so it never seems to end before it starts.
    const lastInstant = new Date(Math.max(Date.parse(time.start), Date.parse(time.end) - 1)).toISOString();
    const startDay = dates.formatDateKey(time.start, props.dateConfig);
    const endDay = dates.formatDateKey(lastInstant, props.dateConfig);
    return {
      main:
        startDay === endDay
          ? instantDay(time.start, props.dateConfig)
          : `${dayLabel(startDay, props.dateConfig, "short")} – ${dayLabel(endDay, props.dateConfig, "short")}`,
      sub: differs
        ? `${t.yourTime({ range: own })} · ${t.inZone({
            range: `${timeIn(time.start, zone, locale())}–${timeIn(time.end, zone, locale())}`,
            zone: zoneName(zone),
          })}`
        : own,
    };
  };
  const series = () => {
    const item = props.item;
    if (item.type === "busy" || !item.occurrence?.rule) return null;
    const start = item.type === "event" ? item.time.start : item.due.kind === "date" ? item.due.date : item.due.at;
    return summarizeRecurrence(
      { rrule: item.occurrence.rule, exdate: [] },
      {
        startsAt: /T/.test(start) ? start : null,
        allDay: item.type === "event" ? item.time.kind === "date" : item.due.kind === "date",
        dateConfig: props.dateConfig,
      },
    );
  };
  const location = () => (props.item.type === "event" ? props.item.location : null);
  const open = () => (props.item.type === "busy" ? null : props.item.open);
  const target = () => (props.source?.appId === "spaces" ? (props.calendar?.name ?? props.source.name) : (props.source?.name ?? ""));
  const notes = () => {
    const item = props.item;
    const result: string[] = [];
    if (item.type === "busy") result.push(t.busyDetail({ app: props.source?.name ?? "" }));
    if (item.type !== "deadline" && item.status === "cancelled") result.push(t.cancelledDetail);
    if (item.type === "event" && item.transparency === "free") result.push(t.freeDetail);
    return result;
  };
  return (
    <div class="spaces-calendar-detail">
      <IconButton class="spaces-calendar-detail__close" label={t.close} size="sm" variant="ghost" onClick={() => props.onClose()}>
        <i class="ti ti-x" aria-hidden="true" />
      </IconButton>
      <h2 class="spaces-calendar-detail__title" style={{ "--spaces-calendar-color": itemColor(props.item, props.calendar) }}>
        <span class="spaces-calendar-detail__dot" aria-hidden="true" />
        <span>
          <Show when={props.item.type === "busy"}>
            <i class="ti ti-lock spaces-calendar-detail__lock" aria-hidden="true" />
          </Show>
          <span data-cancelled={props.item.type !== "deadline" && props.item.status === "cancelled" ? "true" : undefined}>{title()}</span>
        </span>
      </h2>
      <div class="spaces-calendar-detail__rows">
        <div class="spaces-calendar-detail__row">
          <i class="ti ti-clock" aria-hidden="true" />
          <span>
            {when().main}
            <small>{when().sub}</small>
          </span>
        </div>
        <Show when={props.item.type === "deadline" && props.item.done}>
          <div class="spaces-calendar-detail__row">
            <i class="ti ti-circle-check" aria-hidden="true" />
            <span>{t.done}</span>
          </div>
        </Show>
        <Show when={series()}>
          {(text) => (
            <div class="spaces-calendar-detail__row">
              <i class="ti ti-repeat" aria-hidden="true" />
              <span>{text()}</span>
            </div>
          )}
        </Show>
        <Show when={location()}>
          {(place) => (
            <div class="spaces-calendar-detail__row">
              <i class="ti ti-map-pin" aria-hidden="true" />
              <span>{place()}</span>
            </div>
          )}
        </Show>
        <Show when={props.source}>
          {(source) => (
            <div class="spaces-calendar-detail__source">
              <span class="spaces-calendar-detail__app" aria-hidden="true">
                <i class={source().icon ?? "ti ti-calendar"} />
              </span>
              <span>
                <b>{source().name}</b>
                <Show when={props.calendar}>{(calendar) => <> · {calendar().name}</>}</Show>
              </span>
            </div>
          )}
        </Show>
      </div>
      <For each={notes()}>{(note) => <p class="spaces-calendar-detail__note">{note}</p>}</For>
      <Show when={open()}>
        {(link) => (
          <div class="spaces-calendar-detail__actions">
            <ButtonLink href={link().href} variant="secondary" size="sm">
              {t.openIn({ name: target() })}
              <i class="ti ti-arrow-up-right" aria-hidden="true" />
            </ButtonLink>
          </div>
        )}
      </Show>
    </div>
  );
}
