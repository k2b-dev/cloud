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

type Case =
  | "list"
  | "closed"
  | "grid"
  | "selecting"
  | "settings"
  | "states"
  | "canvas"
  | "path"
  | "path-chip"
  | "split-canvas"
  | "split-list-canvas"
  | "selection"
  | "long"
  | "areas"
  | "empty-ways";

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
      // at the end of the bar, inside the window, and whole: the strip fades before it, not under it
      const box = (await button.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(
        await page.locator(".k2-fbar").evaluate((bar) => getComputedStyle(bar).webkitMaskImage || getComputedStyle(bar).maskImage),
      ).toBe("none");
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

test("at the length limit of the address the phone's 'Ansicht' locks a sort that would not fit, as the order's menu does", async () => {
  await withPage(
    "long",
    async (page) => {
      await page.locator(".k2-fbar-view").getByRole("button", { name: "Ansicht" }).click();
      await settled(page);
      const menu = page.getByRole("menu");
      expect(await menu.getByRole("menuitemradio", { name: "Geändert ↓" }).getAttribute("aria-disabled")).toBe("true");
      expect(await menu.getByRole("menuitemradio", { name: "Name ↑" }).getAttribute("aria-checked")).toBe("true");
    },
    390,
  );
});

test("menu entries in their data colour: a dot or the symbol, readable on the menu in light and dark, neutral without a colour", async () => {
  await withPage("areas", async (page) => {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((next) => document.body.setAttribute("data-theme", next), theme);
      await page.getByRole("button", { name: /Bereich/ }).click();
      await settled(page);
      const found = await page.evaluate(() => {
        const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const light = (channels: number[]) => {
          const [r, g, b] = channels.map((channel) => {
            const v = channel / 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          }) as [number, number, number];
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (a: number[], b: number[]) => {
          const [hi, lo] = [light(a), light(b)].sort((x, y) => y - x) as [number, number];
          return (hi + 0.05) / (lo + 0.05);
        };
        const menu = document.querySelector<HTMLElement>(".k2-menu")!;
        const surface = rgb(getComputedStyle(menu).backgroundColor);
        return [...menu.querySelectorAll<HTMLElement>(".k2-mi")].map((entry) => {
          const lead = entry.querySelector<HTMLElement>(".k2-mi-lead")!;
          const mark = lead.querySelector<HTMLElement>(".k2-mi-dot, .k2-icon");
          return {
            label: entry.querySelector(".k2-mi-label")!.textContent,
            mark: mark ? (mark.classList.contains("k2-mi-dot") ? "dot" : "icon") : "none",
            contrast: mark ? Math.round(ratio(rgb(getComputedStyle(mark).color), surface) * 10) / 10 : 0,
            style: lead.getAttribute("style") ?? "",
            colored: lead.hasAttribute("data-color"),
          };
        });
      });
      expect(found.map(({ label, mark }) => [label, mark])).toEqual([
        ["Werkstatt", "dot"],
        ["Kunden", "dot"],
        ["Einkauf", "icon"],
        ["Archiv", "dot"],
        ["Ohne Farbe", "none"],
      ]);
      // a hex colour keeps 3:1 on the menu, also the pale one
      for (const entry of found.slice(0, 3))
        expect({ theme, entry: entry.label, ok: entry.contrast >= 3 }).toEqual({ theme, entry: entry.label, ok: true });
      // a value that is no colour reaches no style and stays neutral: no dot, no colour
      expect(found[4]!.style).not.toContain("position");
      expect(found[4]!.style).not.toContain("#008f4c");
      expect(found[4]!.colored).toBe(false);
      await page.keyboard.press("Escape");
      await settled(page);
    }
  });
});

test("on the desktop the display is a menu of its own beside the order, and the phone's menu stays away", async () => {
  await withPage("list", async (page) => {
    expect(await page.locator(".k2-fbar-view").isVisible()).toBe(false);
    expect(await page.locator(".k2-fbar-display").getByRole("button", { name: /Liste/ }).isVisible()).toBe(true);
    // choosing the grid shows the grid
    await page.locator(".k2-fbar-display").getByRole("button", { name: /Liste/ }).click();
    await settled(page);
    await page.getByRole("menu").getByRole("menuitemradio", { name: "Raster" }).click();
    await settled(page);
    expect(await page.locator(".k2-tiles").count()).toBe(1);
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

test("a selection with six deeds shows three and 'Mehr' with the rest in their order, its count in 14 px 600, and nothing leaves its bar (Files v3)", async () => {
  for (const width of [1440, 1024, 390])
    await withPage(
      "selection",
      async (page) => {
        const found = await page.evaluate(() => {
          const bar = document.querySelector(".k2-bar[data-selecting]")!;
          const box = bar.getBoundingClientRect();
          const lead = getComputedStyle(bar.querySelector(".k2-status-lead")!);
          const deeds = [...bar.querySelectorAll<HTMLElement>(".k2-status-actions > .k2-btn")].map((button) => ({
            name: button.getAttribute("aria-label") ?? button.textContent?.trim(),
            rect: button.getBoundingClientRect(),
          }));
          const floating = getComputedStyle(bar.querySelector(".k2-status-actions")!).position === "fixed";
          return {
            count: [lead.fontSize, lead.fontWeight],
            deeds: deeds.map((deed) => deed.name),
            // in the bar's line, every deed inside the bar (on the phone they float at the bottom of the window)
            inside: deeds.every((deed) => deed.rect.right <= (floating ? innerWidth : box.right) + 0.5 && deed.rect.left >= 0),
          };
        });
        expect(found.count).toEqual(["14px", "600"]);
        // on the phone the panes of the split stand one under the other: no room between them, the room for the
        // floating deeds after the last (review r7)
        if (width === 390)
          expect(
            await page.evaluate(() => [
              ...[...document.querySelectorAll(".k2-split > .k2-pane > .k2-scroll")].map((scroll) => getComputedStyle(scroll).marginBottom),
              getComputedStyle(document.querySelector(".k2-split")!).marginBottom,
            ]),
          ).toEqual(["0px", "0px", "80px"]);
        expect(found.deeds.slice(0, 3)).toEqual(["Teilen", "Verschieben", "Als ZIP laden"]);
        expect(found.deeds.length).toBe(4);
        expect(found.deeds[3]).toBe("Mehr");
        // where the bar shows symbols alone, "Mehr" names itself on hover as the deeds beside it do (review r8)
        expect(await page.locator(".k2-status-actions > .k2-btn[data-menu]").getAttribute("title")).toBe("Mehr");
        expect(found.inside).toBe(true);
        // "Mehr" holds the rest in their order
        await page.locator(".k2-status-actions > .k2-btn[data-menu]").click();
        await settled(page);
        expect(await page.getByRole("menu").getByRole("menuitem").allTextContents()).toEqual([
          "Löschen",
          "In Ordner kopieren",
          "PDFs zusammenführen",
        ]);
        await page.keyboard.press("Escape");
        await settled(page);
        const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
        expect(layout.problems).toEqual([]);
      },
      width,
    );
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

test("a media tile's name that does not fit ends in '…' and keeps its whole name for those who hover (DR #4229)", async () => {
  for (const width of [390, 1440])
    await withPage(
      "grid",
      async (page) => {
        const titles = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>(".k2-tiles[data-variant='media'] .k2-tile-title")].map((title) => {
            // the element that holds the words is the one that cuts them, so the "…" stands on the words themselves
            const words = title.querySelector<HTMLElement>(":scope > .k2-row-open") ?? title;
            return {
              name: title.textContent ?? "",
              cut: words.scrollWidth > words.clientWidth + 1,
              ellipsis: getComputedStyle(words).textOverflow,
              hover: title.getAttribute("title"),
            };
          }),
        );
        // the recipe's long names do not fit a tile of the phone or of the desktop
        expect(titles.some((title) => title.cut)).toBe(true);
        for (const title of titles.filter((each) => each.cut))
          expect({ name: title.name, ellipsis: title.ellipsis }).toEqual({ name: title.name, ellipsis: "ellipsis" });
        for (const title of titles) expect(title.hover).toBe(title.name);
      },
      width,
    );
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
    // a table whose rows lead with a mark: rows of 44 px, marks of 32, as the mockup's list of files
    expect(cell.mark).toBe(32);
    expect(cell.name).toBe("Aufmaß");
    expect(
      await page
        .locator(".k2-table[data-marks] tbody tr:not([data-group]) td")
        .first()
        .evaluate((td) => Math.round(td.getBoundingClientRect().height)),
    ).toBe(44);
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
  // at 800 px of window the settings pane is narrow beside the sidebar and the side column, while the window is no phone;
  // at 1240 and 1300 the pane is about 630 and 690 px: room for name and value, but not for a deed beside them too
  // one page, its window set to each width in turn: the layout follows the pane's width alone
  await withPage(
    "settings",
    async (page) => {
      for (const width of [800, 1024, 1240, 1300, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await settled(page);
        const crossed = await page.evaluate(() =>
          [...document.querySelectorAll("[data-k2-part='Setting']")]
            .map((setting) => {
              const label = setting.querySelector<HTMLElement>(".k2-field-label")!;
              const control = setting
                .querySelector(":scope > :not(.k2-field-label, .k2-field-message, .k2-field-was, .k2-field-action)")!
                .getBoundingClientRect();
              const box = label.getBoundingClientRect();
              const beside = control.left > box.left;
              // beside its value a name keeps the room of a short name in one line ("Angemeldet bleiben")
              const cramped = beside && (box.width < 160 || box.height > 20);
              return {
                name: label.textContent,
                bad: cramped || label.scrollWidth > label.clientWidth + 1 || (beside && box.right > control.left),
              };
            })
            .filter((setting) => setting.bad)
            .map((setting) => setting.name),
        );
        expect({ width, crossed }).toEqual({ width, crossed: [] });
      }
    },
    800,
  );
});

test("on the phone the floating actions of a selection cover nothing of the list, at rest and at its end (review #4223, DR #4229)", async () => {
  await withPage(
    "selecting",
    async (page) => {
      // a tall phone and a short one (a picture in the host's frame, whose bar takes 52 px of it)
      for (const height of [900, 700]) {
        await page.setViewportSize({ width: 390, height });
        await settled(page);
        for (const at of ["rest", "end"] as const) {
          const found = await page.evaluate((end) => {
            const scrollers = [...document.querySelectorAll<HTMLElement>(".k2-scroll")].filter(
              (scroller) => getComputedStyle(scroller).overflowY !== "visible",
            );
            for (const scroller of scrollers) scroller.scrollTop = end ? scroller.scrollHeight : 0;
            const bar = document.querySelector(".k2-status-actions")!.getBoundingClientRect();
            // what each column shows: its box, cut by every column around it that scrolls
            const shown = scrollers.map((scroller) =>
              Math.min(...scrollers.filter((other) => other.contains(scroller)).map((other) => other.getBoundingClientRect().bottom)),
            );
            const titles = [...document.querySelectorAll(".k2-tile-title")].map((title) => title.getBoundingClientRect().bottom);
            return { bar: bar.top, shown: Math.max(...shown), last: Math.max(...titles) };
          }, at === "end");
          // what a column shows ends above the bar, with room to breathe, so no mark or name lies under it
          expect({ height, at, under: found.shown > found.bar - 8 }).toEqual({ height, at, under: false });
          if (at === "end") expect(found.last).toBeLessThanOrEqual(found.bar - 8);
        }
      }
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
        // without states the rows keep their heights: 44 for one line that leads with a mark, 52 for two (in a section
        // no line between rows); on the phone a row of one line takes its 60
        expect(found.heights).toEqual(width === 1440 ? [44, 52] : [60, 52]);
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

test("on the phone a long list beside a drawing in a split does not squeeze the drawing below its 240 px (review r3)", async () => {
  await withPage(
    "split-list-canvas",
    async (page) => {
      const found = await page.evaluate(() => {
        const element = document.querySelector(".k2-canvas[data-fill]")!;
        const canvas = element.getBoundingClientRect();
        // what its pane shows of it, wherever the page is scrolled: cut by every box up to its pane that clips
        const pane = element.closest(".k2-pane")!;
        let bottom = canvas.bottom;
        for (let box: Element | null = element.parentElement; box && pane.contains(box); box = box.parentElement)
          if (getComputedStyle(box).overflowY !== "visible") bottom = Math.min(bottom, box.getBoundingClientRect().bottom);
        const rows = document.querySelectorAll(".k2-pane[aria-label='Seiten'] .k2-row").length;
        return { height: Math.round(bottom - canvas.top), rows };
      });
      expect(found.rows).toBe(40);
      expect(found.height).toBeGreaterThanOrEqual(240);
    },
    390,
  );
});

for (const width of [1440, 1024])
  test(`a path twelve levels deep folds its middle into "…" and keeps first and page in one line at ${width} px`, async () => {
    await withPage(
      "path",
      async (page) => {
        const path = page.locator(".k2-path[aria-label='Ort']");
        // the first place, the menu and the page: one line in the head
        expect(await path.locator(".k2-path-step, b").allTextContents()).toEqual([
          "Werkstatt",
          "Fotos der Musterfronten nach dem zweiten Ölen, Tageslicht",
        ]);
        const lines = await path
          .locator(".k2-path-step, b")
          .evaluateAll((steps) => steps.map((step) => [Math.round(step.getBoundingClientRect().top), step.getClientRects().length]));
        expect(new Set(lines.map(([top]) => top)).size).toBe(1);
        expect(lines.every(([, boxes]) => boxes === 1)).toBe(true);
        const start = await rect(page, "[data-slot='head'] > .k2-bar > .k2-bar-start:has(> .k2-path[aria-label='Ort'])");
        const end = await rect(page, "[data-slot='head'] > .k2-bar > .k2-bar-end");
        expect(start.right).toBeLessThanOrEqual(end.left);
        // the page keeps its whole name while anything else can give way: here (a name of 470 px) the first place has
        // shortened to its 48 px before the page shortens at all (Files v3: never "Entw…" beside a whole first place)
        const [opening, here] = await path
          .locator(".k2-path-step, b")
          .evaluateAll((steps) =>
            steps.map((step) => ({ cut: step.scrollWidth > step.clientWidth + 1, width: Math.round(step.getBoundingClientRect().width) })),
          );
        if (here!.cut) expect(opening!.width).toBe(48);
        if (width === 1440) expect(here!.cut).toBe(false);
        const current = path.locator("b[aria-current='page']");
        expect(await current.getAttribute("title")).toBe("Fotos der Musterfronten nach dem zweiten Ölen, Tageslicht");
        // the places between, in their order, as links in the menu; it opens from the keys, and Escape gives the focus
        // back to its button
        const fold = path.getByRole("button", { name: "Übergeordnete Ebenen" });
        await fold.focus();
        await page.keyboard.press("Enter");
        await settled(page);
        await page.keyboard.press("ArrowDown");
        expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("menuitem");
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
          "Abnahme mit der Kundin am Werktisch",
        ]);
        expect(await entries.first().getAttribute("href")).toBe("#level-1");
        await page.keyboard.press("Escape");
        await settled(page);
        expect(await fold.evaluate((button) => button === document.activeElement)).toBe(true);
        // a short path: names narrower than 48 px keep their own width
        const short = await page
          .locator(".k2-path[aria-label='Quartal']")
          .locator(".k2-path-step[data-near], b")
          .evaluateAll((steps) =>
            steps.map((step) => {
              const text = document.createRange();
              text.selectNodeContents(step);
              return { name: step.textContent, wider: step.getBoundingClientRect().width > text.getBoundingClientRect().width + 1 };
            }),
          );
        expect(short).toEqual([
          { name: "2026", wider: false },
          { name: "Q1", wider: false },
        ]);
        const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
        expect(layout.problems).toEqual([]);
      },
      width,
    );
  });

test("a deep path with a chip after it gives way before the deeds; the chip is read whole (W1b #4206)", async () => {
  await withPage(
    "path-chip",
    async (page) => {
      const found = await page.evaluate(() => {
        const chip = document.querySelector<HTMLElement>("[data-slot='head'] .k2-inline > .k2-chip")!;
        const start = document.querySelector("[data-slot='head'] > .k2-bar > .k2-bar-start")!.getBoundingClientRect();
        const end = document.querySelector("[data-slot='head'] > .k2-bar > .k2-bar-end")!.getBoundingClientRect();
        const current = document.querySelector<HTMLElement>("[data-slot='head'] .k2-path > b")!;
        return {
          chip: chip.scrollWidth <= chip.clientWidth + 1,
          apart: start.right <= end.left,
          page: current.scrollWidth <= current.clientWidth + 1,
          // nothing up to the bar clips the 3 px focus ring of the first link or of the menu "…": every ancestor that
          // clips holds the ring whole (review r8)
          clipped: ["[data-slot='head'] .k2-path > a:first-child", "[data-slot='head'] .k2-path > .k2-btn"].flatMap((selector) => {
            const element = document.querySelector<HTMLElement>(selector)!;
            const ring = element.getBoundingClientRect();
            const cut: string[] = [];
            for (let box = element.parentElement; box && !box.matches("[data-slot='head']"); box = box.parentElement) {
              const style = getComputedStyle(box);
              if (style.overflowX === "visible" && style.overflowY === "visible") continue;
              const room = box.getBoundingClientRect();
              if (
                ring.left - 3 < room.left - 0.5 ||
                ring.right + 3 > room.right + 0.5 ||
                ring.top - 3 < room.top - 0.5 ||
                ring.bottom + 3 > room.bottom + 0.5
              )
                cut.push(`${selector} in ${box.className}`);
            }
            return cut;
          }),
        };
      });
      // a folder of everyday names ("Entwürfe") keeps its whole name beside its chip
      expect(found).toEqual({ chip: true, apart: true, page: true, clipped: [] });
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
      expect(layout.problems).toEqual([]);
    },
    1024,
  );
  // on the phone the path gives way to the shell's bar, also beside a chip; the chip stays (Files v3: never "Ent")
  await withPage(
    "path-chip",
    async (page) => {
      expect(await page.locator("[data-slot='head'] .k2-inline > .k2-path").isVisible()).toBe(false);
      expect(await page.locator("[data-slot='head'] .k2-inline > .k2-chip").isVisible()).toBe(true);
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
      expect(layout.problems).toEqual([]);
    },
    390,
  );
});

test("on the phone a deep path gives way to the shell's bar, and the head keeps only its search", async () => {
  await withPage(
    "path",
    async (page) => {
      expect(await page.locator(".k2-path[aria-label='Ort']").isVisible()).toBe(false);
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

test("an empty state with two ways out: the first a button, the second quiet text after it; the focus from „Erneut versuchen“ goes to the first", async () => {
  for (const width of [1440, 1024, 390])
    await withPage(
      "empty-ways",
      async (page) => {
        await page.getByRole("button", { name: "Erneut versuchen" }).focus();
        await page.keyboard.press("Enter");
        await page.locator('[data-k2-part="Empty"]').waitFor();
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Filter zurücksetzen");
        const found = await page.evaluate(() => {
          const state = document.querySelector('[data-k2-part="Empty"]')!;
          const first = state.querySelector<HTMLElement>(".k2-state-ways > .k2-btn:nth-child(1)")!;
          const second = state.querySelector<HTMLElement>(".k2-state-ways > .k2-btn:nth-child(2)")!;
          const text = state.querySelector(".k2-state-text")!.getBoundingClientRect();
          const a = first.getBoundingClientRect();
          const b = second.getBoundingClientRect();
          return {
            variants: [first.dataset.variant, second.dataset.variant],
            link: second.tagName === "A" ? second.getAttribute("href") : null,
            heights: [a.height, b.height],
            // both start on the text edge or stand beside each other in its line, never beyond the window
            edge: Math.round(a.left - text.left),
            beside: Math.abs(a.top - b.top) < 1 && b.left > a.right,
            inside: b.right <= innerWidth + 0.5,
          };
        });
        expect(found.variants).toEqual([undefined, "text"]);
        expect(found.link).toBe("#notizbuch");
        expect(found.heights[0]).toBe(found.heights[1]);
        expect(found.edge).toBe(0);
        expect(found.beside).toBe(true);
        expect(found.inside).toBe(true);
        // Tab goes on to the quiet way
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Ganzes Notizbuch zeigen");
      },
      width,
    );
});
