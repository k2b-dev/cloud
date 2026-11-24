import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";
import { measureV2Layout } from "./testing";
import { heights, radii } from "./tokens";

// Dialog and Menu of v2 in a real engine, with v2.css: the boxes of the mockup (a dialog of 480 px in the middle, head
// and foot of 56 px, no line between its parts unless content scrolls behind them; on a small touch screen a sheet
// from the bottom; menu entries of 32 px), the layout rules of measureV2Layout while they are open, and the behaviour
// they promise (Escape, focus return).

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
// Icons take one em without their font, so the layout does not depend on a font file in the test.
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  // The bundler resolves the entry beside the behaviour harness; ours lives one folder up in test/.
  [bundle, browser] = await Promise.all([demoBundle("../v2-overlays"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>, { width = 1440, scale = 1, long = false, touch = false } = {}) => {
  // a phone: a touch screen with a coarse pointer, where the dialog presents as a sheet
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: scale, hasTouch: touch, isMobile: touch });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"${long ? " data-long" : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
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

const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (!found) throw new Error("no box");
  return found;
};
const problems = async (page: Page, root: string) => (await measureV2Layout(page, { root })).problems;
const openDialog = async (page: Page) => {
  await page.getByRole("button", { name: "Abbrechen" }).click();
  await page.locator(".k2-dialog").waitFor();
  await settled(page);
};
// The line at the edge of a dialog part: its box-shadow, "none" when it has none.
const edge = (page: Page, slot: "head" | "foot") =>
  page.evaluate((s) => getComputedStyle(document.querySelector(`.k2-dialog > [data-slot="${s}"] > .k2-bar`) as Element).boxShadow, slot);

for (const scale of [1, 2]) {
  test(`dialog at DPR ${scale}: 480 px in the middle, head and foot 56 px, one surface without lines`, async () => {
    await withPage(
      async (page) => {
        await openDialog(page);
        const dialog = await box(page.locator(".k2-dialog"));
        expect(dialog.width).toBe(480);
        expect(Math.abs(dialog.x + dialog.width / 2 - 720)).toBeLessThanOrEqual(1);
        expect(Math.abs(dialog.y + dialog.height / 2 - 450)).toBeLessThanOrEqual(1);
        expect((await box(page.locator('.k2-dialog > [data-slot="head"] > .k2-bar'))).height).toBe(heights.head);
        expect((await box(page.locator('.k2-dialog > [data-slot="foot"] > .k2-bar'))).height).toBe(heights.head);
        expect(await page.locator(".k2-dialog").getAttribute("data-more")).toBeNull();
        expect(await edge(page, "head")).toBe("none");
        expect(await edge(page, "foot")).toBe("none");
        expect(await problems(page, ".k2-dialog")).toEqual([]);
        // the close button stands with its icon on the text edge: 28 px, its right side 10 px past the edge of 20
        const close = await box(page.locator('.k2-dialog > [data-slot="head"] .k2-btn'));
        expect([close.width, close.height, dialog.x + dialog.width - (close.x + close.width)]).toEqual([28, 28, 10]);
        expect((await box(page.locator(".k2-backdrop"))).width).toBe(1440);
      },
      { scale },
    );
  });
}

test("dialog: Escape closes it and focus returns to the button that opened it", async () => {
  await withPage(async (page) => {
    await openDialog(page);
    const inside = () => page.evaluate(() => document.querySelector(".k2-dialog")?.contains(document.activeElement));
    expect(await inside()).toBe(true);
    // Tab and Shift+Tab go round inside the dialog: close, the two buttons of the foot, and back
    for (const key of ["Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      expect(await inside()).toBe(true);
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".k2-dialog"));
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Abbrechen");
  });
});

test("dialog with more content than fits: it scrolls, and a line shows only at the edge behind which content lies", async () => {
  await withPage(
    async (page) => {
      await openDialog(page);
      const dialog = page.locator(".k2-dialog");
      expect((await box(dialog)).height).toBeLessThanOrEqual(900 - 64);
      expect(await dialog.getAttribute("data-more")).toBe("below");
      expect(await edge(page, "head")).toBe("none");
      expect(await edge(page, "foot")).not.toBe("none");
      await page.locator(".k2-dialog-body").evaluate((body) => body.scrollTo({ top: body.scrollHeight }));
      await page.waitForFunction(() => document.querySelector(".k2-dialog")?.getAttribute("data-more") === "above");
      expect(await edge(page, "head")).not.toBe("none");
      expect(await edge(page, "foot")).toBe("none");
    },
    { long: true },
  );
});

// A narrow window without touch (a small desktop window) keeps the dialog form, 16 px from the window's edges.
test("in a narrow window without touch the dialog keeps 16 px to the edges of the window", async () => {
  await withPage(
    async (page) => {
      await openDialog(page);
      const dialog = page.locator(".k2-dialog");
      expect(await dialog.getAttribute("data-presentation")).toBe("dialog");
      const found = await box(dialog);
      expect([found.x, found.width]).toEqual([16, 358]);
      expect(await problems(page, ".k2-dialog")).toEqual([]);
    },
    { width: 390 },
  );
});

// The mockup: "a dialog, on the phone a sheet". On a small touch screen core presents it as a sheet from the bottom:
// the whole width, its top corners round, at the bottom of the window; Escape still closes it.
test("dialog on a phone: a sheet from the bottom, the whole width, its top corners round", async () => {
  await withPage(
    async (page) => {
      await openDialog(page);
      const dialog = page.locator(".k2-dialog");
      expect(await dialog.getAttribute("data-presentation")).toBe("sheet");
      const sheet = await box(dialog);
      expect([sheet.x, sheet.width, Math.round(sheet.y + sheet.height)]).toEqual([0, 390, 900]);
      const radius = await dialog.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius];
      });
      expect(radius).toEqual([`${radii.overlay}px`, `${radii.overlay}px`, "0px", "0px"]);
      expect((await box(page.locator('.k2-dialog > [data-slot="head"] > .k2-bar'))).height).toBe(heights.head);
      expect(await problems(page, ".k2-dialog")).toEqual([]);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector(".k2-dialog"));
    },
    { width: 390, touch: true },
  );
});

// Dialog.confirm (the concept's question before something that cannot be taken back): an alert dialog in the shape of
// Dialog, rendered by Workspace. No close button; focus starts on the other button, Escape and that button answer no,
// a press outside does nothing, the agreeing button answers yes, and it is never a sheet.
for (const touch of [false, true])
  test(`Dialog.confirm${touch ? " on a phone" : ""}: an alert dialog that answers yes or no`, async () => {
    await withPage(
      async (page) => {
        const ask = async () => {
          await page.getByRole("button", { name: "Löschen", exact: true }).click();
          await page.getByRole("alertdialog", { name: "Auftrag löschen?" }).waitFor();
          await settled(page);
        };
        const answer = () => page.getByText(/^Antwort: /).textContent();
        await ask();
        const dialog = page.locator(".k2-dialog[data-alert]");
        expect(await dialog.getAttribute("data-presentation")).not.toBe("sheet");
        expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Abbrechen");
        expect(await page.locator('.k2-dialog[data-alert] > [data-slot="head"] .k2-btn').count()).toBe(0);
        expect(await problems(page, ".k2-dialog")).toEqual([]);
        // a press outside does not answer
        await page.mouse.click(4, 4);
        await settled(page);
        expect(await dialog.count()).toBe(1);
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => !document.querySelector(".k2-dialog"));
        expect(await answer()).toBe("Antwort: nein");
        await ask();
        await page.getByRole("button", { name: "Löschen", exact: true }).last().click();
        await page.waitForFunction(() => document.body.textContent?.includes("Antwort: ja"));
        expect(await answer()).toBe("Antwort: ja");
      },
      touch ? { width: 390, touch } : {},
    );
  });
