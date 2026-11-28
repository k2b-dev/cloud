import { dates } from "@k2b/stdlib";
import { type CalendarRange, type CalendarSourceView, calendarKey, itemInRange, type SourcedCalendarItem } from "./calendar-model";

// Invented data only: the team of the Space fixtures (Planning, Ideas, Trade fair 2026). Tuesday, October 27, 2026, 10:40 in Berlin.
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
      spaces("TeamLg", "Planning", "#6366f1"),
      spaces("Einkf1", "Ideas", "#2563eb"),
      spaces("Messe1", "Trade fair 2026", "#f97316"),
      spaces("Werks1", "Warehouse", "#10b981"),
    ],
  },
  {
    appId: "intranet",
    name: "Intranet",
    icon: "ti ti-building-community",
    state: "ok",
    error: null,
    calendars: [{ id: "firmenevents", name: "Company events", color: "#d97706", suggested: true, visibility: "details", writable: false }],
  },
  {
    appId: "absence",
    name: "Absences",
    icon: "ti ti-beach",
    state: "ok",
    error: null,
    calendars: [
      { id: "team-logistik", name: "Planning team", color: "#64748b", suggested: true, visibility: "details", writable: false },
      { id: "feiertage", name: "Public holidays", color: "#dc2626", suggested: true, visibility: "details", writable: false },
    ],
  },
  {
    appId: "academy",
    name: "Academy",
    icon: "ti ti-school",
    state: "ok",
    error: null,
    calendars: [{ id: "schulungen", name: "My trainings", color: "#06b6d4", suggested: true, visibility: "details", writable: false }],
  },
  {
    appId: "meetings",
    name: "Meetings",
    icon: "ti ti-users-group",
    state: "ok",
    error: null,
    calendars: [
      { id: "meine", name: "My meetings", color: "#ec4899", suggested: true, visibility: "details", writable: false },
      { id: "gf", name: "Management", color: "#71717a", suggested: false, visibility: "busy", writable: false },
    ],
  },
  {
    appId: "shifts",
    name: "Shift plan",
    icon: "ti ti-clock-hour-4",
    state: "ok",
    error: null,
    calendars: [{ id: "meine", name: "My shifts", color: "#65a30d", suggested: false, visibility: "details", writable: false }],
  },
];

const at = (day: string, time: string) => dates.zonedDateTimeToInstant(`${day}T${time}`, TIME_ZONE);
const oct = (day: number) => (day > 31 ? `2026-11-${String(day - 31).padStart(2, "0")}` : `2026-10-${String(day).padStart(2, "0")}`);
let sequence = 0;
const nextId = () => `Item${String(++sequence).padStart(2, "0")}`;
const open = (appId: string, calendarId: string, id: string) => ({
  rel: "open" as const,
  href: appId === "spaces" ? `/app/spaces/${calendarId}?item=${id}` : `https://${appId}.example.org/${id}`,
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
      event("spaces", "TeamLg", "Stand-up", day, "09:15", "09:30", {
        location: "Ramp 1",
        series: { id: "Standup", rule: "FREQ=WEEKLY;BYDAY=TU,WE,TH,FR" },
      }),
    );
  if (weekday === 1)
    items.push(
      event("spaces", "TeamLg", "Week kickoff", day, "09:00", "09:30", {
        location: "Ramp 1",
        series: { id: "Wochenstart", rule: "FREQ=WEEKLY;BYDAY=MO" },
      }),
    );
  if (weekday === 2)
    items.push(
      event("meetings", "meine", "Team meeting", day, "15:00", "16:00", {
        location: "Room Elbe",
        series: { id: "TeamMeeting", rule: "FREQ=WEEKLY;BYDAY=TU" },
      }),
    );
}
items.push(
  event("spaces", "Einkf1", "Ask the film supplier for quotes", 26, "11:00", "12:00"),
  event("spaces", "Messe1", "Plan the trade fair stand", 26, "14:00", "15:30", { location: "Room Elbe" }),
  event("spaces", "Werks1", "Forklift inspection", 27, "10:30", "11:30", { location: "Hall 2" }),
  event("spaces", "Einkf1", "Call with the forwarder", 27, "13:00", "13:45", { location: "online" }),
  event("academy", "schulungen", "First aid refresher", 28, "08:30", "12:00", { location: "Training room 1" }),
  event("spaces", "Messe1", "Pack the stand material", 28, "13:00", "15:00", { location: "South store" }),
  deadline("Einkf1", "Approve invoices", 28, "16:00"),
  event("academy", "schulungen", "Forklift licence – theory", 29, "13:00", "15:00", { location: "Training room 2" }),
  event("intranet", "firmenevents", "All-Hands Q4", 29, "15:30", "16:30", { location: "Canteen and online" }),
  event("meetings", "meine", "Call with the Chicago partner", 29, "16:30", "17:15", { location: "online", zone: "America/Chicago" }),
  deadline("Werks1", "Hand in the shelf inspection report", 29),
  event("spaces", "TeamLg", "October retro", 30, "11:00", "12:00", { location: "Room Elbe" }),
  event("intranet", "firmenevents", "Autumn party", 30, "16:00", "21:00", { location: "North yard", free: true }),
  allDay("absence", "team-logistik", "Sam Example · away", 26, 29),
  allDay("absence", "team-logistik", "Kim Example · away", 29, 31),
  allDay("absence", "feiertage", "Reformation Day", 31, 32),
  event("spaces", "Messe1", "Autumn season kickoff", 1, "10:00", "11:00"),
  allDay("absence", "feiertage", "German Unity Day", 3, 4),
  event("spaces", "TeamLg", "September route review", 5, "13:00", "14:00"),
  event("academy", "schulungen", "Fire safety briefing", 7, "08:00", "09:30", { location: "Canteen" }),
  allDay("absence", "team-logistik", "Robin Example · holiday", 12, 17),
  event("spaces", "Einkf1", "Quote for the refrigerated van", 13, "10:00", "11:00"),
  event("spaces", "Werks1", "Warehouse check-in", 15, "11:00", "12:00"),
  allDay("spaces", "Messe1", "Film the training videos", 19, 22),
  event("spaces", "Einkf1", "Customer visit", 20, "10:00", "11:00"),
  event("intranet", "firmenevents", "New canteen opening", 23, "12:00", "13:00"),
  allDay("spaces", "Messe1", "Trade fair, Hamburg", 35, 38),
  event("spaces", "Einkf1", "Annual review with the forwarder", 33, "14:00", "15:00"),
  busy(27, "14:00", "15:00"),
  busy(28, "10:00", "11:30"),
  busy(29, "09:00", "10:00"),
  busy(30, "13:00", "14:00"),
  busy(26, "16:00", "17:00"),
  event("shifts", "meine", "Early shift", 26, "06:00", "14:00", { location: "Hall 2" }),
  event("shifts", "meine", "Early shift", 27, "06:00", "14:00", { location: "Hall 2" }),
  event("shifts", "meine", "Early shift", 28, "06:00", "14:00", { location: "Hall 2" }),
);
export const ITEMS = items;

/** The Spaces sidebar beside the calendar. */
export const SIDEBAR = {
  spaces: [
    { id: "TeamLg", name: "Planning", color: "#6366f1", openItemCount: 9 },
    { id: "Einkf1", name: "Ideas", color: "#2563eb", openItemCount: 4 },
    { id: "Messe1", name: "Trade fair 2026", color: "#f97316", openItemCount: 12 },
    { id: "Werks1", name: "Warehouse", color: "#10b981", openItemCount: 2 },
  ],
  pinnedSpaceIds: [],
  recentSpaceIds: [],
  myWorkCount: 5,
};

/** The longest Space name the schema takes is 100 characters; a real one comes close. */
const LONG_SPACE = "Annual inventory of the north warehouse, the cold store, the returns area and all outside shelves";

/** The worst case: one Space with a name at the limit, many Spaces, and counts past a thousand. */
export const WORST_SIDEBAR = {
  spaces: [
    { id: "TeamLg", name: LONG_SPACE, color: "#6366f1", openItemCount: 12_840 },
    { id: "Einkf1", name: "Ideas", color: "#2563eb", openItemCount: 1 },
    { id: "Messe1", name: "会议准备", color: "#f97316", openItemCount: 0 },
    { id: "Werks1", name: "🎉 Sommerfest", color: "#10b981", openItemCount: 2 },
  ],
  pinnedSpaceIds: ["TeamLg"],
  recentSpaceIds: [],
  myWorkCount: 1_284,
};
export const WORST_SOURCES: CalendarSourceView[] = SOURCES.map((source) =>
  source.appId === "spaces"
    ? {
        ...source,
        calendars: source.calendars.map((calendar) => (calendar.id === "TeamLg" ? { ...calendar, name: LONG_SPACE } : calendar)),
      }
    : source,
);

/** 30 entries on today from four calendars, overlapping from 07:00 to 19:30, with long, short and foreign titles. */
const crowdedTitles = [
  "Annual safety briefing for all warehouse staff including temporary workers and the night shift",
  "X",
  "会议准备：年度预算审查",
  "🎉 Cake for Jo 🎂",
  "Check the notification settings of the warehouse management system",
  "Call with bartholomew.fitzgerald@northwind-industries-holdings.example.org",
  "Đặng Thị Ngọc Hân · onboarding",
  "Stand-up",
];
const crowdedCalendars = [
  ["spaces", "TeamLg"],
  ["spaces", "Einkf1"],
  ["meetings", "meine"],
  ["academy", "schulungen"],
] as const;
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
export const WORST_ITEMS: SourcedCalendarItem[] = [
  ...items,
  ...Array.from({ length: 30 }, (_, index) => {
    const [appId, calendarId] = crowdedCalendars[index % crowdedCalendars.length]!;
    const start = 7 * 60 + index * 25;
    return event(
      appId,
      calendarId,
      crowdedTitles[index % crowdedTitles.length]!,
      27,
      clock(start),
      clock(start + (index % 4 === 0 ? 120 : 45)),
      {
        location: index % 5 === 0 ? "Hall 2, loading ramp 4, behind the cold store (access through gate B)" : undefined,
      },
    );
  }),
  allDay("absence", "team-logistik", "Aleksandra Wiśniewska-Kowalczyk · parental leave until the end of January", 26, 31),
  allDay("absence", "team-logistik", "J · away", 27, 28),
  allDay("absence", "team-logistik", "نور الهدى عبد الرحمن · holiday", 27, 30),
  deadline("TeamLg", "Reconcile the north warehouse inventory list and hand it to accounting", 27, "17:00"),
];

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
