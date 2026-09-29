import { describe, expect, test } from "bun:test";
import { dates } from "@k2b/stdlib";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PublicSection, ShiftAssignment, ShiftTemplate, UpcomingSlot, Venue, VenueDashboard } from "../../contracts";
import { venueMessages } from "../../messages";
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
  feedbackComments?: boolean;
  calendarDate?: string;
  calendarView?: "day" | "week" | "month" | "mobile-month";
  shift?: string;
  gaps?: boolean;
  locale?: string;
};

const render = (permission: Venue["permission"], sections: PublicSection[], options: RenderOptions = {}) => {
  const dashboard: VenueDashboard = {
    venue: venue(permission),
    openingRules: [],
    overrides: [],
    templates: [],
    slots: [],
    otherAssignments: [],
    outlook: { startDate: "2026-09-28", endDate: "2026-10-04", missingPeople: 0, nextGap: null },
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
          calendarUrl: "https://cloud.example.test/api/venue/calendar/calendar-token.ics",
          accessEntries: [],
          apiKeys: [],
          initialView: options.view ?? "shifts",
          initialSectionId: options.sectionId ?? null,
          initialCalendarView: options.calendarView ?? "week",
          initialCalendarDate: options.calendarDate ?? "2026-09-28",
          initialShiftId: options.shift ?? null,
          initialGapsOnly: options.gaps,
          initialFeedbackDays: 30,
          initialFeedbackSearch: options.feedbackSearch ?? "",
          initialFeedbackComments: options.feedbackComments,
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
    expect(admin).toContain("Visitors see this section exactly like this on the public page.");
    expect(admin).toContain("Draft Not on the public page. Only staff and admins see this draft. Choose Edit to publish it.");
    expect(admin).toContain(" Edit ");

    // A published section on a Venue whose public page is on.
    const live = { dashboard: { venue: { ...venue("admin"), publicEnabled: true } } };
    expect(text(render("admin", [published], { sectionId: "Menu01", ...live }))).toContain(
      "Public Visitors see this section on the public page.",
    );
  });

  test("previews a section with the public page's renderer and without a raw kind tag", () => {
    const notice: PublicSection = { ...section, id: "Note01", kind: "notice", title: "Closed on Friday", content: { text: "Team day" } };
    const html = render("admin", [notice], { sectionId: "Note01" });
    expect(html).toContain('data-section-kind="notice"');
    expect(html).toContain("k2b-notice-card");
    expect(html).not.toMatch(/class="tag"[^>]*>\s*(?:Notice|Menu|Markdown|Links)\s*</);

    const menu: PublicSection = {
      ...section,
      id: "Menu02",
      title: "Lunch",
      content: { items: [{ name: "Old soup", availableUntil: "2000-01-31" }, { name: "Fresh bread" }] },
    };
    const preview = text(render("admin", [menu], { sectionId: "Menu02" }));
    expect(preview).toContain("Fresh bread");
    expect(preview).not.toContain("Old soup");
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

const template: ShiftTemplate = {
  id: "Temp01",
  venueId: "Cafe01",
  weekday: 2,
  title: "Theke",
  startTime: "11:00",
  endTime: "14:00",
  minPeople: 1,
  maxPeople: 3,
  requireTargetForOpening: false,
  active: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const assignment = (overrides: Partial<ShiftAssignment>): ShiftAssignment => ({
  id: "Asg001",
  venueId: "Cafe01",
  templateId: "Temp01",
  templateTitle: "Theke",
  userId: "user-1",
  userDisplayName: "Alex Example",
  // Tuesday 29 September, 11:00–14:00 in Berlin.
  startsAt: "2026-09-29T09:00:00.000Z",
  endsAt: "2026-09-29T12:00:00.000Z",
  note: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

describe("Venue My shifts", () => {
  const shifts = [
    assignment({}),
    assignment({
      id: "Asg002",
      templateId: null,
      templateTitle: null,
      startsAt: "2026-10-01T15:00:00.000Z",
      endsAt: "2026-10-01T17:00:00.000Z",
      note: "Inventory count",
    }),
  ];
  const board = { templates: [template], myUpcomingShifts: shifts };

  test("names each shift with its day, time range, and template title in the venue's time zone", () => {
    const de = text(render("write", [], { view: "my-shifts", locale: "de", dashboard: board }));
    expect(de).toContain("Di., 29. Sept. · 11:00–14:00 · Theke");
    // Free time has no template: it reads as free time and shows its note.
    expect(de).toContain("Do., 1. Okt. · 17:00–19:00 · Freier Zeitraum Inventory count");

    const en = text(render("write", [], { view: "my-shifts", dashboard: board }));
    expect(en).toContain("Tue, Sep 29 · 11:00–14:00 · Theke");
    expect(en).toContain("Thu, Oct 1 · 17:00–19:00 · Free time Inventory count");
  });

  test("keeps the shift's name after its template was paused or deleted", () => {
    // Active templates are all the dashboard lists; the assignment still names its shift.
    const html = text(render("write", [], { view: "my-shifts", dashboard: { templates: [], myUpcomingShifts: [assignment({})] } }));
    expect(html).toContain("Tue, Sep 29 · 11:00–14:00 · Theke");
    expect(html).not.toContain("Free time");
  });

  test("offers Leave as an ordinary full-size button and a calendar subscription instead of a raw iCal link", () => {
    const html = render("write", [], { view: "my-shifts", dashboard: board });
    const leave = [...html.matchAll(/<button[^>]*>(?:(?!<\/button>).)*Leave(?:(?!<\/button>).)*<\/button>/g)].map((match) => match[0]);

    expect(leave).toHaveLength(2);
    for (const button of leave) {
      expect(button).toContain('data-variant="secondary"');
      expect(button).toContain('data-size="md"');
    }
    // Rows wrap instead of cutting the date line.
    expect(html).toContain("flex flex-wrap items-center justify-between");
    expect(text(html)).toContain("Subscribe to calendar");
    expect(html).not.toContain(".ics");
    expect(text(html)).not.toContain("iCal");
  });
});

describe("Venue shift states", () => {
  const today = dates.formatDateKey(new Date(), { timeZone: "Europe/Berlin" });
  const dayAfter = (days: number) => {
    const [year = 1970, month = 1, day = 1] = today.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
  };
  const slot = (date: string, overrides: Partial<UpcomingSlot> = {}): UpcomingSlot => ({
    date,
    template: { ...template, weekday: new Date(`${date}T12:00:00Z`).getUTCDay() },
    startsAt: `${date}T09:00:00.000Z`,
    endsAt: `${date}T12:00:00.000Z`,
    assignedCount: 0,
    minPeople: 1,
    maxPeople: 3,
    missingPeople: 1,
    full: false,
    assignments: [],
    ...overrides,
  });

  test("gives every state its own text and icon, and a tone color from the shared vocabulary", async () => {
    const { slotState, slotStaffingLabel } = await import("./venue-workspace/schedule");
    const { t } = venueMessages.resolve(["en"]);
    const now = new Date(`${dayAfter(1)}T08:00:00.000Z`);
    const full = slot(dayAfter(2), { assignedCount: 3, missingPeople: 0, full: true });
    const reached = slot(dayAfter(2), { assignedCount: 1, missingPeople: 0 });
    const missing = slot(dayAfter(2));
    const ended = slot(dayAfter(0));
    // Below target is urgent only for a shift that opens the venue and starts within a day.
    const urgent = slot(dayAfter(1), { template: { ...template, requireTargetForOpening: true } });
    const later = slot(dayAfter(3), { template: { ...template, requireTargetForOpening: true } });

    const states = [full, reached, missing, ended, urgent, later].map((entry) => {
      const { tone, color, icon, label } = slotState(entry, t, now);
      return { tone, color, icon, label };
    });
    expect(states).toEqual([
      { tone: "success", color: "emerald", icon: "ti ti-check", label: "Full" },
      { tone: "success", color: "emerald", icon: "ti ti-check", label: "Target reached" },
      { tone: "warning", color: "amber", icon: "ti ti-progress", label: "1 missing" },
      { tone: "neutral", color: "zinc", icon: "ti ti-history", label: "Ended" },
      { tone: "danger", color: "red", icon: "ti ti-alert-triangle", label: "1 missing" },
      { tone: "warning", color: "amber", icon: "ti ti-progress", label: "1 missing" },
    ]);
    expect(slotState(urgent, t, now).hint).toBe("The venue opens for this shift only once it is staffed.");
    expect(slotStaffingLabel(missing, t, now)).toBe("0 of 1–3 staffed · 1 missing");
    expect(slotStaffingLabel({ ...missing, maxPeople: null, minPeople: 2, missingPeople: 2 }, venueMessages.resolve(["de"]).t, now)).toBe(
      "0 von 2 besetzt · 2 fehlen",
    );
  });

  test("labels full, missing, and ended shifts in the calendar with text and an icon", () => {
    const upcoming = [
      slot(dayAfter(1), { template: { ...template, id: "Full01", title: "Early bar" }, assignedCount: 3, missingPeople: 0, full: true }),
      slot(dayAfter(1), {
        template: { ...template, id: "Miss01", title: "Late bar", startTime: "15:00", endTime: "18:00" },
        startsAt: `${dayAfter(1)}T13:00:00.000Z`,
        endsAt: `${dayAfter(1)}T16:00:00.000Z`,
      }),
    ];
    const past = [slot("2026-01-07", { template: { ...template, id: "Past01", title: "Old bar" } })];
    const html =
      render("write", [], { calendarDate: dayAfter(1), dashboard: { slots: upcoming } }) +
      render("write", [], { calendarDate: "2026-01-07", dashboard: { slots: past } });
    const entry = (title: string) =>
      html.match(new RegExp(`<[^>]*data-calendar-event[^>]*>(?:(?!data-calendar-event).)*${title}(?:(?!data-calendar-event).)*`))?.[0] ??
      "";

    expect(text(entry("Early bar"))).toContain("Full");
    expect(entry("Early bar")).toContain("ti ti-check");
    expect(text(entry("Late bar"))).toContain("1 missing");
    expect(entry("Late bar")).toContain("ti ti-progress");
    expect(text(entry("Old bar"))).toContain("Ended");
    expect(entry("Old bar")).toContain("ti ti-history");
  });
});

describe("Venue German workspace", () => {
  const en = venueMessages.resolve(["en"]).t as Record<string, unknown>;
  const de = venueMessages.resolve(["de"]).t as Record<string, unknown>;
  /** Every fixed English catalog text that German words differently. */
  const englishOnly = Object.keys(en).flatMap((key) =>
    typeof en[key] === "string" && en[key] !== de[key] ? [{ key, value: en[key] as string }] : [],
  );
  const today = dates.formatDateKey(new Date(), { timeZone: "Europe/Berlin" });
  // A fixed future Monday, so the open shift never reads as ended at some time of day.
  const shiftDay = "2030-01-07";

  test.each(["shifts", "my-shifts", "feedback"] as const)("shows no English catalog text in the %s view", (view) => {
    const html = text(
      render("admin", [], {
        view,
        locale: "de",
        calendarDate: shiftDay,
        dashboard: {
          templates: [template],
          myUpcomingShifts: [assignment({})],
          slots: [
            {
              date: shiftDay,
              template,
              startsAt: `${shiftDay}T20:00:00.000Z`,
              endsAt: `${shiftDay}T21:00:00.000Z`,
              assignedCount: 0,
              minPeople: 1,
              maxPeople: 3,
              missingPeople: 1,
              full: false,
              assignments: [],
            },
          ],
          feedback: { count: 2, averageRating: 3.5, commentCount: 1, buckets: [{ date: today, count: 2, averageRating: 3.5 }] },
          feedbackEntries: [{ venueId: "Cafe01", rating: 3, comment: null, createdAt: new Date().toISOString() }],
          feedbackEntriesPage: { page: 1, pageSize: 50, total: 1 },
        },
      }),
    );
    const leaks = englishOnly.filter(({ value }) =>
      new RegExp(`(^|[^\\p{L}])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "u").test(html),
    );
    expect(leaks).toEqual([]);
    // One missing person reads in the singular.
    if (view === "shifts") expect(html).toMatch(/Theke \d{2}:00–\d{2}:00 1 fehlt /);
  });
});

describe("Venue feedback evaluation", () => {
  const today = dates.formatDateKey(new Date(), { timeZone: "Europe/Berlin" });
  const feedback = {
    count: 3,
    averageRating: 3.67,
    commentCount: 1,
    buckets: [
      { date: "2026-09-26", count: 1, averageRating: 5 },
      { date: "2026-09-27", count: 2, averageRating: 3 },
    ],
  };
  const entries = [{ venueId: "Cafe01", rating: 4, comment: "Great espresso", createdAt: `${today}T10:00:00.000Z` }];

  test("plots the average without smoothing on a 1–5 axis and the number of ratings per day", () => {
    const html = render("admin", [], {
      view: "feedback",
      dashboard: { feedback, feedbackEntries: entries, feedbackEntriesPage: { page: 1, pageSize: 50, total: 1 } },
    });
    const line = html.match(/data-chart-kind="line"[\s\S]*?<\/svg>/)?.[0] ?? "";
    const bars = html.match(/data-chart-kind="bar"[\s\S]*?<\/svg>/)?.[0] ?? "";

    expect(line).not.toBe("");
    // Straight segments only: a smoothed line uses cubic curves (`C`) that overshoot 5/5.
    expect(line).not.toMatch(/ d="[^"]*C/);
    expect(text(line)).toContain("1/5");
    expect(text(line)).toContain("5/5");
    expect(bars).not.toBe("");
    expect(text(html)).toContain("Ratings per day");
  });

  test("draws filled stars and states the rating in words", () => {
    const html = render("admin", [], {
      view: "feedback",
      dashboard: { feedback, feedbackEntries: entries, feedbackEntriesPage: { page: 1, pageSize: 50, total: 1 } },
    });

    expect(html).toContain('role="img" aria-label="4 of 5 stars"');
    expect(html.match(/ti ti-star-filled/g)).toHaveLength(4);
  });

  test("keeps the comments filter in the search, days, and page links", () => {
    const html = render("admin", [], {
      view: "feedback",
      feedbackComments: true,
      dashboard: { feedback, feedbackEntries: entries, feedbackEntriesPage: { page: 1, pageSize: 50, total: 120 } },
    });

    expect(text(html)).toContain("Only with comment");
    expect(html).toContain('<input type="hidden" name="comments" value="1"');
    expect(html).toContain('href="/app/venue/Cafe01/feedback?comments=1&amp;page=2"');
    // The figures stay those of the whole window.
    expect(text(html)).toContain("Ratings 3");

    const empty = text(render("admin", [], { view: "feedback", feedbackComments: true, dashboard: { feedback } }));
    expect(empty).toContain("No rating with a comment in the last 30 days.");
  });
});

describe("Venue shift detail and schedule", () => {
  // A fixed future Tuesday in winter: 10:00 UTC is 11:00 in Berlin.
  const day = "2030-01-08";
  const person = (id: string, userId: string, name: string, overrides: Partial<ShiftAssignment> = {}) =>
    assignment({ id, userId, userDisplayName: name, startsAt: `${day}T10:00:00.000Z`, endsAt: `${day}T13:00:00.000Z`, ...overrides });
  const counter = (overrides: Partial<UpcomingSlot> = {}): UpcomingSlot => ({
    date: day,
    template,
    startsAt: `${day}T10:00:00.000Z`,
    endsAt: `${day}T13:00:00.000Z`,
    assignedCount: 1,
    minPeople: 2,
    maxPeople: 3,
    missingPeople: 1,
    full: false,
    assignments: [person("Asg002", "user-2", "Sam Sample")],
    ...overrides,
  });
  const staffed = counter({
    template: { ...template, id: "Temp02", title: "Evening bar", startTime: "17:00", endTime: "20:00" },
    startsAt: `${day}T16:00:00.000Z`,
    endsAt: `${day}T19:00:00.000Z`,
    assignedCount: 2,
    missingPeople: 0,
    assignments: [person("Asg003", "user-3", "Kim Muster"), person("Asg004", "user-4", "Lee Beispiel")],
  });
  const freeTime = person("Asg005", "user-5", "Robin Probe", {
    templateId: null,
    templateTitle: null,
    startsAt: `${day}T14:00:00.000Z`,
    endsAt: `${day}T15:00:00.000Z`,
    note: "Inventory count",
  });
  const board: Partial<VenueDashboard> = {
    templates: [template],
    slots: [counter(), staffed],
    otherAssignments: [freeTime],
    outlook: {
      startDate: "2030-01-07",
      endDate: "2030-01-13",
      missingPeople: 3,
      nextGap: {
        templateId: "Temp01",
        date: day,
        title: "Theke",
        startsAt: `${day}T10:00:00.000Z`,
        endsAt: `${day}T13:00:00.000Z`,
        missingPeople: 1,
      },
    },
  };
  const detailOf = (html: string) => html.match(/<aside[^>]*k2b-app-workspace__detail[\s\S]*?<\/aside>/)?.[0] ?? "";

  test("renders the selected shift's detail on the server, beside the calendar from 1024 px on", () => {
    const html = render("admin", [], { calendarDate: day, shift: `Temp01:${day}`, dashboard: board });
    const detail = detailOf(html);

    expect(detail).toContain("max-lg:hidden!");
    expect(detail).not.toMatch(/<aside[^>]*\shidden/);
    expect(text(detail)).toContain("Theke");
    expect(text(detail)).toContain("Tue, Jan 8 · 11:00–14:00");
    expect(text(detail)).toContain("1 of 2–3 staffed");
    expect(text(detail)).toContain("Sam Sample");
    // Admins remove other people; the viewer can still take the shift.
    expect(detail).toContain('aria-label="Remove Sam Sample"');
    expect(text(detail)).toContain("Take shift");
    expect(text(detail)).toContain("Also the next 4 weeks");

    // Without a selection, the detail stays closed.
    expect(detailOf(render("admin", [], { calendarDate: day, dashboard: board }))).toMatch(/<aside[^>]*\shidden/);
  });

  test("gives staff Take without Remove, and readers the detail without any action", () => {
    const staff = detailOf(render("write", [], { calendarDate: day, shift: `Temp01:${day}`, dashboard: board }));
    expect(text(staff)).toContain("Take shift");
    expect(staff).not.toContain("Remove Sam Sample");

    const reader = detailOf(render("read", [], { calendarDate: day, shift: `Temp01:${day}`, dashboard: board }));
    expect(text(reader)).toContain("Sam Sample");
    expect(text(reader)).not.toContain("Take shift");
    expect(text(reader)).not.toContain("Leave");
    expect(reader).not.toContain("Remove");

    // The viewer's own shift offers Leave instead of Take.
    const mine = detailOf(
      render("write", [], {
        calendarDate: day,
        shift: `Temp01:${day}`,
        dashboard: { ...board, slots: [counter({ assignments: [person("Asg001", "user-1", "Alex Example")] })] },
      }),
    );
    expect(text(mine)).toContain("Alex Example (you)");
    expect(text(mine)).toContain("Leave");
    expect(text(mine)).not.toContain("Take shift");
  });

  test("opens free time from the calendar in the same detail, also through its sign-up link", () => {
    const html = render("admin", [], { calendarDate: day, shift: "a:Asg005", dashboard: board });
    const detail = text(detailOf(html));
    expect(detail).toContain("Free time");
    expect(detail).toContain("Robin Probe");
    expect(detail).toContain("Inventory count");
    expect(detailOf(html)).toContain('aria-label="Remove Robin Probe"');

    // A sign-up for a paused shift keeps its name and says why the schedule no longer lists the shift.
    const paused = person("Asg006", "user-6", "Toni Test", { templateId: "Old001", templateTitle: "Old brunch" });
    const pausedDetail = text(
      detailOf(render("read", [], { calendarDate: day, shift: "a:Asg006", dashboard: { ...board, otherAssignments: [paused] } })),
    );
    expect(pausedDetail).toContain("Old brunch");
    expect(pausedDetail).toContain("This shift was paused or its time changed after the sign-up");
    expect(pausedDetail).not.toContain("Time someone added outside the recurring shifts.");

    // A sign-up link from My shifts opens the shift it belongs to.
    expect(text(detailOf(render("read", [], { calendarDate: day, shift: "a:Asg002", dashboard: board })))).toContain("Theke");
  });

  test("links every shift and free time to its detail and offers day, week, and month", () => {
    const html = render("write", [], { calendarDate: day, dashboard: board });
    expect(html).toContain(`href="/app/venue/Cafe01/shifts?cv=week&amp;cd=${day}&amp;shift=Temp01:${day}"`);
    expect(html).toContain(`href="/app/venue/Cafe01/shifts?cv=week&amp;cd=${day}&amp;shift=a:Asg005"`);
    expect(text(html)).toContain("Robin Probe");
    for (const view of ["day", "week", "month"]) expect(html).toContain(`cv=${view}&amp;cd=${day}"`);
    // No double-click path: calendar entries are single-activation links.
    expect(html).not.toContain("Don't show this confirmation again");
  });

  test("hides shifts without a gap and free time with the gaps filter, and keeps it in every link", () => {
    const html = render("write", [], { calendarDate: day, gaps: true, dashboard: board });
    expect(text(html)).toContain("Theke");
    expect(text(html)).not.toContain("Evening bar");
    expect(text(html)).not.toContain("Robin Probe");
    expect(html).toContain(`cv=month&amp;cd=${day}&amp;gaps=1"`);
    expect(text(render("write", [], { calendarDate: day, dashboard: board }))).toContain("Evening bar");
  });

  test("shows the week's figures in one row that does not change with the calendar view", () => {
    const outlook = (options: RenderOptions, permission: Venue["permission"] = "write") =>
      text(
        render(permission, [], { calendarDate: day, dashboard: board, ...options }).match(
          /<div[^>]*data-schedule-outlook[\s\S]*?<\/a>/,
        )?.[0] ?? "",
      );
    const week = outlook({});
    expect(week).toContain("This week: 3 spots free");
    expect(week).toContain("Next unstaffed shift: Tue 11:00 · Theke");
    expect(outlook({ calendarView: "month" })).toBe(week);
    expect(outlook({ calendarView: "day", calendarDate: "2030-02-01" })).toBe(week);
    expect(outlook({}, "read")).toContain("This week: 3 unfilled spots");
    expect(
      text(
        render("write", [], {
          calendarDate: day,
          dashboard: { ...board, outlook: { ...board.outlook!, missingPeople: 0, nextGap: null } },
        }),
      ),
    ).toContain("This week: no free spots Next unstaffed shift: none this week");
  });

  test("the phone month view lists the chosen day's shifts with their state in words", () => {
    const html = render("write", [], { calendarDate: day, calendarView: "mobile-month", dashboard: board });
    const agenda = html.match(/k2b-calendar-mobile-month__agenda[\s\S]*$/)?.[0] ?? "";
    expect(text(agenda)).toContain("Theke");
    expect(text(agenda)).toContain("1 missing");
    expect(text(agenda)).toContain("Target reached");
    // Its day cells pick a day in the same view.
    expect(html).toContain(`cv=mobile-month&amp;cd=${day}"`);
  });
});

describe("Venue shift detail permissions", () => {
  const slotFor = (overrides: Partial<UpcomingSlot> = {}): UpcomingSlot => ({
    date: "2030-01-08",
    template,
    startsAt: "2030-01-08T10:00:00.000Z",
    endsAt: "2030-01-08T13:00:00.000Z",
    assignedCount: 1,
    minPeople: 1,
    maxPeople: 2,
    missingPeople: 0,
    full: false,
    assignments: [assignment({ id: "Asg002", userId: "user-2", userDisplayName: "Sam Sample" })],
    ...overrides,
  });

  test("take needs staff with shift sign-up on an open shift; remove needs admin and another person", async () => {
    const { shiftDetailPermissions } = await import("./venue-workspace/shift-detail");
    const selection = (slot: UpcomingSlot) => ({ kind: "slot" as const, eventId: "Temp01:2030-01-08", slot });
    const other = slotFor().assignments[0]!;
    const now = new Date("2030-01-07T12:00:00.000Z");
    const allowed = (permission: Venue["permission"], slot = slotFor(), signupMode: Venue["signupMode"] = "both") => {
      const result = shiftDetailPermissions(selection(slot), { ...venue(permission), signupMode }, "user-1", now);
      return { take: result.take, leave: result.leave?.id ?? null, remove: result.remove(other) };
    };

    expect(allowed("read")).toEqual({ take: false, leave: null, remove: false });
    expect(allowed("write")).toEqual({ take: true, leave: null, remove: false });
    expect(allowed("admin")).toEqual({ take: true, leave: null, remove: true });
    expect(allowed("write", slotFor(), "free")).toMatchObject({ take: false });
    expect(allowed("write", slotFor({ full: true }))).toMatchObject({ take: false });
    const mine = slotFor({ assignments: [assignment({ id: "Asg001" }), other] });
    expect(allowed("write", mine)).toEqual({ take: false, leave: "Asg001", remove: false });
    // An ended shift keeps its record: nobody takes, leaves, or removes.
    const late = new Date("2030-01-09T00:00:00.000Z");
    const ended = shiftDetailPermissions(selection(mine), venue("admin"), "user-1", late);
    expect({ take: ended.take, leave: ended.leave, remove: ended.remove(other) }).toEqual({ take: false, leave: null, remove: false });
  });

  test("resolves a sign-up to the shift it belongs to and unknown selections to nothing", async () => {
    const { resolveShiftSelection } = await import("./venue-workspace/shift-detail");
    const board = { slots: [slotFor()], otherAssignments: [assignment({ id: "Asg009", templateId: null, templateTitle: null })] };
    expect(resolveShiftSelection(board, "a:Asg002")).toMatchObject({ kind: "slot", eventId: "Temp01:2030-01-08" });
    expect(resolveShiftSelection(board, "a:Asg009")).toMatchObject({ kind: "assignment", eventId: "a:Asg009" });
    expect(resolveShiftSelection(board, "Temp01:2030-01-08")).toMatchObject({ kind: "slot" });
    expect(resolveShiftSelection(board, "Temp01:2030-01-15")).toBeNull();
    expect(resolveShiftSelection(board, null)).toBeNull();
  });
});

describe("Venue workspace empty schedule", () => {
  test("shows admins of a venue without shifts the setup steps instead of an all-clear", () => {
    const html = render("admin", []);

    expect(html).toContain("Set up this venue");
    expect(html).toContain("Open schedule settings");
    expect(html).toMatch(/class="hidden [^"]*"[^>]*data-schedule-outlook/);
  });

  test("tells everyone else that no shifts are planned yet", () => {
    for (const permission of ["write", "read"] as const) {
      const html = render(permission, []);
      expect({
        permission,
        checklist: html.includes("Set up this venue"),
        empty: html.includes("No shifts are planned here yet."),
      }).toEqual({
        permission,
        checklist: false,
        empty: true,
      });
    }
  });
});
