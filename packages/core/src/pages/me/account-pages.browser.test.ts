import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { User } from "@k2b/cloud/contracts";
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

// Whether the account pages draw one frame or nested ones, and whether switching tabs moves
// anything, is decided by the cascade of Tailwind, Cloud and @k2b/ui styles, which only a
// real engine resolves.
const root = mkdtempSync(join(tmpdir(), "core-account-pages-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

// Core's canvas paint. The tests render the pages in a stand-in for the page shell without
// the rail and header, which have tests of their own, and measure what the pages put into it.
const CORE_CANVAS =
  "--app-accent:#0284c7;--app-canvas-from:#38bdf8;--app-canvas-via:#ffffff;--app-canvas-to:#60a5fa;--app-canvas-angle:135deg;--app-canvas-strength:20%;--app-canvas-dark-strength:10%";

const pages = {
  "/me": (await import("./page")).default,
  "/me/security": (await import("./security.page")).default,
  "/me/access": (await import("./access.page")).default,
  "/me/notifications": (await import("./notifications.page")).default,
  "/me/notifications/history": (await import("./notification-history.page")).default,
  "/me/developer": (await import("./developer.page")).default,
} as const;
type Path = keyof typeof pages;
const tabs: Path[] = ["/me", "/me/security", "/me/access", "/me/notifications", "/me/developer"];
const { buildFontAssets } = await import("../../../scripts/font-assets");
const { buildTablerIconAssets } = await import("../../../scripts/tabler-assets");
const publicDir = join(root, "public");
const origin = "https://cloud.example.test";

/** Invented demo account. */
const localUser: User = {
  id: "00000000-0000-4000-8000-000000000042",
  uid: "jbeispiel",
  roles: ["local", "user", "admin", "group-manager"],
  provider: "local",
  profile: "user",
  givenname: "Jonas",
  sn: "Beispiel",
  displayName: "Jonas Beispiel",
  mail: "jonas.beispiel@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: "2027-03-31T00:00:00.000Z",
  lastLoginLocal: null,
  memberofGroup: ["team-design", "team-events", "summer-party-2026"],
  memberofGroupIds: [],
  manages: ["team-events"],
  managesGroupIds: [],
};
const now = "2026-09-30T10:00:00.000Z";

/** The same person as a FreeIPA account with a long name, which fills the profile actions. */
const ipaUser: User = {
  ...localUser,
  provider: "ipa",
  roles: ["user"],
  displayName: "Maximiliane Sonnenschein-Beispielhausen",
  ipa: {
    uidNumber: 10_042,
    phone: "+49 30 1234567",
    employeeType: null,
    mobile: null,
    address: { street: "Musterweg 1", postalCode: "10115", city: "Berlin", state: null },
    passwordExpires: null,
    lastLoginIpa: null,
    syncedAt: now,
    sshPublicKeys: [],
    sshFingerprints: [],
  },
};

/** Who is signed in and what the installation offers; each test starts from the local account. */
let user: User = localUser;
let freeIpaEnabled = false;
let requestsEnabled = false;

const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  user = localUser;
  freeIpaEnabled = false;
  requestsEnabled = false;
  spies.push(
    spyOn(cloudSsr, "Layout").mockImplementation(((props: { c: Parameters<typeof server.getLocale>[0]; children: JSX.Element }) =>
      createComponent(LocaleProvider, {
        locale: server.getLocale(props.c),
        get children() {
          return props.children;
        },
      })) as never),
    spyOn(services, "readAccountCategoryPolicy").mockResolvedValue(DEFAULT_ACCOUNT_CATEGORY_POLICY),
    spyOn(services.coreSettings, "get").mockImplementation(
      async (key) =>
        (key === "app.name" ? "Cloud" : key === "app.url" ? origin : key === "freeipa.enable" ? freeIpaEnabled : undefined) as never,
    ),
    spyOn(services.accountsAppService.accountRequest, "getPendingForUser").mockResolvedValue(null as never),
    spyOn(services.accountsAppService.accountRequest, "isEnabled").mockImplementation(async () => requestsEnabled),
    spyOn(services.serviceAccountCredentials, "listForDelegatedUser").mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000101",
        serviceAccountId: "00000000-0000-4000-8000-000000000102",
        name: "Laptop scripts",
        kind: "api_token",
        status: "active",
        tokenPrefix: "cld_7f3a",
        scopes: [],
        expiresAt: "2026-12-31T00:00:00.000Z",
        lastUsedAt: now,
        createdBy: null,
        createdAt: now,
        revokedAt: null,
        revokedBy: null,
      },
    ] as never),
    spyOn(services.webauthn, "listForUser").mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000201",
        userId: localUser.id,
        name: "Work laptop",
        transports: ["internal"],
        deviceType: "multiDevice",
        backedUp: true,
        createdAt: now,
        lastUsedAt: now,
      },
    ]),
    spyOn(services.audit, "listSelfServiceActivity").mockResolvedValue({
      items: [
        {
          id: 1,
          createdAt: now,
          action: "webauthn_credential.authenticate",
          label: "Signed in with a passkey",
          outcome: "allowed",
          context: null,
        },
        { id: 2, createdAt: now, action: "accounts.user.update", label: "Profile updated", outcome: "allowed", context: "Display name" },
      ],
    } as never),
    spyOn(services.notifications.user.preferences, "list").mockResolvedValue({
      availableChannels: ["inbox", "email"],
      definitions: [
        {
          id: "core.account-expiry",
          appId: "core",
          kind: "account-expiry",
          label: "Account expiry",
          description: "Before your account expires.",
          recommendedChannels: ["inbox", "email"],
          requiredChannels: [],
          selectedChannels: ["inbox", "email"],
          effectiveChannels: ["inbox", "email"],
          customized: false,
        },
      ],
    }),
    spyOn(services.notifications.user.history, "list").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 25, totalPages: 0 }),
    spyOn(services.notifications.user.quiet, "get").mockResolvedValue({
      doNotDisturbUntil: null,
      quietHours: { timeZone: "Europe/Berlin", periods: [{ days: [1, 2, 3, 4, 5], start: "22:00", end: "07:00" }] },
      state: { active: false, reason: null, until: null, nextStart: null },
    }),
    spyOn(services.appApproval, "config").mockResolvedValue({
      issuer: origin,
      appOrigin: "https://auth.example.test",
      enabled: true,
      adminPairing: false,
    }),
    spyOn(services.appApproval, "listDevices").mockResolvedValue({
      items: [
        {
          id: "00000000-0000-4000-8000-000000000301",
          name: "Phone",
          createdAt: now,
          lastUsedAt: now,
          revokedAt: null,
          assisted: false,
        },
      ],
      nextCursor: null,
    }),
    spyOn(server.auth.session, "getToken").mockReturnValue("demo-session" as never),
    spyOn(server.auth.session, "authenticateRequest").mockImplementation(async () => ({ user, data: { sid: "demo-session" } }) as never),
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
  // As the page template does: the layer order first, then Core's stylesheet, then the global one.
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

/** The server-rendered content of one account page. */
const content = async (path: Path, locale: "en" | "de") => {
  const app = new Hono()
    .use("*", async (c, next) => {
      c.set("user" as never, user as never);
      c.set("runtime" as never, { apps: [] } as never);
      await next();
    })
    .get(path, ...pages[path]);
  const response = await app.request(`${origin}${path}`, { headers: { Cookie: `cloud.locale=${locale}` } });
  expect(response.status).toBe(200);
  return /<body[^>]*>([\s\S]*)<\/body>/.exec(await response.text())![1]!;
};

type View = { width: number; height: number; touch: boolean };
const desktop: View = { width: 1440, height: 900, touch: false };
const phone: View = { width: 390, height: 844, touch: true };
// The WCAG reflow width.
const narrowPhone: View = { width: 320, height: 640, touch: true };

/** A tab with the server-rendered page on Core's canvas, before any island hydrates; the caller closes it. */
const open = async (view: View, path: Path, locale: "en" | "de", dark = false) => {
  const tab = await browser.newPage({
    javaScriptEnabled: false,
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
  });
  await tab.route(`${origin}/public/**`, (route) => route.fulfill({ path: join(root, new URL(route.request().url()).pathname) }));
  await tab.setContent(
    `<!doctype html><html lang="${locale}" class="${dark ? "dark" : "light"}"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<link rel="stylesheet" href="${origin}/public/fonts.css"><link rel="stylesheet" href="${origin}/public/tabler-icons.css"><style>${css}</style></head>` +
      `<body class="k2b-ui"><div class="cloud-app-canvas relative flex min-h-dvh w-full" style="${CORE_CANVAS}" data-app-id="core">` +
      `<div class="layout-shell-content flex min-h-0 min-w-0 flex-1 flex-col"><main class="layout-content-main min-h-0 min-w-0 flex-1">` +
      `${await content(path, locale)}</main></div></div></body></html>`,
  );
  await tab.evaluate(() => document.fonts.ready);
  return tab;
};

/** Where the avatar, the tabs and the content sit, which frames the page draws, and whether it overflows. */
const measure = async (view: View, path: Path, locale: "en" | "de", dark = false) => {
  const tab = await open(view, path, locale, dark);
  try {
    return await tab.evaluate(() => {
      const main = document.querySelector("main")!;
      const nav = main.querySelector("nav")!;
      const panel = main.querySelector(".account-page")!;
      const visible = (value: string) => value !== "none" && !/rgba\(.*,\s*0\)$/.test(value) && value !== "transparent";
      // Every block that paints a border or a shadow: a frame. Controls, tags, table cells and
      // the notices' forced-colours border are content, not frames.
      const frames = Array.from(main.querySelectorAll<HTMLElement>("section, article, div, ul, header, nav"))
        .filter((element) => element.checkVisibility() && !element.closest("button, a, table, .tag, .k2b-input-shell, .k2b-notice-card"))
        .filter((element) => {
          const style = getComputedStyle(element);
          const border = Number.parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== "none" && visible(style.borderTopColor);
          return border || visible(style.boxShadow);
        })
        .map((element) => element.className.toString().split(" ").slice(0, 3).join(" "));
      const heading = panel.querySelector("h2")!;
      const headingBox = heading.getBoundingClientRect();
      const avatar = main.querySelector("header .k2b-avatar")!.getBoundingClientRect();
      return {
        avatar: `${Math.round(avatar.left)},${Math.round(avatar.top)} ${Math.round(avatar.width)}x${Math.round(avatar.height)}`,
        navTop: Math.round(nav.getBoundingClientRect().top),
        panelTop: Math.round(panel.getBoundingClientRect().top),
        identityInFrame: !!main.querySelector("h1")!.closest(".paper, .k2b-paper"),
        frames,
        current: nav.querySelector('[aria-current="page"]')?.getAttribute("href"),
        pageHeading: { text: heading.textContent, width: headingBox.width, height: headingBox.height },
        sectionFrames: Array.from(panel.querySelectorAll<HTMLElement>(".k2b-settings-section")).map((section) => {
          const style = getComputedStyle(section);
          return `${style.borderTopWidth} ${style.backgroundColor}`;
        }),
        // How far each section's first content sits below its header, and whether its actions stay inside the panel.
        sectionSpacing: Array.from(panel.querySelectorAll<HTMLElement>(".k2b-settings-section")).flatMap((section) => {
          const header = section.querySelector(".k2b-settings-section__header")!.getBoundingClientRect();
          const first = Array.from(section.querySelectorAll<HTMLElement>(".k2b-settings-section__body *")).find(
            (element) => element.checkVisibility() && element.getBoundingClientRect().height > 0,
          );
          return first ? [Math.round(first.getBoundingClientRect().top - header.bottom)] : [];
        }),
        actionsPastPanel: Math.max(
          0,
          ...Array.from(panel.querySelectorAll(".k2b-settings-section__actions")).map(
            (actions) => actions.getBoundingClientRect().right - panel.getBoundingClientRect().right,
          ),
        ),
        // The screen's width: Chromium's phone emulation widens `innerWidth` to wide content, as a page zoomed out.
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
  } finally {
    await tab.close();
  }
};

describe("account pages in a browser", () => {
  test("draw one frame: the identity and tabs sit on the canvas, the sections inside it are flat", async () => {
    for (const view of [desktop, phone])
      for (const dark of [false, true])
        for (const path of Object.keys(pages) as Path[]) {
          const result = await measure(view, path, "en", dark);
          const label = `${path} ${view.width}px ${dark ? "dark" : "light"}`;
          expect({ label, identityInFrame: result.identityInFrame, frames: result.frames }).toEqual({
            label,
            identityInFrame: false,
            frames: ["k2b-paper account-page flex"],
          });
          for (const frame of result.sectionFrames) expect(frame).toBe("0px rgba(0, 0, 0, 0)");
          expect(result.overflow).toBeLessThanOrEqual(0);
        }
  }, 120_000);

  test("keep the avatar, the tabs and the content in place when switching tabs, in English and German", async () => {
    for (const view of [desktop, phone])
      for (const locale of ["en", "de"] as const) {
        const results = [];
        for (const path of tabs) results.push({ path, ...(await measure(view, path, locale)) });
        for (const result of results) {
          expect(result.current).toBe(result.path);
          expect({ path: result.path, avatar: result.avatar, navTop: result.navTop, panelTop: result.panelTop }).toEqual({
            path: result.path,
            avatar: results[0]!.avatar,
            navTop: results[0]!.navTop,
            panelTop: results[0]!.panelTop,
          });
          expect(result.overflow).toBeLessThanOrEqual(0);
        }
      }
  }, 120_000);

  test("open every section's content at the same distance below its header, islands included", async () => {
    requestsEnabled = true;
    freeIpaEnabled = true;
    for (const view of [desktop, phone])
      for (const path of Object.keys(pages) as Path[]) {
        const result = await measure(view, path, "en");
        expect({ path, width: view.width, spacing: result.sectionSpacing.filter((gap) => gap !== 12) }).toEqual({
          path,
          width: view.width,
          spacing: [],
        });
      }
    // The FreeIPA account request is offered on /me/access in this setup.
    expect((await measure(phone, "/me/access", "en")).sectionSpacing.length).toBe(3);
  }, 120_000);

  test("keep a FreeIPA account's profile actions inside the panel down to 320px, in German", async () => {
    user = ipaUser;
    freeIpaEnabled = true;
    for (const view of [phone, narrowPhone])
      for (const path of tabs) {
        const result = await measure(view, path, "de");
        expect({ path, width: view.width, past: result.actionsPastPanel, overflow: result.overflow }).toEqual({
          path,
          width: view.width,
          past: 0,
          overflow: 0,
        });
      }
  }, 120_000);

  test("reserve the browser notification button's height before the island hydrates", async () => {
    const tab = await open(phone, "/me/notifications", "en");
    try {
      const heights = await tab.evaluate(() => {
        const section = Array.from(document.querySelectorAll(".k2b-settings-section")).find((candidate) =>
          candidate.querySelector("h2")?.textContent?.includes("Browser notifications"),
        )!;
        const row = section.querySelector<HTMLElement>(".k2b-settings-section__actions > span")!;
        const before = section.getBoundingClientRect().height;
        // What hydration adds: a small button beside the status.
        row.insertAdjacentHTML(
          "beforeend",
          '<button type="button" class="k2b-button" data-size="sm" data-variant="primary"><i class="ti ti-bell-plus"></i>Enable</button>',
        );
        return { before, after: section.getBoundingClientRect().height };
      });
      expect(heights.after).toBe(heights.before);
    } finally {
      await tab.close();
    }
  }, 30_000);

  test("keep the quiet time section still when its status or a period's error changes", async () => {
    // What the island shows later: a long status instead of "Off", and the error of a period without days. The
    // description shares its lines with whatever stands beside the heading, so the widths that move differ.
    const change = () =>
      Array.from(document.querySelectorAll(".k2b-settings-section"))
        .filter((section) => section.querySelector("h2")?.textContent?.includes("Do not disturb"))
        .map((section) => {
          const field = (label: string) =>
            Array.from(section.querySelectorAll(".k2b-field")).find(
              (candidate) => candidate.querySelector(".k2b-field__label")?.textContent?.trim() === label,
            )!;
          const top = (element: Element) => Math.round(element.getBoundingClientRect().top);
          const measure = () => ({
            body: top(section.querySelector(".k2b-settings-section__body")!),
            from: top(field("From")),
            remove: top(section.querySelector('[aria-label="Remove quiet hours"]')!),
          });
          const label = section.querySelector(".k2b-status-badge__label")!;
          const before = measure();
          const off = label.textContent;
          label.textContent = "Quiet hours until 10/12/2026, 11:30 PM";
          field("Days").insertAdjacentHTML("beforeend", '<p class="k2b-field__error" data-test-error>Choose at least one day.</p>');
          const after = measure();
          label.textContent = off;
          section.querySelector("[data-test-error]")!.remove();
          return { before, after };
        })[0]!;
    for (const view of [desktop, phone]) {
      const tab = await open(view, "/me/notifications", "en");
      try {
        // On a phone the times sit below the days, so the error moves them like any field below it.
        const widths = view === phone ? [phone.width, narrowPhone.width] : [1440, 1280, 1152, 1024, 900, 768];
        const still = view === phone ? ["body"] : ["body", "from", "remove"];
        const pick = (at: Record<string, number>) => Object.fromEntries(still.map((key) => [key, at[key]]));
        for (const width of widths) {
          await tab.setViewportSize({ width, height: view.height });
          const { before, after } = await tab.evaluate(change);
          expect({ width, ...pick(after) }).toEqual({ width, ...pick(before) });
        }
      } finally {
        await tab.close();
      }
    }
  }, 60_000);

  test("let a long name wrap instead of cutting it off on a phone", async () => {
    user = ipaUser;
    const tab = await open(phone, "/me", "en");
    try {
      const name = await tab.evaluate(() => {
        const heading = document.querySelector("main h1")!;
        return { clipped: heading.scrollWidth > heading.clientWidth, lines: Math.round(heading.getBoundingClientRect().height / 25) };
      });
      expect(name).toEqual({ clipped: false, lines: 2 });
    } finally {
      await tab.close();
    }
  }, 30_000);

  test("warn about the account expiry only when it is close", async () => {
    const tone = async (days: number) => {
      user = { ...localUser, accountExpires: new Date(Date.now() + days * 86_400_000).toISOString() };
      return /class="k2b-notice-card[^"]*"[^>]*data-tone="(\w+)"/.exec(await content("/me", "en"))?.[1];
    };
    expect(await tone(120)).toBe("info");
    expect(await tone(10)).toBe("warning");
    expect(await tone(-1)).toBe("danger");
  }, 30_000);

  test("announce the section heading the tabs already show only to assistive technology", async () => {
    const result = await measure(desktop, "/me/access", "de");
    expect(result.pageHeading.text).toBe("Gruppen und Zugriff");
    expect(result.pageHeading.width).toBeLessThanOrEqual(1);
    expect(result.pageHeading.height).toBeLessThanOrEqual(1);
  }, 30_000);
});
