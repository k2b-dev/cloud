import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cloud from "@k2b/cloud";
import { DEFAULT_ACCOUNT_CATEGORY_POLICY, type User } from "@k2b/cloud/contracts";
import { auth } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

// The sign-in pages on v2 as the server renders them, before any island hydrates: the v2 rules (outline and measured
// layout) on a computer and a phone, and no loading state in the first picture. Only a real engine lays them out.
const root = mkdtempSync(join(tmpdir(), "core-auth-pages-browser-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_AUTH_SHOTS;
const publicDir = join(root, "public");

const pages = {
  "/auth/login": (await import("./page")).default,
  "/auth/continue": (await import("./consent.page")).default,
  "/auth/new-password": (await import("./new-password/page")).default,
  "/auth/password-reset": (await import("./password-reset/page")).default,
} as const;
type Path = keyof typeof pages;
const { buildFontAssets } = await import("../../../scripts/font-assets");
const { buildTablerIconAssets } = await import("../../../scripts/tabler-assets");

/** Invented account that has not accepted the terms yet. */
const pendingUser: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "consent-reader",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Ada",
  sn: "Reader",
  displayName: "Ada Reader",
  mail: "ada@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};

const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  spies.push(
    spyOn(services.coreSettings, "get").mockImplementation(
      async (key) => (key === "freeipa.enable" ? true : key === "app.name" ? "Cloud" : undefined) as never,
    ),
    spyOn(services, "readAccountCategoryPolicy").mockResolvedValue(DEFAULT_ACCOUNT_CATEGORY_POLICY),
    spyOn(cloud, "listLegalLinks").mockResolvedValue([
      { href: "/impressum", label: "Impressum" },
      { href: "/legal/privacy", label: "Datenschutz" },
    ] as never),
    spyOn(services.appApproval, "config").mockResolvedValue({
      issuer: origin,
      appOrigin: "https://auth.example.test",
      enabled: true,
      adminPairing: false,
    }),
    spyOn(auth.session, "getToken").mockReturnValue(null as never),
    spyOn(services.legalConsent, "pending").mockResolvedValue({ user: pendingUser, sid: "consent-session", authEpoch: 0 } as never),
    spyOn(services.legalConsent, "documents").mockResolvedValue({ documents: [], version: "a".repeat(64) } as never),
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

/** The server-rendered body of one sign-in page. */
const body = async (path: Path, query = "", cookie = "") => {
  const response = await new Hono()
    .get(path, ...(pages[path] as (typeof pages)["/auth/login"]))
    .request(`${origin}${path}${query}`, { headers: { Cookie: `cloud.locale=de; ${cookie}` } });
  expect(response.status).toBe(200);
  return /<body[^>]*>([\s\S]*)<\/body>/.exec(await response.text())![1]!;
};

type View = { width: number; height: number; touch: boolean; name: string };
const views: View[] = [
  { width: 1440, height: 900, touch: false, name: "1440" },
  { width: 390, height: 844, touch: true, name: "390" },
];

const screens: { path: Path; query?: string; cookie?: string; name: string }[] = [
  { path: "/auth/login", query: "?method=ipa", name: "login-freeipa" },
  { path: "/auth/login", query: "?method=ipa&credential=app", name: "login-app" },
  { path: "/auth/login", query: "?method=guest", name: "login-email" },
  { path: "/auth/login", query: "?method=admin", name: "login-admin" },
  { path: "/auth/continue", query: "?redirectTo=%2Fapp%2Ffiles", name: "consent" },
  { path: "/auth/new-password", query: "?ipa-uid=mira", name: "new-password" },
  { path: "/auth/password-reset", name: "password-reset" },
];

describe("sign-in pages on v2", () => {
  test("every page keeps the v2 rules on a computer and a phone, with no loading state in its first picture", async () => {
    const findings: string[] = [];
    const counts: string[] = [];
    for (const screen of screens)
      for (const view of views) {
        const tab = await browser.newPage({
          viewport: { width: view.width, height: view.height },
          deviceScaleFactor: 1,
          isMobile: view.touch,
          hasTouch: view.touch,
        });
        try {
          await tab.route(`${origin}/public/**`, (route) => route.fulfill({ path: join(root, new URL(route.request().url()).pathname) }));
          // JavaScript runs for the measurement only: the page has no island scripts, so it stays the server's picture.
          await tab.setContent(
            `<!doctype html><html lang="de" class="light"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
              `<link rel="stylesheet" href="${origin}/public/fonts.css"><link rel="stylesheet" href="${origin}/public/tabler-icons.css"><style>${css}</style></head>` +
              `<body class="k2b-ui">${await body(screen.path, screen.query, screen.cookie)}</body></html>`,
          );
          await tab.evaluate(() => document.fonts.ready);
          const outline = await describeV2Page(tab, "main");
          if (outline.includes("Problems ("))
            findings.push(`${screen.name} ${view.name}:\n${outline.slice(outline.indexOf("Problems ("))}`);
          const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
          for (const problem of layout.problems) findings.push(`${screen.name} ${view.name} layout: ${problem}`);
          const loading = await tab.locator('[data-k2-part="Loading"], [aria-busy="true"]').count();
          if (loading > 0) findings.push(`${screen.name} ${view.name}: ${loading} loading states in the first picture`);
          if (view.name === "1440") counts.push(`${screen.name}\t${await tab.evaluate(() => document.querySelectorAll("body *").length)}`);
          if (shots) await tab.screenshot({ path: join(shots, `${screen.name}-${view.name}.png`) });
        } finally {
          await tab.close();
        }
      }
    if (process.env.CLOUD_AUTH_METRICS) console.log(`DOMCOUNT\n${counts.join("\n")}`);
    expect(findings).toEqual([]);
  }, 180_000);

  test("the sign-in keeps the name from the link, and the consent page names its documents' version", async () => {
    const login = await body("/auth/login", "?method=ipa&ipa-uid=mira");
    expect(login).toContain('value="mira"');
    expect(await body("/auth/continue")).toContain(`data-legal-version="${"a".repeat(64)}"`);
  });
});
