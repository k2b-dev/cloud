import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-tiles-dnd.demo";

// Picture tiles and dragging onto folders in v2 (test/v2-tiles-dnd.demo.tsx): the picture box keeps its shape, the grid
// is one Tab stop with arrows, Space selects and Enter opens; tiles and rows drag onto folders of the tree, the table
// and the tiles; files from the computer drop onto a folder. Runs in Chromium and in WebKit (TEST_BROWSER=webkit).

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-tiles-dnd"), serverMarkup("../v2-tiles-dnd"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(3000);
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

const tiles = (page: Page) => page.getByRole("listbox", { name: "Dateien als Kacheln" });
const tile = (page: Page, name: string) => tiles(page).getByRole("option", { name, exact: true });
const folder = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true }).locator(":scope > .k2-nt-row");
const tableRow = (page: Page, name: string) =>
  page.getByRole("table", { name: "Dateien als Tabelle" }).locator("tbody tr", { hasText: name });

/** A mouse drag from the middle of `from` to the middle of `to`, in steps, resting `rest` ms over the target. */
const dragTo = async (page: Page, from: Locator, to: Locator, rest = 0) => {
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  if (!start || !end) throw new Error("dragTo: element not on screen");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 12, start.y + start.height / 2 + 12, { steps: 3 });
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  if (rest) await page.waitForTimeout(rest);
};

test("server markup: picture tiles stand in a grid of their size, each picture over its symbol", () => {
  expect(markup).toMatch(/class="k2-tiles\s*"[^>]*data-size="m"/);
  expect(markup).toMatch(/<span class="k2-tile-pic"><i[^>]*ti-photo[^>]*><\/i><img[^>]*loading="lazy"/);
});

test("tiles: the picture box keeps one shape with a picture, a broken one and none, in every size", async () => {
  await withPage(async (page) => {
    for (const size of ["s", "m", "l"] as const) {
      await page.evaluate((next) => window.__size?.(next), size);
      await settled(page);
      const boxes = await tiles(page)
        .locator(".k2-tile-pic")
        .evaluateAll((pics) =>
          pics.map((pic) => pic.getBoundingClientRect()).map((rect) => ({ w: Math.round(rect.width), h: Math.round(rect.height) })),
        );
      const first = boxes[0]!;
      for (const box of boxes) expect(box).toEqual(first);
      expect(first.h).toBe(Math.round((first.w * 3) / 4));
      expect(first.w).toBeGreaterThanOrEqual({ s: 128, m: 176, l: 248 }[size]);
    }
    // the broken picture draws nothing: its symbol shows through
    const broken = tile(page, "Beschädigt.png").locator("img");
    await page.waitForFunction(() => [...document.images].every((image) => image.complete));
    expect(await broken.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(0);
    expect(await tile(page, "Beschädigt.png").locator(".k2-tile-pic > .ti").isVisible()).toBe(true);
    // a long name is cut, the tile keeps its width
    const title = tile(page, "Werkstatt mit einem sehr langen Dateinamen, der nicht passt.jpg").locator(".k2-tile-title");
    expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  });
});

test("tiles: one Tab stop, arrows follow the grid, Space selects, Enter opens", async () => {
  await withPage(async (page) => {
    await tile(page, "Belege").focus();
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Fotos");
    await page.keyboard.press("Space");
    expect(await tile(page, "Fotos").getAttribute("aria-selected")).toBe("true");
    await page.keyboard.press("End");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Angebot.pdf");
    await page.keyboard.press("Enter");
    expect(await tile(page, "Angebot.pdf").getAttribute("aria-current")).toBe("true");
    // the tiles are one stop: Tab leaves them, past their boxes and names
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest('[role="listbox"]'))).toBeNull();
    expect(await tiles(page).locator('[tabindex="0"]').count()).toBe(1);
  });
});

test("drag: a tile onto a folder of the tree, with a chip under the pointer and a place where letting go does nothing", async () => {
  await withPage(async (page) => {
    await dragTo(page, tile(page, "Messestand.jpg"), folder(page, "Projekte"));
    expect(await folder(page, "Projekte").getAttribute("data-drop-over")).toBe("");
    expect(await page.getByText("Hier loslassen: nichts passiert").isVisible()).toBe(true);
    expect(await page.locator("[data-drag-preview]").textContent()).toBe("Messestand.jpg");
    expect(await page.evaluate(() => window.__moves)).toBeUndefined();
    await page.mouse.up();
    expect(await page.evaluate(() => window.__moves)).toEqual(["messe>projekte"]);
    expect(await page.getByText("Hier loslassen: nichts passiert").count()).toBe(0);
  });
});

test("drag: a folder that does not take it says so; letting go there, on the zone or with Escape changes nothing", async () => {
  await withPage(async (page) => {
    await dragTo(page, tile(page, "Angebot.pdf"), tile(page, "Fotos"));
    expect(await tile(page, "Fotos").getAttribute("data-drop-refused")).toBe("");
    expect(await tile(page, "Fotos").getAttribute("data-drop-over")).toBeNull();
    await page.mouse.up();
    await dragTo(page, tile(page, "Angebot.pdf"), page.getByText("Hier loslassen: nichts passiert"));
    await page.mouse.up();
    await dragTo(page, tile(page, "Angebot.pdf"), folder(page, "Archiv"));
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect(await page.evaluate(() => window.__moves)).toBeUndefined();
  });
});

test("drag: resting on a closed folder opens it, so a level below is reached", async () => {
  await withPage(async (page) => {
    const archive = page.getByRole("treeitem", { name: "Archiv", exact: true });
    expect(await archive.getAttribute("aria-expanded")).toBe("false");
    await dragTo(page, tableRow(page, "Angebot.pdf"), folder(page, "Archiv"), 900);
    expect(await archive.getAttribute("aria-expanded")).toBe("true");
    const year = folder(page, "2025");
    const box = await year.boundingBox();
    if (!box) throw new Error("2025 not shown");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.__moves)).toEqual(["angebot>archiv-2025"]);
  });
});

test("drag: selected rows go together onto a folder row; a click without moving still opens the row", async () => {
  await withPage(async (page) => {
    await tableRow(page, "Messestand.jpg").locator("input").check();
    await tableRow(page, "Angebot.pdf").locator("input").check();
    await dragTo(page, tableRow(page, "Angebot.pdf"), tableRow(page, "Belege"));
    expect(await tableRow(page, "Messestand.jpg").getAttribute("data-dragging")).toBe("");
    expect(await page.locator("[data-drag-preview]").textContent()).toBe("2 Einträge");
    await page.mouse.up();
    expect(await page.evaluate(() => window.__moves)).toEqual(["messe+angebot>belege"]);
    await tableRow(page, "Werkstatt").click();
    expect(await tableRow(page, "Werkstatt").getAttribute("aria-current")).toBe("true");
  });
});

test("files from the computer drop onto a folder row and a folder of the tree", async () => {
  await withPage(async (page) => {
    for (const [selector, name] of [
      ['.k2-table tbody tr[data-drop-target="belege"]', "belege"],
      ['.k2-nt-row[data-drop-target="projekte"]', "projekte"],
    ] as const) {
      const over = await page.evaluate((target) => {
        const element = document.querySelector(target);
        if (!element) return "missing";
        const data = new DataTransfer();
        data.items.add(new File(["x"], "Rechnung.pdf", { type: "application/pdf" }));
        element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
        const shown = element.hasAttribute("data-drop-over");
        element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
        return shown ? "over" : "not over";
      }, selector);
      expect(over).toBe("over");
      expect(await page.evaluate(() => window.__files?.at(-1))).toBe(`Rechnung.pdf>${name}`);
    }
  });
});
