import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";
import {
  historyActivity,
  historyBase,
  historyChain,
  historyDirectory,
  historyFile,
  historyInspectorSource,
  historyMove,
  historyNow,
  historyPage,
  historySearch,
  historyVersions,
} from "./History.browser-fixtures";

// A complete item timeline with older rows, using the real FileInspector / ItemHistory path.
const inspectorHistory = historyPage(
  Array.from({ length: 6 }, (_, index) => ({
    ...historyMove,
    id: `20000000-0000-4000-8000-00000000000${index + 1}`,
    action: "file.upload" as const,
    time: `2026-10-${20 - index}T09:00:00.000Z`,
    startedAt: `2026-10-${20 - index}T09:00:00.000Z`,
    finishedAt: `2026-10-${20 - index}T09:00:00.000Z`,
    before: { visibility: "hidden" as const },
    after: {
      visibility: "full" as const,
      source: "snapshot" as const,
      name: historyFile.name,
      path: `groups/vertrieb/${historyFile.path}`,
      root: "cloud" as const,
      baseId: "10000000-0000-4000-8000-000000000001",
      publicBaseId: historyBase.id,
      relativePath: historyFile.path,
      itemId: "20000000-0000-4000-8000-000000000010",
      directory: false,
      size: historyFile.size,
      revision: null,
    },
  })),
);

const ui = new URL("../../../ui/", import.meta.url).pathname;
const appCss =
  readFileSync(new URL("../styles/app.css", import.meta.url), "utf8").replace(/^@(import|source|custom-variant)[^\n]*\n/gm, "") +
  readFileSync(new URL("../styles/history.css", import.meta.url), "utf8");
const buildHarness = async (server = false): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const entry = new URL(server ? "./history-ssr-fixture.ts" : "./history-dom-fixture.ts", import.meta.url).pathname;
  const build = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: server
        ? `import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import Fixture from "./History.browser-harness";
export const render = (source, locale) => renderToString(() => createComponent(Fixture, { source, locale }));
`
        : `import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import Fixture from "./History.browser-harness";
const target = document.getElementById("root");
// Cloud islands currently replace their server HTML on mount (the @k2b/ssr mount contract).
target.replaceChildren();
render(() => createComponent(Fixture, { source: location.pathname + location.search, locale: document.documentElement.lang }), target);
document.body.dataset.ready = "true";`,
    },
    target: server ? "node" : "browser",
    format: server ? "esm" : "iife",
    conditions: [server ? "node" : "browser"],
    plugins: [
      {
        name: "solid-files-history-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: server ? "ssr" : "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Files history harness build failed");
  return build.outputs[0]!.text();
};

const temporary = mkdtempSync(join(tmpdir(), "files-history-browser-"));
process.once("exit", () => rmSync(temporary, { recursive: true, force: true }));
const serverModule = join(temporary, "server.mjs");
writeFileSync(serverModule, await buildHarness(true));
const { render: renderHistory }: { render: (source: string, locale: string) => string } = await import(serverModule);
const harness = await buildHarness();
const assets: Record<string, [string, string | Buffer]> = {
  "/harness.js": ["text/javascript", harness],
  "/app.css": ["text/css", appCss],
  "/styles.css": ["text/css", readFileSync(`${ui}dist/styles.css`, "utf8")],
  "/tabler.css": ["text/css", readFileSync(`${ui}dist/tabler.css`, "utf8")],
};
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  rmSync(temporary, { recursive: true, force: true });
});
async function open(
  width: number,
  theme: "light" | "dark",
  search = "",
  lang = "de",
  mountInitially = true,
  inspector: boolean | "history" | "paged-history" = false,
  touch = false,
  historySize = 6,
) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: "reduce", hasTouch: touch });
  const tab = await context.newPage();
  await tab.addInitScript((at) => {
    const RealDate = Date;
    class PinnedDate extends RealDate {
      constructor(...args: ConstructorParameters<DateConstructor> | []) {
        if (args.length === 0) super(at);
        else super(...(args as ConstructorParameters<DateConstructor>));
      }
      static override now() {
        return at;
      }
    }
    globalThis.Date = PinnedDate as DateConstructor;
  }, new Date(historyNow).getTime());
  const errors: string[] = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  let fail = false;
  let recoveryFails = false;
  const recoveryRequests: { method: string; path: string; failed: boolean }[] = [];
  let holdContacts = !mountInitially;
  const contacts: (() => void)[] = [];
  const requests: { query: string; fail: boolean }[] = [];
  const releaseContacts = () => {
    holdContacts = false;
    for (const release of contacts.splice(0)) release();
  };
  await tab.route("http://files-history.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/app/filesv2")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="${lang}" class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/styles.css"><style>html,body,#root {height:100%;margin:0}${inspector ? "#root {container: k2b-app-area / inline-size; width:700px}" : ""}</style></head><body class="k2b-ui" data-theme="${theme}"><div id="root">${renderHistory(url.pathname + url.search, lang)}</div>${mountInitially ? '<script src="/harness.js"></script>' : ""}</body></html>`,
      });
    const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/filesv2/activity") {
      if (url.searchParams.get("baseId")?.startsWith("freeipa:"))
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ code: "history_unavailable", message: "History unavailable for this area" }),
        });
      if (inspector === "paged-history") {
        if (!url.searchParams.has("cursor"))
          return json({ ...historyPage(inspectorHistory.items.slice(0, 1)), next: "older-history", exhausted: false });
        return fail
          ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "unavailable" }) })
          : json(historyPage(inspectorHistory.items.slice(1, historySize)));
      }
      if (inspector) return json(inspector === "history" ? inspectorHistory : historyPage([]));
      requests.push({ query: url.search, fail });
      if (fail)
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "Temporarily unavailable", code: "unavailable" }),
        });
      return json(url.searchParams.has("q") ? historySearch : historyActivity);
    }
    if (url.pathname.endsWith("/move-back")) {
      recoveryRequests.push({ method: route.request().method(), path: url.pathname, failed: recoveryFails });
      return recoveryFails
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ message: "Recovery temporarily unavailable", code: "unavailable" }),
          })
        : json({
            base: historyBase,
            entry: { name: "Angebote 2025", path: "Angebote 2025", directory: true, size: 0, modified: historyNow },
          });
    }
    if (holdContacts && (url.pathname.endsWith("/chain") || url.pathname.endsWith("/recovery")))
      await new Promise<void>((resolve) => contacts.push(resolve));
    if (url.pathname.endsWith("/chain")) return json(historyChain);
    if (url.pathname.endsWith("/recovery"))
      return json({ oldLocation: { baseId: historyBase.id, path: "" }, trash: null, canMoveBack: true });
    if (url.pathname === "/api/filesv2/bases") return json({ items: [historyBase], issues: [], editor: null });
    if (inspector) {
      if (url.pathname.endsWith("/entries")) return json(historyDirectory);
      if (url.pathname.endsWith("/entry")) return json({ base: historyBase, entry: historyFile });
      if (url.pathname.endsWith("/versions")) return json(historyVersions);
      if (url.pathname === "/api/filesv2/shares") return json({ items: [], next: null });
      if (url.pathname.endsWith("/download"))
        return json({ url: "http://files-history.test/notes-content", method: "GET", expires: "2026-10-20T13:00:00.000Z" });
      if (url.pathname === "/notes-content") return route.fulfill({ contentType: "text/plain", body: "Current notes for review" });
    }
    if (url.pathname.endsWith("/recent") || url.pathname.endsWith("/favorites")) return json([]);
    const asset =
      assets[url.pathname] ?? (url.pathname.endsWith(".woff2") ? ["font/woff2", readFileSync(`${ui}dist${url.pathname}`)] : null);
    return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
  });
  await tab.goto(
    `http://files-history.test${inspector ? historyInspectorSource : `/app/filesv2?view=activity${search ? `&q=${encodeURIComponent(search)}` : ""}`}`,
  );
  await tab.locator(inspector ? ".filesv2-inspector-info" : ".filesv2-history").waitFor({ state: inspector ? "attached" : "visible" });
  if (mountInitially) await tab.waitForFunction(() => document.body.dataset.ready === "true");
  if (inspector && !(await tab.locator(".filesv2-inspector-info").isVisible())) {
    // A narrow desktop host parks the shared detail behind its real Details control.
    if (typeof inspector === "string") {
      await tabTo(tab, tab.getByRole("button", { name: "Details", exact: true }));
      await tab.keyboard.press("Enter");
    } else await tab.locator("[data-app-workspace-detail-toggle]").click();
    await tab.locator(".filesv2-inspector-info").waitFor();
  }
  await tab.evaluate(() => document.fonts.ready);
  return {
    context,
    tab,
    errors,
    requests,
    recoveryRequests,
    releaseContacts,
    mount: async () => {
      await tab.addScriptTag({ url: "http://files-history.test/harness.js" });
      await tab.waitForFunction(() => document.body.dataset.ready === "true");
    },
    fail: (value: boolean) => {
      fail = value;
    },
    failRecovery: (value: boolean) => {
      recoveryFails = value;
    },
  };
}

async function focused(tab: Page, target: Locator) {
  const element = await target.elementHandle({ timeout: 5_000 });
  if (!element) throw new Error(`Missing focus target: ${target}`);
  try {
    await tab.waitForFunction((element) => document.activeElement === element, element, { timeout: 5_000 });
  } finally {
    await element.dispose();
  }
}

/** Reach a named control through real Tab stops; fail after a focus cycle instead of bypassing a keyboard trap. */
async function tabTo(tab: Page, target: Locator) {
  await target.waitFor({ state: "visible" });
  const visited = await tab.evaluateHandle(() => ({ elements: new Set<Element>(), outsideStops: 0 }));
  try {
    while (!(await target.evaluate((element) => element === document.activeElement))) {
      const repeated = await visited.evaluate((seen) => {
        const active = document.activeElement;
        // Tab can cross browser chrome after a focused control was removed. While focus is outside
        // the document, activeElement is body; that is not a repeated in-page focus stop.
        if (!active || active === document.body || active === document.documentElement) return ++seen.outsideStops > 2;
        seen.outsideStops = 0;
        if (seen.elements.has(active)) return true;
        seen.elements.add(active);
        return false;
      });
      if (repeated)
        throw new Error(
          `Keyboard focus cycled without reaching ${target}; active: ${await tab.evaluate(() => document.activeElement?.outerHTML)}`,
        );
      await tab.keyboard.press("Tab");
    }
  } finally {
    await visited.dispose();
  }
}
async function metrics(tab: Page) {
  return tab.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
    return {
      overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      search: rect(".filesv2-history-search"),
      list: rect(".filesv2-history-list"),
      result: rect(".filesv2-history-result"),
      sidebar: rect(".k2b-app-workspace__sidebar"),
    };
  });
}

for (const language of [
  {
    locale: "en",
    search: "Search activity by name or old path",
    clear: "Clear search",
    retry: "Try again",
    filters: ["Storage", "Who", "What", "When"],
    moveBack: "Move back",
    history: "History",
    older: "Show 2 older",
    fewer: "Show fewer",
  },
  {
    locale: "de",
    search: "Aktivität nach Name oder altem Pfad durchsuchen",
    clear: "Suche leeren",
    retry: "Erneut versuchen",
    filters: ["Ablage", "Wer", "Was", "Wann"],
    moveBack: "Zurückverschieben",
    history: "Verlauf",
    older: "2 ältere anzeigen",
    fewer: "Weniger anzeigen",
  },
]) {
  test(`keyboard search retries and browser history preserves its storage and query in ${language.locale}`, async () => {
    const { context, tab, errors, fail } = await open(1440, "light", "", language.locale);
    try {
      const storage = tab.getByRole("button", { name: language.filters[0], exact: true });
      await tabTo(tab, storage);
      await tab.keyboard.press("Enter");
      const option = tab.getByRole("menuitemradio", { name: "Team Vertrieb", exact: true });
      await focused(tab, option);
      await tab.keyboard.press("Space");
      await tab.waitForURL((url) => url.searchParams.get("base") === historyBase.id);
      await tab.keyboard.press("Escape");
      const selectedStorage = tab.getByRole("button", { name: `${language.filters[0]}: Team Vertrieb`, exact: true });
      await focused(tab, selectedStorage);

      fail(true);
      const search = tab.getByRole("searchbox", { name: language.search, exact: true });
      await tabTo(tab, search);
      await tab.keyboard.type("Angebote 2025");
      await tab.keyboard.press("Enter");
      await tab.waitForURL((url) => url.searchParams.get("q") === "Angebote 2025");
      const address = tab.url();
      const retry = tab.getByRole("button", { name: language.retry, exact: true });
      await tabTo(tab, retry);
      fail(false);
      await tab.keyboard.press("Enter");
      await tab.getByRole("article", { name: /Angebote 2025/ }).waitFor();
      expect(tab.url()).toBe(address);
      expect(await search.inputValue()).toBe("Angebote 2025");
      expect(await selectedStorage.isVisible()).toBe(true);

      await tabTo(tab, tab.getByRole("button", { name: language.clear, exact: true }));
      await tab.keyboard.press("Space");
      await tab.waitForURL((url) => !url.searchParams.has("q"));
      await focused(tab, search);
      expect(new URL(tab.url()).searchParams.get("base")).toBe(historyBase.id);
      expect(await search.inputValue()).toBe("");
      // Browser traversal is explicit: the document interactions above use only the keyboard.
      await tab.goBack();
      await tab.getByRole("article", { name: /Angebote 2025/ }).waitFor();
      expect(tab.url()).toBe(address);
      expect(await search.inputValue()).toBe("Angebote 2025");
      expect(await selectedStorage.isVisible()).toBe(true);
      await tab.goForward();
      await tab.waitForURL((url) => !url.searchParams.has("q"));
      await tab.getByRole("article", { name: /Angebote 2025/ }).waitFor({ state: "hidden" });
      await tabTo(tab, search);
      expect(await search.inputValue()).toBe("");
      expect(new URL(tab.url()).searchParams.get("base")).toBe(historyBase.id);
      await tab.keyboard.type("clear focus check");
      await tabTo(tab, tab.getByRole("button", { name: language.clear, exact: true }));
      await tab.keyboard.press("Space");
      await focused(tab, search);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);

  test(`every history filter returns keyboard focus on Escape in ${language.locale}`, async () => {
    const { context, tab, errors } = await open(1440, "light", "", language.locale);
    try {
      const address = tab.url();
      for (const label of language.filters) {
        const trigger = tab.getByRole("button", { name: label, exact: true });
        await tabTo(tab, trigger);
        await tab.keyboard.press("ArrowDown");
        const menu = tab.getByRole("menu", { name: label, exact: true });
        const options = menu.getByRole("menuitemradio");
        await focused(tab, options.first());
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
        if ((await options.count()) > 1) {
          await tab.keyboard.press("ArrowDown");
          await focused(tab, options.nth(1));
        }
        await tab.keyboard.press("Escape");
        await menu.waitFor({ state: "hidden" });
        await focused(tab, trigger);
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        expect(tab.url()).toBe(address);
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);

  test(`a failed move-back remains keyboard-recoverable without losing search context in ${language.locale}`, async () => {
    const { context, tab, errors, failRecovery, recoveryRequests } = await open(1440, "light", "Angebote 2025", language.locale);
    try {
      const address = tab.url();
      const moveBack = tab.getByRole("button", { name: language.moveBack, exact: true });
      await tabTo(tab, moveBack);
      failRecovery(true);
      await tab.keyboard.press("Enter");
      const error = tab.getByRole("alert").filter({ hasText: "Recovery temporarily unavailable" });
      await error.waitFor();
      expect(tab.url()).toBe(address);
      expect(await tab.getByRole("searchbox", { name: language.search, exact: true }).inputValue()).toBe("Angebote 2025");

      await tabTo(tab, moveBack);
      failRecovery(false);
      const recovered = tab.waitForResponse(
        (response) => response.url().endsWith(`/activity/${historyMove.id}/move-back`) && response.request().method() === "POST",
      );
      await tab.keyboard.press("Space");
      expect((await recovered).ok()).toBe(true);
      await error.waitFor({ state: "hidden" });
      expect(recoveryRequests).toEqual([
        { method: "POST", path: `/api/filesv2/activity/${historyMove.id}/move-back`, failed: true },
        { method: "POST", path: `/api/filesv2/activity/${historyMove.id}/move-back`, failed: false },
      ]);
      expect(tab.url()).toBe(address);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);

  test(`keyboard opens the parked detail and expands and collapses item history in ${language.locale}`, async () => {
    const { context, tab, errors } = await open(1200, "light", "", language.locale, true, "history");
    try {
      const address = tab.url();
      await focused(tab, tab.getByRole("heading", { name: historyFile.name, exact: true }));
      const history = tab.getByRole("group", { name: language.history, exact: true });
      const rows = history.getByRole("article");
      const older = history.getByRole("button", { name: language.older, exact: true });
      await tabTo(tab, older);
      expect(await rows.count()).toBe(4);
      expect(await older.getAttribute("aria-expanded")).toBe("false");
      const controlledRows = await older.getAttribute("aria-controls");
      expect(controlledRows).toBeTruthy();
      expect(await history.locator("ul").getAttribute("id")).toBe(controlledRows);
      await tab.keyboard.press("Enter");
      await rows.nth(5).waitFor();
      expect(await rows.count()).toBe(6);
      const fewer = history.getByRole("button", { name: language.fewer, exact: true });
      await focused(tab, fewer);
      expect(await fewer.getAttribute("aria-expanded")).toBe("true");
      await tab.keyboard.press("Space");
      await rows.nth(4).waitFor({ state: "hidden" });
      expect(await rows.count()).toBe(4);
      await focused(tab, older);
      expect(await older.getAttribute("aria-expanded")).toBe("false");
      expect(tab.url()).toBe(address);

      await tab.keyboard.press("Escape");
      const details = tab.getByRole("button", { name: "Details", exact: true });
      await focused(tab, details);
      await history.waitFor({ state: "hidden" });
      expect(tab.url()).toBe(address);
      await tab.keyboard.press("Enter");
      await focused(tab, tab.getByRole("heading", { name: historyFile.name, exact: true }));
      await older.waitFor();
      expect(await rows.count()).toBe(4);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);
}

for (const count of [2, 6])
  test(`keyboard paging retries and keeps focus when history ends with ${count} rows`, async () => {
    const { context, tab, errors, fail } = await open(1200, "light", "", "en", true, "paged-history", false, count);
    try {
      const history = tab.getByRole("group", { name: "History", exact: true });
      const rows = history.getByRole("article");
      const older = history.getByRole("button", { name: "Show older", exact: true });
      await tabTo(tab, older);
      expect(await rows.count()).toBe(1);
      fail(true);
      await tab.keyboard.press("Enter");
      const retry = history.getByRole("button", { name: "Try again", exact: true });
      await focused(tab, retry);
      expect(await history.getByRole("alert").innerText()).toContain("Older entries could not be loaded.");
      fail(false);
      await tab.keyboard.press("Enter");
      await rows.nth(count - 1).waitFor();
      expect(await rows.count()).toBe(count);
      await retry.waitFor({ state: "hidden" });
      const fewer = history.getByRole("button", { name: "Show fewer", exact: true });
      if (count <= 4) {
        expect(await fewer.count()).toBe(0);
        await focused(tab, history.locator("ul"));
      } else {
        await focused(tab, fewer);
        await tab.keyboard.press("Space");
        await rows.nth(4).waitFor({ state: "hidden" });
        await focused(tab, history.getByRole("button", { name: "Show 2 older", exact: true }));
        expect(await rows.count()).toBe(4);
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);

for (const touch of [false, true])
  test(`file inspector follows its app container width with ${touch ? "touch" : "mouse"} input`, async () => {
    const { context, tab, errors } = await open(1200, "light", "", "en", true, true, touch);
    try {
      const host = tab.locator("#root");
      const preview = tab.locator(".filesv2-inspector-preview");
      const modified = tab.locator(".filesv2-inspector-info .k2b-description-list__item").filter({ hasText: "Modified" });
      const versions = tab.locator(".filesv2-inspector-versions");
      const count = tab
        .locator(".filesv2-inspector-info")
        .getByRole("button", { name: "View versions (2)", exact: true, includeHidden: true });
      await count.waitFor({ state: "visible" });
      await preview.waitFor({ state: "attached" });
      await versions.waitFor({ state: "attached" });
      expect(await host.evaluate((element) => getComputedStyle(element).containerName)).toBe("k2b-app-area");
      expect(await tab.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(touch);
      expect(await tab.locator(".filesv2-inspector .k2b-detail-panel__body").evaluate((element) => getComputedStyle(element).rowGap)).toBe(
        "16px",
      );
      expect(await host.evaluate((element) => element.getBoundingClientRect().width)).toBe(700);
      expect(await tab.evaluate(() => innerWidth)).toBe(1200);
      expect(await preview.isVisible()).toBe(false);
      expect(await versions.isVisible()).toBe(false);
      expect(await versions.getAttribute("data-open")).toBeNull();
      expect(await count.innerText()).toBe("2");
      expect(await modified.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(30);
      expect(await count.getAttribute("aria-expanded")).toBe("false");

      await count.click();
      await versions.waitFor({ state: "visible" });
      expect(await count.getAttribute("aria-expanded")).toBe("true");
      const rowHeight = await versions
        .locator("button.k2b-detail-panel__action")
        .first()
        .evaluate((element) => element.getBoundingClientRect().height);
      if (touch) expect(rowHeight).toBeGreaterThanOrEqual(44);
      else expect(rowHeight).toBeLessThanOrEqual(32);
      expect(await versions.getByText("Initial draft · Mia Weber", { exact: true }).isVisible()).toBe(true);
      expect(await preview.isVisible()).toBe(false);
      await count.click();
      await versions.waitFor({ state: "hidden" });
      expect(await versions.getAttribute("data-open")).toBeNull();

      // Only the host grows: a viewport media query would leave the initial compact assertions failing.
      await host.evaluate((element) => {
        element.style.width = "900px";
      });
      await preview.waitFor({ state: "visible" });
      await versions.waitFor({ state: "visible" });
      await count.waitFor({ state: "hidden" });
      expect(await versions.getByText("Initial draft · Mia Weber", { exact: true }).isVisible()).toBe(true);
      // The current version has no menu, yet its date ends on the same edge as the dates of older versions.
      const dateEdges = await versions
        .locator("time")
        .evaluateAll((times) => times.map((time) => Math.round(time.getBoundingClientRect().right)));
      expect(dateEdges).toHaveLength(2);
      expect(Math.abs(dateEdges[0]! - dateEdges[1]!)).toBeLessThanOrEqual(1);
      expect(await versions.getAttribute("data-open")).toBeNull();
      expect(await host.evaluate((element) => element.getBoundingClientRect().width)).toBe(900);
      expect(await modified.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(30);
      expect(await tab.evaluate(() => innerWidth)).toBe(1200);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);
for (const width of [1440, 768, 390])
  for (const theme of ["light", "dark"] as const)
    test(`history and vanished folder fit ${width}px ${theme}`, async () => {
      const { context, tab, errors } = await open(width, theme);
      try {
        await tab.locator(".filesv2-history-row").first().waitFor();
        expect((await metrics(tab)).overflow).toBe(0);
        if (width === 1440) {
          expect(Math.round((await metrics(tab)).search.width)).toBe(340);
          expect(Math.round((await metrics(tab)).sidebar.width)).toBe(248);
          expect((await metrics(tab)).list.width).toBeLessThanOrEqual(920);
        }
        const search = tab.getByPlaceholder("Name oder alter Pfad suchen");
        await search.fill("Angebote 2025");
        await search.press("Enter");
        await tab.waitForURL((url) => url.searchParams.get("q") === "Angebote 2025");
        await tab.locator(".filesv2-history-hit").first().waitFor();
        expect(new URL(tab.url()).searchParams.get("q")).toBe("Angebote 2025");
        expect((await metrics(tab)).overflow).toBe(0);
        expect((await metrics(tab)).result.width).toBeLessThanOrEqual(760);
        await tab.reload();
        await tab.locator(".filesv2-history-hit").first().waitFor();
        expect(await search.inputValue()).toBe("Angebote 2025");
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 30_000);
test("a failed search keeps its address and retries in place", async () => {
  const { context, tab, errors, fail, requests } = await open(1440, "light", "", "en");
  try {
    fail(true);
    const search = tab.getByPlaceholder("Search name or old path");
    await search.fill("Angebote 2025");
    await search.press("Enter");
    await tab.waitForURL((url) => url.searchParams.get("q") === "Angebote 2025");
    await tab.getByRole("button", { name: "Try again", exact: true }).waitFor();
    expect(new URL(tab.url()).searchParams.get("q")).toBe("Angebote 2025");
    fail(false);
    await tab.getByRole("button", { name: "Try again", exact: true }).click();
    await tab
      .locator(".filesv2-history-hit")
      .first()
      .waitFor({ timeout: 5_000 })
      .catch(async (cause) => {
        throw new Error(JSON.stringify({ requests, errors, text: await tab.locator("body").innerText() }), { cause });
      });
    expect(await search.inputValue()).toBe("Angebote 2025");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 30_000);

for (const width of [1440, 390])
  test(`history preserves the server result through the client mount at ${width}px`, async () => {
    const { context, tab, errors, mount, releaseContacts } = await open(width, "light", "Angebote 2025", "de", false);
    try {
      // WebKit adds line breaks for empty live DOM boxes differently from parsed SSR. Compare the same
      // words and their measured geometry, independently of that engine-specific whitespace serialization.
      const text = async () => (await tab.locator(".filesv2-history-hit").first().textContent())?.replace(/\s+/g, " ").trim();
      const serverText = await text();
      const before = await metrics(tab);
      await mount();
      expect(await text()).toBe(serverText);
      const after = await metrics(tab);
      expect(after.overflow).toBe(0);
      expect(Math.abs(after.result.width - before.result.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.search.width - before.search.width)).toBeLessThanOrEqual(1);
      // Fresh contact data arrives after the first client render and may update its loading state.
      releaseContacts();
      await tab.getByRole("button", { name: "Dorthin springen", exact: true }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      releaseContacts();
      await context.close();
    }
  }, 30_000);

for (const width of [1440, 390])
  test(`other search hits keep their restore action visible and phone buttons are 42px at ${width}px`, async () => {
    const { context, tab, errors } = await open(width, "light", "Angebote 2025");
    try {
      const restore = tab.locator(".filesv2-history-section").getByRole("button", { name: "Wiederherstellen", exact: true });
      await restore.waitFor();
      await tab.mouse.move(0, 0);
      await settled(tab);
      // Without hover or focus: the row's action is the reason the row is shown.
      expect(await restore.evaluate((button) => getComputedStyle(button.closest(".filesv2-history-row__action")!).opacity)).toBe("1");
      if (width === 390) {
        await tab.getByRole("button", { name: "Dorthin springen", exact: true }).waitFor();
        const heights = await tab
          .locator(".filesv2-history-hit__buttons .k2b-button")
          .evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().height)));
        expect(heights.length).toBeGreaterThanOrEqual(1);
        for (const height of heights) expect(height).toBe(42);
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);

test("phone activity keeps the menu beside the search and never leaves a dot at a line edge", async () => {
  const { context, tab, errors } = await open(390, "light");
  try {
    await tab.locator(".filesv2-history-row").first().waitFor();
    await tab.locator(".filesv2-history-head__filters .k2b-filter-chip").first().click();
    await tab.locator(".k2b-filter-chip__option").filter({ hasText: "Team Vertrieb" }).click();
    await tab.locator('.filesv2-history-head__filters .k2b-filter-chip[data-active="true"]').waitFor();
    await tab.waitForFunction(
      () =>
        !document
          .getAnimations()
          .some(
            (animation) =>
              animation.timeline === document.timeline &&
              animation.playState === "running" &&
              animation.effect?.getTiming().iterations !== Infinity,
          ),
    );
    const chipsFit = await tab.locator(".filesv2-history-head__filters .k2b-filter-chip").evaluateAll((chips) =>
      chips.slice(0, 4).every((chip) => {
        const rect = chip.getBoundingClientRect();
        return rect.left >= 15 && rect.right <= 375;
      }),
    );
    expect(chipsFit).toBe(true);
    const head = await tab.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const search = rect(".filesv2-history-search");
      const menu = rect(".filesv2-history-head__actions");
      const filters = rect(".filesv2-history-head__filters");
      return {
        menuBesideSearch: Math.abs(menu.top + menu.height / 2 - (search.top + search.height / 2)) <= 2 && menu.left >= search.right,
        filtersBelow: filters.top >= search.bottom,
      };
    });
    expect(head).toEqual({ menuBesideSearch: true, filtersBelow: true });
    const title = tab.locator(".filesv2-workspace--activity > .k2b-app-workspace__head .k2b-page-title");
    expect(await title.isVisible()).toBe(true);
    expect(await title.innerText()).toContain("Aktivität");
    const titleText = await title.locator(".k2b-page-title__text").evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      clips: element.scrollHeight > element.clientHeight,
    }));
    expect(titleText.clips).toBe(false);
    expect(titleText.height).toBeGreaterThanOrEqual(titleText.fontSize);
    expect(await title.evaluate((element) => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(
      await tab.locator(".filesv2-history-search").evaluate((element) => element.getBoundingClientRect().top),
    );
    // A status badge is followed by a dot like every other fact.
    expect(await tab.locator(".filesv2-history-row__lead .filesv2-history-row__dot").count()).toBeGreaterThanOrEqual(1);
    const lines = await tab.evaluate(() => {
      // A narrow text column forces the facts to wrap.
      for (const text of document.querySelectorAll<HTMLElement>(".filesv2-history-row__text")) text.style.width = "110px";
      const facts =
        "time, a, .k2b-status-badge, .filesv2-history-row__meta > span:not(.filesv2-history-row__dot, .filesv2-history-row__lead)";
      const sameLine = (a: DOMRect, b: DOMRect) => a.bottom > b.top + 1 && a.top < b.bottom - 1;
      const misplaced: string[] = [];
      let wrapped = 0;
      for (const meta of document.querySelectorAll<HTMLElement>(".filesv2-history-row__meta")) {
        if (meta.getBoundingClientRect().height > 30) wrapped++;
        const all = [...meta.querySelectorAll<HTMLElement>(facts)];
        for (const dot of meta.querySelectorAll<HTMLElement>(".filesv2-history-row__dot")) {
          const before = all.filter((fact) => fact.compareDocumentPosition(dot) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1);
          const after = all.find((fact) => dot.compareDocumentPosition(fact) & Node.DOCUMENT_POSITION_FOLLOWING);
          const own = dot.getBoundingClientRect();
          const end = before ? [...before.getClientRects()].at(-1) : undefined;
          const start = after?.getClientRects()[0];
          if (!end || !start || !sameLine(end, own) || !sameLine(start, own))
            misplaced.push(
              JSON.stringify({
                text: meta.textContent,
                html: meta.innerHTML,
                leadWhiteSpace: getComputedStyle(meta.querySelector(".filesv2-history-row__lead") ?? meta).whiteSpace,
                before: end?.toJSON(),
                dot: own.toJSON(),
                after: start?.toJSON(),
              }),
            );
        }
      }
      return { wrapped, misplaced };
    });
    expect(lines.wrapped).toBeGreaterThanOrEqual(1);
    expect(lines.misplaced).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 30_000);

for (const lang of ["de", "en"] as const) {
  for (const width of [390, 1440]) {
    test(`POSIX history notice is visible in ${lang} at ${width}px`, async () => {
      const { context, tab, errors } = await open(width, "light", "", lang);
      try {
        await tab.goto("http://files-history.test/app/filesv2?view=activity&base=freeipa:groups:10000000-0000-4000-8000-000000000001");
        const notice = tab.locator('.filesv2-history-body [role="status"]');
        await notice.waitFor({ state: "visible" });
        expect(await notice.textContent()).toContain(lang === "de" ? "Unix-Rechte" : "Unix permissions");
        expect(await tab.locator(".filesv2-history-row").count()).toBe(0);
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 30_000);
  }
}
