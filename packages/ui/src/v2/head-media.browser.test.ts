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

type Case = "list" | "closed" | "grid" | "selecting" | "settings" | "states" | "canvas" | "cells" | "path" | "split-canvas";

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
  // a real address, so a sort or filter chosen in the bar can write it
  await page.route("http://head-media.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style><script>window.__k2Case = ${JSON.stringify(which)};</script></head><body class="k2-ui"><div id="root"></div></body></html>`,
    }),
  );
  try {
    await page.goto("http://head-media.test/dateien");
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

test("on the phone how the list shows stays in reach: sort, grouping and display in one menu 'Ansicht'", async () => {
  await withPage(
    "closed",
    async (page) => {
      const button = page.locator(".k2-fbar-view").getByRole("button", { name: "Ansicht" });
      expect(await button.isVisible()).toBe(true);
      // at the end of the bar, inside the window
      const box = (await button.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      await button.click();
      await settled(page);
      const menu = page.getByRole("menu");
      for (const title of ["Sortierung", "Darstellung"]) expect(await menu.getByText(title, { exact: true }).count()).toBe(1);
      expect(await menu.getByRole("menuitemradio", { name: "Raster" }).count()).toBe(1);
      // a sort chosen here writes the list's address, as the sort of the desktop does
      await menu
        .getByRole("menuitemradio", { name: /Geändert/ })
        .first()
        .click();
      await settled(page);
      expect(await page.evaluate(() => new URL(location.href).searchParams.get("sort"))).toMatch(/^changed\./);
    },
    390,
  );
});

test("on the desktop the display is a menu of its own beside the order, and the phone's menu stays away", async () => {
  await withPage("list", async (page) => {
    expect(await page.locator(".k2-fbar-view").isVisible()).toBe(false);
    expect(await page.locator(".k2-fbar-display").getByRole("button", { name: /Liste/ }).isVisible()).toBe(true);
  });
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
    await settled(page);
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
        { text: "Laden", visible: true },
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

test("on the phone a group head is the same text with its count, not a band (review #4226)", async () => {
  // the folder on the phone, and the list beside an open file at 1024 px, where the list takes its rows of two lines
  for (const [which, width] of [
    ["closed", 390],
    ["list", 1024],
  ] as const)
    await withPage(
      which,
      async (page) => {
        const found = await page.evaluate(() =>
          [...document.querySelectorAll(".k2-table-phone-group")].map((head) => {
            const style = getComputedStyle(head);
            const row = head.querySelector(".k2-group-row")!;
            return {
              text: row.textContent,
              band: style.backgroundColor,
              line: style.borderBottomWidth,
              weight: getComputedStyle(row).fontWeight,
              height: Math.round(head.getBoundingClientRect().height),
            };
          }),
        );
        expect(found).toEqual([
          { text: "Ordner2", band: "rgba(0, 0, 0, 0)", line: "0px", weight: "600", height: 36 },
          { text: "Dateien11", band: "rgba(0, 0, 0, 0)", line: "0px", weight: "600", height: 36 },
        ]);
        expect(await page.locator(".k2-table-phone .k2-bar").count()).toBe(0);
      },
      width,
    );
});

test("a group head is text with its count, not a band, and no line stands under the last row", async () => {
  await withPage("list", async (page) => {
    const found = await page.evaluate(() => {
      const heads = [...document.querySelectorAll(".k2-table tr[data-group] > td")];
      const rows = [...document.querySelectorAll(".k2-table tbody tr:not([data-group])")];
      const last = rows.at(-1)!.querySelector("td")!;
      const before = heads[1]!.parentElement!.previousElementSibling!.querySelector("td")!;
      return {
        heads: heads.map((td) => td.querySelector(".k2-group-row")?.textContent),
        band: heads.map((td) => getComputedStyle(td).backgroundColor),
        under: heads.map((td) => getComputedStyle(td).borderBottomWidth),
        weight: getComputedStyle(heads[0]!.querySelector(".k2-group-row")!).fontWeight,
        // the groups are separated by the line under the row before the next head
        between: getComputedStyle(before).borderBottomWidth,
        end: getComputedStyle(last).borderBottomWidth,
      };
    });
    expect(found).toEqual({
      heads: ["Ordner2", "Dateien11"],
      band: ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"],
      under: ["0px", "0px"],
      weight: "600",
      between: "1px",
      end: "0px",
    });
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
          return {
            side: mark.left > box.right,
            mark: `${mark.width}x${mark.height}`,
            middle: Math.abs(box.top + box.height / 2 - (mark.top + mark.height / 2)) < 1,
          };
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

test("a setting goes to one column by the width of its pane, so its name never runs into its value (review #4223)", async () => {
  // at 800 px of window the settings pane is narrow beside the sidebar and the side column, while the window is no phone
  for (const width of [800, 1024, 1440])
    await withPage(
      "settings",
      async (page) => {
        const crossed = await page.evaluate(() =>
          [...document.querySelectorAll("[data-k2-part='Setting']")]
            .map((setting) => {
              const label = setting.querySelector<HTMLElement>(".k2-field-label")!;
              const control = setting
                .querySelector(":scope > :not(.k2-field-label, .k2-field-message, .k2-field-was)")!
                .getBoundingClientRect();
              const box = label.getBoundingClientRect();
              const beside = control.left > box.left;
              return { name: label.textContent, bad: label.scrollWidth > label.clientWidth + 1 || (beside && box.right > control.left) };
            })
            .filter((setting) => setting.bad)
            .map((setting) => setting.name),
        );
        expect(crossed).toEqual([]);
      },
      width,
    );
});

test("on the phone the end of the list stays above the floating actions of a selection (review #4223)", async () => {
  await withPage(
    "selecting",
    async (page) => {
      const found = await page.evaluate(() => {
        // scrolled to the very end: every column that scrolls, inner and outer
        for (const scroller of document.querySelectorAll(".k2-scroll")) scroller.scrollTop = scroller.scrollHeight;
        const titles = [...document.querySelectorAll(".k2-tile-title")].map((title) => title.getBoundingClientRect().bottom);
        const bar = document.querySelector(".k2-status-actions")!.getBoundingClientRect();
        return { last: Math.max(...titles), bar: bar.top };
      });
      // the last names stand above the bar, with room to breathe
      expect(found.last).toBeLessThanOrEqual(found.bar - 8);
    },
    390,
  );
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
    // the deed of a setting stands at the end of its name's line, between the name and the value, and moves no value
    const deed = await page.evaluate(() => {
      const setting = document.querySelector("[data-k2-part='Setting'][data-action]")!;
      const button = setting.querySelector(".k2-field-action button")!;
      const box = button.getBoundingClientRect();
      const name = setting.querySelector(".k2-field-label")!.getBoundingClientRect();
      const control = setting.querySelector(".k2-input")!.getBoundingClientRect();
      return {
        name: button.textContent?.trim(),
        between: box.left >= name.right - 1 && box.right <= control.left,
        top: Math.abs(box.top - name.top) < 4,
      };
    });
    expect(deed).toEqual({ name: "Auf Standard zurücksetzen", between: true, top: true });
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

test("the states of an entry stand whole under its lines and wrap; rows without states keep their height", async () => {
  for (const width of [1440, 390])
    await withPage(
      "states",
      async (page) => {
        const found = await page.evaluate(() => {
          const rows = [...document.querySelectorAll<HTMLElement>(".k2-list > .k2-row")];
          const states = rows[1]!.querySelector(".k2-row-states")!;
          const title = rows[1]!.querySelector(".k2-row-title")!.getBoundingClientRect();
          const chips = [...states.querySelectorAll(".k2-chip")];
          const row = rows[1]!.getBoundingClientRect();
          return {
            heights: [Math.round(rows[0]!.getBoundingClientRect().height), Math.round(rows[3]!.getBoundingClientRect().height)],
            edge: Math.round(states.getBoundingClientRect().left - title.left),
            under: states.getBoundingClientRect().top >= title.bottom,
            whole: chips.every((chip) => chip.scrollWidth <= chip.clientWidth + 1 && chip.getBoundingClientRect().right <= row.right),
            lines: new Set(chips.map((chip) => Math.round(chip.getBoundingClientRect().top))).size,
            long: (() => {
              const chip = rows[2]!.querySelector(".k2-row-states .k2-chip")!;
              return (
                chip.getBoundingClientRect().right <= rows[2]!.getBoundingClientRect().right && chip.scrollWidth <= chip.clientWidth + 1
              );
            })(),
          };
        });
        // without states the rows keep their heights: 40 for one line, 52 for two (in a section no line between rows);
        // on the phone a row of one line takes its 60
        expect(found.heights).toEqual(width === 1440 ? [40, 52] : [60, 52]);
        expect(found.edge).toBe(0);
        expect(found.under).toBe(true);
        expect(found.whole).toBe(true);
        expect(found.long).toBe(true);
        // on the phone the six states take more lines than on the desktop, none is cut
        if (width === 390) expect(found.lines).toBeGreaterThan(1);
        const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
        expect(layout.problems).toEqual([]);
      },
      width,
    );
});

test("key numbers stand two by two on the phone, a third alone across; big numbers and long labels stay whole", async () => {
  for (const width of [390, 1440])
    await withPage(
      "cells",
      async (page) => {
        const found = await page.evaluate(() =>
          [...document.querySelectorAll(".k2-cells")].map((cells) => {
            const items = [...cells.querySelectorAll<HTMLElement>(":scope > .k2-cell")];
            const boxes = items.map((cell) => cell.getBoundingClientRect());
            return {
              rows: new Set(boxes.map((box) => Math.round(box.top))).size,
              widths: boxes.map((box) => Math.round(box.width)),
              // the values that are cut: none
              values: items
                .map((cell) => cell.querySelector<HTMLElement>(".k2-cell-value")!)
                .filter((value) => value.scrollWidth > value.clientWidth + 1)
                .map((value) => `${value.textContent} (${value.scrollWidth} in ${value.clientWidth})`),
            };
          }),
        );
        if (width === 390) {
          const [four, three] = found;
          expect(four!.rows).toBe(2);
          expect(new Set(four!.widths).size).toBe(1);
          expect(three!.rows).toBe(2);
          // the third takes the whole second row
          expect(three!.widths[2]).toBe(three!.widths[0]! + three!.widths[1]!);
        } else for (const cells of found) expect(cells.rows).toBe(1);
        for (const cells of found) expect(cells.values).toEqual([]);
        const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
        expect(layout.problems).toEqual([]);
      },
      width,
    );
});
for (const which of ["canvas", "split-canvas"] as const)
  test(`a drawing that is the whole pane has its final height from the first render, and keeps it (${which})`, async () => {
    for (const width of [1440, 390])
      await withPage(
        which,
        async (page) => {
          const found = await page.evaluate(() => {
            const canvas = document.querySelector(".k2-canvas[data-fill]")!.getBoundingClientRect();
            const scroll = document.querySelector(".k2-canvas[data-fill]")!.parentElement!.getBoundingClientRect();
            return {
              first: window.__k2FirstCanvas,
              now: canvas.height,
              bottom: Math.round(scroll.bottom - canvas.bottom),
              window: Math.round(innerHeight - canvas.bottom),
            };
          });
          expect(found.first).toBe(found.now);
          expect(found.now).toBeGreaterThan(240);
          // it reaches the bottom of its pane, and the pane the bottom of the window (inside the page's 8 px and the
          // workspace's 1 px edge): also in a split on the phone, where the panes stand one under the other
          expect(found.bottom).toBe(0);
          expect(found.window).toBeLessThanOrEqual(9);
        },
        width,
      );
  });

for (const width of [1440, 1024])
  test(`a path twelve levels deep folds its middle into "…" and keeps first and page in one line at ${width} px`, async () => {
    await withPage(
      "path",
      async (page) => {
        const path = page.locator(".k2-path");
        // the first place, the menu, the place before the page and the page: one line in the head
        expect(await path.locator(".k2-path-step, b").allTextContents()).toEqual([
          "Werkstatt",
          "Abnahme mit der Kundin am Werktisch",
          "Fotos der Musterfronten nach dem zweiten Ölen, Tageslicht",
        ]);
        const lines = await path
          .locator(".k2-path-step, b")
          .evaluateAll((steps) => steps.map((step) => [Math.round(step.getBoundingClientRect().top), step.getClientRects().length]));
        expect(new Set(lines.map(([top]) => top)).size).toBe(1);
        expect(lines.every(([, boxes]) => boxes === 1)).toBe(true);
        const start = await rect(page, "[data-slot='head'] > .k2-bar > .k2-bar-start");
        const end = await rect(page, "[data-slot='head'] > .k2-bar > .k2-bar-end");
        expect(start.right).toBeLessThanOrEqual(end.left);
        // the first place stays whole; the page keeps its whole name for those who hover or listen
        const first = await path
          .locator(".k2-path-step")
          .first()
          .evaluate((step) => step.scrollWidth <= step.clientWidth);
        expect(first).toBe(true);
        const current = path.locator("b[aria-current='page']");
        expect(await current.getAttribute("title")).toBe("Fotos der Musterfronten nach dem zweiten Ölen, Tageslicht");
        // the places between, in their order, as links in the menu
        await path.getByRole("button", { name: "Übergeordnete Ebenen" }).click();
        await settled(page);
        const entries = page.getByRole("menu").getByRole("menuitem");
        expect(await entries.allTextContents()).toEqual([
          "Projekte",
          "2026",
          "Kunden",
          "Lindqvist",
          "Küche",
          "Entwürfe",
          "Fronten",
          "Eiche geölt",
          "Muster",
        ]);
        expect(await entries.first().getAttribute("href")).toBe("#level-1");
        await page.keyboard.press("Escape");
        await settled(page);
        const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
        expect(layout.problems).toEqual([]);
      },
      width,
    );
  });

test("on the phone a deep path gives way to the shell's bar, and the head keeps only its search", async () => {
  await withPage(
    "path",
    async (page) => {
      expect(await page.locator(".k2-path").isVisible()).toBe(false);
      expect(await page.getByRole("searchbox", { name: "In diesem Ordner" }).isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
      expect(layout.problems).toEqual([]);
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
