import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import type {} from "../../test/v2-bar-fold.fixture";
import { bundleV2Entry } from "../../test/v2-bundle";

// A bar whose end does not fit (W7's head of six kept actions beside tabs, W2's "1.000 Kommentare"): the end's buttons
// that do not fit fold into "…" in their order, the primary action never; the start gives way to its last pixel. The
// fixture is test/v2-bar-fold.fixture.tsx.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; } .case { position: relative; height: 400px; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
let server: { html: string; script: string };
const temp = mkdtempSync(resolve(tmpdir(), "k2-v2-bar-fold-"));
beforeAll(async () => {
  const serverFile = resolve(temp, "server.js");
  await Bun.write(serverFile, await bundleV2Entry("v2-bar-fold.server.tsx", "ssr"));
  const { render }: { render: () => { html: string; script: string } } = await import(serverFile);
  server = render();
  [client, browser] = await Promise.all([bundleV2Entry("v2-bar-fold.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
});

/** The page as the server sent it; with `live` hydrated, which fails on any node the client would make differently. */
const withPage = async (width: number, live: boolean, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${server.script}<style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${server.html}</div></body></html>`,
    );
    if (live) {
      await page.addScriptTag({ content: client });
      await page.waitForFunction(() => window.__k2Hydrated === true);
    }
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const head = (which: string) => `[data-case="${which}"] .k2-ws-main > [data-slot="head"] > .k2-bar`;
const actions = ["Teilen", "Drucken", "Exportieren", "Verlauf", "Duplizieren", "Archivieren"];

/** The controls of a head a person sees, by name, with their edges. */
const seen = (page: Page, bar: string) =>
  page.evaluate((bar) => {
    const found: { name: string; left: number; right: number }[] = [];
    for (const control of document.querySelectorAll<HTMLElement>(`${bar} :is(.k2-btn, .k2-tab)`)) {
      const box = control.getBoundingClientRect();
      // a tab that gave way stands hidden in its place (`visibility: hidden`)
      if (!control.checkVisibility({ visibilityProperty: true }) || box.width === 0) continue;
      const name = control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "";
      found.push({ name, left: Math.round(box.left), right: Math.round(box.right) });
    }
    return found;
  }, bar);

test("390 px, after the page came alive: the actions that do not fit are in '…' in their order; the rest, the tabs and the primary stay", async () => {
  await withPage(390, true, async (page) => {
    const shown = await seen(page, head("record"));
    const names = shown.map((control) => control.name);
    // every control a person sees lies inside the window
    for (const control of shown) expect([control.name, control.right <= 390, control.left >= 0]).toEqual([control.name, true, true]);
    // the tabs give way first, to the open one and their own "Mehr"; then the end folds from its last action
    expect(names[0]).toBe("Übersicht");
    expect(names.slice(-2)).toEqual(["Neu", "Weitere Aktionen"]);
    const kept = names.filter((name) => actions.includes(name));
    expect(kept).toEqual(actions.slice(0, kept.length));
    expect(kept.length).toBeLessThan(actions.length);
    expect(kept.length).toBeGreaterThan(0);
    // the folded actions are in the menu, in their order, and an entry does the action's deed
    await page.locator(head("record")).getByRole("button", { name: "Weitere Aktionen" }).click();
    const entries = await page.getByRole("menuitem").allTextContents();
    expect(entries.map((entry) => entry.trim())).toEqual(actions.slice(kept.length));
    await page.getByRole("menuitem", { name: "Archivieren" }).click();
    expect(await page.evaluate(() => window.__deeds)).toEqual(["Archivieren"]);
  });
});

test("390 px: the keyboard reads the head as the eye does, and '…' comes after the primary action", async () => {
  await withPage(390, true, async (page) => {
    const all = (await seen(page, head("record"))).map((control) => control.name);
    const names = all.slice(all.indexOf(actions[0]!));
    await page.locator(head("record")).getByRole("button", { name: actions[0], exact: true }).focus();
    const order = [names[0]];
    for (let step = 1; step < names.length; step++) {
      await page.keyboard.press("Tab");
      order.push(
        await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim() ?? ""),
      );
    }
    expect(order).toEqual(names);
  });
});

test("1440 px: a head that fits folds nothing and has no '…', on the server's page and after it came alive", async () => {
  let before: Awaited<ReturnType<typeof seen>> = [];
  await withPage(1440, false, async (page) => {
    before = await seen(page, head("record"));
  });
  await withPage(1440, true, async (page) => {
    const after = await seen(page, head("record"));
    expect(after.map((control) => control.name)).toEqual(["Übersicht", "Aktivität", "Dateien", ...actions, "Neu"]);
    expect(after).toEqual(before);
  });
});

for (const live of [false, true])
  test(`390 px, ${live ? "after the page came alive" : "as the server sent it"}: the start gives way to its last pixel, its words shorten with '…'`, async () => {
    await withPage(390, live, async (page) => {
      const shown = await seen(page, head("book"));
      for (const control of shown) expect([control.name, control.right <= 390]).toEqual([control.name, true]);
      const start = await page
        .locator(`${head("book")} > .k2-bar-start`)
        .evaluate((element) => Math.round(element.getBoundingClientRect().right));
      const end = await page
        .locator(`${head("book")} > .k2-bar-end`)
        .evaluate((element) => Math.round(element.getBoundingClientRect().left));
      expect(start).toBeLessThanOrEqual(end);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    });
  });
