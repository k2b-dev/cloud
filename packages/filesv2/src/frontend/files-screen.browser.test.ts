import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../ui/test/browser";
import type { ActivityPage } from "../activity-contracts";
import "../../../ui/test/solid-ssr-preload";
import {
  FIXTURE_NOW,
  type FixtureCase,
  fixtureActivity,
  fixtureBase,
  fixtureBases,
  fixtureFavorites,
  fixtureItemShares,
  fixtureListing,
  fixtureMarkdown,
  fixtureMine,
  fixtureOpened,
  fixturePage,
  fixtureSearch,
  fixtureShareAccess,
  fixtureShares,
  fixtureTrash,
  fixtureVersions,
} from "./files-screen.fixture";

// A person works in a folder of Files on v2: opens folders and files in place, sorts, searches, chooses entries and
// renames, moves and trashes them, on a desktop and on a phone. The test stands in for the server: the page and the
// Files API answer from the same invented folders.
const ui = resolve(import.meta.dir, "../../../ui");
const uiDist = resolve(ui, "dist");
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

/** Pins the page's Date to an instant from which it flows on; runs in the page before its scripts. */
const pinPageClock = (at: number) => {
  const RealDate = Date;
  const offset = at - RealDate.now(); // real clock: the page's distance to the pinned instant
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0)
        super(RealDate.now() + offset); // real clock: flows from the pinned instant
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now() {
      return RealDate.now() + offset; // real clock: flows from the pinned instant
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
};

type View = { width: number; height: number; touch: boolean; name: string };
const wide: View = { width: 1440, height: 900, touch: false, name: "1440" };
const narrow: View = { width: 1024, height: 768, touch: false, name: "1024" };
const phone: View = { width: 390, height: 844, touch: true, name: "390" };

// The Cloud shell around the screen, as the approved mockup draws it: the tinted page of Files, the icon rail with
// its apps, the screen as one white card; on the phone the shell's bar on top. Test frame only, never product CSS.
const SHELL_APPS = ["home", "mail", "layout-kanban", "folders", "table", "notebook", "messages", "address-book"];
const shell =
  `<style>html,body{height:100%;margin:0}` +
  `body{background:linear-gradient(135deg,color-mix(in srgb,#2563eb 11%,#fafafa),color-mix(in srgb,#60a5fa 7%,#fafafa))}` +
  `#root{position:fixed;inset:8px 8px 8px 64px;display:flex;border-radius:14px;overflow:hidden;background:#fff;` +
  `box-shadow:0 0 0 1px rgb(9 9 11/.07),0 1px 3px rgb(9 9 11/.05)}` +
  `.shell-rail{position:fixed;left:0;top:8px;bottom:8px;width:56px;display:flex;flex-direction:column;align-items:center;gap:4px;padding:4px 0}` +
  `.shell-rail b{width:32px;height:32px;border-radius:8px;background:#09090b;color:#fff;display:grid;place-items:center;font:600 13px system-ui;margin-bottom:14px}` +
  `.shell-rail i{width:36px;height:36px;border-radius:8px;display:grid;place-items:center;color:#52525b;font-size:19px}` +
  `.shell-rail i.on{background:#fff;color:#1d4ed8;box-shadow:0 0 0 1px rgb(9 9 11/.07)}.shell-rail span{flex:1}` +
  `.shell-rail em{width:28px;height:28px;border-radius:50%;background:#0f766e;color:#fff;display:grid;place-items:center;font:600 11px system-ui;font-style:normal}` +
  `.shell-bar{display:none}` +
  `@media (max-width:767px){#root{inset:52px 0 0 0;border-radius:0;box-shadow:none}.shell-rail{display:none}` +
  `.shell-bar{position:fixed;inset:0 0 auto 0;height:52px;display:flex;align-items:center;gap:12px;padding:0 16px;font:600 15px system-ui;color:#09090b}` +
  `.shell-bar i{font-size:20px;color:#52525b}}</style>` +
  `<nav class="shell-rail" aria-hidden="true"><b>C</b>${SHELL_APPS.map((app) => `<i class="ti ti-${app}${app === "folders" ? " on" : ""}"></i>`).join("")}<span></span><i class="ti ti-help-circle"></i><em>MS</em></nav>` +
  `<div class="shell-bar" aria-hidden="true"><i class="ti ti-menu-2"></i>Dateien</div>`;
const page = (fixture: FixtureCase) =>
  `<!doctype html><html lang="de" class="light" data-fixture="${fixture}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  // Cloud's typeface as Core serves it (IBM Plex); without it the page falls back to the system font.
  `<link rel="stylesheet" href="${origin}/public/fonts.css">` +
  `<style>${css}</style></head>` +
  `<body class="k2b-ui k2-ui">${shell}<div id="root"></div><script src="/harness.js"></script></body></html>`;

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
  // The fixtures carry dates: the page's Date flows from the fixture's "now", also after a navigation in place. Only
  // Date is pinned; timers and animation frames stay real (rule test-clock).
  await context.addInitScript(pinPageClock, Date.parse(FIXTURE_NOW));
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
      if (url.pathname.endsWith("/revoke")) {
        const id = url.pathname.split("/").at(-2);
        const share = fixtureShares(fixture).items.find((item) => item.id === id);
        return route.fulfill({ json: { ...share, state: "revoked" } });
      }
      if (url.pathname === `${api}/bases/demo/editor`) return route.fulfill({ json: fixtureMarkdown(origin) });
      return route.fulfill({ status: 404, json: { code: "not_found", message: "Nicht gefunden" } });
    }
    if (url.pathname === `${api}/bases`) return route.fulfill({ json: { items: fixtureBases, issues: [], editor: null } });
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
      // The file the editor shows exists in every fixture.
      const edited = fixtureMarkdown(origin).entry;
      if (path === edited.path) return route.fulfill({ json: { base: fixtureBase, entry: edited, favorite: false } });
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
    // An item's own history stays empty; Activity answers with the day of the fixture.
    if (url.pathname === `${api}/activity`)
      // "me" is answered as the server answers it: the person's own changes only.
      return route.fulfill({
        json: url.searchParams.get("scope")
          ? emptyHistory
          : url.searchParams.get("actor") === "me"
            ? fixtureMine(Number(url.searchParams.get("limit")) || undefined)
            : searched(fixtureActivity(fixture), url.searchParams.get("q")),
      });
    // the detail asks for the links of its file; the overview of links asks without a path
    if (url.pathname === `${api}/shares`)
      return route.fulfill({
        json: url.searchParams.get("path") ? fixtureItemShares(url.searchParams.get("path")!) : fixtureShares(fixture),
      });
    if (url.pathname === `${api}/bases/demo/versions`) return route.fulfill({ json: fixtureVersions() });
    // the trashed file of the search can come back from the trash, as the server checks it now
    if (url.pathname.startsWith(`${api}/activity/`) && url.pathname.endsWith("/recovery"))
      return route.fulfill({
        json: {
          oldLocation: { baseId: fixtureBase.id, path: "Angebote" },
          trash: { baseId: fixtureBase.id, id: "t-1", canRestore: true },
          canMoveBack: false,
        },
      });
    if (url.pathname.startsWith(`${api}/shares/`) && url.pathname.endsWith("/access"))
      return route.fulfill({ json: fixtureShareAccess(url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "") });
    if (url.pathname === `${api}/recent`) return route.fulfill({ json: fixture === "plain" ? fixtureOpened() : [] });
    // a photo's preview is an invented picture in its own colours; other kinds have none here
    if (url.pathname.startsWith(`${api}/bases/demo/preview`)) {
      const path = url.searchParams.get("path") ?? "";
      if (!/\.(jpe?g|png)$/i.test(path)) return route.fulfill({ status: 404, json: { code: "preview_unavailable" } });
      const hue = [...path].reduce((sum, sign) => sum + sign.charCodeAt(0), 0) % 360;
      const picture = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 45% 78%)"/><stop offset="1" stop-color="hsl(${hue} 35% 52%)"/></linearGradient></defs><rect width="480" height="360" fill="url(#s)"/><rect x="60" y="150" width="360" height="170" rx="6" fill="hsl(${(hue + 30) % 360} 30% 40%)"/><rect x="90" y="180" width="140" height="110" fill="hsl(${(hue + 30) % 360} 25% 70%)"/><rect x="250" y="180" width="140" height="110" fill="hsl(${(hue + 30) % 360} 25% 66%)"/></svg>`;
      return route.fulfill({ contentType: "image/svg+xml", body: picture });
    }
    if (url.pathname === "/content")
      return route.fulfill({
        contentType: "text/plain; charset=utf-8",
        headers: { "access-control-allow-origin": "*" },
        // a working note long enough to fill the editor, as a real one does
        body: "# Notizen\n\nZuschnitt Küchenfront bis Freitag. Eiche geölt, 19 mm.\n\n- Maße prüfen\n- Kanten bestellen\n\n## Küche Lindqvist\n\nAufmaß am Dienstag mit Frau Lindqvist. Die Nische links ist 4 mm schmaler als im Plan, die Hochschränke rücken deshalb nach rechts.\n\n- Arbeitsplatte Granit, 38 mm, Kante gefast\n- Spüle als Unterbau, Ausschnitt nach Schablone\n- Sockel 100 mm, Lüftungsgitter unter dem Backofen\n\n## Material\n\n| Teil | Menge | Lieferant |\n| --- | --- | --- |\n| Eiche Dreischicht 19 mm | 6 Platten | Holzhandel Sommer |\n| Topfbänder 110° | 24 | Beschläge Thal |\n| Vollauszüge 500 mm | 8 | Beschläge Thal |\n| Hartwachsöl | 2,5 l | Lager |\n\n## Termine\n\n1. Fronten ölen: Mittwoch und Donnerstag\n2. Montage: Montag ab 7:30, zu zweit\n3. Abnahme mit der Kundin: Dienstag Nachmittag\n\n> Rückruf von Frau Lindqvist: Griffleisten lieber in Schwarz.\n\n## Offen\n\n- [ ] Muster Arbeitsplatte zurückgeben\n- [ ] Rechnung Teilzahlung schreiben\n- [x] Fotos vom Bestand ablegen\n",
      });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/public/fonts.css") return route.fulfill({ contentType: "text/css", path: join(uiDist, "plex.css") });
    if (url.pathname.startsWith("/public/fonts/") && !url.pathname.includes(".."))
      return route.fulfill({ contentType: "font/woff2", path: join(uiDist, "fonts", url.pathname.slice("/public/fonts/".length)) });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${address}`);
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, seen };
};

/** A search answers as the server does: only changes whose current or earlier name or place holds the words. */
const searched = (page: ActivityPage, q: string | null): ActivityPage => {
  const words = q?.trim().toLocaleLowerCase();
  if (!words) return page;
  const sides = (item: ActivityPage["items"][number]) =>
    [item.before, item.after].map((side) => ("path" in side && side.path ? side.path : "").toLocaleLowerCase());
  return { ...page, items: page.items.filter((item) => sides(item).some((path) => path.includes(words))) };
};

/** The names of the rows the folder shows, in order. */
const names = (tab: Page) =>
  tab
    .locator("[data-k2-part=Table] tbody tr:not([data-group]) td:nth-child(2) .k2-cell-line")
    .evaluateAll((cells) => cells.map((cell) => (cell.textContent ?? "").trim()));
const rowLink = (tab: Page, name: string) => tab.locator("[data-k2-part=Table] tbody tr .k2-row-open").filter({ hasText: name }).first();
const shoot = async (tab: Page, name: string) => {
  if (!shots) return;
  // the picture shows the page at rest: the focus a click left stays out of it, the open row shows its tint
  await tab.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await tab.mouse.move(0, 0);
  await tab.screenshot({ path: join(shots, `files-v2-${name}.png`) });
};
/**
 * Parts of a row that cover each other: its time under its deed or its "…", a deed over the time (error class "row
 * action without reserved space", found by the design review 26.11.). Empty when every row keeps its parts apart.
 */
const rowOverlaps = (tab: Page) =>
  tab.evaluate(() => {
    const found: string[] = [];
    const meet = (a: DOMRect, b: DOMRect) =>
      a.width > 0 && b.width > 0 && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    for (const row of document.querySelectorAll<HTMLElement>("[data-k2-part=Row]")) {
      const time = row.querySelector(":scope > .k2-row-time, .k2-row-time");
      if (!time) continue;
      const box = time.getBoundingClientRect();
      for (const part of row.querySelectorAll<HTMLElement>(".k2-row-end, button:not(.k2-row-open), a.k2-btn"))
        if (!part.contains(time) && meet(box, part.getBoundingClientRect()))
          found.push(`"${(time.textContent ?? "").trim()}" under "${(part.textContent || part.getAttribute("aria-label") || "").trim()}"`);
    }
    return found;
  });
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
        "Aufmaß",
        "Fotos",
        "Ansicht Front Eiche.jpg",
        "Bestand Küche vorher.jpg",
        "Budget 2027.xlsx",
        "Lieferplan.pdf",
        "Materialliste.xlsx",
        "Muster Arbeitsplatte Granit.jpg",
        "Notizen.md",
        "Rundgang Aufmaß.mp4",
        "Skizze Hochschrank.png",
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
      await tab.waitForFunction(() => document.querySelectorAll("[data-k2-part=Table] tbody tr:not([data-group])").length === 13);

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

  test('the detail\'s star and its "…" keep their place while the entry reads', async () => {
    const { context, tab, errors } = await open(wide, "/app/filesv2?base=demo");
    try {
      // the entry's details answer only when the test lets them
      let answer!: () => void;
      const held = new Promise<void>((resolve) => {
        answer = resolve;
      });
      await tab.route("**/api/filesv2/bases/demo/entry?*", async (route) => {
        await held;
        await route.fallback();
      });
      await rowLink(tab, "Notizen.md").click();
      const head = tab.locator("[data-k2-part=Pane][data-detail] [data-slot=head]");
      await head.getByText("Notizen.md").waitFor();
      const places = () =>
        Promise.all(
          [head.getByRole("button", { name: "Zu Favoriten hinzufügen" }), head.getByRole("button", { name: "Weitere Aktionen" })].map(
            (button) => button.boundingBox(),
          ),
        );
      const before = await places();
      expect(before.every(Boolean)).toBe(true);
      expect(await head.getByRole("button", { name: "Zu Favoriten hinzufügen" }).isDisabled()).toBe(true);
      answer();
      await tab.getByText("Eigenschaften").waitFor();
      expect(await head.getByRole("button", { name: "Zu Favoriten hinzufügen" }).isDisabled()).toBe(false);
      expect(await places()).toEqual(before);
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
            ...document.querySelectorAll("[data-k2-part=Table] tbody tr:not([data-group]) td:nth-child(2) .k2-cell-line"),
          ][3]?.textContent?.trim() === "Rundgang Aufmaß.mp4",
      );
      const sorted = await names(tab);
      expect(sorted.slice(0, 4)).toEqual(["Angebote", "Fotos", "Aufmaß", "Rundgang Aufmaß.mp4"]);
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
      expect(await tab.locator("[data-k2-part=FilterBar]").innerText()).toContain("3 Treffer");
      await shoot(tab, "03-search-1440");
      await field.focus();
      await field.press("Escape");
      await tab.waitForFunction(() => !new URL(location.href).searchParams.get("q"));
      await tab.waitForFunction(() => document.querySelectorAll("[data-k2-part=Table] tbody tr:not([data-group])").length === 13);
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
      // a chosen row wears the selection's tint, an unchosen one none, in light and in dark (the guard of #1543, now on
      // the v2 table): Ansicht and Bestand are not chosen, Budget is
      const tints: string[] = [];
      for (const theme of ["light", "dark"]) {
        await tab.evaluate((theme) => {
          document.documentElement.className = theme;
        }, theme);
        await settled(tab);
        const fills = await tab.evaluate(() =>
          [...document.querySelectorAll("[data-k2-part=Table] tbody tr:not([data-group])")]
            .slice(3, 6)
            .map((row) => [row, row.querySelector("td")!].map((part) => getComputedStyle(part).backgroundColor).join(" ")),
        );
        expect(fills[0], theme).toBe(fills[1]);
        expect(fills[2], theme).not.toBe(fills[0]);
        tints.push(fills[2]!);
      }
      // the dark tint is a tint of its own, not the light one on a dark page
      expect(tints[1]).not.toBe(tints[0]);
      await tab.evaluate(() => {
        document.documentElement.className = "light";
      });
      await settled(tab);
      for (const deed of ["Verschieben nach …", "In den Papierkorb"])
        expect(await status.getByRole("button", { name: deed }).count()).toBe(1);
      await shoot(tab, "04-selection-1440");
      await status.getByRole("button", { name: /Auswahl aufheben/ }).click();
      // the filter row with the count comes back in its place
      await tab
        .locator("[data-k2-part=FilterBar]")
        .getByText(/Einträge ·/)
        .waitFor();

      // One chosen entry adds rename and duplicate to the deeds of the selection.
      await tab.getByRole("checkbox", { name: /Notizen\.md/ }).check();
      await tab.locator("[data-k2-part=StatusRow]").getByRole("button", { name: "Umbenennen" }).click();
      const name = tab.getByRole("dialog").getByRole("textbox").last();
      await name.fill("Notizen neu.md");
      await name.press("Enter");
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("file") === "Notizen neu.md");
      expect(seen.posts.at(-1)).toEqual({ path: "/bases/demo/rename", body: { path: "Notizen.md", name: "Notizen neu.md" } });

      await tab.getByRole("checkbox", { name: /Lieferplan\.pdf/ }).check();
      await tab.locator("[data-k2-part=StatusRow]").getByRole("button", { name: "In den Papierkorb" }).click();
      await tab.getByRole("alertdialog").or(tab.getByRole("dialog")).getByRole("button", { name: "In den Papierkorb" }).click();
      await tab.waitForFunction(() => document.querySelector("[role=status], [role=alert]") !== null);
      expect(seen.posts.at(-1)).toEqual({ path: "/bases/demo/delete", body: { paths: ["Lieferplan.pdf"] } });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  for (const view of [wide, narrow, phone])
    test(`a deep folder folds its path and keeps the head's deeds at ${view.name}px`, async () => {
      const deep = ["Projekte", "Küche Lindqvist", "Angebote", "2026", "Entwürfe", "Alte Stände"].join("/");
      const { context, tab, errors } = await open(view, `/app/filesv2?base=demo&path=${encodeURIComponent(deep)}`);
      try {
        const path = tab.locator("[data-slot=head] [data-k2-part=Path]");
        await path.getByText("Alte Stände").waitFor();
        // the places between fold into one "…" menu; the first place and the last two stand
        if (view !== phone) expect(await path.getByRole("button", { name: "Übergeordnete Ebenen" }).count()).toBe(1);
        await shoot(tab, `22-deep-folder-${view.name}`);
        await expectClean(tab);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });

  test("the grid asks for the preview of a photo only once its tile comes into view", async () => {
    // a short window: about two rows of tiles in view, six tiles to a row
    const { context, tab, errors, seen } = await open({ ...wide, height: 500 }, "/app/filesv2?base=demo", "huge");
    try {
      await tab.locator("[data-k2-part=FilterBar]").getByRole("button", { name: /Liste/ }).click();
      await tab.getByRole("menuitemradio", { name: "Raster" }).click();
      await tab.locator("[data-k2-part=Tiles] > [role=listitem]").first().waitFor();
      // the grid's own (large) previews; the list asked for its small ones before the switch
      const previews = () => seen.api.filter((request) => request.includes("/preview?") && request.includes("size=large"));
      const asked = (name: string) => previews().some((request) => request.includes(name.replaceAll(" ", "+")));
      await tab.waitForFunction(() => document.querySelector("[data-k2-part=Tiles] img") !== null);
      // the page holds 50 entries, 21 of them photos: only those of the rows in view and the next are asked for
      const first = previews().length;
      expect(first).toBeGreaterThan(0);
      expect(first).toBeLessThanOrEqual(10);
      expect(asked("Beleg 0009.jpg")).toBe(true);
      // jumping to the end asks for the last rows' photos, never for those of the rows jumped over
      await tab.locator("[data-k2-part=Tiles] > [role=listitem]").last().scrollIntoViewIfNeeded();
      // the last rows ask for theirs (the next page may have come in under them), never those jumped over
      for (let wait = 0; wait < 50 && previews().length <= first; wait++)
        await tab.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
      expect(previews().length).toBeGreaterThan(first);
      expect(asked("Beleg 0031.jpg")).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("the grid shows the folder as pictures and chooses entries as the list does", async () => {
    const { context, tab, errors } = await open(wide, "/app/filesv2?base=demo");
    try {
      await tab.locator("[data-k2-part=FilterBar]").getByRole("button", { name: /Liste/ }).click();
      await tab.getByRole("menuitemradio", { name: "Raster" }).click();
      await tab.locator("[data-k2-part=Tiles]").waitFor();
      expect(await tab.locator("[data-k2-part=Tiles] > [role=listitem]").count()).toBe(13);
      await shoot(tab, "04b-grid-1440");
      await tab.getByRole("checkbox", { name: /Ansicht Front Eiche\.jpg/ }).check();
      await tab.getByRole("checkbox", { name: /Skizze Hochschrank\.png/ }).check();
      await tab
        .locator("[data-k2-part=StatusRow]")
        .getByText(/2 ausgewählt/)
        .waitFor();
      await shoot(tab, "04c-grid-selection-1440");
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
      // The table keeps only the rows in view in the page; it says how many it holds (with its head and group rows).
      const held = () =>
        tab
          .locator("[data-k2-part=Table] table")
          .first()
          .evaluate((table) => Number(table.getAttribute("aria-rowcount")));
      const rendered = () => tab.locator("[data-k2-part=Table] tbody tr:not([data-group]) .k2-row-open").count();
      expect(await held()).toBeGreaterThanOrEqual(51);
      // the head counts the links of the loaded page only, so with more pages it says so: a lower bound
      expect(await tab.locator("[data-slot=head] [data-k2-part=Chip]").first().innerText()).toMatch(/^Team \+ \d+\+ Links$/);
      const nodes = await tab.evaluate(() => document.querySelectorAll("*").length);
      await shoot(tab, "08-huge-1440");
      const more = tab.getByRole("button", { name: "Mehr laden", exact: true });
      const grown = performance.now();
      for (const count of [100, 150, 200]) {
        await more.click();
        await tab.waitForFunction(
          (expected) => Number(document.querySelector("[data-k2-part=Table] table")?.getAttribute("aria-rowcount")) >= expected + 1,
          count,
        );
      }
      const after = await tab.evaluate(() => document.querySelectorAll("*").length);
      console.info(
        `files huge fixture: first page ready in ${Math.round(ready)} ms with ${nodes} DOM nodes; 200 rows held after ${Math.round(performance.now() - grown)} ms with ${after} DOM nodes and ${await rendered()} rows in the page`,
      );
      expect(await rendered()).toBeLessThan(100);
      expect(after).toBeLessThan(nodes * 2);
      expect(ready).toBeLessThan(5000);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe("the views beside the folders on v2", () => {
  test("Activity, the shares and all storage open in place from the sidebar, each with its data, and the way back is Back", async () => {
    const { context, tab, errors, seen } = await open(wide, "/app/filesv2?base=demo");
    try {
      const nav = tab.locator("[data-k2-part=Nav]");
      await nav.getByRole("link", { name: "Aktivität" }).click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("view") === "activity");
      await tab.getByText("Ansicht Front Eiche.jpg").first().waitFor();
      // "Me" is where Activity starts; six photos of one person at one time read as one line.
      expect(new URL(tab.url()).searchParams.get("who")).toBe("me");
      expect(await tab.locator("[data-k2-part=List][aria-label='Aktivität']").innerText()).toContain("6 Dateien hochgeladen");
      await shoot(tab, "12-activity-1440");
      await expectClean(tab);

      await nav.getByRole("link", { name: "Freigaben" }).click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("view") === "shares");
      await tab.getByText("Unterlagen Lindqvist").first().waitFor();
      await shoot(tab, "13-shares-1440");
      await expectClean(tab);

      await nav.getByRole("link", { name: "Alle Ablagen" }).click();
      await tab.waitForFunction(() => !new URL(location.href).search);
      await tab.locator("[data-k2-part=List][aria-label='Zuletzt geöffnet'] [data-k2-part=Row]").first().waitFor();
      // the storages are the sidebar's; the page does not list them a second time (Valentin 26.11.)
      expect(await tab.locator("[data-k2-part=List][aria-label='Alle Ablagen']").count()).toBe(0);
      // beside the storages, the viewer's own last changes in the row design of Activity, under their day
      const recent = tab.locator("[data-k2-part=List][aria-label='Zuletzt von dir']");
      expect(await recent.innerText()).toContain("Ansicht Front Eiche.jpg");
      expect(await recent.locator("[data-k2-part=Row] [data-k2-part=Avatar]").count()).toBe(0);
      await shoot(tab, "14-overview-1440");
      await expectClean(tab);

      await tab.goBack();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("view") === "shares");
      await tab.goBack();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("view") === "activity");
      await tab.getByText("Ansicht Front Eiche.jpg").first().waitFor();
      // Every step stayed on the first page load.
      expect(seen.pages).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  // Guard of the error class "row action without reserved space": no time stands under a deed or a "…", on any row.
  for (const view of [wide, phone])
    for (const fixture of ["plain", "worst", "huge"] as const)
      test(`Activity rows keep their time apart from their deeds at ${view.name}px (${fixture})`, async () => {
        const { context, tab, errors } = await open(view, "/app/filesv2?view=activity", fixture);
        try {
          expect(await rowOverlaps(tab)).toEqual([]);
          if (fixture === "huge") {
            await tab.evaluate(() => {
              const column = [...document.querySelectorAll<HTMLElement>(".k2-scroll")].find(
                (element) => element.scrollHeight > element.clientHeight,
              );
              if (column) column.scrollTop = column.scrollHeight / 2;
            });
            await tab.waitForTimeout(150);
            expect(await rowOverlaps(tab)).toEqual([]);
          }
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      });

  test("Activity's search finds a vanished file in the address, and a link is revoked after a question", async () => {
    const { context, tab, errors, seen } = await open(wide, "/app/filesv2?view=activity");
    try {
      const field = tab.getByRole("searchbox").first();
      await field.fill("Alter Entwurf");
      await field.press("Enter");
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("q") === "Alter Entwurf");
      await tab.getByText("Alter Entwurf.pdf").first().waitFor();
      expect(seen.api.some((request) => request.startsWith("GET /activity") && request.includes("q=Alter"))).toBe(true);
      await shoot(tab, "15-activity-search-1440");
      await expectClean(tab);

      await tab.locator("[data-k2-part=Nav]").getByRole("link", { name: "Freigaben" }).click();
      await tab.getByText("Unterlagen Lindqvist").first().waitFor();
      // the status column says the state only; revoking is a deed of the row's "…"
      expect(await tab.getByRole("button", { name: "Link widerrufen" }).count()).toBe(0);
      await tab.locator("[data-k2-part=Table]").getByRole("button", { name: "Aktionen für Unterlagen Lindqvist" }).click();
      await tab.getByRole("menuitem", { name: "Link widerrufen" }).click();
      await tab.getByRole("alertdialog").getByRole("button", { name: "Widerrufen" }).click();
      await tab.waitForFunction(() => document.body.textContent?.includes("Freigabe widerrufen."));
      // the question opened from a menu entry is really answered: the link is revoked through the API
      expect(seen.posts.at(-1)?.path).toMatch(/^\/shares\/.+\/revoke$/);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("an editor with unsaved changes asks before the sidebar leads away, and staying keeps the draft", async () => {
    const { context, tab, errors } = await open(wide, "/app/filesv2?base=demo&file=Notizen.md&view=edit");
    try {
      const editor = tab.locator("textarea, [contenteditable=true]").first();
      await editor.waitFor();
      await tab.getByText("Alles gespeichert").first().waitFor();
      await shoot(tab, "16-editor-1440");
      await expectClean(tab);
      // on a v2 page the editor's counts read as its meta text: 12 px in the page's typeface, not 10 px mono
      const stats = await tab
        .locator(".k2b-markdown-editor__stats")
        .evaluate((element) => [getComputedStyle(element).fontSize, getComputedStyle(element).fontFamily]);
      expect(stats[0]).toBe("12px");
      expect(stats[1]).toContain("IBM Plex Sans");
      // one bar (Valentin 26.11.): the head names the file alone, small, with its draft's state; the place is the
      // sidebar's active entry; no title row of the editor's own
      expect((await tab.locator("[data-slot=head] [data-k2-part=Path]").innerText()).trim()).toBe("Notizen.md");
      expect(await tab.locator("[data-slot=head] [data-k2-part=Chip]").innerText()).toBe("Alles gespeichert");
      expect(await tab.locator("[data-k2-part=Pane] [data-slot=status]").count()).toBe(0);
      // saving and closing end the editor's own bar, which every width shows; saving waits for a change
      const save = tab.locator("[role=toolbar]").getByRole("button", { name: "Speichern" });
      expect(await save.isDisabled()).toBe(true);
      // no close of its own: the sidebar marks the file's place and leads back there
      expect(await tab.locator("[role=toolbar]").getByRole("button", { name: "Schließen" }).count()).toBe(0);
      expect(await tab.locator("[data-k2-part=Nav] [aria-current=page]").innerText()).toContain("Werkstatt");
      await editor.click();
      await tab.keyboard.type(" Neu.");
      await tab.getByText("Ungespeicherte Änderungen").first().waitFor();
      expect(await save.isDisabled()).toBe(false);
      await tab.locator("[data-k2-part=Nav]").getByRole("link", { name: "Favoriten" }).click();
      const question = tab.getByRole("dialog").or(tab.getByRole("alertdialog")).last();
      await question.waitFor();
      await question.getByRole("button", { name: /Abbrechen/ }).click();
      expect(new URL(tab.url()).searchParams.get("view")).toBe("edit");
      await tab.locator("[data-k2-part=Nav]").getByRole("link", { name: "Favoriten" }).click();
      await tab
        .getByRole("dialog")
        .or(tab.getByRole("alertdialog"))
        .last()
        .getByRole("button", { name: /Bestätigen/ })
        .click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("view") === "favorites");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("an old folder address says where its folder went instead of not found", async () => {
    const { context, tab, errors } = await open(wide, "/app/filesv2?base=demo&path=Alte+Angebote");
    try {
      await tab.getByText("Dieser Ordner ist umgezogen", { exact: false }).first().waitFor();
      expect(await tab.getByRole("link", { name: /Verlauf ansehen/ }).count()).toBeGreaterThan(0);
      // under the card, what the folder holds at its new place, each entry leading there
      await tab.getByText("Preisliste 2025.pdf").waitFor();
      expect(await tab.getByRole("link", { name: /Preisliste 2025\.pdf/ }).getAttribute("href")).toContain("Archiv%2F2025%2FAlte+Angebote");
      await shoot(tab, "17-moved-1440");
      await expectClean(tab);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  for (const address of [
    "/app/filesv2?view=activity&who=me",
    "/app/filesv2?view=shares",
    "/app/filesv2",
    "/app/filesv2?base=demo&file=Notizen.md&view=edit",
  ])
    test(`${address} fits the phone`, async () => {
      const { context, tab, errors } = await open(phone, address);
      try {
        await shoot(tab, `18-${new URL(address, origin).searchParams.get("view") ?? "overview"}-390`);
        if (address.includes("view=edit")) {
          // the phone's head keeps only its search: saving and closing are in the editor's own bar there too
          expect(await tab.locator("[role=toolbar]").getByRole("button", { name: "Speichern" }).isVisible()).toBe(true);
          expect(await tab.locator("[data-k2-part=Pane] [data-slot=status]").count()).toBe(0);
        }
        await expectClean(tab);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });

  for (const view of [wide, narrow, phone])
    for (const address of [
      "/app/filesv2?view=activity",
      "/app/filesv2?view=shares",
      "/app/filesv2",
      "/app/filesv2?base=demo&file=Notizen.md&view=edit",
    ])
      test(`worst-case ${new URL(address, origin).searchParams.get("view") ?? "overview"} keeps the layout whole at ${view.name}px`, async () => {
        const { context, tab, errors } = await open(view, address, "worst");
        try {
          await shoot(tab, `19-worst-${new URL(address, origin).searchParams.get("view") ?? "overview"}-${view.name}`);
          await expectClean(tab);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      });

  // Nothing yet: each view says so in its place, with its way on, and nothing breaks.
  for (const view of [wide, phone])
    for (const address of ["/app/filesv2?view=activity&who=me", "/app/filesv2?view=shares", "/app/filesv2"])
      test(`an empty ${new URL(address, origin).searchParams.get("view") ?? "overview"} says so at ${view.name}px`, async () => {
        const { context, tab, errors } = await open(view, address, "empty");
        try {
          expect(await tab.locator("[data-k2-part=Empty]").count()).toBeGreaterThan(0);
          await shoot(tab, `21-empty-${new URL(address, origin).searchParams.get("view") ?? "overview"}-${view.name}`);
          await expectClean(tab);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      });

  test("all storage of 200 storages opens at once and stays whole", async () => {
    const started = performance.now();
    const { context, tab, errors } = await open(wide, "/app/filesv2", "huge");
    try {
      const ready = performance.now() - started;
      // the storages are the sidebar's: the page lists none of them, so 200 cost it nothing
      expect(await tab.locator("[data-k2-part=List][aria-label='Alle Ablagen']").count()).toBe(0);
      console.info(`overview of 200 storages ready in ${Math.round(ready)} ms`);
      await expectClean(tab);
      expect(ready).toBeLessThan(5000);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  for (const address of ["/app/filesv2?view=activity", "/app/filesv2?view=shares"])
    test(`${address} of 1,000 entries keeps only the rows in view and scrolls to its end`, async () => {
      const started = performance.now();
      const { context, tab, errors } = await open(wide, address, "huge");
      try {
        const ready = performance.now() - started;
        const nodes = await tab.evaluate(() => document.querySelectorAll("*").length);
        const rows = await tab.locator("[data-k2-part=Row], [data-k2-part=Table] tbody tr").count();
        await shoot(tab, `20-huge-${new URL(address, origin).searchParams.get("view")}-1440`);
        // Scroll the column to its end: the last entries come into the page, the first ones leave it.
        await tab.evaluate(async () => {
          const column = [...document.querySelectorAll<HTMLElement>(".k2-scroll")].find(
            (element) => element.scrollHeight > element.clientHeight,
          );
          if (!column) throw new Error("no scrolling column");
          for (let step = 0; step < 40; step++) {
            column.scrollTop += column.clientHeight;
            await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
          }
          column.scrollTop = column.scrollHeight;
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
        const after = await tab.evaluate(() => document.querySelectorAll("*").length);
        const end = await tab.evaluate(() => document.body.textContent ?? "");
        console.info(`${address} huge: ready in ${Math.round(ready)} ms, ${rows} rows and ${nodes} nodes; ${after} nodes at the end`);
        expect(rows).toBeLessThan(200);
        expect(after).toBeLessThan(nodes * 2);
        expect(address.includes("activity") ? end.includes("Beleg 1000.pdf") : end.includes("Aufmaß Oswald")).toBe(true);
        expect(ready).toBeLessThan(5000);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
});
