import { afterAll, beforeAll, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { accountsAppService } from "@k2b/cloud/services";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser, Page } from "playwright";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import { launchBrowser, launchHookMs, settled } from "../../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import { parseUsersAddress, USERS_PER_PAGE, usersQuery } from "./query";
import { FIXTURE_ACCOUNTS, FIXTURE_GROUPS, FIXTURE_NOW, fixtureDirectory, fixtureSummary } from "./users-screen.fixture";

// The account list as the server sends it, inside the Cloud shell: the real page with the real `Layout` (icon rail,
// tinted page, the app's v2 sidebar), rendered on the server from the invented sample and shown without its islands, as
// the first picture a person sees. It keeps the v2 layout rules at 1440 and 390 px and draws the pictures of the
// list for the design review when CLOUD_USERS_SCREEN_SHOTS is set.
const root = mkdtempSync(join(tmpdir(), "accounts-users-shell-browser-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");

const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_USERS_SCREEN_SHOTS;
const query = usersQuery("de");

/** Invented administrator who opens the list. */
const admin = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "m.solberg",
  roles: ["user", "admin"],
  provider: "local",
  profile: "user",
  givenname: "Mira",
  sn: "Solberg",
  displayName: "Mira Solberg",
  mail: "m.solberg@solberg-kramer.example",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

/** The apps of the icon rail, as a running Cloud lists them. */
const apps: CloudRuntime["apps"] = [
  ["mail", "Mail", "ti ti-mail"],
  ["files", "Dateien", "ti ti-folders"],
  ["grids", "Grids", "ti ti-table"],
  ["notebooks", "Notizbücher", "ti ti-notebook"],
  ["spaces", "Spaces", "ti ti-layout-kanban"],
  ["accounts", "Zugänge", "ti ti-users-group"],
].map(([id, name, icon]) => ({
  id: id!,
  name: name!,
  icon: icon!,
  description: "",
  routes: [`/app/${id}`],
  nav: { href: `/app/${id}`, section: "primary" as const },
}));

const spies = [
  stubRailSnapshot(),
  spyOn(accountsAppService.accountRequest, "countPending").mockResolvedValue(2),
  spyOn(accountsAppService.group, "list").mockImplementation(async (config) => {
    const ids = config?.scope?.ids ?? [];
    const items = Object.values(FIXTURE_GROUPS)
      .filter((group) => ids.includes(group.id))
      .map((group) => ({ ...group, provider: "local" as const, description: null, gidnumber: null, personalOwner: null }));
    return { items, page: 1, perPage: items.length, total: items.length, hasNext: false };
  }),
  spyOn(accountsAppService.account, "directory").mockImplementation(async (config) => {
    const params = new URL(`${origin}${pageAddress}`).searchParams;
    const matching = fixtureDirectory(parseUsersAddress(query, params).state);
    const page = config.pagination?.page ?? 1;
    return {
      ok: true as const,
      data: {
        items: matching.slice((page - 1) * USERS_PER_PAGE, page * USERS_PER_PAGE),
        page,
        perPage: USERS_PER_PAGE,
        total: matching.length,
        hasNext: page * USERS_PER_PAGE < matching.length,
        summary: fixtureSummary(FIXTURE_ACCOUNTS),
      },
    };
  }),
];
/** The address the server is asked for, so the stand-in directory answers the same state as the page parsed. */
let pageAddress = "/app/accounts/users";

const server = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
server.use("*", async (c, next) => {
  c.set("actor", { kind: "user", user: admin });
  c.set("user", admin);
  c.set("runtime", { apps });
  await next();
});
server.get("/app/accounts/users", ...handler);

let browser: Browser;
let css: string;
let icons: { css: string; font: string };
beforeAll(async () => {
  // the page reads "now" for its dates and "today" on the server: the sample's day, whatever day the test runs
  setSystemTime(new Date(FIXTURE_NOW));
  const styles = [resolve(import.meta.dir, "../../../../../styles.css"), resolve(import.meta.dir, "../../styles/app.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [globalCss, appCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = [globalCss, appCss, v2Css].join("\n");
  const iconCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
  const iconCss = await Bun.file(fileURLToPath(iconCssUrl)).text();
  const fontAsset = iconCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
  if (!fontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
  icons = { css: iconCss.replace(fontAsset, "/tabler-icons.woff2"), font: fileURLToPath(new URL(fontAsset, iconCssUrl)) };
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  setSystemTime();
  await browser?.close();
  for (const spy of spies) spy.mockRestore();
});

/** Opens the server's page for an address at a width, without its islands (their code is not served): the first picture. */
const open = async (address: string, width: number): Promise<Page> => {
  pageAddress = address;
  const response = await server.request(`${origin}${address}`, { headers: { "Accept-Language": "de" } });
  expect(response.status).toBe(200);
  const html = await response.text();
  const phone = width < 600;
  const page = await browser.newPage({
    viewport: { width, height: phone ? 844 : 900 },
    deviceScaleFactor: 1,
    isMobile: phone,
    hasTouch: phone,
    colorScheme: "light",
  });
  // nothing leaves the test: the page itself and the icon font, everything else (scripts, pictures, other hosts) empty
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === new URL(`${origin}${address}`).pathname) return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    // the operator's logo at the top of the rail
    if (url.pathname === "/branding/logo")
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="5" fill="#111827"/><path d="M13 7.2a4 4 0 1 0 0 5.6" fill="none" stroke="#fff" stroke-width="2"/></svg>',
      });
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${origin}${address}`, { waitUntil: "domcontentloaded" });
  await page.addStyleTag({ content: css });
  await page.addStyleTag({ content: icons.css });
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  return page;
};

const shoot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `accounts-users-v2-shell-${name}.png`) });
};

describe("the account list inside the Cloud shell", () => {
  for (const [name, address] of [
    ["all", "/app/accounts/users"],
    ["agents", "/app/accounts/users?view=agents&kind=agent"],
    ["duplicates", "/app/accounts/users?view=duplicates&duplicate=yes&sort=mail.asc&group=mail"],
  ] as const)
    for (const width of [1440, 390])
      test(`${name} at ${width} px: the shell, a first row that says what matters today, and every row with its sign`, async () => {
        const page = await open(address, width);
        try {
          // the shell frame: the icon rail on a desk, the tinted page behind the workspace
          if (width > 600) expect(await page.locator(".layout-rail").isVisible()).toBe(true);
          expect(await page.locator("[data-status-row]").first().textContent()).toContain(
            `${fixtureSummary(FIXTURE_ACCOUNTS).signedInToday} Anmeldungen heute`,
          );
          // every row leads with an avatar or a mark
          const rows = page.locator("[data-k2-part=Table] tbody tr:not([data-group]):visible, [data-k2-part=Row]:visible");
          const count = await rows.count();
          expect(count).toBeGreaterThan(0);
          expect(await rows.locator('[data-k2-part="Avatar"], [data-k2-part="Mark"]').count()).toBeGreaterThanOrEqual(count);
          const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
          expect(layout.problems).toEqual([]);
          await shoot(page, `${name}-light-${width}`);
        } finally {
          await page.close();
        }
      }, 60_000);

  test("the chips of the first row open the views that need a hand", async () => {
    const page = await open("/app/accounts/users", 1440);
    try {
      const summary = fixtureSummary(FIXTURE_ACCOUNTS);
      const chip = page.locator("[data-status-row] a", { hasText: `${summary.invited} eingeladen` });
      expect(await chip.getAttribute("href")).toBe("/app/accounts/users?view=invited&status=invited");
      // dates count from the sample's day, the same on every day the test runs
      expect(await page.locator("[data-k2-part=Table] tbody tr", { hasText: "Ada Renz" }).textContent()).toContain("vor 11 Tagen");
    } finally {
      await page.close();
    }
  }, 60_000);
});
