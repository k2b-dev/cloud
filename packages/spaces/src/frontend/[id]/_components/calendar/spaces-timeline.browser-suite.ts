import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { dates } from "@k2b/stdlib";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { CalendarItem, SpaceTag } from "@/contracts";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
import { defaultCalendarFilter } from "./filter";
import { type TimelineRange, timelineWindow } from "./timeline";

// Where the strip starts, that hydration and loading more days keep it in place, and how it reads on a phone are
// layout questions, so the calendar route renders on the server and then runs its real island bundle in a real
// browser, as the workspace page does. The scratch root sits inside this package's dependencies, so the island
// bundle resolves Solid from there.
const packageCache = resolve(import.meta.dir, "../../../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "spaces-timeline-browser-"));
const workspaceDir = resolve(import.meta.dir, "../workspace");
const { plugin } = createConfig({ dev: false, verbose: false, rootDir: root, componentRoots: [workspaceDir] });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: TimelineFixture } = await import("./spaces-timeline.browser-fixture");

const ui = resolve(import.meta.dir, "../../../../../../ui/dist");
const styleEntries = [
  resolve(import.meta.dir, "../../../../styles/app.css"),
  resolve(import.meta.dir, "../../../../../../cloud/src/styles/global.css"),
];

// Thursday, October 8, 2026, 14:20 in Kiel: the server renders at this time and the browser's clock shows it.
const NOW = new Date("2026-10-08T12:20:00.000Z");
const timeZone = "Europe/Berlin";
const at = (day: number, time: string) => dates.zonedDateTimeToInstant(`2026-10-${String(day).padStart(2, "0")}T${time}`, timeZone);

const tags: SpaceTag[] = [
  { id: "Tag001", spaceId: "Space1", name: "Release", color: "#8b5cf6" },
  { id: "Tag002", spaceId: "Space1", name: "Kunden", color: "#0ea5e9" },
  { id: "Tag003", spaceId: "Space1", name: "Team", color: "#10b981" },
];
const tag = (index: number) => [tags[index]!];
const base = {
  spaceId: "Space1",
  spaceName: "Produktteam Nord",
  spaceColor: "#3b82f6",
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
} satisfies Omit<CalendarItem, "id" | "title">;
const event = (id: string, title: string, day: number, start: string, end: string, extra: Partial<CalendarItem> = {}): CalendarItem => ({
  ...base,
  id,
  title,
  startsAt: at(day, start),
  endsAt: at(day, end),
  ...extra,
});
const task = (id: string, title: string, day: number, time: string, extra: Partial<CalendarItem> = {}): CalendarItem => ({
  ...base,
  id,
  title,
  deadline: at(day, time),
  ...extra,
});
const allItems: CalendarItem[] = [
  event("Kick01", "Kick-off Release 4.2", 1, "10:00", "11:30", { tags: tag(0) }),
  event("Run001", "Lauftreff", 7, "20:00", "21:00", { tags: tag(2) }),
  { ...event("Away01", "Lena im Urlaub", 5, "00:00", "00:00"), endsAt: at(11, "00:00"), allDay: true },
  { ...event("Onbo01", "Onboarding-Workshop Oktober", 8, "00:00", "00:00"), endsAt: at(10, "00:00"), allDay: true, tags: tag(2) },
  event("Daily8", "Daily Stand-up", 8, "08:30", "09:00", { tags: tag(2) }),
  event("Work01", "Workshop Stadtwerke Kiel", 8, "09:30", "11:00", { location: "Raum Förde", tags: tag(1) }),
  event("Port01", "Angebot Hafenamt abstimmen", 8, "10:30", "11:30", { tags: tag(1) }),
  event("Desi01", "Design-Review Onboarding", 8, "13:00", "13:45", { tags: tag(2) }),
  task("Task01", "Folien Release-Planung", 8, "15:30", { priority: "high" }),
  event("Plan01", "Release-Planung 4.2", 8, "16:00", "17:30", { location: "Raum Schlei", tags: tag(0) }),
  task("Task02", "Rechnung 2026-118 prüfen", 8, "17:00"),
  event("Dinn01", "Abendessen Kundenteam Kiel", 8, "19:00", "21:30", { location: "Fischküche", tags: tag(1) }),
  event("Daily9", "Daily Stand-up", 9, "08:30", "09:00", { tags: tag(2) }),
  event("Revi01", "Sprint-Review", 9, "11:00", "12:30", { tags: tag(0) }),
  task("Task03", "Messe-Giveaways bestellen", 9, "12:00"),
  event("Rund01", "Planungsrunde", 12, "10:00", "11:00", { tags: tag(2) }),
  task("Task04", "Angebot Stadtwerke senden", 12, "17:00", { priority: "urgent" }),
  event("Retr01", "Retro Release 4.2", 20, "14:00", "15:00", { tags: tag(0) }),
];
const completed = new Set<string>();
const touches = (item: CalendarItem, range: TimelineRange) => {
  const [from, to] = [Date.parse(range.from), Date.parse(range.to)];
  if (item.startsAt && item.endsAt) return Date.parse(item.startsAt) < to && Date.parse(item.endsAt) > from;
  const due = Date.parse(item.deadline ?? "");
  return due >= from && due < to;
};
const itemsIn = (range: TimelineRange) => allItems.filter((item) => !completed.has(item.id) && touches(item, range));

const dateConfig = { locale: "de", timeZone, weekStartsOn: 1 as const };
const anchor = dates.parseCalendarDate("2026-10-08", dateConfig);
const baseUrl = "/app/spaces/Space1?view=calendar&cv=timeline&cd=2026-10-08";

const serverBody = (canWrite: boolean) => {
  setSystemTime(NOW);
  try {
    const range = timelineWindow(anchor, dateConfig);
    return renderToString(() =>
      createComponent(TimelineFixture, {
        locale: "de",
        spaceId: "Space1",
        baseUrl,
        columns: [{ id: "Col001", spaceId: "Space1", name: "Offen", color: null, rank: "1", isDone: false }],
        tags,
        initialState: {
          view: "timeline",
          date: anchor.toISOString(),
          filter: defaultCalendarFilter,
          range,
          items: itemsIn(range),
          weather: {},
        },
        selectedItemId: "",
        dateConfig,
        canWrite,
      }),
    );
  } finally {
    setSystemTime();
  }
};

let css = "";
let server: ReturnType<typeof Bun.serve>;
const pages = new Map<string, string>();
const viewRequests: Array<{ href: string; from: string | null; to: string | null }> = [];
const completions: unknown[] = [];
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
      if (url.pathname === "/api/spaces/workspace/view") {
        const href = url.searchParams.get("href") ?? "";
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        viewRequests.push({ href, from, to });
        const range = from && to ? { from, to } : timelineWindow(anchor, dateConfig);
        return Response.json({
          kind: "calendar",
          view: "timeline",
          date: anchor.toISOString(),
          filter: defaultCalendarFilter,
          range,
          items: itemsIn(range),
          weather: {},
        });
      }
      const completion = /^\/api\/spaces\/Space1\/items\/(\w+)\/completed$/.exec(url.pathname);
      if (completion && request.method === "POST") {
        const body = (await request.json()) as { completed: boolean };
        completions.push({ itemId: completion[1], ...body });
        if (body.completed) completed.add(completion[1]!);
        else completed.delete(completion[1]!);
        return Response.json({ id: completion[1] });
      }
      // The case travels in a header, so the page URL is the real route and item links stay detail-only.
      const html = pages.get(request.headers.get("x-case") ?? "");
      return html
        ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
        : new Response("Not found", { status: 404 });
    },
  });
  browser = await launchBrowser();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const pageHtml = (canWrite: boolean) =>
  `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style>` +
  "<style>solid-client,solid-island{display:contents}</style></head>" +
  // The workspace main area: a padded flex column the route fills.
  `<body class="k2b-ui" style="margin:0"><main style="display:flex;flex-direction:column;height:100dvh;box-sizing:border-box;padding:var(--ui-space-shell)">${serverBody(canWrite)}</main>` +
  `<script type="module">document.querySelectorAll('solid-island').forEach((e)=>import('/_ssr/'+e.dataset.id+'.js'))</script></body></html>`;

let caseCounter = 0;
type View = { width: number; height: number; touch: boolean };
const phone: View = { width: 390, height: 844, touch: true };
const tablet: View = { width: 1024, height: 1366, touch: true };
const desktop: View = { width: 1440, height: 900, touch: false };

const open = async (view: View, options: { javaScript?: boolean; canWrite?: boolean } = {}): Promise<Page> => {
  const id = `case${++caseCounter}`;
  pages.set(id, pageHtml(options.canWrite ?? true));
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch && browserName === "chromium",
    hasTouch: view.touch,
    javaScriptEnabled: options.javaScript ?? true,
    timezoneId: timeZone,
    locale: "de-DE",
    colorScheme: "light",
    extraHTTPHeaders: { "x-case": id },
  });
  await context.clock.setFixedTime(NOW);
  const page = await context.newPage();
  await page.goto(`${server.url}${baseUrl.slice(1)}`);
  await page.evaluate(() => window.document.fonts.ready);
  if (options.javaScript ?? true) await hydrated(page);
  return page;
};
/** The island bundle has loaded and run; the page loads nothing else until the reader acts. */
const hydrated = (page: Page) => page.waitForLoadState("networkidle");
const item = (page: Page, id: string) => page.locator(`.k2b-timeline [data-entry-id="${id}"]`);
const box = async (page: Page, id: string) => {
  const found = await item(page, id).boundingBox();
  if (!found) throw new Error(`Item ${id} is not on screen`);
  return { x: Math.round(found.x), y: Math.round(found.y), width: Math.round(found.width), height: Math.round(found.height) };
};

describe(`Spaces timeline in ${browserName}`, () => {
  test("hydrates without moving anything the server drew", async () => {
    for (const view of [desktop, tablet, phone]) {
      const server = await open(view, { javaScript: false });
      const before = await box(server, "Daily8");
      await server.context().close();
      const page = await open(view);
      // The first frames after hydration measure the axis; nothing may move by then.
      await page.waitForTimeout(300);
      expect(await box(page, "Daily8")).toEqual(before);
      await page.context().close();
    }
  }, 60_000);

  test("runs across the width on a tablet and down the height on a phone", async () => {
    for (const [view, axis] of [
      [tablet, "horizontal"],
      [phone, "vertical"],
    ] as const) {
      const page = await open(view);
      const shown = await page
        .locator(".k2b-timeline__viewport")
        .evaluate((element) => getComputedStyle(element).getPropertyValue("--k2b-timeline-axis").trim());
      expect(shown).toBe(axis);
      const first = await box(page, "Daily8");
      const later = await box(page, "Work01");
      if (axis === "horizontal") expect(later.x).toBeGreaterThan(first.x);
      else expect(later.y).toBeGreaterThan(first.y);
      await page.context().close();
    }
  }, 60_000);

  test("loads the week before in place, and the days of it on the way back", async () => {
    const server = await open(desktop, { javaScript: false });
    const before = await box(server, "Run001");
    await server.context().close();
    viewRequests.splice(0);
    // The strip opens at its start, so the week before loads at once.
    const page = await open(desktop);
    await page.waitForFunction(() => document.querySelector(".k2b-timeline")?.getAttribute("aria-busy") !== "true");
    expect(viewRequests.filter((request) => request.from !== null)).toEqual([
      { href: baseUrl, from: "2026-09-30T18:00:00.000Z", to: "2026-10-07T18:00:00.000Z" },
    ]);
    await page.waitForTimeout(300);
    expect(await box(page, "Run001")).toEqual(before);
    await page.locator(".k2b-timeline__viewport").evaluate((element) => element.scrollTo({ left: 0, behavior: "instant" }));
    await item(page, "Kick01").waitFor();
    await page.context().close();
  }, 60_000);

  test("turns the mouse wheel sideways where the strip fills the view", async () => {
    const page = await open(desktop);
    const viewport = page.locator(".k2b-timeline__viewport");
    const before = await viewport.evaluate((element) => element.scrollLeft);
    const area = (await viewport.boundingBox())!;
    await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
    await page.mouse.wheel(0, 300);
    await page.waitForFunction((start) => (document.querySelector(".k2b-timeline__viewport")?.scrollLeft ?? 0) > start + 200, before);
    expect(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBe(0);
    await page.context().close();
  }, 60_000);

  test("checks a task off, confirms it, and lets it leave the strip", async () => {
    const page = await open(desktop);
    completions.splice(0);
    await item(page, "Task01").locator(".k2b-timeline__check").click();
    await page.locator(".k2b-toast__description", { hasText: "Eintrag erledigt" }).waitFor();
    expect(completions).toEqual([{ itemId: "Task01", completed: true }]);
    await item(page, "Task01").waitFor({ state: "detached" });
    completed.delete("Task01");
    await page.context().close();
  }, 60_000);

  test("offers no checkbox to a reader who may not change tasks", async () => {
    const page = await open(desktop, { canWrite: false });
    await expect(item(page, "Task01").locator(".k2b-timeline__check").count()).resolves.toBe(0);
    await page.context().close();
  }, 60_000);

  test("opens an item's detail and scrolls back to now from Today without loading", async () => {
    const page = await open(desktop);
    const opened = page.evaluate(
      () =>
        new Promise<string>((done) =>
          window.addEventListener("spaces-detail-navigation", (event) => done((event as CustomEvent<{ href: string }>).detail.href), {
            once: true,
          }),
        ),
    );
    await item(page, "Work01").click();
    expect(await opened).toContain("item=Work01");

    viewRequests.splice(0);
    await page.locator(".k2b-timeline__viewport").evaluate((element) => element.scrollBy({ left: 2400, behavior: "instant" }));
    await page.waitForTimeout(200);
    await page.getByRole("link", { name: "Heute" }).click();
    await page.waitForTimeout(800);
    const now = await page.locator(".k2b-timeline__now").boundingBox();
    const strip = await page.locator(".k2b-timeline__viewport").boundingBox();
    expect(now!.x).toBeGreaterThan(strip!.x);
    expect(now!.x).toBeLessThan(strip!.x + strip!.width);
    expect(viewRequests.filter((request) => request.from === null)).toEqual([]);
    await page.context().close();
  }, 60_000);

  test("shows the strip on a phone and a tablet", async () => {
    mkdirSync("/tmp/spaces-timeline", { recursive: true });
    for (const [name, view] of [
      ["phone-390", phone],
      ["ipad-1024", tablet],
      ["ipad-landscape-1366", { width: 1366, height: 1024, touch: true }],
      ["desktop-1440", desktop],
    ] as const) {
      const page = await open(view);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `/tmp/spaces-timeline/${name}-light.png` });
      if (view === phone) {
        await page.getByRole("link", { name: "Heute" }).click();
        await page.waitForTimeout(1000);
        await page.screenshot({ path: `/tmp/spaces-timeline/${name}-now-light.png` });
      }
      await page.context().close();
    }
  }, 60_000);
});
