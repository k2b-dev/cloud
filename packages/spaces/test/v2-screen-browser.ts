import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../ui/test/browser";

/**
 * A browser for one v2 screen of Spaces: it builds a harness entry (a `.tsx` that renders the screen from invented
 * data into `#root`), serves it at any page address, and lets the test answer the API. The harness reads the address
 * and the `data-state` of the document, as the page would.
 */
const ui = resolve(import.meta.dir, "../../ui");
export const ORIGIN = "https://cloud.example.test";

export type View = { width: number; height: number; touch: boolean; name: string };
export const wide: View = { width: 1440, height: 900, touch: false, name: "1440" };
export const narrow: View = { width: 1024, height: 768, touch: false, name: "1024" };
export const phone: View = { width: 390, height: 844, touch: true, name: "390" };

/** Answers one API call; return `undefined` to answer 404. */
export type Api = (url: URL, route: Route) => Promise<unknown> | unknown;

const buildHarness = async (entry: string): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    splitting: false,
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-spaces-v2-screen",
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
  if (!build.success) throw new AggregateError(build.logs, `Harness build failed: ${entry}`);
  return build.outputs[0]!.text();
};

export const createScreenBrowser = (entry: string) => {
  let browser: Browser;
  let css = "";
  let harness = "";
  let icons = { css: "", font: "" };
  const start = async () => {
    harness = await buildHarness(entry);
    const iconCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
    const iconCss = await Bun.file(fileURLToPath(iconCssUrl)).text();
    const fontAsset = iconCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
    if (!fontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
    icons = { css: iconCss.replace(fontAsset, "/tabler-icons.woff2"), font: fileURLToPath(new URL(fontAsset, iconCssUrl)) };
    const styles = [resolve(import.meta.dir, "../src/styles/app.css"), resolve(import.meta.dir, "../../../styles.css")];
    const built = await Promise.all(styles.map((path) => Bun.build({ entrypoints: [path], plugins: [tailwind] })));
    for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
    const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
    const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
    css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss, v2Css].join("\n");
    browser = await launchBrowser();
  };
  const stop = async () => {
    await browser?.close();
  };
  const document = (locale: string, state: string) =>
    `<!doctype html><html lang="${locale}" class="light" data-state="${state}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${ORIGIN}/tabler-icons.css">` +
    `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
    `<body class="k2b-ui k2-ui"><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`;

  /** Opens an address; `pages` are the paths the harness answers as a page, `api` answers everything under `/api/`. */
  const open = async (view: View, address: string, options: { pages: string[]; api?: Api; locale?: string; state?: string; now?: string }) => {
    const context: BrowserContext = await browser.newContext({
      viewport: { width: view.width, height: view.height },
      deviceScaleFactor: 1,
      isMobile: view.touch,
      hasTouch: view.touch,
      reducedMotion: "reduce",
      colorScheme: "light",
      timezoneId: "Europe/Berlin",
    });
    // Only Date stands at the fixture time, as the server rendered it; timers and animation frames stay real.
    if (options.now)
      await context.addInitScript((at: number) => {
        const Real = Date;
        window.Date = new Proxy(Real, {
          construct: (target, args) => new target(...((args.length > 0 ? args : [at]) as [number])),
          get: (target, key) => (key === "now" ? () => at : Reflect.get(target, key)),
        });
      }, Date.parse(options.now));
    const tab = await context.newPage();
    tab.setDefaultTimeout(10_000);
    const errors = pageErrors(tab);
    const visited: string[] = [];
    await tab.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (options.pages.includes(url.pathname)) {
        visited.push(`${url.pathname}${url.search}`);
        return route.fulfill({ contentType: "text/html; charset=utf-8", body: document(options.locale ?? "en", options.state ?? "") });
      }
      if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
      if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
      if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
      if (url.pathname.startsWith("/api/") && options.api) {
        const answer = await options.api(url, route);
        if (answer instanceof Response) {
          return route.fulfill({ status: answer.status, contentType: "application/json", body: await answer.text() });
        }
        if (answer !== undefined) return route.fulfill({ json: answer });
      }
      return route.fulfill({ status: 404, json: { message: "Not found" } });
    });
    await tab.goto(`${ORIGIN}${address}`);
    await tab.waitForSelector('body[data-ready="true"]');
    await tab.evaluate(() => window.document.fonts.ready);
    await settled(tab);
    return { context, tab, errors, visited };
  };
  return { start, stop, open };
};

/** The rules of v2 on the resting page: no outline problem and no layout finding. */
export const layoutProblems = async (tab: Page): Promise<string[]> => {
  await tab.mouse.move(0, 0);
  const outline = await describeV2Page(tab, "#root");
  const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]", skip: "[data-k2-canvas]" });
  return [...(outline.includes("Problems (") ? [outline] : []), ...layout.problems];
};
