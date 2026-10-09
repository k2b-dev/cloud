import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { CalendarItem, SpaceColumn, SpaceItemAssignee, SpaceTag } from "@/contracts";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
import { defaultFilter } from "../filter/types";
import { buildSpacesItemLinkBaseUrl } from "../workspace/workspace-types";
import { calendarPersonColor } from "./colors";
import { parseCalendarRoute } from "./filter";

// Whether a color choice moves anything is a layout question, so the calendar route renders on the server and then
// runs its real island bundle in a real browser, as the workspace page does. The island bundle resolves Solid from
// its root, so the scratch root sits inside this package's dependencies.
const packageCache = resolve(import.meta.dir, "../../../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "spaces-calendar-browser-"));
const workspaceDir = resolve(import.meta.dir, "../workspace");
const { plugin } = createConfig({ dev: false, verbose: false, rootDir: root, componentRoots: [workspaceDir] });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: CalendarFixture } = await import("./calendar.browser-fixture");

const ui = resolve(import.meta.dir, "../../../../../../ui/dist");
const styleEntries = [
  resolve(import.meta.dir, "../../../../styles/app.css"),
  resolve(import.meta.dir, "../../../../../../cloud/src/styles/global.css"),
];
/** Light screenshots of the scenarios, kept for review like the Kanban suite's. */
const shots = join(tmpdir(), "spaces-calendar-colors", browserName);

// Invented demo data: a team planning a spring fair in October 2026.
const columns: SpaceColumn[] = [
  { id: "Col001", spaceId: "Space1", name: "To do", color: "#6b7280", rank: "1", isDone: false },
  { id: "Col002", spaceId: "Space1", name: "In progress", color: "#3b82f6", rank: "2", isDone: false },
  { id: "Col003", spaceId: "Space1", name: "Review", color: "#f59e0b", rank: "3", isDone: false },
  { id: "Col004", spaceId: "Space1", name: "Done", color: "#22c55e", rank: "4", isDone: true },
];
const tag = (id: string, name: string, color: string): SpaceTag => ({ id, spaceId: "Space1", name, color });
const fair = tag("Tag001", "Fair", "#8b5cf6");
const press = tag("Tag002", "Press", "#ec4899");
const logistics = tag("Tag003", "Logistics", "#0ea5e9");
const volunteers = tag("Tag004", "Volunteers", "#22c55e");
const tags = [fair, logistics, press, volunteers];
const person = (id: string, displayName: string): SpaceItemAssignee => ({ id, displayName, avatarHash: null });
const robin = person("11111111-1111-4111-8111-111111111111", "Robin Example");
const kim = person("22222222-2222-4222-8222-222222222222", "Kim Example");
const alex = person("33333333-3333-4333-8333-333333333333", "Alex Doe");

const base = (id: string, title: string, patch: Partial<CalendarItem>): CalendarItem => ({
  id,
  spaceId: "Space1",
  spaceName: "Spring fair",
  spaceColor: "#8b5cf6",
  title,
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
const event = (id: string, title: string, day: number, from: string, to: string, patch: Partial<CalendarItem> = {}) =>
  base(id, title, {
    startsAt: `2026-10-${String(day).padStart(2, "0")}T${from}:00.000Z`,
    endsAt: `2026-10-${String(day).padStart(2, "0")}T${to}:00.000Z`,
    columnId: "Col002",
    ...patch,
  });
const task = (id: string, title: string, day: number, patch: Partial<CalendarItem> = {}) =>
  base(id, title, { deadline: `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`, allDay: true, ...patch });
const items: CalendarItem[] = [
  event("Item01", "Kickoff with the town office", 5, "09:00", "10:30", { tags: [fair], assignees: [robin] }),
  task("Item02", "Order banners", 6, { priority: "high", tags: [fair], assignees: [robin], columnId: "Col002" }),
  event("Item03", "Stand layout walk", 7, "14:00", "15:30", { tags: [logistics, fair], assignees: [kim] }),
  task("Item04", "Send the press kit", 9, { priority: "urgent", tags: [press], assignees: [alex] }),
  task("Item05", "Confirm the stage rental", 12, { priority: "medium", tags: [logistics], assignees: [kim], columnId: "Col003" }),
  event("Item06", "Press call", 13, "10:00", "11:00", { tags: [press], assignees: [alex], priority: "high" }),
  task("Item07", "Book the cleaning crew", 13, { priority: "low" }),
  event("Item08", "Volunteer briefing", 14, "15:00", "16:30", { tags: [volunteers, fair, press], assignees: [robin, kim] }),
  task("Item09", "Draft the volunteer schedule", 15, { priority: "medium", tags: [volunteers], assignees: [robin] }),
  task("Item10", "Print the badges", 15, { priority: "urgent", assignees: [kim], columnId: "Col003" }),
  event("Item11", "Team lunch", 16, "12:00", "13:00", { columnId: "Col001" }),
  task("Item12", "Collect insurance quotes", 20, { priority: "low", tags: [logistics] }),
  task("Item13", "Pay the deposit", 21, { priority: "high", columnId: "Col002" }),
  task("Item14", "Ask the bakery about a stand", 22, { priority: "medium", tags: [fair], assignees: [alex] }),
  event("Item15", "Sound check", 23, "16:00", "18:00", { tags: [logistics], assignees: [kim] }),
  base("Item16", "Spring fair", {
    startsAt: "2026-10-24T00:00:00.000Z",
    endsAt: "2026-10-25T00:00:00.000Z",
    allDay: true,
    tags: [fair, press, volunteers],
    columnId: "Col002",
  }),
  task("Item17", "Proofread the flyer", 26, { priority: "low", tags: [press], assignees: [kim] }),
  event("Item18", "Debrief", 28, "09:00", "10:00", { columnId: "Col002" }),
];

/** By default the URL names the calendar view, as after switching to it; `search` replaces the whole query. */
type Scenario = { locale: "en" | "de"; view: "week" | "month"; colorBy?: string; search?: string };
const query = (scenario: Scenario) =>
  scenario.search ?? `?view=calendar&cv=${scenario.view}&cd=2026-10-12${scenario.colorBy ? `&ccolor=${scenario.colorBy}` : ""}`;
/** The route as the workspace page renders it for a URL, with the island's base URL from the page's own builder. */
const serverBody = (url: URL) => {
  const locale = url.searchParams.get("lang") === "de" ? "de" : "en";
  const dateConfig = { locale, timeZone: "UTC", weekStartsOn: 1 } as const;
  const route = parseCalendarRoute(url, dateConfig);
  const view = route.view === "week" ? "week" : "month";
  return renderToString(() =>
    createComponent(CalendarFixture, {
      locale,
      spaceId: "Space1",
      baseUrl: buildSpacesItemLinkBaseUrl({
        baseSpaceUrl: "/app/spaces/Space1",
        currentView: "calendar",
        filter: defaultFilter,
        hasViewOverride: url.searchParams.has("view"),
        calendarView: view,
        calendarDate: route.date,
        calendarFilter: route.filter,
        dateConfig,
      }),
      columns,
      tags,
      initialState: { view, date: route.date, filter: route.filter, items, weather: {}, tray: null },
      selectedItemId: url.searchParams.get("item") ?? "",
      dateConfig,
      canWrite: true,
      currentUserId: "99999999-9999-4999-8999-999999999999",
    }),
  );
};

let css = "";
let server: ReturnType<typeof Bun.serve>;
const viewRequests: string[] = [];
let browser: Browser;

beforeAll(async () => {
  const built = await Promise.all(styleEntries.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(built.map((build) => build.outputs[0]!.text()))),
  ].join("\n");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
      if (url.pathname === "/api/spaces/workspace/view") {
        viewRequests.push(url.searchParams.get("href") ?? "");
        return Response.json({ message: "The color choice must not load calendar data" }, { status: 500 });
      }
      if (url.pathname !== "/app/spaces/Space1") return new Response("Not found", { status: 404 });
      // The page renders what its URL asks for, as the workspace page does on a reload.
      return new Response(pageHtml(url, url.searchParams.get("theme") === "dark" ? "dark" : "light"), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  browser = await launchBrowser();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const pageHtml = (url: URL, theme: "light" | "dark") =>
  `<!doctype html><html lang="${url.searchParams.get("lang") === "de" ? "de" : "en"}" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style>` +
  "<style>solid-client,solid-island{display:contents}</style></head>" +
  // The workspace main area: a padded flex column the route fills.
  `<body class="k2b-ui" style="margin:0"><main style="display:flex;flex-direction:column;height:100dvh;box-sizing:border-box;padding:var(--ui-space-shell)">${serverBody(url)}</main>` +
  `<script type="module">document.querySelectorAll('solid-island').forEach((e)=>import('/_ssr/'+e.dataset.id+'.js'))</script></body></html>`;

type View = { width: number; height: number; touch: boolean };
const phone: View = { width: 390, height: 844, touch: true };
const desktop: View = { width: 1280, height: 900, touch: false };

const open = async (view: View, scenario: Scenario, theme: "light" | "dark" = "light") => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`${server.url}app/spaces/Space1${query(scenario)}&lang=${scenario.locale}&theme=${theme}`);
  await hydrated(page);
  return page;
};
/** Solid attaches its delegated click handler to each item once the island has taken over the server markup. */
const hydrated = async (page: Page) => {
  await page.evaluate(() => window.document.fonts.ready);
  await page.waitForFunction(
    () => Boolean((window.document.querySelector("[data-calendar-event]") as { $$click?: unknown } | null)?.$$click),
    {
      timeout: 15_000,
    },
  );
};
const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 50))));

/** Every item's box, accent, and fill, and the boxes of the calendar's fixed parts, rounded to whole pixels. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height].map(Math.round);
    };
    const chips = Array.from(window.document.querySelectorAll<HTMLElement>("[data-calendar-event]"));
    return {
      header: box(window.document.querySelector(".k2b-calendar-header")!),
      toolbar: box(window.document.querySelector(".k2b-content-calendar > div:nth-child(2)")!),
      calendar: box(window.document.querySelector(".k2b-content-calendar")!),
      items: chips.map((chip) => ({ title: chip.getAttribute("aria-label"), box: box(chip) })),
    };
  });
/**
 * The layout once the day and week views have scrolled to the working hours, at once under the reduced motion these
 * pages ask for. A loaded engine can run that scroll late, so two equal samples prove nothing; the scroll is done
 * when the first working hour sits at the top of the time grid, or the grid cannot scroll further.
 */
const settledLayout = async (page: Page) => {
  await page.waitForFunction(
    () => {
      const grid = window.document.querySelector<HTMLElement>(".k2b-calendar-time-grid__scroll");
      const start = window.document.querySelector(".k2b-calendar-time-grid__hour:not([data-outside-business])");
      if (!grid || !start) return false;
      const atStart = Math.abs(start.getBoundingClientRect().top - grid.getBoundingClientRect().top) <= 1;
      return atStart || grid.scrollTop >= grid.scrollHeight - grid.clientHeight - 1;
    },
    undefined,
    { timeout: 15_000 },
  );
  return layout(page);
};
type Look = { accent: string; fill: string; marker: boolean; flag: boolean; dots: number };
const looks = (page: Page): Promise<Record<string, Look>> =>
  page.evaluate(() =>
    Object.fromEntries(
      Array.from(window.document.querySelectorAll<HTMLElement>("[data-calendar-event]")).map((chip) => {
        const dots = chip.querySelector("[data-spaces-calendar-dots]");
        return [
          chip.dataset.spaceItemId,
          {
            accent: chip.style.getPropertyValue("--k2b-calendar-accent"),
            fill: getComputedStyle(chip).backgroundColor,
            marker: chip.dataset.display === "marker",
            flag: Boolean(chip.querySelector("[data-spaces-calendar-flag]")),
            dots: dots && getComputedStyle(dots).display !== "none" ? dots.children.length : 0,
          },
        ];
      }),
    ),
  );
/** The open menu: whether it needs scrolling, whether the color choice sits in one row, and whether it offers Reset. */
const openMenu = (page: Page) =>
  page.evaluate(() => {
    const menu = window.document.querySelector<HTMLElement>(".k2b-dropdown__menu:popover-open")!;
    const segments = Array.from(menu.querySelectorAll(".k2b-dropdown__row > [role='menuitemradio']"), (segment) =>
      Math.round(segment.getBoundingClientRect().top),
    );
    const labels = Array.from(menu.querySelectorAll<HTMLElement>(".k2b-dropdown__row .k2b-dropdown__copy > span"));
    const wrapped = labels.filter(
      (label) => label.getBoundingClientRect().height > Number.parseFloat(getComputedStyle(label).lineHeight) * 1.5,
    );
    return {
      scrolls: menu.scrollHeight > menu.clientHeight,
      segments: segments.length,
      rows: new Set(segments).size,
      wrapped: wrapped.length,
      resets: menu.querySelectorAll("[role='group'][aria-label='Filter actions'], [role='group'][aria-label='Filteraktionen']").length,
    };
  });
/** Opens the scope menu and picks a color by its visible label. */
const chooseColor = async (page: Page, scope: string, label: string) => {
  await page.getByRole("button", { name: scope }).click();
  await page.getByRole("menuitemradio", { name: label }).click();
  await page.keyboard.press("Escape");
  await settle(page);
};
const shoot = async (page: Page, name: string) => {
  mkdirSync(shots, { recursive: true });
  // Away from the items, so no hover tint shows in the picture.
  await page.mouse.move(0, 0);
  await settle(page);
  await page.screenshot({ path: join(shots, `${name}.png`) });
};

describe(`Spaces calendar colors in ${browserName}`, () => {
  test("desktop month: tag colors, task markers, flags, and dots; another color moves nothing and survives a reload", async () => {
    const page = await open(desktop, { locale: "en", view: "month" });
    try {
      await shoot(page, "01-month-by-tag");
      const before = await layout(page);
      const tagged = await looks(page);
      // Events and tasks take their first tag's color; untagged items their status color, then neutral gray.
      expect(tagged.Item03).toMatchObject({ accent: "#0ea5e9", marker: false, dots: 1 });
      expect(tagged.Item08).toMatchObject({ accent: "#22c55e", dots: 2 });
      expect(tagged.Item04).toMatchObject({ accent: "#ec4899", marker: true, flag: true, fill: "rgba(0, 0, 0, 0)" });
      expect(tagged.Item07).toMatchObject({ accent: "#6b7280", marker: true, flag: false });
      expect(tagged.Item10).toMatchObject({ accent: "#f59e0b", flag: true });
      expect(tagged.Item03!.fill).not.toBe("rgba(0, 0, 0, 0)");
      // A task is a marker on the plain surface; hovering it tints it and moves nothing.
      await page.locator('[data-space-item-id="Item05"]').hover();
      await settle(page);
      expect((await looks(page)).Item05!.fill).not.toBe("rgba(0, 0, 0, 0)");
      expect(await layout(page)).toEqual(before);
      await page.mouse.move(0, 0);

      // The choice is one section of the scope menu, so the toolbar keeps its row.
      await page.getByRole("button", { name: "Scope" }).click();
      expect(await page.getByRole("menuitemradio", { name: "Tag" }).getAttribute("aria-checked")).toBe("true");
      expect(await openMenu(page)).toEqual({ scrolls: false, segments: 4, rows: 1, wrapped: 0, resets: 0 });
      await shoot(page, "07-color-menu");
      await page.keyboard.press("Escape");
      await chooseColor(page, "Scope", "Person");
      await page.waitForURL(/ccolor=person/);
      const byPerson = await looks(page);
      expect(byPerson.Item01!.accent).not.toBe(tagged.Item01!.accent);
      expect(byPerson.Item08!.dots).toBe(1);
      expect(byPerson.Item07!.accent).toBe("#a1a1aa");
      expect(await layout(page)).toEqual(before);
      expect(viewRequests).toEqual([]);
      await shoot(page, "03-month-by-person");
      // Another color is no filter: the menu keeps its size and offers no Reset.
      await page.getByRole("button", { name: "Scope" }).click();
      expect(await openMenu(page)).toEqual({ scrolls: false, segments: 4, rows: 1, wrapped: 0, resets: 0 });
      await page.keyboard.press("Escape");

      await chooseColor(page, "Scope", "Status");
      await page.waitForURL(/ccolor=status/);
      expect((await looks(page)).Item04!.accent).toBe("#6b7280");
      expect(await layout(page)).toEqual(before);
      await shoot(page, "02-month-by-status");

      await page.reload();
      await hydrated(page);
      expect((await looks(page)).Item04!.accent).toBe("#6b7280");
      expect(await layout(page)).toEqual(before);

      await chooseColor(page, "Scope", "Priority");
      await page.waitForURL(/ccolor=priority/);
      expect((await looks(page)).Item04!.accent).toBe("#ef4444");
      await shoot(page, "04-month-by-priority");
      // Picking Tag again returns to the default URL.
      await chooseColor(page, "Scope", "Tag");
      await page.waitForURL((url) => !url.searchParams.has("ccolor"));
      expect(await looks(page)).toEqual(tagged);
      expect(viewRequests).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("desktop month from the saved view with a filter and an open item: another color keeps the item and loads nothing", async () => {
    // Without a view override the page's base URL names no view, while the calendar's own links always name it and
    // write the filters after it; both describe the same calendar data.
    const page = await open(desktop, { locale: "en", view: "month", search: "?cv=month&cd=2026-10-12&cassigned=assigned&item=Item03" });
    try {
      const before = await layout(page);
      expect(await page.locator('[data-space-item-id="Item03"]').getAttribute("data-selected")).toBe("true");
      await chooseColor(page, "Scope", "Person");
      await page.waitForURL(/ccolor=person/);
      const url = new URL(page.url());
      expect(url.searchParams.get("item")).toBe("Item03");
      expect(url.searchParams.get("cassigned")).toBe("assigned");
      expect((await looks(page)).Item03!.accent).toBe(calendarPersonColor("Kim Example"));
      expect(await page.locator('[data-space-item-id="Item03"]').getAttribute("data-selected")).toBe("true");
      expect(await layout(page)).toEqual(before);
      expect(viewRequests).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("desktop week in German: the all-day markers and timed events keep their places for every color", async () => {
    const page = await open(desktop, { locale: "de", view: "week" });
    try {
      const before = await settledLayout(page);
      await shoot(page, "05-week-by-tag");
      for (const label of ["Priorität", "Person", "Status"]) {
        await chooseColor(page, "Umfang", label);
        expect(await layout(page)).toEqual(before);
      }
      expect(viewRequests).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("phone month: the dots give way to the title, and another color moves nothing", async () => {
    const page = await open(phone, { locale: "de", view: "month" });
    try {
      await shoot(page, "06-phone-month-by-tag");
      const before = await layout(page);
      expect(Object.values(await looks(page)).every((item) => item.dots === 0)).toBe(true);
      expect(before.toolbar[3]).toBeLessThanOrEqual(56);
      await page.getByRole("button", { name: "Umfang" }).click();
      // The whole menu, color row included, fits without scrolling on a phone too.
      expect(await openMenu(page)).toEqual({ scrolls: false, segments: 4, rows: 1, wrapped: 0, resets: 0 });
      await shoot(page, "08-phone-color-menu");
      await page.keyboard.press("Escape");
      await chooseColor(page, "Umfang", "Person");
      await page.waitForURL(/ccolor=person/);
      expect(await layout(page)).toEqual(before);
      expect(viewRequests).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("an old link to the removed timeline opens the month view of its day, with links to the four views", async () => {
    const page = await open(desktop, { locale: "en", view: "month", search: "?view=calendar&cv=timeline&cd=2026-10-12" });
    try {
      const views = await page
        .locator(".k2b-calendar-header [role='radio']")
        .evaluateAll((links) =>
          links.map((link) => [
            link.textContent?.trim(),
            link.getAttribute("aria-checked"),
            new URL((link as HTMLAnchorElement).href).searchParams.get("cv"),
          ]),
        );
      expect(views).toEqual([
        ["Day", "false", "day"],
        ["Week", "false", "week"],
        ["Month", "true", "month"],
        ["Year", "false", "year"],
      ]);
      expect(await page.locator('[data-space-item-id="Item03"]').count()).toBe(1);
      expect(await page.locator("[role='alert']").count()).toBe(0);
      expect(viewRequests).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("dark theme keeps the title text readable on every tinted fill", async () => {
    const page = await open(desktop, { locale: "en", view: "month" }, "dark");
    try {
      const readable = await page.evaluate(() => {
        // Resolve a computed color to sRGB channels through a 1x1 canvas, whatever syntax the engine returns.
        const canvas = window.document.createElement("canvas").getContext("2d")!;
        const channels = (color: string) => {
          canvas.clearRect(0, 0, 1, 1);
          canvas.fillStyle = color;
          canvas.fillRect(0, 0, 1, 1);
          return Array.from(canvas.getImageData(0, 0, 1, 1).data.slice(0, 3));
        };
        const luminance = (rgb: number[]) => {
          const [r, g, b] = rgb.map((value) => {
            const channel = value / 255;
            return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        return Array.from(window.document.querySelectorAll<HTMLElement>("[data-calendar-event]:not([data-display='marker'])")).map(
          (chip) => {
            const [light, dark] = [
              luminance(channels(getComputedStyle(chip).color)),
              luminance(channels(getComputedStyle(chip).backgroundColor)),
            ].sort((a, b) => b - a);
            return { title: chip.getAttribute("aria-label"), readable: (light! + 0.05) / (dark! + 0.05) >= 4.5 };
          },
        );
      });
      expect(readable.length).toBeGreaterThan(0);
      expect(readable.filter((entry) => !entry.readable)).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 60_000);
});
