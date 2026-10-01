import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type Browser, type BrowserContextOptions, chromium, type Page } from "playwright";

// Row heights, the toast rail's corner, scrolling and touch hit areas need a real layout engine.
const ui = new URL("../../../ui/", import.meta.url).pathname;
const appCss = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8")
  // Tailwind directives; the panel uses only its own classes and @k2b/ui.
  .replace(/^@(import|source|custom-variant)[^\n]*\n/gm, "");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./UploadPanel.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-upload-panel-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Upload panel harness build failed");
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const assets: Record<string, [string, string | Buffer]> = {
  "/harness.js": ["text/javascript; charset=utf-8", harness],
  // As in Cloud: the app sheet first, @k2b/ui after it.
  "/app.css": ["text/css", appCss],
  "/styles.css": ["text/css", readFileSync(`${ui}dist/styles.css`, "utf8")],
  "/tabler.css": ["text/css", readFileSync(`${ui}dist/tabler.css`, "utf8")],
};
const page = (theme: "light" | "dark", lang: string) =>
  `<!doctype html><html lang="${lang}" class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/styles.css">` +
  `</head><body class="k2b-ui" data-theme="${theme}"><div id="root"></div><script src="/harness.js"></script></body></html>`;

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (options: BrowserContextOptions, theme: "light" | "dark" = "light", lang = "en") => {
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  const tab = await context.newPage();
  await tab.route("http://upload.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: page(theme, lang) });
    const asset = assets[path] ?? (path.endsWith(".woff2") ? ["font/woff2", readFileSync(`${ui}dist${path}`)] : null);
    return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
  });
  await tab.goto("http://upload.test/");
  await tab.waitForFunction(() => !!window.uploads);
  return tab;
};
const settle = (tab: Page) => tab.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30))));
const run = async (tab: Page, script: string) => {
  await tab.evaluate(script);
  await settle(tab);
};

/** Invented demo files, sizes in bytes. */
const demo: [string, number][] = [
  ["Offer_2026-10.pdf", 1_200_000],
  ["Invoice_0815.pdf", 400_000],
  ["Team_meeting_minutes.docx", 250_000],
  ["Autumn_presentation.pptx", 8_600_000],
  ["Summer_party/IMG_0412.jpg", 4_800_000],
  ["Summer_party/IMG_0413.jpg", 5_100_000],
  ["Summer_party/IMG_0414.jpg", 4_600_000],
  ["Summer_party/IMG_0415.jpg", 5_300_000],
  ["Summer_party/IMG_0416.jpg", 4_900_000],
  ["Budget_2027.xlsx", 900_000],
  ["Tour_video.mp4", 32_500_000],
  ["Notes.md", 20_000],
];

/** Boxes of everything that must keep its place while numbers change, rounded to whole pixels. */
const boxes = (tab: Page) =>
  tab.evaluate(() =>
    Object.fromEntries(
      [
        ".filesv2-upload",
        ".filesv2-upload__percent",
        ".filesv2-upload__title",
        ".filesv2-upload__bar",
        ".filesv2-upload__scroll",
        ".filesv2-upload__count",
        ".filesv2-upload__action",
      ].map((selector) => {
        const box = document.querySelector(selector)!.getBoundingClientRect();
        return [selector, [box.left, box.top, box.width, box.height].map(Math.round)];
      }),
    ),
  );

describe("upload panel in a browser", () => {
  test("nothing moves while percent, counts, failures and appended files change", async () => {
    const tab = await open(desktop);
    try {
      await run(tab, `window.uploads.add(${JSON.stringify(demo)})`);
      const first = await boxes(tab);
      // The panel sits in the toast rail's corner, at the bottom right on a desktop.
      const [left, top, width, height] = first[".filesv2-upload"]!;
      expect(left! + width!).toBeGreaterThan(1440 - 40);
      expect(top! + height!).toBeGreaterThan(900 - 40);
      await run(tab, "window.uploads.progress(40_000)");
      expect(await boxes(tab)).toEqual(first);
      for (let index = 0; index < 6; index++) await run(tab, "window.uploads.finish()");
      await run(tab, "window.uploads.progress(2_000_000)");
      expect(await tab.textContent(".filesv2-upload__percent")).toBe("32%");
      expect(await boxes(tab)).toEqual(first);
      await run(tab, "window.uploads.fail('Connection lost')");
      expect(await tab.textContent(".filesv2-upload__errors")).toBe("1 error");
      expect(await boxes(tab)).toEqual(first);
      await run(tab, `window.uploads.add(${JSON.stringify(demo.slice(0, 5).map(([name, size]) => [`Scans/${name}`, size]))})`);
      expect(await tab.textContent(".filesv2-upload__count")).toBe("6 of 17 files");
      expect(await boxes(tab)).toEqual(first);
      // Each row has the same height, with or without a failure reason.
      const heights = await tab.$$eval(".filesv2-upload-row", (rows) => [
        ...new Set(rows.map((row) => row.getBoundingClientRect().height)),
      ]);
      expect(heights).toEqual([36]);
    } finally {
      await tab.context().close();
    }
  });

  test("the list follows the file in flight and holds still while the pointer is inside it", async () => {
    const tab = await open(desktop);
    try {
      await run(tab, `window.uploads.add(${JSON.stringify(demo)})`);
      for (let index = 0; index < 6; index++) await run(tab, "window.uploads.finish()");
      const scrollTop = () => tab.$eval(".filesv2-upload__scroll", (element) => element.scrollTop);
      // One finished row stays above the active one.
      expect(await scrollTop()).toBe(5 * 36);
      expect(await tab.getAttribute('.filesv2-upload-row[data-status="working"]', "style")).toContain("--filesv2-upload-index: 6");
      const list = (await tab.$(".filesv2-upload__scroll"))!.boundingBox();
      const box = (await list)!;
      await tab.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await run(tab, "window.uploads.finish()");
      await run(tab, "window.uploads.finish()");
      expect(await scrollTop()).toBe(5 * 36);
      await tab.mouse.move(10, 10);
      await settle(tab);
      expect(await scrollTop()).toBe(7 * 36);
    } finally {
      await tab.context().close();
    }
  });

  test("collapsing keeps the headline, bar and count; the list returns on the active file", async () => {
    const tab = await open(desktop);
    try {
      await run(tab, `window.uploads.add(${JSON.stringify(demo)})`);
      for (let index = 0; index < 8; index++) await run(tab, "window.uploads.finish()");
      await tab.click('button[aria-label="Hide file list"]');
      await settle(tab);
      expect(await tab.isVisible(".filesv2-upload__scroll")).toBeFalse();
      expect(await tab.isVisible(".filesv2-upload__percent")).toBeTrue();
      expect(await tab.isVisible(".filesv2-upload__bar")).toBeTrue();
      expect(await tab.textContent(".filesv2-upload__count")).toBe("8 of 12 files");
      expect(await tab.getAttribute('button[aria-label="Show file list"]', "aria-expanded")).toBe("false");
      await tab.click('button[aria-label="Show file list"]');
      await settle(tab);
      expect(await tab.$eval(".filesv2-upload__scroll", (element) => element.scrollTop)).toBe(7 * 36);
    } finally {
      await tab.context().close();
    }
  });

  for (const theme of ["light", "dark"] as const) {
    test(`on a ${theme} phone the panel sits at the top edge, fits 390 px and takes taps on 44 px targets`, async () => {
      const tab = await open(phone, theme, "de");
      try {
        await run(tab, `window.uploads.add(${JSON.stringify(demo)})`);
        for (let index = 0; index < 6; index++) await run(tab, "window.uploads.finish()");
        await run(tab, "window.uploads.fail('Verbindung unterbrochen')");
        const layout = await tab.evaluate(() => {
          const panel = document.querySelector<HTMLElement>(".filesv2-upload")!;
          const box = panel.closest("[data-k2b-toast]")!.getBoundingClientRect();
          // Every point 21 px from a control's centre still reaches it.
          const reach = (selector: string) => {
            const control = document.querySelector<HTMLElement>(selector)!;
            const { left, top, width, height } = control.getBoundingClientRect();
            const [x, y] = [left + width / 2, top + height / 2];
            const hits = [
              [x, y - 21],
              [x, y + 21],
              [x - 21, y],
              [x + 21, y],
            ].map(([px, py]) => document.elementFromPoint(px!, py!));
            return hits.every((hit) => hit?.closest("button") === control);
          };
          return {
            top: Math.round(box.top),
            left: Math.round(box.left),
            right: Math.round(box.right),
            // The rows bleed into the toast's padding on purpose; nothing may leave the toast or the rail.
            overflow: Math.max(
              ...[panel.closest<HTMLElement>("[data-k2b-toast]")!, panel.closest<HTMLElement>("[data-k2b-toast-container]")!].map(
                (element) => element.scrollWidth - element.clientWidth,
              ),
            ),
            retry: reach('.filesv2-upload-row[data-status="failed"] button'),
            action: reach(".filesv2-upload__action"),
            title: panel.querySelector(".filesv2-upload__title")!.textContent,
            percentColor: getComputedStyle(panel.querySelector(".filesv2-upload__percent")!).color,
            surface: getComputedStyle(panel.closest("[data-k2b-toast]")!).backgroundColor,
          };
        });
        expect(layout.top).toBeLessThan(40);
        expect(layout.left).toBeGreaterThanOrEqual(0);
        expect(layout.right).toBeLessThanOrEqual(390);
        expect(layout.overflow).toBeLessThanOrEqual(0);
        expect(layout.retry).toBeTrue();
        expect(layout.action).toBeTrue();
        expect(layout.title).toBe("Hochladen nach „Projects“");
        expect(layout.percentColor).not.toBe(layout.surface);
        await tab.screenshot({ path: `/tmp/filesv2-upload-phone-${theme}.png` });
      } finally {
        await tab.context().close();
      }
    });
  }
});
