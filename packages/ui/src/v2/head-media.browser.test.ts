import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-head-media.client";
import { measureV2Layout } from "./testing";

// The second part of the design pass (26.11.), in the browser on the recipes that use it: a page head of two rows
// (path and deeds, then the filter bar with count, order and display), a selection that takes the bar's place at the
// same height and floats its actions at the bottom on the phone, media tiles that people select, the large preview of
// the open file, a storage quota in the sidebar, marks in table cells, and settings with their value beside them.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }";

type Case = "list" | "grid" | "selecting" | "settings";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-head-media.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (which: Case, run: (page: Page) => Promise<void>, width = 1440, touch = false) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style><script>window.__k2Case = ${JSON.stringify(which)};</script></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".k2-mk[data-image]")].every((mark) => mark.getAttribute("data-image") !== ""),
    );
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const rect = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height };
    });

test("the head has two full-width rows above list and detail: path and deeds, then the filter bar", async () => {
  await withPage("list", async (page) => {
    const head = await rect(page, "[data-slot='head'] > .k2-bar");
    const bar = await rect(page, ".k2-fbar");
    const list = await rect(page, ".k2-table");
    const detail = await rect(page, ".k2-pane[data-detail]");
    // the filter bar is the status row of its list: 52 px, right under the head, over list and detail alike
    expect(bar.height).toBe(52);
    expect(Math.round(bar.top)).toBe(Math.round(head.bottom));
    expect(bar.right).toBeGreaterThanOrEqual(detail.right - 1);
    expect(Math.round(list.top)).toBeGreaterThanOrEqual(Math.round(bar.bottom));
    // no third row: the list's own head row and the detail's head start where the bar ends
    expect(await page.locator(".k2-bar[data-status-row]").count()).toBe(0);
    // count, order and display at its end
    const tail = await page.locator(".k2-fbar-tail").evaluate((element) => ({
      results: element.querySelector(".k2-fbar-results")?.textContent,
      buttons: [...element.querySelectorAll(".k2-btn")].map((button) => button.textContent?.trim()),
    }));
    expect(tail.results).toBe("13 Einträge · 186 MB");
    expect(tail.buttons.at(-1)).toBe("Liste");
  });
});

test("a selection takes the bar's place at the same height, so the list does not move", async () => {
  let before = 0;
  await withPage("grid", async (page) => {
    before = (await rect(page, ".k2-tiles")).top;
  });
  await withPage("selecting", async (page) => {
    const bar = await rect(page, ".k2-bar[data-selecting]");
    expect(bar.height).toBe(52);
    expect((await rect(page, ".k2-tiles")).top).toBe(before);
    expect(await page.locator(".k2-bar[data-selecting] .k2-status-lead").textContent()).toBe("3 ausgewählt");
  });
});

test("media tiles: picture 4:3, a box that shows on hover and on every tile while one is selected", async () => {
  await withPage("grid", async (page) => {
    const tile = page.locator(".k2-tiles[data-variant='media'] > .k2-tile").first();
    const shape = await tile.evaluate((element) => {
      const picture = element.querySelector(".k2-tile-media > .k2-mk")!.getBoundingClientRect();
      return {
        wide: element.getBoundingClientRect().width >= 160,
        ratio: Math.round((picture.width / picture.height) * 100) / 100,
        box: getComputedStyle(element.querySelector(".k2-tile-check")!).opacity,
      };
    });
    expect(shape).toEqual({ wide: true, ratio: 1.33, box: "0" });
    await tile.hover();
    expect(await tile.locator(".k2-tile-check").evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    // the box is named by the tile's title and selects it
    await page.getByRole("checkbox", { name: "Ansicht Front Eiche.jpg" }).check();
    await settled(page);
    const selected = await tile.evaluate((element) => ({
      on: element.hasAttribute("data-selected"),
      background: getComputedStyle(element).backgroundColor,
      line: getComputedStyle(element).boxShadow,
    }));
    expect(selected.on).toBe(true);
    expect(selected.background).toBe("rgb(239, 246, 255)");
    expect(selected.line).toContain("inset");
    // while one is selected every box shows, and the selection bar has taken the filter bar's place
    const boxes = await page
      .locator(".k2-tile-check")
      .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).opacity));
    expect(new Set(boxes)).toEqual(new Set(["1"]));
    expect(await page.locator(".k2-bar[data-selecting] .k2-status-lead").textContent()).toBe("1 ausgewählt");
  });
});

test("on touch every box shows, and the tile still opens its file", async () => {
  await withPage(
    "grid",
    async (page) => {
      expect(
        await page
          .locator(".k2-tile-check")
          .first()
          .evaluate((element) => getComputedStyle(element).opacity),
      ).toBe("1");
      expect(await page.locator(".k2-tile-title a").first().getAttribute("href")).toBe("#front");
    },
    390,
    true,
  );
});

test("on the phone the actions of a selection float at the bottom, symbol over word, and the main action gives way", async () => {
  await withPage(
    "selecting",
    async (page) => {
      const bar = await rect(page, ".k2-status-actions");
      expect(Math.round(900 - bar.bottom)).toBe(16);
      const labels = await page
        .locator(".k2-status-actions .k2-btn-label")
        .evaluateAll((elements) =>
          elements.map((element) => ({ text: element.textContent, visible: element.getBoundingClientRect().width > 1 })),
        );
      expect(labels).toEqual([
        { text: "Teilen", visible: true },
        { text: "Verschieben", visible: true },
        { text: "Als ZIP laden", visible: true },
        { text: "Löschen", visible: true },
      ]);
      expect(await page.locator(".k2-fab").evaluate((element) => getComputedStyle(element).display)).toBe("none");
    },
    390,
  );
});

test("the open file shows a large preview 4:3 from edge to edge, and the list leads each file with its thumbnail", async () => {
  await withPage("list", async (page) => {
    const preview = await page.locator("[data-k2-part='Preview']").evaluate((element) => {
      const box = element.getBoundingClientRect();
      const pane = element.closest(".k2-pane")!.getBoundingClientRect();
      return {
        state: element.getAttribute("data-image"),
        name: element.getAttribute("aria-label"),
        ratio: Math.round((box.width / box.height) * 100) / 100,
        edges: [Math.round(box.left - pane.left), Math.round(pane.right - box.right)],
      };
    });
    expect(preview).toEqual({ state: "shown", name: "Vorschau von Ansicht Front Eiche.jpg", ratio: 1.33, edges: [20, 20] });
    const cell = await page
      .locator(".k2-table tbody tr:not([data-group]) td .k2-cell-lead")
      .first()
      .evaluate((element) => ({
        mark: element.querySelector(".k2-mk")?.getBoundingClientRect().width,
        name: element.querySelector(".k2-cell-line")?.textContent,
      }));
    expect(cell.mark).toBe(24);
    expect(cell.name).toBe("Aufmaß");
    // the owner leads its cell as a person
    expect(await page.locator(".k2-table td .k2-cell-lead > .k2-av").count()).toBeGreaterThan(5);
  });
});

test("in rows of two lines a file keeps its thumbnail beside its box", async () => {
  await withPage(
    "list",
    async (page) => {
      const lead = await page
        .locator(".k2-table-phone .k2-row", { hasText: "Ansicht Front Eiche.jpg" })
        .locator(".k2-row-lead")
        .evaluate((element) => {
          const box = element.querySelector(".k2-mark")!.getBoundingClientRect();
          const mark = element.querySelector(".k2-mk")!.getBoundingClientRect();
          return { side: mark.left > box.right, mark: `${mark.width}x${mark.height}`, middle: Math.abs(box.top + box.height / 2 - (mark.top + mark.height / 2)) < 1 };
        });
      expect(lead).toEqual({ side: true, mark: "32x32", middle: true });
    },
    1024,
  );
});

test("the sidebar shows what the storage uses, as a meter with its words", async () => {
  await withPage("list", async (page) => {
    const meter = page.getByRole("meter", { name: "Werkstatt" });
    expect(await meter.getAttribute("aria-valuetext")).toBe("38,2 von 100 GB");
    expect(await meter.getAttribute("data-status")).toBeNull();
    expect(
      await meter.locator(".k2-nav-quota-track > i").evaluate((element) => Math.round(element.getBoundingClientRect().width)),
    ).toBeGreaterThan(0);
  });
});

test("a setting stands with its value beside its name, and an unsaved change says what it was", async () => {
  await withPage("settings", async (page) => {
    const setting = page.locator("[data-k2-part='Setting']").first();
    const found = await setting.evaluate((element) => {
      const label = element.querySelector(".k2-field-label")!.getBoundingClientRect();
      const control = element.querySelector(".k2-input")!.getBoundingClientRect();
      const was = element.querySelector(".k2-field-was");
      return {
        beside: control.left > label.right,
        width: Math.round(control.width),
        was: was?.textContent,
        under: was ? was.getBoundingClientRect().top >= control.bottom : false,
      };
    });
    expect(found).toEqual({ beside: true, width: 300, was: "geändert · vorher 12 Std.", under: true });
    // the controls of all settings stand in one line down the page
    const lefts = await page
      .locator("[data-k2-part='Setting'] > :is(.k2-input, .k2-check)")
      .evaluateAll((elements) => [...new Set(elements.map((element) => Math.round(element.getBoundingClientRect().left)))]);
    expect(lefts.length).toBe(1);
  });
  await withPage(
    "settings",
    async (page) => {
      const found = await page
        .locator("[data-k2-part='Setting']")
        .first()
        .evaluate((element) => ({
          under:
            element.querySelector(".k2-input")!.getBoundingClientRect().top >=
            element.querySelector(".k2-field-label")!.getBoundingClientRect().bottom,
        }));
      expect(found).toEqual({ under: true });
    },
    390,
  );
});

for (const which of ["list", "grid", "selecting", "settings"] as const)
  for (const width of [1440, 1024, 390])
    test(`${which} keeps the layout rules at ${width} px`, async () => {
      await withPage(
        which,
        async (page) => {
          const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
          expect(layout.problems).toEqual([]);
        },
        width,
      );
    });
