import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { pageErrors, settled } from "./browser";

/**
 * A page of an app as Cloud draws it, for browser tests and design pictures without a running Cloud: the first HTML
 * of the real page (with its shell) or a test harness, served with the shell's own stylesheets, Plex fonts and icons.
 * Every request that leaves the test origin is refused, so a picture never depends on the network.
 *
 *   const assets = await loadShellAssets({ appCss: resolve(dir, "../styles/app.css"), appId: "ipa-hosts" });
 *   const { tab, errors, context } = await openShellPage(browser, assets, { path: "/admin/ipa-hosts", html, width: 1440 });
 */

export const SHELL_ORIGIN = "https://cloud.example.test";

/** One invented mark for every logo and app symbol the shell asks for, so no picture shows a broken image. */
const LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2563eb"/><path d="M9 20a5 5 0 0 1 1-9.9A7 7 0 0 1 23 12a4 4 0 0 1 0 8z" fill="#fff"/></svg>';

export type ShellAssets = {
  /** Answers a request for one of the shell's assets; false when the path is none of them. */
  serve: (route: Route, url: URL) => Promise<boolean>;
  /** The `<link>`s a harness document puts in its head to draw with the shell's fonts and icons. */
  head: string;
};

/** Builds the shell's stylesheets once per test file and serves them, the Plex fonts and the icons, at their paths. */
export const loadShellAssets = async (app: { id: string; css: string }): Promise<ShellAssets> => {
  const uiDist = dirname(fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css")));
  const icons = await Bun.file(resolve(uiDist, "tabler.css")).text();
  const iconFont = /tabler-icons-[\w-]+\.woff2/.exec(icons)?.[0];
  if (!iconFont) throw new Error("The Tabler preset names no font");
  const build = async (entry: string) => {
    const result = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
    if (!result.success) throw new AggregateError(result.logs, `Could not build ${entry}`);
    return result.outputs[0]!.text();
  };
  const v2 = await Bun.file(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css"))).text();
  const stylesheets: Record<string, string> = {
    "/public/fonts.css": (await Bun.file(resolve(uiDist, "plex.css")).text()).replaceAll("./fonts/", "/public/fonts/"),
    "/public/tabler-icons.css": icons.replace(/\.\/tabler-icons-[\w-]+\.woff2(\?[^)]*)?/, "/public/tabler-icons.woff2"),
    "/public/global.css": await build(resolve(import.meta.dir, "../../../styles.css")),
    [`/public/${app.id}/app.css`]: await build(app.css),
    "/public/v2.css": v2,
  };
  const fonts = resolve(uiDist, "fonts");
  return {
    head: ["/public/fonts.css", "/public/tabler-icons.css", "/public/global.css", `/public/${app.id}/app.css`, "/public/v2.css"]
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
 * scripts answer empty), so the picture is the first one a person sees; every other request is refused.
 *
 * `extra` puts a test's own script into the real page, such as a harness that renders the app's screen from invented
 * data into its island, so a dialog opens inside the shell's frame: `html` goes before `</body>`, and `files` answer
 * their paths (a script, or what an API returns for any method). The page then waits for `body[data-ready]`.
 */
export const openShellPage = async (
  browser: Browser,
  assets: ShellAssets,
  page: { path: string; html: string; width: number; extra?: { html: string; files: Record<string, { type: string; body: string }> } },
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
  const errors = pageErrors(tab);
  await tab.goto(`${SHELL_ORIGIN}${page.path}`);
  if (page.extra) await tab.waitForSelector("body[data-ready]");
  await tab.evaluate(() => window.document.fonts.ready);
  await settled(tab);
  return { context, tab, errors };
};
