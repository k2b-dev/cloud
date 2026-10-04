import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import { type Browser, chromium } from "playwright";
import { createComponent } from "solid-js";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import type { RuntimeAppMeta } from "../contracts/app";
import { PWA_CANVAS_COLORS } from "../contracts/pwa";
import type { User } from "../contracts/shared";
import { type AuthContext, auth } from "../server/middleware/auth";
import { announcements } from "../services/announcements";
import { session } from "../services/session";

// The status bar takes its colour from `theme-color` and the top layer, and only a real engine computes the
// cascade of the shared stylesheets, so the complete app document renders in Chromium at phone size.
const root = mkdtempSync(join(tmpdir(), "cloud-pwa-layout-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { defineApp } = await import("../_internal/define-app");
const { default: PwaLayout } = await import("./PwaLayout");
const { TextInput } = await import("@k2b/ui");

const { ssr } = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-box",
  description: "Invented test part",
  baseUrl: "http://inventory:3000",
  routes: ["/pwa/inventory"],
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
const apps: RuntimeAppMeta[] = [
  { id: "pwa", name: "Mobile app", icon: "ti ti-device-mobile", description: "", routes: ["/pwa"] },
  { id: "inventory", name: "Inventory", icon: "ti ti-box", description: "", routes: ["/pwa/inventory"], pwa: { href: "/pwa/inventory" } },
];

const spies = [
  stubRailSnapshot(),
  spyOn(session, "getToken").mockReturnValue("test-session"),
  spyOn(session, "authenticateRequest").mockResolvedValue({
    user,
    data: { userId: user.id, sid: "test", authEpoch: 0, kind: "app", expiresAt: "2099-01-01T00:00:00Z" },
  }),
  spyOn(announcements.active, "forState").mockResolvedValue({ banners: [], announcements: [], latestAnnouncementVersion: 0 }),
];

const server = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.set("runtime" as never, { apps } as never);
    await next();
  })
  .get(
    "/pwa/inventory",
    auth.requireRole("user", ssr.pwaAccess),
    ...ssr<AuthContext>(
      (c) => () =>
        createComponent(PwaLayout, {
          c,
          title: "Inventory",
          get children() {
            // Block-level fields stack, so the content is always taller than a phone screen.
            return Array.from({ length: 30 }, (_, index) =>
              createComponent(TextInput, { label: `Field ${index + 1}`, value: () => "", onValueChange: () => {} }),
            );
          },
        }),
    ),
  );

const origin = "https://cloud.example.test";
let browser: Browser;
let css: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  for (const spy of spies) spy.mockRestore();
});

const open = async (theme: "light" | "dark") => {
  const response = await server.request(`${origin}/pwa/inventory`, { headers: { Cookie: `pwa_session=test-session; theme=${theme}` } });
  expect(response.status).toBe(200);
  const document = await response.text();
  const page = await browser.newPage({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await page.route(`${origin}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/pwa/inventory") return route.fulfill({ contentType: "text/html", body: document });
    if (url.pathname === "/public/global.css") return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${origin}/pwa/inventory`);
  return page;
};

describe("PwaLayout in a phone browser", () => {
  for (const theme of ["light", "dark"] as const)
    test(`gives the status bar the page canvas and keeps the top edge free of fixed layers (${theme})`, async () => {
      const page = await open(theme);
      try {
        const result = await page.evaluate(() => {
          let topEdge: string | null = null;
          for (let element = document.elementFromPoint(innerWidth / 2, 4); element && !topEdge; element = element.parentElement) {
            const { position } = getComputedStyle(element);
            if (position === "fixed" || position === "sticky") topEdge = element.className;
          }
          const body = document.querySelector<HTMLElement>(".k2b-mobile-shell__body")!;
          const swatch = document.createElement("i");
          swatch.style.color = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content;
          document.body.append(swatch);
          const themeColor = getComputedStyle(swatch).color;
          swatch.remove();
          return {
            themeColor,
            html: getComputedStyle(document.documentElement).backgroundColor,
            body: getComputedStyle(document.body).backgroundColor,
            header: getComputedStyle(document.querySelector(".k2b-mobile-shell__header")!).backgroundColor,
            tabBar: getComputedStyle(document.querySelector(".k2b-tab-bar")!).position,
            documentScrolls: document.scrollingElement!.scrollHeight > innerHeight,
            contentScrolls: body.scrollHeight > body.clientHeight,
            touchAction: getComputedStyle(document.querySelector(".k2b-field")!).touchAction,
            inputFontSize: getComputedStyle(document.querySelector("input")!).fontSize,
            topEdge,
          };
        });
        const rgb = (hex: string) => `rgb(${[1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)).join(", ")})`;
        const canvas = rgb(PWA_CANVAS_COLORS[theme]);
        expect(result).toEqual({
          themeColor: canvas,
          html: canvas,
          body: canvas,
          header: canvas,
          tabBar: "static",
          documentScrolls: false,
          contentScrolls: true,
          touchAction: "pan-x pan-y",
          inputFontSize: "16px",
          topEdge: null,
        });
      } finally {
        await page.close();
      }
    }, 60_000);
});
