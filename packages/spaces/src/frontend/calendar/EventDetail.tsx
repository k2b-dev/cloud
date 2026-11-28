import type { CalendarDescriptor } from "@k2b/cloud/contracts";
import { type DateContext, dates } from "@k2b/stdlib";
import { Button, Dialog, Facts, Notice } from "@k2b/ui/v2";
import { For, Show } from "solid-js";
import { summarizeRecurrence } from "@/presentation/recurrence";
import { type CalendarSourceView, itemTitle, nextDateKey, type SourcedCalendarItem, shiftDateKey } from "./calendar-model";
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
    <Dialog
      title={title()}
      open
      onOpenChange={(open) => !open && props.onClose()}
      foot={
        <>
          <Button onClick={() => props.onClose()}>{t.close}</Button>
          <Show when={open()}>
            {(link) => (
              <Button variant="primary" href={link().href} forward>
                {t.openIn({ name: target() })}
              </Button>
            )}
          </Show>
        </>
      }
    >
      <Facts
        items={[
          { label: t.when, value: `${when().main} · ${when().sub}` },
          ...(props.item.type === "deadline" && props.item.done ? [{ label: t.state, value: t.done }] : []),
          ...(series() ? [{ label: t.repeats, value: series()! }] : []),
          ...(location() ? [{ label: t.place, value: location()! }] : []),
          ...(props.source
            ? [{ label: t.source, value: props.calendar ? `${props.source.name} · ${props.calendar.name}` : props.source.name }]
            : []),
        ]}
      />
      <For each={notes()}>
        {(note) => (
          <Notice tone="note" icon={props.item.type === "busy" ? "lock" : "info-circle"}>
            {note}
          </Notice>
        )}
      </For>
    </Dialog>
  );
}
