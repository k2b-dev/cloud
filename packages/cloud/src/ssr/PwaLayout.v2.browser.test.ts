import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import { Hono } from "hono";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { launchBrowser, launchHookMs, settled } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import * as watcher from "../_internal/runtime-watcher";
import type { RuntimeAppMeta } from "../contracts/app";
import { PWA_V2_HEAD_COLORS } from "../contracts/pwa";
import type { User } from "../contracts/shared";
import { type AuthContext, auth } from "../server/middleware/auth";
import { announcements } from "../services/announcements";
import { session } from "../services/session";
import { buildOlderGlobal } from "../styles/older-core-global.test-fixture";

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

const spies: { mockRestore(): void }[] = [
  stubRailSnapshot(),
  spyOn(session, "getToken").mockReturnValue("test-session"),
  spyOn(session, "authenticateRequest").mockResolvedValue({
    user,
    data: { userId: user.id, sid: "test", authEpoch: 0, kind: "app", expiresAt: "2099-01-01T00:00:00Z" },
  }),
  spyOn(announcements.active, "forState").mockResolvedValue({ banners: [], announcements: [], latestAnnouncementVersion: 0 }),
];
// What the registered Core serves; each page sets it (see `open`).
const coreRoutes = spyOn(watcher, "registeredCoreRoutes").mockReturnValue(["/public/global.css", "/public/v2.css"]);
spies.push(coreRoutes);

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
type Insets = { top: number; right: number; bottom: number; left: number };
/** The insets of a phone upright with a notch and a home indicator; env() is 0 in a desktop engine. */
const insets: Insets = { top: 47, right: 0, bottom: 34, left: 0 };
/** The same phone on its side: the notch at one side, the home indicator below. */
const landscape: Insets = { top: 0, right: 47, bottom: 21, left: 47 };
const withInsets = (css: string, sides: Insets) =>
  css.replace(/env\(\s*safe-area-inset-(top|right|bottom|left)\s*\)/g, (_, side: keyof Insets) => `${sides[side]}px`);

let browser: Browser;
// `older global.css` is the sheet of a Core from before the v2 frame: global.css without the frame's rules.
const sheets: Record<"v2.css" | "older global.css", string> = { "v2.css": "", "older global.css": "" };
beforeAll(async () => {
  const v2 = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../styles/v2-page.css")] });
  if (!v2.success) throw new AggregateError(v2.logs, "Could not build v2.css.");
  sheets["v2.css"] = await v2.outputs[0]!.text();
  sheets["older global.css"] = await buildOlderGlobal(["./pwa-layout.css"]);
  if (sheets["older global.css"].includes("pwa-v2")) throw new Error("The older sheet still holds the v2 frame.");
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  for (const spy of spies) spy.mockRestore();
});

const open = async (
  path: string,
  width: number,
  sheet: keyof typeof sheets,
  options: { theme?: "light" | "dark"; height?: number; sides?: Insets } = {},
) => {
  const theme = options.theme ?? "light";
  // A Core from before the v2 frame declares global.css only; the page then takes the v1 frame.
  coreRoutes.mockReturnValue(sheet === "v2.css" ? ["/public/global.css", "/public/v2.css"] : ["/public/global.css"]);
  const response = await server.request(`${origin}${path}`, { headers: { Cookie: `pwa_session=test-session; theme=${theme}` } });
  expect(response.status).toBe(200);
  const document = await response.text();
  const phone = width < 768;
  const page = await browser.newPage({
    // The server's page alone (its islands' scripts are not served): the frame must stand without them.
    colorScheme: theme,
    viewport: { width, height: options.height ?? (phone ? 844 : 900) },
    ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
  });
  const css = withInsets(sheets[sheet], options.sides ?? (phone ? insets : { top: 0, right: 0, bottom: insets.bottom, left: 0 }));
  await page.route(`${origin}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === path) return route.fulfill({ contentType: "text/html", body: document });
    if (url.pathname === `/public/${sheet === "v2.css" ? "v2.css" : "global.css"}`)
      return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${origin}${path}`);
  await settled(page);
  return page;
};

describe("PwaLayout ui v2 in a browser", () => {
  for (const variant of ["framed", "bare"] as const)
    for (const width of [390, 1024, 1440])
      test(`${variant} page at ${width} px: clean, inside the window, clear of the safe areas`, async () => {
        const page = await open(variant === "framed" ? "/pwa/inventory" : "/pwa/inventory/bare", width, "v2.css");
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
              tabs: box(".k2-tabbar"),
              actions: box(".pwa-v2-actions a"),
              // a slot shows its contents only; the bar is the head's box
              head: box(".pwa-v2-main .k2-bar"),
              scrollWidth: document.documentElement.scrollWidth,
              documentScrolls: document.scrollingElement!.scrollHeight > innerHeight,
              paneScrolls: pane.scrollHeight > pane.clientHeight,
              tabsPadding: getComputedStyle(document.querySelector(".k2-tabbar")!).paddingBottom,
            };
          });
          expect(result.scrollWidth).toBeLessThanOrEqual(width);
          expect(result.documentScrolls).toBe(false);
          expect(result.paneScrolls).toBe(true);
          // The page's actions stay in the frame's head at every width; a bare page has its own head.
          if (variant === "framed") expect(result.actions?.width).toBeGreaterThan(0);
          expect(Math.round(result.frame!.height)).toBe(width < 768 ? 844 : 900);
          // The page's head starts below the status bar and the notch.
          expect(result.head!.top).toBeGreaterThanOrEqual(width < 768 ? insets.top : 0);
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

  test("on its side, the phone keeps the page and the tab bar clear of the notch and the home indicator", async () => {
    const page = await open("/pwa/inventory", 667, "v2.css", { height: 375, sides: landscape });
    try {
      const result = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON() as DOMRect;
        return {
          main: box(".pwa-v2-main"),
          tabs: box(".k2-tabbar"),
          scrollWidth: document.documentElement.scrollWidth,
          documentScrolls: document.scrollingElement!.scrollHeight > innerHeight,
        };
      });
      expect(result.scrollWidth).toBeLessThanOrEqual(667);
      expect(result.documentScrolls).toBe(false);
      for (const place of [result.main, result.tabs]) {
        expect(place.left).toBeGreaterThanOrEqual(landscape.left);
        expect(place.right).toBeLessThanOrEqual(667 - landscape.right);
      }
      expect(Math.round(result.tabs.bottom)).toBe(375);
      expect(result.tabs.height).toBe(1 + 56 + landscape.bottom);
    } finally {
      await page.close();
    }
  }, 60_000);

  for (const width of [390, 1440])
    test(`beside a Core from before the v2 frame, the page shows in the v1 frame at ${width} px, inside the window`, async () => {
      const page = await open("/pwa/inventory", width, "older global.css");
      try {
        const result = await page.evaluate(() => {
          const box = (selector: string) => {
            const element = document.querySelector(selector);
            return element && element.getClientRects().length > 0 ? (element.getBoundingClientRect().toJSON() as DOMRect) : undefined;
          };
          const content = document.querySelector<HTMLElement>(".k2b-mobile-shell__body")!;
          return {
            v2Frame: document.querySelector(".pwa-v2") !== null,
            content: box(".k2b-mobile-shell .k2-ui[data-ui='v2']"),
            rows: document.querySelectorAll(".k2b-mobile-shell .k2-ui [data-k2-part='Row']").length,
            tabs: box(".k2b-tab-bar"),
            scrollWidth: document.documentElement.scrollWidth,
            documentScrolls: document.scrollingElement!.scrollHeight > innerHeight,
            contentScrolls: content.scrollHeight > content.clientHeight,
          };
        });
        expect(result.v2Frame).toBe(false);
        expect(result.rows).toBe(24);
        expect(result.content!.width).toBeGreaterThan(200);
        expect(result.scrollWidth).toBeLessThanOrEqual(width);
        expect(result.documentScrolls).toBe(false);
        expect(result.contentScrolls).toBe(true);
        if (width < 768) expect(Math.round(result.tabs!.bottom)).toBe(844);
        else expect(result.tabs).toBeUndefined();
        const outline = await describeV2Page(page, ".k2b-mobile-shell .k2-ui[data-ui='v2']");
        expect(outline.includes("Problems (") ? outline : "").toBe("");
      } finally {
        await page.close();
      }
    }, 60_000);

  test("before the page comes alive, a notice already stands above the tab bar, and above the home indicator on a screen", async () => {
    // what the runtime's island shows; the server's page holds the stack, empty
    const notice =
      '<div class="k2-notice" data-k2-part="Notice" data-tone="warn" role="note"><i class="ti ti-wifi-off k2-icon"></i><span class="k2-notice-text">Offline</span></div>';
    for (const [path, above] of [
      ["/pwa/inventory", "bar"],
      ["/pwa/inventory/screen", "home indicator"],
    ] as const) {
      const page = await open(path, 390, "v2.css");
      try {
        const result = await page.evaluate((markup) => {
          const stack = document.querySelector("[data-k2-part='NoticeStack']")!;
          stack.innerHTML = markup;
          const bar = document.querySelector(".k2-tabbar");
          return {
            stack: stack.getBoundingClientRect().bottom,
            bar: bar && bar.getClientRects().length > 0 ? bar.getBoundingClientRect().top : undefined,
          };
        }, notice);
        if (above === "bar") expect(Math.round(result.stack)).toBe(Math.round(result.bar! - 12));
        else {
          expect(result.bar).toBeUndefined();
          expect(Math.round(result.stack)).toBe(844 - insets.bottom - 12);
        }
      } finally {
        await page.close();
      }
    }
  }, 60_000);

  test("a screen page has no tab bar and keeps clear of the home indicator, also when it becomes one in place", async () => {
    const measure = (page: Page) =>
      page.evaluate(() => ({
        tabs: document.querySelector(".k2-tabbar")?.getClientRects().length ?? 0,
        main: Math.round(document.querySelector(".pwa-v2-main")!.getBoundingClientRect().bottom),
      }));
    const screen = await open("/pwa/inventory/screen", 390, "v2.css");
    const page = await open("/pwa/inventory", 390, "v2.css");
    try {
      expect(await measure(screen)).toEqual({ tabs: 0, main: 844 - insets.bottom });
      expect((await measure(page)).tabs).toBe(1);
      // what `setPwaScreen` does in place, and back
      await page.evaluate(() => {
        document.querySelector(".pwa-v2")!.toggleAttribute("data-screen", true);
        document.querySelector(".k2-tabbar")!.toggleAttribute("hidden", true);
      });
      expect(await measure(page)).toEqual({ tabs: 0, main: 844 - insets.bottom });
      await page.evaluate(() => {
        document.querySelector(".pwa-v2")!.toggleAttribute("data-screen", false);
        document.querySelector(".k2-tabbar")!.toggleAttribute("hidden", false);
      });
      expect((await measure(page)).tabs).toBe(1);
    } finally {
      await screen.close();
      await page.close();
    }
  }, 60_000);

  for (const theme of ["light", "dark"] as const)
    test(`on the phone the status bar, the notch and the head are one colour (${theme})`, async () => {
      const page = await open("/pwa/inventory", 390, "v2.css", { theme });
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
            // the head stands on the workspace's surface
            head: getComputedStyle(document.querySelector(".pwa-v2-main [data-k2-workspace]")!).backgroundColor,
            colorScheme: getComputedStyle(document.documentElement).colorScheme,
          };
        });
        const rgb = (hex: string) => `rgb(${[1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)).join(", ")})`;
        // the constant names v2's surface: a change of either fails here
        const head = rgb(PWA_V2_HEAD_COLORS[theme]);
        expect(result).toEqual({ themeColor: head, html: head, frame: head, head, colorScheme: theme });
      } finally {
        await page.close();
      }
    }, 60_000);
});
