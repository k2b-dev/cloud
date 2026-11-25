import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";
import "../../../../ui/test/solid-ssr-preload";
import { parseUsersAddress, usersQuery } from "./query";
import { FIXTURE_GROUPS, FIXTURE_PEOPLE, fixtureDirectory, fixtureGroupItems } from "./users-screen.fixture";

// An administrator filters, sorts and groups the user list on v2; the address holds it all, so reload and back show the
// same rows. The test stands in for the server: the page and the users API answer from the same invented sample.
const root = mkdtempSync(join(tmpdir(), "accounts-users-screen-browser-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_USERS_SCREEN_SHOTS;
const query = usersQuery("de");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "UsersScreen.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-users-screen-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Users screen harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let css: string;
let harness: string;
let icons: { css: string; font: string };
beforeAll(async () => {
  harness = await buildHarness();
  const iconCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
  const iconCss = await Bun.file(fileURLToPath(iconCssUrl)).text();
  const fontAsset = iconCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
  if (!fontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
  icons = { css: iconCss.replace(fontAsset, "/tabler-icons.woff2"), font: fileURLToPath(new URL(fontAsset, iconCssUrl)) };
  const styles = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss, v2Css].join("\n");
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean; name: string };
const wide: View = { width: 1440, height: 900, touch: false, name: "1440" };
const narrow: View = { width: 1024, height: 768, touch: false, name: "1024" };
const phone: View = { width: 390, height: 844, touch: true, name: "390" };

const page = (failed: boolean) =>
  `<!doctype html><html lang="de" class="light" data-failed="${failed}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

type Seen = { pages: string[]; api: string[] };

const open = async (view: View, address: string, options: { failed?: boolean } = {}) => {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  const errors = pageErrors(tab);
  const seen: Seen = { pages: [], api: [] };
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/app/accounts/users") {
      seen.pages.push(url.search);
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: page(Boolean(options.failed)) });
    }
    if (url.pathname === "/api/accounts/users") {
      seen.api.push(url.search);
      const users = fixtureDirectory(parseUsersAddress(query, url.searchParams).state);
      return route.fulfill({
        json: { users, pagination: { page: 1, per_page: 100, total: users.length, total_pages: 1, has_next: false } },
      });
    }
    if (url.pathname === "/api/accounts/groups") {
      const ids = url.searchParams.get("ids")?.split(",");
      const items = fixtureGroupItems(url.searchParams.get("search") ?? "").filter((item) => !ids || ids.includes(item.value));
      return route.fulfill({ json: { groups: items.map((item) => ({ id: item.value, name: item.label })) } });
    }
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${address}`);
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, seen };
};

/** The names of the rows the table shows, in order; a person in two groups stands twice. */
const names = (tab: Page) => tab.locator("[data-k2-part=Table] tbody tr:not([data-group]) td:first-child").allTextContents();
const groupHeads = (tab: Page) => tab.locator("[data-k2-part=Table] tbody tr[data-group]").allTextContents();
const expectedNames = (address: string) =>
  fixtureDirectory(parseUsersAddress(query, new URLSearchParams(address)).state).map((person) => person.displayName);

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `accounts-users-v2-${name}.png`) });
};

const expectClean = async (tab: Page) => {
  const outline = await describeV2Page(tab, "#root");
  expect(outline).not.toContain("Problems (");
  const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
  expect(layout.problems).toEqual([]);
};

describe("the user list on v2", () => {
  test("a filter writes the address, a reload shows the same rows, and Back returns to the list before", async () => {
    const { context, tab, errors, seen } = await open(wide, "/app/accounts/users");
    try {
      expect(await names(tab)).toEqual(expectedNames(""));
      // add "Status ist Aktiv" through "+ Filter"
      await tab.getByRole("button", { name: "Filter", exact: true }).click();
      await tab.getByRole("menuitem", { name: /Status/ }).click();
      await tab.getByRole("option", { name: /Aktiv/ }).click();
      await tab.keyboard.press("Escape");
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("status") === "active");
      await tab.waitForFunction(
        (count) => document.querySelectorAll("[data-k2-part=Table] tbody tr:not([data-group])").length === count,
        expectedNames("status=active").length,
      );
      expect(await names(tab)).toEqual(expectedNames("status=active"));
      expect(seen.api.at(-1)).toContain("status=active");

      // sort by last activity, newest first
      await tab.getByRole("button", { name: /Name/ }).first().click();
      await tab
        .getByRole("menuitemradio", { name: /Zuletzt aktiv/ })
        .first()
        .click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("sort") === "login.desc");
      await tab.waitForFunction(
        (first) => document.querySelector("[data-k2-part=Table] tbody tr td:first-child")?.textContent === first,
        expectedNames("status=active&sort=login.desc")[0],
      );
      const sorted = await names(tab);
      expect(sorted).toEqual(expectedNames("status=active&sort=login.desc"));

      // a reload of the written address shows the same rows, from the page alone
      await tab.reload();
      await settled(tab);
      expect(await names(tab)).toEqual(sorted);
      expect(seen.pages.at(-1)).toBe("?status=active&sort=login.desc");

      // Back: the sort leaves, then the filter, and the rows follow
      await tab.goBack();
      await tab.waitForFunction(() => !new URL(location.href).searchParams.has("sort"));
      await tab.waitForFunction(
        (count) => document.querySelectorAll("[data-k2-part=Table] tbody tr:not([data-group])").length === count,
        expectedNames("status=active").length,
      );
      expect(await names(tab)).toEqual(expectedNames("status=active"));
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("grouped by group, a person stands in each of their groups and the status row says so", async () => {
    const { context, tab, errors } = await open(wide, "/app/accounts/users?status=active");
    try {
      await tab.getByRole("button", { name: /Keine Gruppen/ }).click();
      await tab.getByRole("menuitemradio", { name: "Gruppe" }).click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("group") === "member-of");
      await tab.locator("[data-k2-part=Table] tbody tr[data-group]").first().waitFor();
      const heads = await groupHeads(tab);
      expect(heads.map((head) => head.replace(/\d+$/, ""))).toEqual([
        "Aushilfen",
        "Büro",
        "Geschäftsführung",
        "Lager",
        "Verkauf",
        "Werkstatt",
      ]);
      // Milan Horvat (Geschäftsführung, Verkauf) and Petra Lindqvist (Verkauf, Werkstatt) stand twice
      const shown = await names(tab);
      expect(shown.filter((name) => name === "Milan Horvat")).toHaveLength(2);
      expect(shown.filter((name) => name === "Petra Lindqvist")).toHaveLength(2);
      expect(await tab.locator("[data-status-row]").textContent()).toContain("2 davon in mehreren Gruppen, sie stehen mehrfach");
      await shoot(tab, "grouped-light-1440");
      await expectClean(tab);
      // grouping only arranges the page: Back takes it away without loading the rows again
      await tab.goBack();
      await tab.waitForFunction(() => !new URL(location.href).searchParams.has("group"));
      expect(await tab.locator("[data-k2-part=Table] tbody tr[data-group]").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("a group filter names its group on the first picture and searches groups through the lookup", async () => {
    const { context, tab, errors } = await open(wide, `/app/accounts/users?member-of=${FIXTURE_GROUPS.sales.id}`);
    try {
      expect(await tab.locator(".k2-fbar-flow .k2-stmt-b").allTextContents()).toEqual(["Gruppe ist Verkauf"]);
      expect(await names(tab)).toEqual(expectedNames(`member-of=${FIXTURE_GROUPS.sales.id}`));
      await tab.locator(".k2-stmt-b").first().click();
      await tab.getByRole("searchbox", { name: /Gruppe/ }).fill("lag");
      await tab.getByRole("option", { name: /Lager/ }).click();
      await tab.waitForFunction(
        (ids) => new URL(location.href).searchParams.get("member-of") === ids,
        [FIXTURE_GROUPS.sales.id, FIXTURE_GROUPS.store.id].join(","),
      );
      await tab.keyboard.press("Escape");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("keeps the v2 rules at 1440, 1024 and 390 px; on the phone rows are two lines ending in their status", async () => {
    const address = "/app/accounts/users?status=active&group=member-of";
    for (const view of [wide, narrow, phone]) {
      const { context, tab, errors } = await open(view, address);
      try {
        await expectClean(tab);
        await shoot(tab, `grouped-light-${view.name}`);
        if (view === phone) {
          // the phone list: names with their role and groups, the status chip at the end
          const first = tab.locator("[data-k2-part=Table] li, [data-k2-part=Row]").filter({ hasText: "Petra Lindqvist" }).first();
          await first.waitFor();
          expect(await first.textContent()).toContain("Aktiv");
        }
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
    const plain = await open(wide, "/app/accounts/users");
    try {
      await shoot(plain.tab, "all-light-1440");
      expect(await names(plain.tab)).toHaveLength(FIXTURE_PEOPLE.length);
    } finally {
      await plain.context.close();
    }
  });

  test("a list that failed to load offers to try again, and the retry loads it", async () => {
    const { context, tab, errors, seen } = await open(wide, "/app/accounts/users?status=invited", { failed: true });
    try {
      await tab.getByRole("button", { name: "Erneut versuchen" }).click();
      await tab.waitForFunction(
        (count) => document.querySelectorAll("[data-k2-part=Table] tbody tr:not([data-group])").length === count,
        expectedNames("status=invited").length,
      );
      expect(seen.api.at(-1)).toContain("status=invited");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
