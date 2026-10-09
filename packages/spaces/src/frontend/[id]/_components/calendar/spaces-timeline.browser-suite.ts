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
import type { CalendarItem, SpaceTag } from "@/contracts";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
import { type CalendarFilter, defaultCalendarFilter, parseCalendarRoute } from "./filter";
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
/** Light screenshots of the strip on a phone, tablets, and a desktop, kept for review like the other calendar suites'. */
const shots = join(tmpdir(), "spaces-timeline", browserName);

// Thursday, October 8, 2026, 14:20 in Kiel: the server renders at this time and the browser's clock shows it.
const NOW = new Date("2026-10-08T12:20:00.000Z");
const TODAY = "2026-10-08";
const timeZone = "Europe/Berlin";
const at = (day: number, time: string) => dates.zonedDateTimeToInstant(`2026-10-${String(day).padStart(2, "0")}T${time}`, timeZone);

const tags: SpaceTag[] = [
  { id: "Tag001", spaceId: "Space1", name: "Release", color: "#8b5cf6" },
  { id: "Tag002", spaceId: "Space1", name: "Kunden", color: "#0ea5e9" },
  { id: "Tag003", spaceId: "Space1", name: "Team", color: "#10b981" },
];
const columns = [{ id: "Col001", spaceId: "Space1", name: "Offen", color: "#f59e0b", rank: "1", isDone: false }];
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
  columnId: "Col001",
  assignees: [],
  activeBlockerCount: 0,
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
const sample: CalendarItem[] = [
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
const touches = (item: CalendarItem, range: TimelineRange) => {
  const [from, to] = [Date.parse(range.from), Date.parse(range.to)];
  if (item.startsAt && item.endsAt) return Date.parse(item.startsAt) < to && Date.parse(item.endsAt) > from;
  const due = Date.parse(item.deadline ?? "");
  return due >= from && due < to;
};
/** What the calendar query returns: the items of the range that the filter's type lets through. */
const itemsIn = (items: CalendarItem[], range: TimelineRange, filter: CalendarFilter = defaultCalendarFilter) =>
  items.filter(
    (item) => touches(item, range) && (filter.type === "all" || (filter.type === "event") === Boolean(item.startsAt && item.endsAt)),
  );

const dateConfig = { locale: "de", timeZone, weekStartsOn: 1 as const };
const hrefOf = (date: string) => `/app/spaces/Space1?view=calendar&cv=timeline&cd=${date}`;
/** The calendar data a timeline href loads, as the calendar query names it. */
const sourceOf = (date: string, extra = "") => `/app/spaces/Space1?cd=${date}${extra}&cv=timeline&view=calendar`;
const anchorOf = (date: string) => dates.parseCalendarDate(date, dateConfig);
/** The first window of the strip opened on today. */
const opening = timelineWindow(anchorOf(TODAY), dateConfig);

type Case = { html: string; items: CalendarItem[] };
type ViewRequest = { href: string; from: string | null; to: string | null };

const serverBody = (options: { canWrite: boolean; items: CalendarItem[]; date: string }) => {
  setSystemTime(NOW);
  try {
    const anchor = anchorOf(options.date);
    const range = timelineWindow(anchor, dateConfig);
    return renderToString(() =>
      createComponent(TimelineFixture, {
        locale: "de",
        spaceId: "Space1",
        baseUrl: hrefOf(options.date),
        columns,
        tags,
        initialState: {
          view: "timeline",
          date: anchor.toISOString(),
          filter: defaultCalendarFilter,
          range,
          items: itemsIn(options.items, range),
          weather: {},
        },
        selectedItemId: "",
        dateConfig,
        canWrite: options.canWrite,
      }),
    );
  } finally {
    setSystemTime();
  }
};

let css = "";
let server: ReturnType<typeof Bun.serve>;
const cases = new Map<string, Case>();
const viewRequests: ViewRequest[] = [];
const completions: unknown[] = [];
/** Holds the answer to a view request until the test lets it go; the answer itself is read when the request comes in. */
let hold: (request: ViewRequest) => Promise<void> = async () => {};
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
      // The case travels in a header, so the page URL is the real route and item links stay detail-only.
      const data = cases.get(request.headers.get("x-case") ?? "");
      if (url.pathname === "/api/spaces/workspace/view") {
        const viewRequest = {
          href: url.searchParams.get("href") ?? "",
          from: url.searchParams.get("from"),
          to: url.searchParams.get("to"),
        };
        viewRequests.push(viewRequest);
        const route = parseCalendarRoute(new URL(viewRequest.href, "http://spaces.local"), dateConfig);
        const range =
          viewRequest.from && viewRequest.to
            ? { from: viewRequest.from, to: viewRequest.to }
            : timelineWindow(new Date(route.date), dateConfig);
        const body = { kind: "calendar", ...route, range, items: itemsIn(data?.items ?? [], range, route.filter), weather: {} };
        await hold(viewRequest);
        return Response.json(body);
      }
      const completion = /^\/api\/spaces\/Space1\/items\/(\w+)\/completed$/.exec(url.pathname);
      if (completion && request.method === "POST" && data) {
        const body = (await request.json()) as { completed: boolean };
        completions.push({ itemId: completion[1], ...body });
        if (body.completed) data.items = data.items.filter((item) => item.id !== completion[1]);
        return Response.json({ id: completion[1] });
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

const pageHtml = (options: { canWrite: boolean; items: CalendarItem[]; date: string }) =>
  `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style>` +
  "<style>solid-client,solid-island{display:contents}</style></head>" +
  // The workspace main area: a padded flex column the route fills.
  `<body class="k2b-ui" style="margin:0"><main style="display:flex;flex-direction:column;height:100dvh;box-sizing:border-box;padding:var(--ui-space-shell)">${serverBody(options)}</main>` +
  `<script type="module">document.querySelectorAll('solid-island').forEach((e)=>import('/_ssr/'+e.dataset.id+'.js'))</script></body></html>`;

let caseCounter = 0;
type View = { width: number; height: number; touch: boolean };
const phone: View = { width: 390, height: 844, touch: true };
const tablet: View = { width: 1024, height: 1366, touch: true };
const desktop: View = { width: 1440, height: 900, touch: false };

const open = async (
  view: View,
  options: { javaScript?: boolean; canWrite?: boolean; items?: CalendarItem[]; date?: string } = {},
): Promise<Page> => {
  const id = `case${++caseCounter}`;
  const date = options.date ?? TODAY;
  const items = [...(options.items ?? sample)];
  cases.set(id, { html: pageHtml({ canWrite: options.canWrite ?? true, items, date }), items });
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
  await page.goto(`${server.url}${hrefOf(date).slice(1)}`);
  await page.evaluate(() => window.document.fonts.ready);
  if (options.javaScript ?? true) await idle(page);
  return page;
};
/** The island has loaded and run, and the weeks it loads on its own are in; the page loads nothing more until the reader acts. */
const idle = (page: Page) => page.waitForLoadState("networkidle");
/** The data of the page opened last, which the server reads and changes. */
const lastCase = () => cases.get(`case${caseCounter}`)!;
const item = (page: Page, id: string) => page.locator(`.k2b-timeline [data-entry-id="${id}"]`);
const box = async (page: Page, id: string) => {
  const found = await item(page, id).boundingBox();
  if (!found) throw new Error(`Item ${id} is not on screen`);
  return { x: Math.round(found.x), y: Math.round(found.y), width: Math.round(found.width), height: Math.round(found.height) };
};
const scrollToEnd = (page: Page) =>
  page.locator(".k2b-timeline__viewport").evaluate((element) => element.scrollTo({ left: element.scrollWidth, top: element.scrollHeight }));
/** Resolves once the server has seen a view request that `match` accepts. */
const requested = async (match: (request: ViewRequest) => boolean) => {
  for (let tries = 0; tries < 200; tries++) {
    if (viewRequests.some(match)) return;
    await Bun.sleep(25);
  }
  throw new Error(`No such view request among ${JSON.stringify(viewRequests)}`);
};
/** A gate for held answers: `wait` holds them, `open` lets them all go. */
const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((done) => (open = done));
  return { wait, open };
};
/** The href of the next item detail the page opens in place, or "navigated" when it loads another document instead. */
const nextDetail = (page: Page) =>
  page
    .evaluate(
      () =>
        new Promise<string>((done) => {
          window.addEventListener("spaces-detail-navigation", (event) => done((event as CustomEvent<{ href: string }>).detail.href), {
            once: true,
          });
          setTimeout(() => done("nothing"), 3000);
        }),
    )
    .catch(() => "navigated");
/** What a live update does: the view refreshes the days it shows. */
const invalidate = (page: Page) =>
  page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("spaces-data-invalidated", { detail: { domains: ["view"], cursor: null, itemId: null, cover: () => {} } }),
    ),
  );

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
    expect(viewRequests.filter((request) => request.from !== null)[0]).toEqual({
      href: sourceOf(TODAY),
      from: "2026-09-30T18:00:00.000Z",
      to: opening.from,
    });
    expect(await box(page, "Run001")).toEqual(before);
    await page.locator(".k2b-timeline__viewport").evaluate((element) => element.scrollTo({ left: 0, behavior: "instant" }));
    await item(page, "Kick01").waitFor();
    await page.context().close();
  }, 60_000);

  test("loads only a few empty weeks around a Space with nothing planned", async () => {
    for (const view of [desktop, phone]) {
      viewRequests.splice(0);
      const page = await open(view, { items: [] });
      // Empty weeks fold away and leave the reader at the end of the strip; they must not pull in the next one.
      const weeks = viewRequests.filter((request) => request.from !== null);
      expect(weeks.length).toBeGreaterThan(0);
      expect(weeks.length).toBeLessThanOrEqual(4);
      await page.context().close();
    }
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

  test("colors the strip by the calendar's color choice, without loading", async () => {
    const page = await open(desktop);
    const accent = (id: string) =>
      item(page, id).evaluate((element) => element.closest("li")?.style.getPropertyValue("--k2b-timeline-accent"));
    // By tag: an event takes its tag's color, a task without a tag its status color.
    expect(await accent("Work01")).toBe("#0ea5e9");
    expect(await accent("Task01")).toBe("#f59e0b");
    viewRequests.splice(0);
    await page.getByRole("button", { name: "Umfang" }).click();
    await page.getByRole("menuitemradio", { name: "Priorität" }).click();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.location.search.includes("ccolor=priority"));
    expect(await accent("Task01")).toBe("#f97316");
    expect(await accent("Work01")).toBe("#a1a1aa");
    expect(viewRequests).toEqual([]);
    await page.context().close();
  }, 60_000);

  test("checks a task off, confirms it, and lets it leave the strip", async () => {
    const page = await open(desktop);
    completions.splice(0);
    await item(page, "Task01").locator(".k2b-timeline__check").click();
    await page.locator(".k2b-toast__description", { hasText: "Eintrag erledigt" }).waitFor();
    expect(completions).toEqual([{ itemId: "Task01", completed: true }]);
    await item(page, "Task01").waitFor({ state: "detached" });
    await page.context().close();
  }, 60_000);

  test("offers no checkbox to a reader who may not change tasks", async () => {
    const page = await open(desktop, { canWrite: false });
    await expect(item(page, "Task01").locator(".k2b-timeline__check").count()).resolves.toBe(0);
    await page.context().close();
  }, 60_000);

  test("opens an item's detail and scrolls back to now from Today without loading", async () => {
    const page = await open(desktop);
    const opened = nextDetail(page);
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

  test("the active Timeline link scrolls back to where the strip opened", async () => {
    const page = await open(desktop, { date: "2026-10-20" });
    // The week before has loaded in place, so the strip still shows the evening before the anchor day.
    const opened = await box(page, "Retr01");
    await page.locator(".k2b-timeline__viewport").evaluate((element) => element.scrollTo({ left: 0, behavior: "instant" }));
    // At the start the week of the kick-off loads, so weeks before the opening join the strip before the link is used.
    await item(page, "Kick01").waitFor();
    await page.getByRole("radio", { name: "Zeitleiste" }).click();
    // Back to the opening evening, at most the 16 px the scroll leaves before it, wherever earlier weeks loaded since.
    await page.waitForFunction(
      (x) => Math.abs((document.querySelector('[data-entry-id="Retr01"]')?.getBoundingClientRect().x ?? Number.NaN) - x) <= 17,
      opened.x,
      { timeout: 5000 },
    );
    await page.context().close();
  }, 60_000);

  test("keeps the items of the strip shown linked to it while the next day loads", async () => {
    const page = await open(desktop);
    const next = gate();
    hold = (request) => (request.href.includes("cd=2026-10-09") ? next.wait : Promise.resolve());
    try {
      await page.getByRole("link", { name: "Weiter" }).click();
      await requested((request) => request.href.includes("cd=2026-10-09"));
      expect(await item(page, "Work01").getAttribute("href")).toContain("cd=2026-10-08");
      const opened = nextDetail(page);
      await item(page, "Work01").click();
      expect(await opened).toContain("item=Work01");
      expect(new URL(page.url()).searchParams.get("cd")).toBe(TODAY);
    } finally {
      hold = async () => {};
      next.open();
      await page.context().close();
    }
  }, 60_000);

  test("loads a week again when a refresh started while it loaded, so a change in it shows", async () => {
    const page = await open(desktop, { items: [...sample, task("Late01", "Standfläche buchen", 20, "12:00")] });
    const week = gate();
    const refresh = gate();
    let weekHeld = false;
    hold = (request) => {
      if (request.from === opening.to && !weekHeld) {
        weekHeld = true;
        return week.wait;
      }
      return request.to === opening.to && request.from !== null && request.from < opening.from ? refresh.wait : Promise.resolve();
    };
    try {
      viewRequests.splice(0);
      await scrollToEnd(page);
      await requested((request) => request.from === opening.to);
      // Someone completes the task while the week is on its way; the week's answer still holds it.
      const data = lastCase();
      data.items = data.items.filter((entry) => entry.id !== "Late01");
      await invalidate(page);
      await requested((request) => request.to === opening.to && request.from !== null && request.from < opening.from);
      week.open();
      await page.waitForTimeout(300);
      await expect(item(page, "Late01").count()).resolves.toBe(0);
      refresh.open();
      await requested((request) => request.from === opening.to && viewRequests.filter((entry) => entry.from === opening.to).length === 2);
      await idle(page);
      await scrollToEnd(page);
      await item(page, "Retr01").waitFor();
      await expect(item(page, "Late01").count()).resolves.toBe(0);
    } finally {
      hold = async () => {};
      week.open();
      refresh.open();
      await page.context().close();
    }
  }, 60_000);

  for (const order of ["week first", "filter first"] as const) {
    test(`loads the week for a new filter that came in while a week loaded (${order})`, async () => {
      const page = await open(desktop);
      const week = gate();
      const filter = gate();
      const filtered = (request: ViewRequest) => request.href.includes("ctype=event");
      let weekHeld = false;
      hold = (request) => {
        if (request.from === opening.to && !weekHeld) {
          weekHeld = true;
          return week.wait;
        }
        return filtered(request) && request.from !== opening.to ? filter.wait : Promise.resolve();
      };
      try {
        viewRequests.splice(0);
        await scrollToEnd(page);
        await requested((request) => request.from === opening.to);
        await page.getByRole("button", { name: "Umfang" }).click();
        await page.getByRole("menuitemradio", { name: "Termine", exact: true }).click();
        await page.keyboard.press("Escape");
        await requested(filtered);
        const [first, second] = order === "week first" ? [week, filter] : [filter, week];
        first.open();
        await page.waitForTimeout(300);
        // A week of the old filter never joins the strip once another filter loads, so the strip does not grow and shrink.
        if (order === "week first") await expect(item(page, "Retr01").count()).resolves.toBe(0);
        second.open();
        await requested((request) => filtered(request) && request.from === opening.to);
        await idle(page);
        await scrollToEnd(page);
        await item(page, "Retr01").waitFor();
        await expect(item(page, "Task02").count()).resolves.toBe(0);
      } finally {
        hold = async () => {};
        week.open();
        filter.open();
        await page.context().close();
      }
    }, 60_000);
  }

  test("fits the calendar header in one row and shows now after Today, on a phone and tablets", async () => {
    mkdirSync(shots, { recursive: true });
    for (const [name, view] of [
      ["phone-390", phone],
      ["ipad-1024", tablet],
      ["ipad-landscape-1366", { width: 1366, height: 1024, touch: true }],
      ["desktop-1440", desktop],
    ] as const) {
      const page = await open(view);
      // Today, the five views, and New event share one row: every control overlaps the others vertically.
      const oneRow = await page.locator(".k2b-calendar-header__actions a, .k2b-calendar-header__actions button").evaluateAll((elements) => {
        const boxes = elements.map((element) => element.getBoundingClientRect());
        return boxes.length >= 7 && Math.max(...boxes.map((rect) => rect.top)) < Math.min(...boxes.map((rect) => rect.bottom));
      });
      expect(oneRow).toBe(true);
      await page.screenshot({ path: join(shots, `${name}.png`) });
      await page.getByRole("link", { name: "Heute" }).click();
      await page.waitForTimeout(1000);
      const now = (await page.locator(".k2b-timeline__now").boundingBox())!;
      const strip = (await page.locator(".k2b-timeline__viewport").boundingBox())!;
      if (view === phone) expect(now.y).toBeGreaterThan(strip.y);
      if (view === phone) expect(now.y).toBeLessThan(strip.y + strip.height);
      else expect(now.x).toBeLessThan(strip.x + strip.width);
      await page.screenshot({ path: join(shots, `${name}-now.png`) });
      await page.context().close();
    }
  }, 90_000);
});
