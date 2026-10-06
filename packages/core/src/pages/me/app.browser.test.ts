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
import type { Browser } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { launchBrowser } from "../../../../ui/test/browser";
import { accountMessages } from "./messages";

// `/me/app` must read like the other account tabs: one frame, flat sections, one type scale, no overflow on a phone.
const root = mkdtempSync(join(tmpdir(), "core-account-app-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const appPage = (await import("./app.page")).default;
const ui = resolve(import.meta.dir, "../../../../ui");
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

/** The real island, compiled for the browser with Solid's DOM output as Cloud's client build does. */
const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "AppDevices.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-pairing-dialog-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Pairing dialog harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let css: string;
let harness: string;
beforeAll(async () => {
  harness = await buildHarness();
  const styles = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss].join("\n");
  await buildFontAssets(publicDir);
  await buildTablerIconAssets(publicDir);
  browser = await launchBrowser();
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
const head = (lang: string, dark = false) =>
  // Playwright's WebKit ignores the charset of a routed response, so the page names it, as a Cloud page does.
  `<!doctype html><html lang="${lang}" class="${dark ? "dark" : "light"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="${origin}/public/fonts.css"><link rel="stylesheet" href="${origin}/public/tabler-icons.css"><style>${css}</style></head>`;

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
    head("en", dark) +
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
            const frames = Array.from(main.querySelectorAll<HTMLElement>("section, article, div, ul, li, p, header, nav"))
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
            // One type scale: every visible text run in the frame outside controls, by size, weight and color.
            const styles = new Set(
              Array.from(panel.querySelectorAll<HTMLElement>("*"))
                .filter(
                  (element) =>
                    element.checkVisibility() &&
                    !element.closest("button, a, .sr-only") &&
                    [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim()),
                )
                .map((element) => {
                  const style = getComputedStyle(element);
                  return `${style.fontSize} ${style.fontWeight} ${style.color}`;
                }),
            );
            return {
              frames,
              current: main.querySelector('nav [aria-current="page"]')?.getAttribute("href"),
              thisPhone: panel.textContent?.includes("This phone"),
              styles: styles.size,
              pair: Array.from(panel.querySelectorAll("button")).filter((button) => button.textContent?.trim() === "Pair a phone").length,
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
            // The list heading, phone names, and the description sharing one secondary style with the details.
            styles: 3,
            pair: 1,
          });
          expect(overflow).toBeLessThanOrEqual(0);
        } finally {
          await tab.close();
        }
      }
  }, 120_000);
});

describe("the pairing dialog in a browser", () => {
  const PAIRING = "00000000-0000-4000-8000-000000000601";
  const SECRET = `${"A".repeat(42)}w`;
  const api = "/api/auth/pwa/v1/pairings";

  // One frame for the whole pairing: no step scrolls its body or changes the frame's height, in English and German,
  // on a computer, in a narrow window with a mouse, and on phones, which get the link instead of the QR code.
  test("fits every step without scrolling and keeps one height", async () => {
    const results = [];
    for (const view of [desktop, { ...phone, touch: false }, phone, { width: 320, height: 568, touch: true }])
      for (const lang of ["en", "de"] as const) {
        const t = accountMessages.resolve([lang]).t;
        let release = () => {};
        const started = new Promise<void>((resolve) => {
          release = resolve;
        });
        let confirmations = 0;
        const context = await browser.newContext({
          viewport: { width: view.width, height: view.height },
          deviceScaleFactor: 1,
          isMobile: view.touch,
          hasTouch: view.touch,
          reducedMotion: "reduce",
        });
        const tab = await context.newPage();
        await tab.route(`${origin}/**`, async (route) => {
          const { pathname } = new URL(route.request().url());
          const post = route.request().method() === "POST";
          if (pathname === "/me/app")
            return route.fulfill({
              contentType: "text/html; charset=utf-8",
              body: `${head(lang)}<body class="k2b-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`,
            });
          if (pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
          if (pathname.startsWith("/public/")) return route.fulfill({ path: join(root, pathname) });
          if (post && pathname === api) {
            // Held, so the test sees the step that prepares the pairing.
            await started;
            return route.fulfill({
              status: 201,
              json: {
                id: PAIRING,
                secret: SECRET,
                claimUntil: new Date(Date.now() + 300_000).toISOString(),
                expiresAt: new Date(Date.now() + 600_000).toISOString(),
              },
            });
          }
          if (!post && pathname === `${api}/${PAIRING}`)
            return route.fulfill({
              json: {
                state: "claimed",
                claimUntil: new Date(Date.now() + 300_000).toISOString(),
                expiresAt: new Date(Date.now() + 600_000).toISOString(),
                device: { name: "Jonas' iPhone 15 Pro", platform: "ios" },
                attemptsLeft: 3 - confirmations,
              },
            });
          if (post && pathname === `${api}/${PAIRING}/confirm`) {
            // Three wrong codes: the third cancels the pairing.
            confirmations += 1;
            return confirmations < 3
              ? route.fulfill({
                  status: 409,
                  json: { code: "WRONG_CODE", message: "The code does not match.", attemptsLeft: 3 - confirmations },
                })
              : route.fulfill({ status: 410, json: { code: "EXPIRED", message: "This pairing has expired.", attemptsLeft: 0 } });
          }
          return route.fulfill({ status: 404 });
        });
        try {
          const steps: Record<string, { height: number; overflow: number }> = {};
          const measure = async (step: string, text: string) => {
            await tab.locator("dialog").getByText(text).first().waitFor();
            await tab.evaluate(() => document.fonts.ready);
            steps[step] = await tab.evaluate(() => {
              const dialog = document.querySelector("dialog")!;
              const body = dialog.querySelector(".k2b-panel-dialog__body")!;
              return { height: dialog.getBoundingClientRect().height, overflow: body.scrollHeight - body.clientHeight };
            });
          };
          // Keys go to the focused element. Playwright sees the code step before the dialog's first frame, where the
          // dialog puts focus in the code, so each code waits for that focus.
          const enter = async (code: string) => {
            await tab.waitForFunction(() => document.activeElement?.matches(".k2b-pin-input__digit") ?? false);
            await tab.keyboard.type(code);
            await tab.keyboard.press("Enter");
          };
          await tab.goto(`${origin}/me/app`);
          await tab.getByRole("button", { name: t.pwaPair }).click();
          await measure("starting", t.pwaPreparing);
          release();
          await measure("link", view.touch ? t.pwaCopyOnPhone : t.pwaScanOrCopy);
          // The tab keeps the pairing; a reload resumes it and reads at once, and the phone has claimed it meanwhile.
          await tab.reload();
          await measure("code", t.pwaClaimed({ name: "Jonas' iPhone 15 Pro" }));
          await enter("111111");
          await measure("wrong code", t.pwaWrongCode({ count: 2 }));
          await enter("222222");
          await tab
            .locator("dialog")
            .getByText(t.pwaWrongCode({ count: 1 }))
            .waitFor();
          await enter("333333");
          await measure("too many wrong codes", t.pwaTooManyTries);
          results.push({
            width: view.width,
            touch: view.touch,
            lang,
            overflow: Object.entries(steps)
              .filter(([, step]) => step.overflow > 0)
              .map(([name, step]) => `${name} +${step.overflow}px`),
            heights: new Set(Object.values(steps).map((step) => step.height)).size,
          });
        } finally {
          await context.close();
        }
      }
    expect(results.filter((result) => result.overflow.length || result.heights !== 1)).toEqual([]);
  }, 120_000);
});
