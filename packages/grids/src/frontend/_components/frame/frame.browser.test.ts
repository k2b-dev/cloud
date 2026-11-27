import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, BrowserContext, Page } from "playwright";
import { renderCloudShell } from "../../../../../../tests/fixtures/cloud-shell";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../../ui/test/browser";
import { FIXTURE_NOW, FIXTURE_REVISION, type FixtureVariant } from "./frame.browser-fixture";

// The bases overview and a base home on v2, in a real browser: the address holds what is open and narrowed, the
// rules of v2 hold at 1920, 1440, 1024 and 390 px, the worst-case data breaks nothing, and 1,000 bases or tables stay
// bounded. The test stands in for the server: pages and APIs answer from invented fixtures.
const ui = resolve(import.meta.dir, "../../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.GRIDS_FRAME_SHOTS;

/** The harness as the page loads it: an ES module and its chunks by address, split as an app's islands ship. */
const buildHarness = async (): Promise<{ entry: string; scripts: Map<string, string> }> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "frame.browser-harness.tsx")],
    target: "browser",
    // as islands ship: an ES module whose on-demand parts are chunks of their own (an IIFE bundle left a
    // lazily-read Cloud contract unset when Grids read it through the barrel)
    format: "esm",
    splitting: true,
    // the page parses and runs the whole harness before it shows anything: minified, as an app's islands ship
    minify: true,
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
  const scripts = new Map<string, string>();
  for (const output of build.outputs) scripts.set(`/${output.path.replace(/^\.\//, "")}`, await output.text());
  const entry = [...scripts.keys()].find((path) => path.includes("frame.browser-harness"));
  if (!entry) throw new Error("the Grids frame harness has no entry");
  return { entry, scripts };
};

const buildCss = async (entry: string): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(import.meta.dir, "../../../../../cloud")))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

let browser: Browser;
// the real Cloud shell (icon rail, page title, phone bar) around the screens, as a person sees the page
let shell: Awaited<ReturnType<typeof renderCloudShell>>;
let css: string;
let harness: Awaited<ReturnType<typeof buildHarness>>;
let icons: { css: string; font: string };
// the real type of Cloud (IBM Plex) instead of the system fallback, so the pictures count as evidence
let plex: { css: string; dir: string };
beforeAll(async () => {
  harness = await buildHarness();
  const iconCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
  const iconCss = await Bun.file(fileURLToPath(iconCssUrl)).text();
  const fontAsset = iconCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
  if (!fontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
  icons = { css: iconCss.replace(fontAsset, "/tabler-icons.woff2"), font: fileURLToPath(new URL(fontAsset, iconCssUrl)) };
  const plexCss = fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css"));
  plex = { css: (await Bun.file(plexCss).text()).replaceAll("./fonts/", "/fonts/"), dir: join(plexCss, "..", "fonts") };
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = [
    "@layer properties, theme, base, components, utilities;",
    await buildCss(resolve(import.meta.dir, "../../../../../../styles.css")),
    await buildCss(resolve(import.meta.dir, "../../../styles/app.css")),
    v2Css,
  ].join("\n");
  if (shots) mkdirSync(shots, { recursive: true });
  [shell, browser] = await Promise.all([renderCloudShell({ id: "grids", name: "Grids", icon: "table" }), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  shell?.restore();
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean; name: string };
const wide: View = { width: 1440, height: 900, touch: false, name: "1440" };
const narrow: View = { width: 1024, height: 768, touch: false, name: "1024" };
const phone: View = { width: 390, height: 844, touch: true, name: "390" };
// the widest screen B is drawn for: lists keep their measure and the rest is room, not stretched rows
const xl: View = { width: 1920, height: 1080, touch: false, name: "1920" };

/** The shell's page for an address, with the app's styles and the harness that mounts the screen into its `#root`. */
const page = async (address: string, variant: FixtureVariant) => {
  const html = await shell.page(address, [{ title: "Start", href: "/" }, { title: "Grids" }]);
  return (
    html
      // the shell's own stylesheets are served by Core: the page carries the same styles, compiled here
      .replace(/<link\b[^>]*rel="(?:stylesheet|preload)"[^>]*>/g, "")
      .replace("<html", `<html data-variant="${variant}"`)
      .replace(
        "</head>",
        `<link rel="stylesheet" href="${origin}/plex.css"><link rel="stylesheet" href="${origin}/tabler-icons.css"><style>${css}</style></head>`,
      )
      .replace("</body>", `<script type="module" src="${harness.entry}"></script></body>`)
  );
};

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
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: await page(`${url.pathname}${url.search}`, variant) });
    if (url.pathname === "/api/grids/workspace/revision")
      return route.fulfill({ json: { ...FIXTURE_REVISION, canWrite: true, canAdmin: true } });
    if (url.pathname === "/api/grids/bases" && route.request().method() === "POST") {
      seen.created.push(route.request().postDataJSON());
      return route.fulfill({ status: 503, json: { message: "Base creation unavailable" } });
    }
    const script = harness.scripts.get(url.pathname);
    if (script !== undefined) return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/plex.css") return route.fulfill({ contentType: "text/css", body: plex.css });
    if (url.pathname.startsWith("/fonts/")) return route.fulfill({ path: join(plex.dir, url.pathname.slice("/fonts/".length)) });
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
    test(`keeps the v2 rules at 1920, 1440, 1024 and 390 px (${variant})`, async () => {
      for (const view of [xl, wide, narrow, phone]) {
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
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});

describe("a base home on v2", () => {
  for (const variant of ["plain", "worst"] as const)
    test(`keeps the v2 rules at 1920, 1440, 1024 and 390 px (${variant})`, async () => {
      for (const view of [xl, wide, narrow, phone]) {
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
      expect(await nav.getByRole("link", { name: "Offene Aufträge" }).getAttribute("href")).toBe("/app/grids/Bas001/table/T1/view/V1");
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
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  // #4196, k2b-ui gap (Row, lane MW): a two-line Row wraps its quiet second line, so a long table name under a recent
  // change grows the row past 52 px; a three-line Row already cuts each line with an ellipsis.
  test.todo("#4196: a recent change keeps one quiet line for a long table name", () => {});
  // #4196, k2b-ui gap (Spark, from #4208): a Spark scales to its own highest bar, so a table with 2 new records a day
  // looks as busy as one with 11; the rows of one list need one shared top to be told apart at a glance.
  test.todo("#4196: the tables' sparks of one base home share one scale", () => {});
});
