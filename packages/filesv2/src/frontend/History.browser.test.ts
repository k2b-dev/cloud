import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { historyActivity, historyBase, historyChain, historyMove, historyNow, historyPage } from "./History.browser-fixtures";

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
async function open(width: number, theme: "light" | "dark", search = "", lang = "de", mountInitially = true) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: "reduce" });
  const tab = await context.newPage();
  await tab.clock.setFixedTime(new Date(historyNow));
  const errors: string[] = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  let fail = false;
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
        body: `<!doctype html><html lang="${lang}" class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/styles.css"><style>html,body,#root {height:100%;margin:0}</style></head><body class="k2b-ui" data-theme="${theme}"><div id="root">${renderHistory(url.pathname + url.search, lang)}</div>${mountInitially ? '<script src="/harness.js"></script>' : ""}</body></html>`,
      });
    const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/filesv2/activity") {
      requests.push({ query: url.search, fail });
      if (fail)
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "Temporarily unavailable", code: "unavailable" }),
        });
      return json(url.searchParams.has("q") ? historyPage([historyMove]) : historyActivity);
    }
    if (holdContacts && (url.pathname.endsWith("/chain") || url.pathname.endsWith("/recovery")))
      await new Promise<void>((resolve) => contacts.push(resolve));
    if (url.pathname.endsWith("/chain")) return json(historyChain);
    if (url.pathname.endsWith("/recovery"))
      return json({ oldLocation: { baseId: historyBase.id, path: "" }, trash: null, canMoveBack: true });
    if (url.pathname === "/api/filesv2/bases") return json({ items: [historyBase], issues: [], editor: null });
    if (url.pathname.endsWith("/recent") || url.pathname.endsWith("/favorites")) return json([]);
    const asset =
      assets[url.pathname] ?? (url.pathname.endsWith(".woff2") ? ["font/woff2", readFileSync(`${ui}dist${url.pathname}`)] : null);
    return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
  });
  await tab.goto(`http://files-history.test/app/filesv2?view=activity${search ? `&q=${encodeURIComponent(search)}` : ""}`);
  await tab.locator(".filesv2-history").waitFor();
  if (mountInitially) await tab.waitForFunction(() => document.body.dataset.ready === "true");
  await tab.evaluate(() => document.fonts.ready);
  return {
    context,
    tab,
    errors,
    requests,
    releaseContacts,
    mount: async () => {
      await tab.addScriptTag({ url: "http://files-history.test/harness.js" });
      await tab.waitForFunction(() => document.body.dataset.ready === "true");
    },
    fail: (value: boolean) => {
      fail = value;
    },
  };
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
      const serverText = await tab.locator(".filesv2-history-hit").first().innerText();
      const before = await metrics(tab);
      await mount();
      expect(await tab.locator(".filesv2-history-hit").first().innerText()).toBe(serverText);
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
