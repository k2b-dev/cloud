import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { User } from "@k2b/cloud/contracts";
import { DEFAULT_ACCOUNT_CATEGORY_POLICY } from "@k2b/cloud/contracts";
import { defaultRailPreferences } from "@k2b/cloud/contracts/rail-preferences";
import { defaultScreenPreferences } from "@k2b/cloud/contracts/screen-preferences";
import * as server from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { railPreferences } from "@k2b/cloud/services/rail-preferences";
import { screenPreferences } from "@k2b/cloud/services/screen-preferences";
import * as sharedWorkstation from "@k2b/cloud/services/session/shared-workstation";
import { appAppearanceStyle } from "@k2b/cloud/ssr/app-appearance";
import { LocaleProvider } from "@k2b/ui";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { launchBrowser } from "../../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

// The account pages on v2 as the server renders them, before any island hydrates: the v2 rules (outline and measured
// layout), no loading state in the first picture, and what the address keeps. Only a real engine lays them out.
const root = mkdtempSync(join(tmpdir(), "core-account-pages-browser-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

const cloudSsr = await import("@k2b/cloud/ssr");
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

// Core's canvas paint. The tests render the pages in a stand-in for the page shell without
// the rail and header, which have tests of their own, and measure what the pages put into it.
const CORE_CANVAS = appAppearanceStyle({
  accent: "#0284c7",
  background: { from: "#3b82f6", via: "#ffffff", to: "#60a5fa", angle: 135, strength: 20 },
});

const pages = {
  "/me": (await import("./page")).default,
  "/me/security": (await import("./security.page")).default,
  "/me/access": (await import("./access.page")).default,
  "/me/notifications": (await import("./notifications.page")).default,
  "/me/activity": (await import("./activity.page")).default,
} as const;
const { oldAccountAddresses } = await import("./old-addresses");
type Path = keyof typeof pages;
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
  setSystemTime(new Date(now));
  user = localUser;
  freeIpaEnabled = false;
  requestsEnabled = false;
  spies.push(
    spyOn(cloudSsr, "Layout").mockImplementation(((props: { c: Parameters<typeof server.getLocale>[0]; children: JSX.Element }) => {
      return createComponent(LocaleProvider, {
        locale: server.getLocale(props.c),
        get children() {
          return props.children;
        },
      });
    }) as never),
    spyOn(services, "readAccountCategoryPolicy").mockResolvedValue(DEFAULT_ACCOUNT_CATEGORY_POLICY),
    spyOn(services.coreSettings, "get").mockImplementation(
      async (key) =>
        (key === "app.name"
          ? "Cloud"
          : key === "app.url"
            ? origin
            : key === "freeipa.enable"
              ? freeIpaEnabled
              : key === "ai.openai_api_enabled"
                ? true
                : undefined) as never,
    ),
    spyOn(services.accountsAppService.accountRequest, "getPendingForUser").mockResolvedValue(null as never),
    spyOn(services.accountsAppService.accountRequest, "isEnabled").mockImplementation(async () => requestsEnabled),
    spyOn(services.accountsAppService.user.group, "list").mockImplementation(async ({ recursive }) => {
      const direct = user.memberofGroup.filter((name) => name !== "internal-fixture-group");
      const items = recursive ? [...direct, "inherited-fixture-team"] : direct;
      return { items, total: items.length, page: 1, perPage: items.length, hasNext: false };
    }),
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
      {
        id: "00000000-0000-4000-8000-000000000103",
        serviceAccountId: "00000000-0000-4000-8000-000000000102",
        name: "Dictation app",
        kind: "api_token",
        status: "active",
        tokenPrefix: "cld_9b2c",
        scopes: ["ai:inference"],
        expiresAt: null,
        lastUsedAt: null,
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
          excludedChannels: [],
          excludedReason: null,
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
    spyOn(server, "loadPendingApprovals").mockResolvedValue({ items: [], nextCursor: null } as never),
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
    spyOn(screenPreferences, "get").mockResolvedValue(defaultScreenPreferences()),
    spyOn(sharedWorkstation, "sharedWorkstationIdleSeconds").mockResolvedValue(600),
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
  setSystemTime();
});

let browser: Browser;
let css: string;
beforeAll(async () => {
  // As the page template does: the layer order first, then Core's stylesheet, then the global one.
  const styles = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss, v2Css].join("\n");
  if (shots) mkdirSync(shots, { recursive: true });
  await buildFontAssets(publicDir);
  await buildTablerIconAssets(publicDir);
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

/** The server-rendered content of one account page. */
const content = async (path: Path, locale: "en" | "de", query = "") => {
  const response = await request(path, locale, query);
  expect(response.status).toBe(200);
  return /<body[^>]*>([\s\S]*)<\/body>/.exec(await response.text())![1]!;
};
const request = (path: Path, locale: "en" | "de", query = "") =>
  new Hono()
    .use("*", async (c, next) => {
      c.set("user" as never, user as never);
      c.set("runtime" as never, { apps: [] } as never);
      await next();
    })
    .get(path, ...(pages[path] as (typeof pages)["/me"]))
    .request(`${origin}${path}${query}`, { headers: { Cookie: `cloud.locale=${locale}` } });

type View = { width: number; height: number; touch: boolean; name: string };
const desktop: View = { width: 1440, height: 900, touch: false, name: "1440" };
const tablet: View = { width: 1024, height: 768, touch: false, name: "1024" };
const phone: View = { width: 390, height: 844, touch: true, name: "390" };
const shots = process.env.CLOUD_ACCOUNT_SHOTS;

/**
 * A tab with the server-rendered page in the v2 scope that `Layout ui="v2"` gives it, before any island hydrates:
 * what a person sees first. The caller closes it.
 */
const open = async (view: View, path: Path, locale: "en" | "de", query = "") => {
  const tab = await browser.newPage({
    // JavaScript runs for the measurement only: the page has no island scripts, so it stays the server's picture.
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
  });
  await tab.route(`${origin}/public/**`, (route) => route.fulfill({ path: join(root, new URL(route.request().url()).pathname) }));
  await tab.setContent(
    `<!doctype html><html lang="${locale}" class="light"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<link rel="stylesheet" href="${origin}/public/fonts.css"><link rel="stylesheet" href="${origin}/public/tabler-icons.css"><style>${css}</style>` +
      `<style>html,body{height:100%;margin:0}main{position:fixed;inset:0;display:flex}</style></head>` +
      `<body class="k2b-ui"><main class="layout-content-main k2-ui" style="${CORE_CANVAS}">${await content(path, locale, query)}</main></body></html>`,
  );
  await tab.evaluate(() => document.fonts.ready);
  return tab;
};

const screens: { path: Path; query?: string; name: string }[] = [
  { path: "/me", name: "profile" },
  { path: "/me/security", name: "security" },
  { path: "/me/access", name: "access" },
  { path: "/me/notifications", name: "notifications" },
  { path: "/me/activity", name: "activity-open" },
  { path: "/me/activity", query: "?kind=deliveries", name: "activity-deliveries" },
  { path: "/me/activity", query: "?kind=sign-ins", name: "activity-sign-ins" },
];

describe("account pages on v2", () => {
  test("every page keeps the v2 rules at 1440, 1024 and 390 px, with no loading state in its first picture", async () => {
    const counts: string[] = [];
    const findings: string[] = [];
    for (const screen of screens)
      for (const view of [desktop, tablet, phone]) {
        const tab = await open(view, screen.path, "de", screen.query);
        try {
          const outline = await describeV2Page(tab, "main");
          if (outline.includes("Problems ("))
            findings.push(`${screen.name} ${view.name} outline:\n${outline.slice(outline.indexOf("Problems ("))}`);
          const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
          for (const problem of layout.problems) findings.push(`${screen.name} ${view.name} layout: ${problem}`);
          // The server renders the data: the first picture has nothing that is still loading.
          const loading = await tab.locator('[data-k2-part="Loading"], [aria-busy="true"]').count();
          if (loading > 0) findings.push(`${screen.name} ${view.name}: ${loading} loading states in the first picture`);
          if (view === desktop) counts.push(`${screen.path}\t${await tab.evaluate(() => document.querySelectorAll("main *").length)}`);
          if (shots) await tab.screenshot({ path: join(shots, `${screen.name}-${view.name}.png`) });
        } finally {
          await tab.close();
        }
      }
    if (process.env.CLOUD_ACCOUNT_METRICS) console.log(`DOMCOUNT\n${counts.join("\n")}`);
    expect(findings).toEqual([]);
  }, 240_000);

  test("access memberships omit internal groups from the session projection", async () => {
    user = { ...localUser, memberofGroup: [...localUser.memberofGroup, "internal-fixture-group"] };
    const html = await content("/me/access", "en");
    expect(html).not.toContain(">internal-fixture-group<");
    expect(html).not.toContain("search=internal-fixture-group");
    expect(html).toContain("team-design");
    expect(services.accountsAppService.user.group.list).toHaveBeenCalledWith({ userId: user.id, recursive: false });
  });

  test("inherited memberships remain reachable when all direct groups are internal", async () => {
    user = { ...localUser, memberofGroup: ["internal-fixture-group"] };
    const direct = await content("/me/access", "en");
    expect(direct).toContain('href="/me/access?groups=all"');
    expect(direct).not.toContain(">internal-fixture-group<");
    expect(direct).not.toContain(">inherited-fixture-team<");
    const inherited = await content("/me/access", "en", "?groups=all");
    expect(inherited).toContain(">inherited-fixture-team<");
    expect(inherited).not.toContain(">internal-fixture-group<");
    expect(inherited).toContain('href="/me/access"');
  });

  test("every old address of the account leads to its new place with every parameter", async () => {
    const app = new Hono();
    for (const [path, redirect] of oldAccountAddresses) app.get(path, redirect);
    const target = async (address: string) => {
      const response = await app.request(`${origin}${address}`);
      expect(response.status).toBe(302);
      return response.headers.get("Location");
    };
    expect(await target("/me/developer?create=api-key&reauthenticate=1")).toBe("/me/security?create=api-key&reauthenticate=1");
    expect(await target("/me/app?pair=1")).toBe("/me/security?pair=1");
    expect(await target("/me/approvals?app=mail")).toBe("/me/activity?app=mail");
    expect(await target("/me/notifications/history?status=failed&page=2")).toBe("/me/activity?status=failed&page=2&kind=deliveries");
    expect(await target("/me/security/activity?activityDays=7")).toBe("/me/activity?activityDays=7&kind=sign-ins");
    // the security page itself still takes the old range of its activity
    const response = await request("/me/security", "en", "?activityDays=90&from=mail");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/me/activity?activityDays=90&from=mail&kind=sign-ins");
  });

  test("the activity reads only the kind the address names, open approvals by default", async () => {
    await content("/me/activity", "en");
    expect(server.loadPendingApprovals).toHaveBeenCalledTimes(1);
    expect(services.notifications.user.history.list).not.toHaveBeenCalled();
    await content("/me/activity", "en", "?kind=sign-ins&activityDays=90");
    expect(services.audit.listSelfServiceActivity).toHaveBeenLastCalledWith(expect.objectContaining({ days: 90 }));
    await content("/me/activity", "en", "?kind=deliveries&status=failed&page=2");
    expect(services.notifications.user.history.list).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", page: 2 }));
    expect(server.loadPendingApprovals).toHaveBeenCalledTimes(1);
  });

  test("the account's areas are tabs with their own addresses, and the sidebar leads to the record and the activity", async () => {
    const html = await content("/me/security", "en");
    for (const href of ["/me", "/me/access", "/me/notifications", "/me/activity"]) expect(html).toContain(`href="${href}"`);
    // the phones of the mobile app stand there only while the installation offers the app
    expect(html).not.toContain("Phones with the app");
  });

  test("warn about the account expiry only when it is close", async () => {
    const tone = async (days: number) => {
      user = { ...localUser, accountExpires: new Date(Date.now() + days * 86_400_000).toISOString() };
      return /data-k2-part="Notice" data-tone="(\w+)"/.exec(await content("/me", "en"))?.[1];
    };
    expect(await tone(120)).toBe("note");
    expect(await tone(10)).toBe("warn");
    expect(await tone(-1)).toBe("bad");
  }, 30_000);

  test("a FreeIPA account with a long name keeps its deeds inside the column at 320 px, in German", async () => {
    user = ipaUser;
    freeIpaEnabled = true;
    const tab = await open({ width: 320, height: 640, touch: true, name: "320" }, "/me", "de");
    try {
      expect(await describeV2Page(tab, "main")).not.toContain("Problems (");
      expect(await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    } finally {
      await tab.close();
    }
  }, 30_000);
});

// break-ui: the realistic worst case of every value the account record and the activity render, through the same
// boundary as the sample data (the services), never a switch in the product.
const worstUser: User = {
  ...localUser,
  uid: "aleksandra.wisniewska-kowalczyk",
  givenname: "Aleksandra Maria",
  sn: "Wiśniewska-Kowalczyk von Hohenzollern-Sigmaringen",
  displayName: "Aleksandra Maria Wiśniewska-Kowalczyk von Hohenzollern-Sigmaringen",
  mail: "aleksandra.wisniewska-kowalczyk@northwind-industries-holdings.example.com",
  memberofGroup: Array.from({ length: 48 }, (_, index) => `fachschaft-informatik-arbeitsgruppe-barrierefreiheit-${index + 1}`),
  manages: ["fachschaft-informatik-arbeitsgruppe-barrierefreiheit-1", "j"],
  accountExpires: new Date(Date.parse(now) + 3 * 86_400_000).toISOString(),
};
const worstCase = () => {
  user = worstUser;
  spies.push(
    spyOn(services.webauthn, "listForUser").mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => ({
        id: `00000000-0000-4000-8000-0000000002${String(index).padStart(2, "0")}`,
        userId: worstUser.id,
        name:
          index === 0
            ? "MacBook Pro 16″ (M3 Max) – Büro Raum 2.0.41, Schreibtisch am Fenster"
            : index === 1
              ? "J"
              : `YubiKey 5C NFC #${index}`,
        transports: ["usb", "nfc", "ble", "hybrid", "internal"],
        deviceType: "multiDevice" as const,
        backedUp: index % 2 === 0,
        createdAt: now,
        lastUsedAt: index === 1 ? null : now,
      })),
    ),
    spyOn(services.serviceAccountCredentials, "listForDelegatedUser").mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        id: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
        serviceAccountId: "00000000-0000-4000-8000-000000000102",
        name: index === 0 ? "Nightly export of the Fachschaft budget spreadsheet to the archive server (do not delete)" : `Skript ${index}`,
        kind: "api_token",
        status: "active",
        tokenPrefix: "cld_7f3a9c21",
        scopes: index % 2 ? ["ai:inference"] : [],
        expiresAt: index % 3 ? null : now,
        lastUsedAt: now,
        createdBy: null,
        createdAt: now,
        revokedAt: null,
        revokedBy: null,
      })) as never,
    ),
    spyOn(services.notifications.user.history, "list").mockResolvedValue({
      items: Array.from({ length: 25 }, (_, index) => ({
        id: `00000000-0000-4000-8000-0000000004${String(index).padStart(2, "0")}`,
        eventId: `00000000-0000-4000-8000-0000000005${String(index).padStart(2, "0")}`,
        definitionId: "core.account-expiry",
        appId: index % 2 ? "core" : "an-app-that-is-not-installed-any-more",
        label: "Ablauf des Kontos",
        title:
          index === 0
            ? "Dein Konto „aleksandra.wisniewska-kowalczyk“ läuft in 3 Tagen ab – verlängere es jetzt, damit du nichts verlierst"
            : "Erinnerung",
        targetHref: index % 3 ? "/me" : null,
        channel: index % 2 ? "email" : "browser",
        destinationLabel: "aleksandra.wisniewska-kowalczyk@northwind-industries-holdings.example.com",
        required: false,
        status: (["failed", "delivered", "suppressed", "deferred"] as const)[index % 4]!,
        attemptCount: 3,
        errorCode: index % 4 === 0 ? "provider_error" : null,
        errorMessage: index % 4 === 0 ? "550 5.1.1 The email account that you tried to reach does not exist." : null,
        createdAt: now,
        deliveredAt: null,
      })),
      total: 1284,
      page: 1,
      perPage: 25,
      totalPages: 52,
    }),
  );
};

describe("account pages with the worst case of their data", () => {
  test("long names, many groups, keys and deliveries keep the v2 rules at 1440 and 390 px", async () => {
    worstCase();
    const findings: string[] = [];
    for (const screen of [
      { path: "/me" as const, name: "worst-profile" },
      { path: "/me/security" as const, name: "worst-security" },
      { path: "/me/access" as const, query: "?groups=all", name: "worst-access" },
      { path: "/me/activity" as const, query: "?kind=deliveries", name: "worst-deliveries" },
    ])
      for (const view of [desktop, phone]) {
        const tab = await open(view, screen.path, "de", screen.query);
        try {
          const outline = await describeV2Page(tab, "main");
          if (outline.includes("Problems ("))
            findings.push(`${screen.name} ${view.name} outline:\n${outline.slice(outline.indexOf("Problems ("))}`);
          const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
          for (const problem of layout.problems) findings.push(`${screen.name} ${view.name} layout: ${problem}`);
          const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          if (overflow > 0) findings.push(`${screen.name} ${view.name}: the page scrolls sideways by ${overflow} px`);
          if (shots) await tab.screenshot({ path: join(shots, `${screen.name}-${view.name}.png`) });
        } finally {
          await tab.close();
        }
      }
    expect(findings).toEqual([]);
  }, 120_000);
});
