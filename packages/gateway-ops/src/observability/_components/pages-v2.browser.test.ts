import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";

// The gateway routes, the notification definitions, the earlier notifications and the capability console on v2, from
// invented data: each keeps the v2 layout rules at desktop, tablet and phone width, with normal and worst-case data.
// `CLOUD_PAGES_V2_SHOTS=<dir>` also saves a light screenshot per screen, data set and width.
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_PAGES_V2_SHOTS;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "pages-v2.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-pages-v2-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Pages v2 harness build failed");
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

const document = (screen: string, state: string) =>
  `<!doctype html><html lang="de" class="light" data-screen="${screen}" data-state="${state}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

type View = { width: number; height: number; touch: boolean };
const desktop: View = { width: 1440, height: 900, touch: false };
const tablet: View = { width: 1024, height: 800, touch: false };
const phone: View = { width: 390, height: 844, touch: true };

const open = async (view: View, screen: string, address: string, state = "normal") => {
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
    if (url.pathname.startsWith("/admin/observability/"))
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: document(screen, state) });
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

const ADDRESS: Record<string, string> = {
  routes: "/admin/observability/gateway/routes",
  registry: "/admin/observability/deliveries?tab=registry",
  legacy: "/admin/observability/deliveries?tab=legacy",
  capabilities: "/admin/observability/capabilities",
};

describe("gateway routes, notifications and capabilities on v2", () => {
  test("each screen keeps the v2 rules at 1440, 1024 and 390 px, with normal and worst-case data", async () => {
    const cases: [string, string, string, View][] = [];
    for (const screen of Object.keys(ADDRESS)) {
      for (const view of [desktop, tablet, phone]) cases.push([screen, ADDRESS[screen]!, "normal", view]);
      for (const view of [desktop, phone]) cases.push([screen, ADDRESS[screen]!, "worst", view]);
    }
    cases.push(["capabilities", "/admin/observability/capabilities?request=request-0", "normal", desktop]);
    cases.push(["capabilities", "/admin/observability/capabilities?request=request-0", "normal", phone]);
    cases.push(["capabilities", "/admin/observability/capabilities?tab=apps", "normal", desktop]);
    cases.push(["legacy", "/admin/observability/deliveries?tab=legacy&notification=n-0", "normal", desktop]);
    cases.push(["legacy", "/admin/observability/deliveries?tab=legacy&notification=n-0", "worst", phone]);
    for (const [screen, address, state, view] of cases) {
      const name = `${screen}${/request=|notification=/.test(address) ? "-record" : address.includes("tab=apps") ? "-apps" : ""}-${state}-${view.width}`;
      const { context, tab, errors } = await open(view, screen, address, state);
      try {
        const outline = await describeV2Page(tab, "#root");
        expect({ name, problems: outline.includes("Problems (") ? outline : "" }).toEqual({ name, problems: "" });
        const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
        expect({ name, problems: layout.problems }).toEqual({ name, problems: [] });
        await shoot(tab, name);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 300_000);

  test("an earlier notification opens beside the list; it is edited in a dialog and sent again after a question", async () => {
    const { context, tab, errors } = await open(desktop, "legacy", ADDRESS.legacy!);
    try {
      await tab.getByRole("link", { name: /Willkommen 2/ }).click();
      await tab.waitForURL(/notification=n-2/);
      await tab.waitForSelector('body[data-ready="true"]');
      await tab.getByRole("button", { name: "Bearbeiten" }).click();
      const dialog = tab.getByRole("dialog");
      expect(await dialog.getByRole("textbox", { name: "Betreff" }).inputValue()).toBe("Willkommen 2");
      await dialog.getByRole("button", { name: "Abbrechen" }).click();
      await tab.getByRole("button", { name: "Erneut senden" }).click();
      await tab.getByRole("alertdialog").waitFor();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
