import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../../ui/test/browser";
import { renderNotebookBook } from "../../../lib/book-renderer";
import type { FullWidthHarness } from "./full-width.browser-harness";

// Each fixture types its browser window locally; other harnesses use the same property.
declare const window: { harness: FullWidthHarness };

const prose =
  "Unser Team sammelt die Gedanken für die nächste gemeinsame Woche. Wir besprechen die Erfahrungen aus dem letzten Projekt und halten fest, welche Fragen noch offen sind. Everyone can read the same notes and add an explanation for everyone who joins the project. Gute Dokumentation gibt uns Zeit, sorgfältig zu arbeiten und unsere Entscheidungen später nachzuvollziehen. Am Freitag schauen wir gemeinsam auf die Ergebnisse und planen die nächsten Schritte. The shared notebook keeps the details close to the people who need them.";
const markdown = Array.from({ length: 120 }, (_, index) => `Absatz ${index}. ${prose}`).join("\n\n");
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const ui = `${resolve(import.meta.dir, "../../../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "full-width.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-full-width-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the full-width harness.");
  const bundle = await build.outputs[0]!.text();
  // Use the shipped page-head order and cascade, including the responsive switch rule.
  const outputs = await Promise.all(
    [resolve(import.meta.dir, "../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../styles.css")].map(async (entry) => {
      const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
      if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}.`);
      return build.outputs[0]!.text();
    }),
  );
  const css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  const { html } = renderNotebookBook({ markdown, notebookId: "book01", locale: "de" });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/harness.js")
        return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      return new Response(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script id="note-source" type="text/plain">${markdown}</script><script id="book-source" type="text/plain">${html}</script><script src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const open = async (mode = "write", width = 2560, mobile = false) => {
  const page = await browser.newPage({ viewport: { width, height: mobile ? 844 : 1440 }, isMobile: mobile, hasTouch: mobile });
  try {
    await page.goto(`${server.url}?mode=${mode}`);
    await page.waitForFunction(() => Boolean(window.harness));
    await settle(page);
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
};
const settle = (page: Page) => page.evaluate(() => window.harness.settle());
const measure = (page: Page) => page.evaluate(() => window.harness.measure());
const toggle = (page: Page) => page.getByRole("switch", { name: "Volle Breite" });
const closeTo = (actual: number, expected: number, tolerance = 1) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
const assertWide = async (page: Page) => {
  const result = await measure(page);
  expect(result.width).toBeGreaterThan(1500);
  closeTo(result.width, result.available);
};

for (const mode of ["write", "book"]) {
  test(`${mode}: full width rewraps in the available space without moving the reading anchor before paint`, async () => {
    const page = await open(mode);
    try {
      closeTo((await measure(page)).width, 704);
      await page.evaluate(() => window.harness.scrollMiddle());
      expect(await page.locator(".k2b-scroll-area").evaluate((element) => element.scrollTop)).toBeGreaterThan(2000);
      const before = await page.evaluate(() => window.harness.anchor());
      for (const on of [true, false]) {
        // Subscribe before the click; reading the next frame after Playwright returns can miss a jump.
        const painted = page.evaluate(() => window.harness.firstPaint());
        await toggle(page).click();
        closeTo(await painted, before);
        await settle(page);
        closeTo(await page.evaluate(() => window.harness.anchor()), before);
        if (on) await assertWide(page);
        else closeTo((await measure(page)).width, 704);
      }
    } finally {
      await page.close();
    }
  }, 30_000);
}

test("a reload starts wide with the saved cookie and checked switch", async () => {
  const page = await open();
  try {
    await toggle(page).click();
    expect(await page.evaluate(() => window.harness.stored())).toBe(true);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.harness));
    expect(await page.locator(".notebook-document-surface").getAttribute("data-full-width")).toBe("");
    expect(await toggle(page).isChecked()).toBe(true);
    await assertWide(page);
  } finally {
    await page.close();
  }
}, 30_000);

test("the palette command shares the switch, cookie and live on/off title", async () => {
  const page = await open();
  try {
    expect(await page.evaluate(() => window.harness.command())).toEqual({
      title: "Volle Breite einschalten",
      icon: "ti ti-viewport-wide",
      description: "Nur für dich in diesem Browser",
      shortcut: undefined,
    });
    await page.evaluate(() => window.harness.runCommand());
    expect(await page.locator(".notebook-document-surface").getAttribute("data-full-width")).toBe("");
    expect(await toggle(page).isChecked()).toBe(true);
    expect(await page.evaluate(() => window.harness.stored())).toBe(true);
    expect((await page.evaluate(() => window.harness.command()))?.title).toBe("Volle Breite ausschalten");
    await assertWide(page);
  } finally {
    await page.close();
  }
}, 30_000);

for (const width of [390, 1023, 1024]) {
  test(`the switch and command follow the 64rem boundary at ${width}px`, async () => {
    const page = await open("write", width, width === 390);
    try {
      expect(await page.locator('input[role="switch"]').isVisible()).toBe(width >= 1024);
      expect(await page.evaluate(() => window.harness.command() !== null)).toBe(width >= 1024);
    } finally {
      await page.close();
    }
  }, 30_000);
}

test("resizing removes and restores the command without losing the preference", async () => {
  const page = await open();
  try {
    await toggle(page).click();
    await page.setViewportSize({ width: 1023, height: 1440 });
    await page.waitForFunction(() => window.harness.command() === null);
    expect(await page.locator('input[role="switch"]').isVisible()).toBe(false);
    // Nothing here can switch it off, so the text keeps the reading column.
    const measureValue = () =>
      page
        .locator(".notebook-document-surface")
        .evaluate((surface) => getComputedStyle(surface).getPropertyValue("--notebook-measure").trim());
    expect(await measureValue()).toBe("44rem");
    await page.setViewportSize({ width: 1024, height: 1440 });
    await page.waitForFunction(() => window.harness.command() !== null);
    expect(await toggle(page).isChecked()).toBe(true);
    expect((await page.evaluate(() => window.harness.command()))?.title).toBe("Volle Breite ausschalten");
    expect(await measureValue()).toBe("100%");
  } finally {
    await page.close();
  }
}, 30_000);

test("toggling leaves every panel child, panel and switch track in place", async () => {
  const page = await open();
  try {
    const before = await page.evaluate(() => window.harness.panelRects());
    expect(before.length).toBeGreaterThan(4);
    for (const _on of [true, false]) {
      await toggle(page).click();
      await settle(page);
      const after = await page.evaluate(() => window.harness.panelRects());
      expect(after).toHaveLength(before.length);
      after.forEach((rect, index) => {
        for (const key of ["x", "y", "width", "height"] as const) closeTo(rect[key], before[index]![key], 0.5);
      });
    }
  } finally {
    await page.close();
  }
}, 30_000);

// The help says: when the navigation and the detail panel leave less room than
// the column, the lines get longer only once the panel closes.
for (const mode of ["write", "book"]) {
  for (const width of [1024, 1280]) {
    test(`${mode} at ${width}px: beside the open panel the lines keep their length until the panel closes`, async () => {
      const page = await open(mode, width);
      try {
        const lineWidth = async () => {
          await settle(page);
          return (await measure(page)).width;
        };
        const surfaceWidth = () => page.locator(".notebook-document-surface").evaluate((surface) => surface.getBoundingClientRect().width);
        // The workspace hands the panel's track back after the panel's exit motion.
        const setPanelOpen = async (open: boolean) => {
          const before = await surfaceWidth();
          await page.evaluate((open) => window.harness.setPanelOpen(open), open);
          await page.waitForFunction(
            ([open, before]) => {
              const now = document.querySelector(".notebook-document-surface")!.getBoundingClientRect().width;
              return open ? now < before : now > before;
            },
            [open, before] as const,
          );
        };
        const narrowOpen = await lineWidth();
        expect(narrowOpen).toBeLessThan(704);
        await toggle(page).click();
        closeTo(await lineWidth(), narrowOpen);
        await setPanelOpen(false);
        const wideClosed = await lineWidth();
        await setPanelOpen(true);
        await toggle(page).click();
        await setPanelOpen(false);
        const narrowClosed = await lineWidth();
        closeTo(narrowClosed, 704);
        expect(wideClosed).toBeGreaterThan(narrowClosed);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
}
