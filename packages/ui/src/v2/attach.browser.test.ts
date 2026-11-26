// Contract test for a Workspace the server rendered without an island: `attachWorkspaces` brings its drawer, the
// collapse of its sidebar, the toaster, `Dialog.confirm`, its grips and the folds of its Nav alive, and nothing moves
// when it attaches. Runs in Chromium and in WebKit.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { transparentIslands } from "../../scripts/v2-island-css";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import type {} from "../../test/v2-behavior/frame.entry";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";

let browser: Browser;
let bundle: string;
let markup: string;
const css = `${transparentIslands(readFileSync(resolve(import.meta.dir, "v2.css"), "utf8"))}\n[hidden]{display:none}`;
beforeAll(async () => {
  [bundle, markup] = await Promise.all([demoBundle("frame"), serverMarkup("frame")]);
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** The boxes of every part of the page, to compare before and after the frame attached (without its live parts). */
const boxes = (page: Page) =>
  page.$$eval("[data-k2-part]", (parts) =>
    parts
      .filter((part) => !part.closest("[data-k2-ws-live]"))
      .map((part) => {
        const box = part.getBoundingClientRect();
        return `${part.getAttribute("data-k2-part")} ${[box.x, box.y, box.width, box.height].map(Math.round).join(",")}`;
      }),
  );

const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style></head><body>${markup}</body></html>`,
    );
    await settled(page);
    const before = await boxes(page);
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    expect(await boxes(page)).toEqual(before);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

test("the server's markup is the frame: no toaster, dialog or drawer until the page attaches it", () => {
  expect(markup).toContain("data-k2-workspace ");
  expect(markup).not.toContain("data-k2-toaster");
  expect(markup).not.toContain('data-slot="drawer-trigger"');
});

test("in a narrow window the drawer holds the sidebar's own nodes and gives them back", async () => {
  await withPage(900, async (page) => {
    const toggle = page.locator(".k2-ws-toggle");
    expect(await toggle.isVisible()).toBe(true);
    expect(await page.locator(".k2-ws-collapse").isVisible()).toBe(false);
    await toggle.click();
    const drawer = page.locator(".k2-drawer");
    await drawer.waitFor();
    expect(await drawer.locator('[data-k2-part="Nav"]').count()).toBe(1);
    expect(await page.locator('.k2-ws-side [data-k2-part="Nav"]').count()).toBe(0);
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "detached" });
    expect(await page.locator('.k2-ws-side [data-k2-part="Nav"]').count()).toBe(1);
    await page.waitForFunction(() => document.activeElement?.classList.contains("k2-ws-toggle") === true);
    // picking an entry closes the drawer
    await toggle.click();
    await drawer.getByRole("link", { name: "Eingang" }).click();
    await drawer.waitFor({ state: "detached" });
  });
});

test("on a wide screen the sidebar collapses and expands by its button and Mod+Alt+S, and the page hears each change", async () => {
  await withPage(1440, async (page) => {
    const collapse = page.locator(".k2-ws-collapse");
    const side = page.locator(".k2-ws-side");
    expect(await page.locator(".k2-ws-toggle").isVisible()).toBe(false);
    expect(await collapse.getAttribute("aria-expanded")).toBe("true");
    expect(await collapse.getAttribute("aria-label")).toBe("Seitenleiste ausblenden");
    await collapse.click();
    await side.waitFor({ state: "hidden" });
    expect(await collapse.getAttribute("aria-expanded")).toBe("false");
    expect(await collapse.getAttribute("aria-label")).toBe("Seitenleiste zeigen");
    await page.keyboard.press("Control+Alt+KeyS");
    await side.waitFor({ state: "visible" });
    expect(await page.evaluate(() => window.__collapsed)).toEqual([true, false]);
  });
});

test("a fold of the server's Nav opens and closes", async () => {
  await withPage(1440, async (page) => {
    const fold = page.getByRole("button", { name: "Archiv" });
    expect(await fold.getAttribute("aria-expanded")).toBe("false");
    expect(await page.getByRole("link", { name: "2025" }).isVisible()).toBe(false);
    await fold.click();
    expect(await fold.getAttribute("aria-expanded")).toBe("true");
    await page.getByRole("link", { name: "2025" }).waitFor();
  });
});

test("useToast and Dialog.confirm answer from the attached workspace", async () => {
  await withPage(1440, async (page) => {
    await page.evaluate(() => window.__toast("Gespeichert"));
    await page.locator('[data-k2-toaster] [data-slot="toast"]').getByText("Gespeichert").waitFor();
    const answer = page.evaluate(() => window.__confirm());
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Verwerfen" }).click();
    expect(await answer).toBe(true);
  });
});

test("the grip of a line stands in the middle of the line in sight", async () => {
  await withPage(1440, async (page) => {
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLElement>("[data-k2-grip]")].every((grip) => grip.style.getPropertyValue("--k2-grip-top") !== ""),
    );
  });
});
