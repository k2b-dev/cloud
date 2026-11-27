import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";

// An operator opens Betrieb and sees what matters in the window: one statement, the key figures, the signals with a
// way to each, the error charts and the failing routes. The screen renders invented operations as the page does.
// `CLOUD_OVERVIEW_V2_SHOTS=<dir>` also saves a light screenshot per data set and width.
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_OVERVIEW_V2_SHOTS;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "OverviewScreen.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-overview-screen-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Overview screen harness build failed");
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

const document = (state: string) =>
  `<!doctype html><html lang="de" class="light" data-state="${state}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

type View = { width: number; height: number; touch: boolean };
const desktop: View = { width: 1440, height: 900, touch: false };
const tablet: View = { width: 1024, height: 800, touch: false };
const phone: View = { width: 390, height: 844, touch: true };

const open = async (view: View, address: string, state = "normal") => {
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
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/admin/observability") return route.fulfill({ contentType: "text/html; charset=utf-8", body: document(state) });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    return route.fulfill({ status: 404, contentType: "text/html", body: "<!doctype html><title>elsewhere</title>" });
  });
  await tab.goto(`${origin}${address}`);
  await tab.waitForSelector('body[data-ready="true"]');
  await tab.evaluate(() => window.document.fonts.ready);
  await settled(tab);
  return { context, tab, errors };
};

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `${name}.png`) });
};

describe("the operations overview on v2", () => {
  test("a new window is a new address; each signal leads to the page that looks at it", async () => {
    const { context, tab, errors } = await open(desktop, "/admin/observability");
    try {
      expect(await tab.getByText("Eingriff erforderlich").first().isVisible()).toBe(true);
      const failed = tab.getByRole("link", { name: /fehlgeschlagene Ausführung/ });
      expect(await failed.getAttribute("href")).toBe("/admin/observability/runs?kind=job&status=failed&time=last-24h");
      await tab.locator('[data-k2-part="Statement"] button.k2-stmt-b').first().click();
      await tab.getByRole("option", { name: "Letzte 7 Tage" }).click();
      await tab.waitForURL(/range=7d/);
      await tab.waitForSelector('body[data-ready="true"]');
      expect(await tab.getByRole("group", { name: "Filter" }).innerText()).toContain("Letzte 7 Tage");
      expect(await tab.getByRole("link", { name: /fehlgeschlagene Ausführung/ }).getAttribute("href")).toBe(
        "/admin/observability/runs?kind=job&status=failed&time=last-7d",
      );
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the three services stand with their state, each leading to its area of the infrastructure record", async () => {
    const { context, tab, errors } = await open(desktop, "/admin/observability", "worst");
    try {
      const services = tab.getByRole("list", { name: "Infrastruktur" });
      expect(await services.innerText()).toMatch(
        /Postgres\s+Prüfung erforderlich[\s\S]*Valkey\s+Eingriff erforderlich[\s\S]*NATS\s+nicht verfügbar/,
      );
      expect(await services.getByRole("link", { name: /^Postgres/ }).getAttribute("href")).toBe(
        "/admin/observability/infrastructure/postgres",
      );
      expect(await services.getByRole("link", { name: /^NATS/ }).getAttribute("href")).toBe("/admin/observability/infrastructure/nats");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the screen keeps the v2 rules at 1440, 1024 and 390 px, quiet, busy and with the worst real data", async () => {
    const cases: [string, string, View][] = [
      ["normal", "normal", desktop],
      ["normal", "normal", tablet],
      ["normal", "normal", phone],
      ["quiet", "quiet", desktop],
      ["quiet", "quiet", phone],
      ["worst", "worst", desktop],
      ["worst", "worst", phone],
    ];
    for (const [name, state, view] of cases) {
      const { context, tab, errors } = await open(view, "/admin/observability", state);
      try {
        const outline = await describeV2Page(tab, "#root");
        expect({ name, width: view.width, problems: outline.includes("Problems (") ? outline : "" }).toEqual({
          name,
          width: view.width,
          problems: "",
        });
        const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
        expect({ name, width: view.width, problems: layout.problems }).toEqual({ name, width: view.width, problems: [] });
        if (state === "quiet") expect(await tab.getByText("Keine aktiven Störungen").first().isVisible()).toBe(true);
        await shoot(tab, `overview-${name}-${view.width}`);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 180_000);
});
