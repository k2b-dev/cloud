import { describe, expect, test } from "bun:test";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PublicSection, Venue, VenueDashboard } from "../../contracts";
import "../ssr-test-plugin";

const { default: VenueWorkspace } = await import("./VenueWorkspace.island.tsx");

const venue = (permission: Venue["permission"]): Venue => ({
  id: "Cafe01",
  slug: "corner-cafe",
  name: "Corner Café",
  icon: "ti ti-coffee",
  description: null,
  timezone: "Europe/Berlin",
  openMode: "combined",
  signupMode: "both",
  publicEnabled: false,
  feedbackEnabled: true,
  accentColor: "#2563eb",
  logoBase64: null,
  bannerBase64: null,
  icalToken: "calendar-token",
  permission,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

const section: PublicSection = {
  id: "Menu01",
  venueId: "Cafe01",
  kind: "menu",
  title: "Autumn menu",
  content: { items: [] },
  enabled: false,
  position: 0,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const render = (permission: Venue["permission"], sections: PublicSection[]) => {
  const dashboard: VenueDashboard = {
    venue: venue(permission),
    openingRules: [],
    overrides: [],
    templates: [],
    slots: [],
    assignments: [],
    myUpcomingShifts: [],
    myShiftCount: 0,
    sections,
    feedback: permission === "read" ? null : { count: 0, averageRating: null, buckets: [] },
    feedbackEntries: [],
  };
  return renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(VenueWorkspace, {
          dashboard,
          dashboardSource: { venueId: "Cafe01", query: {} },
          userId: "user-1",
          icalToken: "calendar-token",
          accessEntries: [],
          apiKeys: [],
          initialView: "shifts",
          initialCalendarView: "week",
          initialCalendarDate: "2026-09-28",
          initialFeedbackDays: 30,
          initialFeedbackSearch: "",
        });
      },
    }),
  );
};

describe("Venue workspace sidebar", () => {
  test("shows a reader without visible sections neither feedback nor an empty public content group", () => {
    const html = render("read", []);

    expect(html).toContain('href="/app/venue/Cafe01/shifts"');
    expect(html).not.toContain('href="/app/venue/Cafe01/feedback"');
    expect(html).not.toContain("Public content");
    expect(html).not.toContain("No sections yet.");
  });

  test("lists the sections a reader's view contains", () => {
    const html = render("read", [{ ...section, enabled: true }]);

    expect(html).toContain("Public content");
    expect(html).toContain('href="/app/venue/Cafe01/public-sections/Menu01"');
  });

  test("gives staff the feedback view and hides an empty public content group", () => {
    const html = render("write", []);

    expect(html).toContain('href="/app/venue/Cafe01/feedback"');
    expect(html).not.toContain("Public content");
  });

  test("keeps the public content group with its empty state for admins", () => {
    const html = render("admin", []);

    expect(html).toContain('href="/app/venue/Cafe01/feedback"');
    expect(html).toContain("Public content");
    expect(html).toContain("Add public section");
    expect(html).toContain("No sections yet.");
  });
});
