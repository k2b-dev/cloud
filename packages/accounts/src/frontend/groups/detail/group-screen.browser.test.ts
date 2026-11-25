import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../../ui/test/browser";
import "../../../../../ui/test/solid-ssr-preload";
import { accountsMessages } from "../../messages";
import { relationsMessages } from "../relations/relations-messages";
import {
  AGENT,
  ALL,
  agent,
  children,
  GROUP,
  type GroupDb,
  graph,
  hugeDb,
  NEW_AGENT,
  ONCALL,
  PLATFORM,
  propsFor,
  SALES,
  sampleDb,
  tree,
  worstDb,
} from "./group-screens.fixture";
import { groupDetailMessages } from "./messages";

// A group's record on v2: its tabs, adding and removing members, managers and parent groups, the group deeds, and the
// relations view. The test is the server: it keeps the group in memory, answers the API and renders each page again.
const ui = resolve(import.meta.dir, "../../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_ACCOUNTS_V2_SHOTS;
const a = accountsMessages.resolve(["en"]).t;
const d = groupDetailMessages.resolve(["en"]).t;
const r = relationsMessages.resolve(["en"]).t;
const robot = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#0d9488"/></svg>';

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "GroupScreen.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    // minified as the islands ship, so the huge group's timing measures the screen, not the parsing of test code
    minify: true,
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-group-screen-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Group screen harness build failed");
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
  const styles = [resolve(import.meta.dir, "../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../styles.css")];
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

type View = { width: number; height: number; touch: boolean };
const wide: View = { width: 1440, height: 900, touch: false };
const narrow: View = { width: 1024, height: 768, touch: false };
const phone: View = { width: 390, height: 844, touch: true };

/** What the API was asked: every write with its method, path and body, every directory search, every page. */
type Log = { writes: { method: string; path: string; body: unknown }[]; searches: URL[]; pages: string[]; relations: string[] };
/** How the API answers the next writes: a status per write, 200 when the list runs out. */
type Answers = { statuses: number[] };

const page = (db: GroupDb, url: URL) => htmlPage(JSON.stringify({ screen: "group", locale: "en", props: propsFor(db, url) }));
const htmlPage = (state: string) =>
  `<!doctype html><html lang="en" class="light" data-state='${state.replaceAll("'", "&#39;")}'><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

/** Changes the server's group after a write that went through, as the services would. */
const apply = (db: GroupDb, method: string, path: string, body: { type?: string; id?: string } | null) => {
  const role = path.endsWith("/managers") ? "managers" : "members";
  const target = path.split("/")[4];
  if (path.endsWith("/members") || path.endsWith("/managers")) {
    if (target !== GROUP) {
      // this group joined or left another group
      if (method === "POST") db.parents.push({ ...db.parents[0]!, key: `group:${target}`, id: target!, name: "Sales" });
      else db.parents = db.parents.filter((entry) => entry.id !== target);
      return;
    }
    const key = `${body?.type}:${body?.id}`;
    if (method === "DELETE") db[role] = db[role].filter((entry) => entry.key !== key);
    else if (body?.type === "service_account") db[role].push(agent(body.id ?? "", "Release integration"));
  }
  if (path.endsWith("/posix")) db.group = { ...db.group, gid: 10_042 };
  if (method === "PATCH") db.group = { ...db.group, description: (body as { description?: string } | null)?.description ?? null };
};

const open = async (view: View, address: string, db: GroupDb, answers: Answers = { statuses: [] }) => {
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
  const log: Log = { writes: [], searches: [], pages: [], relations: [] };
  await tab.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === `/app/accounts/groups/${GROUP}`) {
      log.pages.push(url.search);
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: page(db, url) });
    }
    if (path === "/app/accounts/groups")
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: "<!doctype html><title>Groups</title><p>Group list</p>" });
    if (path === "/new-group")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: htmlPage(
          JSON.stringify({
            screen: "new-group",
            locale: "en",
            freeIpaEnabled: url.searchParams.get("freeipa") === "1",
            linuxEnabled: url.searchParams.get("linux") === "1",
          }),
        ),
      });
    if (path === "/api/accounts/groups" && request.method() === "POST") {
      const body = request.postDataJSON();
      log.writes.push({ method: "POST", path, body });
      const status = answers.statuses.shift() ?? 200;
      if (status !== 200) return route.fulfill({ status, json: { message: "Group already exists" } });
      return route.fulfill({
        json: { id: SALES, name: body.name, provider: body.provider, description: null, gidnumber: null, personalOwner: null },
      });
    }
    if (path === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (path === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (path === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    if (path.endsWith("/avatar")) return route.fulfill({ contentType: "image/svg+xml", body: robot });
    if (path === "/api/accounts/action-notice") return route.fulfill({ json: { markdown: null, failed: false } });
    if (path === "/api/accounts/entities") {
      log.searches.push(url);
      const kinds = url.searchParams.get("kinds") ?? "";
      const items = kinds.includes("service_account")
        ? [{ kind: "service_account", serviceAccount: { id: NEW_AGENT, name: "Release integration", kind: "standalone" } }]
        : kinds === "group"
          ? [{ kind: "group", group: { id: SALES, name: "sales", description: "Vertrieb" } }]
          : [{ kind: "user", user: { id: "44444444-4444-4444-8444-000000000001", uid: "rike", displayName: "Rike Sommer", mail: null } }];
      return route.fulfill({ json: { items } });
    }
    if (path === "/api/accounts/groups/relations") {
      log.relations.push(url.search);
      const focus = url.searchParams.get("focus") ?? GROUP;
      const selected = url.searchParams.get("selected");
      if (url.searchParams.get("expand") === "d1") {
        const ids = children[focus] ?? [];
        return route.fulfill({
          json: { ...graph, focus, columns: [{ key: "d1", items: ids.map((child) => ({ id: child, via: focus })), backs: [], hidden: 0 }] },
        });
      }
      return route.fulfill({
        json: {
          ...tree,
          roots: url.searchParams.get("expand") === "roots" ? { ids: [ALL, SALES], hidden: 0 } : tree.roots,
          selected: { ...graph.selected!, id: selected ?? GROUP, cycle: selected === SALES ? null : graph.selected!.cycle },
        },
      });
    }
    if (path.startsWith("/api/accounts/groups/")) {
      const body = request.postData() ? request.postDataJSON() : null;
      log.writes.push({ method: request.method(), path, body });
      const status = answers.statuses.shift() ?? 200;
      if (status !== 200) return route.fulfill({ status, json: { message: "Refresh the group and try again" } });
      apply(db, request.method(), path, body);
      return route.fulfill({ json: { message: "Updated" } });
    }
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${address}`);
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, log };
};

const shoot = async (tab: Page, name: string, view: View) => {
  if (shots) await tab.screenshot({ path: join(shots, `d-${name}-light-${view.width}.png`) });
};

const expectClean = async (tab: Page) => {
  const outline = await describeV2Page(tab, "#root");
  expect(outline).not.toContain("Problems (");
  const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
  expect(layout.problems).toEqual([]);
  return outline;
};

const record = `/app/accounts/groups/${GROUP}`;

describe("a group's record on v2", () => {
  test("every tab, the relations and the worst case keep the v2 rules at 1440, 1024 and 390 px", async () => {
    for (const view of [wide, narrow, phone]) {
      for (const [name, address, db] of [
        ["members", `${record}?indirect=true&service_accounts=true`, sampleDb()],
        ["managers", `${record}?tab=managers&service_accounts=true`, sampleDb()],
        ["member-of", `${record}?tab=member-of`, sampleDb()],
        ["empty", `${record}?search=nobody`, sampleDb()],
        ["relations", `${record}?tab=relations`, sampleDb()],
        ["relations-tree", `${record}?tab=relations&view=list`, sampleDb()],
        ["worst", record, worstDb()],
      ] as const) {
        const { context, tab, errors } = await open(view, address, db);
        try {
          const outline = await expectClean(tab);
          if (name === "empty") expect(outline).toContain(a.noMatchingMembers);
          if (name === "worst") expect(outline).toContain("Page 1 of 2");
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await shoot(tab, name, view);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  }, 300_000);

  test("a group of 1,200 members stays a page of 100 rows and is ready within 1.5 s", async () => {
    const { context, tab, errors } = await open(wide, record, hugeDb());
    try {
      await tab.getByText("Person 100", { exact: true }).waitFor();
      // from the start of the screen's render to its rows (the harness renders in the browser what the server renders)
      const ready = await tab.evaluate(() => performance.now() - Number(document.documentElement.dataset.renderStart));
      expect(ready).toBeLessThan(1500);
      expect(await tab.locator("[data-k2-part='Row']").count()).toBe(100);
      expect(await tab.locator("#root *").count()).toBeLessThan(2500);
      await tab.getByText("Page 1 of 12").waitFor();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("an agent becomes a manager through the directory lookup, and the page shows it", async () => {
    const db = sampleDb();
    const { context, tab, errors, log } = await open(wide, `${record}?tab=managers&service_accounts=true`, db);
    try {
      await tab.getByRole("button", { name: a.addManager }).first().click();
      const dialog = tab.locator("[data-k2-part='Dialog']");
      await dialog.getByRole("heading", { name: d.addManagersTitle }).waitFor();
      const typed = tab.waitForRequest((request) => request.url().includes("search=Release"));
      await dialog.getByRole("searchbox").fill("Release");
      const search = new URL((await typed).url());
      await dialog.getByRole("option", { name: /Release integration/ }).click();
      expect(search.searchParams.get("search")).toBe("Release");
      expect(search.searchParams.get("kinds")).toBe("user,group,service_account");
      expect(search.searchParams.get("provider")).toBe("local");
      expect(search.searchParams.get("service_account_kinds")).toBe("standalone,agent");
      expect(search.searchParams.get("service_account_status")).toBe("active");
      expect(search.searchParams.get("exclude_service_account_ids")).toBe(AGENT);
      await dialog.getByRole("button", { name: d.addChosen({ count: 1 }) }).click();
      await tab.getByText("Release integration", { exact: true }).waitFor();
      expect(log.writes).toEqual([
        { method: "POST", path: `/api/accounts/groups/${GROUP}/managers`, body: { type: "service_account", id: NEW_AGENT } },
      ]);
      // the page shows the change again from the server; the harness loads it anew, so the toast leaves with the old page
      expect(await dialog.count()).toBe(0);
      // an agent manages members only, and says so
      expect(await tab.getByText(`${a.agent} · ${a.machineManagementAccess}`).count()).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a FreeIPA group offers no machines, and a manager who is no administrator finds users only", async () => {
    const db = sampleDb();
    db.group = { ...db.group, provider: "ipa" };
    db.viewer = { ...db.viewer, isAdmin: false };
    const { context, tab, errors, log } = await open(wide, record, db);
    try {
      await tab.getByRole("button", { name: a.addMember }).first().click();
      const dialog = tab.locator("[data-k2-part='Dialog']");
      await dialog.getByRole("option", { name: /Rike Sommer/ }).waitFor();
      const search = log.searches.at(-1)!;
      expect(search.searchParams.get("kinds")).toBe("user");
      expect(search.searchParams.get("provider")).toBe("ipa");
      expect(search.searchParams.has("service_account_kinds")).toBe(false);
      expect(search.searchParams.has("service_account_status")).toBe(false);
      // no administrator: no tab for parent groups or relations, and no group deeds
      expect(await tab.getByRole("link", { name: a.memberOf }).count()).toBe(0);
      expect(await tab.getByRole("button", { name: a.groupActions }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a refused removal says why and changes nothing; the retry removes the agent", async () => {
    const db = sampleDb();
    const { context, tab, errors, log } = await open(wide, `${record}?tab=managers&service_accounts=true`, db, { statuses: [409] });
    try {
      const remove = tab.getByRole("button", { name: a.removeLabel({ name: "Nightly helper" }) });
      await remove.click();
      await tab.getByRole("alertdialog").getByRole("button", { name: a.remove, exact: true }).click();
      await tab.getByText("Refresh the group and try again").waitFor();
      expect(log.pages).toHaveLength(1);
      expect(await tab.getByText("Nightly helper", { exact: true }).count()).toBe(1);
      await remove.click();
      await tab.getByRole("alertdialog").getByRole("button", { name: a.remove, exact: true }).click();
      await tab.getByText("Nightly helper", { exact: true }).waitFor({ state: "detached" });
      expect(log.writes.map((write) => write.method)).toEqual(["DELETE", "DELETE"]);
      expect(log.writes.at(-1)).toEqual({
        method: "DELETE",
        path: `/api/accounts/groups/${GROUP}/managers`,
        body: { type: "service_account", id: AGENT },
      });
      // an indirect member cannot be removed here
      await tab.getByRole("link", { name: a.members }).click();
      await tab.getByText("Milan Horvat").waitFor();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("POSIX: explained while local Linux identities are off, converted after a question when they are on", async () => {
    const off = sampleDb();
    off.viewer = { ...off.viewer, linuxEnabled: false };
    const first = await open(wide, record, off);
    try {
      await first.tab.getByText(a.localPosixUnavailable).waitFor();
      await first.tab.getByRole("button", { name: a.groupActions }).click();
      expect(await first.tab.getByRole("menuitem", { name: a.makePosix }).getAttribute("aria-disabled")).toBe("true");
      await first.tab.getByRole("menuitem", { name: a.makePosix }).click({ force: true });
      expect(await first.tab.getByRole("alertdialog").count()).toBe(0);
      expect(first.log.writes).toEqual([]);
    } finally {
      await first.context.close();
    }
    const db = sampleDb();
    const { context, tab, errors, log } = await open(wide, record, db, { statuses: [409] });
    try {
      for (const attempt of [1, 2]) {
        await tab.getByRole("button", { name: a.groupActions }).click();
        await tab.getByRole("menuitem", { name: a.makePosix }).click();
        await tab.getByRole("alertdialog").getByRole("button", { name: a.convert }).click();
        if (attempt === 1) await tab.getByText("Refresh the group and try again").waitFor();
      }
      await tab.getByText("10042").first().waitFor();
      expect(log.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
        `PUT /api/accounts/groups/${GROUP}/posix`,
        `PUT /api/accounts/groups/${GROUP}/posix`,
      ]);
      expect(await tab.getByText("10042").count()).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a personal Linux group cannot be deleted and says why; another group is deleted after a question", async () => {
    const personal = sampleDb();
    personal.group = { ...personal.group, gid: 10_001, owner: { id: "55555555-5555-4555-8555-000000000001", name: "Quinn Doe" } };
    const first = await open(wide, record, personal);
    try {
      await first.tab.getByText(a.personalGroupDeleteBlocked({ name: "Quinn Doe" })).waitFor();
      await first.tab.getByRole("button", { name: a.groupActions }).click();
      expect(await first.tab.getByRole("menuitem", { name: a.delete }).getAttribute("aria-disabled")).toBe("true");
    } finally {
      await first.context.close();
    }
    const { context, tab, errors, log } = await open(wide, record, sampleDb());
    try {
      await tab.getByRole("button", { name: a.groupActions }).click();
      await tab.getByRole("menuitem", { name: a.delete }).click();
      const question = tab.getByRole("alertdialog");
      await question.getByText(a.deleteGroupExplanation({ freeIpa: false })).waitFor();
      await question.getByRole("button", { name: a.delete }).click();
      await tab.waitForURL(`${origin}/app/accounts/groups`);
      expect(log.writes).toEqual([{ method: "DELETE", path: `/api/accounts/groups/${GROUP}`, body: null }]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the description is changed in a dialog; the group joins and leaves another group", async () => {
    const db = sampleDb();
    const { context, tab, errors, log } = await open(wide, record, db);
    try {
      await tab.getByRole("button", { name: a.edit }).click();
      const dialog = tab.locator("[data-k2-part='Dialog']");
      await dialog.getByRole("textbox", { name: a.description }).fill("Neue Beschreibung");
      await dialog.getByRole("button", { name: a.save }).click();
      await tab.getByText("Neue Beschreibung").waitFor();
      expect(log.writes.at(-1)).toEqual({
        method: "PATCH",
        path: `/api/accounts/groups/${GROUP}`,
        body: { description: "Neue Beschreibung" },
      });

      await tab.getByRole("link", { name: a.memberOf }).click();
      await tab.getByText("All staff").waitFor();
      await tab.getByRole("button", { name: a.addToGroup }).first().click();
      await dialog.getByRole("option", { name: /sales/i }).click();
      const search = log.searches.at(-1)!;
      expect(search.searchParams.get("kinds")).toBe("group");
      expect(search.searchParams.get("exclude_group_ids")).toBe(`${ALL},${GROUP}`);
      await dialog.getByRole("button", { name: d.addChosen({ count: 1 }) }).click();
      await tab.getByText("Sales", { exact: true }).waitFor();
      expect(log.writes.at(-1)).toEqual({
        method: "POST",
        path: `/api/accounts/groups/${SALES}/members`,
        body: { type: "group", id: GROUP },
      });
      await tab.getByRole("button", { name: a.removeFromLabel({ name: "All staff" }) }).click();
      await tab.getByRole("alertdialog").getByRole("button", { name: a.remove, exact: true }).click();
      await tab.getByText("All staff").waitFor({ state: "detached" });
      expect(log.writes.at(-1)).toEqual({
        method: "DELETE",
        path: `/api/accounts/groups/${ALL}/members`,
        body: { type: "group", id: GROUP },
      });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("relation levels: every edge starts and ends at its card on a wide screen; on the phone the edges leave", async () => {
    for (const view of [wide, phone]) {
      const { context, tab, errors } = await open(view, `${record}?tab=relations`, sampleDb());
      try {
        await tab.getByRole("link", { name: "On call: contains Engineering, so it leads back" }).waitFor();
        await tab.getByText("Engineering → Platform → On call → Engineering", { exact: false }).waitFor();
        await tab.getByRole("link", { name: "+ 3 more" }).waitFor();
        const edges = await tab.evaluate(() => {
          const svg = document.querySelector("[data-stage] svg");
          if (!svg || getComputedStyle(svg).display === "none") return null;
          const origin = svg.getBoundingClientRect();
          const boxes = [...document.querySelectorAll("[data-stage] a")].map((link) => {
            const box = link.getBoundingClientRect();
            return { left: box.left - origin.left, right: box.right - origin.left, middle: box.top - origin.top + box.height / 2 };
          });
          return [...svg.querySelectorAll(":scope > path")].map((path) => {
            const numbers = (path.getAttribute("d") ?? "").match(/-?\d+(\.\d+)?/g)!.map(Number);
            const [x1, y1] = numbers;
            const [x2, y2] = numbers.slice(-2);
            const near = (x: number, y: number, side: "left" | "right") =>
              boxes.some((box) => Math.abs(box[side] - x) <= 1 && Math.abs(box.middle - y) <= 1);
            return near(x1!, y1!, "right") && near(x2!, y2!, "left");
          });
        });
        if (view === phone) expect(edges).toBeNull();
        else expect(edges).toEqual([true, true, true, true]);
        // a group chosen in the levels keeps the view's state; "Make focus" opens its own record
        await tab
          .getByRole("link", { name: /^Platform/ })
          .first()
          .click();
        await tab.waitForURL((url) => url.searchParams.get("sel") === PLATFORM);
        await settled(tab);
        await shoot(tab, "relations-chosen", view);
        expect(new URL(tab.url()).searchParams.get("tab")).toBe("relations");
        expect(await tab.getByRole("link", { name: r.makeFocus }).getAttribute("href")).toBe(
          `/app/accounts/groups/${PLATFORM}?tab=relations`,
        );
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 90_000);

  test("a back edge that closes a cycle arcs from its card to the group it leads back to", async () => {
    // Engineering at depth 3: On call contains Engineering again, three levels down.
    const db = sampleDb();
    db.relations = {
      ...graph,
      depth: 3,
      columns: [
        { key: "u1", items: [{ id: ALL, via: GROUP }], backs: [], hidden: 0 },
        { key: "d1", items: [{ id: PLATFORM, via: GROUP }], backs: [], hidden: 0 },
        { key: "d2", items: [{ id: ONCALL, via: PLATFORM }], backs: [], hidden: 0 },
        { key: "d3", items: [], backs: [{ from: ONCALL, to: GROUP, closesCycle: true }], hidden: 0 },
      ],
    };
    const { context, tab, errors } = await open(wide, `${record}?tab=relations&depth=3`, db);
    try {
      await tab.getByRole("link", { name: "Engineering: On call contains it again" }).waitFor();
      const arc = await tab.evaluate(() => {
        const svg = document.querySelector("[data-stage] svg")!;
        const origin = svg.getBoundingClientRect();
        const box = (element: Element) => {
          const rect = element.getBoundingClientRect();
          return { center: rect.left - origin.left + rect.width / 2, top: rect.top - origin.top };
        };
        const path = svg.querySelector(":scope > path[marker-end]");
        const numbers = (path?.getAttribute("d") ?? "").match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
        const links = [...document.querySelectorAll("[data-stage] a")];
        const start = box(links.find((link) => link.getAttribute("aria-label")?.startsWith("Engineering:"))!);
        const end = box(links.find((link) => link.getAttribute("aria-label") === null && link.textContent?.startsWith("Engineering"))!);
        return { numbers, start, end };
      });
      const [x1, y1] = arc.numbers;
      expect(Math.abs(x1! - arc.start.center)).toBeLessThanOrEqual(1);
      expect(Math.abs(y1! - arc.start.top)).toBeLessThanOrEqual(1);
      // The arc ends with "Q … x y V top": its last x is the third number from the end.
      expect(Math.abs(arc.numbers.at(-3)! - arc.end.center)).toBeLessThanOrEqual(1);
      expect(Math.abs(arc.numbers.at(-1)! - arc.end.top)).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("relation tree: one tab stop, keys, Enter selects in place, cycles end, and a control keeps the selection", async () => {
    const { context, tab, errors, log } = await open(wide, `${record}?tab=relations&view=list`, sampleDb());
    const focused = () => tab.evaluate(() => document.activeElement?.textContent ?? "");
    try {
      const items = tab.getByRole("treeitem");
      await items.first().waitFor();
      expect(await tab.locator('[role="treeitem"][tabindex="0"]').count()).toBe(1);
      await items.first().focus();
      await tab.keyboard.press("ArrowRight");
      await tab.getByRole("treeitem", { name: /Engineering/ }).waitFor();
      await tab.keyboard.press("ArrowDown");
      await tab.keyboard.press("ArrowDown");
      await tab.keyboard.press("ArrowRight");
      await tab.getByRole("treeitem", { name: /Platform/ }).waitFor();
      await tab.keyboard.press("ArrowDown");
      await tab.keyboard.press("ArrowRight");
      await tab.getByRole("treeitem", { name: /On call/ }).waitFor();
      await tab.keyboard.press("ArrowDown");
      await tab.keyboard.press("ArrowRight");
      await tab.getByRole("treeitem", { name: "leads back to Engineering" }).waitFor();
      await tab.keyboard.press("End");
      expect(await focused()).toContain("leads back to Engineering");
      await tab.keyboard.press("ArrowLeft");
      expect(await focused()).toContain("On call");
      await tab.keyboard.press("Home");
      await tab.keyboard.press("ArrowDown");
      await tab.keyboard.press("Enter");
      await tab.waitForFunction((sales) => new URLSearchParams(location.search).get("sel") === sales, SALES);
      await tab.locator("[data-k2-part='Section']", { hasText: "Sales" }).first().waitFor();
      expect(log.relations.some((search) => search.includes(`selected=${SALES}`))).toBe(true);
      await tab.getByRole("button", { name: "+ 1 more" }).click();
      await tab.locator('[role="treeitem"][aria-level="1"]').nth(1).waitFor();
      expect(log.relations.at(-1)).toContain("expand=roots");
      // a control opens the next page from the URL as it is now, with the selection made in the tree
      await tab.getByRole("button", { name: new RegExp(r.tree) }).click();
      await tab.getByRole("menuitemcheckbox", { name: r.managers }).click();
      await tab.waitForFunction(() => location.search.includes("managers=1"));
      const params = new URLSearchParams(log.pages.at(-1));
      expect(params.get("sel")).toBe(SALES);
      expect(params.get("tab")).toBe("relations");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);
});

describe("the dialog for a new group on v2", () => {
  const dialogOf = (tab: Page) => tab.locator("[data-k2-part='Dialog']");
  const nameField = (tab: Page) => dialogOf(tab).getByRole("textbox", { name: a.name });
  const posix = (tab: Page) => dialogOf(tab).getByRole("checkbox", { name: a.createPosixGroup });
  const create = (tab: Page) => dialogOf(tab).getByRole("button", { name: a.createGroup });

  test("an empty normalized name is refused, the name shows normalized, and a refusal keeps every value", async () => {
    const { context, tab, errors, log } = await open(wide, "/new-group", sampleDb(), { statuses: [409] });
    try {
      await nameField(tab).fill("!!!");
      await create(tab).click();
      await dialogOf(tab).getByText(a.groupNameInvalid).waitFor();
      expect(await nameField(tab).getAttribute("aria-invalid")).toBe("true");
      expect(log.writes).toEqual([]);
      await nameField(tab).fill("Research Team");
      await dialogOf(tab).getByText("research-team", { exact: false }).waitFor();
      await create(tab).click();
      await dialogOf(tab).getByText("Group already exists").waitFor();
      expect(log.writes).toEqual([
        { method: "POST", path: "/api/accounts/groups", body: { provider: "local", name: "research-team", posix: false } },
      ]);
      expect(await nameField(tab).inputValue()).toBe("Research Team");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a local POSIX group is chosen on purpose, its name is checked first, and one press sends once", async () => {
    const { context, tab, errors, log } = await open(wide, "/new-group?linux=1", sampleDb());
    try {
      expect(await posix(tab).isChecked()).toBe(false);
      await posix(tab).check();
      await nameField(tab).fill("3team");
      await create(tab).click();
      await dialogOf(tab).getByText(a.localPosixNameInvalid).waitFor();
      expect(log.writes).toEqual([]);
      await nameField(tab).fill("research-team");
      await create(tab).dblclick();
      await tab.waitForFunction(() => document.body.dataset.closed === "created");
      expect(log.writes).toEqual([
        { method: "POST", path: "/api/accounts/groups", body: { provider: "local", name: "research-team", posix: true } },
      ]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("switching who manages it keeps each POSIX choice; without Linux identities a local group is never POSIX", async () => {
    for (const linux of [false, true]) {
      const { context, tab, errors, log } = await open(wide, `/new-group?freeipa=1&linux=${linux ? 1 : 0}`, sampleDb());
      try {
        expect(await posix(tab).isChecked()).toBe(true);
        await dialogOf(tab).getByLabel(a.managedBy).click();
        await tab.getByRole("option", { name: a.local }).click();
        expect(await posix(tab).isChecked()).toBe(false);
        expect(await posix(tab).isDisabled()).toBe(!linux);
        if (linux) await posix(tab).check();
        else await dialogOf(tab).getByText(a.localPosixUnavailable).waitFor();
        await nameField(tab).fill("staff");
        await create(tab).click();
        await tab.waitForFunction(() => document.body.dataset.closed === "created");
        expect(log.writes.at(-1)?.body).toMatchObject({ provider: "local", posix: linux });
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 60_000);

  test("cancelling an edited form asks first; saying no keeps the fields, discarding closes without a request", async () => {
    const { context, tab, errors, log } = await open(wide, "/new-group", sampleDb());
    try {
      await nameField(tab).fill("Research");
      await dialogOf(tab).getByRole("button", { name: a.cancel }).click();
      const question = tab.getByRole("alertdialog");
      await question.getByRole("button", { name: a.cancel }).click();
      expect(await tab.evaluate(() => document.body.dataset.closed ?? null)).toBeNull();
      expect(await nameField(tab).inputValue()).toBe("Research");
      await dialogOf(tab).getByRole("button", { name: a.cancel }).click();
      await question.getByRole("button", { name: d.discard }).click();
      await tab.waitForFunction(() => document.body.dataset.closed === "cancelled");
      expect(log.writes).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
