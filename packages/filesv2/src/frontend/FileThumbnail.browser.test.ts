import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";

// Fixed tile boxes, the delayed placeholder and the fade-in need a real layout engine and real image loading.
const ui = new URL("../../../ui/", import.meta.url).pathname;
const appCss = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8")
  // Tailwind directives; the list uses only its own classes and @k2b/ui.
  .replace(/^@(import|source|custom-variant)[^\n]*\n/gm, "");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./FileThumbnail.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-file-thumbnail-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Thumbnail harness build failed");
  return build.outputs[0]!.text();
};

const assets: Record<string, [string, string | Buffer]> = {
  "/harness.js": ["text/javascript; charset=utf-8", await buildHarness()],
  // As in Cloud: the app sheet first, @k2b/ui after it.
  "/app.css": ["text/css", appCss],
  "/styles.css": ["text/css", readFileSync(`${ui}dist/styles.css`, "utf8")],
  "/tabler.css": ["text/css", readFileSync(`${ui}dist/tabler.css`, "utf8")],
};
const html =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/styles.css">` +
  `</head><body class="k2b-ui" data-theme="light"><div id="root"></div><script src="/harness.js"></script></body></html>`;

/** Invented demo files and the previews the service draws for them. */
const picture = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="100%" height="100%" fill="${fill}"/></svg>`;
const firstPage = `<svg xmlns="http://www.w3.org/2000/svg" width="226" height="320"><rect width="100%" height="100%" fill="#fff"/><rect x="20" y="30" width="150" height="10" fill="#1e3a8a"/></svg>`;
const readme = "# Summer party 2026\n\nEverything the organising team needs: the schedule, the posters and the shopping list.\n";
const folder = [
  { name: "Workshop.jpg", size: 4_600_000 },
  { name: "README.md", size: 1_200 },
  { name: "Broken.jpg", size: 5_100_000 },
  { name: "Report.pdf", size: 412_000 },
  { name: "Offer.docx", size: 58_000 },
  { name: "Archive.zip", size: 2_000_000 },
  { name: "Offline.jpg", size: 3_900_000 },
];

/** Every preview request: file name and size. */
const previewRequests: { name: string; size: string }[] = [];

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/** `hold` keeps back the small preview of Workshop.jpg, as a slow first view would. */
const open = async (options: BrowserContextOptions, hold: Promise<void>): Promise<Page> => {
  previewRequests.length = 0;
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  await context.addInitScript((list) => {
    (window as unknown as { folder: unknown }).folder = list;
  }, folder);
  const tab = await context.newPage();
  await tab.route("http://thumbnails.test/**", async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (path === "/") return route.fulfill({ contentType: "text/html", body: html });
    if (path === "/api/filesv2/bases/personal/preview") {
      const name = url.searchParams.get("path")!.split("/").at(-1)!;
      const size = url.searchParams.get("size")!;
      previewRequests.push({ name, size });
      // Every address carries the file's version, so the browser may keep the answer.
      if (url.searchParams.get("rev") !== `r-${name}`) return route.fulfill({ status: 400 });
      // The connection drops, as when the network goes away.
      if (name === "Offline.jpg") return route.abort("failed");
      if (name === "Broken.jpg") return route.fulfill({ status: 404, json: { code: "preview_failed", message: "" } });
      if (name === "Workshop.jpg") await hold;
      if (name.endsWith(".jpg")) return route.fulfill({ contentType: "image/svg+xml", body: picture("#0e7490") });
      if (name === "Report.pdf" || name === "Offer.docx") return route.fulfill({ contentType: "image/svg+xml", body: firstPage });
      if (name === "README.md" && size === "text") return route.fulfill({ contentType: "text/plain; charset=utf-8", body: readme });
      return route.fulfill({ status: 404, json: { code: "preview_unsupported", message: "" } });
    }
    const asset = assets[path] ?? (path.endsWith(".woff2") ? ["font/woff2", readFileSync(`${ui}dist${path}`)] : null);
    return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
  });
  // Records when the first placeholder appears, measured from the moment the list starts rendering.
  await tab.addInitScript(() => {
    const start = performance.now();
    document.addEventListener("DOMContentLoaded", () => {
      new MutationObserver((_records, observer) => {
        if (!document.querySelector(".filesv2-thumbnail.k2b-skeleton")) return;
        document.body.dataset.placeholderAfter = String(performance.now() - start);
        observer.disconnect();
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] });
    });
  });
  await tab.goto("http://thumbnails.test/");
  await tab.waitForSelector(".filesv2-list__row");
  return tab;
};
const box = (tab: Page, selector: string) =>
  tab.$eval(selector, (element) => {
    const rect = element.getBoundingClientRect();
    return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
  });

describe("file previews in the list", () => {
  for (const [label, options] of [
    ["1440", desktop],
    ["390", phone],
  ] as const)
    test(`each file shows its content in a fixed place; a late preview shows a placeholder and moves nothing (${label})`, async () => {
      let release = () => {};
      const tab = await open(
        options,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      try {
        const workshop = '.filesv2-list__row:has-text("Workshop.jpg") .filesv2-thumbnail';
        const rows = () => tab.$$eval(".filesv2-list__row", (all) => all.map((row) => Math.round(row.getBoundingClientRect().top)));
        const before = { rows: await rows(), tile: await box(tab, workshop) };
        // No placeholder for a quick answer: it appears only after 200 ms.
        await tab.waitForSelector(`${workshop}.k2b-skeleton`, { timeout: 2_000 });
        expect(Number(await tab.evaluate(() => document.body.dataset.placeholderAfter))).toBeGreaterThanOrEqual(195);
        release();
        await tab.waitForSelector(`${workshop} img[data-ready]`);
        await tab.waitForFunction(
          () =>
            ![...document.querySelectorAll(".filesv2-list__row")]
              .find((row) => row.textContent?.includes("Workshop.jpg"))
              ?.querySelector(".filesv2-thumbnail")
              ?.classList.contains("k2b-skeleton"),
        );
        expect(await rows()).toEqual(before.rows);
        expect(await box(tab, workshop)).toEqual(before.tile);
        // A text shows its first lines; a page shows whole.
        await tab.waitForFunction(() =>
          [...document.querySelectorAll(".filesv2-list__row")]
            .find((row) => row.textContent?.includes("README.md"))
            ?.querySelector(".filesv2-thumbnail__text")
            ?.textContent?.includes("Summer party"),
        );
        await tab.waitForSelector('.filesv2-list__row:has-text("Report.pdf") .filesv2-thumbnail img[data-ready]');
        // A failed preview, a dropped connection and a file without a preview keep their type icon quietly.
        for (const name of ["Broken.jpg", "Offline.jpg", "Archive.zip"])
          await tab.waitForSelector(`.filesv2-list__row:has-text("${name}") .k2b-file-type-icon`);
        expect(previewRequests.some((request) => request.name === "Archive.zip")).toBe(false);
        await settled(tab);
        await tab.screenshot({ path: `/tmp/files11-shots/list-light-${label}.png` });
      } finally {
        await tab.context().close();
      }
    });
});
