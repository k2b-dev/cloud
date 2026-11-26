import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { User } from "@k2b/cloud/contracts";
import { defaultRailPreferences } from "@k2b/cloud/contracts/rail-preferences";
import * as services from "@k2b/cloud/services";
import { railPreferences } from "@k2b/cloud/services/rail-preferences";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

// Core's error pages on v2, as the server sends them, in the Cloud shell before any island runs: the 404 of every
// unknown address (Core's words), and the shared error page of `ssr.error` for 403, a generic 404 and a failure, with
// the waiting game where it is offered. Pictures with CLOUD_ERROR_SHOTS.
const root = mkdtempSync(join(tmpdir(), "core-error-pages-browser-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { ssr } = await import("../config");
const notFoundPage = (await import("./NotFound")).default;
const { buildFontAssets } = await import("../../scripts/font-assets");
const { buildTablerIconAssets } = await import("../../scripts/tabler-assets");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_ERROR_SHOTS;

/** Invented demo account. */
const user: User = {
  id: "00000000-0000-4000-8000-000000000042",
  uid: "jbeispiel",
  roles: ["local", "user"],
  provider: "local",
  profile: "user",
  givenname: "Jonas",
  sn: "Beispiel",
  displayName: "Jonas Beispiel",
  mail: "jonas.beispiel@example.org",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};

const app = new Hono()
  .use("*", async (c, next) => {
    c.set("user" as never, user as never);
    c.set("runtime" as never, { apps: [] } as never);
    await next();
  })
  .get("/forbidden", (c) => ssr.error(c, 403))
  .get("/gone", (c) => ssr.error(c, 404))
  .get("/broken", (c) => ssr.error(c, 503))
  .get("/*", ...notFoundPage);

const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  spies.push(
    spyOn(services.coreSettings, "get").mockImplementation(async (key) => (key === "app.name" ? "Cloud" : undefined) as never),
    spyOn(railPreferences, "get").mockResolvedValue(defaultRailPreferences()),
    spyOn(services.railShortcuts, "forUser").mockResolvedValue([]),
    spyOn(services.announcements.active, "forState").mockResolvedValue({
      banners: [],
      announcements: [],
      latestAnnouncementVersion: null,
    } as never),
  );
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

let browser: Browser;
let pageCss: { app: string; global: string; v2: string };
beforeAll(async () => {
  const styles = [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  pageCss = { app: appCss!, global: globalCss!, v2: readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8") };
  if (shots) mkdirSync(shots, { recursive: true });
  await buildFontAssets(join(root, "public"));
  await buildTablerIconAssets(join(root, "public"));
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean; name: string };
const views: View[] = [
  { width: 1440, height: 900, touch: false, name: "1440" },
  { width: 1024, height: 768, touch: false, name: "1024" },
  { width: 390, height: 844, touch: true, name: "390" },
];

/** The whole page as the server sends it, with the template's stylesheets and fonts and no island scripts. */
const open = async (view: View, path: string): Promise<{ tab: Page; status: number }> => {
  const response = await app.request(`${origin}${path}`, { headers: { Cookie: "cloud.locale=de" } });
  const html = (await response.text()).replace("</head>", `<style>${pageCss.v2}</style></head>`);
  const tab = await browser.newPage({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
  });
  await tab.route(`${origin}/**`, (route) => {
    const requested = new URL(route.request().url()).pathname;
    if (requested === path) return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    if (requested.startsWith("/branding/"))
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0f172a"/></svg>',
      });
    if (requested.endsWith("/app.css")) return route.fulfill({ contentType: "text/css", body: pageCss.app });
    if (requested === "/public/global.css") return route.fulfill({ contentType: "text/css", body: pageCss.global });
    if (requested.startsWith("/public/")) return route.fulfill({ path: join(root, requested) }).catch(() => route.fulfill({ status: 404 }));
    return route.fulfill({ status: 404, body: "" });
  });
  await tab.goto(`${origin}${path}`);
  await tab.evaluate(() => document.fonts.ready);
  return { tab, status: response.status };
};

const pages = [
  { path: "/forbidden", name: "403", status: 403, text: "Dein Konto hat keine Berechtigung, diese Seite zu öffnen.", game: false },
  { path: "/gone", name: "404-generic", status: 404, text: "Diese Seite ist nicht verfügbar", game: true },
  { path: "/broken", name: "503", status: 503, text: "Bitte versuche es später erneut.", game: true },
  { path: "/nicht/da", name: "404-core", status: 404, text: "Die Seite ist nicht vorhanden", game: false },
];

describe("error pages on v2", () => {
  test("each error page is a v2 screen in the shell: one sign, one sentence, one way home, the game only where offered", async () => {
    const findings: string[] = [];
    for (const page of pages)
      for (const view of views) {
        const { tab, status } = await open(view, page.path);
        try {
          expect(status).toBe(page.status);
          const empty = tab.locator('[data-k2-part="Empty"]');
          expect(await empty.count()).toBe(1);
          expect(await empty.textContent()).toContain(page.text);
          expect(await empty.locator('a[href="/"]').count()).toBe(1);
          expect(await tab.locator("[data-waiting-game]").count()).toBe(page.game ? 1 : 0);
          // the game's box stands at its size before its code arrives, so nothing moves then
          if (page.game) expect((await tab.locator("[data-waiting-game]").boundingBox())?.height ?? 0).toBeGreaterThan(300);
          // the title stands once: in the head, not again in the phone bar above it
          expect(await tab.getByText(await tab.title(), { exact: true }).count()).toBe(1);
          const outline = await describeV2Page(tab, ".layout-content-main");
          if (outline.includes("Problems (")) findings.push(`${page.name} ${view.name}:\n${outline.slice(outline.indexOf("Problems ("))}`);
          const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
          for (const problem of layout.problems) findings.push(`${page.name} ${view.name} layout: ${problem}`);
          if (shots) await tab.screenshot({ path: join(shots, `${page.name}-${view.name}.png`) });
        } finally {
          await tab.close();
        }
      }
    expect(findings).toEqual([]);
  }, 180_000);
});
