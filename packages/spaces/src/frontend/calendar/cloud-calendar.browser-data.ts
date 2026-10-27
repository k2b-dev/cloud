import { dates } from "@k2b/stdlib";
import { type CalendarRange, type CalendarSourceView, calendarKey, itemInRange, type SourcedCalendarItem } from "./calendar-model";

// Invented data only: a logistics team in Lower Saxony. Tuesday, October 27, 2026, 10:40 in Berlin.
export const NOW = new Date("2026-10-27T09:40:00.000Z");
export const TIME_ZONE = "Europe/Berlin";
export const TODAY = "2026-10-27";

const spaces = (id: string, name: string, color: string) => ({
  id,
  name,
  color,
  suggested: true,
  visibility: "details" as const,
  writable: false,
  open: { rel: "open" as const, href: `/app/spaces/${id}?view=calendar` },
});

export const SOURCES: CalendarSourceView[] = [
  {
    appId: "spaces",
    name: "Spaces",
    icon: "ti ti-layout-kanban",
    state: "ok",
    error: null,
    calendars: [
      spaces("TeamLg", "Team Logistik", "#8b5cf6"),
      spaces("Einkf1", "Einkauf", "#3b82f6"),
      spaces("Messe1", "Messe 2026", "#f97316"),
      spaces("Werks1", "Werkstatt", "#10b981"),
    ],
  },
  {
    appId: "intranet",
    name: "Intranet",
    icon: "ti ti-building-community",
    state: "ok",
    error: null,
    calendars: [{ id: "firmenevents", name: "Firmenevents", color: "#d97706", suggested: true, visibility: "details", writable: false }],
  },
  {
    appId: "absence",
    name: "Abwesenheiten",
    icon: "ti ti-beach",
    state: "ok",
    error: null,
    calendars: [
      { id: "team-logistik", name: "Team Logistik", color: "#64748b", suggested: true, visibility: "details", writable: false },
      { id: "feiertage", name: "Feiertage Niedersachsen", color: "#dc2626", suggested: true, visibility: "details", writable: false },
    ],
  },
  {
    appId: "academy",
    name: "Akademie",
    icon: "ti ti-school",
    state: "ok",
    error: null,
    calendars: [{ id: "schulungen", name: "Meine Schulungen", color: "#06b6d4", suggested: true, visibility: "details", writable: false }],
  },
  {
    appId: "meetings",
    name: "Meetings",
    icon: "ti ti-users-group",
    state: "ok",
    error: null,
    calendars: [
      { id: "meine", name: "Meine Meetings", color: "#ec4899", suggested: true, visibility: "details", writable: false },
      { id: "gf", name: "Geschäftsführung", color: "#71717a", suggested: false, visibility: "busy", writable: false },
    ],
  },
  {
    appId: "shifts",
    name: "Schichtplan",
    icon: "ti ti-clock-hour-4",
    state: "ok",
    error: null,
    calendars: [{ id: "meine", name: "Meine Schichten", color: "#65a30d", suggested: false, visibility: "details", writable: false }],
  },
];

const at = (day: string, time: string) => dates.zonedDateTimeToInstant(`${day}T${time}`, TIME_ZONE);
const oct = (day: number) => (day > 31 ? `2026-11-${String(day - 31).padStart(2, "0")}` : `2026-10-${String(day).padStart(2, "0")}`);
let sequence = 0;
const nextId = () => `Item${String(++sequence).padStart(2, "0")}`;
const open = (appId: string, calendarId: string, id: string) => ({
  rel: "open" as const,
  href: appId === "spaces" ? `/app/spaces/${calendarId}?item=${id}` : `https://${appId}.example.com/${id}`,
});

type Extra = { location?: string; free?: boolean; zone?: string; series?: { id: string; rule: string }; cancelled?: boolean };
const event = (appId: string, calendarId: string, title: string, day: number, start: string, end: string, extra: Extra = {}) => {
  const id = extra.series ? `${extra.series.id}-${oct(day)}` : nextId();
  return {
    type: "event" as const,
    appId,
    calendarId,
    id,
    title,
    time: { kind: "instant" as const, start: at(oct(day), start), end: at(oct(day), end), timeZone: extra.zone ?? TIME_ZONE },
    location: extra.location ?? null,
    status: extra.cancelled ? ("cancelled" as const) : ("confirmed" as const),
    transparency: extra.free ? ("free" as const) : ("busy" as const),
    occurrence: extra.series ? { seriesId: extra.series.id, originalStart: at(oct(day), start), rule: extra.series.rule } : null,
    ref: appId === "spaces" ? { type: "spaces.item", id } : null,
    open: open(appId, calendarId, id),
    version: "1",
  };
};
const allDay = (appId: string, calendarId: string, title: string, from: number, toExclusive: number) => {
  const id = nextId();
  return {
    type: "event" as const,
    appId,
    calendarId,
    id,
    title,
    time: { kind: "date" as const, start: oct(from), end: oct(toExclusive) },
    location: null,
    status: "confirmed" as const,
    transparency: "busy" as const,
    occurrence: null,
    ref: null,
    open: open(appId, calendarId, id),
    version: "1",
  };
};
const deadline = (calendarId: string, title: string, day: number, time?: string) => {
  const id = nextId();
  return {
    type: "deadline" as const,
    appId: "spaces",
    calendarId,
    id,
    title,
    due: time ? { kind: "instant" as const, at: at(oct(day), time), timeZone: TIME_ZONE } : { kind: "date" as const, date: oct(day) },
    done: false,
    occurrence: null,
    ref: { type: "spaces.item", id },
    open: open("spaces", calendarId, id),
    version: "1",
  };
};
const busy = (day: number, start: string, end: string) => ({
  type: "busy" as const,
  appId: "meetings",
  calendarId: "gf",
  id: nextId(),
  time: { kind: "instant" as const, start: at(oct(day), start), end: at(oct(day), end), timeZone: TIME_ZONE },
  status: "confirmed" as const,
  transparency: "busy" as const,
});

const items: SourcedCalendarItem[] = [];
// Recurring series, as each source expands them: October 1 to November 8.
for (let day = 1; day <= 39; day++) {
  const weekday = new Date(`${oct(day)}T12:00:00Z`).getUTCDay();
  if (weekday >= 2 && weekday <= 5)
    items.push(
      event("spaces", "TeamLg", "Standup", day, "09:15", "09:30", {
        location: "Rampe 1",
        series: { id: "Standup", rule: "FREQ=WEEKLY;BYDAY=TU,WE,TH,FR" },
      }),
    );
  if (weekday === 1)
    items.push(
      event("spaces", "TeamLg", "Wochenstart", day, "09:00", "09:30", {
        location: "Rampe 1",
        series: { id: "Wochenstart", rule: "FREQ=WEEKLY;BYDAY=MO" },
      }),
    );
  if (weekday === 2)
    items.push(
      event("meetings", "meine", "Team-Meeting Logistik", day, "15:00", "16:00", {
        location: "Raum Elbe",
        series: { id: "TeamMeeting", rule: "FREQ=WEEKLY;BYDAY=TU" },
      }),
    );
}
items.push(
  event("spaces", "Einkf1", "Angebote Folienlieferant prüfen", 26, "11:00", "12:00"),
  event("spaces", "Messe1", "Standplanung Messe Logistik Nord", 26, "14:00", "15:30", { location: "Raum Elbe" }),
  event("spaces", "Werks1", "Gabelstapler-Wartung", 27, "10:30", "11:30", { location: "Halle 2" }),
  event("spaces", "Einkf1", "Lieferantencall Spedition Nord", 27, "13:00", "13:45", { location: "online" }),
  event("academy", "schulungen", "Erste-Hilfe-Auffrischung", 28, "08:30", "12:00", { location: "Schulungsraum 1" }),
  event("spaces", "Messe1", "Messestand-Material packen", 28, "13:00", "15:00", { location: "Lager Süd" }),
  deadline("Einkf1", "Rechnungen freigeben", 28, "16:00"),
  event("academy", "schulungen", "Staplerschein – Theorie", 29, "13:00", "15:00", { location: "Schulungsraum 2" }),
  event("intranet", "firmenevents", "All-Hands Q4", 29, "15:30", "16:30", { location: "Kantine und online" }),
  event("meetings", "meine", "Call mit Partner Chicago", 29, "16:30", "17:15", { location: "online", zone: "America/Chicago" }),
  deadline("Werks1", "Prüfprotokoll Regale abgeben", 29),
  event("spaces", "TeamLg", "Retro Oktober", 30, "11:00", "12:00", { location: "Raum Elbe" }),
  event("intranet", "firmenevents", "Herbstfest", 30, "16:00", "21:00", { location: "Hof Nord", free: true }),
  allDay("absence", "team-logistik", "Malte Sommer · abwesend", 26, 29),
  allDay("absence", "team-logistik", "Tom Krüger · abwesend", 29, 31),
  allDay("absence", "feiertage", "Reformationstag", 31, 32),
  event("spaces", "Messe1", "Kickoff Herbstsaison", 1, "10:00", "11:00"),
  allDay("absence", "feiertage", "Tag der Deutschen Einheit", 3, 4),
  event("spaces", "TeamLg", "Touren-Review September", 5, "13:00", "14:00"),
  event("academy", "schulungen", "Brandschutzunterweisung", 7, "08:00", "09:30", { location: "Kantine" }),
  allDay("absence", "team-logistik", "Jana Berger · Urlaub", 12, 17),
  event("spaces", "Einkf1", "Angebot Kühlfahrzeug", 13, "10:00", "11:00"),
  event("spaces", "Werks1", "Abstimmung Werkstatt", 15, "11:00", "12:00"),
  allDay("spaces", "Messe1", "Schulungsvideos drehen", 19, 22),
  event("spaces", "Einkf1", "Kundentermin Lindner", 20, "10:00", "11:00"),
  event("intranet", "firmenevents", "Neue Kantine: Eröffnung", 23, "12:00", "13:00"),
  allDay("spaces", "Messe1", "Messe Logistik Nord, Hamburg", 35, 38),
  event("spaces", "Einkf1", "Jahresgespräch Spedition", 33, "14:00", "15:00"),
  busy(27, "14:00", "15:00"),
  busy(28, "10:00", "11:30"),
  busy(29, "09:00", "10:00"),
  busy(30, "13:00", "14:00"),
  busy(26, "16:00", "17:00"),
  event("shifts", "meine", "Frühschicht", 26, "06:00", "14:00", { location: "Halle 2" }),
  event("shifts", "meine", "Frühschicht", 27, "06:00", "14:00", { location: "Halle 2" }),
  event("shifts", "meine", "Frühschicht", 28, "06:00", "14:00", { location: "Halle 2" }),
);
export const ITEMS = items;

/** What a source answers for a range and the chosen calendars, as the Spaces route returns it. */
export const answerFor = (
  range: CalendarRange,
  keys: readonly string[],
  fixture: { failed?: readonly string[]; items?: SourcedCalendarItem[] } = {},
) => {
  const chosen = new Set(keys);
  const apps = [...new Set(keys.map((key) => key.slice(0, key.indexOf(":"))))];
  const failed = new Set(fixture.failed ?? []);
  return {
    items: (fixture.items ?? ITEMS).filter(
      (item) =>
        chosen.has(calendarKey(item.appId, item.calendarId)) &&
        !failed.has(item.appId) &&
        itemInRange(item, range, { timeZone: TIME_ZONE }),
    ),
    sources: apps.map((appId) => ({
      appId,
      state: failed.has(appId) ? ("failed" as const) : ("ok" as const),
      error: failed.has(appId) ? { code: "UNAVAILABLE", retryable: true } : null,
    })),
  };
};
