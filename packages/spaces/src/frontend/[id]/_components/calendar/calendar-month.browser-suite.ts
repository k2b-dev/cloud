import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { dates } from "@k2b/stdlib";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { CalendarItem, SpaceColumn, SpaceTag } from "@/contracts";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
import { parseCalendarRoute } from "./filter";

// Selection, ranges, menus, bars, and overflow are layout and pointer questions, so the calendar route renders on the
// server and then runs its real island bundle in a real browser, as the workspace page does. The scratch root sits
// inside this package's dependencies, so the island bundle resolves Solid from there.
const packageCache = resolve(import.meta.dir, "../../../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "spaces-calendar-month-browser-"));
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
/** Light screenshots of the month view on a desktop and a phone, kept for review. */
const shots = join(tmpdir(), "spaces-calendar-month", browserName);

// Friday, October 9, 2026, 10:00 in Kiel: the server renders at this time and the browser's clock shows it.
const NOW = new Date("2026-10-09T08:00:00.000Z");
const timeZone = "Europe/Berlin";
const at = (month: number, day: number, time: string) =>
  dates.zonedDateTimeToInstant(`2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${time}`, timeZone);

// Invented demo data: a team preparing an autumn trade fair.
const columns: SpaceColumn[] = [
  { id: "Col001", spaceId: "Space1", name: "To do", color: "#6b7280", rank: "1", isDone: false },
  { id: "Col002", spaceId: "Space1", name: "In progress", color: "#3b82f6", rank: "2", isDone: false },
];
const tags: SpaceTag[] = [
  { id: "Tag001", spaceId: "Space1", name: "Fair", color: "#8b5cf6" },
  { id: "Tag002", spaceId: "Space1", name: "Travel", color: "#0ea5e9" },
  { id: "Tag003", spaceId: "Space1", name: "Team", color: "#22c55e" },
];
const base = {
  spaceId: "Space1",
  spaceName: "Autumn fair",
  spaceColor: "#8b5cf6",
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
  columnId: "Col002",
  assignees: [],
  activeBlockerCount: 0,
} satisfies Omit<CalendarItem, "id" | "title">;
const event = (id: string, title: string, day: number, start: string, end: string, extra: Partial<CalendarItem> = {}): CalendarItem => ({
  ...base,
  id,
  title,
  startsAt: at(10, day, start),
  endsAt: at(10, day, end),
  ...extra,
});
const task = (id: string, title: string, day: number, extra: Partial<CalendarItem> = {}): CalendarItem => ({
  ...base,
  id,
  title,
  deadline: at(10, day, "17:00"),
  columnId: "Col001",
  ...extra,
});
const allDay = (
  id: string,
  title: string,
  from: [number, number],
  to: [number, number],
  extra: Partial<CalendarItem> = {},
): CalendarItem => ({
  ...base,
  id,
  title,
  allDay: true,
  startsAt: at(from[0], from[1], "00:00"),
  // The day after the last one, as Spaces stores all-day ranges.
  endsAt: at(to[0], to[1], "00:00"),
  ...extra,
});
const fair = tags[0]!;
const travel = tags[1]!;
const team = tags[2]!;
const sample: CalendarItem[] = [
  event("Kick01", "Kickoff with the venue", 5, "09:00", "10:00", { tags: [fair] }),
  // Wednesday to Tuesday: the bar breaks between two week rows.
  allDay("Setup1", "Fair setup", [10, 7], [10, 14], { tags: [fair] }),
  task("Badge1", "Order badges", 8, { tags: [fair] }),
  event("Press1", "Press call", 12, "10:00", "11:00"),
  // A crowded Thursday: more entries than a month cell can show.
  event("Crowd1", "Stand-up", 15, "08:30", "09:00", { tags: [team] }),
  event("Crowd2", "Booth walkthrough", 15, "09:30", "10:30", { tags: [fair] }),
  event("Crowd3", "Supplier call", 15, "11:00", "11:30"),
  task("Crowd4", "Send floor plan", 15, { tags: [fair] }),
  event("Crowd5", "Lunch with partners", 15, "12:30", "13:30", { tags: [team] }),
  event("Crowd6", "Catering tasting", 15, "15:00", "16:00"),
  // A timed trip over three days.
  { ...base, id: "Trip01", title: "Trip to Hamburg", startsAt: at(10, 20, "09:00"), endsAt: at(10, 22, "17:00"), tags: [travel] },
  task("Recap1", "Write the recap", 23),
  // Over the end of the month and into the next week row.
  allDay("Break1", "Autumn break", [10, 29], [11, 4], { tags: [team] }),
];

const dateConfigFor = (locale: "en" | "de") => ({ locale, timeZone, weekStartsOn: 1 as const });
const monthHref = (date = "2026-10-09", view = "month") => `/app/spaces/Space1?view=calendar&cv=${view}&cd=${date}`;

const serverBody = (locale: "en" | "de", href: string, items: CalendarItem[]) => {
  setSystemTime(NOW);
  try {
    const dateConfig = dateConfigFor(locale);
    const route = parseCalendarRoute(new URL(href, "http://spaces.local"), dateConfig);
    return renderToString(() =>
      createComponent(CalendarFixture, {
        locale,
        spaceId: "Space1",
        baseUrl: href,
        columns,
        tags,
        initialState: { ...route, items, weather: {}, tray: null },
        selectedItemId: "",
        dateConfig,
        canWrite: true,
        currentUserId: "99999999-9999-4999-8999-999999999999",
      }),
    );
  } finally {
    setSystemTime();
  }
};

let css = "";
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
type Case = { locale: "en" | "de"; items: CalendarItem[] };
const cases = new Map<string, Case>();
const viewRequests: string[] = [];
const created: Record<string, unknown>[] = [];

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
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
      // The case travels in a header, so the page URL is the real route.
      const data = cases.get(request.headers.get("x-case") ?? "");
      if (!data) return new Response("Not found", { status: 404 });
      if (url.pathname === "/api/spaces/workspace/view") {
        const href = url.searchParams.get("href") ?? "";
        viewRequests.push(href);
        const route = parseCalendarRoute(new URL(href, "http://spaces.local"), dateConfigFor(data.locale));
        return Response.json({ kind: "calendar", ...route, items: data.items, weather: {}, tray: null });
      }
      if (url.pathname === "/api/spaces/Space1/items" && request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        created.push(body);
        return Response.json({ ...base, id: `New${String(created.length).padStart(3, "0")}`, ...body });
      }
      if (url.pathname !== "/app/spaces/Space1") return new Response("Not found", { status: 404 });
      return new Response(pageHtml(data.locale, `${url.pathname}${url.search}`, data.items), {
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

const pageHtml = (locale: "en" | "de", href: string, items: CalendarItem[]) =>
  `<!doctype html><html lang="${locale}" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style>` +
  "<style>solid-client,solid-island{display:contents}</style></head>" +
  // The workspace main area: a padded flex column the route fills.
  `<body class="k2b-ui" style="margin:0"><main style="display:flex;flex-direction:column;height:100dvh;box-sizing:border-box;padding:var(--ui-space-shell)">${serverBody(locale, href, items)}</main>` +
  `<script type="module">document.querySelectorAll('solid-island').forEach((e)=>import('/_ssr/'+e.dataset.id+'.js'))</script></body></html>`;

type View = { width: number; height: number; touch: boolean };
const phone: View = { width: 390, height: 844, touch: true };
const desktop: View = { width: 1440, height: 900, touch: false };
let caseCounter = 0;

const open = async (
  view: View,
  options: { locale?: "en" | "de"; href?: string; items?: CalendarItem[]; scale?: number } = {},
): Promise<Page> => {
  const id = `case${++caseCounter}`;
  const locale = options.locale ?? "en";
  cases.set(id, { locale, items: options.items ?? sample });
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch && browserName === "chromium",
    hasTouch: view.touch,
    timezoneId: timeZone,
    locale: locale === "de" ? "de-DE" : "en-US",
    colorScheme: "light",
    reducedMotion: "reduce",
    deviceScaleFactor: options.scale ?? 1,
    extraHTTPHeaders: { "x-case": id },
  });
  await context.clock.setFixedTime(NOW);
  const page = await context.newPage();
  await page.goto(`${server.url}${(options.href ?? monthHref()).slice(1)}`);
  await page.evaluate(() => window.document.fonts.ready);
  await page.waitForFunction(
    () => Boolean((document.querySelector("[data-calendar-event]") as { $$click?: unknown } | null)?.$$click),
    undefined,
    { timeout: 15_000 },
  );
  return page;
};
const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 50))));
const shoot = async (page: Page, name: string) => {
  mkdirSync(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await settle(page);
  await page.screenshot({ path: join(shots, `${name}.png`) });
};

type Box = { x: number; y: number; width: number; height: number };
const box = async (page: Page, selector: string): Promise<Box> => {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} is not on screen`);
  return { x: Math.round(found.x), y: Math.round(found.y), width: Math.round(found.width), height: Math.round(found.height) };
};
const day = (key: string) => `[data-calendar-day-key="${key}"]`;
/** A point in the empty lower part of a day cell, below its bars. */
const emptyPoint = async (page: Page, key: string) => {
  const cell = await box(page, day(key));
  return { x: cell.x + cell.width / 2, y: cell.y + cell.height - 6 };
};
const selectedDays = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[role='gridcell'][aria-selected='true']"), (cell) => cell.dataset.calendarDayKey),
  );
const clickDay = async (page: Page, key: string, options: { button?: "left" | "right"; modifiers?: "Shift" } = {}) => {
  const point = await emptyPoint(page, key);
  if (options.modifiers) await page.keyboard.down(options.modifiers);
  await page.mouse.click(point.x, point.y, { button: options.button ?? "left" });
  if (options.modifiers) await page.keyboard.up(options.modifiers);
};
const dragDays = async (page: Page, from: string, to: string) => {
  const start = await emptyPoint(page, from);
  const end = await emptyPoint(page, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y, { steps: 2 });
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
};
const openPopover = ".k2b-calendar-popover:popover-open";
const isOpen = (page: Page, selector: string) => page.evaluate((query) => Boolean(document.querySelector(query)), selector);
/** Every bar of an item: its accessible name, box, and torn ends. */
const bars = (page: Page, itemId: string) =>
  page.locator(`[data-space-item-id="${itemId}"]`).evaluateAll((elements) =>
    elements
      .filter((element) => !element.closest(".k2b-calendar-popover"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label: element.getAttribute("aria-label"),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          before: element.getAttribute("data-continues-before") === "true",
          after: element.getAttribute("data-continues-after") === "true",
        };
      }),
  );
const cellBox = async (page: Page, key: string) => {
  const cell = await box(page, day(key));
  return { left: cell.x, right: cell.x + cell.width, top: cell.y, bottom: cell.y + cell.height };
};
/** How many entries of a day the grid draws, and the count its "+N" shows. */
const dayOverflow = (page: Page, key: string) =>
  page.evaluate((dayKey) => {
    const cell = document.querySelector<HTMLElement>(`[data-calendar-day-key="${dayKey}"]`)!;
    const more = cell.querySelector<HTMLElement>(".k2b-calendar-month__more");
    return {
      drawn: cell.querySelectorAll(".k2b-calendar-month__segment").length,
      more: more ? Number(/\d+/.exec(more.getAttribute("aria-label") ?? "")?.[0]) : 0,
      label: more?.getAttribute("aria-label") ?? null,
    };
  }, key);
/** The heights of the week rows and the widths of the first row's days: the grid itself, without its content. */
const gridShape = (page: Page) =>
  page.evaluate(() => ({
    rows: Array.from(document.querySelectorAll(".k2b-calendar-month__week"), (row) => Math.round(row.getBoundingClientRect().height)),
    columns: Array.from(document.querySelectorAll(".k2b-calendar-month__week:first-of-type [role='gridcell']"), (cell) =>
      Math.round(cell.getBoundingClientRect().width),
    ),
  }));
const waitFor = async (check: () => boolean, what: string) => {
  for (let tries = 0; tries < 200; tries++) {
    if (check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const focusedDay = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.calendarDayKey ?? document.activeElement?.tagName ?? null);
const popoverState = (page: Page) =>
  page.evaluate(() => {
    const popover = document.querySelector<HTMLElement>(".k2b-calendar-popover:popover-open");
    return popover ? { kind: popover.dataset.kind, quiet: popover.dataset.quiet === "true" } : null;
  });
/** The line beside the kind that says when, as long as it shows: a squeezed line would read empty. */
const quickCreateWhen = (page: Page) =>
  page.locator(`${openPopover} [data-spaces-quick-create-when]`).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width >= 40 ? (element.textContent ?? "") : `hidden: ${element.textContent}`;
  });
const menuEntries = (page: Page) => page.locator(".k2b-context-menu[role='menu']").getByRole("menuitem").allTextContents();
/** The text drawn at the torn ends of an item's bars, in row order. */
const hints = (page: Page, itemId: string) =>
  page
    .locator(`[data-space-item-id="${itemId}"]`)
    .evaluateAll((elements) =>
      elements
        .filter((element) => !element.closest(".k2b-calendar-popover"))
        .map((element) =>
          Array.from(
            element.querySelectorAll<HTMLElement>(".k2b-calendar-event__hint"),
            (hint) => `${hint.dataset.edge}:${hint.textContent}`,
          ),
        ),
    );

describe(`Spaces month view in ${browserName}`, () => {
  test("desktop: the filters and the count sit right after the title in the one toolbar row, and paging moves nothing", async () => {
    const page = await open(desktop);
    try {
      // The calendar is its toolbar and its body: no row between them.
      const parts = await page.evaluate(() =>
        Array.from(document.querySelector(".k2b-content-calendar")!.children, (child) => child.className.split(" ")[0]),
      );
      expect(parts).toEqual(["k2b-calendar-header", "k2b-calendar-body"]);
      const order = await page.evaluate(() =>
        Array.from(document.querySelector(".k2b-calendar-header")!.children, (child) => child.className.split(" ")[0]),
      );
      expect(order).toEqual(["k2b-calendar-header__navigation", "k2b-calendar-header__content", "k2b-calendar-header__actions"]);
      expect(await page.locator(".k2b-calendar-header__content").getByText("13 shown").count()).toBe(1);
      const chips = () =>
        page.locator(".k2b-calendar-header__content .k2b-filter-chip").evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return { name: element.getAttribute("aria-label"), x: Math.round(rect.left), y: Math.round(rect.top) };
          }),
        );
      const before = await chips();
      expect(before.map((chip) => chip.name)).toEqual(["Scope", "Priority", "Status", "Tags"]);
      // One row: the chips, Today, and the title share their vertical middle.
      const middle = async (selector: string) => {
        const found = await box(page, selector);
        return Math.round(found.y + found.height / 2);
      };
      const title = await middle(".k2b-calendar-header__title");
      expect(Math.abs((await middle(".k2b-calendar-header__content .k2b-filter-chip")) - title)).toBeLessThanOrEqual(2);
      expect(Math.abs((await middle(".k2b-calendar-header__today")) - title)).toBeLessThanOrEqual(2);
      expect((await box(page, ".k2b-calendar-header")).height).toBeLessThanOrEqual(56);

      // Paging to a month with a shorter and one with a longer name moves no filter.
      for (const [label, month] of [
        ["Next", "2026-11"],
        ["Next", "2026-12"],
        ["Previous", "2026-11"],
      ] as const) {
        viewRequests.length = 0;
        await page.locator(`.k2b-calendar-header__nav-button[aria-label="${label}"]`).click();
        await page.waitForURL(new RegExp(`cd=${month}`));
        await waitFor(() => viewRequests.length > 0, "the view request");
        await settle(page);
        expect(await chips()).toEqual(before);
      }
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("desktop: the toolbar draws the filters as icons, then gives them a row of their own, and never overflows", async () => {
    const page = await open(desktop);
    try {
      for (const [width, iconOnly, ownRow] of [
        [1200, true, false],
        [960, false, true],
        [700, false, true],
      ] as const) {
        await page.setViewportSize({ width, height: 900 });
        await settle(page);
        const shape = await page.evaluate(() => {
          const header = document.querySelector(".k2b-calendar-header")!.getBoundingClientRect();
          const title = document.querySelector(".k2b-calendar-header__title")!.getBoundingClientRect();
          const chip = document.querySelector(".k2b-calendar-header__content .k2b-filter-chip")!.getBoundingClientRect();
          const overflow = Array.from(document.querySelectorAll(".k2b-calendar-header a, .k2b-calendar-header button")).filter(
            (element) => {
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && (rect.right > header.right + 0.5 || rect.left < header.left - 0.5);
            },
          ).length;
          return { chipWidth: Math.round(chip.width), below: chip.top > title.bottom, overflow };
        });
        expect({ width, iconOnly: shape.chipWidth <= 36, ownRow: shape.below, overflow: shape.overflow }).toEqual({
          width,
          iconOnly,
          ownRow,
          overflow: 0,
        });
      }
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("desktop: a click selects a day without navigating and shows the quick create quietly; the grid keeps the keys", async () => {
    const page = await open(desktop);
    try {
      viewRequests.length = 0;
      const url = page.url();
      await clickDay(page, "2026-10-16");
      expect(await selectedDays(page)).toEqual(["2026-10-16"]);
      expect(page.url()).toBe(url);
      expect(await focusedDay(page)).toBe("2026-10-16");
      // The quick create shows beside the day, but the focus stays in the grid.
      await page.locator(openPopover).waitFor();
      expect(await popoverState(page)).toEqual({ kind: "create", quiet: true });
      expect(await quickCreateWhen(page)).toBe("Fri, Oct 16 · 09:00–10:00");
      await shoot(page, "quiet-quick-create-en");

      // The arrows move the selection, and the quiet quick create follows it.
      await page.keyboard.press("ArrowRight");
      expect(await selectedDays(page)).toEqual(["2026-10-17"]);
      await page.keyboard.press("ArrowDown");
      expect(await selectedDays(page)).toEqual(["2026-10-24"]);
      expect(await quickCreateWhen(page)).toBe("Sat, Oct 24 · 09:00–10:00");
      await page.keyboard.press("Shift+ArrowLeft");
      await page.keyboard.press("Shift+ArrowLeft");
      expect(await selectedDays(page)).toEqual(["2026-10-22", "2026-10-23", "2026-10-24"]);
      expect(await quickCreateWhen(page)).toBe("Thu, Oct 22 – Sat, Oct 24 · all day");
      expect(await focusedDay(page)).toBe("2026-10-22");
      // Shift and a click extend the selection from where it started.
      await clickDay(page, "2026-10-26", { modifiers: "Shift" });
      expect(await selectedDays(page)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
      await settle(page);
      expect(viewRequests).toEqual([]);
      expect(page.url()).toBe(url);

      // Escape closes the quick create first, then clears the selection.
      await page.keyboard.press("Escape");
      expect(await popoverState(page)).toBeNull();
      expect(await selectedDays(page)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
      await page.keyboard.press("Escape");
      expect(await selectedDays(page)).toEqual([]);

      // Enter opens the quick create with the focus in its title.
      await clickDay(page, "2026-10-13");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Enter");
      await page.locator(openPopover).waitFor();
      expect(await popoverState(page)).toEqual({ kind: "create", quiet: false });
      expect(await focusedDay(page)).toBe("INPUT");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector(".k2b-calendar-popover:popover-open"));
      expect(await focusedDay(page)).toBe("2026-10-13");

      // New event in the toolbar creates on the same day, in the full dialog.
      await page.getByRole("button", { name: "New event" }).click();
      const dialog = page.locator("dialog[open]");
      await dialog.waitFor();
      expect(await dialog.textContent()).toContain("Oct 13");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("desktop: typing or Tab moves into the quiet quick create, Enter there saves, and a click elsewhere closes it", async () => {
    const page = await open(desktop);
    try {
      created.length = 0;
      await clickDay(page, "2026-10-14");
      await page.locator(openPopover).waitFor();
      expect(await focusedDay(page)).toBe("2026-10-14");
      await page.keyboard.type("Stand rehearsal");
      expect(await focusedDay(page)).toBe("INPUT");
      expect(await page.locator(`${openPopover} input`).inputValue()).toBe("Stand rehearsal");
      expect(await popoverState(page)).toEqual({ kind: "create", quiet: false });
      await page.keyboard.press("Enter");
      await waitFor(() => created.length === 1, "the create request");
      expect(created[0]).toMatchObject({
        title: "Stand rehearsal",
        allDay: false,
        startsAt: at(10, 14, "09:00"),
        endsAt: at(10, 14, "10:00"),
      });
      await page.waitForFunction(() => !document.querySelector(".k2b-calendar-popover:popover-open"));
      expect(await focusedDay(page)).toBe("2026-10-14");

      await clickDay(page, "2026-10-21");
      await page.locator(openPopover).waitFor();
      await page.keyboard.press("Tab");
      expect(await focusedDay(page)).toBe("INPUT");
      // A click on another day closes it and selects that day instead.
      await clickDay(page, "2026-10-27");
      expect(await selectedDays(page)).toEqual(["2026-10-27"]);
      expect(await quickCreateWhen(page)).toBe("Tue, Oct 27 · 09:00–10:00");
      // A click outside the grid closes it and leaves the focus where the click put it.
      await page.locator(".k2b-calendar-header__title").click();
      await page.waitForFunction(() => !document.querySelector(".k2b-calendar-popover:popover-open"));
      expect(created).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("desktop: a drag selects a range, the quick create opens at it with the focus, Escape cancels, and Enter saves one all-day event", async () => {
    const page = await open(desktop);
    try {
      created.length = 0;
      await dragDays(page, "2026-10-19", "2026-10-21");
      expect(await selectedDays(page)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21"]);
      await page.locator(openPopover).waitFor();
      // At the day where the drag ended, below it or above it.
      const popover = await box(page, openPopover);
      const end = await cellBox(page, "2026-10-21");
      const besideEnd = Math.abs(popover.y - end.bottom) <= 8 || Math.abs(popover.y + popover.height - end.top) <= 8;
      expect({ besideEnd, overlapsHorizontally: popover.x < end.right && popover.x + popover.width > end.left }).toEqual({
        besideEnd: true,
        overlapsHorizontally: true,
      });
      expect(await focusedDay(page)).toBe("INPUT");
      expect(await page.locator(openPopover).getAttribute("aria-label")).toBe("New entry");
      expect(await page.locator(`${openPopover} [role='radio'][aria-checked='true']`).innerText()).toBe("All day");
      expect(await quickCreateWhen(page)).toBe("Mon, Oct 19 – Wed, Oct 21 · all day");
      await shoot(page, "quick-create-en");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector(".k2b-calendar-popover:popover-open"));
      expect(await selectedDays(page)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21"]);
      expect(created).toEqual([]);

      await dragDays(page, "2026-10-26", "2026-10-28");
      await page.locator(openPopover).waitFor();
      await page.keyboard.type("Booth crew briefing");
      await page.keyboard.press("Enter");
      await waitFor(() => created.length === 1, "the create request");
      expect(created[0]).toMatchObject({
        title: "Booth crew briefing",
        allDay: true,
        startsAt: at(10, 26, "00:00"),
        endsAt: at(10, 29, "00:00"),
        columnId: "Col001",
      });
      await page.waitForFunction(() => !document.querySelector(".k2b-calendar-popover:popover-open"));
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("desktop: a right-click opens the day's menu; it keeps a selection it lands in, creates through the quick create, and opens the day", async () => {
    const page = await open(desktop);
    try {
      created.length = 0;
      await clickDay(page, "2026-10-19");
      await clickDay(page, "2026-10-21", { modifiers: "Shift" });
      await clickDay(page, "2026-10-20", { button: "right" });
      const menu = page.locator(".k2b-context-menu[role='menu']");
      await menu.waitFor();
      // The menu heads its entries with the days; the label shows in small capitals.
      expect((await menu.innerText()).toLowerCase()).toContain("oct 19 – oct 21 · 3 days");
      expect(await menuEntries(page)).toEqual([
        "New event",
        "New all-day event",
        "New task with deadline",
        "Open day",
        "Open week",
        "Clear selection",
      ]);
      expect(await selectedDays(page)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21"]);
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });

      // Outside the selection, the menu selects the day it opened on.
      await clickDay(page, "2026-10-14", { button: "right" });
      await menu.waitFor();
      expect(await selectedDays(page)).toEqual(["2026-10-14"]);
      expect(await menuEntries(page)).toEqual(["New event", "New all-day event", "New task with deadline", "Open day", "Open week"]);
      await shoot(page, "context-menu-en");
      await menu.getByRole("menuitem", { name: "New task with deadline" }).click();
      await page.locator(openPopover).waitFor();
      expect(await page.locator(`${openPopover} [role='radio'][aria-checked='true']`).innerText()).toBe("Task");
      expect(await quickCreateWhen(page)).toBe("due Wed, Oct 14, 17:00");
      await page.keyboard.type("Print the price list");
      await page.keyboard.press("Enter");
      await waitFor(() => created.length === 1, "the create request");
      expect(created[0]).toMatchObject({ title: "Print the price list", deadline: at(10, 14, "17:00") });
      expect(created[0]!.startsAt).toBeUndefined();

      // The keyboard opens the same menu at the focused day, and Open day goes to the day view.
      await page.locator(day("2026-10-27")).focus();
      await page.keyboard.press("Shift+F10");
      await menu.waitFor();
      expect(await selectedDays(page)).toEqual(["2026-10-27"]);
      const opened = await box(page, ".k2b-context-menu[role='menu']");
      const cell = await cellBox(page, "2026-10-27");
      expect(opened.x >= cell.left && opened.x <= cell.right).toBe(true);
      await menu.getByRole("menuitem", { name: "Open day" }).click();
      await page.waitForURL(/cv=day&cd=2026-10-27/);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("desktop: the views open at the selected day, the week number opens its week, and Page Down pages with the keys", async () => {
    const page = await open(desktop);
    try {
      await clickDay(page, "2026-10-16");
      const viewHref = (name: string) => page.locator(".k2b-calendar-view-switcher").getByRole("radio", { name }).getAttribute("href");
      expect(await viewHref("Day")).toContain("cv=day&cd=2026-10-16");
      expect(await viewHref("Week")).toContain("cv=week&cd=2026-10-16");
      expect(await page.locator(".k2b-calendar-month__week-link").first().getAttribute("aria-label")).toBe("Week 40, open week");
      expect(await page.locator(".k2b-calendar-month__week-link").nth(2).getAttribute("href")).toContain("cv=week&cd=2026-10-12");

      await page.keyboard.press("Escape");
      await page.keyboard.press("PageDown");
      await page.waitForURL(/cd=2026-11-16/);
      await page.waitForFunction(
        () => document.querySelector("[aria-selected='true']")?.getAttribute("data-calendar-day-key") === "2026-11-16",
      );
      expect(await focusedDay(page)).toBe("2026-11-16");
      // The arrows leave the shown month the same way.
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowUp");
      expect(await selectedDays(page)).toEqual(["2026-10-26"]);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("desktop: a long event is one bar per week row, torn where a row cuts it, with the date it continues to where it fits", async () => {
    const page = await open(desktop);
    try {
      const setup = await bars(page, "Setup1");
      expect(setup.map(({ label, before, after }) => ({ label, before, after }))).toEqual([
        { label: "Fair setup, October 7 to October 13", before: false, after: true },
        { label: "Fair setup, October 7 to October 13", before: true, after: false },
      ]);
      expect(await hints(page, "Setup1")).toEqual([["end:until 13"], ["start:from 7"]]);
      // Wednesday to the row's end, then Monday and Tuesday of the next row.
      const [first, second] = setup;
      expect(Math.abs(first!.left - (await cellBox(page, "2026-10-07")).left)).toBeLessThanOrEqual(6);
      expect(Math.abs(first!.right - (await cellBox(page, "2026-10-11")).right)).toBeLessThanOrEqual(2);
      expect(Math.abs(second!.left - (await cellBox(page, "2026-10-12")).left)).toBeLessThanOrEqual(2);
      expect(Math.abs(second!.right - (await cellBox(page, "2026-10-13")).right)).toBeLessThanOrEqual(6);
      // The bar keeps its lane on each of its days: the task on Thursday sits below it.
      const badge = (await bars(page, "Badge1"))[0]!;
      expect(badge.top).toBeGreaterThan(first!.bottom);

      const trip = await bars(page, "Trip01");
      expect(trip).toHaveLength(1);
      expect(trip[0]!.label).toMatch(/^Trip to Hamburg, October 20.*09:00.* to October 22.*05:00/);
      expect(await hints(page, "Trip01")).toEqual([[]]);

      // Over the month's end: the last row cuts the break, and November carries it on.
      const autumn = await bars(page, "Break1");
      expect(autumn.map(({ before, after }) => ({ before, after }))).toEqual([{ before: false, after: true }]);
      expect(autumn[0]!.label).toBe("Autumn break, October 29 to November 3");
      expect(await hints(page, "Break1")).toEqual([["end:until Nov 3"]]);

      // Narrow days drop a hint that leaves the title no room; the accessible name keeps the range.
      await page.setViewportSize({ width: 400, height: 900 });
      await page.waitForFunction(() => document.querySelectorAll('[data-space-item-id="Setup1"] .k2b-calendar-event__hint').length < 2);
      expect(await hints(page, "Setup1")).toEqual([["end:until 13"], []]);

      await page.setViewportSize({ width: 1440, height: 900 });
      viewRequests.length = 0;
      await page.locator('.k2b-calendar-header__nav-button[aria-label="Next"]').click();
      await page.waitForURL(/cd=2026-11/);
      await page.waitForFunction(() => document.querySelectorAll('[data-space-item-id="Break1"]').length === 2);
      const november = await bars(page, "Break1");
      expect(november.map(({ before, after }) => ({ before, after }))).toEqual([
        { before: false, after: true },
        { before: true, after: false },
      ]);
      expect(Math.abs(november[1]!.right - (await cellBox(page, "2026-11-03")).right)).toBeLessThanOrEqual(6);
      await page.waitForFunction(() => document.querySelectorAll('[data-space-item-id="Break1"] .k2b-calendar-event__hint').length === 2);
      expect(await hints(page, "Break1")).toEqual([["end:until 3"], ["start:from Oct 29"]]);
      await shoot(page, "month-end-en");
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("desktop: each cell draws as many entries as fit, +N counts only the rest and lists the day, and resizing never moves the grid", async () => {
    const page = await open(desktop);
    try {
      const counts = await dayOverflow(page, "2026-10-15");
      expect(counts.drawn).toBeGreaterThan(0);
      expect(counts.drawn + counts.more).toBe(6);
      expect(counts.label).toBe(`${counts.more} more on Thursday, October 15, 2026`);
      // A day beside the crowded one keeps its rows: only the crowded day gives a row to "+N".
      expect(await dayOverflow(page, "2026-10-12")).toEqual({ drawn: 2, more: 0, label: null });
      const shape = await gridShape(page);
      expect(new Set(shape.rows).size).toBe(1);

      await page.setViewportSize({ width: 1440, height: 640 });
      await page.waitForFunction(() => {
        const cell = document.querySelector('[data-calendar-day-key="2026-10-15"]')!;
        return cell.querySelectorAll(".k2b-calendar-month__segment").length < 4;
      });
      const small = await dayOverflow(page, "2026-10-15");
      expect(small.drawn).toBeLessThan(counts.drawn);
      expect(small.drawn + small.more).toBe(6);
      const smallShape = await gridShape(page);
      expect(new Set(smallShape.rows).size).toBe(1);
      expect(smallShape.columns).toEqual(shape.columns);

      await page.setViewportSize({ width: 1440, height: 1300 });
      await page.waitForFunction(() => !document.querySelector('[data-calendar-day-key="2026-10-15"] .k2b-calendar-month__more'));
      expect(await dayOverflow(page, "2026-10-15")).toEqual({ drawn: 6, more: 0, label: null });

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForFunction(() => Boolean(document.querySelector('[data-calendar-day-key="2026-10-15"] .k2b-calendar-month__more')));
      await page.locator(`${day("2026-10-15")} .k2b-calendar-month__more`).click();
      await page.locator(openPopover).waitFor();
      expect(await popoverState(page)).toEqual({ kind: "day", quiet: false });
      const listed = await page
        .locator(`${openPopover} [data-calendar-event]`)
        .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-space-item-id")));
      expect(listed).toEqual(["Crowd1", "Crowd2", "Crowd3", "Crowd5", "Crowd6", "Crowd4"]);
      expect(await page.locator(openPopover).getByRole("link", { name: "Open day" }).getAttribute("href")).toContain(
        "cv=day&cd=2026-10-15",
      );
      await shoot(page, "more-popover-en");
      await page.keyboard.press("Escape");
      expect(await isOpen(page, openPopover)).toBe(false);

      // Space lists the focused day, and New event there opens the quick create.
      await page.locator(day("2026-10-23")).focus();
      await page.keyboard.press(" ");
      await page.locator(openPopover).waitFor();
      expect(await page.locator(`${openPopover} .k2b-calendar-day-list__title`).innerText()).toBe("Friday, October 23, 2026");
      await page.locator(openPopover).getByRole("button", { name: "New event" }).click();
      await page.waitForFunction(
        () => document.querySelector<HTMLElement>(".k2b-calendar-popover:popover-open")?.dataset.kind === "create",
      );
      expect(await focusedDay(page)).toBe("INPUT");
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("phone in German: the toolbar wraps without an extra row, a tap selects, a second tap creates, and bars keep their titles", async () => {
    const page = await open(phone, { locale: "de" });
    try {
      const parts = await page.evaluate(() =>
        Array.from(document.querySelector(".k2b-content-calendar")!.children, (child) => child.className.split(" ")[0]),
      );
      expect(parts).toEqual(["k2b-calendar-header", "k2b-calendar-body"]);
      // The filters keep their icon and their names as accessible names.
      const chips = await page
        .locator(".k2b-calendar-header__content .k2b-filter-chip")
        .evaluateAll((elements) =>
          elements.map((element) => [element.getAttribute("aria-label"), Math.round(element.getBoundingClientRect().width)]),
        );
      expect(chips).toEqual([
        ["Umfang", 36],
        ["Priorität", 36],
        ["Status", 36],
        ["Tags", 36],
      ]);
      // Title, Today, and New event share the first row.
      const middle = async (selector: string) => {
        const found = await box(page, selector);
        return Math.round(found.y + found.height / 2);
      };
      const title = await middle(".k2b-calendar-header__title");
      expect(Math.abs((await middle(".k2b-calendar-header__today")) - title)).toBeLessThanOrEqual(2);
      expect(Math.abs((await middle(".k2b-calendar-header__actions > button")) - title)).toBeLessThanOrEqual(2);
      const overflow = await page.evaluate(() => {
        const header = document.querySelector(".k2b-calendar-header")!.getBoundingClientRect();
        return Array.from(document.querySelectorAll(".k2b-calendar-header a, .k2b-calendar-header button")).filter((element) => {
          const rect = element.getBoundingClientRect();
          if (rect.width === 0) return false;
          return rect.right > header.right + 0.5 || rect.left < header.left - 0.5;
        }).length;
      });
      expect(overflow).toBe(0);

      const url = page.url();
      const point = await emptyPoint(page, "2026-10-16");
      await page.touchscreen.tap(point.x, point.y);
      await page.waitForFunction(
        () => document.querySelector('[data-calendar-day-key="2026-10-16"]')?.getAttribute("aria-selected") === "true",
      );
      expect(page.url()).toBe(url);
      // A tap only selects; the second tap on the selected day opens the quick create.
      await settle(page);
      expect(await popoverState(page)).toBeNull();
      await page.waitForTimeout(400);
      await page.touchscreen.tap(point.x, point.y);
      await page.locator(openPopover).waitFor();
      expect(await popoverState(page)).toEqual({ kind: "create", quiet: false });
      expect(await quickCreateWhen(page)).toBe("Fr 16. Okt · 09:00–10:00");
      const sheet = await box(page, openPopover);
      expect(sheet.x).toBeGreaterThanOrEqual(8);
      expect(sheet.x + sheet.width).toBeLessThanOrEqual(phone.width - 8);
      await shoot(page, "phone-quick-create-de");
      await page.keyboard.press("Escape");

      const setup = await bars(page, "Setup1");
      expect(setup.map(({ label, before, after }) => ({ label, before, after }))).toEqual([
        { label: "Fair setup, 7. Oktober bis 13. Oktober", before: false, after: true },
        { label: "Fair setup, 7. Oktober bis 13. Oktober", before: true, after: false },
      ]);
      expect((await hints(page, "Setup1"))[0]).toEqual(["end:bis 13."]);
      const crowded = await dayOverflow(page, "2026-10-15");
      expect(crowded.drawn + crowded.more).toBe(6);
      expect(crowded.more).toBeGreaterThan(0);
      expect(await page.locator(`${day("2026-10-15")} .k2b-calendar-month__more`).innerText()).toBe(`+${crowded.more}`);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  // A finger that stays down needs Chromium's input protocol: Playwright drives WebKit's touch input only as a whole tap.
  test.skipIf(browserName === "webkit")(
    "phone in German: a long press on a day opens its menu as a sheet, and its entries create through the quick create",
    async () => {
      const page = await open(phone, { locale: "de" });
      try {
        const cdp = await page.context().newCDPSession(page);
        const point = await emptyPoint(page, "2026-10-14");
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
        const sheet = page.locator("dialog[open] .k2b-gesture-menu__sheet-menu");
        await sheet.waitFor();
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(300);
        expect(await sheet.isVisible()).toBe(true);
        expect(await sheet.getByRole("menuitem").allTextContents()).toEqual([
          "Neuer Termin",
          "Neuer ganztägiger Termin",
          "Neue Aufgabe mit Fälligkeit",
          "Tag öffnen",
          "Woche öffnen",
        ]);
        expect(await selectedDays(page)).toEqual(["2026-10-14"]);
        await shoot(page, "phone-long-press-de");
        await sheet.getByRole("menuitem", { name: "Neuer ganztägiger Termin" }).click();
        await page.locator(openPopover).waitFor();
        expect(await quickCreateWhen(page)).toBe("Mi 14. Okt · ganztägig");
      } finally {
        await page.context().close();
      }
    },
    60_000,
  );

  test("every view puts the filters after its title; light screenshots of each on a desktop and a phone", async () => {
    for (const [name, view, locale, href] of [
      ["desktop-1440-de", desktop, "de", monthHref()],
      ["phone-390-de", phone, "de", monthHref()],
      ["desktop-1440-en", desktop, "en", monthHref()],
      ["laptop-1100-de", { width: 1100, height: 800, touch: false }, "de", monthHref()],
      ["tablet-900-de", { width: 900, height: 900, touch: false }, "de", monthHref()],
      ["desktop-1440-de-week", desktop, "de", monthHref("2026-10-09", "week")],
      ["desktop-1440-de-day", desktop, "de", monthHref("2026-10-09", "day")],
      ["phone-390-de-week", phone, "de", monthHref("2026-10-09", "week")],
    ] as const) {
      const page = await open(view, { locale, href, scale: 2 });
      try {
        const order = await page.evaluate(() =>
          Array.from(document.querySelector(".k2b-calendar-header")!.children, (child) => child.className.split(" ")[0]),
        );
        expect({ name, order }).toEqual({
          name,
          order: ["k2b-calendar-header__navigation", "k2b-calendar-header__content", "k2b-calendar-header__actions"],
        });
        await shoot(page, name);
        if (!href.includes("cv=month")) continue;
        // The torn end of the setup bar, where it leaves its first week row.
        const first = (await bars(page, "Setup1"))[0]!;
        await page.screenshot({
          path: join(shots, `${name}-torn-end.png`),
          clip: { x: Math.max(0, first.right - 120), y: first.top - 12, width: 132, height: first.bottom - first.top + 24 },
        });
      } finally {
        await page.context().close();
      }
    }
  }, 120_000);
});
