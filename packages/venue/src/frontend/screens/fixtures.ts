import type {
  PublicStatus,
  ShiftAssignment,
  ShiftTemplate,
  UpcomingSlot,
  Venue,
  VenueDashboard,
  VenueTemplateSummary,
} from "../../contracts";
import type { VenueWorkspaceProps } from "../_components/venue-workspace/types";
import type { VenueSettingsContext } from "./VenueSettingsScreen";

/** Invented data for the v2 screens' tests and previews; the page pins its clock to `FIXTURE_NOW`. */
export const FIXTURE_NOW = "2026-11-25T09:00:00.000Z";
export const SHIFT_DAY = "2026-11-26";

export const fixtureVenue = (patch: Partial<Venue> = {}): Venue => ({
  id: "Cafe01",
  slug: "campus-cafe",
  name: "Campus-Café Nord",
  icon: "ti ti-coffee",
  description: "Studentisches Café im Erdgeschoss",
  timezone: "Europe/Berlin",
  openMode: "combined",
  signupMode: "both",
  publicEnabled: true,
  feedbackEnabled: true,
  accentColor: "#b45309",
  logoBase64: null,
  bannerBase64: null,
  permission: "admin",
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-11-20T08:00:00.000Z",
  ...patch,
});

export const fixtureVenues: Venue[] = [
  fixtureVenue(),
  fixtureVenue({
    id: "Bar002",
    slug: "kellerbar",
    name: "Kellerbar",
    icon: "ti ti-glass-full",
    accentColor: "#7c3aed",
    permission: "write",
    publicEnabled: false,
    description: null,
  }),
  fixtureVenue({
    id: "Lab003",
    slug: "fahrradwerkstatt",
    name: "Fahrradwerkstatt",
    icon: "ti ti-bike",
    accentColor: "#047857",
    permission: "read",
    signupMode: "free",
    description: "Offene Werkstatt, Werkzeug und Ersatzteile",
  }),
  fixtureVenue({
    id: "Lib004",
    slug: "lesesaal",
    name: "Lesesaal Ost",
    icon: "ti ti-book",
    accentColor: "#2563eb",
    permission: "write",
    description: "Aufsicht und Ausleihe am Abend",
  }),
  fixtureVenue({
    id: "Gar005",
    slug: "gemeinschaftsgarten",
    name: "Gemeinschaftsgarten",
    icon: "ti ti-plant",
    accentColor: "#15803d",
    permission: "write",
    publicEnabled: false,
    signupMode: "both",
    description: "Gießdienst, Ernte und Werkzeugschuppen",
  }),
  fixtureVenue({
    id: "Kit006",
    slug: "mensa-kueche",
    name: "Mensa-Küche",
    icon: "ti ti-tools-kitchen-2",
    accentColor: "#dc2626",
    permission: "admin",
    description: "Ausgabe, Spüle und Vorbereitung",
  }),
  fixtureVenue({
    id: "Inf007",
    slug: "infotheke",
    name: "Infotheke Foyer",
    icon: "ti ti-info-circle",
    accentColor: "#0891b2",
    permission: "read",
    publicEnabled: false,
    description: "Fragen, Fundsachen und Raumschlüssel",
  }),
];

export const fixtureTemplates: VenueTemplateSummary[] = [
  { id: "cafe", name: "Café", description: "Öffnungszeiten, Schichten und eine Karte", icon: "ti ti-coffee" },
  { id: "workshop", name: "Werkstatt", description: "Freie Zeiten statt fester Schichten", icon: "ti ti-tool" },
] as VenueTemplateSummary[];

const template = (patch: Partial<ShiftTemplate> & Pick<ShiftTemplate, "id" | "title">): ShiftTemplate => ({
  venueId: "Cafe01",
  weekday: 4,
  date: null,
  startTime: "11:00",
  endTime: "14:00",
  minPeople: 3,
  maxPeople: 4,
  requireTargetForOpening: true,
  active: true,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
  ...patch,
});

const person = (
  id: string,
  userId: string,
  name: string,
  slot: { startsAt: string; endsAt: string },
  templateId: string | null,
  title: string | null,
): ShiftAssignment => ({
  id,
  venueId: "Cafe01",
  templateId,
  templateTitle: title,
  userId,
  userDisplayName: name,
  startsAt: slot.startsAt,
  endsAt: slot.endsAt,
  note: null,
  createdAt: "2026-11-20T08:00:00.000Z",
  updatedAt: "2026-11-20T08:00:00.000Z",
});

const lunchTimes = { startsAt: `${SHIFT_DAY}T10:00:00.000Z`, endsAt: `${SHIFT_DAY}T13:00:00.000Z` };
export const lunch: UpcomingSlot = {
  date: SHIFT_DAY,
  template: template({ id: "Temp01", title: "Mittagstheke" }),
  ...lunchTimes,
  assignedCount: 2,
  minPeople: 3,
  maxPeople: 4,
  missingPeople: 1,
  full: false,
  assignments: [
    person("Asg001", "user-2", "Kim Muster", lunchTimes, "Temp01", "Mittagstheke"),
    person("Asg002", "user-3", "Sam Beispiel", lunchTimes, "Temp01", "Mittagstheke"),
  ],
};
const eveningTimes = { startsAt: `${SHIFT_DAY}T16:00:00.000Z`, endsAt: `${SHIFT_DAY}T20:00:00.000Z` };
export const evening: UpcomingSlot = {
  date: SHIFT_DAY,
  template: template({ id: "Temp02", title: "Abendschicht", startTime: "17:00", endTime: "21:00", minPeople: 2, maxPeople: 2 }),
  ...eveningTimes,
  assignedCount: 2,
  minPeople: 2,
  maxPeople: 2,
  missingPeople: 0,
  full: true,
  assignments: [
    person("Asg003", "user-1", "Robin Example", eveningTimes, "Temp02", "Abendschicht"),
    person("Asg004", "user-4", "Jo Lange", eveningTimes, "Temp02", "Abendschicht"),
  ],
};

/** What the café sells this week, as its menu section lists it. */
const MENU = [
  { name: "Käsekuchen", description: "Mit Mürbeteig, nach Hausrezept", price: "2,80 €" },
  { name: "Apfelstrudel", description: "Warm, mit Vanillesoße", price: "3,20 €" },
  { name: "Cappuccino", price: "2,10 €" },
  { name: "Chai Latte", description: "Hafermilch auf Wunsch", price: "2,60 €" },
];

/** A shift of this week from its template, with the people who took it; open places follow from min and max. */
const slotOf = (
  date: string,
  shift: ShiftTemplate,
  times: { startsAt: string; endsAt: string },
  people: [id: string, userId: string, name: string][],
): UpcomingSlot => ({
  date,
  template: shift,
  ...times,
  assignedCount: people.length,
  minPeople: shift.minPeople,
  maxPeople: shift.maxPeople,
  missingPeople: Math.max(0, shift.minPeople - people.length),
  full: shift.maxPeople !== null && people.length >= shift.maxPeople,
  assignments: people.map(([id, userId, name]) => person(id, userId, name, times, shift.id, shift.title)),
});
const stocktaking = slotOf(
  "2026-11-25",
  template({ id: "Temp03", title: "Inventur", weekday: 3, startTime: "14:00", endTime: "17:00", minPeople: 2, maxPeople: 3 }),
  { startsAt: "2026-11-25T13:00:00.000Z", endsAt: "2026-11-25T16:00:00.000Z" },
  [
    ["Asg005", "user-5", "Alex Probe"],
    ["Asg006", "user-1", "Robin Example"],
  ],
);
const breakfast = slotOf(
  "2026-11-27",
  template({ id: "Temp04", title: "Frühstück", weekday: 5, startTime: "08:00", endTime: "11:00", minPeople: 2, maxPeople: 3 }),
  { startsAt: "2026-11-27T07:00:00.000Z", endsAt: "2026-11-27T10:00:00.000Z" },
  [["Asg007", "user-6", "Lea Sommer"]],
);
const brunch = slotOf(
  "2026-11-28",
  template({ id: "Temp05", title: "Brunch", weekday: 6, startTime: "09:00", endTime: "13:00", minPeople: 3, maxPeople: 5 }),
  { startsAt: "2026-11-28T08:00:00.000Z", endsAt: "2026-11-28T12:00:00.000Z" },
  [
    ["Asg008", "user-2", "Kim Muster"],
    ["Asg009", "user-7", "Ole Brandt"],
    ["Asg010", "user-1", "Robin Example"],
  ],
);

/** Two shifts next week, beyond the calendar's week, that the viewer took: the lunch still lacks one, breakfast is covered. */
const nextLunch = slotOf("2026-12-01", lunch.template, { startsAt: "2026-12-01T10:00:00.000Z", endsAt: "2026-12-01T13:00:00.000Z" }, [
  ["Asg011", "user-1", "Robin Example"],
  ["Asg013", "user-3", "Sam Beispiel"],
]);
const nextBreakfast = slotOf(
  "2026-12-04",
  breakfast.template,
  { startsAt: "2026-12-04T07:00:00.000Z", endsAt: "2026-12-04T10:00:00.000Z" },
  [
    ["Asg012", "user-1", "Robin Example"],
    ["Asg014", "user-6", "Lea Sommer"],
  ],
);
const nextWeek = [nextLunch.assignments[0]!, nextBreakfast.assignments[0]!];

/** The opening hours: Monday to Thursday 8–16, Friday 8–14, Saturday 9–13. */
const HOURS: Record<number, [string, string]> = {
  1: ["08:00", "16:00"],
  2: ["08:00", "16:00"],
  3: ["07:30", "16:00"],
  4: ["08:00", "18:00"],
  5: ["08:00", "14:00"],
  6: ["09:00", "13:00"],
};
const openingRules = [1, 2, 3, 4, 5, 6].map((weekday) => ({
  id: `Open0${weekday}`,
  venueId: "Cafe01",
  weekday,
  startTime: HOURS[weekday]![0],
  endTime: HOURS[weekday]![1],
  note: null,
  position: weekday - 1,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
}));

/** Seven ratings of the last days, three with words, as the counts above them say. */
const feedbackEntries = [
  { rating: 5, comment: "Bester Kuchen auf dem Campus!", createdAt: "2026-11-25T08:30:00.000Z" },
  { rating: 4, comment: "Freundlich, aber die Schlange war lang.", createdAt: "2026-11-25T07:50:00.000Z" },
  { rating: 5, comment: null, createdAt: "2026-11-25T07:10:00.000Z" },
  { rating: 3, comment: null, createdAt: "2026-11-24T14:10:00.000Z" },
  { rating: 4, comment: "Mehr vegane Brötchen wären schön.", createdAt: "2026-11-24T10:05:00.000Z" },
  { rating: 4, comment: null, createdAt: "2026-11-23T15:40:00.000Z" },
  { rating: 4, comment: null, createdAt: "2026-11-23T09:20:00.000Z" },
].map((entry) => ({ venueId: "Cafe01", ...entry }));

export const fixtureDashboard = (patch: Partial<VenueDashboard> = {}): VenueDashboard => ({
  venue: fixtureVenue(),
  openingRules,
  overrides: [],
  templates: [lunch.template, evening.template, stocktaking.template, breakfast.template, brunch.template],
  slots: [stocktaking, lunch, evening, breakfast, brunch, nextLunch, nextBreakfast],
  otherAssignments: [],
  outlook: {
    startDate: "2026-11-25",
    endDate: "2026-12-01",
    // Thursday's lunch and Friday's breakfast each miss one person
    missingPeople: 2,
    nextGap: { templateId: "Temp01", date: SHIFT_DAY, title: "Mittagstheke", ...lunchTimes, missingPeople: 1 },
  },
  assignments: [...stocktaking.assignments, ...lunch.assignments, ...evening.assignments, ...breakfast.assignments, ...brunch.assignments],
  // the viewer (user-1) works today's stocktaking, Thursday evening, Saturday's brunch and two shifts next week
  myUpcomingShifts: [stocktaking.assignments[1]!, evening.assignments[0]!, brunch.assignments[2]!, ...nextWeek],
  myShiftCount: 5,
  sections: [
    {
      id: "Sec001",
      venueId: "Cafe01",
      kind: "menu",
      title: "Kuchen und Getränke",
      content: { items: MENU },
      enabled: true,
      position: 1,
      createdAt: "2026-10-01T08:00:00.000Z",
      updatedAt: "2026-10-01T08:00:00.000Z",
    },
    {
      id: "Sec002",
      venueId: "Cafe01",
      kind: "notice",
      title: "Heute Lesung",
      content: { body: "Ab 19 Uhr" },
      enabled: false,
      position: 2,
      createdAt: "2026-10-01T08:00:00.000Z",
      updatedAt: "2026-10-01T08:00:00.000Z",
    },
  ],
  feedback: {
    count: 7,
    averageRating: 4.1,
    commentCount: 3,
    buckets: [
      { date: "2026-11-23", count: 2, averageRating: 4 },
      { date: "2026-11-24", count: 2, averageRating: 3.5 },
      { date: "2026-11-25", count: 3, averageRating: 4.7 },
    ],
  },
  feedbackEntries,
  feedbackEntriesPage: { page: 1, pageSize: 50, total: feedbackEntries.length },
  ...patch,
});

/** The page props of one venue, as the server builds them. */
export const venueProps = (patch: Partial<VenueWorkspaceProps> = {}): VenueWorkspaceProps => ({
  dashboard: fixtureDashboard(),
  dashboardSource: { venueId: "Cafe01", query: {} },
  userId: "user-1",
  calendarUrl: "https://cloud.example.test/api/venue/calendar/calendar-token.ics",
  accessEntries: [],
  apiKeys: [],
  initialView: "shifts",
  initialPublicPreview: fixturePreview(),
  initialCalendarView: "week",
  initialCalendarViewSource: "url",
  initialCalendarDate: SHIFT_DAY,
  initialFeedbackDays: 30,
  initialFeedbackSearch: "",
  ...patch,
});

/** The settings of the venue as the server reads them for the settings page. */
export const fixtureSettings = (): VenueSettingsContext => ({
  venue: fixtureVenue(),
  openingRules,
  overrides: [
    {
      id: "Exc001",
      venueId: "Cafe01",
      date: "2026-12-24",
      kind: "closed",
      startTime: null,
      endTime: null,
      note: "Heiligabend",
      createdAt: "2026-11-01T08:00:00.000Z",
      updatedAt: "2026-11-01T08:00:00.000Z",
    },
  ],
  templates: [lunch.template, evening.template, stocktaking.template, breakfast.template, brunch.template],
  accessEntries: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      principal: { type: "user", userId: "00000000-0000-4000-9000-000000000001" },
      permission: "admin",
      createdAt: "2026-09-01T08:00:00.000Z",
      displayName: "Kim Muster",
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      principal: { type: "user", userId: "00000000-0000-4000-9000-000000000002" },
      permission: "write",
      createdAt: "2026-09-02T08:00:00.000Z",
      displayName: "Sam Beispiel",
    },
    {
      id: "00000000-0000-4000-8000-000000000003",
      principal: { type: "user", userId: "00000000-0000-4000-9000-000000000003" },
      permission: "write",
      createdAt: "2026-09-03T08:00:00.000Z",
      displayName: "Alex Probe",
    },
    {
      id: "00000000-0000-4000-8000-000000000004",
      principal: { type: "group", groupId: "00000000-0000-4000-9000-000000000004" },
      permission: "read",
      createdAt: "2026-09-04T08:00:00.000Z",
      displayName: "Café-Team",
    },
  ],
  apiKeys: [],
});

/** The public page as visitors see it now: open until 16:00, the menu, and the next openings. */
export const fixturePreview = (): PublicStatus => {
  const dashboard = fixtureDashboard();
  return {
    venue: dashboard.venue,
    open: true,
    spontaneousOpen: false,
    statusLabel: "Geöffnet",
    todayLabel: "Heute 08:00–16:00",
    nextOpeningLabel: null,
    activeWindowLabel: "bis 16:00",
    upcomingOpenings: [
      { kind: "regular", title: "Geöffnet", startsAt: "2026-11-26T07:00:00.000Z", endsAt: "2026-11-26T15:00:00.000Z" },
      { kind: "regular", title: "Geöffnet", startsAt: "2026-11-27T07:00:00.000Z", endsAt: "2026-11-27T15:00:00.000Z" },
    ],
    upcomingExceptions: [],
    openingRules: dashboard.openingRules,
    sections: dashboard.sections.filter((section) => section.enabled),
  };
};

/** Worst-case data for the schedule and an open shift: an endless title, many people with long and non-Latin names. */
export const worstDashboard = (): VenueDashboard => {
  const dashboard = fixtureDashboard();
  const names = [
    "Maximiliane Theodora von Hohenstein-Liebenfels",
    "李小龍",
    "Ö",
    "Jean-Baptiste Emmanuel Zorg-Montgomery-Wellington",
    "Ada 🧁 Lovelace",
    "Bartholomäus Aloysius Wenzeslaus Prinz",
  ];
  const title = "Mittagstheke mit Kaffeeausschank, Kuchenverkauf, Pfandrücknahme und Fundsachen im Erdgeschoss Nordflügel";
  const crowded: UpcomingSlot = {
    ...lunch,
    template: { ...lunch.template, title, maxPeople: 12, minPeople: 10 },
    minPeople: 10,
    maxPeople: 12,
    assignedCount: names.length,
    missingPeople: 10 - names.length,
    assignments: names.map((name, index) => person(`Wst${index}`, `user-w${index}`, name, lunchTimes, "Temp01", title)),
  };
  return { ...dashboard, slots: dashboard.slots.map((slot) => (slot.template.id === "Temp01" ? crowded : slot)) };
};
