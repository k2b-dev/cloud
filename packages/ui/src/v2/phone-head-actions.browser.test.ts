import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-phone-head-actions.client";
import { describeV2Page } from "./testing";

// On the phone, in a host that offers the page's search in its own bar (Cloud's shell, `data-k2-host-search`), a head
// gives way only while it holds nothing but where the page stands: its path, its search, and the main action the
// floating button repeats (`Button floats`). A chat's head with its menu "…" keeps its height and stays usable; a
// list's head gives way, and its main action is the floating button alone. The search stays in reach of the host.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss = "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-phone-head-actions.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (kind: "chat" | "list" | "bare" | "detail" | "nofab", width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui" data-k2-host-search><div id="root"></div></body></html>`,
    );
    await page.evaluate((shape) => {
      window.__k2HeadKind = shape;
    }, kind);
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const headHeight = (page: Page) => page.evaluate(() => document.querySelector('[data-slot="head"] > .k2-bar')!.getBoundingClientRect().height);

test("390: a chat's head with its menu keeps its height, and the menu opens and acts", async () => {
  await withPage("chat", 390, async (page) => {
    expect(await headHeight(page)).toBeGreaterThan(40);
    // where the page stands leaves for the host's bar; the actions stay
    expect(await page.locator('[data-slot="head"] .k2-path').isVisible()).toBe(false);
    await page.getByRole("button", { name: "Aktionen des Chats" }).click();
    await page.getByRole("menuitem", { name: "In diesem Chat" }).click();
    expect(await page.evaluate(() => window.__k2Opened)).toBe("context");
    expect(await describeV2Page(page)).not.toContain("primary buttons");
  });
}, 30_000);

test("390: a list's head gives way, its main action is the floating button alone and cannot be reached in the head", async () => {
  await withPage("list", 390, async (page) => {
    expect(await headHeight(page)).toBe(0);
    expect(await page.locator(".k2-fab").isVisible()).toBe(true);
    // the head's twin of the floating button is gone: not shown, not focusable, not counted as a second primary
    const twin = page.locator('[data-slot="head"] [data-floats]');
    expect(await twin.isVisible()).toBe(false);
    expect(
      await twin.evaluate((button) => {
        (button as HTMLElement).focus();
        return document.activeElement === button;
      }),
    ).toBe(false);
    expect(await describeV2Page(page)).not.toContain("primary buttons");
  });
}, 30_000);

test("390: a head without a start keeps its menu ⋯ at its height, and the menu acts", async () => {
  await withPage("bare", 390, async (page) => {
    expect(await headHeight(page)).toBeGreaterThan(40);
    await page.getByRole("button", { name: "Aktionen des Chats" }).click();
    await page.getByRole("menuitem", { name: "In diesem Chat" }).click();
    expect(await page.evaluate(() => window.__k2Opened)).toBe("context");
  });
}, 30_000);

test("390: the host's bar still reaches the folded search of a head that gave way, and Enter sends it", async () => {
  await withPage("list", 390, async (page) => {
    // as Cloud's shell does it (packages/cloud/src/browser/page-search.ts)
    await page.evaluate(() =>
      document.querySelector<HTMLInputElement>('[data-k2-host-search] [data-slot="head"] [data-k2-part="Input"][data-search] > input')!.focus(),
    );
    await page.keyboard.type("Angebot");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.__k2Searched)).toBe("Angebot");
  });
}, 30_000);

test("390: an open detail is the page, the list's main action does not float over it, and the check says nothing", async () => {
  await withPage("detail", 390, async (page) => {
    expect(await page.locator(".k2-fab").count()).toBe(0);
    expect(await describeV2Page(page)).not.toContain("the primary action is hidden at this width");
  });
}, 30_000);

test("390: a list whose main action has no floating twin still gets the check's finding", async () => {
  await withPage("nofab", 390, async (page) => {
    expect(await describeV2Page(page)).toContain("the primary action is hidden at this width");
  });
}, 30_000);

test("1440: the list's head keeps its main action, and nothing floats", async () => {
  await withPage("list", 1440, async (page) => {
    expect(await page.locator('[data-slot="head"] [data-floats]').isVisible()).toBe(true);
    expect(await page.locator(".k2-fab").isVisible()).toBe(false);
    expect(await describeV2Page(page)).not.toContain("primary buttons");
  });
}, 30_000);
