import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "moved-hint.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { MovedHint } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const params = new URLSearchParams(location.hash.slice(1));
const button = (id, label) => { const b = document.createElement('button'); b.id = id; b.textContent = label; return b; };
const first = button('first', 'Files');
const target = button('target', 'Tags');
const last = button('last', 'More');
if (params.has('hidden')) target.style.display = 'none';
window.dismissals = 0;
window.actions = 0;
render(() => {
  const [open, setOpen] = createSignal(true);
  window.setHintOpen = setOpen;
  const action = params.has('callback') ? {label: 'Show filters', onClick: () => {window.actions++; document.body.dataset.actions = String(window.actions); }} : {label: 'Show filters', href: '#filters'};
  return [first, target, params.has('never') ? null : createComponent(MovedHint, {
    get open() { return open(); }, target: () => target, action,
    onDismiss: () => {window.dismissals++; document.body.dataset.dismissals = String(window.dismissals);},
    children: 'Tags moved to the filter chips in the head.',
  }), last];
}, document.getElementById('toolbar'));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle moved hint fixture");
const script = await build.outputs[0]!.text();
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});
const load = async (theme: string, params = "", options: BrowserContextOptions = {}) => {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 }, ...options })).newPage();
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:24px}#toolbar{display:flex;gap:8px}#next{height:80px}</style></head><body class="k2b-ui" data-theme="${theme}"><div id="toolbar"></div><div id="next">Next block</div></body></html>`,
  );
  await page.evaluate((params) => {
    location.hash = params;
  }, params);
  await page.addScriptTag({ content: script });
  return page;
};
const shown = (page: Page) => page.evaluate(() => document.querySelector(".k2b-moved-hint")?.matches(":popover-open") ?? false);
const layout = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#first, #target, #last, #next")].map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
const dismissals = (page: Page) => page.locator("body").getAttribute("data-dismissals");
const waitShown = (page: Page) => page.waitForFunction(() => document.querySelector(".k2b-moved-hint")?.matches(":popover-open"));

for (const theme of ["light", "dark"])
  describe(`MovedHint in ${theme}`, () => {
    test("open and dismissed hints leave the toolbar and following content in their original positions", async () => {
      const baseline = await load(theme, "never=1");
      const page = await load(theme);
      try {
        await waitShown(page);
        const original = await layout(baseline);
        expect(await layout(page)).toEqual(original);
        await page.getByRole("button", { name: "Got it", exact: true }).click();
        expect(await shown(page)).toBe(false);
        expect(await layout(page)).toEqual(original);
        expect(await dismissals(page)).toBe("1");
      } finally {
        await Promise.all([baseline.context().close(), page.context().close()]);
      }
    });

    test("positions below the target within desktop and phone viewports, including reduced motion", async () => {
      for (const width of [1000, 390]) {
        const page = await load(theme, "", { viewport: { width, height: 700 }, reducedMotion: "reduce" });
        try {
          await waitShown(page);
          const rects = await page.evaluate(() => {
            const target = document.getElementById("target")!.getBoundingClientRect();
            const hint = document.querySelector(".k2b-moved-hint")!.getBoundingClientRect();
            return { bottom: target.bottom, top: hint.top, left: hint.left, right: hint.right, hintBottom: hint.bottom };
          });
          expect(rects.top).toBeGreaterThanOrEqual(rects.bottom);
          expect(rects.left).toBeGreaterThanOrEqual(8);
          expect(rects.right).toBeLessThanOrEqual(width - 8);
          expect(rects.hintBottom).toBeLessThanOrEqual(692);
          await page.waitForFunction(() =>
            document
              .querySelector('[data-k2b-live] [aria-live="polite"]')
              ?.textContent?.includes("Tags moved to the filter chips in the head."),
          );
        } finally {
          await page.context().close();
        }
      }
    });

    test("Tab follows the target into the hint and Escape restores focus with one dismissal", async () => {
      const page = await load(theme);
      try {
        await waitShown(page);
        await page.locator("#target").focus();
        await page.keyboard.press("Tab");
        expect(await page.getByRole("link", { name: "Show filters" }).evaluate((e) => e === document.activeElement)).toBe(true);
        await page.keyboard.press("Tab");
        expect(await page.getByRole("button", { name: "Got it" }).evaluate((e) => e === document.activeElement)).toBe(true);
        await page.keyboard.press("Escape");
        expect(await shown(page)).toBe(false);
        expect(await dismissals(page)).toBe("1");
        expect(await page.locator("#target").evaluate((e) => e === document.activeElement)).toBe(true);
        await page.keyboard.press("Escape");
        expect(await dismissals(page)).toBe("1");
      } finally {
        await page.context().close();
      }
    });

    test("Got it returns focus and the callback action dismisses before running once", async () => {
      const page = await load(theme, "callback=1");
      try {
        await waitShown(page);
        await page.locator("#target").focus();
        await page.getByRole("button", { name: "Got it" }).click();
        expect(await shown(page)).toBe(false);
        expect(await dismissals(page)).toBe("1");
        expect(await page.locator("#target").evaluate((e) => e === document.activeElement)).toBe(true);
        await page.evaluate("window.setHintOpen(false); window.setHintOpen(true)");
        await waitShown(page);
        await page.getByRole("button", { name: "Show filters" }).click();
        expect(await shown(page)).toBe(false);
        expect(await dismissals(page)).toBe("2");
        expect(await page.locator("body").getAttribute("data-actions")).toBe("1");
      } finally {
        await page.context().close();
      }
    });

    test("the native action link dismisses and still follows its href", async () => {
      const page = await load(theme);
      try {
        await waitShown(page);
        await page.getByRole("link", { name: "Show filters" }).click();
        expect(await dismissals(page)).toBe("1");
        expect(await shown(page)).toBe(false);
        expect(await page.evaluate(() => location.hash)).toBe("#filters");
      } finally {
        await page.context().close();
      }
    });

    test("a hidden target keeps the hint closed and resizing it back into view shows it", async () => {
      const page = await load(theme, "hidden=1");
      try {
        expect(await shown(page)).toBe(false);
        await page.locator("#target").evaluate((target) => {
          target.style.display = "";
        });
        await waitShown(page);
        await page.locator("#target").evaluate((target) => {
          target.style.display = "none";
        });
        await page.waitForFunction(() => !document.querySelector(".k2b-moved-hint")?.matches(":popover-open"));
        expect(await dismissals(page)).toBeNull();
      } finally {
        await page.context().close();
      }
    });

    test("scrolling the target out of view takes the hint along instead of pinning it to the viewport edge", async () => {
      const page = await load(theme);
      try {
        await waitShown(page);
        // A tall page after the toolbar lets the target leave the viewport.
        await page.evaluate(() => {
          document.getElementById("next")!.style.height = "3000px";
        });
        await page.evaluate(() => window.scrollTo(0, 1500));
        await page.waitForFunction(() => !document.querySelector(".k2b-moved-hint")?.matches(":popover-open"));
        await page.evaluate(() => window.scrollTo(0, 0));
        await waitShown(page);
        const [hint, target] = await Promise.all([page.locator(".k2b-moved-hint").boundingBox(), page.locator("#target").boundingBox()]);
        expect(hint!.y).toBeGreaterThanOrEqual(target!.y + target!.height);
        expect(await dismissals(page)).toBeNull();
      } finally {
        await page.context().close();
      }
    });
  });
