import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { VenueView } from "../_components/venue-workspace/types";
import { parseCalendarView, parseShiftSelection } from "../schedule-url";
import {
  emptyDashboard,
  FIXTURE_NOW,
  fixtureDashboard,
  fixtureOverviewVenues,
  fixtureSettings,
  fixtureTemplates,
  fixtureUpcomingShifts,
  fixtureVenue,
  fixtureVenues,
  overviewVenue,
  venueProps,
  worstDashboard,
  worstUpcomingShifts,
} from "./fixtures";
import VenueOverviewScreen from "./VenueOverviewScreen";
import VenueScreen from "./VenueScreen";
import VenueSettingsScreen from "./VenueSettingsScreen";
import type { VenueSettingsTab } from "./venue-nav";

/**
 * Every Venue page for the browser tests, rendered from the address as the server would. `data-variant` picks the
 * data: `normal`, `worst` (break-ui) or `huge` (1,000 venues); `data-permission` the viewer's role.
 */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const variant = document.documentElement.dataset.variant ?? "normal";
const permission = (document.documentElement.dataset.permission ?? "admin") as "read" | "write" | "admin";
const worst = [
  fixtureVenue({
    id: "Long01",
    name: "Studentisches Kulturcafé im Erdgeschoss des Hauptgebäudes mit Außenterrasse und Leseecke",
    description: "Eine sehr lange Beschreibung ohne Punkt und Komma die einfach immer weiter geht",
  }),
  fixtureVenue({ id: "Kana01", name: "東京カフェ 🍰☕", description: null, accentColor: "#dc2626" }),
  fixtureVenue({ id: "One001", name: "X", description: null }),
];
const venues =
  variant === "huge"
    ? Array.from({ length: 1000 }, (_, index) => fixtureVenue({ id: `V${String(index).padStart(5, "0")}`, name: `Ort ${index + 1}` }))
    : variant === "worst"
      ? [...worst, ...fixtureVenues]
      : variant === "empty"
        ? []
        : fixtureVenues;

const screen = () => {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  if (path === "/app/venue") {
    // as the server answers: a page of at most 100 venues by name, with "more" when another page follows
    const listed =
      variant === "worst"
        ? [
            overviewVenue(worst[0]!, { kind: "opens", at: "2026-11-28T09:00:00.000Z" }),
            overviewVenue(worst[1]!, { kind: "staffed" }),
            overviewVenue(worst[2]!, { kind: "open", until: "2026-11-25T23:00:00.000Z" }),
            ...fixtureOverviewVenues,
          ]
        : params.get("q") === "nichts"
          ? []
          : venues.slice(0, 100).map((venue) => overviewVenue(venue));
    const none = { entries: [], total: 0, venues: 0, next: null };
    const shifts =
      variant === "worst" ? worstUpcomingShifts(listed) : variant === "empty" || variant === "noshifts" ? none : fixtureUpcomingShifts();
    return (
      <VenueOverviewScreen
        now={FIXTURE_NOW}
        venues={variant === "empty" ? [] : listed}
        morePages={venues.length > 100}
        page={1}
        shifts={shifts}
        templates={fixtureTemplates}
        initialQuery={params.get("q") ?? ""}
      />
    );
  }
  const view = (path.split("/")[4] ?? "shifts") as VenueView | "settings";
  if (view === "settings") {
    const tab =
      (["access", "schedule", "danger"] as const).find((entry) => entry === path.split("/")[5]) ?? ("general" satisfies VenueSettingsTab);
    const settings = fixtureSettings();
    // a venue nobody else works in yet
    if (variant === "alone") settings.accessEntries = [];
    return (
      <VenueSettingsScreen
        initial={settings}
        dashboard={{ venue: settings.venue, myShiftCount: fixtureDashboard().myShiftCount, feedback: fixtureDashboard().feedback }}
        tab={tab}
      />
    );
  }
  const base = venueProps();
  const venue = { ...base.dashboard.venue, permission, ...(variant === "worst" ? { name: worst[0]!.name } : {}) };
  return (
    <VenueScreen
      {...base}
      dashboard={{ ...(variant === "worst" ? worstDashboard() : variant === "empty" ? emptyDashboard() : base.dashboard), venue }}
      initialView={view}
      initialCalendarView={parseCalendarView(params.get("cv")) ?? "week"}
      initialCalendarDate={params.get("cd") ?? base.initialCalendarDate}
      initialShiftId={parseShiftSelection(params.get("shift"))}
      initialGapsOnly={params.get("gaps") === "1"}
    />
  );
};

render(() => <LocaleProvider locale="de">{screen()}</LocaleProvider>, host);
// When the page stood: milliseconds from the start of navigation, measured in the page.
document.body.dataset.readyAt = String(Math.round(performance.now()));
document.body.dataset.ready = "true";
