import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";
import "../../../../ui/test/solid-ssr-preload";
import { REQUESTS } from "./overview-requests.fixture-data";

// The Accounts overview and the request list on v2: both keep the v2 rules at every width, the overview links to the
// places that replaced the old pages, and a request is denied in a v2 dialog. The test stands in for the server.
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
// a relative folder is read from the package, so a run on another machine can bring the pictures back
const shots = process.env.CLOUD_ACCOUNTS_V2_SHOTS ? resolve(import.meta.dir, "../../..", process.env.CLOUD_ACCOUNTS_V2_SHOTS) : undefined;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "OverviewRequests.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-overview-requests-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Overview and requests harness build failed");
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

type View = { width: number; height: number; touch: boolean; name: string };
const wide: View = { width: 1440, height: 900, touch: false, name: "1440" };
const narrow: View = { width: 1024, height: 768, touch: false, name: "1024" };
const phone: View = { width: 390, height: 844, touch: true, name: "390" };

type State = { admin?: boolean; worst?: boolean; huge?: boolean; full?: boolean; empty?: boolean; freeIpa?: boolean };
const page = (state: State) =>
  `<!doctype html><html lang="de" class="light" data-state='${JSON.stringify(state)}'><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

type Seen = { pages: string[]; denied: { id: string; body: unknown }[] };

const open = async (view: View, address: string, state: State = {}, deny: { status: number; message?: string } = { status: 200 }) => {
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
  const seen: Seen = { pages: [], denied: [] };
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/app/accounts" || url.pathname === "/app/accounts/requests") {
      seen.pages.push(`${url.pathname}${url.search}`);
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: page(state) });
    }
    const denied = url.pathname.match(/^\/api\/accounts\/account-requests\/([^/]+)\/deny$/);
    if (denied && route.request().method() === "POST") {
      seen.denied.push({ id: denied[1]!, body: route.request().postDataJSON() });
      return route.fulfill({ status: deny.status, json: { message: deny.message ?? "Request denied" } });
    }
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${address}`);
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, seen };
};

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `a-${name}.png`) });
};

const expectClean = async (tab: Page) => {
  await tab.mouse.move(0, 0);
  const outline = await describeV2Page(tab, "#root");
  expect(outline.includes("Problems (") ? outline : "").toBe("");
  const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
  expect(layout.problems).toEqual([]);
};

describe("the Accounts overview on v2", () => {
  test("keeps the v2 rules at 1440, 1024 and 390 px, for administrators and everyone else", async () => {
    for (const [name, state] of [
      ["overview-admin", { admin: true }],
      ["overview-person", {}],
      ["overview-worst", { admin: true, worst: true }],
    ] as const) {
      for (const view of [wide, narrow, phone]) {
        const { context, tab, errors } = await open(view, "/app/accounts", state);
        try {
          await expectClean(tab);
          await shoot(tab, `${name}-light-${view.name}`);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  }, 120_000);

  test("the logs menu leads to the system logs and to the activity kinds that replaced the old pages", async () => {
    const { context, tab, errors } = await open(wide, "/app/accounts", { admin: true });
    try {
      await tab.getByRole("button", { name: "Protokolle" }).click();
      const deleted = tab.getByRole("menuitem", { name: "Gelöschte Konten" });
      expect(await deleted.getAttribute("href")).toBe("/app/accounts/activity?kind=deleted");
      expect(await tab.getByRole("menuitem", { name: "Erinnerungsverlauf" }).getAttribute("href")).toBe(
        "/app/accounts/activity?kind=reminders",
      );
      await shoot(tab, "overview-logs-menu-light-1440");
      await tab.keyboard.press("Escape");
      // a person without administration sees neither the menu nor the administration's figures
      const person = await open(wide, "/app/accounts", {});
      try {
        expect(await person.tab.getByRole("button", { name: "Protokolle" }).count()).toBe(0);
        expect(await person.tab.getByText("Administration").count()).toBe(0);
        expect(person.errors).toEqual([]);
      } finally {
        await person.context.close();
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});

describe("the request list on v2", () => {
  test("keeps the v2 rules at 1440, 1024 and 390 px, also in the worst case and empty", async () => {
    for (const [name, state, address] of [
      ["requests", {}, "/app/accounts/requests"],
      ["requests-all", {}, "/app/accounts/requests?status=all"],
      ["requests-worst", { worst: true }, "/app/accounts/requests"],
      ["requests-empty", { empty: true }, "/app/accounts/requests"],
    ] as const) {
      for (const view of [wide, narrow, phone]) {
        const { context, tab, errors } = await open(view, address, state);
        try {
          await expectClean(tab);
          await shoot(tab, `${name}-light-${view.name}`);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  }, 180_000);

  /** Opens the list with `count` rows and returns how long the page took from navigation to its last row, and its nodes. */
  const measure = async (state: State, count: number, clean = true) => {
    const { context, tab, errors } = await open(wide, "/app/accounts/requests", state);
    try {
      await tab
        .locator("[data-k2-part=Table] tbody tr")
        .nth(count - 1)
        .waitFor({ state: "attached" });
      // from the start of the navigation to the last row, the browser's own start left out
      const ready = await tab.evaluate(() => performance.now());
      const nodes = await tab.evaluate(() => document.querySelectorAll("*").length);
      await tab.mouse.wheel(0, 20_000);
      if (clean) await expectClean(tab);
      expect(errors).toEqual([]);
      return { ready, nodes };
    } finally {
      await context.close();
    }
  };

  test("the largest page the server sends (100 requests) is ready within 1.5 s", async () => {
    const { ready, nodes } = await measure({ full: true }, 100);
    console.info(`requests full page: ${nodes} DOM nodes, ready ${Math.round(ready)} ms`);
    expect(ready).toBeLessThan(1500);
  }, 60_000);

  // k2b-ui gap: virtualized list (lane MW). Until v2 virtualizes `Table`, 1,000 rows are 1,000 DOM rows, so this
  // records the time and node count (the outline and measurement of 1,000 rows outlast a test); the bound (< 1.5 s, bounded nodes) follows with MW.
  test("1,000 requests render without errors (scale record until the list is virtualized)", async () => {
    const { ready, nodes } = await measure({ huge: true }, 1000, false);
    console.info(`requests huge: ${nodes} DOM nodes, ready ${Math.round(ready)} ms`);
  }, 120_000);

  test("on the phone a pending request opens its page, where it is created or denied", async () => {
    const { context, tab, errors } = await open(phone, "/app/accounts/requests");
    try {
      const row = tab.locator("[data-k2-part=Row]").filter({ hasText: REQUESTS[0]!.name }).first();
      expect(await row.locator("a").first().getAttribute("href")).toBe(`/app/accounts/users/new?request=${REQUESTS[0]!.id}`);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("“Ablehnen” asks in a v2 dialog with an optional reason, denies once, and shows the list again", async () => {
    const { context, tab, errors, seen } = await open(wide, "/app/accounts/requests");
    try {
      await tab.getByRole("button", { name: "Ablehnen" }).first().click();
      const dialog = tab.locator("[data-k2-part=Dialog]");
      await dialog.waitFor();
      expect(await dialog.getByRole("heading").first().textContent()).toBe("Kontoanfrage ablehnen");
      expect(await dialog.textContent()).toContain(REQUESTS[0]!.email);
      await dialog.getByRole("textbox").fill("Bitte über die Personalabteilung anfragen.");
      await shoot(tab, "requests-deny-light-1440");
      const before = seen.pages.length;
      await dialog.getByRole("button", { name: "Anfrage ablehnen" }).click();
      await tab.waitForFunction(() => !document.querySelector("[data-k2-part=Dialog]"));
      expect(seen.denied).toEqual([{ id: REQUESTS[0]!.id, body: { reason: "Bitte über die Personalabteilung anfragen." } }]);
      await tab.waitForFunction(() => document.querySelector("[data-k2-workspace]") !== null);
      expect(seen.pages.length).toBeGreaterThan(before);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a refused denial keeps the dialog open with the service's sentence; cancel denies nothing", async () => {
    const { context, tab, errors, seen } = await open(
      wide,
      "/app/accounts/requests",
      {},
      { status: 400, message: "Die Anfrage ist nicht mehr offen." },
    );
    try {
      await tab.getByRole("button", { name: "Ablehnen" }).nth(1).click();
      const dialog = tab.locator("[data-k2-part=Dialog]");
      await dialog.waitFor();
      await dialog.getByRole("button", { name: "Anfrage ablehnen" }).click();
      await dialog.getByText("Die Anfrage ist nicht mehr offen.").waitFor();
      expect(seen.denied).toEqual([{ id: REQUESTS[1]!.id, body: {} }]);
      await dialog.getByRole("button", { name: "Abbrechen" }).click();
      await tab.waitForFunction(() => !document.querySelector("[data-k2-part=Dialog]"));
      expect(seen.denied).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
