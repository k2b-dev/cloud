import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";

// #4163: tabs with an address are a navigation (links, `aria-current`); tabs that switch a panel in place are the
// WAI-ARIA tabs pattern (tab list, tabs with `aria-selected`, a tab panel named by the open tab, one tab stop that the
// arrows, Home and End move), and both look the same.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-tabs"), serverMarkup("../v2-tabs"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>, { width = 1440, before = "" }: { width?: number; before?: string } = {}) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${markup}</div></body></html>`,
    );
    if (before) await page.addScriptTag({ content: before });
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

test("the server already sends both kinds: a navigation of links and a tab list", () => {
  expect(markup).toMatch(/<nav [^>]*data-k2-part="Tabs" aria-label="Ansichten"/);
  expect(markup).toMatch(/role="tablist" aria-label="Beispiel"/);
  expect(markup).toMatch(/role="tab"[^>]*aria-selected="true"/);
  expect(markup).toContain('role="tabpanel"');
});

test("tabs with an address are links in a navigation, the open one `aria-current`", async () => {
  await withPage(async (page) => {
    const views = page.getByRole("navigation", { name: "Ansichten" });
    expect(await views.getByRole("link").allTextContents()).toEqual(["Alle12", "Online2"]);
    expect(await views.getByRole("link", { name: /Alle/ }).getAttribute("aria-current")).toBe("page");
    expect(await views.getByRole("tab").count()).toBe(0);
  });
});

test("tabs in place are the WAI-ARIA tabs: selected, controlling the panel the open tab names", async () => {
  await withPage(async (page) => {
    const list = page.getByRole("tablist", { name: "Beispiel" });
    expect(await list.getByRole("tab").allTextContents()).toEqual(["Vorschau", "Code", "Eigenschaften"]);
    expect(await list.getByRole("tab", { selected: true }).textContent()).toBe("Vorschau");
    expect(await list.getByRole("tab").evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-controls")))).toEqual([
      "example",
      "example",
      "example",
    ]);
    const panel = page.getByRole("tabpanel", { name: "Vorschau" });
    expect(await panel.textContent()).toBe("Die Vorschau");
    // one tab stop: the open tab
    expect(await list.getByRole("tab").evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("tabindex")))).toEqual(["0", "-1", "-1"]);
    // the same look as a tab of the address: its words and its line in the app's colour
    const look = (selector: string) =>
      page.locator(selector).evaluate((tab) => {
        const style = getComputedStyle(tab);
        return [style.color, style.borderBottomColor, style.borderBottomWidth, style.fontWeight];
      });
    expect(await look('[role="tab"][aria-selected="true"]')).toEqual(await look(".k2-tab[aria-current]"));
  });
});

test("the arrows, Home and End move the one tab stop and open the tab; Tab goes on into the panel", async () => {
  await withPage(async (page) => {
    const list = page.getByRole("tablist", { name: "Beispiel" });
    await list.getByRole("tab", { name: "Vorschau" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("tabpanel", { name: "Code" }).waitFor();
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Code");
    expect(await page.getByRole("tabpanel").textContent()).toBe("Der Code");
    await page.keyboard.press("End");
    await page.getByRole("tabpanel", { name: "Eigenschaften" }).waitFor();
    // the arrows go round
    await page.keyboard.press("ArrowRight");
    await page.getByRole("tabpanel", { name: "Vorschau" }).waitFor();
    await page.keyboard.press("ArrowLeft");
    await page.getByRole("tabpanel", { name: "Eigenschaften" }).waitFor();
    await page.keyboard.press("Home");
    await page.getByRole("tabpanel", { name: "Vorschau" }).waitFor();
    expect(await list.getByRole("tab").evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("tabindex")))).toEqual(["0", "-1", "-1"]);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("tabpanel");
    // a press opens a tab too
    await list.getByRole("tab", { name: "Code" }).click();
    expect(await list.getByRole("tab", { selected: true }).textContent()).toBe("Code");
  });
});

test("while the open tab hides in “Mehr”, a tab that shows holds the tab stop, so Tab still reaches the tab list", async () => {
  await withPage(
    async (page) => {
      const list = page.getByRole("tablist", { name: "Beispiel" });
      // the open tab has no room and stands in the menu of further tabs
      expect(await list.locator('[role="tab"][aria-selected="true"]').getAttribute("data-overflow")).toBe("");
      const stops = await list.locator('[role="tab"]').evaluateAll((tabs) =>
        tabs.filter((tab) => tab.getAttribute("tabindex") === "0").map((tab) => ({ text: tab.textContent, hidden: tab.hasAttribute("data-overflow") })),
      );
      expect(stops).toEqual([{ text: "Vorschau", hidden: false }]);
      // the keys walk only the tabs that show
      await list.getByRole("tab", { name: "Vorschau" }).focus();
      await page.keyboard.press("End");
      expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-overflow"))).toBe(false);
    },
    { width: 390, before: "window.__manyTabs = true;" },
  );
});
