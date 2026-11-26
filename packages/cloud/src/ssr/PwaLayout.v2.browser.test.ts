import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { launchBrowser, launchHookMs, settled } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import * as watcher from "../_internal/runtime-watcher";
import type { RuntimeAppMeta } from "../contracts/app";
import { PWA_CANVAS_COLORS } from "../contracts/pwa";
import type { User } from "../contracts/shared";
import { type AuthContext, auth } from "../server/middleware/auth";
import { announcements } from "../services/announcements";
import { session } from "../services/session";

// A Cloud app page on v2 (`PwaLayout ui="v2"`) as the phone and a wide screen show it: the frame, the page's panes, the
// tab bar or the sidebar, clear of the safe areas, in the canvas the status bar takes. The page loads Core's v2.css
// alone; beside an older Core it keeps global.css, which holds the same rules.
const root = mkdtempSync(join(tmpdir(), "cloud-pwa-layout-v2-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { defineApp } = await import("../_internal/define-app");
const { default: PwaLayout } = await import("./PwaLayout");
const { Bar, Button, Pane, Row, Section, Text, Workspace } = await import("@k2b/ui/v2");

const { ssr } = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-box",
  description: "Invented test part",
  baseUrl: "http://inventory:3000",
  routes: [],
  pwa: {},
});

/** Invented demo account. */
const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "mmuster",
  provider: "local",
  profile: "user",
  roles: ["user", "local", "local/user"],
  givenname: "Mia",
  sn: "Muster",
  displayName: "Mia Muster",
  mail: "mia.muster@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const part = (id: string, name: string, icon: string): RuntimeAppMeta => ({
  id,
  name,
  icon: `ti ti-${icon}`,
  description: "",
  routes: [`/pwa/${id}`],
  pwa: { href: `/pwa/${id}` },
});
const apps: RuntimeAppMeta[] = [
  { id: "pwa", name: "Mobile app", icon: "ti ti-device-mobile", description: "", routes: ["/pwa"] },
  part("inventory", "Inventory", "box"),
  part("chat", "Chat", "messages"),
  part("spaces", "Spaces", "layout-kanban"),
  part("files", "Files", "folder"),
];

const spies = [
  stubRailSnapshot(),
  spyOn(session, "getToken").mockReturnValue("test-session"),
  spyOn(session, "authenticateRequest").mockResolvedValue({
    user,
    data: { userId: user.id, sid: "test", authEpoch: 0, kind: "app", expiresAt: "2099-01-01T00:00:00Z" },
  }),
  spyOn(announcements.active, "forState").mockResolvedValue({ banners: [], announcements: [], latestAnnouncementVersion: 0 }),
  // The registered Core serves v2.css; the global.css cases below build the older Core's sheet instead.
  spyOn(watcher, "registeredCoreRoutes").mockReturnValue(["/public/global.css", "/public/v2.css"]),
];

/** Invented shelves, more than a phone screen holds, so the pane scrolls and the document does not. */
const shelves = Array.from({ length: 24 }, (_, index) => ({
  name: `Regal ${String.fromCharCode(65 + (index % 6))}${Math.floor(index / 6) + 1}`,
  line: `${12 + index * 3} Artikel · Lager Nord`,
}));
const rows = () =>
  createComponent(Section, {
    icon: "box",
    title: "Regale",
    get children() {
      return shelves.map((shelf) => createComponent(Row, { icon: "box", lines: [shelf.name, shelf.line], href: "#regal" }));
    },
  });

type Variant = "framed" | "bare" | "screen";
const pageOf = (variant: Variant) =>
  ssr<AuthContext>(
    (c) => () =>
      createComponent(PwaLayout, {
        c,
        ui: "v2",
        title: "Inventory",
        back: variant === "screen" ? { href: "/pwa/inventory", label: "Inventory" } : undefined,
        bare: variant !== "framed",
        screen: variant === "screen",
        get actions() {
          return createComponent(Button, { variant: "ghost", icon: "settings", label: "Settings", href: "/pwa/settings" });
        },
        get children() {
          if (variant === "framed") return rows();
          // A bare page brings its own Workspace from its island, here with the pane's own head.
          return createComponent(Workspace, {
            get children() {
              return createComponent(Pane, {
                label: "Regale",
                get head() {
                  return createComponent(Bar, {
                    get start() {
                      return createComponent(Text, { weight: "strong", children: "Regale" });
                    },
                  });
                },
                get children() {
                  return rows();
                },
              });
            },
          });
        },
      }),
  );

const server = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.set("runtime" as never, { apps } as never);
    await next();
  })
  .get("/pwa/inventory", auth.requireRole("user", ssr.pwaAccess), ...pageOf("framed"))
  .get("/pwa/inventory/bare", auth.requireRole("user", ssr.pwaAccess), ...pageOf("bare"))
  .get("/pwa/inventory/screen", auth.requireRole("user", ssr.pwaAccess), ...pageOf("screen"));

const origin = "https://cloud.example.test";
/** The insets of a phone with a notch and a home indicator; env() is 0 in a desktop engine. */
const insets = { top: 47, right: 0, bottom: 34, left: 0 };
const withInsets = (css: string) =>
  css.replace(/env\(\s*safe-area-inset-(top|right|bottom|left)\s*\)/g, (_, side: keyof typeof insets) => `${insets[side]}px`);

let browser: Browser;
const sheets: Record<"v2.css" | "global.css", string> = { "v2.css": "", "global.css": "" };
beforeAll(async () => {
  const v2 = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../styles/v2-page.css")] });
  const global = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  for (const build of [v2, global]) if (!build.success) throw new AggregateError(build.logs, "Could not build the stylesheets.");
  sheets["v2.css"] = withInsets(await v2.outputs[0]!.text());
  sheets["global.css"] = withInsets(await global.outputs[0]!.text());
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  for (const spy of spies) spy.mockRestore();
});

const open = async (path: string, width: number, sheet: keyof typeof sheets, theme: "light" | "dark" = "light") => {
  const response = await server.request(`${origin}${path}`, { headers: { Cookie: `pwa_session=test-session; theme=${theme}` } });
  expect(response.status).toBe(200);
  const document = await response.text();
  const phone = width < 768;
  const page = await browser.newPage({
    // The server's page alone (its islands' scripts are not served): the frame must stand without them.
    colorScheme: theme,
    viewport: { width, height: phone ? 844 : 900 },
    ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
  });
  await page.route(`${origin}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === path) return route.fulfill({ contentType: "text/html", body: document });
    // The page links v2.css; beside an older Core the same link is answered with global.css.
    if (url.pathname === "/public/v2.css") return route.fulfill({ contentType: "text/css", body: sheets[sheet] });
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${origin}${path}`);
  await settled(page);
  return page;
};

describe("PwaLayout ui v2 in a browser", () => {
  for (const sheet of ["v2.css", "global.css"] as const)
    for (const variant of ["framed", "bare"] as const)
      for (const width of [390, 1024, 1440])
        test(`${sheet}: ${variant} page at ${width} px: clean, inside the window, clear of the safe areas`, async () => {
          const page = await open(variant === "framed" ? "/pwa/inventory" : "/pwa/inventory/bare", width, sheet);
          try {
            const outline = await describeV2Page(page, ".pwa-v2-main");
            expect(outline.includes("Problems (") ? outline : "").toBe("");
            const layout = await measureV2Layout(page, { root: ".pwa-v2-main [data-k2-workspace]" });
            expect(layout.problems).toEqual([]);
            const result = await page.evaluate(() => {
              const box = (selector: string) => {
                const element = document.querySelector(selector);
                if (!element || element.getClientRects().length === 0) return undefined;
                const { top, right, bottom, left, width, height } = element.getBoundingClientRect();
                return { top, right, bottom, left, width, height };
              };
              const pane = document.querySelector<HTMLElement>(".pwa-v2-main .k2-scroll")!;
              return {
                frame: box(".pwa-v2"),
                main: box(".pwa-v2-main"),
                nav: box(".pwa-v2-nav"),
                tabs: box(".pwa-v2-tabs"),
                actions: box(".pwa-v2-actions a"),
                // a slot shows its contents only; the bar is the head's box
                head: box(".pwa-v2-main .k2-bar"),
                scrollWidth: document.documentElement.scrollWidth,
                documentScrolls: document.scrollingElement!.scrollHeight > innerHeight,
                paneScrolls: pane.scrollHeight > pane.clientHeight,
                tabsPadding: getComputedStyle(document.querySelector(".pwa-v2-tabs")!).paddingBottom,
              };
            });
            expect(result.scrollWidth).toBeLessThanOrEqual(width);
            expect(result.documentScrolls).toBe(false);
            expect(result.paneScrolls).toBe(true);
            // The page's actions stay in the frame's head at every width; a bare page has its own head.
            if (variant === "framed") expect(result.actions?.width).toBeGreaterThan(0);
            expect(Math.round(result.frame!.height)).toBe(width < 768 ? 844 : 900);
            // The page's head starts below the status bar and the notch.
            expect(result.head!.top).toBeGreaterThanOrEqual(insets.top);
            if (width < 768) {
              // Phone: the page fills the width; the tab bar ends at the window's edge and holds the home indicator.
              expect(result.nav).toBeUndefined();
              expect(result.main).toMatchObject({ left: 0, width });
              expect(Math.round(result.tabs!.bottom)).toBe(844);
              expect(result.tabsPadding).toBe(`${insets.bottom}px`);
              // its line, its 56 px row, the home indicator
              expect(result.tabs!.height).toBe(1 + 56 + insets.bottom);
              expect(result.main!.bottom).toBeLessThanOrEqual(result.tabs!.top + 0.5);
            } else {
              // Wide: the sidebar beside the page, no tab bar; the page keeps clear of the bottom inset.
              expect(result.tabs).toBeUndefined();
              expect(result.nav).toMatchObject({ left: 0, width: 248 });
              expect(result.main!.left).toBeGreaterThanOrEqual(248);
              expect(result.main!.bottom).toBeLessThanOrEqual(900 - insets.bottom + 0.5);
            }
          } finally {
            await page.close();
          }
        }, 60_000);

  test("a screen page has no tab bar and keeps clear of the home indicator", async () => {
    const page = await open("/pwa/inventory/screen", 390, "v2.css");
    try {
      const result = await page.evaluate(() => ({
        tabs: document.querySelector(".pwa-v2-tabs")?.getClientRects().length ?? 0,
        main: document.querySelector(".pwa-v2-main")!.getBoundingClientRect().bottom,
        back: document.querySelector(".pwa-v2-back a")?.getAttribute("aria-label"),
      }));
      expect(result.tabs).toBe(0);
      expect(Math.round(result.main)).toBe(844 - insets.bottom);
    } finally {
      await page.close();
    }
  }, 60_000);

  for (const theme of ["light", "dark"] as const)
    test(`gives the status bar the frame's canvas (${theme})`, async () => {
      const page = await open("/pwa/inventory", 390, "v2.css", theme);
      try {
        const result = await page.evaluate(() => {
          const swatch = document.createElement("i");
          swatch.style.color = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].find(
            (meta) => !meta.media || matchMedia(meta.media).matches,
          )!.content;
          document.body.append(swatch);
          const themeColor = getComputedStyle(swatch).color;
          swatch.remove();
          return {
            themeColor,
            html: getComputedStyle(document.documentElement).backgroundColor,
            frame: getComputedStyle(document.querySelector(".pwa-v2")!).backgroundColor,
            colorScheme: getComputedStyle(document.documentElement).colorScheme,
          };
        });
        const rgb = (hex: string) => `rgb(${[1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)).join(", ")})`;
        const canvas = rgb(PWA_CANVAS_COLORS[theme]);
        expect(result).toEqual({ themeColor: canvas, html: canvas, frame: canvas, colorScheme: theme });
      } finally {
        await page.close();
      }
    }, 60_000);
});
