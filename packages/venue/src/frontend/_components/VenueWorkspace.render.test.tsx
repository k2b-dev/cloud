import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dates } from "@k2b/stdlib";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PublicSection, PublicStatus, ShiftAssignment, ShiftTemplate, UpcomingSlot, Venue, VenueDashboard } from "../../contracts";
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
  view?: "shifts" | "my-shifts" | "feedback" | "public";
  sectionId?: string;
  /** The Public page view's preview; `null` when the server could not build it. Defaults to one from the dashboard. */
  preview?: PublicStatus | null;
  dashboard?: Partial<VenueDashboard>;
  feedbackSearch?: string;
  feedbackComments?: boolean;
  calendarDate?: string;
  calendarView?: "day" | "week" | "month" | "mobile-month";
  shift?: string;
  gaps?: boolean;
  locale?: string;
};

/** The public page as the server previews it: closed, without hours, with the given sections. */
const previewOf = (previewVenue: Venue, sections: PublicSection[]): PublicStatus => ({
  venue: previewVenue,
  open: false,
  spontaneousOpen: false,
  statusLabel: "Closed",
  todayLabel: "Closed today",
  nextOpeningLabel: null,
  activeWindowLabel: null,
  upcomingOpenings: [],
  upcomingExceptions: [],
  openingRules: [],
  sections,
});

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
          initialPublicPreview:
            options.preview === undefined
              ? previewOf(
                  dashboard.venue,
                  dashboard.sections.filter((entry) => entry.enabled),
                )
              : options.preview,
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

/** The mobile navigation the host renders: the serialized entries of the workspace navigation. */
const mobileNavigation = (html: string) => {
  const json = html.match(/<script type="application\/json" data-cloud-workspace-navigation>(.*?)<\/script>/)?.[1] ?? "{}";
  return (JSON.parse(json) as { items: { id: string; label: string; href?: string; action?: string }[] }).items;
};
/** The desktop sidebar, expanded and collapsed, without the IDs a render generates. */
const sidebar = (html: string) => html.slice(html.indexOf("<aside"), html.indexOf("</aside>")).replace(/ id="[^"]*"/g, "");
const manySections = Array.from({ length: 12 }, (_, index) => ({
  ...section,
  id: `Sect${String(index).padStart(2, "0")}`,
  title: `Section number ${index}`,
  enabled: index % 2 === 0,
}));

describe("Venue workspace navigation by role", () => {
  const roles: { permission: "read" | "write" | "admin"; mobile: string[]; desktopItems: number; settings: boolean }[] = [
    { permission: "read", mobile: ["all", "shifts", "my-shifts", "public"], desktopItems: 3, settings: false },
    { permission: "write", mobile: ["signup", "all", "shifts", "my-shifts", "feedback", "public"], desktopItems: 4, settings: false },
    {
      permission: "admin",
      mobile: ["signup", "all", "shifts", "my-shifts", "feedback", "public", "settings"],
      desktopItems: 5,
      settings: true,
    },
  ];

  test.each(roles)("gives $permission a fixed set of entries, however many sections exist", ({ permission, mobile, desktopItems }) => {
    const empty = render(permission, []);
    const full = render(permission, manySections);

    expect(mobileNavigation(empty).map((item) => item.id)).toEqual(mobile);
    expect(mobileNavigation(full).map((item) => item.id)).toEqual(mobile);
    expect(sidebar(full)).toBe(sidebar(empty));
    expect(sidebar(full)).not.toContain("Section number");
    expect(JSON.stringify(mobileNavigation(full))).not.toContain("Section number");
    // Views and the public page in the expanded sidebar, plus Settings for admins.
    expect(sidebar(full).match(/class="k2b-app-workspace__sidebar-item /g)).toHaveLength(desktopItems);
  });

  test.each(roles)("shows the settings entry to $permission only when admin", ({ permission, settings }) => {
    const html = render(permission, []);
    expect(sidebar(html).includes("Venue settings")).toBe(settings);
    expect(mobileNavigation(html).some((item) => item.id === "settings")).toBe(settings);
  });

  test("opens the public page view for admins and the link dialog for everyone else", () => {
    const admin = mobileNavigation(render("admin", [])).find((item) => item.id === "public");
    expect(admin).toMatchObject({ label: "Public page", href: "/app/venue/Cafe01/public" });
    for (const permission of ["read", "write"] as const) {
      const html = render(permission, []);
      expect(mobileNavigation(html).find((item) => item.id === "public")).toMatchObject({ label: "Public page", action: "public" });
      expect(sidebar(html)).not.toContain('href="/app/venue/Cafe01/public"');
      expect(text(sidebar(html))).toContain("Public page");
    }
  });

  test("offers Take shift only where staff take shifts, and feedback only to staff and admins", () => {
    const freeOnly = { dashboard: { venue: { ...venue("write"), signupMode: "free" as const } } };
    expect(mobileNavigation(render("write", [], freeOnly)).map((item) => item.id)).not.toContain("signup");
    expect(sidebar(render("write", [], freeOnly))).not.toContain("Take a shift");
    expect(sidebar(render("read", []))).not.toContain('href="/app/venue/Cafe01/feedback"');
    expect(sidebar(render("write", []))).toContain('href="/app/venue/Cafe01/feedback"');
  });
});

describe("Venue public page view", () => {
  const draft: PublicSection = {
    ...section,
    id: "Draft1",
    title: "Winter hours",
    kind: "notice",
    content: { text: "Soon" },
    enabled: false,
  };
  const published: PublicSection = {
    ...section,
    id: "Menu01",
    title: "Autumn menu",
    enabled: true,
    content: { items: [{ name: "Pumpkin soup", price: "4.50" }] },
  };
  const on = { view: "public" as const, dashboard: { venue: { ...venue("admin"), publicEnabled: true } } };

  test("lists every section with its visibility and previews only what visitors see", () => {
    const html = render("admin", [published, draft], on);
    const list = html.slice(html.indexOf("data-public-sections"), html.indexOf("data-public-preview"));
    const preview = html.slice(html.indexOf("data-public-preview"));

    expect(text(list)).toContain("Autumn menu Menu");
    expect(text(list)).toContain("Winter hours Notice · Draft");
    // The draft state reads below the title, so a narrow list column leaves the title its room; hover names it in full.
    expect(list).not.toContain("k2b-settings-collection__item-status");
    expect(list).toContain('title="Winter hours"');
    expect(list).toContain('aria-label="Show “Winter hours” on the public page"');
    expect(list).toContain('aria-label="Move Autumn menu down"');
    expect(list).toContain('aria-label="Edit “Autumn menu”"');
    expect(list).toContain('aria-label="More actions for “Winter hours”"');
    expect(preview).toContain('data-public-layout="preview"');
    expect(text(preview)).toContain("Pumpkin soup");
    expect(text(preview)).not.toContain("Winter hours");
    expect(text(preview)).toContain("Visitors see the page like this right now.");
  });

  test("says in the preview how many stored links visitors cannot follow", () => {
    const links: PublicSection = {
      ...section,
      id: "Links1",
      kind: "links",
      title: "Useful links",
      enabled: true,
      content: {
        links: [
          { label: "Our site", href: "https://cafe.example.org" },
          { label: "Old", href: "www.cafe.example.org" },
        ],
      },
    };
    const preview = text(render("admin", [links], on).split("data-public-preview")[1] ?? "");
    expect(preview).toContain("Our site");
    expect(preview).toContain("Visitors don't see 1 link because its address");
  });

  test("puts the switch and the page, monitor, and open links on top while the page is on", () => {
    const html = render("admin", [published], on);
    const bar = html.slice(html.indexOf("data-public-page-bar"), html.indexOf("data-public-sections"));

    expect(bar).toMatch(/role="switch"[^>]*checked/);
    expect(text(bar)).toContain("Public page on");
    expect(text(bar)).toContain("Copy page link");
    expect(text(bar)).toContain("Copy monitor link");
    expect(bar).toContain('href="/app/venue/public/Cafe01"');
    expect(text(html)).not.toContain("The public page is off.");
  });

  test("still previews the page while it is off and says what visitors see", () => {
    const html = render("admin", [published], { view: "public" });
    const bar = html.slice(html.indexOf("data-public-page-bar"), html.indexOf("data-public-sections"));

    expect(bar).not.toMatch(/role="switch"[^>]*checked/);
    expect(text(html)).toContain("The public page is off. Its link shows only that the venue is not available.");
    expect(text(html)).toContain("Visitors see the page like this once you switch it on.");
    expect(text(html.slice(html.indexOf("data-public-preview")))).toContain("Pumpkin soup");
  });

  test("stacks the list above the preview below 1024 px, widens it from 1280 px, and gives every switch a 44 px target", () => {
    const html = render("admin", [published, draft], on);
    const grid = html.match(/<div class="grid items-start gap-4 ([^"]*)">/)?.[1] ?? "";
    // One column until `lg`, with the list first in the DOM, so a phone shows it above the preview.
    expect(grid).toBe("lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,32rem)_minmax(0,1fr)]");
    expect(html.indexOf("data-public-sections")).toBeLessThan(html.indexOf("data-public-preview"));
    const switches = html.match(/k2b-switch-field [^"]*/g) ?? [];
    expect(switches).toHaveLength(3);
    for (const field of switches) expect(field).toContain("[&amp;_.k2b-switch]:min-h-11");
  });

  test("offers the first section when there is none", () => {
    const html = render("admin", [], on);
    expect(text(html)).toContain("No sections yet.");
    expect(text(html)).toContain("Add section");
    expect(html).toContain('data-public-layout="preview"');
  });

  test("keeps the list usable when the preview could not be built", () => {
    const html = render("admin", [published], { ...on, preview: null });
    expect(text(html)).toContain("The preview could not be loaded. Retry");
    expect(html).not.toContain('data-public-layout="preview"');
    expect(text(html)).toContain("Autumn menu");
  });

  test("marks the section an old section link named, in the list and in the preview", () => {
    const html = render("admin", [published, draft], { ...on, sectionId: "Menu01" });
    expect(html).toMatch(/data-section-row="Menu01" data-selected=""/);
    expect(html).toMatch(/data-public-section="Menu01" data-selected=""/);
    expect(html).not.toMatch(/data-section-row="Draft1" data-selected/);
  });

  test("shows nothing of the editor to staff, whom the server sends to the schedule", () => {
    expect(render("write", [published], { view: "public" })).not.toContain("data-public-page-editor");
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

  test.each(["shifts", "my-shifts", "feedback", "public"] as const)("shows no English catalog text in the %s view", (view) => {
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

  test("marks a single day's average as a point and names each day once on the axis", () => {
    const html = render("admin", [], {
      view: "feedback",
      dashboard: {
        feedback: { count: 1, averageRating: 5, commentCount: 0, buckets: [{ date: "2026-09-28", count: 1, averageRating: 5 }] },
      },
    });
    const average = html.match(/data-chart-kind="(?:line|scatter)"[\s\S]*?<\/svg>/)?.[0] ?? "";
    expect(average).toMatch(/class="stdlib-chart-point/);
    expect(text(average).match(/Sep 28/g)).toHaveLength(1);

    const twoDays = render("admin", [], { view: "feedback", dashboard: { feedback } });
    const line = twoDays.match(/data-chart-kind="line"[\s\S]*?<\/svg>/)?.[0] ?? "";
    expect(text(line).match(/Sep 26/g)).toHaveLength(1);
    expect(text(line).match(/Sep 27/g)).toHaveLength(1);
  });

  test("shows each rating as stars and as a value, with glyphs the icon font has", () => {
    const html = render("admin", [], {
      view: "feedback",
      dashboard: { feedback, feedbackEntries: entries, feedbackEntriesPage: { page: 1, pageSize: 50, total: 1 } },
    });
    const cell = html.match(/<span role="img" aria-label="4 of 5 stars"[\s\S]*?\/5<\/span><\/span>/)?.[0] ?? "";

    expect(cell).not.toBe("");
    expect(cell.match(/ti ti-star text-sm text-amber-500/g)).toHaveLength(4);
    expect(cell.match(/ti ti-star text-sm text-zinc-300/g)).toHaveLength(1);
    expect(text(cell)).toContain("4/5");
    // A class the font lacks renders nothing: `ti-star-filled` left the rating cells empty.
    const shipped = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/icons/tabler.css")), "utf8");
    const glyphs = new Set([...shipped.matchAll(/\.ti-([a-z0-9-]+)/g)].map((match) => match[1]));
    const used = new Set([...html.matchAll(/\bti ti-([a-z0-9-]+)/g)].map((match) => match[1]));
    expect([...used].filter((glyph) => !glyphs.has(glyph))).toEqual([]);
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

  test("shows the next 7 days' figures in one row that does not change with the calendar view", () => {
    const outlook = (options: RenderOptions, permission: Venue["permission"] = "write") =>
      text(
        render(permission, [], { calendarDate: day, dashboard: board, ...options }).match(
          /<div[^>]*data-schedule-outlook[\s\S]*?<\/a>/,
        )?.[0] ?? "",
      );
    const week = outlook({});
    expect(week).toContain("Next 7 days: 3 spots free");
    expect(week).toContain("Next unstaffed shift: Tue 11:00 · Theke");
    expect(outlook({ calendarView: "month" })).toBe(week);
    expect(outlook({ calendarView: "day", calendarDate: "2030-02-01" })).toBe(week);
    expect(outlook({}, "read")).toContain("Next 7 days: 3 unfilled spots");
    expect(
      text(
        render("write", [], {
          calendarDate: day,
          dashboard: { ...board, outlook: { ...board.outlook!, missingPeople: 0, nextGap: null } },
        }),
      ),
    ).toContain("Next 7 days: no free spots Next unstaffed shift: none in the next 7 days");
  });

  test("links every calendar date to the venue's own day east of UTC", () => {
    // Berlin is ahead of UTC, so the calendar's day starts at 22:00 or 23:00 UTC of the day before.
    const hrefOf = (html: string, pattern: RegExp) => html.match(pattern)?.[1]?.replaceAll("&amp;", "&");
    const week = render("write", [], { calendarDate: "2026-10-05", calendarView: "week" });
    expect(hrefOf(week, /aria-label="Previous"[^>]*href="([^"]*)"/)).toBe("/app/venue/Cafe01/shifts?cv=week&cd=2026-09-28");
    expect(hrefOf(week, /aria-label="Next"[^>]*href="([^"]*)"/)).toBe("/app/venue/Cafe01/shifts?cv=week&cd=2026-10-12");
    // A day header opens that day, not the one before.
    expect(week).toContain('href="/app/venue/Cafe01/shifts?cv=day&amp;cd=2026-10-07"');
    expect(week).not.toContain('href="/app/venue/Cafe01/shifts?cv=day&amp;cd=2026-10-04"');
    // Today is the venue's today.
    const today = dates.formatDateKey(new Date(), { timeZone: "Europe/Berlin" });
    expect(hrefOf(week, /k2b-calendar-header__today[^>]*href="([^"]*)"/)).toBe(`/app/venue/Cafe01/shifts?cv=week&cd=${today}`);
    // The view switch keeps the shown day.
    expect(week).toContain('href="/app/venue/Cafe01/shifts?cv=day&amp;cd=2026-10-05"');

    // Across the change to winter time, a day forward is still the next day.
    const day = render("write", [], { calendarDate: "2026-10-24", calendarView: "day" });
    expect(hrefOf(day, /aria-label="Next"[^>]*href="([^"]*)"/)).toBe("/app/venue/Cafe01/shifts?cv=day&cd=2026-10-25");
    expect(text(day)).toContain("Saturday, October 24");
    // Noon UTC is already the next day in Auckland; the calendar still shows the day of the link.
    const auckland = render("write", [], {
      calendarDate: "2026-10-24",
      calendarView: "day",
      dashboard: { venue: { ...venue("write"), timezone: "Pacific/Auckland" } },
    });
    expect(text(auckland)).toContain("Saturday, October 24");
    expect(hrefOf(auckland, /aria-label="Next"[^>]*href="([^"]*)"/)).toBe("/app/venue/Cafe01/shifts?cv=day&cd=2026-10-25");

    // A tapped day in the phone month selects that day and asks for its list; a month step only browses.
    const month = render("write", [], { calendarDate: "2026-09-29", calendarView: "mobile-month" });
    expect(month).toContain('href="/app/venue/Cafe01/shifts?cv=mobile-month&amp;cd=2026-09-30&amp;focus=day"');
    expect(hrefOf(month, /aria-label="Next"[^>]*href="([^"]*)"/)).toBe("/app/venue/Cafe01/shifts?cv=mobile-month&cd=2026-10-29");
    expect(hrefOf(month, /aria-label="Previous"[^>]*href="([^"]*)"/)).toBe("/app/venue/Cafe01/shifts?cv=mobile-month&cd=2026-08-29");
    expect(hrefOf(month, /k2b-calendar-header__today[^"]*"[^>]*href="([^"]*)"/)).toMatch(
      /^\/app\/venue\/Cafe01\/shifts\?cv=mobile-month&cd=\d{4}-\d{2}-\d{2}$/,
    );
  });

  test("the phone month view lists the chosen day's shifts with their state in words", () => {
    const html = render("write", [], { calendarDate: day, calendarView: "mobile-month", dashboard: board });
    const agenda = html.match(/k2b-calendar-mobile-month__agenda[\s\S]*$/)?.[0] ?? "";
    expect(text(agenda)).toContain("Theke");
    expect(text(agenda)).toContain("1 missing");
    expect(text(agenda)).toContain("Target reached");
    // Its day cells pick a day in the same view.
    expect(html).toContain(`cv=mobile-month&amp;cd=${day}&amp;focus=day"`);
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
