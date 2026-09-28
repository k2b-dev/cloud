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

type RenderOptions = {
  view?: "shifts" | "my-shifts" | "feedback";
  sectionId?: string;
  dashboard?: Partial<VenueDashboard>;
  feedbackSearch?: string;
  locale?: string;
};

const render = (permission: Venue["permission"], sections: PublicSection[], options: RenderOptions = {}) => {
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
    feedback: permission === "read" ? null : { count: 0, averageRating: null, commentCount: 0, buckets: [] },
    feedbackEntries: [],
    feedbackEntriesPage: null,
    ...options.dashboard,
  };
  return renderToString(() =>
    createComponent(LocaleProvider, {
      locale: options.locale ?? "en",
      get children() {
        return createComponent(VenueWorkspace, {
          dashboard,
          dashboardSource: { venueId: "Cafe01", query: {} },
          userId: "user-1",
          icalToken: "calendar-token",
          accessEntries: [],
          apiKeys: [],
          initialView: options.view ?? "shifts",
          initialSectionId: options.sectionId ?? null,
          initialCalendarView: "week",
          initialCalendarDate: "2026-09-28",
          initialFeedbackDays: 30,
          initialFeedbackSearch: options.feedbackSearch ?? "",
        });
      },
    }),
  );
};

/** Visible text without markup, so assertions do not depend on element structure. */
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

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

describe("Venue public sections show whether visitors see them", () => {
  const draft: PublicSection = { ...section, id: "Draft1", title: "Winter hours", enabled: false };
  const published: PublicSection = { ...section, id: "Menu01", title: "Autumn menu", enabled: true };

  test("marks drafts in the sidebar and leaves public sections unmarked", () => {
    const html = render("admin", [published, draft]);

    expect(text(html)).toContain("Winter hours Draft");
    expect(text(html)).not.toContain("Autumn menu Draft");
  });

  test("cuts long section titles and the add action with an ellipsis and keeps the full text in a tooltip", () => {
    const long = { ...draft, title: "Winter hours for the terrace and the reading room" };
    const html = render("admin", [published, long], { locale: "de" });
    const row = (label: string) => html.match(new RegExp(`<a[^>]*title="${label}"[^>]*>.*?</a>`))?.[0] ?? "";
    const addRow = html.match(/<button[^>]*title="Öffentlichen Abschnitt hinzufügen"[^>]*>.*?<\/button>/)?.[0] ?? "";

    // `data-marquee="false"` is the sidebar label's ellipsis mode.
    expect(row("Winter hours for the terrace and the reading room · Entwurf")).toContain('data-marquee="false"');
    expect(row("Autumn menu")).toContain('data-marquee="false"');
    expect(row("Autumn menu")).not.toContain("Entwurf");
    expect(addRow).toContain('data-marquee="false"');
  });

  test("states the section's visibility above its preview", () => {
    const admin = text(render("admin", [draft], { sectionId: "Draft1" }));
    expect(admin).toContain("Preview in the style of the public page.");
    expect(admin).toContain("Draft Not on the public page. Only staff and admins see this draft. Choose Edit to publish it.");
    expect(admin).toContain(" Edit ");

    // A published section on a Venue whose public page is on.
    const live = { dashboard: { venue: { ...venue("admin"), publicEnabled: true } } };
    expect(text(render("admin", [published], { sectionId: "Menu01", ...live }))).toContain(
      "Public Visitors see this section on the public page.",
    );
  });

  test("points staff, who have no Edit action, to admins for publishing", () => {
    const staff = text(render("write", [draft], { sectionId: "Draft1" }));
    expect(staff).toContain("Draft Not on the public page. Only staff and admins see this draft. Only admins can publish it.");
    expect(staff).not.toContain("Choose Edit");
    expect(staff).not.toContain(" Edit ");

    expect(text(render("write", [draft], { sectionId: "Draft1", locale: "de" }))).toContain(
      "Entwurf Nicht auf der öffentlichen Seite. Nur Personen mit Zugriff „Mitarbeit“ oder „Admin“ sehen diesen Entwurf. Veröffentlichen können nur Admins.",
    );
  });

  test("does not call a section public while the public page is switched off", () => {
    // The fixture Venue has its public page switched off.
    const html = text(render("admin", [published], { sectionId: "Menu01" }));
    expect(html).toContain("Public page off The public page is switched off, so visitors see nothing right now.");
    expect(html).not.toContain(" Public The public page");

    expect(text(render("admin", [published], { sectionId: "Menu01", locale: "de" }))).toContain(
      "Öffentliche Seite aus Die öffentliche Seite ist ausgeschaltet. Besucher sehen gerade nichts.",
    );
  });
});

describe("Venue feedback view", () => {
  const entries = Array.from({ length: 50 }, (_, index) => ({
    venueId: "Cafe01",
    rating: 4,
    comment: index % 2 === 0 ? `Comment ${index}` : null,
    createdAt: new Date(Date.UTC(2026, 8, 27, 10, index)).toISOString(),
  }));
  const feedback = {
    count: 120,
    averageRating: 3.94,
    commentCount: 61,
    buckets: [{ date: "2026-09-27", count: 120, averageRating: 3.94 }],
  };

  test("counts the whole window and pages the list through the same total", () => {
    const html = render("admin", [], {
      view: "feedback",
      locale: "de",
      dashboard: { feedback, feedbackEntries: entries, feedbackEntriesPage: { page: 2, pageSize: 50, total: 120 } },
    });

    expect(text(html)).toContain("Bewertungen 120");
    expect(text(html)).toContain("Kommentare 61");
    expect(text(html)).toContain("3,9/5");
    expect(text(html)).toContain("51–100 von 120 Bewertungen");
    expect(html).toContain('href="/app/venue/Cafe01/feedback?page=3"');
    // Submission times use the Venue's time zone: 10:00 UTC is 12:00 in Berlin.
    expect(text(html)).toContain("So., 27. Sept., 12:00");
  });

  test("keeps the search in page links and names it in the range", () => {
    const html = render("admin", [], {
      view: "feedback",
      feedbackSearch: "espresso",
      dashboard: { feedback, feedbackEntries: entries.slice(0, 2), feedbackEntriesPage: { page: 1, pageSize: 50, total: 2 } },
    });

    expect(text(html)).toContain("1–2 of 2 ratings with “espresso”");
    expect(text(html)).toContain("Ratings 120");
  });
});
