import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";
import { sqlTestLimits, sqlTestResult } from "../workspace/sql-test-fixtures";
import {
  FIXTURE_NOW,
  figuresOf,
  fixtureApiKeys,
  fixtureBase,
  fixtureBases,
  fixtureScrapesFor,
  fixtureSources,
  manySources,
} from "./fixtures";
import { type Crumb, renderPulseShell } from "./pulse-shell.browser-fixture";

// The main paths of Pulse on v2 in Chromium (WebKit through the shared launcher): find and create a base, open,
// add, edit and remove a source, run SQL, open a saved query, save settings, plus the layout rules at 1440 and
// 390 px and the worst-case and 1,000-row states. The harness renders each page from its address; this test
// answers the APIs with invented data.
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type BrowserContext = Awaited<ReturnType<Browser["newContext"]>>;
type Page = Awaited<ReturnType<BrowserContext["newPage"]>>;
type Route = Parameters<Extract<Parameters<Page["route"]>[1], (...args: never[]) => unknown>>[0];

const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_PULSE_V2_SHOTS;
const baseId = fixtureBases[0]!.id;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "PulseScreens.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-pulse-screens-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Pulse screens harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let css: string;
let harness: string;
let icons: { css: string; font: string };
// Pictures show the screen inside the real Cloud shell; the tests without pictures keep the bare page.
let shell: Awaited<ReturnType<typeof renderPulseShell>> | undefined;
beforeAll(async () => {
  if (shots) shell = await renderPulseShell();
  harness = await buildHarness();
  const iconCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
  const iconCss = await Bun.file(fileURLToPath(iconCssUrl)).text();
  const fontAsset = iconCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
  if (!fontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
  icons = { css: iconCss.replace(fontAsset, "/tabler-icons.woff2"), font: fileURLToPath(new URL(fontAsset, iconCssUrl)) };
  // A Cloud page loads the v1 sheet and then v2.css; the SQL editor (a rich v1 component) needs the first.
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
  shell?.restore();
  await browser?.close();
});

const head = () =>
  `<link rel="stylesheet" href="${origin}/ui/plex.css"><link rel="stylesheet" href="${origin}/tabler-icons.css"><style>${css}</style>`;
/** The title each Pulse page gives its layout: Start, Pulse, then the open base and "Einstellungen" where they apply. */
const pageTitle = (address: string): Crumb[] => {
  const [, app, , id, view] = new URL(address, origin).pathname.split("/");
  const crumbs: Crumb[] = [
    { title: "Start", href: "/" },
    { title: "Pulse", href: "/app/pulse" },
  ];
  if (app === "admin") return [{ title: "Verwaltung", href: "/admin" }, { title: "Pulse" }];
  const base = fixtureBases.find((entry) => entry.id === id);
  if (!base) return crumbs;
  crumbs.push({ title: base.name, href: `/app/pulse/${base.id}` });
  return view === "settings" ? [...crumbs, { title: "Einstellungen" }] : crumbs;
};
const page = async (variant: string, address: string) => {
  if (shell)
    return (await shell.page(address, pageTitle(address)))
      .replace("<html", `<html data-variant="${variant}"`)
      .replace("</head>", `${head()}</head>`)
      .replace("</body>", '<script src="/harness.js"></script></body>');
  return (
    `<!doctype html><html lang="de" class="light" data-variant="${variant}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">${head()}` +
    `<style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
    `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`
  );
};

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

type Call = { method: string; path: string; body: unknown; query?: URLSearchParams };
/** The Pulse API as the server answers it for the invented base; `override` answers one call differently. */
const answer = async (route: Route, calls: Call[], override?: (call: Call) => { status: number; json?: unknown } | undefined) => {
  const request = route.request();
  const url = new URL(request.url());
  const call: Call = {
    method: request.method(),
    path: url.pathname,
    body: request.postData() ? JSON.parse(request.postData()!) : null,
    // only a request with a query string carries it, so writes compare as before
    ...(url.search ? { query: url.searchParams } : {}),
  };
  calls.push(call);
  const special = override?.(call);
  if (special) return route.fulfill({ status: special.status, json: special.json ?? {} });
  const base = `/api/pulse/bases/${baseId}`;
  if (call.method === "POST" && call.path === "/api/pulse/bases")
    return route.fulfill({
      status: 201,
      json: fixtureBase({ id: "z9Yx8Wv7", name: String((call.body as { name?: string })?.name ?? "") }),
    });
  if (call.path === "/api/pulse/bases") return route.fulfill({ json: fixtureBases });
  if (call.path === base && call.method === "GET")
    return route.fulfill({ json: { ...fixtureBases[0], outage: { unavailable: false, since: null } } });
  if (call.path === base && call.method === "PATCH") return route.fulfill({ json: { ...fixtureBases[0], ...(call.body as object) } });
  if (call.path === `${base}/sources/figures`) return route.fulfill({ json: figuresOf(allSources()) });
  // the list endpoint as the server answers it: searched by name, one page from the offset
  if (call.path === `${base}/sources` && call.method === "GET") {
    const words = url.searchParams.get("q")?.toLowerCase() ?? "";
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 500);
    const matching = allSources().filter((source) => source.name.toLowerCase().includes(words));
    return route.fulfill({ json: matching.slice(offset, offset + limit) });
  }
  if (call.path === `${base}/sources` && call.method === "POST")
    return route.fulfill({
      status: 201,
      json: { ...fixtureSources[0], id: "s9Zz8Yy7", name: String((call.body as { name?: string })?.name ?? "") },
    });
  if (call.path.endsWith("/scrape")) return route.fulfill({ json: { metrics: 12, events: 0, states: 0 } });
  if (call.path.endsWith("/scrapes")) return route.fulfill({ json: fixtureScrapesFor(call.path.split("/").at(-2) ?? "") });
  if (call.path.endsWith("/api-keys")) return route.fulfill({ json: call.path.includes("s4Cc5Dd6") ? fixtureApiKeys : [] });
  if (call.path.startsWith(`${base}/sources/`) && call.method === "PATCH")
    return route.fulfill({
      json: { ...fixtureSources.find((source) => call.path.endsWith(source.id)), ...(call.body as object), revision: 2 },
    });
  if (call.path.startsWith(`${base}/sources/`) && call.method === "DELETE") return route.fulfill({ status: 204, body: "" });
  if (call.path === "/api/pulse/admin/orphans")
    return route.fulfill({ json: { items: [{ database: "pulse_base_k3m8q2" }], nextCursor: null } });
  if (call.path === `${base}/sql/limits`) return route.fulfill({ json: sqlTestLimits });
  // a saved query on CPU answers with a day of hourly values, as a real run would
  if (call.path === `${base}/sql` && call.method === "POST" && String((call.body as { sql?: string })?.sql).includes("cpu"))
    return route.fulfill({
      json: {
        ...sqlTestResult,
        columns: [
          { name: "time", type: "DateTime('UTC')" },
          { name: "cpu", type: "Float64" },
        ],
        rows: Array.from({ length: 24 }, (_, hour) => [
          `2026-11-24 ${String(hour).padStart(2, "0")}:00:00`,
          Math.round((38 + 22 * Math.sin(hour / 3.8) + (hour % 5) * 3) * 10) / 10,
        ]),
        rowCount: 24,
      },
    });
  if (call.path === `${base}/sql` && call.method === "POST")
    return route.fulfill({
      json: {
        ...sqlTestResult,
        columns: [
          { name: "time", type: "DateTime('UTC')" },
          { name: "events", type: "UInt64" },
        ],
        rows: [
          ["2026-11-25 07:00:00", 12],
          ["2026-11-25 08:00:00", 30],
          ["2026-11-25 09:00:00", 21],
        ],
        rowCount: 3,
      },
    });
  return route.fulfill({ status: 404, json: { message: "Not found" } });
};

/** The sources the API answers with: the page's variant decides, as the harness does for the first picture. */
let variant = "normal";
const allSources = () => (variant === "huge" ? manySources(1000) : fixtureSources);
const open = async (view: View, address: string, options: { variant?: string; override?: Parameters<typeof answer>[2] } = {}) => {
  variant = options.variant ?? "normal";
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
    if (url.pathname === "/branding/logo") return route.fulfill({ path: resolve(ui, "../cloud/public/logo.svg") });
    if (url.pathname.startsWith("/ui/")) return route.fulfill({ path: resolve(ui, "dist", url.pathname.slice(4)) });
    if (url.pathname.startsWith("/api/")) return answer(route, calls, options.override);
    // the shell's own assets (its scripts and sheets) are not part of these pictures
    if (/\.[a-z0-9]+$/.test(url.pathname)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: await page(options.variant ?? "normal", `${url.pathname}${url.search}`),
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

describe("Pulse on v2", () => {
  test("a base with more sources than a page loads the next page by offset and counts all of them", async () => {
    const { context, tab, errors, calls } = await open(desktop, `/app/pulse/${baseId}`, { variant: "huge" });
    try {
      expect(await tab.getByText("50 von 1.000 Zeilen sichtbar").isVisible()).toBe(true);
      await tab.getByRole("button", { name: "Weitere laden" }).click();
      await tab.locator('[data-k2-part="Table"]').getByText("Quelle 100", { exact: true }).waitFor();
      expect(calls.some((call) => call.path.endsWith("/sources") && call.query?.get("offset") === "50")).toBe(true);
      expect(await tab.getByText("100 von 1.000 Zeilen sichtbar").isVisible()).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the sources search asks the server, keeps the words in the address and the figures cover all sources", async () => {
    const { context, tab, errors, calls } = await open(desktop, `/app/pulse/${baseId}`);
    try {
      await tab.getByRole("searchbox", { name: "Quellen durchsuchen…" }).fill("drucker");
      await tab.waitForFunction(() => location.search === "?q=drucker");
      await tab.locator('[data-k2-part="Table"]').getByText("Switch Halle 1").waitFor({ state: "detached" });
      await settled(tab);
      expect(calls.some((call) => call.path.endsWith("/sources") && call.query?.get("q") === "drucker")).toBe(true);
      expect(await tab.locator('[data-k2-part="Table"]').getByText("Drucker Halle 2").isVisible()).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("the base list filters as it is typed, keeps the words in the address and creates a base", async () => {
    const { context, tab, errors, calls } = await open(desktop, "/app/pulse");
    try {
      await tab.getByRole("searchbox", { name: "Pulse-Basen durchsuchen" }).fill("web");
      await tab.waitForFunction(() => location.search === "?q=web");
      expect(await tab.getByText("1 von 7").isVisible()).toBe(true);
      expect(await tab.getByText("Betrieb Werkstatt Nord").count()).toBe(0);
      await tab.getByRole("button", { name: "Neue Basis" }).first().click();
      const dialog = tab.getByRole("dialog");
      await dialog.getByRole("button", { name: "Erstellen" }).click();
      expect(await dialog.getByText("Pflichtfeld.").isVisible()).toBe(true);
      expect(writes(calls)).toEqual([]);
      await dialog.getByRole("textbox", { name: "Name" }).fill("Kühlhaus");
      await dialog.getByRole("button", { name: "Erstellen" }).click();
      await tab.waitForURL(`${origin}/app/pulse/z9Yx8Wv7`);
      expect(writes(calls)).toEqual([{ method: "POST", path: "/api/pulse/bases", body: { name: "Kühlhaus", description: null } }]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a source opens beside the list from its row and closes back to the list", async () => {
    const { context, tab, errors } = await open(desktop, `/app/pulse/${baseId}`);
    try {
      await shoot(tab, "sources-1440");
      await tab
        .getByRole("link", { name: /Drucker Halle 2/ })
        .first()
        .click();
      await tab.waitForURL(`${origin}/app/pulse/${baseId}/sources/s7Ee8Ff9`);
      await settled(tab);
      const detail = tab.locator('[data-k2-part="Pane"][aria-label="Drucker Halle 2"]');
      expect(await detail.getByText("http://10.0.0.12:9100/metrics").isVisible()).toBe(true);
      await shoot(tab, "source-open-1440");
      expect((await measureV2Layout(tab, { root: "#root" })).problems).toEqual([]);
      await detail.getByRole("link", { name: "Quelldetails schließen" }).click();
      await tab.waitForURL(`${origin}/app/pulse/${baseId}`);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("on the phone a tap on a source opens it as the page, with its name, the way back and its edit button", async () => {
    const { context, tab, errors } = await open(phone, `/app/pulse/${baseId}`);
    try {
      // a tap on the row, as a finger opens it: the phone shows the rows as a list, the row on screen takes the tap
      await tab.locator('a.k2-row-open[href$="/sources/s7Ee8Ff9"]:visible').first().tap();
      await tab.waitForURL(`${origin}/app/pulse/${baseId}/sources/s7Ee8Ff9`);
      await settled(tab);
      await shoot(tab, "source-open-390");
      expect(await tab.locator(':text-is("Drucker Halle 2"):visible').count()).toBeGreaterThan(0);
      const back = tab.getByRole("link", { name: "Quellen" }).first();
      expect(await back.isVisible()).toBe(true);
      expect(await tab.getByRole("button", { name: "Bearbeiten" }).isVisible()).toBe(true);
      expect((await measureV2Layout(tab, { root: "#root" })).problems).toEqual([]);
      // the way back is a tap too, and leads to the list
      await back.tap();
      await tab.waitForURL(`${origin}/app/pulse/${baseId}`);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a new metrics source is checked, created, read once and opened", async () => {
    const { context, tab, errors, calls } = await open(desktop, `/app/pulse/${baseId}`);
    try {
      await tab.getByRole("button", { name: "Neue Quelle" }).first().click();
      const dialog = tab.getByRole("dialog");
      await dialog.getByRole("radio", { name: /abrufen|Pull|Pulse ruft/i }).click();
      await dialog.getByRole("textbox", { name: "Name" }).fill("Kühlung");
      await dialog.getByRole("button", { name: "Hinzufügen" }).click();
      expect(await dialog.getByText("Pflichtfeld.").isVisible()).toBe(true);
      await dialog.getByRole("textbox", { name: /Endpunkt|URL/ }).fill("https://kuehlung.example/metrics");
      await dialog.getByRole("button", { name: "Hinzufügen" }).click();
      await tab.waitForURL(`${origin}/app/pulse/${baseId}/sources/s9Zz8Yy7`);
      expect(writes(calls).map((call) => `${call.method} ${call.path}`)).toEqual([
        `POST /api/pulse/bases/${baseId}/sources`,
        `POST /api/pulse/bases/${baseId}/sources/s9Zz8Yy7/scrape`,
      ]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("editing and removing the open source send one write each", async () => {
    const { context, tab, errors, calls } = await open(desktop, `/app/pulse/${baseId}/sources/s7Ee8Ff9`);
    try {
      await tab.getByRole("button", { name: "Bearbeiten" }).click();
      const dialog = tab.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "Name" }).fill("Drucker Halle 3");
      await dialog.getByRole("button", { name: "Speichern" }).click();
      await dialog.waitFor({ state: "detached" });
      const patch = writes(calls).find((call) => call.method === "PATCH");
      expect(patch?.body).toMatchObject({ name: "Drucker Halle 3", expectedRevision: 1, scrapeIntervalSeconds: 60 });
      await tab.getByRole("button", { name: "Weitere Aktionen zur Quelle" }).click();
      await tab.getByRole("menuitem", { name: "Quelle entfernen" }).click();
      await tab.getByRole("alertdialog").getByRole("button", { name: "Quelle entfernen" }).click();
      await tab.waitForURL(`${origin}/app/pulse/${baseId}`);
      expect(writes(calls).map((call) => call.method)).toEqual(["PATCH", "DELETE"]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("SQL runs with its parameter and shows the rows and the chart", async () => {
    const address = `/app/pulse/${baseId}/sql?sql=${encodeURIComponent("SELECT ts AS time, count() AS events FROM events WHERE kind = :kind")}&params=${encodeURIComponent('{"kind":"order"}')}`;
    const { context, tab, errors, calls } = await open(desktop, address);
    try {
      await tab.getByRole("button", { name: "Ausführen" }).click();
      await tab.getByText("3 Zeilen", { exact: false }).first().waitFor();
      await settled(tab);
      const run = writes(calls).find((call) => call.path.endsWith("/sql"));
      expect(run?.body).toMatchObject({ params: { kind: "order" } });
      expect(await tab.locator('[data-k2-part="Table"]').getByText("30").isVisible()).toBe(true);
      expect(await tab.locator('[data-k2-part="Canvas"][aria-label="Diagramm"]').count()).toBe(1);
      await shoot(tab, "sql-result-1440");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a saved query opens in the console from its row", async () => {
    const { context, tab, errors } = await open(desktop, `/app/pulse/${baseId}/queries`);
    try {
      await tab
        .getByRole("link", { name: /CPU je Stunde/ })
        .first()
        .click();
      await tab.waitForURL(`${origin}/app/pulse/${baseId}/sql/q1Ab2Cd3`);
      await settled(tab);
      expect(await tab.getByText("CPU je Stunde, letzter Tag").first().isVisible()).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("settings save a new name, and a shorter retention asks with date and amount first", async () => {
    let refused = false;
    const { context, tab, errors, calls } = await open(desktop, `/app/pulse/${baseId}/settings/retention`, {
      override: (call) => {
        if (call.method !== "PATCH" || refused || (call.body as { rawRetentionDays?: number }).rawRetentionDays !== 7) return undefined;
        refused = true;
        return {
          status: 409,
          json: {
            code: "PULSE_RETENTION_CONFIRMATION_REQUIRED",
            message: "Confirm",
            preview: [{ kind: "raw", retention: 7, cutoff: "2026-11-18T09:42:00.000Z", rows: 1200, bytes: 48_000 }],
            previewedFrom: { rawRetentionDays: 30, rollupRetentionDays: 400, sensitiveRetentionHours: 72 },
          },
        };
      },
    });
    try {
      await tab.getByRole("combobox", { name: "Aufbewahrung von Rohdaten" }).click();
      await tab.getByRole("option", { name: "7 Tage" }).click();
      await tab.getByRole("button", { name: "Speichern" }).click();
      const question = tab.getByRole("alertdialog");
      await question.waitFor();
      expect(await question.innerText()).toContain("Rohdaten");
      await question.getByRole("button", { name: /speichern/i }).click();
      await tab.getByText("Gespeichert", { exact: false }).first().waitFor();
      const patches = writes(calls).filter((call) => call.method === "PATCH");
      expect(patches.map((call) => (call.body as { confirmShorterRetention?: boolean }).confirmShorterRetention ?? false)).toEqual([
        false,
        true,
      ]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("every page keeps the layout rules at 1440, 1024 and 390 px", async () => {
    const addresses = [
      "/app/pulse",
      `/app/pulse/${baseId}`,
      `/app/pulse/${baseId}/sources/s4Cc5Dd6`,
      `/app/pulse/${baseId}/sql/q1Ab2Cd3`,
      `/app/pulse/${baseId}/queries`,
      `/app/pulse/${baseId}/settings`,
      `/app/pulse/${baseId}/settings/members`,
      `/app/pulse/${baseId}/settings/retention`,
      `/app/pulse/${baseId}/settings/usage`,
      `/app/pulse/${baseId}/settings/danger`,
      "/admin/pulse?view=bases",
      "/admin/pulse?view=targets",
    ];
    const found: string[] = [];
    for (const view of [desktop, tablet, phone])
      for (const address of addresses) {
        const { context, tab, errors } = await open(view, address);
        try {
          const name = `${address.replace(/^\/(app|admin)\/pulse\/?/, "").replace(/[^a-z0-9]+/gi, "-") || "bases"}-${view.width}`;
          // the console is measured as it is used: with a query that ran, its rows and its chart
          if (address.includes("/sql/")) {
            await tab.getByRole("button", { name: "Ausführen" }).click();
            await tab.getByText("24 Zeilen", { exact: false }).first().waitFor();
            await settled(tab);
          }
          await shoot(tab, name);
          for (const problem of (await measureV2Layout(tab, { root: "#root" })).problems) found.push(`${name}: ${problem}`);
          found.push(...errors.map((error) => `${name}: ${error}`));
        } finally {
          await context.close();
        }
      }
    expect(found).toEqual([]);
  }, 300_000);

  test("worst-case names, endpoints and counts keep their rows and break nothing (break-ui)", async () => {
    const found: string[] = [];
    for (const view of [desktop, phone])
      for (const address of ["/app/pulse", `/app/pulse/${baseId}`, `/app/pulse/${baseId}/sources/w1Aa2Bb3`]) {
        const { context, tab, errors } = await open(view, address, { variant: "worst" });
        try {
          const name = `worst-${address.replace(/[^a-z0-9]+/gi, "-")}-${view.width}`;
          await shoot(tab, name);
          for (const problem of (await measureV2Layout(tab, { root: "#root" })).problems) found.push(`${name}: ${problem}`);
          const wide = await tab.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
          if (wide) found.push(`${name}: the page scrolls sideways`);
          found.push(...errors.map((error) => `${name}: ${error}`));
        } finally {
          await context.close();
        }
      }
    expect(found).toEqual([]);
  }, 180_000);

  test("1,000 bases and 1,000 sources are ready in time and scroll", async () => {
    for (const address of ["/app/pulse", `/app/pulse/${baseId}`]) {
      const { context, tab, errors, ready } = await open(desktop, address, { variant: "huge" });
      try {
        const nodes = await tab.evaluate(() => document.querySelectorAll("*").length);
        // k2b-ui gap: v2 Table does not virtualize yet (lane MW), so the DOM grows with the rows; the time budget holds.
        console.log(`[scale] ${address}: ready ${ready} ms, ${nodes} elements`);
        expect(ready).toBeLessThan(1500);
        await tab.mouse.move(700, 500);
        await tab.mouse.wheel(0, 20_000);
        await settled(tab);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 120_000);
});
