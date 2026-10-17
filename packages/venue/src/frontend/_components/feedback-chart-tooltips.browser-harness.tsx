import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { Venue, VenueDashboard } from "../../contracts";
import VenueWorkspace from "./VenueWorkspace.island";

const venue: Venue = {
  id: "Cafe01",
  slug: "corner-cafe",
  name: "Corner Café",
  icon: "ti ti-coffee",
  description: null,
  timezone: "Europe/Berlin",
  openMode: "combined",
  signupMode: "templates",
  publicEnabled: true,
  feedbackEnabled: true,
  accentColor: "#2563eb",
  logoBase64: null,
  bannerBase64: null,
  permission: "admin",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};
// `?single` shows one day with ratings, which the workspace draws as a point instead of a line.
const buckets: NonNullable<VenueDashboard["feedback"]>["buckets"] = new URLSearchParams(location.search).has("single")
  ? [{ date: "2026-09-28", count: 1, averageRating: 5 }]
  : [
      { date: "2026-09-26", count: 1, averageRating: 4.25 },
      { date: "2026-09-27", count: 2, averageRating: 3 },
      { date: "2026-09-28", count: 4, averageRating: 4.5 },
    ];
const dashboard: VenueDashboard = {
  venue,
  openingRules: [],
  overrides: [],
  templates: [],
  slots: [],
  otherAssignments: [],
  outlook: { startDate: "2026-09-28", endDate: "2026-10-04", missingPeople: 0, nextGap: null },
  assignments: [],
  myUpcomingShifts: [],
  myShiftCount: 0,
  sections: [],
  feedback: { count: 7, averageRating: 4.07, commentCount: 0, buckets },
  feedbackEntries: [],
  feedbackEntriesPage: null,
};
// The workspace may refresh its dashboard; answer with the same data instead of a server.
globalThis.fetch = (async () => Response.json(dashboard)) as unknown as typeof fetch;

render(
  () => (
    <LocaleProvider locale={document.documentElement.lang}>
      <VenueWorkspace
        dashboard={dashboard}
        dashboardSource={{ venueId: "Cafe01", query: {} }}
        userId="user-1"
        calendarUrl="https://cloud.example.test/api/venue/calendar/calendar-token.ics"
        accessEntries={[]}
        apiKeys={[]}
        initialView="feedback"
        initialCalendarView="week"
        initialCalendarDate="2026-09-28"
        initialFeedbackDays={30}
        initialFeedbackSearch=""
      />
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
