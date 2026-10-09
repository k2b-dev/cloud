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
import { type CalendarFilter, parseCalendarRoute } from "./filter";

// Where the tray sits below the day, that the day never moves for it, and how focus moves through it are layout and
// interaction questions, so the calendar route renders on the server and then runs its real island bundle in a real
// browser, as the workspace page does. The scratch root sits inside this package's dependencies, so the island
// bundle resolves Solid from there.
const packageCache = resolve(import.meta.dir, "../../../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "spaces-calendar-tray-browser-"));
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
/** Light screenshots of the day view with its tray on a phone, tablets, and a desktop, kept for review. */
const shots = join(tmpdir(), "spaces-calendar-tray", browserName);

// Thursday, October 8, 2026, 14:20 in Kiel: the server renders at this time and the browser's clock shows it.
const NOW = new Date("2026-10-08T12:20:00.000Z");
const TODAY = "2026-10-08";
const timeZone = "Europe/Berlin";
const at = (day: number, time: string) => dates.zonedDateTimeToInstant(`2026-10-${String(day).padStart(2, "0")}T${time}`, timeZone);

const tags: SpaceTag[] = [
  { id: "Tag001", spaceId: "Space1", name: "Release", color: "#8b5cf6" },
  { id: "Tag002", spaceId: "Space1", name: "Kunden", color: "#0ea5e9" },
];
const columns = [{ id: "Col001", spaceId: "Space1", name: "Offen", color: "#f59e0b", rank: "1", isDone: false }];
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
const sample: CalendarItem[] = [
  event("Daily8", "Daily Stand-up", 8, "08:30", "09:00"),
  event("Work01", "Workshop Stadtwerke Kiel", 8, "09:30", "11:00", { location: "Raum Förde", tags: [tags[1]!] }),
  event("Plan01", "Release-Planung 4.2", 8, "16:00", "17:30", { location: "Raum Schlei", tags: [tags[0]!] }),
  event("Daily9", "Daily Stand-up", 9, "08:30", "09:00"),
];
/** The reader the page renders for. */
const READER = "99999999-9999-4999-8999-999999999999";
const trayTask = (id: string, title: string, deadline: string | null = null): SpaceItem => ({
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
});
/** Two overdue tasks, and three undated tasks of the reader of which the tray shows two. */
const sampleTray = (): CalendarTray => ({
  overdue: {
    items: [
      trayTask("Late01", "Vertrag Stadtwerke gegenzeichnen", at(6, "17:00")),
      trayTask("Late02", "Feedback zu Wireframes", at(5, "17:00")),
    ],
    total: 2,
  },
  undated: { items: [trayTask("Open01", "Kundenliste bereinigen"), trayTask("Open02", "Messe-Giveaways bestellen")], total: 3 },
});
const emptyTray = (): CalendarTray => ({ overdue: { items: [], total: 0 }, undated: { items: [], total: 0 } });
/** What the server sends: a tray only for the day view, and none while the calendar shows only events. */
const trayFor = (tray: CalendarTray, view: string, filter: CalendarFilter) => (view === "day" && filter.type !== "event" ? tray : null);
/** The items of the day the route names, as the calendar query returns them. */
const itemsOn = (items: CalendarItem[], date: string) => {
  const key = dates.formatDateKey(new Date(date), dateConfig);
  return items.filter((item) => item.startsAt && dates.formatDateKey(new Date(item.startsAt), dateConfig) === key);
};

const dateConfig = { locale: "de", timeZone, weekStartsOn: 1 as const };
const hrefOf = (date: string, view = "day") => `/app/spaces/Space1?view=calendar&cv=${view}&cd=${date}`;

type Case = { html: string; items: CalendarItem[]; tray: CalendarTray };

const serverBody = (options: { canWrite: boolean; items: CalendarItem[]; tray: CalendarTray; href: string }) => {
  setSystemTime(NOW);
  try {
    const route = parseCalendarRoute(new URL(options.href, "http://spaces.local"), dateConfig);
    return renderToString(() =>
      createComponent(CalendarFixture, {
        locale: "de",
        spaceId: "Space1",
        baseUrl: options.href,
        columns,
        tags,
        initialState: {
          ...route,
          items: route.view === "day" ? itemsOn(options.items, route.date) : options.items,
          weather: {},
          tray: trayFor(options.tray, route.view, route.filter),
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
const viewRequests: string[] = [];
const completions: unknown[] = [];
/** Holds the answer to a view request until the test lets it go; the answer itself is read when the request comes in. */
let hold: (href: string) => Promise<void> = async () => {};
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
        const href = url.searchParams.get("href") ?? "";
        viewRequests.push(href);
        const route = parseCalendarRoute(new URL(href, "http://spaces.local"), dateConfig);
        const body = {
          kind: "calendar",
          ...route,
          items: route.view === "day" ? itemsOn(data?.items ?? [], route.date) : (data?.items ?? []),
          weather: {},
          tray: trayFor(data?.tray ?? emptyTray(), route.view, route.filter),
        };
        await hold(href);
        return Response.json(body);
      }
      const completion = /^\/api\/spaces\/Space1\/items\/(\w+)\/completed$/.exec(url.pathname);
      if (completion && request.method === "POST" && data) {
        const body = (await request.json()) as { completed: boolean; claimId?: string };
        completions.push({ itemId: completion[1], ...body });
        if (body.completed) {
          for (const list of [data.tray.overdue, data.tray.undated]) {
            const kept = list.items.filter((item) => item.id !== completion[1]);
            list.total -= list.items.length - kept.length;
            list.items = kept;
          }
        }
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

const pageHtml = (options: { canWrite: boolean; items: CalendarItem[]; tray: CalendarTray; href: string }) =>
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
  options: { javaScript?: boolean; canWrite?: boolean; tray?: CalendarTray; href?: string } = {},
): Promise<Page> => {
  const id = `case${++caseCounter}`;
  const href = options.href ?? hrefOf(TODAY);
  const items = [...sample];
  const tray = structuredClone(options.tray ?? sampleTray());
  cases.set(id, { html: pageHtml({ canWrite: options.canWrite ?? true, items, tray, href }), items, tray });
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch && browserName === "chromium",
    hasTouch: view.touch,
    javaScriptEnabled: options.javaScript ?? true,
    timezoneId: timeZone,
    locale: "de-DE",
    colorScheme: "light",
    reducedMotion: "reduce",
    extraHTTPHeaders: { "x-case": id },
  });
  await context.clock.setFixedTime(NOW);
  const page = await context.newPage();
  await page.goto(`${server.url}${href.slice(1)}`);
  await page.evaluate(() => window.document.fonts.ready);
  if (options.javaScript ?? true) await hydrated(page);
  return page;
};
/** Solid attaches its delegated click handler to each item once the island has taken over the server markup. */
const hydrated = (page: Page) =>
  page.waitForFunction(() => Boolean((document.querySelector("[data-calendar-event]") as { $$click?: unknown } | null)?.$$click), {
    timeout: 15_000,
  });
const rounded = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} is not on screen`);
  return { x: Math.round(found.x), y: Math.round(found.y), width: Math.round(found.width), height: Math.round(found.height) };
};
const DAY = ".k2b-calendar-time-grid__scroll";
const TRAY = "[data-spaces-task-tray]";
/** Resolves once the server has seen a view request that `match` accepts. */
const requested = async (match: (href: string) => boolean) => {
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
/** What a live update does: the view refreshes the day it shows. */
const invalidate = (page: Page) =>
  page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("spaces-data-invalidated", { detail: { domains: ["view"], cursor: null, itemId: null, cover: () => {} } }),
    ),
  );
/** The accessible name of the focused control in the tray, or "" elsewhere. */
const focusedInTray = (page: Page) =>
  page.evaluate(() => {
    const focused = document.activeElement;
    if (!focused?.closest("[data-spaces-task-tray]")) return "";
    return focused.getAttribute("aria-label") ?? focused.textContent?.trim() ?? "tray";
  });

describe(`Spaces task tray in ${browserName}`, () => {
  test("keeps the tray below the day on every screen, and the day in place whether the tray is full, empty, or loading", async () => {
    mkdirSync(shots, { recursive: true });
    for (const [name, view] of [
      ["desktop-1440", desktop],
      ["ipad-1024", tablet],
      ["phone-390", phone],
    ] as const) {
      const server = await open(view, { javaScript: false });
      const serverDay = await rounded(server, DAY);
      const serverTray = await rounded(server, TRAY);
      await server.context().close();

      const full = await open(view);
      const day = await rounded(full, DAY);
      const tray = await rounded(full, TRAY);
      // Hydration moves nothing the server drew.
      expect(day).toEqual(serverDay);
      expect(tray).toEqual(serverTray);
      expect(tray.y).toBeGreaterThanOrEqual(day.y + day.height - 1);
      expect(tray.y + tray.height).toBeLessThanOrEqual(view.height);
      await full.getByText("Vertrag Stadtwerke gegenzeichnen").waitFor();
      await full.screenshot({ path: join(shots, `${name}.png`) });
      await full.context().close();

      const empty = await open(view, { tray: emptyTray() });
      expect(await rounded(empty, DAY)).toEqual(day);
      expect(await rounded(empty, TRAY)).toEqual(tray);
      await empty.getByText("Nichts überfällig und keine Aufgaben ohne Datum für dich").waitFor();
      await empty.context().close();
    }
  }, 120_000);

  test("keeps the row while a day opens from the month view, so the day does not move when its tasks come in", async () => {
    const page = await open(desktop, { href: hrefOf(TODAY, "month") });
    const loading = gate();
    hold = () => loading.wait;
    try {
      expect(await page.locator(TRAY).count()).toBe(0);
      await page.getByRole("radio", { name: "Tag" }).click();
      await page.locator(`${TRAY}[aria-busy="true"]`).waitFor();
      const before = await rounded(page, DAY);
      expect(await page.locator(TRAY).getByText("Nichts überfällig").count()).toBe(0);
      loading.open();
      await page.getByText("Vertrag Stadtwerke gegenzeichnen").waitFor();
      expect(await page.locator(TRAY).getAttribute("aria-busy")).toBeNull();
      expect(await rounded(page, DAY)).toEqual(before);
    } finally {
      hold = async () => {};
      loading.open();
      await page.context().close();
    }
  }, 60_000);

  test("reaches the tray right after the day with the keyboard", async () => {
    const page = await open(desktop);
    // The last stop of the calendar, wherever its day ends.
    await page.evaluate(() => {
      const calendar = document.querySelector(".k2b-content-calendar")!;
      const stops = [...calendar.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]:not([tabindex='-1'])")].filter(
        (element) => !element.closest("[data-spaces-task-tray]") && element.getClientRects().length > 0,
      );
      stops.at(-1)!.focus();
    });
    await page.keyboard.press("Tab");
    expect(await focusedInTray(page)).toBe("Als erledigt markieren: Vertrag Stadtwerke gegenzeichnen");
    await page.context().close();
  }, 60_000);

  test("keeps keyboard focus in the tray when a task checked off there leaves it", async () => {
    const page = await open(desktop);
    await page.getByRole("checkbox", { name: "Als erledigt markieren: Vertrag Stadtwerke gegenzeichnen" }).focus();
    await page.keyboard.press("Space");
    await page.locator('[data-spaces-tray-item="Late01"]').waitFor({ state: "detached" });
    // Focus moves to the box of the task that took its place, so the reader can go on checking tasks off.
    await page.waitForFunction(
      () => document.activeElement?.closest("[data-spaces-tray-item]")?.getAttribute("data-spaces-tray-item") === "Late02",
    );
    expect(await focusedInTray(page)).toBe("Als erledigt markieren: Feedback zu Wireframes");
    await page.context().close();
  }, 60_000);

  test("keeps a box checked while its change is in flight, whatever the reader presses meanwhile", async () => {
    const page = await open(desktop);
    const refresh = gate();
    hold = () => refresh.wait;
    try {
      completions.splice(0);
      viewRequests.splice(0);
      const box = page.getByRole("checkbox", { name: "Als erledigt markieren: Vertrag Stadtwerke gegenzeichnen" });
      await box.focus();
      await page.keyboard.press("Space");
      await requested(() => true);
      // The task is done but the tray waits for the refresh; another Space neither unchecks the box nor sends again.
      await page.keyboard.press("Space");
      expect(await box.isChecked()).toBe(true);
      expect(await focusedInTray(page)).toBe("Als erledigt markieren: Vertrag Stadtwerke gegenzeichnen");
      expect(completions).toEqual([{ itemId: "Late01", completed: true }]);
      refresh.open();
      await page.locator('[data-spaces-tray-item="Late01"]').waitFor({ state: "detached" });
    } finally {
      hold = async () => {};
      refresh.open();
      await page.context().close();
    }
  }, 60_000);

  test("keeps keyboard focus on a task of the tray while a refresh brings the same tasks again", async () => {
    const page = await open(desktop);
    const link = page.getByRole("link", { name: /Feedback zu Wireframes/ });
    await link.focus();
    // A mark on the element shows whether the refresh kept it or drew a new one.
    await link.evaluate((element) => element.setAttribute("data-kept", ""));
    viewRequests.splice(0);
    await invalidate(page);
    await requested(() => true);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-kept") ?? false)).toBe(true);
    await page.context().close();
  }, 60_000);

  test("checks off a task the reader claimed with that claim", async () => {
    const tray = sampleTray();
    tray.undated.items[0] = {
      ...tray.undated.items[0]!,
      claim: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        actor: { kind: "user", id: READER },
        displayName: "Lena",
        avatarHash: null,
        claimedAt: "2026-10-08T08:00:00.000Z",
      },
    };
    const page = await open(desktop, { tray });
    completions.splice(0);
    await page.locator('[data-spaces-tray-item="Open01"] .k2b-check').click();
    await page.locator('[data-spaces-tray-item="Open01"]').waitFor({ state: "detached" });
    expect(completions).toEqual([{ itemId: "Open01", completed: true, claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }]);
    await page.context().close();
  }, 60_000);

  test("checks a task off in the tray and opens another one in place, while the day stays where it is", async () => {
    const page = await open(desktop);
    completions.splice(0);
    const before = await rounded(page, '[data-space-item-id="Work01"]');
    await page.locator('[data-spaces-tray-item="Late01"] .k2b-check').click();
    await page.locator(".k2b-toast__description", { hasText: "Eintrag erledigt" }).waitFor();
    expect(completions).toEqual([{ itemId: "Late01", completed: true }]);
    await page.locator('[data-spaces-tray-item="Late01"]').waitFor({ state: "detached" });
    expect(await rounded(page, '[data-space-item-id="Work01"]')).toEqual(before);

    const opened = nextDetail(page);
    await page.getByRole("link", { name: /Feedback zu Wireframes/ }).click();
    expect(await opened).toContain("cv=day&cd=2026-10-08&item=Late02");
    // The reader has three undated tasks and sees two, so the tray links to the list with all of them.
    expect(await page.getByRole("link", { name: "Alle anzeigen: 3 deiner Aufgaben ohne Datum" }).getAttribute("href")).toBe(
      "/app/spaces/Space1?view=list&type=task&assignedTo=me&deadline=none&sort=priority",
    );
    await page.context().close();
  }, 60_000);

  test("offers no tray checkbox to a reader who may not change tasks", async () => {
    const page = await open(desktop, { canWrite: false });
    await page.getByText("Vertrag Stadtwerke gegenzeichnen").waitFor();
    await expect(page.locator(`${TRAY} input[type=checkbox]`).count()).resolves.toBe(0);
    await page.context().close();
  }, 60_000);

  test("fits Today, the four views, and New event in one header row on a phone and tablets", async () => {
    for (const view of [phone, tablet, { width: 1366, height: 1024, touch: true }, desktop]) {
      const page = await open(view);
      const oneRow = await page.locator(".k2b-calendar-header__actions a, .k2b-calendar-header__actions button").evaluateAll((elements) => {
        const boxes = elements.map((element) => element.getBoundingClientRect());
        return boxes.length >= 6 && Math.max(...boxes.map((rect) => rect.top)) < Math.min(...boxes.map((rect) => rect.bottom));
      });
      expect(oneRow).toBe(true);
      await page.context().close();
    }
  }, 90_000);
});
