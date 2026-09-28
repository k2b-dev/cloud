import { describe, expect, test } from "bun:test";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { Venue, VenueDashboard } from "../../../contracts";
import "../../ssr-test-plugin";

const { SettingsDialog } = await import("./settings");

const dashboard = (permission: Venue["permission"]): VenueDashboard => ({
  venue: {
    id: "Cafe01",
    slug: "corner-cafe",
    name: "Corner Café",
    icon: "ti ti-coffee",
    description: null,
    timezone: "Europe/Berlin",
    openMode: "combined",
    signupMode: "both",
    publicEnabled: true,
    feedbackEnabled: true,
    accentColor: "#2563eb",
    logoBase64: null,
    bannerBase64: null,
    icalToken: "calendar-token",
    permission,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
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
  feedback: null,
  feedbackEntries: [],
  feedbackEntriesPage: { page: 1, pageSize: 50, total: 0 },
});

const render = (permission: Venue["permission"], locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(SettingsDialog, {
          dashboard: dashboard(permission),
          accessEntries: [],
          apiKeys: [],
          onOpenCalendarSubscription: () => {},
          close: () => {},
        });
      },
    }),
  );

describe("Venue settings: General", () => {
  test("shows staff the settings read-only and says who can change them", () => {
    const html = render("write");

    expect(html).toContain("Only admins of this venue can change these settings.");
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    expect(html).not.toContain("No unsaved changes");
  });

  test("says the same in German", () => {
    expect(render("read", "de")).toContain("Nur Admins dieses Standorts können diese Einstellungen ändern.");
  });

  test("gives admins the save footer without the read-only note", () => {
    const html = render("admin");

    expect(html).not.toContain("Only admins of this venue can change these settings.");
    expect(html).toContain("No unsaved changes");
  });
});
