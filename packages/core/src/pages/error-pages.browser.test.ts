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
const { LAUF_CSS, LAUF_SCRIPT, maintenanceGameMessages } = await import("@k2b/cloud/maintenance-game");
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
const open = async (view: View, path: string, theme: "light" | "dark" = "light"): Promise<{ tab: Page; status: number }> => {
  const response = await app.request(`${origin}${path}`, { headers: { Cookie: "cloud.locale=de" } });
  const html = (await response.text()).replace("</head>", `<style>${pageCss.v2}</style></head>`);
  const tab = await browser.newPage({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
    // the page's own script follows the system's scheme while the person chose "automatic"
    colorScheme: theme,
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
  { path: "/forbidden", name: "403", status: 403, title: "Dafür fehlt dir der Zugriff", primary: "/", game: false },
  { path: "/gone", name: "404", status: 404, title: "Diese Seite gibt es nicht", primary: "/", game: true },
  { path: "/broken", name: "503", status: 503, title: "Die Seite konnte nicht geöffnet werden", primary: "/broken", game: true },
  { path: "/nicht/da", name: "404-core", status: 404, title: "Diese Seite gibt es nicht", primary: "/", game: true },
];

describe("error pages on v2", () => {
  test("each error page is the approved direction A in the shell: the code alone, title, sentence, two ways out, no head", async () => {
    const findings: string[] = [];
    for (const page of pages)
      for (const view of views) {
        const { tab, status } = await open(view, page.path);
        try {
          expect(status).toBe(page.status);
          const screen = tab.locator('[data-k2-part="ErrorScreen"]');
          expect(await screen.count()).toBe(1);
          // the code alone as the sign: no icon in or on it
          expect(await screen.locator(".k2-es-code").textContent()).toBe(String(page.status));
          expect(await screen.locator(".k2-es-code .k2-icon").count()).toBe(0);
          expect(await screen.getByRole("heading", { level: 1 }).textContent()).toBe(page.title);
          // the title stands once on the page: no head row, and the phone bar names the app
          expect(await tab.getByText(page.title, { exact: true }).count()).toBe(1);
          expect(await tab.locator('[data-k2-workspace] [data-slot="head"]').count()).toBe(0);
          // two ways out, the first is the primary one; a failure loads the same address again first
          const actions = screen.locator(".k2-es-actions .k2-btn");
          expect(await actions.count()).toBe(2);
          expect(await actions.first().getAttribute("data-variant")).toBe("primary");
          expect(await actions.first().getAttribute("href")).toBe(page.primary);
          // the waiting game only as an invitation, where it is offered
          expect(await screen.locator(".k2-es-foot").count()).toBe(page.game ? 1 : 0);
          if (page.game) {
            // a plain symbol with quiet words, no frame, and the words that fit the device: keys or a tap
            const invite = screen.getByRole("button", { name: "Mini-Spiel starten" });
            expect(await invite.evaluate((element) => getComputedStyle(element).borderStyle)).toBe("none");
            expect(await invite.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
            const keys = invite.locator(".k2-es-invite-keys");
            const touch = invite.locator(".k2-es-invite-touch");
            expect([await keys.isVisible(), await touch.isVisible()]).toEqual(view.touch ? [false, true] : [true, false]);
          }
          // the words stand in the middle of the page
          const box = await screen.locator(".k2-es-stack").boundingBox();
          const pane = await screen.boundingBox();
          if (box && pane) expect(Math.abs(box.x + box.width / 2 - (pane.x + pane.width / 2))).toBeLessThan(2);
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

  test("the waiting game plays below the ways out: they stay reachable while it runs and after leaving it", async () => {
    const texts = maintenanceGameMessages.resolve(["de"]).t;
    for (const view of [views[0]!, views[2]!]) {
      const { tab } = await open(view, "/gone");
      try {
        // what the invitation does when pressed, without the island bundle: the game on the screen's stage
        await tab.addStyleTag({ content: LAUF_CSS });
        await tab.addScriptTag({ content: `window.__k2bLauf=${LAUF_SCRIPT};` });
        await tab.evaluate((t) => {
          const host = document.querySelector<HTMLElement>(`[data-k2-part="ErrorScreen"]`)!;
          const factory = Reflect.get(window, "__k2bLauf") as (options: object) => { open(): void; start(): void };
          const game = factory({ host, anchor: () => host.querySelector(".k2-es-stack"), t, dark: () => false, onFinish: () => {} });
          host.setAttribute("data-k2-stage", "");
          game.open();
          game.start();
        }, texts);
        const primary = tab.locator(".k2-es-actions .k2-btn").first();
        const reachable = async () => {
          const box = (await primary.boundingBox())!;
          return tab.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".k2-btn")?.getAttribute("data-variant") ?? null, {
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
          });
        };
        await tab.waitForTimeout(400);
        expect(await tab.evaluate(() => document.documentElement.dataset.lauf)).toBe("run");
        expect(await reachable()).toBe("primary");
        // the words moved to the top, so the road has the room below the ways out
        const actions = (await tab.locator(".k2-es-actions").boundingBox())!;
        if (shots) await tab.screenshot({ path: join(shots, `404-${view.name}-game.png`) });
        await tab.keyboard.press("Escape");
        await tab.waitForTimeout(200);
        expect(await tab.evaluate(() => document.documentElement.dataset.lauf)).toBe("wait");
        expect(await reachable()).toBe("primary");
        expect(actions.y + actions.height).toBeLessThan(view.height / 2);
      } finally {
        await tab.close();
      }
    }
  }, 60_000);

  test.if(Boolean(shots))(
    "the dark theme takes the dark tokens, the outline too",
    async () => {
      const { tab } = await open(views[0]!, "/gone", "dark");
      try {
        expect(await tab.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
        await tab.screenshot({ path: join(shots!, "404-1440-dark.png") });
      } finally {
        await tab.close();
      }
    },
    60_000,
  );
});
