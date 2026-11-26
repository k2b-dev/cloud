import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";
import { evening, FIXTURE_NOW, fixtureDashboard, fixtureSettings, lunch, SHIFT_DAY } from "./fixtures";

// The main paths of Venue on v2: find and create a venue, open a shift from the calendar, join it with the following
// weeks, remove someone as an admin, Back and Forward over the selection, sign up from the dialog, leave one of my
// shifts, renew the calendar link, plus the layout rules at 1440, 1024 and 390 px, the worst case and 1,000 venues.
// The harness renders each page from its address; this test answers the APIs with invented data.
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type BrowserContext = Awaited<ReturnType<Browser["newContext"]>>;
type Page = Awaited<ReturnType<BrowserContext["newPage"]>>;
type Route = Parameters<Extract<Parameters<Page["route"]>[1], (...args: never[]) => unknown>>[0];

const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_VENUE_V2_SHOTS;
const schedule = `/app/venue/Cafe01/shifts?cv=week&cd=${SHIFT_DAY}`;
const lunchId = `Temp01:${SHIFT_DAY}`;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "VenueScreens.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-venue-screens-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Venue screens harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let css: string;
let harness: string;
let icons: { css: string; font: string };
beforeAll(async () => {
  harness = await buildHarness();
  const iconCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
  const iconCss = await Bun.file(fileURLToPath(iconCssUrl)).text();
  const fontAsset = iconCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
  if (!fontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
  icons = { css: iconCss.replace(fontAsset, "/tabler-icons.woff2"), font: fileURLToPath(new URL(fontAsset, iconCssUrl)) };
  // A Cloud page loads the v1 sheet and then v2.css; the calendar (a rich v1 component) needs the first.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", ui))).default;
  const styles = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss, v2Css].join("\n");
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const page = (variant: string, permission: string) =>
  `<!doctype html><html lang="de" class="light" data-variant="${variant}" data-permission="${permission}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

/** Pins only Date in the page, flowing from the fixture instant; timers and frames stay real. */
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
const tablet: View = { width: 1024, height: 768, touch: true };
const phone: View = { width: 390, height: 844, touch: true };

type Call = { method: string; path: string; body: unknown };
const answer = async (route: Route, calls: Call[]) => {
  const request = route.request();
  const url = new URL(request.url());
  const call: Call = { method: request.method(), path: url.pathname, body: request.postData() ? JSON.parse(request.postData()!) : null };
  calls.push(call);
  if (call.method === "POST" && call.path === "/api/venue/venues") return route.fulfill({ status: 201, json: { id: "New001" } });
  if (call.path.endsWith("/dashboard")) return route.fulfill({ json: fixtureDashboard() });
  if (call.method === "POST" && call.path.includes("/signup-weeks")) return route.fulfill({ status: 201, json: [{}, {}, {}] });
  if (call.method === "POST" && call.path.endsWith("/signup")) return route.fulfill({ status: 201, json: {} });
  if (call.method === "DELETE") return route.fulfill({ json: { message: "Shift cancelled" } });
  if (call.path.endsWith("/settings-context")) return route.fulfill({ json: fixtureSettings() });
  if (call.method === "PATCH" && call.path === "/api/venue/venues/Cafe01") return route.fulfill({ json: {} });
  if (call.method === "PATCH" && call.path.includes("/templates/")) return route.fulfill({ json: {} });
  if (call.method === "PUT" && call.path.endsWith("/sections/order")) return route.fulfill({ json: {} });
  if (call.method === "PATCH" && call.path.includes("/sections/")) return route.fulfill({ json: {} });
  if (call.path.endsWith("/calendar/my/renew"))
    return route.fulfill({ json: { href: "https://cloud.example.test/api/venue/calendar/new-token.ics" } });
  return route.fulfill({ status: 404, json: { message: "Not found" } });
};

const open = async (view: View, address: string, options: { variant?: string; permission?: string } = {}) => {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  const errors = pageErrors(tab);
  const calls: Call[] = [];
  await context.addInitScript(pinPageClock, Date.parse(FIXTURE_NOW));
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    if (url.pathname.startsWith("/api/")) return answer(route, calls);
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: page(options.variant ?? "normal", options.permission ?? "admin"),
    });
  });
  await tab.goto(`${origin}${address}`);
  await tab.waitForSelector('body[data-ready="true"]');
  const ready = Number(await tab.locator("body").getAttribute("data-ready-at"));
  await tab.evaluate(() => window.document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, calls, ready };
};

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `${name}.png`) });
};
const writes = (calls: Call[]) => calls.filter((call) => call.method !== "GET");
const detail = (tab: Page) => tab.locator('[data-k2-part="Pane"][data-detail]');
const shiftInUrl = (tab: Page) => new URL(tab.url()).searchParams.get("shift");

describe("Venue on v2", () => {
  test("the venue list filters as it is typed and creates a venue from the head", async () => {
    const { context, tab, errors, calls } = await open(desktop, "/app/venue");
    try {
      await shoot(tab, "venues-1440");
      await tab.getByRole("searchbox", { name: "Standorte durchsuchen" }).fill("keller");
      await tab.waitForFunction(() => location.search === "?q=keller");
      expect(await tab.getByText("1 von 3").isVisible()).toBe(true);
      await tab.getByRole("button", { name: "Neuer Standort" }).first().click();
      await tab.getByRole("menuitem", { name: /Leerer Standort/ }).click();
      const dialog = tab.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Mensa Süd");
      await dialog.getByRole("button", { name: "Erstellen" }).click();
      await tab.waitForURL(`${origin}/app/venue/New001`);
      expect(writes(calls)[0]).toMatchObject({ method: "POST", path: "/api/venue/venues", body: { name: "Mensa Süd", slug: "mensa-sud" } });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a shift opens beside the calendar from one click, Back closes it and Forward opens it again", async () => {
    const { context, tab, errors } = await open(desktop, schedule);
    try {
      expect(await detail(tab).count()).toBe(0);
      await tab.locator("[data-calendar-event]", { hasText: "Mittagstheke" }).first().click();
      await detail(tab).waitFor();
      expect(shiftInUrl(tab)).toBe(lunchId);
      expect(await detail(tab).innerText()).toContain("Sam Beispiel");
      await shoot(tab, "shift-open-1440");
      expect((await measureV2Layout(tab)).problems).toEqual([]);
      await tab.goBack();
      await tab.waitForFunction(() => !location.search.includes("shift="));
      await detail(tab).waitFor({ state: "detached" });
      await tab.goForward();
      await detail(tab).waitFor();
      expect(shiftInUrl(tab)).toBe(lunchId);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("staff join a shift with the following weeks; admins remove someone after a question", async () => {
    const staff = await open(desktop, `${schedule}&shift=${lunchId}`, { permission: "write" });
    try {
      // staff remove nobody; the reload after the join answers as an admin, so this is read before it
      expect(
        await detail(staff.tab)
          .getByRole("button", { name: /Kim Muster entfernen/ })
          .count(),
      ).toBe(0);
      await detail(staff.tab)
        .getByRole("checkbox", { name: /nächsten 4 Wochen|next 4 weeks/ })
        .click();
      await detail(staff.tab).getByRole("button", { name: "Schicht übernehmen" }).click();
      await staff.tab.waitForFunction(() => document.body.innerText.length > 0);
      await settled(staff.tab);
      expect(writes(staff.calls)).toEqual([
        { method: "POST", path: "/api/venue/venues/Cafe01/templates/Temp01/signup-weeks", body: { date: SHIFT_DAY, weeks: 5 } },
      ]);
      expect(staff.errors).toEqual([]);
    } finally {
      await staff.context.close();
    }
    const admin = await open(desktop, `${schedule}&shift=${lunchId}`);
    try {
      await detail(admin.tab).getByRole("button", { name: "Sam Beispiel entfernen" }).click();
      const question = admin.tab.getByRole("alertdialog");
      expect(await question.innerText()).toContain("Mittagstheke");
      await question.getByRole("button", { name: "Entfernen" }).click();
      await admin.tab.waitForFunction(() => document.querySelector('[role="alertdialog"]') === null);
      await settled(admin.tab);
      expect(writes(admin.calls)).toEqual([{ method: "DELETE", path: "/api/venue/venues/Cafe01/assignments/Asg002", body: null }]);
      expect(admin.errors).toEqual([]);
    } finally {
      await admin.context.close();
    }
  }, 60_000);

  test("on the phone the open shift is the page, with the way back to the schedule", async () => {
    const { context, tab, errors } = await open(phone, `/app/venue/Cafe01/shifts?cv=mobile-month&cd=${SHIFT_DAY}&shift=${lunchId}`);
    try {
      await shoot(tab, "shift-open-390");
      expect(await tab.getByRole("link", { name: "Dienstplan" }).first().isVisible()).toBe(true);
      expect((await measureV2Layout(tab)).problems).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the sign-up dialog lists the open shifts by day and takes one", async () => {
    const { context, tab, errors, calls } = await open(desktop, schedule, { permission: "write" });
    try {
      await tab.getByRole("button", { name: "Schicht übernehmen" }).first().click();
      const dialog = tab.getByRole("dialog");
      await dialog.getByText("Mittagstheke").first().waitFor();
      // the full evening shift is the viewer's own, so it stays listed with Leave
      expect(await dialog.getByText("Abendschicht").count()).toBeGreaterThan(0);
      await dialog.getByRole("button", { name: "Schicht übernehmen" }).first().click();
      await dialog.waitFor({ state: "detached" });
      expect(writes(calls)).toEqual([
        { method: "POST", path: "/api/venue/venues/Cafe01/templates/Temp01/signup", body: { date: lunch.date } },
      ]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("leaving one of my shifts asks first; the calendar link renews after a question", async () => {
    const { context, tab, errors, calls } = await open(desktop, "/app/venue/Cafe01/my-shifts", { permission: "write" });
    try {
      await shoot(tab, "my-shifts-1440");
      await tab.getByRole("button", { name: "Austreten" }).first().click();
      await tab.getByRole("alertdialog").getByRole("button", { name: "Austreten" }).click();
      await tab.waitForFunction(() => document.querySelector('[role="alertdialog"]') === null);
      await settled(tab);
      expect(writes(calls)).toEqual([
        { method: "DELETE", path: `/api/venue/venues/Cafe01/assignments/${evening.assignments[0]!.id}`, body: null },
      ]);
      await tab.getByRole("button", { name: "Kalender abonnieren" }).click();
      const dialog = tab.getByRole("dialog");
      await dialog.getByRole("button", { name: "Link erneuern" }).click();
      await tab.getByRole("alertdialog").getByRole("button", { name: "Link erneuern" }).click();
      await dialog.getByText("new-token.ics").waitFor();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("settings save the general fields once and read the settings again", async () => {
    const { context, tab, errors, calls } = await open(desktop, "/app/venue/Cafe01/settings");
    try {
      await tab.getByRole("textbox", { name: "Name", exact: true }).fill("Campus-Café Süd");
      await tab.getByRole("button", { name: "Speichern" }).click();
      await tab.waitForFunction(() => document.body.innerText.includes("gespeichert") || document.body.innerText.includes("Gespeichert"));
      expect(writes(calls)).toHaveLength(1);
      expect(writes(calls)[0]).toMatchObject({
        method: "PATCH",
        path: "/api/venue/venues/Cafe01",
        body: { name: "Campus-Café Süd", slug: "campus-cafe" },
      });
      expect(calls.some((call) => call.path.endsWith("/settings-context"))).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a shift pauses from its menu; deleting the venue takes its typed name", async () => {
    const schedulePage = await open(desktop, "/app/venue/Cafe01/settings/schedule");
    try {
      await shoot(schedulePage.tab, "settings-schedule-1440");
      await schedulePage.tab
        .getByRole("button", { name: /Mittagstheke/ })
        .first()
        .click();
      await schedulePage.tab.getByRole("menuitem", { name: /pausieren/i }).click();
      await schedulePage.tab.waitForFunction(() => document.body.innerText.length > 0);
      await settled(schedulePage.tab);
      const pause = writes(schedulePage.calls).find((call) => call.method === "PATCH");
      expect(pause).toMatchObject({ path: "/api/venue/venues/Cafe01/templates/Temp01", body: { active: false, title: "Mittagstheke" } });
      expect(schedulePage.errors).toEqual([]);
    } finally {
      await schedulePage.context.close();
    }
    const danger = await open(desktop, "/app/venue/Cafe01/settings/danger");
    try {
      await danger.tab.getByRole("button", { name: "Standort löschen" }).first().click();
      const dialog = danger.tab.getByRole("dialog");
      const confirm = dialog.getByRole("button", { name: "Standort löschen" });
      expect(await confirm.isDisabled()).toBe(true);
      await dialog.getByRole("textbox").fill("Campus-Café Nord");
      await confirm.click();
      await danger.tab.waitForURL(`${origin}/app/venue`);
      expect(writes(danger.calls)).toEqual([{ method: "DELETE", path: "/api/venue/venues/Cafe01", body: null }]);
      expect(danger.errors).toEqual([]);
    } finally {
      await danger.context.close();
    }
  }, 90_000);

  test("public page: a section moves with its button and keeps focus, its switch saves only the visibility", async () => {
    const { context, tab, errors, calls } = await open(desktop, "/app/venue/Cafe01/public");
    try {
      await shoot(tab, "public-editor-1440");
      const down = tab.getByRole("button", { name: "Nach unten: Kuchen und Getränke" });
      await down.focus();
      await tab.keyboard.press("Enter");
      await tab.waitForFunction(() =>
        document.querySelector('[role="status"][aria-live="polite"]')?.textContent?.includes("Kuchen und Getränke"),
      );
      await settled(tab);
      expect(writes(calls)[0]).toEqual({
        method: "PUT",
        path: "/api/venue/venues/Cafe01/sections/order",
        body: { sectionIds: ["Sec002", "Sec001"] },
      });
      expect(await tab.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toContain("Kuchen und Getränke");
      await tab
        .getByRole("button", { name: /Heute Lesung/ })
        .last()
        .click();
      await tab.getByRole("menuitemcheckbox", { name: "Auf der öffentlichen Seite zeigen" }).click();
      await tab.waitForFunction(() => document.body.innerText.length > 0);
      await settled(tab);
      expect(writes(calls).find((call) => call.method === "PATCH")).toEqual({
        method: "PATCH",
        path: "/api/venue/venues/Cafe01/sections/Sec002",
        body: { enabled: true },
      });
      // The public page switch reads the venue fresh and saves it with only the switch changed.
      const before = calls.length;
      // the switch input itself is drawn by its label, so the label takes the click
      await tab.getByText("Öffentliche Seite an", { exact: true }).click();
      await tab.waitForFunction(() => document.body.innerText.length > 0);
      await settled(tab);
      const after = calls.slice(before).filter((call) => !call.path.endsWith("/dashboard") && !call.path.endsWith("/public-preview"));
      expect(after.map((call) => `${call.method} ${call.path}`)).toEqual([
        "GET /api/venue/venues/Cafe01/settings-context",
        "PATCH /api/venue/venues/Cafe01",
      ]);
      expect(after[1]?.body).toMatchObject({ publicEnabled: false, name: "Campus-Café Nord", slug: "campus-cafe" });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("feedback filters are statements in the filter bar and live in the address", async () => {
    const { context, tab, errors } = await open(desktop, "/app/venue/Cafe01/feedback");
    try {
      await shoot(tab, "feedback-1440");
      await tab
        .getByRole("button", { name: /Zeitraum/ })
        .first()
        .click();
      await tab.getByRole("option", { name: /7 Tage/ }).click();
      await tab.waitForURL(/days=7/);
      expect(new URL(tab.url()).pathname).toBe("/app/venue/Cafe01/feedback");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("every page keeps the layout rules at 1440, 1024 and 390 px", async () => {
    const addresses = [
      "/app/venue",
      schedule,
      `${schedule}&shift=${lunchId}`,
      "/app/venue/Cafe01/my-shifts",
      "/app/venue/Cafe01/feedback",
      "/app/venue/Cafe01/public",
      "/app/venue/Cafe01/settings",
      "/app/venue/Cafe01/settings/access",
      "/app/venue/Cafe01/settings/schedule",
      "/app/venue/Cafe01/settings/danger",
    ];
    const found: string[] = [];
    for (const view of [desktop, tablet, phone])
      for (const address of addresses) {
        const { context, tab, errors } = await open(view, address);
        try {
          const name = `${address.replace(/^\/app\/venue\/?/, "").replace(/[^a-z0-9]+/gi, "-") || "venues"}-${view.width}`;
          await shoot(tab, name);
          for (const problem of (await measureV2Layout(tab)).problems) found.push(`${name}: ${problem}`);
          found.push(...errors.map((error) => `${name}: ${error}`));
        } finally {
          await context.close();
        }
      }
    expect(found).toEqual([]);
  }, 300_000);

  test("worst-case names keep their rows and break nothing (break-ui)", async () => {
    const found: string[] = [];
    for (const view of [desktop, phone])
      for (const address of ["/app/venue", `${schedule}&shift=${lunchId}`]) {
        const { context, tab, errors } = await open(view, address, { variant: "worst" });
        try {
          const name = `worst-${address.replace(/[^a-z0-9]+/gi, "-")}-${view.width}`;
          await shoot(tab, name);
          for (const problem of (await measureV2Layout(tab)).problems) found.push(`${name}: ${problem}`);
          if (await tab.evaluate(() => document.documentElement.scrollWidth > window.innerWidth))
            found.push(`${name}: the page scrolls sideways`);
          found.push(...errors.map((error) => `${name}: ${error}`));
        } finally {
          await context.close();
        }
      }
    expect(found).toEqual([]);
  }, 180_000);

  test("1,000 venues are ready in time", async () => {
    const { context, tab, errors, ready } = await open(desktop, "/app/venue", { variant: "huge" });
    try {
      const nodes = await tab.evaluate(() => document.querySelectorAll("*").length);
      console.log(`[scale] /app/venue: ready ${ready} ms, ${nodes} elements`);
      expect(ready).toBeLessThan(1500);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);
});
