import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { CalendarItem, SpaceColumn } from "@/contracts";
import { CALENDAR_NEUTRAL_COLOR, CALENDAR_PRIORITY_COLORS, calendarPersonColor } from "./colors";
import { type CalendarColorBy, defaultCalendarFilter } from "./filter";
import type { CalendarView } from "./types";

const root = mkdtempSync(join(tmpdir(), "spaces-calendar-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: Calendar } = await import("./index");

describe("Spaces calendar toolbar", () => {
  test("uses an input button for New event", () => {
    const html = renderToString(() =>
      createComponent(Calendar, {
        spaceId: "Space1",
        items: [],
        columns: [],
        tags: [],
        filter: defaultCalendarFilter,
        view: "month",
        date: new Date("2026-08-16T00:00:00.000Z"),
        baseUrl: "/app/spaces/Space1",
        dateConfig: { locale: "en", timeZone: "UTC", weekStartsOn: 1 },
        canWrite: true,
      }),
    );

    expect(html).toMatch(/data-variant="input"[^>]*>.*New event<\/span><\/button>/);
    expect(html).toMatch(/class="k2b-calendar-month__day-target\s*"/);
    expect(html).toContain("view=calendar&amp;cv=day");
    expect(html).not.toContain("Create event on");
  });

  test("keeps precise empty-slot creation in the day view", () => {
    const html = renderToString(() =>
      createComponent(Calendar, {
        spaceId: "Space1",
        items: [],
        columns: [],
        tags: [],
        filter: defaultCalendarFilter,
        view: "day",
        date: new Date("2026-08-16T00:00:00.000Z"),
        baseUrl: "/app/spaces/Space1",
        dateConfig: { locale: "en", timeZone: "UTC", weekStartsOn: 1 },
        canWrite: true,
      }),
    );

    expect(html).toMatch(/class="k2b-calendar-time-grid__slot\s*"/);
    expect(html).toContain('data-interactive="true"');
  });

  test("passes the bounded description preview to large timed event cards", () => {
    const item: CalendarItem = {
      id: "Event1",
      spaceId: "Space1",
      spaceName: "Planning",
      spaceColor: "#3b82f6",
      title: "Customer demo",
      descriptionPreview: "Walk through the new workspace flow.",
      location: null,
      url: null,
      startsAt: "2026-08-16T09:00:00.000Z",
      endsAt: "2026-08-16T10:30:00.000Z",
      allDay: false,
      deadline: null,
      priority: null,
      recurrence: null,
      recurringEventId: null,
      recurrenceId: null,
      tags: [],
      columnId: "Col001",
      assignees: [],
    };
    const html = renderToString(() =>
      createComponent(Calendar, {
        spaceId: "Space1",
        items: [item],
        columns: [],
        tags: [],
        filter: defaultCalendarFilter,
        view: "day",
        date: new Date("2026-08-16T00:00:00.000Z"),
        baseUrl: "/app/spaces/Space1",
        dateConfig: { locale: "en", timeZone: "UTC", weekStartsOn: 1 },
        canWrite: false,
      }),
    );

    expect(html).toMatch(/<span class="mt-1 line-clamp-2[^"]*">Walk through the new workspace flow\.<\/span>/);
  });
});

const columns: SpaceColumn[] = [
  { id: "Col001", spaceId: "Space1", name: "To do", color: "#6b7280", rank: "1", isDone: false },
  { id: "Col002", spaceId: "Space1", name: "In progress", color: null, rank: "2", isDone: false },
];
const fair = { id: "Tag001", spaceId: "Space1", name: "Fair", color: "#8b5cf6" };
const press = { id: "Tag002", spaceId: "Space1", name: "Press", color: "#ec4899" };
const robin = { id: "11111111-1111-4111-8111-111111111111", displayName: "Robin Example", avatarHash: null };
const base = (patch: Partial<CalendarItem>): CalendarItem => ({
  id: "Item01",
  spaceId: "Space1",
  spaceName: "Spring fair",
  spaceColor: "#3b82f6",
  title: "Item",
  descriptionPreview: null,
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  tags: [],
  columnId: "Col001",
  assignees: [],
  ...patch,
});
const items: CalendarItem[] = [
  base({
    id: "Event1",
    title: "Stand meeting",
    startsAt: "2026-08-12T09:00:00.000Z",
    endsAt: "2026-08-12T10:00:00.000Z",
    tags: [fair, press],
    assignees: [robin],
  }),
  base({ id: "Task01", title: "Send the press kit", deadline: "2026-08-12T00:00:00.000Z", priority: "urgent", tags: [press] }),
  base({ id: "Task02", title: "Count the chairs", deadline: "2026-08-12T00:00:00.000Z", priority: "low", columnId: "Col002" }),
];
const renderView = (view: CalendarView, locale: "en" | "de", colorBy: CalendarColorBy = "tag") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return calendarFor(view, locale, colorBy);
      },
    }),
  );
const calendarFor = (view: CalendarView, locale: "en" | "de", colorBy: CalendarColorBy) =>
  createComponent(Calendar, {
    spaceId: "Space1",
    items,
    columns,
    tags: [fair, press],
    filter: { ...defaultCalendarFilter, colorBy },
    view,
    date: new Date("2026-08-12T00:00:00.000Z"),
    baseUrl: "/app/spaces/Space1",
    dateConfig: { locale, timeZone: "UTC", weekStartsOn: 1 },
    canWrite: true,
  });
/** Each rendered item by its title: its link markup up to the closing tag. */
const chip = (html: string, title: string) => {
  const match = new RegExp(`<a [^>]*data-calendar-event[^>]*>(?:(?!</a>).)*${title}(?:(?!</a>).)*</a>`, "s").exec(html);
  if (!match) throw new Error(`No calendar item "${title}"`);
  return match[0];
};

describe("Spaces calendar colors", () => {
  for (const locale of ["en", "de"] as const) {
    for (const view of ["day", "week", "month"] as const) {
      test(`${view} view in ${locale}: tag colors for events and tasks, tasks as markers, a flag for urgent work`, () => {
        const html = renderView(view, locale);
        const event = chip(html, "Stand meeting");
        const urgent = chip(html, "Send the press kit");
        const calm = chip(html, "Count the chairs");

        // The event's first tag fills its band; its second tag is a dot where there is room.
        expect(event).toContain("--k2b-calendar-accent:#8b5cf6");
        expect(event).not.toContain('data-display="marker"');
        expect(event).toMatch(
          /data-spaces-calendar-dots[^>]*>(?:<!--[^>]*-->)*<span class="size-1\.5 rounded-full" style="background-color:#ec4899"/,
        );
        expect(event).not.toContain("ti-checkbox");
        // A task takes its tag's color too, as a checkbox marker instead of a band.
        expect(urgent).toContain('data-display="marker"');
        expect(urgent).toContain("--k2b-calendar-accent:#ec4899");
        expect(urgent).toContain("ti ti-checkbox");
        expect(urgent).toContain(`title="${locale === "de" ? "Dringend" : "Urgent"}"`);
        // Marker and flag are visual only; the accessible name says what they show.
        expect(urgent).toContain(
          locale === "de"
            ? 'aria-label="Send the press kit, Fälligkeitsdatum, Priorität: Dringend"'
            : 'aria-label="Send the press kit, Deadline, Priority: Urgent"',
        );
        expect(calm).toContain(`aria-label="Count the chairs, ${locale === "de" ? "Fälligkeitsdatum" : "Deadline"}"`);
        expect(event).toContain(
          locale === "de" ? 'aria-label="Stand meeting, 09:00 bis 10:00"' : 'aria-label="Stand meeting, 09:00 to 10:00"',
        );
        // Without a tag, the status color; without one either, the calm neutral. Low priority shows no flag.
        expect(calm).toContain(`--k2b-calendar-accent:${CALENDAR_NEUTRAL_COLOR}`);
        expect(calm).not.toContain("data-spaces-calendar-flag");
        expect(html).not.toMatch(/data-color="(amber|red)"/);
      });
    }

    test(`year view in ${locale}: day indicators show the same item colors`, () => {
      const byTag = renderView("year", locale);
      expect(byTag).toContain(locale === "de" ? "Oktober" : "October");
      expect(byTag).toMatch(/class="k2b-calendar-year__indicator"[^>]*style="background-color:#8b5cf6"/);
      expect(renderView("year", locale, "status")).toMatch(/class="k2b-calendar-year__indicator"[^>]*style="background-color:#6b7280"/);
    });
  }

  test("status, priority, and person modes re-color the same items", () => {
    const status = renderView("month", "en", "status");
    expect(chip(status, "Stand meeting")).toContain("--k2b-calendar-accent:#6b7280");
    expect(chip(status, "Count the chairs")).toContain(`--k2b-calendar-accent:${CALENDAR_NEUTRAL_COLOR}`);
    expect(chip(status, "Stand meeting")).not.toContain("data-spaces-calendar-dots");

    const priority = renderView("month", "en", "priority");
    expect(chip(priority, "Send the press kit")).toContain(`--k2b-calendar-accent:${CALENDAR_PRIORITY_COLORS.urgent}`);
    expect(chip(priority, "Count the chairs")).toContain(`--k2b-calendar-accent:${CALENDAR_PRIORITY_COLORS.low}`);
    expect(chip(priority, "Stand meeting")).toContain(`--k2b-calendar-accent:${CALENDAR_NEUTRAL_COLOR}`);

    const person = renderView("month", "en", "person");
    expect(chip(person, "Stand meeting")).toContain(`--k2b-calendar-accent:${calendarPersonColor("Robin Example")}`);
    expect(chip(person, "Send the press kit")).toContain(`--k2b-calendar-accent:${CALENDAR_NEUTRAL_COLOR}`);
  });

  test("offers Reset in the scope menu for a changed filter, not for another color, and Reset keeps the color", () => {
    const resetSection = /role="group" aria-label="Filter actions"/;
    expect(renderView("month", "en", "person")).not.toMatch(resetSection);
    const filtered = renderToString(() =>
      createComponent(Calendar, {
        spaceId: "Space1",
        items,
        columns,
        tags: [fair, press],
        filter: { ...defaultCalendarFilter, type: "task", colorBy: "person" },
        view: "month",
        date: new Date("2026-08-12T00:00:00.000Z"),
        baseUrl: "/app/spaces/Space1",
        dateConfig: { locale: "en", timeZone: "UTC", weekStartsOn: 1 },
        canWrite: true,
      }),
    );
    expect(filtered).toMatch(resetSection);
  });

  test("keeps the color choice in every calendar link", () => {
    const html = renderView("month", "de", "person");
    expect(html).toContain("view=calendar&amp;cv=day");
    expect([...html.matchAll(/href="([^"]*view=calendar[^"]*)"/g)].every(([, href]) => href!.includes("ccolor=person"))).toBe(true);
    expect(renderView("month", "en")).not.toContain("ccolor=");
  });
});
