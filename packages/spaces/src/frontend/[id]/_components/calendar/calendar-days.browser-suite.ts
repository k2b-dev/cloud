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
import type { CalendarItem, SpaceItem, SpaceTag } from "@/contracts";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
import type { CalendarTray } from "../workspace/workspace-types";
import { parseCalendarRoute } from "./filter";
import { CALENDAR_DAY_HOURS, type CalendarRange, calendarWindow } from "./range";

// The day and week views are layout and pointer questions: the calendar route renders on the server and then runs its
// real island bundle in a real browser, as the workspace page does, against an API that answers like the server. The
// scratch root sits inside this package's dependencies, so the island bundle resolves Solid from there.
const packageCache = resolve(import.meta.dir, "../../../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "spaces-calendar-days-browser-"));
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
/** Light screenshots of the day and week views, kept for review. */
const shots = join(tmpdir(), "spaces-calendar-days", browserName);

// Friday, October 9, 2026, 10:48 in Kiel: the server renders at this time and the browser's clock shows it.
const NOW = new Date("2026-10-09T08:48:00.000Z");
const TODAY = "2026-10-09";
const timeZone = "Europe/Berlin";
const dateConfig = { locale: "de", timeZone, weekStartsOn: 1 as const };
const at = (day: string, time: string) => dates.zonedDateTimeToInstant(`2026-${day}T${time}`, timeZone, { disambiguation: "compatible" });
const hrefOf = (date: string, view = "day") => `/app/spaces/Space1?view=calendar&cv=${view}&cd=${date}`;

// Invented demo data: a logistics team in autumn.
const tags: SpaceTag[] = [
  { id: "Tag001", spaceId: "Space1", name: "Touren", color: "#0ea5e9" },
  { id: "Tag002", spaceId: "Space1", name: "Lager", color: "#f59e0b" },
  { id: "Tag003", spaceId: "Space1", name: "Einkauf", color: "#8b5cf6" },
  { id: "Tag004", spaceId: "Space1", name: "Team", color: "#14b8a6" },
  { id: "Tag005", spaceId: "Space1", name: "Messe", color: "#ec4899" },
  { id: "Tag006", spaceId: "Space1", name: "Kunde", color: "#ef4444" },
];
const [touren, lager, einkauf, team, messe, kunde] = tags as [SpaceTag, SpaceTag, SpaceTag, SpaceTag, SpaceTag, SpaceTag];
const columns = [{ id: "Col001", spaceId: "Space1", name: "Offen", color: "#a1a1aa", rank: "1", isDone: false }];
const base = {
  spaceId: "Space1",
  spaceName: "Team Logistik",
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
  columnId: "Col001",
  assignees: [],
  activeBlockerCount: 0,
} satisfies Omit<CalendarItem, "id" | "title">;
const event = (
  id: string,
  title: string,
  day: string,
  start: string,
  endDay: string,
  end: string,
  tag: SpaceTag,
  extra: Partial<CalendarItem> = {},
) => ({
  ...base,
  id,
  title,
  startsAt: at(day, start),
  endsAt: at(endDay, end),
  tags: [tag],
  ...extra,
});
const task = (id: string, title: string, day: string, time: string, tag: SpaceTag, extra: Partial<CalendarItem> = {}) => ({
  ...base,
  id,
  title,
  deadline: at(day, time),
  tags: [tag],
  ...extra,
});
const allDay = (id: string, title: string, first: string, after: string, tag: SpaceTag) => ({
  ...base,
  id,
  title,
  allDay: true,
  startsAt: at(first, "00:00"),
  // The midnight after the last day, as Spaces stores all-day ranges.
  endsAt: at(after, "00:00"),
  tags: [tag],
});
const sample = (): CalendarItem[] => [
  event("Week05", "Wochenstart", "10-05", "09:00", "10-05", "09:30", team),
  event("Revw05", "Touren-Review September", "10-05", "13:00", "10-05", "14:30", touren),
  event("Ware06", "Wareneingang Großlieferung", "10-06", "08:00", "10-06", "12:00", lager, { priority: "high" }),
  task("Zoll07", "Zollpapiere Lieferung 4711", "10-07", "12:00", einkauf, { priority: "urgent" }),
  event("Hage08", "Kundentermin Hagedorn GmbH", "10-08", "10:00", "10-08", "11:00", kunde, { location: "Videocall" }),
  event("Stand9", "Standup", "10-09", "09:15", "10-09", "09:30", team),
  event("Call09", "Lieferantencall Spedition Nord", "10-09", "10:30", "10-09", "11:15", einkauf, { location: "Telefon" }),
  event("Lunch9", "Mittag mit Team Lager", "10-09", "12:30", "10-09", "13:15", team),
  event("Tour09", "Tourenplanung KW 43", "10-09", "14:00", "10-09", "15:30", touren),
  task("Fracht", "Frachtbriefe prüfen", "10-09", "16:00", lager),
  event("Wabs09", "Wochenabschluss", "10-09", "16:30", "10-09", "17:00", team),
  event("Sond10", "Sonderschicht Lager", "10-10", "08:00", "10-10", "12:00", lager),
  event("Invt12", "Inventur-Vorbereitung", "10-12", "10:00", "10-12", "12:00", lager),
  event("Fahr13", "Fahrerschulung Ladungssicherung", "10-13", "08:30", "10-13", "16:00", touren, { location: "Halle 1" }),
  event("Scan13", "Wartung Scanner-System", "10-13", "23:00", "10-14", "01:30", lager),
  event("Bewe14", "Bewerbungsgespräch Disponent", "10-14", "09:00", "10-14", "10:00", team),
  event("Budg14", "Budgetrunde Q4", "10-14", "16:00", "10-14", "17:00", einkauf, { priority: "high" }),
  task("Plan14", "Tourenplan KW 43 freigeben", "10-14", "16:00", touren, { priority: "high" }),
  event("Retr16", "Retro Herbstsaison", "10-16", "14:00", "10-16", "15:00", team),
  event("Umzu16", "Nachtumzug Regalreihe C", "10-16", "22:00", "10-17", "04:00", lager, { priority: "high" }),
  allDay("Vide19", "Schulungsvideos drehen", "10-19", "10-22", team),
  event("Lind20", "Kundentermin Lindner Logistik", "10-20", "10:00", "10-20", "11:00", kunde),
  allDay("Mess22", "Messe Logistik Nord, Hamburg", "10-22", "10-28", messe),
  event("Gesp23", "Messe: Gespräch Brandt & Söhne", "10-23", "15:00", "10-23", "16:00", messe),
  event("Nach28", "Messe-Nachbereitung", "10-28", "10:00", "10-28", "11:30", messe),
];
/** The reader the page renders for. */
const READER = "99999999-9999-4999-8999-999999999999";
const trayTask = (id: string, title: string, deadline: string | null = null, extra: Partial<SpaceItem> = {}): SpaceItem => ({
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
  deadline,
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
const sampleTray = (): CalendarTray => ({
  overdue: { items: [trayTask("Late01", "Reklamation Hagedorn beantworten", at("10-08", "17:00"))], total: 1 },
  undated: {
    items: [trayTask("Open01", "Regalbeschriftung erneuern", null, { tags: [lager] }), trayTask("Open02", "Notfallplan aktualisieren")],
    total: 2,
  },
});

/** Whether the calendar query places an item in the days: events overlap them, tasks are due in them, nights included. */
const inRange = (item: CalendarItem, range: CalendarRange) => {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to) + CALENDAR_DAY_HOURS[0] * 3_600_000;
  if (item.startsAt && item.endsAt) return Date.parse(item.startsAt) < to && Date.parse(item.endsAt) > from;
  return Boolean(item.deadline) && Date.parse(item.deadline!) >= from && Date.parse(item.deadline!) < to;
};
const rangeOf = (view: string, date: string, from?: string | null, to?: string | null): CalendarRange =>
  from && to ? { from, to } : calendarWindow(view === "week" ? "week" : "day", new Date(date), dateConfig);

type Case = { html: string; items: CalendarItem[]; tray: CalendarTray };

const serverBody = (options: { canWrite: boolean; items: CalendarItem[]; tray: CalendarTray; href: string }) => {
  setSystemTime(NOW);
  try {
    const route = parseCalendarRoute(new URL(options.href, "http://spaces.local"), dateConfig);
    const range = rangeOf(route.view, route.date);
    return renderToString(() =>
      createComponent(CalendarFixture, {
        locale: "de",
        spaceId: "Space1",
        baseUrl: options.href,
        columns,
        tags,
        initialState: {
          ...route,
          range,
          items: options.items.filter((item) => inRange(item, range)),
          weather: { [TODAY]: { tempMin: 8, tempMax: 14, icon: "cloud" }, "2026-10-10": { tempMin: 7, tempMax: 16, icon: "sun" } },
          tray: route.view === "day" ? options.tray : null,
        },
        selectedItemId: "",
        dateConfig,
        canWrite: options.canWrite,
        currentUserId: READER,
      }),
    );
  } finally {
    setSystemTime();
  }
};

let css = "";
let server: ReturnType<typeof Bun.serve>;
const cases = new Map<string, Case>();
const viewRequests: Array<{ href: string; from: string | null; to: string | null; includeTray: string | null }> = [];
const writes: Array<{ method: string; path: string; body: unknown }> = [];
/** Holds the answer to a range request until the test lets it go. */
let hold: (from: string | null) => Promise<void> = async () => {};
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
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
      // The case travels in a header, so the page URL is the real route.
      const data = cases.get(request.headers.get("x-case") ?? "");
      if (url.pathname === "/api/spaces/workspace/view") {
        const href = url.searchParams.get("href") ?? "";
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        viewRequests.push({ href, from, to, includeTray: url.searchParams.get("includeTray") });
        const route = parseCalendarRoute(new URL(href, "http://spaces.local"), dateConfig);
        const range = rangeOf(route.view, route.date, from, to);
        const body = {
          kind: "calendar",
          ...route,
          range,
          items: (data?.items ?? []).filter((item) => inRange(item, range)),
          weather: {},
          tray: route.view === "day" && url.searchParams.get("includeTray") !== "false" ? (data?.tray ?? null) : null,
        };
        await hold(from);
        return Response.json(body);
      }
      const item = /^\/api\/spaces\/Space1\/items\/(\w+)$/.exec(url.pathname);
      if (item && request.method === "GET") return Response.json({ ...trayTask(item[1]!, item[1]!), claim: null });
      if (request.method !== "GET" && url.pathname.startsWith("/api/spaces/Space1/items")) {
        const body = request.headers.get("content-type")?.includes("json") ? await request.json() : null;
        writes.push({ method: request.method, path: url.pathname, body });
        if (request.method === "PATCH" && item && data) {
          const patch = body as { startsAt?: string; endsAt?: string };
          data.tray.undated.items = data.tray.undated.items.filter((entry) => entry.id !== item[1]);
          const planned = trayTask(item[1]!, item[1]!);
          data.items.push({
            ...base,
            id: item[1]!,
            title: item[1]!,
            startsAt: patch.startsAt ?? null,
            endsAt: patch.endsAt ?? null,
            allDay: false,
          });
          return Response.json({ ...planned, ...patch });
        }
        return Response.json(trayTask("New001", (body as { title?: string } | null)?.title ?? "Neu"));
      }
      return data
        ? new Response(data.html, { headers: { "content-type": "text/html; charset=utf-8" } })
        : new Response("Not found", { status: 404 });
    },
  });
  browser = await launchBrowser();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const pageHtml = (options: { canWrite: boolean; items: CalendarItem[]; tray: CalendarTray; href: string }) =>
  `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style>` +
  "<style>solid-client,solid-island{display:contents}</style></head>" +
  `<body class="k2b-ui" style="margin:0"><main style="display:flex;flex-direction:column;height:100dvh;box-sizing:border-box;padding:var(--ui-space-shell)">${serverBody(options)}</main>` +
  `<script type="module">document.querySelectorAll('solid-island').forEach((e)=>import('/_ssr/'+e.dataset.id+'.js'))</script></body></html>`;

let caseCounter = 0;
type View = { width: number; height: number; touch: boolean };
const phone: View = { width: 390, height: 844, touch: true };
const tablet: View = { width: 1024, height: 1366, touch: true };
const desktop: View = { width: 1440, height: 900, touch: false };

const open = async (view: View, options: { canWrite?: boolean; href?: string; motion?: boolean } = {}): Promise<Page> => {
  const id = `case${++caseCounter}`;
  const href = options.href ?? hrefOf(TODAY);
  const items = sample();
  const tray = sampleTray();
  cases.set(id, { html: pageHtml({ canWrite: options.canWrite ?? true, items, tray, href }), items, tray });
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch && browserName === "chromium",
    hasTouch: view.touch,
    timezoneId: timeZone,
    locale: "de-DE",
    colorScheme: "light",
    reducedMotion: options.motion ? "no-preference" : "reduce",
    extraHTTPHeaders: { "x-case": id },
  });
  await context.clock.setFixedTime(NOW);
  const page = await context.newPage();
  await page.goto(`${server.url}${href.slice(1)}`);
  await page.evaluate(() => window.document.fonts.ready);
  await page.waitForFunction(() => Boolean((document.querySelector("[data-calendar-event]") as { $$click?: unknown } | null)?.$$click), {
    timeout: 15_000,
  });
  // The view takes its first position once it mounted.
  await page.waitForTimeout(150);
  return page;
};
const box = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} is not on screen`);
  return { x: Math.round(found.x), y: Math.round(found.y), width: Math.round(found.width), height: Math.round(found.height) };
};
const DAYS = ".k2b-calendar-days__scroll";
const WEEK = ".k2b-calendar-week__scroll";
const band = (id: string) => `.k2b-calendar-band[data-calendar-entry="${id}"]`;
/**
 * A wheel or trackpad gesture: steps one frame apart, dispatched in the page, as a trackpad sends them. Driving the
 * mouse from the test spaces the steps by the round trip to the browser instead, which a remote engine stretches.
 */
const gesture = (page: Page, selector: string, deltaX: number, deltaY: number, steps: number, shiftKey = false) =>
  page.locator(selector).evaluate(
    (element, step) =>
      new Promise<void>((done) => {
        const target = element.querySelector("[data-calendar-column], [data-calendar-body]") ?? element;
        let left = step.steps;
        const next = () => {
          target.dispatchEvent(
            new WheelEvent("wheel", { deltaX: step.deltaX, deltaY: step.deltaY, shiftKey: step.shiftKey, bubbles: true, cancelable: true }),
          );
          if (--left > 0) requestAnimationFrame(next);
          else done();
        };
        next();
      }),
    { deltaX, deltaY, steps, shiftKey },
  );
const rested = (page: Page) => page.waitForTimeout(700);
/** Waits until `read` returns a value, as the page answers asynchronously. */
const eventually = async <T>(read: () => T | undefined | null): Promise<T> => {
  for (let tries = 0; tries < 200; tries++) {
    const value = read();
    if (value !== undefined && value !== null) return value;
    await Bun.sleep(25);
  }
  throw new Error("Nothing came");
};

describe(`Spaces day and week views in ${browserName}`, () => {
  test("show the days down the page from 06:00, with the night of the day before folded and empty days merged", async () => {
    mkdirSync(shots, { recursive: true });
    const page = await open(desktop);
    // Today opens with now in view, below today's heading.
    const heading = page.locator(".k2b-calendar-days__day[data-today] .k2b-calendar-days__head");
    expect(await heading.textContent()).toContain("Heute");
    expect(await heading.textContent()).toContain("Freitag, 9. Oktober");
    expect(await page.locator(".k2b-calendar-header__title > span").first().textContent()).toBe("Fr 9. Okt 2026");
    // The day starts at six; the night is a folded row unless an entry lies in it.
    const today = page.locator(".k2b-calendar-days__day[data-today]");
    expect(await today.locator(".k2b-calendar-days__hour").first().textContent()).toBe("06:00");
    expect(await today.locator(".k2b-calendar-fold").textContent()).toContain("Nacht · 22–06");
    const tuesday = page.locator('.k2b-calendar-days__day[data-calendar-keys="2026-10-13"]');
    expect(await tuesday.locator(".k2b-calendar-night__bar").textContent()).toContain("Nacht · Di 13. → Mi 14.");
    expect(await tuesday.locator(band("Scan13")).count()).toBe(1);
    // Sunday holds nothing and folds into one row.
    const sunday = page.locator('.k2b-calendar-days__day[data-calendar-keys="2026-10-11"]');
    expect(await sunday.getAttribute("data-empty")).toBe("true");
    expect(await sunday.locator(".k2b-calendar-days__empty").textContent()).toContain("Nichts geplant");
    // The running event fills up and says what is left.
    expect(await page.locator(band("Call09")).getAttribute("data-running")).toBe("true");
    expect(await page.locator(band("Call09")).textContent()).toContain("noch 27 Min");
    // Free time is labelled; a deadline is a dashed line with a box.
    expect(await today.locator(".k2b-calendar-gap__button").first().textContent()).toContain("frei");
    await page.getByRole("checkbox", { name: "Erledigt: Frachtbriefe prüfen" }).waitFor();
    // The Today button shows a calm dot while today is on screen.
    expect(await page.locator(".k2b-calendar-header__today").getAttribute("data-direction")).toBe("here");
    await page.screenshot({ path: join(shots, "day-desktop-1440.png") });
    await page.locator(DAYS).evaluate((element) => element.scrollBy(0, 1400));
    await rested(page);
    expect(await page.locator(".k2b-calendar-header__today").getAttribute("data-direction")).toBe("up");
    await page.screenshot({ path: join(shots, "day-night-desktop-1440.png") });
    await page.context().close();

    for (const [name, view] of [
      ["day-phone-390", phone],
      ["day-ipad-1024", tablet],
    ] as const) {
      const small = await open(view);
      expect(await small.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      await small.screenshot({ path: join(shots, `${name}.png`) });
      await small.context().close();
    }
  }, 120_000);

  test("creates in free time through the quick create, and checks a task off with its box", async () => {
    const page = await open(desktop);
    writes.splice(0);
    await page.locator(".k2b-calendar-days__day[data-today] .k2b-calendar-gap__button").filter({ hasText: "1 Std. 15 frei" }).click();
    const popover = page.locator(".k2b-calendar-popover:popover-open");
    await popover.waitFor();
    expect(await popover.locator("[data-spaces-quick-create-when]").textContent()).toBe("Fr 9. Okt · 11:15–12:30");
    await popover.getByRole("textbox").fill("Rückruf Spedition");
    await popover.getByRole("textbox").press("Enter");
    expect(
      await eventually(() => writes.find((write) => write.method === "POST" && write.path === "/api/spaces/Space1/items")?.body),
    ).toMatchObject({
      title: "Rückruf Spedition",
      startsAt: at("10-09", "11:15"),
      endsAt: at("10-09", "12:30"),
      allDay: false,
    });

    await page.getByRole("checkbox", { name: "Erledigt: Frachtbriefe prüfen" }).click();
    expect(await eventually(() => writes.find((write) => write.path === "/api/spaces/Space1/items/Fracht/completed")?.body)).toMatchObject({
      completed: true,
    });
    await page.context().close();
  }, 60_000);

  test("plans a task from the row below into free time by dragging it there", async () => {
    const page = await open(desktop);
    writes.splice(0);
    const chip = page.locator("[data-spaces-task-tray] a").filter({ hasText: "Regalbeschriftung erneuern" });
    const gap = page.locator(".k2b-calendar-days__day[data-today] .k2b-calendar-gap").filter({ hasText: "1 Std. 15 frei" });
    const from = (await chip.boundingBox())!;
    const to = (await gap.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y - 60, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    // The gap says the task fits before it lands.
    await page.locator('.k2b-calendar-gap[data-hit="fit"]').waitFor();
    expect(await page.locator(".k2b-calendar-ghost__fit").textContent()).toBe("passt");
    await page.mouse.up();
    expect(await eventually(() => writes.find((write) => write.method === "PATCH")?.body)).toMatchObject({ allDay: false });
    const patch = writes.find((write) => write.method === "PATCH")!;
    expect(patch.path).toBe("/api/spaces/Space1/items/Open01");
    const planned = patch.body as { startsAt: string; endsAt: string };
    // An hour inside the gap from 11:15 to 12:30.
    expect(Date.parse(planned.endsAt) - Date.parse(planned.startsAt)).toBe(3_600_000);
    expect(Date.parse(planned.startsAt)).toBeGreaterThanOrEqual(Date.parse(at("10-09", "11:15")));
    expect(Date.parse(planned.endsAt)).toBeLessThanOrEqual(Date.parse(at("10-09", "12:30")));
    await page.context().close();
  }, 60_000);

  test("loads the weeks before and after while the reader scrolls, without moving what they see", async () => {
    const page = await open(desktop);
    const earlier = Promise.withResolvers<void>();
    hold = async (from) => {
      if (from && Date.parse(from) < Date.parse(at("10-02", "00:00"))) await earlier.promise;
    };
    try {
      viewRequests.splice(0);
      // Near the first loaded day the view asks for the week before, without the tray.
      await page.locator(DAYS).evaluate((element) => {
        element.scrollTop = 200;
      });
      expect(await eventually(() => viewRequests.find((request) => request.from))).toMatchObject({ includeTray: "false" });
      const visible = await page.locator(".k2b-calendar-days__day").nth(1).boundingBox();
      const anchor = await page.locator(".k2b-calendar-days__day").nth(1).getAttribute("data-calendar-keys");
      earlier.resolve();
      await page.locator('.k2b-calendar-days__day[data-calendar-keys*="2026-09-2"]').first().waitFor();
      await rested(page);
      // The week came in above; the day the reader looked at stays where it was.
      const after = await page.locator(`.k2b-calendar-days__day[data-calendar-keys="${anchor}"]`).boundingBox();
      expect(Math.round(after!.y)).toBe(Math.round(visible!.y));

      viewRequests.splice(0);
      await page.locator(DAYS).evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      expect(await eventually(() => viewRequests.find((request) => request.from)?.from)).toBe(at("10-31", "00:00"));
      await page.locator('.k2b-calendar-days__day[data-calendar-keys*="2026-11-0"]').first().waitFor();
    } finally {
      hold = async () => {};
      earlier.resolve();
      await page.context().close();
    }
  }, 60_000);

  test("keeps the URL on the day the reader scrolled to, and a filter keeps that day", async () => {
    const page = await open(desktop);
    await page.locator(DAYS).evaluate((element) => {
      const monday = element.querySelector<HTMLElement>('[data-calendar-keys="2026-10-12"]')!;
      element.scrollTop = monday.offsetTop;
    });
    await page.waitForURL(/cd=2026-10-12/);
    expect(await page.locator(".k2b-calendar-header__title > span").first().textContent()).toBe("Mo 12. Okt 2026");
    viewRequests.splice(0);
    await page.getByRole("button", { name: "Priorität" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Hoch" }).click();
    await page.keyboard.press("Escape");
    expect(await eventually(() => viewRequests.find((request) => request.href.includes("cpriority=high"))?.href)).toContain(
      "cd=2026-10-12",
    );
    await page.context().close();
  }, 60_000);

  test("shows the week as a strip of days that scrolls sideways, settles on a day, and pages by weeks", async () => {
    const page = await open(desktop, { href: hrefOf(TODAY, "week") });
    const title = () => page.locator(".k2b-calendar-header__title > span").first().textContent();
    expect(await title()).toBe("5.–11. Okt 2026");
    expect(await page.locator(".k2b-calendar-week__corner").textContent()).toBe("KW 41");
    const columnWidth = (await box(page, "[data-calendar-column]")).width;
    const left = () => page.locator(WEEK).evaluate((element) => element.scrollLeft);
    const start = await left();
    // A sideways trackpad gesture with a little drift up and down moves only the days, and settles on a day start.
    await gesture(page, WEEK, 32, 5, 10);
    await rested(page);
    const moved = await left();
    expect(moved).toBeGreaterThan(start);
    expect(Math.abs(moved / columnWidth - Math.round(moved / columnWidth))).toBeLessThan(0.02);
    expect(await page.locator(WEEK).evaluate((element) => element.scrollTop)).toBe(0);
    // Shift with the wheel goes sideways too.
    await gesture(page, WEEK, 0, 120, 2, true);
    await rested(page);
    expect(await left()).toBeGreaterThan(moved);
    // The arrows go to the start of the next week; Today comes back and points the way while away.
    await page.locator(".k2b-calendar-header__nav-button").nth(1).click();
    await rested(page);
    expect(await title()).toBe("12.–18. Okt 2026");
    expect(await page.locator(".k2b-calendar-header__today").getAttribute("data-direction")).toBe("left");
    await page.screenshot({ path: join(shots, "week-nights-desktop-1440.png") });
    await page.locator(".k2b-calendar-header__today").click();
    await rested(page);
    expect(await title()).toBe("5.–11. Okt 2026");
    await page.screenshot({ path: join(shots, "week-desktop-1440.png") });
    await page.context().close();

    // A long all-day event breaks at the end of the week and names where it goes on.
    const bars = await open(desktop, { href: hrefOf("2026-10-19", "week") });
    const fair = bars.locator(".k2b-calendar-week__slot .k2b-calendar-event", { hasText: "Messe Logistik Nord" }).first();
    expect(await fair.getAttribute("data-continues-after")).toBe("true");
    expect(await fair.locator('.k2b-calendar-event__hint[data-edge="end"]').textContent()).toBe("bis 27.");
    await bars.screenshot({ path: join(shots, "week-bars-desktop-1440.png") });
    await bars.context().close();

    // A phone shows three days; a tap on a column shows its free time, the next one proposes an hour there.
    const small = await open(phone, { href: hrefOf(TODAY, "week") });
    const visibleColumns = await small.locator(WEEK).evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return [...element.querySelectorAll<HTMLElement>("[data-calendar-column]")].filter((column) => {
        const rect = column.getBoundingClientRect();
        return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
      }).length;
    });
    expect(visibleColumns).toBe(3);
    const saturday = small.locator('[data-calendar-column][data-calendar-body="2026-10-10"]');
    const area = (await saturday.boundingBox())!;
    await small.touchscreen.tap(area.x + area.width / 2, area.y + 520);
    expect(await saturday.getAttribute("data-active")).toBe("true");
    await small.touchscreen.tap(area.x + area.width / 2, area.y + 520);
    await small.locator(".k2b-calendar-draft").waitFor();
    await small.screenshot({ path: join(shots, "week-phone-390.png") });
    await small.context().close();
  }, 120_000);

  test("publishes its shortcuts as commands of the page, and its shortcuts dialog lists the same ones", async () => {
    const page = await open(desktop);
    const commands = await page.evaluate(() => {
      const detail = { commands: [] as Array<{ id: string; title: string; shortcut?: string }> };
      window.dispatchEvent(new CustomEvent("cloud.command.collect", { detail }));
      return detail.commands.map((command) => [command.id, command.shortcut, command.title]);
    });
    expect(commands).toEqual(
      expect.arrayContaining([
        ["calendar.today", "h", "Heute"],
        ["calendar.next", "j", "Weiter"],
        ["calendar.previous", "k", "Zurück"],
        ["calendar.view.day", "1", "Ansicht Tag"],
        ["calendar.view.week", "2", "Ansicht Woche"],
        ["calendar.view.month", "3", "Ansicht Monat"],
        ["calendar.view.year", "4", "Ansicht Jahr"],
        ["calendar.goto", "g", "Gehe zu"],
        ["spaces.calendar.new-event", "n", "Neuer Termin"],
        ["spaces.calendar.new-task", "shift+n", "Neue Aufgabe mit Fälligkeit"],
      ]),
    );
    await page.getByRole("button", { name: "Tastenkürzel" }).click();
    const dialog = page.getByRole("dialog", { name: "Tastenkürzel" });
    await dialog.waitFor();
    for (const label of ["Heute", "Weiter", "Gehe zu", "Neuer Termin", "Neue Aufgabe mit Fälligkeit"])
      await dialog.getByText(label, { exact: true }).waitFor();
    await page.keyboard.press("Escape");

    // New task opens the quick create as a task where a new entry fits: today at the next full hour.
    await page.evaluate(() => {
      const detail = { commands: [] as Array<{ id: string; action: () => void }> };
      window.dispatchEvent(new CustomEvent("cloud.command.collect", { detail }));
      detail.commands.find((command) => command.id === "spaces.calendar.new-task")?.action();
    });
    const popover = page.locator(".k2b-calendar-popover:popover-open");
    await popover.waitFor();
    expect(await popover.locator("[data-spaces-quick-create-when]").textContent()).toBe("fällig Fr 9. Okt, 11:00");
    await page.context().close();
  }, 60_000);
});
