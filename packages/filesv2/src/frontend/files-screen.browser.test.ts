import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../ui/test/browser";
import "../../../ui/test/solid-ssr-preload";
import {
  FIXTURE_NOW,
  type FixtureCase,
  fixtureBase,
  fixtureFavorites,
  fixtureListing,
  fixturePage,
  fixtureSearch,
  fixtureTrash,
} from "./files-screen.fixture";

// A person works in a folder of Files on v2: opens folders and files in place, sorts, searches, chooses entries and
// renames, moves and trashes them, on a desktop and on a phone. The test stands in for the server: the page and the
// Files API answer from the same invented folders.
const ui = resolve(import.meta.dir, "../../../ui");
const origin = "https://cloud.example.test";
setDefaultTimeout(30_000);
const shots = process.env.CLOUD_FILES_SCREEN_SHOTS;
const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", ui))).default;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "FilesScreen.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-files-screen-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Files screen harness build failed");
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
  const styles = [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")];
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

const page = (fixture: FixtureCase) =>
  `<!doctype html><html lang="de" class="light" data-fixture="${fixture}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

const emptyHistory = { items: [], next: null, visibleCount: 0, batches: [], exhausted: true, scanLimitReached: false };
type Seen = { pages: string[]; api: string[]; posts: { path: string; body: unknown }[] };

const open = async (view: View, address: string, fixture: FixtureCase = "plain") => {
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
  const seen: Seen = { pages: [], api: [], posts: [] };
  await tab.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const api = "/api/filesv2";
    if (url.pathname === "/app/filesv2") {
      seen.pages.push(url.search);
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: page(fixture) });
    }
    if (url.pathname.startsWith(api)) seen.api.push(`${request.method()} ${url.pathname.slice(api.length)}${url.search}`);
    if (request.method() === "POST" && url.pathname.startsWith(api)) {
      const body = request.postDataJSON() as { path?: string; paths?: string[]; name?: string };
      seen.posts.push({ path: url.pathname.slice(api.length), body });
      if (url.pathname.endsWith("/rename")) {
        const from = String(body.path);
        const renamed = [from.split("/").slice(0, -1).join("/"), String(body.name)].filter(Boolean).join("/");
        return route.fulfill({
          json: { entry: { name: body.name, path: renamed, directory: false, size: 1, modified: FIXTURE_NOW } },
        });
      }
      if (url.pathname.endsWith("/download"))
        return route.fulfill({ json: { url: `${origin}/content`, method: "GET", expires: "2026-11-25T13:00:00.000Z" } });
      if (url.pathname.endsWith("/delete"))
        return route.fulfill({ json: { results: (body.paths ?? []).map((path) => ({ path, ok: true })) } });
      return route.fulfill({ status: 404, json: { code: "not_found", message: "Nicht gefunden" } });
    }
    if (url.pathname === `${api}/bases`) return route.fulfill({ json: { items: [fixtureBase], issues: [], editor: null } });
    if (url.pathname === `${api}/bases/demo/entries`) {
      const items = fixtureListing(fixture, url.searchParams.get("path") ?? "", {
        sort: url.searchParams.get("sort") ?? "name",
        order: url.searchParams.get("order") ?? "asc",
        type: url.searchParams.get("type") ?? "all",
        groupFolders: url.searchParams.get("groupFolders") !== "false",
      });
      const page = fixturePage(items, url.searchParams.get("after"));
      return route.fulfill({ json: { base: fixtureBase, path: url.searchParams.get("path") ?? "", ...page, actions: { create: true } } });
    }
    if (url.pathname === `${api}/bases/demo/search`) {
      const path = url.searchParams.get("path") ?? "";
      const items = fixtureSearch(fixture, path, url.searchParams.get("q") ?? "");
      return route.fulfill({
        json: { base: fixtureBase, path, items, next: null, query: url.searchParams.get("q"), scope: "tree", total: items.length },
      });
    }
    if (url.pathname === `${api}/bases/demo/entry`) {
      const path = url.searchParams.get("path") ?? "";
      const all = [
        ...fixtureListing(fixture, path.split("/").slice(0, -1).join("/"), { sort: "name", order: "asc", type: "all", groupFolders: true }),
      ];
      const found = all.find((item) => item.path === path);
      return found
        ? route.fulfill({ json: { base: fixtureBase, entry: found, favorite: false } })
        : route.fulfill({ status: 404, json: { code: "not_found", message: "Nicht gefunden" } });
    }
    if (url.pathname === `${api}/bases/demo/trash`) return route.fulfill({ json: fixtureTrash });
    if (url.pathname === `${api}/favorites`) return route.fulfill({ json: fixtureFavorites });
    if (url.pathname === `${api}/activity`) return route.fulfill({ json: emptyHistory });
    if (url.pathname === `${api}/shares`) return route.fulfill({ json: { items: [], next: null } });
    if (url.pathname.startsWith(`${api}/bases/demo/preview`)) return route.fulfill({ status: 404, body: "" });
    if (url.pathname === "/content")
      return route.fulfill({
        contentType: "text/plain; charset=utf-8",
        headers: { "access-control-allow-origin": "*" },
        body: "# Notizen\n\nZuschnitt Küchenfront bis Freitag. Eiche geölt, 19 mm.\n\n- Maße prüfen\n- Kanten bestellen\n",
      });
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

/** The names of the rows the folder shows, in order. */
const names = (tab: Page) =>
  tab
    .locator("[data-k2-part=Table] tbody tr:not([data-group]) td:nth-child(2) [data-k2-part=Text]")
    .evaluateAll((cells) => cells.map((cell) => (cell.textContent ?? "").trim()));
const rowLink = (tab: Page, name: string) => tab.locator("[data-k2-part=Table] tbody tr .k2-row-open").filter({ hasText: name }).first();
const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `files-v2-${name}.png`) });
};
const expectClean = async (tab: Page) => {
  await tab.mouse.move(0, 0);
  const outline = await describeV2Page(tab, "#root");
  expect(outline.includes("Problems (") ? outline : "").toBe("");
  const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
  expect(layout.problems).toEqual([]);
};

describe("a folder of Files on v2", () => {
  test("folders and files open in place, the address keeps them, and the open file stands beside the list", async () => {
    const { context, tab, errors, seen } = await open(wide, "/app/filesv2?base=demo");
    try {
      expect(await names(tab)).toEqual([
        "Angebote",
        "Fotos",
        "Budget 2027.xlsx",
        "Lieferplan.pdf",
        "Notizen.md",
        "Zuschnitt Küchenfront.dxf",
      ]);
      await shoot(tab, "01-folder-1440");
      await expectClean(tab);

      await rowLink(tab, "Angebote").click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("path") === "Angebote");
      await tab.waitForFunction(() => document.querySelectorAll("[data-k2-part=Table] tbody tr:not([data-group])").length === 2);
      expect(await names(tab)).toEqual(["Angebot Familie Oswald.pdf", "Angebot Stadtwerke.pdf"]);
      // in place: the page itself never loaded again, and the sidebar names the open folder
      expect(seen.pages).toHaveLength(1);
      expect(await tab.locator("[data-k2-part=Nav] [aria-current=page]").innerText()).toContain("Angebote");

      await tab.goBack();
      await tab.waitForFunction(() => !new URL(location.href).searchParams.get("path"));
      await tab.waitForFunction(() => document.querySelectorAll("[data-k2-part=Table] tbody tr:not([data-group])").length === 6);

      await rowLink(tab, "Notizen.md").click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("file") === "Notizen.md");
      await tab.getByText("Eigenschaften", { exact: true }).waitFor();
      expect(await tab.getByRole("button", { name: "Herunterladen", exact: true }).count()).toBeGreaterThan(0);
      await shoot(tab, "02-detail-1440");
      await expectClean(tab);
      await tab.getByRole("link", { name: "Details schließen", exact: true }).first().click();
      await tab.waitForFunction(() => !new URL(location.href).searchParams.get("file"));
      expect(seen.pages).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("a column head sorts through the address, and a reload shows the same order", async () => {
    const { context, tab, errors, seen } = await open(wide, "/app/filesv2?base=demo");
    try {
      await tab.locator("[data-k2-part=Table] thead").getByRole("link", { name: /Größe/ }).click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("sort") === "size.desc");
      await tab.waitForFunction(
        () =>
          [
            ...document.querySelectorAll("[data-k2-part=Table] tbody tr:not([data-group]) td:nth-child(2) [data-k2-part=Text]"),
          ][2]?.textContent?.trim() === "Zuschnitt Küchenfront.dxf",
      );
      const sorted = await names(tab);
      expect(sorted.slice(0, 3)).toEqual(["Angebote", "Fotos", "Zuschnitt Küchenfront.dxf"]);
      await tab.reload();
      await settled(tab);
      expect(await names(tab)).toEqual(sorted);
      expect(seen.pages.at(-1)).toContain("sort=size.desc");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("a search below the folder finds by name, says how many, and Escape shows the folder again", async () => {
    const { context, tab, errors } = await open(wide, "/app/filesv2?base=demo");
    try {
      const field = tab.getByRole("searchbox").first();
      await field.fill("angebot");
      await field.press("Enter");
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("q") === "angebot");
      await tab.waitForFunction(() => document.querySelectorAll("[data-k2-part=Table] tbody tr:not([data-group])").length === 3);
      expect(await tab.locator("[data-k2-part=StatusRow]").innerText()).toContain("3 Treffer");
      await shoot(tab, "03-search-1440");
      await field.focus();
      await field.press("Escape");
      await tab.waitForFunction(() => !new URL(location.href).searchParams.get("q"));
      await tab.waitForFunction(() => document.querySelectorAll("[data-k2-part=Table] tbody tr:not([data-group])").length === 6);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("chosen entries turn the status row into their deeds; rename and trash go through the Files API", async () => {
    const { context, tab, errors, seen } = await open(wide, "/app/filesv2?base=demo");
    try {
      await tab.getByRole("checkbox", { name: /Budget 2027\.xlsx/ }).check();
      await tab.getByRole("checkbox", { name: /Lieferplan\.pdf/ }).check();
      const status = tab.locator("[data-k2-part=StatusRow]");
      await status.getByText(/2 ausgewählt/).waitFor();
      for (const deed of ["Verschieben nach …", "In den Papierkorb"])
        expect(await status.getByRole("button", { name: deed }).count()).toBe(1);
      await shoot(tab, "04-selection-1440");
      await status.getByRole("button", { name: /Auswahl aufheben/ }).click();
      await status.getByText(/Einträge geladen/).waitFor();

      await tab.getByRole("button", { name: "Aktionen für Notizen.md", exact: true }).click();
      await tab.getByRole("menuitem", { name: "Umbenennen", exact: true }).click();
      const name = tab.getByRole("dialog").getByRole("textbox").last();
      await name.fill("Notizen neu.md");
      await name.press("Enter");
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("file") === "Notizen neu.md");
      expect(seen.posts.at(-1)).toEqual({ path: "/bases/demo/rename", body: { path: "Notizen.md", name: "Notizen neu.md" } });

      await tab.getByRole("button", { name: "Aktionen für Lieferplan.pdf", exact: true }).click();
      await tab.getByRole("menuitem", { name: "In den Papierkorb", exact: true }).click();
      await tab.getByRole("alertdialog").or(tab.getByRole("dialog")).getByRole("button", { name: "In den Papierkorb" }).click();
      await tab.waitForFunction(() => document.querySelector("[role=status], [role=alert]") !== null);
      expect(seen.posts.at(-1)).toEqual({ path: "/bases/demo/delete", body: { paths: ["Lieferplan.pdf"] } });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("on a phone a file opens as its own page, and the way back returns to the folder", async () => {
    const { context, tab, errors } = await open(phone, "/app/filesv2?base=demo");
    try {
      await shoot(tab, "05-folder-390");
      await expectClean(tab);
      await tab.getByRole("link", { name: "Notizen.md", exact: true }).click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("file") === "Notizen.md");
      await tab.getByText("Eigenschaften", { exact: true }).waitFor();
      await shoot(tab, "06-detail-390");
      await expectClean(tab);
      await tab.locator("[data-k2-part=Back]").getByRole("link").first().click();
      await tab.waitForFunction(() => !new URL(location.href).searchParams.get("file"));
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("the trash and the favorites open in place from the sidebar, and a favorite opens its file beside its folder", async () => {
    const { context, tab, errors, seen } = await open(wide, "/app/filesv2?base=demo");
    try {
      await tab.locator("[data-k2-part=Nav]").getByRole("link", { name: "Papierkorb" }).click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("view") === "trash");
      await tab.getByText("Alter Entwurf.pdf").first().waitFor();
      expect(await tab.locator("[data-k2-part=Table]").innerText()).toContain("Ursprünglicher Speicherort unbekannt");
      await shoot(tab, "09-trash-1440");
      await expectClean(tab);

      await tab.locator("[data-k2-part=Nav]").getByRole("link", { name: "Favoriten" }).click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("view") === "favorites");
      await tab.getByText("Budget 2027.xlsx").first().waitFor();
      await shoot(tab, "10-favorites-1440");
      await expectClean(tab);

      await tab.getByRole("link", { name: "Budget 2027.xlsx" }).first().click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("file") === "Budget 2027.xlsx");
      await tab.getByText("Eigenschaften", { exact: true }).waitFor();
      // Every step stayed on the first page load.
      expect(seen.pages).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  for (const address of ["/app/filesv2?base=demo&view=trash", "/app/filesv2?view=favorites"])
    test(`${address} fits the phone`, async () => {
      const { context, tab, errors } = await open(phone, address);
      try {
        await shoot(tab, `11-${address.includes("trash") ? "trash" : "favorites"}-390`);
        await expectClean(tab);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });

  for (const view of [wide, narrow, phone])
    test(`worst-case names, sizes and scripts keep the layout whole at ${view.name}px`, async () => {
      const { context, tab, errors } = await open(view, "/app/filesv2?base=demo", "worst");
      try {
        await shoot(tab, `07-worst-${view.name}`);
        await expectClean(tab);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });

  test("a folder of 1,000 entries opens with its first page at once and grows page by page", async () => {
    const started = performance.now();
    const { context, tab, errors } = await open(wide, "/app/filesv2?base=demo", "huge");
    try {
      const ready = performance.now() - started;
      const rows = () => tab.locator("[data-k2-part=Table] tbody tr:not([data-group])").count();
      expect(await rows()).toBe(50);
      const nodes = await tab.evaluate(() => document.querySelectorAll("*").length);
      await shoot(tab, "08-huge-1440");
      const more = tab.getByRole("button", { name: "Mehr laden", exact: true });
      const grown = performance.now();
      for (const count of [100, 150, 200]) {
        await more.click();
        await tab.waitForFunction(
          (expected) => document.querySelectorAll("[data-k2-part=Table] tbody tr:not([data-group])").length === expected,
          count,
        );
      }
      const after = await tab.evaluate(() => document.querySelectorAll("*").length);
      // k2b-ui gap: Table is not virtualized yet (lane MW, VirtualFeed); each loaded page adds its rows to the DOM.
      console.info(
        `files huge fixture: 50 rows ready in ${Math.round(ready)} ms with ${nodes} DOM nodes; 200 rows after ${Math.round(performance.now() - grown)} ms with ${after} DOM nodes`,
      );
      expect(ready).toBeLessThan(5000);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
