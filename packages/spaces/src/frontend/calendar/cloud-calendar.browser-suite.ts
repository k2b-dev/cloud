import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { browserName, launchBrowser, settled } from "../../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import {
  type CalendarRange,
  type CalendarSourceRead,
  type CalendarSourceView,
  defaultSelection,
  parseCloudCalendarRoute,
  type SourcedCalendarItem,
  viewWindow,
} from "./calendar-model";
import { answerFor, ITEMS, NOW, SOURCES, SIDEBAR as sidebar, TIME_ZONE, TODAY } from "./cloud-calendar.browser-data";

// The page renders on the server and then runs its real island bundle in a real browser, as Spaces serves it.
const packageCache = resolve(import.meta.dir, "../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "spaces-cloud-calendar-browser-"));
registerSsrTestPlugin({ dev: false, verbose: false, rootDir: root, componentRoots: [import.meta.dir] });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: CloudCalendarFixture } = await import("./cloud-calendar.browser-fixture");

const ui = resolve(import.meta.dir, "../../../../ui/dist");
/** Light screenshots for review; one dark one checks the theme. */
const shots = join(tmpdir(), "spaces-cloud-calendar", browserName);
mkdirSync(shots, { recursive: true });

type Case = {
  locale: "en" | "de";
  /** Cloud could not ask the apps which calendars they offer. */
  catalogFails?: boolean;
  /** Apps the server had no time for: the browser asks them. */
  pending?: string[];
  /** Apps that fail every read until `recover` is called. */
  failing?: Set<string>;
  /** Holds every events answer until it resolves. */
  gate?: Promise<void>;
  items?: SourcedCalendarItem[];
  sources?: CalendarSourceView[];
};
const cases = new Map<string, Case>();
const requests: URL[] = [];
let css = "";
let controller = "";
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;

const dateConfigFor = (locale: "en" | "de") => ({ locale, timeZone: TIME_ZONE, weekStartsOn: 1 as const });

/** The status row under the head: the count, what still loads, and which calendars show busy times only. */
const STATUS = '[data-k2-part="StatusRow"]';
/** The warning above the calendar when a source does not answer, with Try again. */
const NOTICE = '[data-k2-part="Notice"]';
/** The page head: the views, search, and the calendar choice. */
const HEAD = '[data-k2-workspace] > .k2-ws-main > [data-slot="head"]';
/** The calendar choice in the head: "Kalender 9". */
const CHOOSER = `${HEAD} button[aria-haspopup="menu"]`;

/** The page's server work, as `page.tsx` does it, with the case's sources. */
const serverBody = (data: Case, href: string) => {
  setSystemTime(NOW);
  try {
    const dateConfig = dateConfigFor(data.locale);
    const route = parseCloudCalendarRoute(new URL(href, "http://spaces.local"), dateConfig);
    const range = viewWindow(route.view, route.date, dateConfig);
    const sources = data.catalogFails ? null : (data.sources ?? SOURCES);
    const selection = route.selection ?? defaultSelection(sources ?? []);
    const pending = new Set(data.pending ?? []);
    const answer = answerFor(range, selection, { failed: [...(data.failing ?? [])], items: data.items });
    const reads: CalendarSourceRead[] = sources
      ? answer.sources.map((read) => (pending.has(read.appId) ? { appId: read.appId, state: "pending", error: null } : read))
      : [];
    const items = sources ? answer.items.filter((item) => !pending.has(item.appId)) : [];
    return renderToString(() =>
      createComponent(CloudCalendarFixture, {
        locale: data.locale,
        sidebar,
        route,
        sources,
        range,
        items,
        reads,
        today: TODAY,
        now: NOW.toISOString(),
        canCreateSpace: true,
        dateConfig,
      }),
    );
  } finally {
    setSystemTime();
  }
};

const pageHtml = (data: Case, url: URL) => {
  const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
  return (
    `<!doctype html><html lang="${data.locale}" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style>` +
    "<style>solid-client,solid-island{display:contents}</style></head>" +
    // The page as Spaces draws it on v2: the workspace fills the window.
    `<body class="k2b-ui" data-theme="${theme}" style="margin:0"><main class="k2-ui" style="display:flex;flex-direction:column;height:100dvh;box-sizing:border-box">${serverBody(data, `${url.pathname}${url.search}`)}</main>` +
    `<script>${controller}</script><script type="module">await document.fonts.ready;document.documentElement.dataset.serverStatus=document.querySelector('${STATUS}')?.textContent??'';` +
    "await Promise.all(Array.from(document.querySelectorAll('solid-island'),e=>import('/_ssr/'+e.dataset.id+'.js')));document.documentElement.dataset.ready='true';</script></body></html>"
  );
};

beforeAll(async () => {
  const builds = await Promise.all(
    [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../cloud/src/styles/global.css")].map((entry) =>
      Bun.build({ entrypoints: [entry], plugins: [tailwind] }),
    ),
  );
  for (const build of builds) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(builds.flatMap((build) => build.outputs.map((output) => output.text())))),
  ].join("\n");
  const entry = resolve(import.meta.dir, "cloud-calendar.controller.ts");
  const built = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `import { installAppWorkspaceController } from ${JSON.stringify(join(ui, "browser/index.js"))}; installAppWorkspaceController();`,
    },
    target: "browser",
    format: "iife",
  });
  if (!built.success) throw new AggregateError(built.logs, "Could not bundle the workspace controller.");
  controller = await built.outputs[0]!.text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
      const data = cases.get(request.headers.get("x-case") ?? "");
      if (!data) return new Response("Not found", { status: 404 });
      if (url.pathname === "/api/spaces/calendar/events") {
        requests.push(url);
        await data.gate;
        const range: CalendarRange = { from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" };
        return Response.json(
          answerFor(range, url.searchParams.getAll("cal").filter(Boolean), { failed: [...(data.failing ?? [])], items: data.items }),
        );
      }
      if (url.pathname === "/api/spaces/calendar/sources") return Response.json({ sources: data.sources ?? SOURCES });
      if (url.pathname.startsWith("/api/")) return Response.json({});
      if (url.pathname !== "/app/spaces/calendar") return new Response("Not found", { status: 404 });
      return new Response(pageHtml(data, url), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  browser = await launchBrowser();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

/** Pins only `Date` to the fixture's instant; timers and animation frames keep running as in a real browser. */
const pinPageClock = (at: number) => {
  const RealDate = Date;
  const offset = at - RealDate.now(); // real clock: the page's distance to the pinned instant
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0)
        super(RealDate.now() + offset); // real clock: flows from the pinned instant
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now() {
      return RealDate.now() + offset; // real clock: flows from the pinned instant
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
};

type View = { width: number; height: number; touch: boolean };
const desktop: View = { width: 1440, height: 900, touch: false };
const phone: View = { width: 390, height: 844, touch: true };
let caseCount = 0;

const open = async (view: View, path: string, data: Case) => {
  const id = `case-${++caseCount}`;
  cases.set(id, data);
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    hasTouch: view.touch,
    isMobile: view.touch && browserName === "chromium",
    timezoneId: TIME_ZONE,
    locale: data.locale === "de" ? "de-DE" : "en-US",
    reducedMotion: "reduce",
    extraHTTPHeaders: { "x-case": id },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.addInitScript(pinPageClock, NOW.getTime());
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(new URL(path, server.url).href);
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
  await page.evaluate(() => document.fonts.ready);
  return { page, errors, close: () => context.close() };
};
const shoot = (page: Page, name: string) => page.screenshot({ path: join(shots, `${name}.png`) });
/** The first match inside the window, so a click never scrolls the strip to another week. */
const onScreen = async (page: Page, name: RegExp) => {
  await settled(page);
  const matches = page.getByRole("button", { name });
  for (let index = 0; index < (await matches.count()); index++) {
    const rect = await matches.nth(index).boundingBox();
    if (rect && rect.x >= 280 && rect.x + rect.width <= desktop.width && rect.y >= 0 && rect.y < desktop.height) return matches.nth(index);
  }
  throw new Error(`No ${name} on screen`);
};
const box = async (page: Page, selector: string) => {
  await settled(page);
  const rect = await page.locator(selector).first().boundingBox();
  if (!rect) throw new Error(`No box for ${selector}`);
  return rect;
};

describe("calendar of all Spaces and apps", () => {
  test("the week shows every chosen calendar, names it in the sidebar, and keeps the server's first picture", async () => {
    const { page, errors, close } = await open(desktop, "/app/spaces/calendar?view=week&date=2026-10-27", { locale: "de" });
    try {
      await shoot(page, "01-week-de");
      expect(await page.locator('.k2-ws-side [aria-current="page"]').textContent()).toContain("Kalender");
      expect(await page.locator(`${HEAD} [aria-current="page"]`).textContent()).toContain("Woche");
      // Nine suggested calendars; the busy-only and the shift calendar wait for a choice.
      expect(await page.getByRole("button", { name: /Kalender 9/ }).count()).toBe(1);
      // The choice keeps its name in the head; the views are the head's tabs, so the calendar shows no switcher of its own.
      expect(await page.locator(`${CHOOSER} .k2-btn-label`).isVisible()).toBe(true);
      expect(await page.locator(".k2b-calendar-view-switcher").count()).toBe(0);
      for (const title of ["Gabelstapler-Wartung", "All-Hands Q4", "Malte Sommer · abwesend", "Erste-Hilfe-Auffrischung"])
        expect(await page.getByText(title, { exact: false }).count()).toBeGreaterThan(0);
      expect(await page.getByText("Frühschicht").count()).toBe(0);
      // Nothing loaded after mount, and the status row stayed what the server rendered.
      expect(requests.length).toBe(0);
      expect(await page.locator(STATUS).textContent()).toBe((await page.locator("html").getAttribute("data-server-status")) ?? "");
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  test("choosing calendars loads only the added one, keeps it in the URL, and survives a reload", async () => {
    const { page, close } = await open(desktop, "/app/spaces/calendar?view=week&date=2026-10-27", { locale: "de" });
    try {
      const chip = page.getByRole("button", { name: /Kalender 9/ });
      const chipBefore = await chip.boundingBox();
      await chip.click();
      const menu = page.getByRole("menu");
      expect(await menu.getByText("Abwesenheiten").count()).toBeGreaterThan(0);
      await shoot(page, "02-chooser-de");
      const before = requests.length;
      await menu.getByRole("menuitemcheckbox", { name: /^Meine Schichten/ }).click();
      await page.getByText("Frühschicht").first().waitFor();
      const added = requests.slice(before);
      expect(added.length).toBeGreaterThan(0);
      for (const request of added) expect(request.searchParams.getAll("cal")).toEqual(["shifts:meine"]);
      expect(new URL(page.url()).searchParams.getAll("cal")).toContain("shifts:meine");
      expect(await page.getByRole("button", { name: /Kalender 10/ }).count()).toBe(1);
      // Unticking a calendar takes it out at once and loads nothing.
      if (!(await menu.isVisible())) await page.getByRole("button", { name: /Kalender 10/ }).click();
      const beforeRemoval = requests.length;
      await menu.getByRole("menuitemcheckbox", { name: /^Firmenevents/ }).click();
      await page.getByRole("button", { name: /Kalender 9/ }).waitFor();
      expect(requests.length).toBe(beforeRemoval);
      expect(new URL(page.url()).searchParams.getAll("cal")).not.toContain("intranet:firmenevents");
      await page.keyboard.press("Escape");
      expect(await page.getByText("All-Hands Q4").count()).toBe(0);
      // k2b-ui gap: a menu entry has no "only this one" (see CloudCalendar), so choosing one calendar alone is unticking.
      await page.reload();
      await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
      expect(await page.getByRole("button", { name: /Kalender 9/ }).count()).toBe(1);
      expect(await page.getByText("Frühschicht").count()).toBeGreaterThan(0);
      expect(await page.getByText("All-Hands Q4").count()).toBe(0);
      const chipAfter = await page.getByRole("button", { name: /Kalender 9/ }).boundingBox();
      expect(chipAfter?.y).toBe(chipBefore?.y);
    } finally {
      await close();
    }
  }, 60_000);

  test("an event opens its details beside it, with its series, place, source, and a link into its app", async () => {
    const { page, close } = await open(desktop, "/app/spaces/calendar?view=week&date=2026-10-27", { locale: "de" });
    try {
      await (await onScreen(page, /Team-Meeting Logistik/)).click();
      // The dialog is named after the entry it shows.
      const dialog = page.getByRole("dialog", { name: /Team-Meeting Logistik/ });
      await dialog.waitFor();
      expect(await dialog.textContent()).toContain("Meetings");
      expect(await dialog.textContent()).toContain("Raum Elbe");
      expect(await dialog.textContent()).toMatch(/Dienstag/);
      await shoot(page, "03-detail-de");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await (await onScreen(page, /Gabelstapler-Wartung/)).click();
      const link = page.getByRole("dialog").getByRole("link", { name: /In Werkstatt öffnen/ });
      expect(await link.getAttribute("href")).toMatch(/^\/app\/spaces\/Werks1\?item=/);
      // Another zone says both times.
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await (await onScreen(page, /Call mit Partner Chicago/)).click();
      expect(await page.getByRole("dialog", { name: /Call mit Partner Chicago/ }).textContent()).toContain("in Chicago");
    } finally {
      await close();
    }
  }, 60_000);

  test("month and list show the same calendars", async () => {
    const month = await open(desktop, "/app/spaces/calendar?view=month&date=2026-10-27", { locale: "de" });
    try {
      expect(await month.page.locator(`${HEAD} [aria-current="page"]`).textContent()).toContain("Monat");
      expect(await month.page.getByText("Reformationstag").count()).toBeGreaterThan(0);
      await shoot(month.page, "04-month-de");
    } finally {
      await month.close();
    }
    const list = await open(desktop, "/app/spaces/calendar?view=list&date=2026-10-27", { locale: "de" });
    try {
      expect(await list.page.locator(".spaces-calendar-agenda__day").first().textContent()).toContain("Heute");
      expect(await list.page.getByText("Lieferantencall Spedition Nord").count()).toBe(1);
      expect(await list.page.getByText("Rechnungen freigeben").count()).toBe(1);
      await shoot(list.page, "05-list-de");
      // The next page of the list starts 14 days later.
      const next = list.page.locator('.k2b-calendar-header a[aria-label="Weiter"], .k2b-calendar-header a[title="Weiter"]').first();
      if ((await next.count()) > 0) expect(await next.getAttribute("href")).toContain("date=2026-11-10");
    } finally {
      await list.close();
    }
  }, 60_000);

  test("a slow source loads in the browser while the rest shows, and the status line moves nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { page, close } = await open(desktop, "/app/spaces/calendar?view=week&date=2026-10-27", {
      locale: "de",
      pending: ["absence", "academy"],
      gate,
    });
    try {
      const status = page.locator(STATUS);
      expect(await status.textContent()).toContain("Lädt 3 von 9 Kalendern");
      const chip = await box(page, CHOOSER);
      const statusBox = await box(page, STATUS);
      expect(await page.getByText("Gabelstapler-Wartung").count()).toBeGreaterThan(0);
      expect(await page.getByText("Erste-Hilfe-Auffrischung").count()).toBe(0);
      await shoot(page, "06-loading-de");
      release();
      await page.getByText("Erste-Hilfe-Auffrischung").first().waitFor();
      await page.waitForFunction((selector) => !document.querySelector(selector)?.textContent?.includes("Lädt"), STATUS);
      expect(await box(page, CHOOSER)).toEqual(chip);
      const after = await box(page, STATUS);
      expect({ y: after.y, height: after.height }).toEqual({ y: statusBox.y, height: statusBox.height });
    } finally {
      await close();
    }
  }, 60_000);

  test("a late source with one all-day entry moves nothing: the all-day row always holds one line", async () => {
    // Without the dated deadline of Spaces, only the late absences bring all-day entries; they fit one line.
    const items = ITEMS.filter((item) => !(item.type === "deadline" && item.due.kind === "date"));
    for (const view of ["day", "week"] as const) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { page, close } = await open(desktop, `/app/spaces/calendar?view=${view}&date=2026-10-27`, {
        locale: "de",
        pending: ["absence"],
        gate,
        items,
      });
      try {
        await page.getByText("Lädt 2 von 9 Kalendern", { exact: false }).waitFor();
        expect(await page.getByText("Malte Sommer · abwesend").count()).toBe(0);
        const before = await box(page, '[data-calendar-event]:has-text("Gabelstapler-Wartung")');
        release();
        await page.getByText("Malte Sommer · abwesend").first().waitFor();
        const after = await box(page, '[data-calendar-event]:has-text("Gabelstapler-Wartung")');
        expect({ view, x: after.x, y: after.y, height: after.height }).toEqual({ view, x: before.x, y: before.y, height: before.height });
      } finally {
        await close();
      }
    }
  }, 60_000);

  test("a failing source is named with Try again, the others stay, and a retry recovers it", async () => {
    const failing = new Set(["absence"]);
    const { page, close } = await open(desktop, "/app/spaces/calendar?view=week&date=2026-10-27", { locale: "de", failing });
    try {
      // The warning above the calendar names the app that does not answer.
      const notice = page.locator(NOTICE);
      expect(await notice.textContent()).toContain("Abwesenheiten antwortet nicht.");
      expect(await notice.textContent()).toContain("Die anderen Kalender sind aktuell.");
      expect(await page.getByText("Gabelstapler-Wartung").count()).toBeGreaterThan(0);
      await shoot(page, "07-failed-de");
      // The choice marks its calendars as not reachable beside their names.
      await page.getByRole("button", { name: /Kalender 9/ }).click();
      expect(await page.getByRole("menu").getByText("nicht erreichbar").count()).toBeGreaterThan(0);
      await page.keyboard.press("Escape");
      failing.clear();
      await notice.getByRole("button", { name: "Erneut versuchen" }).click();
      await page.getByText("Malte Sommer · abwesend").first().waitFor();
      await notice.waitFor({ state: "detached" });
    } finally {
      await close();
    }
  }, 60_000);

  test("a busy-only calendar says so and shows Busy without any detail", async () => {
    const { page, close } = await open(
      desktop,
      `/app/spaces/calendar?view=week&date=2026-10-27&${defaultSelection(SOURCES)
        .concat("meetings:gf")
        .map((key) => `cal=${encodeURIComponent(key)}`)
        .join("&")}`,
      { locale: "de" },
    );
    try {
      expect(await page.locator(STATUS).textContent()).toContain("Meetings · Geschäftsführung: nur frei/belegt sichtbar");
      await (await onScreen(page, /^Belegt/)).click();
      const dialog = page.getByRole("dialog");
      expect(await dialog.textContent()).toContain("Du siehst bei diesem Kalender nur, wann Zeit belegt ist.");
      expect(await dialog.getByRole("link").count()).toBe(0);
      await shoot(page, "08-busy-de");
    } finally {
      await close();
    }
  }, 60_000);

  test("no calendar, no event, and no catalog each say what happened and offer the way on", async () => {
    const none = await open(desktop, "/app/spaces/calendar?view=week&date=2026-10-27&cal=", { locale: "de" });
    try {
      await none.page.getByText("Kein Kalender gewählt").waitFor();
      await shoot(none.page, "09-no-calendar-de");
      await none.page.getByRole("button", { name: "Standard-Kalender laden" }).click();
      await none.page.getByText("Gabelstapler-Wartung").first().waitFor();
      expect(new URL(none.page.url()).searchParams.has("cal")).toBe(false);
    } finally {
      await none.close();
    }
    const empty = await open(desktop, "/app/spaces/calendar?view=week&date=2026-11-16", { locale: "de", items: [] });
    try {
      await empty.page.getByText("Keine Termine in dieser Woche").waitFor();
      expect(await empty.page.getByRole("link", { name: "Zu heute" }).getAttribute("href")).toContain("date=2026-10-27");
      await shoot(empty.page, "10-empty-week-de");
    } finally {
      await empty.close();
    }
    const failed = await open(desktop, "/app/spaces/calendar?view=week&date=2026-10-27", { locale: "de", catalogFails: true });
    try {
      await failed.page.getByText("Kalender konnten nicht geladen werden").waitFor();
      expect(await failed.page.getByText("Keine Termine").count()).toBe(0);
      await shoot(failed.page, "11-catalog-failed-de");
      await failed.page.getByRole("button", { name: "Erneut versuchen" }).click();
      await failed.page.getByText("Gabelstapler-Wartung").first().waitFor();
    } finally {
      await failed.close();
    }
  }, 90_000);

  test("on a phone the list and the day fit, the title names the calendar, and an event opens in a sheet", async () => {
    const { page, errors, close } = await open(phone, "/app/spaces/calendar?view=list&date=2026-10-27", { locale: "de" });
    try {
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(phone.width);
      await shoot(page, "12-phone-list-de");
      await page
        .getByRole("button", { name: /Gabelstapler-Wartung/ })
        .first()
        .click();
      await page.getByRole("dialog", { name: /Gabelstapler-Wartung/ }).waitFor();
      await shoot(page, "13-phone-detail-de");
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
    const day = await open(phone, "/app/spaces/calendar?view=day&date=2026-10-27", { locale: "de" });
    try {
      expect(await day.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone.width);
      await shoot(day.page, "14-phone-day-de");
    } finally {
      await day.close();
    }
  }, 90_000);

  test("English and the dark theme read the same calendars", async () => {
    const { page, close } = await open(desktop, "/app/spaces/calendar?view=week&date=2026-10-27&theme=dark", { locale: "en" });
    try {
      expect(await page.getByRole("button", { name: /Calendars 9/ }).count()).toBe(1);
      expect(await page.locator(`${HEAD} [aria-current="page"]`).textContent()).toContain("Week");
      await shoot(page, "15-week-dark-en");
    } finally {
      await close();
    }
  }, 60_000);
});
