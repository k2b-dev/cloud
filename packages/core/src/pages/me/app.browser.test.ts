import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PwaDeviceView, User } from "@k2b/cloud/contracts";
import { DEFAULT_ACCOUNT_CATEGORY_POLICY } from "@k2b/cloud/contracts";
import { defaultRailPreferences } from "@k2b/cloud/contracts/rail-preferences";
import * as server from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { railPreferences } from "@k2b/cloud/services/rail-preferences";
import * as cloudSsr from "@k2b/cloud/ssr";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import { type Browser, chromium } from "playwright";
import { createComponent, type JSX } from "solid-js";

// `/me/app` must read like the other account tabs: one frame, flat sections, no overflow on a phone.
const root = mkdtempSync(join(tmpdir(), "core-account-app-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const appPage = (await import("./app.page")).default;
const { buildFontAssets } = await import("../../../scripts/font-assets");
const { buildTablerIconAssets } = await import("../../../scripts/tabler-assets");
const publicDir = join(root, "public");
const origin = "https://cloud.example.test";
const CORE_CANVAS =
  "--app-accent:#0284c7;--app-canvas-from:#38bdf8;--app-canvas-via:#ffffff;--app-canvas-to:#60a5fa;--app-canvas-angle:135deg;--app-canvas-strength:20%;--app-canvas-dark-strength:10%";

/** Invented demo account and phones. */
const user: User = {
  id: "00000000-0000-4000-8000-000000000042",
  uid: "jbeispiel",
  roles: ["local", "user"],
  provider: "local",
  profile: "user",
  givenname: "Jonas",
  sn: "Beispiel",
  displayName: "Jonas Beispiel",
  mail: "jonas.beispiel@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const phones: PwaDeviceView[] = [
  {
    id: "00000000-0000-4000-8000-000000000501",
    name: "iPhone",
    platform: "ios",
    createdAt: "2026-09-01T10:00:00.000Z",
    lastUsedAt: "2026-09-29T10:00:00.000Z",
    current: false,
  },
  {
    id: "00000000-0000-4000-8000-000000000502",
    name: "Android",
    platform: "android",
    createdAt: "2026-09-12T10:00:00.000Z",
    lastUsedAt: "2026-09-30T10:00:00.000Z",
    current: true,
  },
];
const shell = { id: "pwa", name: "Mobile app", icon: "ti ti-device-mobile", description: "", routes: ["/pwa", "/public/pwa"] };

let devices: PwaDeviceView[] = phones;
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  devices = phones;
  spies.push(
    spyOn(cloudSsr, "Layout").mockImplementation(((props: { c: Parameters<typeof server.getLocale>[0]; children: JSX.Element }) =>
      createComponent(LocaleProvider, {
        locale: server.getLocale(props.c),
        get children() {
          return props.children;
        },
      })) as never),
    spyOn(services, "readAccountCategoryPolicy").mockResolvedValue(DEFAULT_ACCOUNT_CATEGORY_POLICY),
    spyOn(services.coreSettings, "get").mockImplementation(async (key) => (key === "app.name" ? "Cloud" : undefined) as never),
    spyOn(services.pwaDevices, "list").mockImplementation(async () => devices),
    // The page shell's own reads.
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
let css: string;
beforeAll(async () => {
  const styles = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss].join("\n");
  await buildFontAssets(publicDir);
  await buildTablerIconAssets(publicDir);
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const request = (apps: (typeof shell)[]) =>
  new Hono()
    .use("*", async (c, next) => {
      c.set("user" as never, user as never);
      c.set("runtime" as never, { apps } as never);
      await next();
    })
    .get("/me/app", ...appPage)
    .request(`${origin}/me/app`, { headers: { Cookie: "cloud.locale=en" } });

type View = { width: number; height: number; touch: boolean };
const phone: View = { width: 390, height: 844, touch: true };
const desktop: View = { width: 1440, height: 900, touch: false };

const open = async (view: View, dark = false) => {
  const response = await request([shell]);
  expect(response.status).toBe(200);
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(await response.text())![1]!;
  const tab = await browser.newPage({
    javaScriptEnabled: false,
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
  });
  await tab.route(`${origin}/public/**`, (route) => route.fulfill({ path: join(root, new URL(route.request().url()).pathname) }));
  await tab.setContent(
    `<!doctype html><html lang="en" class="${dark ? "dark" : "light"}"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<link rel="stylesheet" href="${origin}/public/fonts.css"><link rel="stylesheet" href="${origin}/public/tabler-icons.css"><style>${css}</style></head>` +
      `<body class="k2b-ui"><div class="cloud-app-canvas relative flex min-h-screen w-full" style="${CORE_CANVAS}" data-app-id="core">` +
      `<div class="layout-shell-content flex min-h-0 min-w-0 flex-1 flex-col"><main class="layout-content-main min-h-0 min-w-0 flex-1">` +
      `${body}</main></div></div></body></html>`,
  );
  await tab.evaluate(() => document.fonts.ready);
  return tab;
};

describe("/me/app in a browser", () => {
  test("is absent without the mobile app and framed never", async () => {
    expect((await request([])).status).toBe(404);
    const response = await request([shell]);
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("draws one flat frame, marks this phone and fits a phone in light and dark", async () => {
    for (const view of [phone, desktop])
      for (const dark of [false, true]) {
        const tab = await open(view, dark);
        try {
          const result = await tab.evaluate(() => {
            const main = document.querySelector("main")!;
            const panel = main.querySelector(".account-page")!;
            const visible = (value: string) => value !== "none" && !/rgba\(.*,\s*0\)$/.test(value) && value !== "transparent";
            const frames = Array.from(main.querySelectorAll<HTMLElement>("section, article, div, ul, header, nav"))
              .filter(
                (element) => element.checkVisibility() && !element.closest("button, a, table, .tag, .k2b-input-shell, .k2b-notice-card"),
              )
              .filter((element) => {
                const style = getComputedStyle(element);
                const border =
                  Number.parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== "none" && visible(style.borderTopColor);
                return border || visible(style.boxShadow);
              })
              .map((element) => element.className.toString().split(" ").slice(0, 3).join(" "));
            const install = Array.from(main.querySelectorAll<HTMLAnchorElement>('a[href="/pwa/"]')).filter((link) =>
              link.checkVisibility(),
            );
            return {
              frames,
              current: main.querySelector('nav [aria-current="page"]')?.getAttribute("href"),
              thisPhone: panel.textContent?.includes("This phone"),
              install: install.length,
              overflow: document.documentElement.scrollWidth - window.innerWidth,
            };
          });
          const { overflow, ...layout } = result;
          expect({ width: view.width, dark, ...layout }).toEqual({
            width: view.width,
            dark,
            frames: ["k2b-paper account-page flex"],
            current: "/me/app",
            thisPhone: true,
            // Installing happens on the phone; computers get the camera hint instead.
            install: view.touch ? 1 : 0,
          });
          expect(overflow).toBeLessThanOrEqual(0);
        } finally {
          await tab.close();
        }
      }
  }, 120_000);
});
