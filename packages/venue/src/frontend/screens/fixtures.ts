import type { ShiftAssignment, ShiftTemplate, UpcomingSlot, Venue, VenueDashboard, VenueTemplateSummary } from "../../contracts";
import type { VenueWorkspaceProps } from "../_components/venue-workspace/types";

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

export const fixtureDashboard = (patch: Partial<VenueDashboard> = {}): VenueDashboard => ({
  venue: fixtureVenue(),
  openingRules: [],
  overrides: [],
  templates: [lunch.template, evening.template],
  slots: [lunch, evening],
  otherAssignments: [],
  outlook: {
    startDate: "2026-11-25",
    endDate: "2026-12-01",
    missingPeople: 1,
    nextGap: { templateId: "Temp01", date: SHIFT_DAY, title: "Mittagstheke", ...lunchTimes, missingPeople: 1 },
  },
  assignments: [...lunch.assignments, ...evening.assignments],
  myUpcomingShifts: [evening.assignments[0]!],
  myShiftCount: 1,
  sections: [],
  feedback: {
    count: 7,
    averageRating: 4.1,
    commentCount: 3,
    buckets: ["2026-11-23", "2026-11-24", "2026-11-25"].map((date, index) => ({
      date,
      count: index + 2,
      averageRating: 3.8 + index * 0.2,
    })),
  },
  feedbackEntries: [
    { venueId: "Cafe01", rating: 5, comment: "Bester Kuchen auf dem Campus!", createdAt: "2026-11-25T08:30:00.000Z" },
    { venueId: "Cafe01", rating: 3, comment: null, createdAt: "2026-11-24T14:10:00.000Z" },
  ],
  feedbackEntriesPage: { page: 1, pageSize: 50, total: 2 },
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
  initialCalendarView: "week",
  initialCalendarViewSource: "url",
  initialCalendarDate: SHIFT_DAY,
  initialFeedbackDays: 30,
  initialFeedbackSearch: "",
  ...patch,
});
