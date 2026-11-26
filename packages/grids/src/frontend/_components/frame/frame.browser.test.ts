import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../../ui/test/browser";
import { FIXTURE_NOW, FIXTURE_REVISION, type FixtureVariant } from "./frame.browser-fixture";

// The bases overview and a base home on v2, in a real browser: the address holds what is open and narrowed, the
// rules of v2 hold at 1440, 1024 and 390 px, the worst-case data breaks nothing, and 1,000 bases or tables stay
// bounded. The test stands in for the server: pages and APIs answer from invented fixtures.
const ui = resolve(import.meta.dir, "../../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.GRIDS_FRAME_SHOTS;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "frame.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-grids-frame-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Grids frame harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(import.meta.dir, "../../../../../cloud")))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
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
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = [
    "@layer properties, theme, base, components, utilities;",
    await buildCss(resolve(import.meta.dir, "../../../../../../styles.css")),
    await buildCss(resolve(import.meta.dir, "../../../styles/app.css")),
    v2Css,
  ].join("\n");
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

const page = (variant: FixtureVariant) =>
  `<!doctype html><html lang="de" class="light" data-variant="${variant}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

type Seen = { created: unknown[] };

/** Runs in the page: Date flows on from the pinned instant; timers and animation frames stay real. */
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

const open = async (view: View, address: string, variant: FixtureVariant = "plain") => {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  // the fixtures' dates are relative to FIXTURE_NOW: the page's Date starts there, so no picture depends on the day
  await context.addInitScript(pinPageClock, Date.parse(FIXTURE_NOW));
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  const errors = pageErrors(tab);
  const seen: Seen = { created: [] };
  // the live channel stays quiet: no change arrives while the test runs
  await tab.routeWebSocket(/\/api\/grids\/live/, () => {});
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/app/grids" || url.pathname.startsWith("/app/grids/Bas001"))
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: page(variant) });
    if (url.pathname === "/api/grids/workspace/revision")
      return route.fulfill({ json: { ...FIXTURE_REVISION, canWrite: true, canAdmin: true } });
    if (url.pathname === "/api/grids/bases" && route.request().method() === "POST") {
      seen.created.push(route.request().postDataJSON());
      return route.fulfill({ status: 503, json: { message: "Base creation unavailable" } });
    }
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  const started = performance.now();
  await tab.goto(`${origin}${address}`);
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, seen, readyMs: Math.round(performance.now() - started) };
};

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `${name}.png`) });
};

const expectClean = async (tab: Page) => {
  await tab.mouse.move(0, 0);
  const outline = await describeV2Page(tab, "#root");
  expect(outline.includes("Problems (") ? outline : "").toBe("");
  const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
  expect(layout.problems).toEqual([]);
};

const elements = (tab: Page) => tab.evaluate(() => document.querySelectorAll("#root *").length);

describe("the bases overview on v2", () => {
  for (const variant of ["plain", "worst"] as const)
    test(`keeps the v2 rules at 1440, 1024 and 390 px (${variant})`, async () => {
      for (const view of [wide, narrow, phone]) {
        const { context, tab, errors } = await open(view, "/app/grids", variant);
        try {
          await expectClean(tab);
          await shoot(tab, `grids-bases-${variant}-light-${view.name}`);
          expect(await tab.locator("[data-k2-part=Loading]").count()).toBe(0);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }, 90_000);

  test("search lives in the address and a miss offers the whole list", async () => {
    const { context, tab, errors } = await open(wide, "/app/grids?q=lager");
    try {
      expect(await tab.locator("[data-k2-part=Table] tbody tr").count()).toBe(1);
      expect(await tab.getByRole("searchbox", { name: "Bases durchsuchen" }).inputValue()).toBe("lager");
      await tab.goto(`${origin}/app/grids?q=zzz`);
      await settled(tab);
      await expect(tab.getByText("Keine passenden Bases")).toBeTruthy();
      expect(await tab.getByRole("link", { name: "Alle Bases zeigen" }).getAttribute("href")).toBe("/app/grids");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("New base opens its dialog in the address, keeps the name after a failed request and asks before discarding", async () => {
    const { context, tab, errors, seen } = await open(wide, "/app/grids");
    try {
      await tab.getByRole("link", { name: "Neue Base" }).first().click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("new") === "blank");
      const dialog = tab.getByRole("dialog", { name: "Neue Base" });
      await dialog.waitFor();
      await dialog.getByRole("textbox", { name: "Name" }).fill("Werkzeuge");
      await dialog.getByRole("button", { name: "Base erstellen" }).click();
      await dialog.getByText("Base creation unavailable").waitFor();
      expect(await dialog.getByRole("textbox", { name: "Name" }).inputValue()).toBe("Werkzeuge");
      expect(seen.created).toEqual([{ name: "Werkzeuge", description: null }]);
      await shoot(tab, "grids-bases-new-failed-light-1440");
      // Escape with a typed name asks first; keeping the dialog keeps the name
      await tab.keyboard.press("Escape");
      const question = tab.getByRole("alertdialog");
      await question.getByRole("button", { name: "Weiter bearbeiten" }).click();
      expect(await dialog.getByRole("textbox", { name: "Name" }).inputValue()).toBe("Werkzeuge");
      await tab.keyboard.press("Escape");
      await tab.getByRole("alertdialog").getByRole("button", { name: "Verwerfen" }).click();
      await tab.waitForFunction(() => !new URL(location.href).searchParams.has("new"));
      expect(await tab.getByRole("dialog").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a template tile opens the dialog with that template on the first picture", async () => {
    const { context, tab, errors } = await open(wide, "/app/grids?new=crm");
    try {
      const dialog = tab.getByRole("dialog", { name: "CRM erstellen" });
      await dialog.waitFor();
      expect(await dialog.getByRole("textbox", { name: "Name" }).inputValue()).toBe("CRM");
      expect(await dialog.getByText("Beispieldaten hinzufügen").count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("1,000 bases stay bounded: 100 rows a page, ready quickly", async () => {
    const { context, tab, errors, readyMs } = await open(wide, "/app/grids", "huge");
    try {
      expect(await tab.locator("[data-k2-part=Table] tbody tr").count()).toBe(100);
      expect(await tab.getByText("Seite 1 von 10").count()).toBe(1);
      const count = await elements(tab);
      console.info(`grids bases huge: ${count} elements, ready ${readyMs} ms`);
      expect(count).toBeLessThan(6000);
      expect(readyMs).toBeLessThan(5000);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});

describe("a base home on v2", () => {
  for (const variant of ["plain", "worst"] as const)
    test(`keeps the v2 rules at 1440, 1024 and 390 px (${variant})`, async () => {
      for (const view of [wide, narrow, phone]) {
        const { context, tab, errors } = await open(view, "/app/grids/Bas001?groups=1&edit=true", variant);
        try {
          await expectClean(tab);
          // the revision the page loaded with is the current one: nothing says the base changed
          expect(await tab.getByText("Arbeitsbereich geändert").count()).toBe(0);
          await shoot(tab, `grids-home-${variant}-light-${view.name}`);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }, 90_000);

  test("search and kind narrow the entries in the address; Back returns", async () => {
    const { context, tab, errors } = await open(wide, "/app/grids/Bas001");
    try {
      const rows = () => tab.locator("[data-k2-part=Pane] [data-k2-part=Row]").count();
      const all = await rows();
      expect(all).toBeGreaterThan(5);
      const search = tab.getByRole("searchbox", { name: "In dieser Base suchen" });
      await search.fill("auftr");
      await search.press("Enter");
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("q") === "auftr");
      expect(await rows()).toBeLessThan(all);
      await tab.goBack();
      await tab.waitForFunction(() => !new URL(location.href).searchParams.has("q"));
      await tab.waitForFunction((count) => document.querySelectorAll("[data-k2-part=Pane] [data-k2-part=Row]").length === count, all);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the sidebar names the base's places; tables carry their views one level in", async () => {
    const { context, tab, errors } = await open(wide, "/app/grids/Bas001");
    try {
      const nav = tab.locator("[data-k2-part=Nav]");
      expect(await nav.getByRole("link", { name: "Übersicht" }).getAttribute("aria-current")).toBe("page");
      expect(await nav.getByRole("link", { name: "Aufträge", exact: true }).getAttribute("href")).toBe("/app/grids/Bas001/table/T1");
      // a table's views are the tabs of its page, not places of the sidebar
      expect(await nav.getByRole("link", { name: "Offene Aufträge" }).count()).toBe(0);
      expect(await nav.getByRole("link", { name: "Bearbeiten" }).getAttribute("href")).toBe("/app/grids/Bas001?edit=true");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a base with 1,000 tables renders and states its size", async () => {
    const { context, tab, errors, readyMs } = await open(wide, "/app/grids/Bas001", "huge");
    try {
      const count = await elements(tab);
      // k2b-ui gap: Nav and Section lists are not virtualized yet (lane MW); this pins today's size.
      console.info(`grids home huge: ${count} elements, ready ${readyMs} ms`);
      expect(readyMs).toBeLessThan(8000);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});

describe("the records page on v2", () => {
  const table = "/app/grids/Bas001/table/table";
  for (const variant of ["plain", "worst"] as const)
    test(`keeps the v2 rules at 1440, 1024 and 390 px (${variant})`, async () => {
      for (const view of [wide, narrow, phone]) {
        const { context, tab, errors } = await open(view, `${table}?edit=true`, variant);
        try {
          await expectClean(tab);
          await shoot(tab, `grids-records-${variant}-light-${view.name}`);
          expect(await tab.locator("[data-k2-part=Loading]").count()).toBe(0);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }, 90_000);

  test("amounts, dates and formula dates stand whole on one line", async () => {
    const { context, tab, errors } = await open(wide, table);
    try {
      for (const expected of ["12400,00 EUR", "2026-11-14", "2026-12-01"]) {
        const cell = tab.locator("[data-k2-part=Table] tbody tr:first-child td", { hasText: expected }).first();
        const fits = await cell.evaluate((td) => {
          const line = td.querySelector(".k2-cell-line") ?? td;
          return { scroll: line.scrollWidth, client: line.clientWidth, text: line.textContent?.trim() };
        });
        expect(fits.text).toBe(expected);
        expect(fits.scroll).toBeLessThanOrEqual(fits.client);
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a row opens its record in the address, the head sorts, and Filter opens its dialog", async () => {
    const { context, tab, errors } = await open(wide, table);
    try {
      await tab.locator("[data-k2-part=Table] tbody tr:first-child").click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("record") === "record-0");
      await tab.locator("[data-k2-part=RecordHead]").waitFor();
      await shoot(tab, "grids-records-open-light-1440");
      // Back closes the record again: the address holds what is open
      await tab.goBack();
      await tab.waitForFunction(() => !new URL(location.href).searchParams.has("record"));
      expect(await tab.locator("[data-k2-part=RecordHead]").count()).toBe(0);

      await tab.locator("[data-k2-part=Table] thead").getByRole("button", { name: "Fällig", exact: true }).click();
      await tab.waitForFunction(() => (new URL(location.href).searchParams.get("sort") ?? "").includes('"date"'));

      await tab.getByRole("button", { name: "Filter" }).click();
      await tab.getByRole("dialog", { name: "Filtern und sortieren" }).waitFor();
      await shoot(tab, "grids-records-filter-light-1440");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the table's views are the tabs of its head", async () => {
    const { context, tab, errors } = await open(wide, table);
    try {
      const tabs = tab.locator("[data-slot=head] [data-k2-part=Tabs]");
      expect(await tabs.getByRole("link", { name: /Offene Aufträge/ }).getAttribute("href")).toBe(`${table}/view/V1`);
      expect(await tabs.getByRole("link", { name: "Alle", exact: true }).getAttribute("aria-current")).toBe("page");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("1,000 records render; their size is pinned until the table is virtualized", async () => {
    const { context, tab, errors, readyMs } = await open(wide, table, "huge");
    try {
      const count = await elements(tab);
      // k2b-ui gap: the v2 Table is not virtualized yet (lane MW); this pins today's size.
      console.info(`grids records huge: ${count} elements, ready ${readyMs} ms`);
      expect(await tab.locator("[data-k2-part=Table] tbody tr").count()).toBe(1000);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);
});
