import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-worst.client";

// Worst-case states that change after the page is live (break-ui 25.11., review of #4210): a note that grows past its
// lines, a hidden tab that becomes the open one, an address cut in the middle in a narrow row, an amount among marks.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-worst.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
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

test("a summary that grows past its four lines after the page is live offers 'Mehr anzeigen'", async () => {
  await withPage(1024, async (page) => {
    const more = page.getByRole("button", { name: "Mehr anzeigen" });
    expect(await more.count()).toBe(0);
    await page.evaluate(() => window.__k2GrowNote?.());
    await more.waitFor();
    await more.click();
    await page.getByText("Sechste Zeile").waitFor();
    expect(await page.getByRole("button", { name: "Weniger anzeigen" }).isVisible()).toBe(true);
  });
});

test("a hidden tab that becomes the open one shows, cut if it must, and is no entry of the menu", async () => {
  await withPage(420, async (page) => {
    const tab = page.locator(".k2-tab", { hasText: "Entwürfe" });
    expect(await tab.evaluate((element) => getComputedStyle(element).visibility)).toBe("hidden");
    await page.evaluate(() => window.__k2OpenTab?.("Entwürfe"));
    await settled(page);
    expect(await tab.getAttribute("aria-current")).toBe("page");
    expect(await tab.evaluate((element) => getComputedStyle(element).visibility)).toBe("visible");
    const box = await tab.boundingBox();
    const line = await page.locator(".k2-tabs").boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual((line?.y ?? 0) + (line?.height ?? 0) + 0.5);
  });
});

test("an address with a short start, cut in the middle, stays inside its row and ends in '…'", async () => {
  await withPage(240, async (page) => {
    const parts = await page.evaluate(() => {
      const cut = document.querySelector(".k2-midcut")!;
      const title = cut.closest(".k2-row-title")!.getBoundingClientRect();
      const end = cut.lastElementChild as HTMLElement;
      return {
        overflow: Math.max(0, cut.getBoundingClientRect().right - title.right, end.getBoundingClientRect().right - title.right),
        cut: end.scrollWidth > end.clientWidth,
        ellipsis: getComputedStyle(end).textOverflow,
      };
    });
    expect(parts.overflow).toBeLessThanOrEqual(0.5);
    expect(parts.cut).toBe(true);
    expect(parts.ellipsis).toBe("ellipsis");
  });
});

for (const width of [1024, 220])
  test(`an amount among a row's marks is never cut at ${width} px: it shows whole or leaves whole`, async () => {
    await withPage(width, async (page) => {
      const amount = await page.evaluate(() => {
        const chip = document.querySelector(".k2-row-marks > .k2-chip")!;
        const marks = chip.closest(".k2-row-marks")!.getBoundingClientRect();
        const words = chip.querySelector(".k2-chip-text")!;
        const box = chip.getBoundingClientRect();
        const inside =
          box.left >= marks.left - 0.5 && box.right <= marks.right + 0.5 && box.top >= marks.top - 0.5 && box.bottom <= marks.bottom + 0.5;
        const outside = box.top >= marks.bottom || box.bottom <= marks.top;
        return {
          whole: words.scrollWidth <= words.clientWidth + 0.5,
          inside,
          outside,
          box: [box.left, box.top, box.right, box.bottom].map(Math.round),
          marks: [marks.left, marks.top, marks.right, marks.bottom].map(Math.round),
        };
      });
      expect(amount).toEqual(expect.objectContaining({ whole: true }));
      expect(amount.inside || amount.outside).toBe(true);
      if (width === 1024) expect(amount.inside).toBe(true);
    });
  });
