import { afterAll, spyOn } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { settled } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import * as watcher from "./_internal/runtime-watcher";

/**
 * `@k2b/cloud/testing`: an app's page as Cloud draws it, for browser tests and design pictures without a running
 * Cloud. Needs Playwright in the consumer; nothing here is part of the runtime exports.
 *
 * - `loadShellAssets({ id, css })`: the app's own sheet and Cloud's global.css or, with `v2Page`, Core's v2.css in its
 *   place, built from this Cloud, with the Plex fonts and the icons, served at the paths a page asks for.
 * - `openShellPage(browser, assets, { path, html, width, errors })`: the first HTML of a page (or a harness) at one
 *   width, light; every request that leaves the test origin is refused, so a picture never depends on the network.
 * - `serveCoreV2Sheet()`: the registered Core declares its `/public/v2.css`, as every current installation does.
 *
 *   serveCoreV2Sheet();
 *   const assets = await loadShellAssets({ id: "oauth", css: resolve(dir, "../styles/app.css"), v2Page: true });
 *   const { tab, errors, context } = await openShellPage(browser, assets, { path: "/oauth/device", html, width: 390, errors: pageErrors });
 */

export const SHELL_ORIGIN = "https://cloud.example.test";

/** One invented mark for every logo and app symbol the shell asks for, so no picture shows a broken image. */
const LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2563eb"/><path d="M9 20a5 5 0 0 1 1-9.9A7 7 0 0 1 23 12a4 4 0 0 1 0 8z" fill="#fff"/></svg>';

export type ShellAssets = {
  /** Answers a request for one of the shell's assets; false when the path is none of them. */
  serve: (route: Route, url: URL) => Promise<boolean>;
  /** The `<link>`s a harness document puts in its head to draw with the shell's sheets, fonts and icons. */
  head: string;
};

const build = async (entry: string, withTailwind: boolean) => {
  const result = await Bun.build({ entrypoints: [entry], plugins: withTailwind ? [tailwind] : [] });
  if (!result.success) throw new AggregateError(result.logs, `Could not build ${entry}`);
  return result.outputs[0]!.text();
};

/**
 * Builds the page's stylesheets once per test file and serves them, the Plex fonts and the icons at their paths, in the
 * order a page links them (`pageStylesheetLinks`): fonts, icons, the app's sheet at `/public/<id>/app.css`, then Cloud's
 * global.css or, for a page that links Core's v2.css alone (a visitor page on `MinimalLayout ui="v2"`, an app page on
 * `PwaLayout ui="v2"`), that sheet with `v2Page`.
 */
export const loadShellAssets = async (app: { id: string; css: string; v2Page?: boolean }): Promise<ShellAssets> => {
  const uiDist = dirname(fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css")));
  const icons = await Bun.file(resolve(uiDist, "tabler.css")).text();
  const iconFont = /tabler-icons-[\w-]+\.woff2/.exec(icons)?.[0];
  if (!iconFont) throw new Error("The Tabler preset names no font");
  const styles = resolve(import.meta.dir, "styles");
  const stylesheets: Record<string, string> = {
    "/public/fonts.css": (await Bun.file(resolve(uiDist, "plex.css")).text()).replaceAll("./fonts/", "/public/fonts/"),
    "/public/tabler-icons.css": icons.replace(/\.\/tabler-icons-[\w-]+\.woff2(\?[^)]*)?/, "/public/tabler-icons.woff2"),
    [`/public/${app.id}/app.css`]: await build(app.css, true),
    ...(app.v2Page
      ? { "/public/v2.css": await build(resolve(styles, "v2-page.css"), false) }
      : { "/public/global.css": await build(resolve(styles, "global.css"), true) }),
  };
  const fonts = resolve(uiDist, "fonts");
  return {
    head: Object.keys(stylesheets)
      .map((href) => `<link rel="stylesheet" href="${href}">`)
      .join(""),
    serve: async (route, url) => {
      const css = stylesheets[url.pathname];
      if (css !== undefined) return route.fulfill({ contentType: "text/css", body: css }).then(() => true);
      if (url.pathname === "/public/tabler-icons.woff2") return route.fulfill({ path: resolve(uiDist, iconFont) }).then(() => true);
      if (url.pathname.startsWith("/public/fonts/")) {
        const path = resolve(fonts, url.pathname.slice("/public/fonts/".length));
        if (!path.startsWith(`${fonts}/`)) return route.fulfill({ status: 404, body: "" }).then(() => true);
        return route.fulfill({ path }).then(() => true);
      }
      if (route.request().resourceType() === "image") return route.fulfill({ contentType: "image/svg+xml", body: LOGO }).then(() => true);
      return false;
    },
  };
};

/**
 * Opens the first HTML of a page in the shell at one width, light. The islands stay as the server drew them (their
 * scripts answer empty), so the picture is the first one a person sees; every other request is refused. `errors`
 * collects the page's errors from the moment it opens (the test's own collector, such as one that knows WebKit's
 * words for a refused request).
 *
 * `extra` puts a test's own script into the real page, such as a harness that renders the app's screen from invented
 * data into its island, so a dialog opens inside the shell's frame: `html` goes before `</body>`, and `files` answer
 * their paths (a script, or what an API returns for any method). The page then waits for `body[data-ready]`.
 */
export const openShellPage = async (
  browser: Browser,
  assets: ShellAssets,
  page: {
    path: string;
    html: string;
    width: number;
    errors: (tab: Page) => string[];
    extra?: { html: string; files: Record<string, { type: string; body: string }> };
  },
): Promise<{ context: BrowserContext; tab: Page; errors: string[] }> => {
  const phone = page.width < 600;
  const context = await browser.newContext({
    viewport: { width: page.width, height: phone ? 844 : 900 },
    deviceScaleFactor: 1,
    isMobile: phone,
    hasTouch: phone,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  const html = page.extra ? page.html.replace("</body>", `${page.extra.html}</body>`) : page.html;
  await context.route("**", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== SHELL_ORIGIN) return route.abort("blockedbyclient");
    if (url.pathname === new URL(page.path, SHELL_ORIGIN).pathname)
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    const file = page.extra?.files[url.pathname];
    if (file) return route.fulfill({ contentType: file.type, body: file.body });
    if (await assets.serve(route, url)) return;
    if (route.request().resourceType() === "script") return route.fulfill({ contentType: "text/javascript", body: "" });
    return route.fulfill({ status: 404, body: "" });
  });
  const tab = await context.newPage();
  const errors = page.errors(tab);
  await tab.goto(`${SHELL_ORIGIN}${page.path}`);
  if (page.extra) await tab.waitForSelector("body[data-ready]", { state: "attached" });
  await tab.evaluate(() => window.document.fonts.ready);
  await settled(tab);
  return { context, tab, errors };
};

/**
 * Lets an app's SSR test render as a current installation: the registered Core declares its `/public/v2.css`, so a page
 * on `MinimalLayout ui="v2"` or `PwaLayout ui="v2"` links it alone and draws the v2 frame. Without it a test renders the
 * frame beside an older Core, a state no current installation shows. The spy is restored after the calling test file.
 */
export const serveCoreV2Sheet = () => {
  const routes = spyOn(watcher, "registeredCoreRoutes").mockReturnValue(["/public/global.css", "/public/v2.css"]);
  afterAll(() => routes.mockRestore());
  return routes;
};
