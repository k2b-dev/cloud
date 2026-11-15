import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";

// Where the folder picker sits and how high it opens are layout; only a real engine shows them.
const ui = new URL("../../../ui/", import.meta.url).pathname;
const appCss = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8").replace(
  /^@(import|source|custom-variant)[^\n]*\n/gm,
  "",
);

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MoveDialog.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-move-dialog-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Move dialog harness build failed");
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const assets: Record<string, [string, string]> = {
  "/harness.js": ["text/javascript; charset=utf-8", harness],
  "/app.css": ["text/css", appCss],
  "/styles.css": ["text/css", readFileSync(`${ui}dist/styles.css`, "utf8")],
  "/tabler.css": ["text/css", readFileSync(`${ui}dist/tabler.css`, "utf8")],
};
const html =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/styles.css">` +
  `</head><body class="k2b-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;
// Fictional folders, enough for a list longer than half the screen.
const folders = {
  items: Array.from({ length: 24 }, (_, index) => ({
    name: `Folder ${String(index + 1).padStart(2, "0")}`,
    path: `Folder ${String(index + 1).padStart(2, "0")}`,
    directory: true,
    size: 0,
    modified: "2026-10-20T12:30:00.000Z",
  })),
  next: null,
};

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (options: BrowserContextOptions): Promise<Page> => {
  const tab = await (await browser.newContext({ ...options, reducedMotion: "reduce" })).newPage();
  await tab.route("http://move.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: html });
    if (path.startsWith("/api/filesv2/")) return route.fulfill({ contentType: "application/json", body: JSON.stringify(folders) });
    const asset = assets[path];
    return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
  });
  await tab.goto("http://move.test/");
  await tab.waitForFunction(() => typeof window.openPicker === "function");
  await tab.evaluate(() => window.openPicker());
  await tab.locator(".filesv2-picker__tile").first().waitFor();
  await settled(tab);
  return tab;
};

test("on a phone the folder picker is a bottom sheet that opens at half height and grows to full", async () => {
  const tab = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const frame = tab.locator("dialog[open]");
    expect(await frame.evaluate((element) => element.classList.contains("k2b-bottom-sheet-frame"))).toBe(true);
    expect(await frame.getAttribute("data-sheet-detent")).toBe("half");
    // Half height is a preview: the sheet shows half the screen, and its actions stay on the bottom edge.
    const half = await frame.evaluate((element) => Math.round(innerHeight - element.getBoundingClientRect().top));
    expect(half).toBe(422);
    const footer = (await tab.locator(".k2b-panel-dialog__footer").boundingBox())!;
    expect(Math.round(footer.y + footer.height)).toBe(844);
    await tab.locator(".k2b-bottom-sheet__handle").tap();
    await settled(tab);
    expect(await frame.getAttribute("data-sheet-detent")).toBe("full");
    // At full height the folders fill the sheet: the grid grows and the sheet's body scrolls, not an 18rem box.
    const grid = await tab.locator(".filesv2-picker").evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      overflow: getComputedStyle(element).overflowY,
    }));
    expect(grid.overflow).toBe("visible");
    expect(grid.height).toBeGreaterThan(18 * 16);
    // Back closes it like Cancel.
    await tab.goBack();
    await tab.waitForFunction(() => window.picked === null);
  } finally {
    await tab.context().close();
  }
});

test("from 48rem the folder picker stays the dialog it was", async () => {
  const tab = await open({ viewport: { width: 1440, height: 900 } });
  try {
    const frame = tab.locator("dialog[open]");
    expect(await frame.evaluate((element) => element.classList.contains("k2b-bottom-sheet-frame"))).toBe(false);
    expect(await tab.locator(".k2b-bottom-sheet__handle").count()).toBe(0);
    expect(await tab.locator(".filesv2-picker__tile").count()).toBe(24);
  } finally {
    await tab.context().close();
  }
});
