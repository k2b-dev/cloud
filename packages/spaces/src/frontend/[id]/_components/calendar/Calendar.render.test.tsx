import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { CalendarItem, SpaceColumn, SpaceItem } from "@/contracts";
import { spaceMessages } from "../../messages";
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

    expect(html).toMatch(/data-variant="input"[^>]*>.*<span class="max-sm:sr-only">New event<\/span><\/span><\/button>/);
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
      activeBlockerCount: 0,
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
  activeBlockerCount: 0,
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

  test("offers the day, week, month, and year views, and no timeline", () => {
    const html = renderView("month", "de");
    expect([...html.matchAll(/role="radio"[^>]*href="[^"]*cv=(\w+)[^"]*"/g)].map(([, view]) => view)).toEqual([
      "day",
      "week",
      "month",
      "year",
    ]);
    expect(html).not.toContain("cv=timeline");
    expect(html).not.toContain("Zeitleiste");
  });
});

describe("Spaces task tray below the day view", () => {
  const task = (id: string, title: string, extra: Partial<SpaceItem> = {}): SpaceItem => ({
    id,
    spaceId: "Space1",
    columnId: "Col001",
    title,
    description: null,
    location: null,
    url: null,
    startsAt: null,
    endsAt: null,
    allDay: false,
    deadline: null,
    estimatedDurationMinutes: null,
    activeBlockerCount: 0,
    priority: null,
    recurrence: null,
    recurringEventId: null,
    recurrenceId: null,
    rank: "1024",
    completedAt: null,
    createdBy: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    assignees: [],
    tags: [],
    ...extra,
  });
  const overdue = [
    task("Late01", "Countersign the contract", { deadline: "2026-10-06T15:00:00.000Z" }),
    task("Late02", "Send wireframe feedback", { deadline: "2026-10-05T15:00:00.000Z", activeBlockerCount: 1 }),
  ];
  const undated = [task("Open01", "Clean up the customer list"), task("Open02", "Order trade fair giveaways")];
  const render = (options: {
    canWrite?: boolean;
    locale?: string;
    filter?: typeof defaultCalendarFilter;
    view?: CalendarView;
    tray: { overdue: { items: SpaceItem[]; total: number }; undated: { items: SpaceItem[]; total: number } } | null;
  }) => {
    const locale = options.locale ?? "en";
    const filter = options.filter ?? defaultCalendarFilter;
    return renderToString(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(Calendar, {
            spaceId: "Space1",
            items: [],
            columns: [],
            tags: [],
            filter,
            view: options.view ?? "day",
            date: new Date("2026-10-08T00:00:00.000Z"),
            baseUrl: "/app/spaces/Space1?view=calendar&cv=day",
            dateConfig: { locale, timeZone: "UTC", weekStartsOn: 1 },
            canWrite: options.canWrite ?? true,
            tray: options.tray,
          });
        },
      }),
    );
  };

  test("reads overdue tasks and the reader's undated tasks after the day, where they show", () => {
    const html = render({ tray: { overdue: { items: overdue, total: 7 }, undated: { items: undated, total: 2 } } });
    const tray = html.indexOf('aria-label="Overdue tasks and your tasks without a date"');
    expect(tray).toBeGreaterThan(-1);
    // The document follows the screen, so Tab and a screen reader reach the row below the day after it.
    expect(tray).toBeGreaterThan(html.lastIndexOf("k2b-calendar-time-grid__slot"));
    expect(html).not.toContain("order-last");
    expect(html.indexOf(">Overdue</h3>")).toBeLessThan(html.indexOf(">Yours, no date</h3>"));
    expect(html.indexOf("Countersign the contract")).toBeLessThan(html.indexOf("Clean up the customer list"));
    // Items open their detail on the day shown.
    expect(html).toContain('href="/app/spaces/Space1?view=calendar&amp;cv=day&amp;cd=2026-10-08&amp;item=Late01"');
    // A blocked task has no checkbox and says why; every other task can be checked off.
    expect(html).toContain('aria-label="Mark complete: Countersign the contract"');
    expect(html).not.toContain('aria-label="Mark complete: Send wireframe feedback"');
    expect(html).toContain("Blocked by 1");
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    // Only a part with more tasks than it shows links to the list with all of them, under the same query.
    expect(html).toContain('aria-label="Show all 7 overdue tasks"');
    expect(html).toContain('href="/app/spaces/Space1?view=list&amp;type=task&amp;deadline=overdue&amp;sortDesc=true"');
    expect(html).not.toContain("Show all 2");
  });

  test("keeps the list link on the calendar's filter, and the reader's undated tasks on them", () => {
    const filter = { ...defaultCalendarFilter, assignedTo: "assigned" as const, priorities: ["urgent" as const], tagIds: ["Tag001"] };
    const html = render({ filter, tray: { overdue: { items: [], total: 0 }, undated: { items: undated, total: 9 } } });
    expect(html).not.toContain(">Overdue</h3>");
    expect(html).toContain(
      'href="/app/spaces/Space1?view=list&amp;type=task&amp;priority=urgent&amp;tags=Tag001&amp;assignedTo=me&amp;deadline=none&amp;sort=priority"',
    );
  });

  test("offers no checkbox to a reader who may not change tasks", () => {
    const html = render({ canWrite: false, tray: { overdue: { items: overdue, total: 2 }, undated: { items: undated, total: 2 } } });
    expect(html).toContain("Countersign the contract");
    expect(html).not.toContain('type="checkbox"');
  });

  test("keeps its row with a quiet note when nothing waits, in German too", () => {
    const empty = { overdue: { items: [], total: 0 }, undated: { items: [], total: 0 } };
    expect(render({ tray: empty })).toContain("Nothing overdue, and no tasks of yours without a date");
    const german = render({ locale: "de", tray: { overdue: { items: overdue, total: 2 }, undated: empty.undated } });
    expect(german).toContain(">Überfällig</h3>");
    expect(german).toContain('aria-label="Überfällige Aufgaben und deine Aufgaben ohne Datum"');
    expect(render({ locale: "de", tray: empty })).toContain("Nichts überfällig und keine Aufgaben ohne Datum für dich");
  });

  test("says that the filter leaves nothing, rather than that nothing waits, when the calendar is filtered", () => {
    const empty = { overdue: { items: [], total: 0 }, undated: { items: [], total: 0 } };
    for (const filter of [
      { ...defaultCalendarFilter, assignedTo: "unassigned" as const },
      { ...defaultCalendarFilter, priorities: ["urgent" as const] },
      { ...defaultCalendarFilter, tagIds: ["Tag001"] },
    ]) {
      const html = render({ filter, tray: empty });
      expect(html).toContain("Nothing overdue or undated under this filter");
      expect(html).not.toContain("no tasks of yours without a date");
    }
    // Showing tasks only, or another color, leaves the tray as it is.
    expect(render({ filter: { ...defaultCalendarFilter, type: "task", colorBy: "priority" }, tray: empty })).toContain(
      "Nothing overdue, and no tasks of yours without a date",
    );
    expect(render({ locale: "de", filter: { ...defaultCalendarFilter, assignedTo: "me" }, tray: empty })).toContain(
      "Mit diesem Filter nichts überfällig und nichts ohne Datum",
    );
  });

  test("names each Show all link starting with the words it shows, in every language", () => {
    const html = render({ locale: "de", tray: { overdue: { items: overdue, total: 7 }, undated: { items: undated, total: 3 } } });
    expect(html).toContain('aria-label="Alle anzeigen: 7 überfällige Aufgaben"');
    expect(html).toContain('aria-label="Alle anzeigen: 3 deiner Aufgaben ohne Datum"');
    // Voice control finds a link by what it shows only where its name contains those words.
    for (const locale of ["en", "de"]) {
      const { t } = spaceMessages.resolve([locale]);
      expect(t.taskTrayAllOverdue({ count: 7 }).startsWith(t.taskTrayShowAll)).toBe(true);
      expect(t.taskTrayAllUndated({ count: 3 }).startsWith(t.taskTrayShowAll)).toBe(true);
    }
  });

  test("keeps the row free while the day loads, and shows none for events only or in the other views", () => {
    const loading = render({ tray: null });
    expect(loading).toMatch(/aria-busy="true"[^>]*data-spaces-task-tray/);
    expect(loading).not.toContain("Nothing overdue");
    expect(render({ filter: { ...defaultCalendarFilter, type: "event" }, tray: null })).not.toContain("data-spaces-task-tray");
    const full = { overdue: { items: overdue, total: 2 }, undated: { items: undated, total: 2 } };
    for (const view of ["week", "month", "year"] as const) expect(render({ view, tray: full })).not.toContain("data-spaces-task-tray");
  });
});
