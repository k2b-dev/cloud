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
import type { AccountDirectoryEntry } from "@k2b/cloud/contracts";
import { parseUsersAddress, USERS_PER_PAGE, usersQuery } from "./query";
import { FIXTURE_ACCOUNTS, FIXTURE_GROUPS, fixtureDirectory, fixtureGroupItems, fixtureSample } from "./users-screen.fixture";

// An administrator filters, sorts and groups the account list on v2: people, agents and API key accounts in one list. The
// address holds it all, so reload and back show the same rows. The test stands in for the server: the page and the
// accounts API answer from the same invented sample (the demo, the break-ui worst case, 1,250 accounts, or none).
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

type Sample = "demo" | "worst" | "huge" | "empty";
const page = (failed: boolean, sample: Sample = "demo") =>
  `<!doctype html><html lang="de" class="light" data-failed="${failed}" data-sample="${sample}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

type Seen = { pages: string[]; api: string[]; created: unknown[] };

const open = async (view: View, address: string, options: { failed?: boolean; sample?: Sample } = {}) => {
  const sample = fixtureSample(options.sample);
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
  const seen: Seen = { pages: [], api: [], created: [] };
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/app/accounts/groups") return route.fulfill({ contentType: "text/html; charset=utf-8", body: page(false) });
    if (url.pathname === "/app/accounts/users") {
      seen.pages.push(url.search);
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: page(Boolean(options.failed), options.sample) });
    }
    if (url.pathname === "/api/accounts/accounts") {
      seen.api.push(url.search);
      const pageNumber = Number(url.searchParams.get("page") ?? "1");
      const matching = fixtureDirectory(parseUsersAddress(query, url.searchParams).state, sample);
      const accounts = matching.slice((pageNumber - 1) * USERS_PER_PAGE, pageNumber * USERS_PER_PAGE);
      const total_pages = Math.max(1, Math.ceil(matching.length / USERS_PER_PAGE));
      return route.fulfill({
        json: { accounts, pagination: { page: pageNumber, per_page: USERS_PER_PAGE, total: matching.length, total_pages, has_next: pageNumber < total_pages } },
      });
    }
    if (url.pathname.startsWith("/api/accounts/users/") && url.pathname.endsWith("/avatar")) return route.fulfill({ status: 404, json: {} });
    if (url.pathname === "/api/accounts/groups" && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { name: string; provider: "ipa" | "local"; description?: string };
      seen.created.push(body);
      const group = { id: "33333333-3333-4333-8333-000000000099", name: body.name, provider: body.provider };
      return route.fulfill({
        status: 201,
        json: { ...group, description: body.description ?? null, gidnumber: null, personalOwner: null },
      });
    }
    if (url.pathname === "/api/accounts/action-notice") return route.fulfill({ json: { failed: false, notice: null } });
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
const names = (tab: Page) =>
  tab.locator("[data-k2-part=Table] tbody tr:not([data-group]) td:first-child [data-k2-part=Text]").allTextContents();
const groupHeads = (tab: Page) => tab.locator("[data-k2-part=Table] tbody tr[data-group]").allTextContents();
const nameOf = (entry: AccountDirectoryEntry) => (entry.kind === "person" ? entry.displayName || entry.mail || entry.uid : entry.name);
const expectedNames = (address: string) =>
  fixtureDirectory(parseUsersAddress(query, new URLSearchParams(address)).state).slice(0, USERS_PER_PAGE).map(nameOf);

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `accounts-users-v2-${name}.png`) });
};

const expectClean = async (tab: Page) => {
  // a row under the pointer shows its hover frame; the rules judge the resting page
  await tab.mouse.move(0, 0);
  const outline = await describeV2Page(tab, "#root");
  // the whole outline names each problem when one is found
  expect(outline.includes("Problems (") ? outline : "").toBe("");
  const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
  expect(layout.problems).toEqual([]);
};

describe("the account list on v2", () => {
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
        (first) => document.querySelector("[data-k2-part=Table] tbody tr td:first-child [data-k2-part=Text]")?.textContent === first,
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
  }, 60_000);

  test("grouped by group, a person stands in each of their groups and the status row says so", async () => {
    const { context, tab, errors } = await open(wide, "/app/accounts/users?status=active");
    try {
      await tab.getByRole("button", { name: /Keine Gruppen/ }).click();
      await tab.getByRole("menuitemradio", { name: "Gruppe", exact: true }).click();
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
      expect(await tab.locator("[data-status-row]").textContent()).toContain("2 davon in mehreren Gruppen");
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
  }, 60_000);

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
  }, 60_000);

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
      expect(await names(plain.tab)).toHaveLength(FIXTURE_ACCOUNTS.length);
    } finally {
      await plain.context.close();
    }
  }, 60_000);

  test("the kind filter narrows to agents, its address survives a reload, and Back returns to every account", async () => {
    const { context, tab, errors, seen } = await open(wide, "/app/accounts/users");
    try {
      await tab.getByRole("button", { name: "Filter", exact: true }).click();
      await tab.getByRole("menuitem", { name: /Art/ }).click();
      await tab.getByRole("option", { name: /Agent/ }).click();
      await tab.keyboard.press("Escape");
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("kind") === "agent");
      await tab.waitForFunction(
        (count) => document.querySelectorAll("[data-k2-part=Table] tbody tr:not([data-group])").length === count,
        expectedNames("kind=agent").length,
      );
      expect(await names(tab)).toEqual(["Festplaner", "Wochenbericht"]);
      expect(seen.api.at(-1)).toContain("kind=agent");
      // an agent row opens the agent's page
      const first = tab.locator("[data-k2-part=Table] tbody tr td:first-child a").first();
      expect(await first.getAttribute("href")).toBe("/app/accounts/agents/0b2f5c7e-0000-4000-8000-000000000002");
      await tab.reload();
      await settled(tab);
      expect(await names(tab)).toEqual(["Festplaner", "Wochenbericht"]);
      await tab.goBack();
      await tab.waitForFunction(() => !new URL(location.href).searchParams.has("kind"));
      await tab.waitForFunction(
        (count) => document.querySelectorAll("[data-k2-part=Table] tbody tr:not([data-group])").length === count,
        FIXTURE_ACCOUNTS.length,
      );
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a person-only filter leaves the agents out, and the agents view says how to make one when there is none", async () => {
    const people = await open(wide, "/app/accounts/users?passkey=no");
    try {
      const shown = await names(people.tab);
      expect(shown).toEqual(expectedNames("passkey=no"));
      expect(shown).not.toContain("Wochenbericht");
      expect(people.errors).toEqual([]);
    } finally {
      await people.context.close();
    }
    const empty = await open(wide, "/app/accounts/users?view=agents&kind=agent,api-key", { sample: "empty" });
    try {
      expect(await empty.tab.locator("#root").textContent()).toContain("cld admin agents create");
      await expectClean(empty.tab);
      expect(empty.errors).toEqual([]);
    } finally {
      await empty.context.close();
    }
  }, 60_000);

  test("the duplicate address view groups accounts by their shared address and keeps it in the address", async () => {
    const { context, tab, errors } = await open(wide, "/app/accounts/users");
    try {
      await tab.getByRole("link", { name: "Doppelte E-Mail" }).click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("duplicate") === "yes");
      await tab.locator("[data-k2-part=Table] tbody tr[data-group]").first().waitFor();
      expect((await groupHeads(tab)).map((head) => head.replace(/\d+$/, ""))).toEqual(["j.hartwig@solberg-kramer.example"]);
      expect(await names(tab)).toEqual(["Jonas Hartwig", "Jonas Hartwig"]);
      expect(await tab.locator("[data-status-row]").textContent()).toContain("1 Adresse mit mehreren Konten");
      await shoot(tab, "duplicates-light-1440");
      await expectClean(tab);
      // a row opens the person's page, where the account can be deleted
      const href = await tab.locator("[data-k2-part=Table] tbody tr:not([data-group]) td:first-child a").first().getAttribute("href");
      expect(href).toStartWith("/app/accounts/users/22222222-2222-4222-8222-");
      await tab.reload();
      await settled(tab);
      expect(await names(tab)).toEqual(["Jonas Hartwig", "Jonas Hartwig"]);
      await tab.goBack();
      await tab.waitForFunction(() => !new URL(location.href).searchParams.has("duplicate"));
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the worst case (break-ui) keeps the v2 rules at 1440, 1024 and 390 px, every name readable in its row", async () => {
    for (const view of [wide, narrow, phone]) {
      const { context, tab, errors } = await open(view, "/app/accounts/users", { sample: "worst" });
      try {
        await expectClean(tab);
        await shoot(tab, "worst-light-" + view.name);
        const text = (await tab.locator("#root").textContent()) ?? "";
        // a person without a name or address is named by the account name; an emoji name keeps its emoji
        expect(text).toContain("svc-scanner");
        expect(text).toContain("🦊 Fox");
        expect(text).not.toContain("undefined");
        expect(text).not.toContain("NaN");
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 90_000);

  test("1,250 accounts: the list is ready within 1.5 s and holds one page, so the page stays the same size", async () => {
    for (const view of [wide, phone]) {
      const started = Date.now();
      const { context, tab, errors } = await open(view, "/app/accounts/users", { sample: "huge" });
      try {
        await tab.locator("[data-k2-part=Table]").first().waitFor();
        expect(Date.now() - started).toBeLessThan(1500);
        const rows = await tab.locator("[data-k2-part=Table] tbody tr:not([data-group]), [data-k2-part=Table] li").count();
        expect(rows).toBeLessThanOrEqual(USERS_PER_PAGE);
        // bounded DOM: about what one page of 100 rows needs, whatever the number of accounts
        const nodes = await tab.evaluate(() => document.querySelectorAll("#root *").length);
        expect(nodes).toBeLessThan(4000);
        expect(await tab.locator("[data-status-row]").textContent()).toContain("100 von 1.250 Konten");
        expect(await tab.getByText("Seite 1 von 13").count()).toBe(1);
        await shoot(tab, "huge-light-" + view.name);
        await expectClean(tab);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 90_000);

  test("the group list keeps the v2 rules at 1440, 1024 and 390 px", async () => {
    for (const view of [wide, narrow, phone]) {
      const { context, tab, errors } = await open(view, "/app/accounts/groups");
      try {
        await tab.getByRole("group", { name: "Filter" }).first().waitFor();
        await expectClean(tab);
        await shoot(tab, `groups-light-${view.name}`);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 60_000);

  test("“Neue Gruppe” opens the v2 dialog with the same fields and creates the normalized group", async () => {
    const { context, tab, errors, seen } = await open(wide, "/app/accounts/groups");
    try {
      await tab.getByRole("button", { name: "Neue Gruppe" }).first().click();
      const dialog = tab.locator("[data-k2-part=Dialog]");
      await dialog.waitFor();
      expect(await dialog.getByRole("heading").first().textContent()).toBe("Gruppe erstellen");
      await dialog.getByRole("textbox", { name: /Name/ }).fill("Mein Team!");
      expect(await dialog.textContent()).toContain("Name: mein-team");
      expect(await dialog.getByRole("checkbox", { name: "Als POSIX-Gruppe erstellen" }).isChecked()).toBe(true);
      await shoot(tab, "new-group-light-1440");
      await dialog.getByRole("button", { name: "Gruppe erstellen" }).click();
      await tab.waitForFunction(() => !document.querySelector("[data-k2-part=Dialog]"));
      expect(seen.created).toEqual([{ provider: "ipa", name: "mein-team", posix: true }]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

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
  }, 60_000);
});
