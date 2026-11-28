import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-head-place.client";
import type { Kind } from "../../test/v2-head-place.fixture";

// What a workspace's head knows of its place (test/v2-head-place.fixture.tsx), in Chromium and WebKit, the server's
// page and the live one alike: several main actions stand as one "+ Neu" menu, which the phone's round button offers
// too; a title that repeats the sidebar's current entry gives way while the sidebar shows; a head with nothing to show on
// the phone takes no room; an open entry named after a path is small in the path's row, and keeps its name on the phone
// where the path gives way; a long file name at the end of a path is cut in its middle, its end kept.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
let server: (kind: Kind) => { html: string; script: string };
const temp = mkdtempSync(resolve(tmpdir(), "k2-v2-head-place-"));
beforeAll(async () => {
  const serverFile = resolve(temp, "server.js");
  await Bun.write(serverFile, await bundleV2Entry("v2-head-place.server.tsx", "ssr"));
  ({ render: server } = (await import(serverFile)) as { render: typeof server });
  [client, browser] = await Promise.all([bundleV2Entry("v2-head-place.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
});

type Options = { live?: boolean; host?: boolean };

/** The page as the server sent it; with `live` hydrated over it; with `host` in a host that has its own phone bar. */
const withPage = async (width: number, kind: Kind, options: Options, run: (page: Page) => Promise<void>) => {
  const phone = width < 768;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
  const page = await context.newPage();
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  const { html, script } = server(kind);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${script}<style>${css}</style><style>${testCss}</style></head><body class="k2-ui"${options.host ? " data-k2-host-search" : ""}><div id="root">${html}</div></body></html>`,
    );
    if (options.live) {
      await page.addScriptTag({ content: `window.__k2HeadPlaceKind = ${JSON.stringify(kind)};` });
      await page.addScriptTag({ content: client });
      await page.waitForFunction(() => window.__k2Hydrated === true);
    }
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
};

const head = '.k2-ws-main > [data-slot="head"]';
/** Whether a part shows: it has a box and is not cut to the 1 px of a part that stays only for assistive technology. */
const shows = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element) return false;
    const box = element.getBoundingClientRect();
    return box.width > 1 && box.height > 1 && getComputedStyle(element).visibility !== "hidden";
  }, selector);
const heightOf = (page: Page, selector: string) =>
  page.evaluate((selector) => document.querySelector(selector)?.getBoundingClientRect().height ?? -1, selector);

describe("several main actions in a workspace's head", () => {
  test("the server's page already holds one \"+ Neu\" for them, and a pane's bar keeps its own", () => {
    const { html } = server("creates");
    expect(html).toContain('class="k2-creates"');
    expect(html).toContain("data-creates");
    expect(server("repeats").html).not.toContain("k2-creates");
  });

  for (const live of [false, true])
    test(`1440 px${live ? ", live" : ""}: one "+ Neu" in place of the two, the ghost action beside it`, async () => {
      await withPage(1440, "creates", { live }, async (page) => {
        expect(await shows(page, `${head} .k2-creates > .k2-btn`)).toBe(true);
        expect(await page.locator(`${head} .k2-creates > .k2-btn`).innerText()).toContain("Neu");
        expect(
          await page
            .locator(`${head} .k2-bar-end > .k2-btn[data-variant="primary"]`)
            .evaluateAll((all) => all.map((one) => getComputedStyle(one).display)),
        ).toEqual(["none", "none"]);
        expect(await shows(page, `${head} .k2-bar-end > .k2-btn[data-variant="ghost"]`)).toBe(true);
        // the round button is the phone's only
        expect(await shows(page, ".k2-fab-menu > .k2-btn")).toBe(false);
      });
    }, 30_000);

  test('1440 px: the "+" lists both by their words and runs the one picked', async () => {
    await withPage(1440, "creates", { live: true }, async (page) => {
      await page.locator(`${head} .k2-creates > .k2-btn`).click();
      const menu = page.locator('[data-k2-part="Menu"]');
      await menu.waitFor();
      expect(await menu.getByRole("menuitem").allInnerTexts()).toEqual(["Hochladen", "Neuer Ordner"]);
      await menu.getByRole("menuitem", { name: "Neuer Ordner" }).click();
      await page.waitForFunction(() => window.__k2Created === "folder");
    });
  }, 30_000);

  test('390 px: the head\'s "+" leaves, and the round button offers both', async () => {
    await withPage(390, "creates", { live: true }, async (page) => {
      expect(await shows(page, `${head} .k2-creates > .k2-btn`)).toBe(false);
      expect(await shows(page, ".k2-fab-menu > .k2-btn")).toBe(true);
      // one round button: the workspace's single main action gives way to the menu of the head's
      expect(await page.locator(".k2-fab").count()).toBe(0);
      await page.locator(".k2-fab-menu > .k2-btn").click();
      const menu = page.locator('[data-k2-part="Menu"]');
      await menu.waitFor();
      // the phone's menu is a sheet that slides in
      await settled(page);
      await menu.getByRole("menuitem", { name: "Hochladen" }).click();
      await page.waitForFunction(() => window.__k2Created === "upload");
    });
  }, 30_000);
});

describe("a head title that repeats the sidebar's current entry", () => {
  test("the server's page marks it, and only it", () => {
    expect(server("repeats").html).toMatch(/class="k2-text[^"]*"[^>]*data-names-place=""/);
    expect(server("creates").html).not.toContain("data-names-place");
  });

  for (const live of [false, true])
    test(`1440 px${live ? ", live" : ""}: the title gives way, still named, and the head keeps its action`, async () => {
      await withPage(1440, "repeats", { live }, async (page) => {
        expect(await shows(page, `${head} .k2-text`)).toBe(false);
        expect(await page.locator(`${head} .k2-text`).textContent()).toBe("Einstellungen");
        expect(await shows(page, `${head} .k2-bar-end > .k2-btn`)).toBe(true);
      });
    }, 30_000);

  test("1440 px: a head of that title alone gives way whole; 390 px: the head names the page", async () => {
    await withPage(1440, "repeatsOnly", { live: true }, async (page) => {
      expect(await heightOf(page, `${head} > .k2-bar`)).toBeLessThanOrEqual(1);
    });
    await withPage(390, "repeatsOnly", { live: true }, async (page) => {
      expect(await shows(page, `${head} .k2-text`)).toBe(true);
      expect(await heightOf(page, `${head} > .k2-bar`)).toBeGreaterThan(40);
    });
    await withPage(390, "repeats", { live: true }, async (page) => {
      expect(await shows(page, `${head} .k2-text`)).toBe(true);
    });
  }, 30_000);
});

describe("a head with nothing to show on the phone", () => {
  test("390 px: a head of only the main action the round button repeats takes no room", async () => {
    for (const live of [false, true])
      await withPage(390, "hollow", { live }, async (page) => {
        expect(await heightOf(page, `${head} > .k2-bar`)).toBe(0);
        expect(await shows(page, ".k2-fab")).toBe(true);
      });
  }, 30_000);

  test("390 px: a head search keeps the head without a host and gives way in a host until it holds words", async () => {
    await withPage(390, "hollowSearch", { live: true }, async (page) => {
      expect(await heightOf(page, `${head} > .k2-bar`)).toBeGreaterThan(40);
    });
    await withPage(390, "hollowSearch", { live: true, host: true }, async (page) => {
      expect(await heightOf(page, `${head} > .k2-bar`)).toBe(0);
    });
  }, 30_000);

  test("1440 px: the head stands as ever", async () => {
    await withPage(1440, "hollow", { live: true }, async (page) => {
      expect(await heightOf(page, `${head} > .k2-bar`)).toBeGreaterThan(40);
      expect(await shows(page, `${head} .k2-bar-end > .k2-btn`)).toBe(true);
    });
  }, 30_000);
});

describe("an open entry named after a path", () => {
  test("1440 px: its name is small, in the row of the path", async () => {
    await withPage(1440, "detail", { live: true }, async (page) => {
      const name = page.locator('.k2-pane[data-detail] > [data-slot="head"] .k2-bar-start > .k2-text');
      const path = page.locator('.k2-pane[data-detail] > [data-slot="head"] .k2-bar-start > .k2-path');
      expect(await name.evaluate((element) => getComputedStyle(element).fontSize)).toBe("14px");
      const [named, place] = await Promise.all([name.boundingBox(), path.boundingBox()]);
      expect(Math.abs(named!.y + named!.height / 2 - (place!.y + place!.height / 2))).toBeLessThanOrEqual(1);
    });
  }, 30_000);

  for (const live of [false, true])
    test(`390 px${live ? ", live" : ""}: the path gives way and the name stays, under the way back`, async () => {
      await withPage(390, "detail", { live }, async (page) => {
        const start = '.k2-pane[data-detail] > [data-slot="head"] > .k2-bar > .k2-bar-start';
        expect(await shows(page, `${start} > .k2-text`)).toBe(true);
        expect(await shows(page, `${start} > .k2-path`)).toBe(false);
        const back = await page.locator('.k2-pane[data-detail] > [data-k2-part="Back"]').boundingBox();
        const row = await page.locator('.k2-pane[data-detail] > [data-slot="head"] > .k2-bar').boundingBox();
        expect(back!.y + back!.height).toBeLessThanOrEqual(row!.y + 0.5);
      });
    }, 30_000);
});

describe("a long file name at the end of a path", () => {
  test("the server's page sends its start and its end apart, and its whole name as the hint", () => {
    const { html } = server("path");
    expect(html).toMatch(/<b[^>]* aria-current="page"[^>]* title="IMG_20260412_101500_Werkstatt_[^"]*_Espresso\.jpg"/);
    expect(html).toContain('class="k2-path-name-end"');
  });

  for (const width of [1024, 1440])
    test(`${width} px: without room it is cut in its middle, its end whole`, async () => {
      await withPage(width, "path", { live: true }, async (page) => {
        const cut = await page.evaluate(() => {
          const page = document.querySelector<HTMLElement>(".k2-path > b")!;
          const name = page.querySelector<HTMLElement>(".k2-path-name")!;
          const end = page.querySelector<HTMLElement>(".k2-path-name-end")!;
          const box = page.getBoundingClientRect();
          return {
            end: end.textContent,
            endWhole: end.scrollWidth <= end.clientWidth + 1 && end.getBoundingClientRect().right <= box.right + 0.5,
            startCut: name.scrollWidth > name.clientWidth + 1,
            inside: box.right <= page.parentElement!.getBoundingClientRect().right + 0.5,
          };
        });
        expect(cut.end).toBe("Espresso.jpg");
        expect(cut.endWhole).toBe(true);
        expect(cut.inside).toBe(true);
        expect(cut.startCut).toBe(true);
      });
    }, 30_000);
});
