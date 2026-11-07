import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../test/browser";

// The open results change size while the person types; the popover follows them in the shipped browser build.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "combobox-resize.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { Combobox } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

window.mountCombobox = (debounceMs) => render(
  () => createComponent(Combobox, {
    label: "Add people",
    debounceMs,
    empty: "Nobody with this name works here. A long notice that is much wider than the search field above it.",
    // "wi" finds a long name, "wid" a short one; a held answer waits for the test.
    fetchData: (query) => {
      const answer = () =>
        query === "wi" ? [{ id: "long", label: "Wilhelmina Fictitious-Longname-Example" }] : [{ id: "short", label: "Wid" }];
      if (!window.holdFetch) return Promise.resolve(answer());
      return new Promise((resolve) => { window.releaseFetch = () => resolve(answer()); });
    },
    onSelect: () => {},
  }),
  document.getElementById("host"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the combobox resize fixture for the browser.");
const script = await build.outputs[0]!.text();

declare global {
  interface Window {
    mountCombobox: (debounceMs: number) => void;
    holdFetch?: boolean;
    releaseFetch?: () => void;
  }
}

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (debounceMs: number) => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
        `<body class="k2b-ui"><div id="host" style="width: 240px; padding: 16px"></div></body></html>`,
    );
    await page.addScriptTag({ content: script });
    await page.evaluate((debounce) => window.mountCombobox(debounce), debounceMs);
    return { page, errors };
  } catch (error) {
    await page.close();
    throw error;
  }
};
const frames = (page: Awaited<ReturnType<typeof open>>["page"]) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

describe("@k2b/ui Combobox results that change size", () => {
  test("a search waiting out its debounce shows loading rows, not the empty notice", async () => {
    const { page, errors } = await open(400);
    try {
      await page.evaluate(() => (window.holdFetch = true));
      await page.getByRole("combobox").fill("wid");
      // Read at once: the request has not started yet, so nobody can have been found or not found.
      const popover = page.locator(".k2b-choice-popover");
      expect(await popover.locator(".k2b-choice-loading").count()).toBe(1);
      expect(await popover.textContent()).not.toContain("Nobody with this name");
      // The held request keeps the loading rows; their width is the field's, so the answer resizes no notice.
      await settled(page);
      const field = (await page.locator(".k2b-combobox__input").boundingBox())!.width;
      expect((await popover.boundingBox())!.width).toBe(field);
      await page.waitForFunction(() => typeof window.releaseFetch === "function", undefined, { timeout: 2_000 });
      await page.evaluate(() => window.releaseFetch!());
      await page.getByRole("option", { name: "Wid", exact: true }).waitFor({ timeout: 2_000 });
      await frames(page);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("shorter results keep the popover's width without a ResizeObserver loop", async () => {
    const { page, errors } = await open(0);
    try {
      const search = page.getByRole("combobox");
      await search.fill("wi");
      await page.getByRole("option", { name: "Wilhelmina Fictitious-Longname-Example", exact: true }).waitFor({ timeout: 2_000 });
      await frames(page);
      const popover = page.locator(".k2b-choice-popover");
      const wide = (await popover.boundingBox())!.width;
      expect(wide).toBeGreaterThan((await page.locator(".k2b-combobox__input").boundingBox())!.width);
      await search.fill("wid");
      await page.getByRole("option", { name: "Wid", exact: true }).waitFor({ timeout: 2_000 });
      await frames(page);
      // Filtering never narrows the open popover, and holding its width resizes nothing inside the observer's delivery.
      expect((await popover.boundingBox())!.width).toBe(wide);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
