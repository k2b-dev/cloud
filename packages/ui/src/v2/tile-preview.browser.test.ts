import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-tile-preview.client";
import { measureV2Layout } from "./testing";

// A card's preview (`Tile` `preview`, mockup empty-start-tiles v4): across the top of the card, edge to edge above its
// name, 112 px on the quiet surface (84 px and two columns on the phone): a small table of words, a page, or a sign.
// It is a picture: assistive technology reads the card by its name. Long words end in "…" and never widen the card.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-tile-preview.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (viewport: { width: number; height: number }, worst: boolean, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui" data-worst="${worst ? 1 : 0}"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** Each card's box, its preview's box and what the preview shows. */
const cards = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".k2-tiles > .k2-tile")].map((card) => {
      const preview = card.querySelector<HTMLElement>(".k2-tile-preview");
      const box = card.getBoundingClientRect();
      const top = preview?.getBoundingClientRect();
      return {
        width: Math.round(box.width),
        preview: top && {
          // edge to edge across the top of the card, inside its hairline
          left: Math.round(top.left - box.left),
          right: Math.round(box.right - top.right),
          top: Math.round(top.top - box.top),
          height: Math.round(top.height),
          hidden: preview?.getAttribute("aria-hidden"),
          columns: [...(preview?.querySelectorAll("th") ?? [])].filter((cell) => getComputedStyle(cell).display !== "none").length,
          page: preview?.querySelector(".k2-tile-pv-page b")?.textContent ?? null,
        },
      };
    }),
  );

test("each card carries its preview across its top: 112 px, edge to edge, hidden from assistive technology", async () => {
  await withPage({ width: 1440, height: 900 }, false, async (page) => {
    const shown = await cards(page);
    expect(shown).toHaveLength(4);
    for (const card of shown) {
      expect(card.preview).toMatchObject({ left: 1, right: 1, top: 1, height: 112, hidden: "true" });
    }
    expect(shown.map((card) => card.preview?.columns)).toEqual([0, 3, 3, 0]);
    expect(shown[3]?.preview?.page).toBe("Tagebuch");
    // the name of the card stays its name: the preview's words are not part of it
    expect(await page.getByRole("link", { name: "Private Finanzen" }).count()).toBe(1);
    expect((await measureV2Layout(page)).problems).toEqual([]);
  });
});

test("on the phone the preview is 84 px and shows two columns", async () => {
  await withPage({ width: 390, height: 844 }, false, async (page) => {
    const shown = await cards(page);
    for (const card of shown) expect(card.preview?.height).toBe(84);
    expect(shown[1]?.preview?.columns).toBe(2);
    expect((await measureV2Layout(page)).problems).toEqual([]);
  });
});

test("a long word in the preview ends in … and leaves the cards as wide as each other", async () => {
  await withPage({ width: 1440, height: 900 }, true, async (page) => {
    const widths = (await cards(page)).map((card) => card.width);
    expect(new Set(widths).size).toBe(1);
    const cut = await page
      .locator(".k2-tile-pv-table td", { hasText: "Arbeitgeber-Gesellschaft" })
      .evaluate((cell) => cell.scrollWidth > cell.clientWidth && getComputedStyle(cell).textOverflow === "ellipsis");
    expect(cut).toBe(true);
  });
});

// W5 (Pulse) and the coordinator: a start card is a button when it opens a dialog in place. The whole card presses it,
// and its name is cut with "…" like a link's (a button cut hard before).
for (const width of [1440, 390])
  test(`at ${width} px a card with onOpen is one button the whole card presses, its long name cut with …`, async () => {
    await withPage({ width, height: 900 }, true, async (page) => {
      const card = page.locator(".k2-tiles > .k2-tile").last();
      const button = card.locator(".k2-tile-title > button.k2-row-open");
      expect(await button.count()).toBe(1);
      expect(await card.locator("a").count()).toBe(0);
      expect(await card.getAttribute("data-open")).toBe("");
      // a press on the preview, far from the name, presses the card's button
      const preview = await card.locator(".k2-tile-preview").boundingBox();
      await page.mouse.click(preview!.x + preview!.width / 2, preview!.y + preview!.height / 2);
      await settled(page);
      expect(await page.evaluate(() => window.__k2TilePresses)).toBe(1);
      await button.focus();
      await page.keyboard.press("Enter");
      await settled(page);
      expect(await page.evaluate(() => window.__k2TilePresses)).toBe(2);
      const cut = await button.evaluate((element) => ({
        overflow: getComputedStyle(element).textOverflow,
        fits: element.scrollWidth <= element.clientWidth,
      }));
      expect(cut.overflow).toBe("ellipsis");
      if (width === 390) expect(cut.fits).toBe(false);
    });
  });
