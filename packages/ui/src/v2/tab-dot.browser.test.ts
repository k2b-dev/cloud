import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-tab-dot.demo";

// The areas of a record carry the state of what they open, as nav entries do (Gateway Ops, F2): a dot after the name,
// its word in the tab's name, and a change of state moves nothing.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-tab-dot"), serverMarkup("../v2-tab-dot"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${markup}</div></body></html>`,
    );
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

test("a tab shows the dot of its state after its name and says the state in its name", async () => {
  await withPage(async (page) => {
    const postgres = page.getByRole("link", { name: "Postgres Warnung" });
    expect(await postgres.isVisible()).toBe(true);
    expect(await page.getByRole("link", { name: "Valkey In Ordnung" }).isVisible()).toBe(true);
    expect(await page.getByRole("link", { name: "NATS", exact: true }).isVisible()).toBe(true);
    const dot = await postgres.locator(".k2-dot").boundingBox();
    expect(dot).toMatchObject({ width: 8, height: 8 });
    // the dot stands after the name, as in a nav entry
    const order = await postgres.evaluate((tab) => {
      const name = [...tab.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
      const range = document.createRange();
      range.selectNodeContents(name!);
      return { name: range.getBoundingClientRect().right, dot: tab.querySelector(".k2-dot")!.getBoundingClientRect().left };
    });
    expect(order.dot).toBeGreaterThan(order.name);
  });
});

test("a change of state keeps the tab's width, so nothing moves", async () => {
  await withPage(async (page) => {
    const widths = async () =>
      page.evaluate(() => [...document.querySelectorAll("[data-k2-part='Tabs'] .k2-tab")].map((tab) => tab.getBoundingClientRect().width));
    const before = await widths();
    for (const status of ["bad", "ok", "warn"] as const) {
      await page.evaluate((next) => window.__setPostgres?.(next), status);
      await settled(page);
      expect(await widths()).toEqual(before);
    }
    expect(await page.getByRole("link", { name: "Postgres Warnung" }).isVisible()).toBe(true);
  });
});
