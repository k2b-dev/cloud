import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-head-media.client";
import { describeV2Page, measureV2Layout } from "./testing";

// The second part of the design pass (26.11.), in the browser on the recipes that use it: a page head of two rows
// (path and deeds, then the filter bar with count, order and display), a selection that takes the bar's place at the
// same height and floats its actions at the bottom on the phone, media tiles that people select, the large preview of
// the open file, a storage quota in the sidebar, marks in table cells, and settings with their value beside them.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const dist = resolve(import.meta.dir, "../../dist");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }";

type Case =
  | "list"
  | "closed"
  | "grid"
  | "selecting"
  | "settings"
  | "setting-change"
  | "states"
  | "canvas"
  | "cells"
  | "cells-narrow"
  | "path"
  | "path-chip"
  | "split-canvas"
  | "split-tall-canvas"
  | "invitation"
  | "selection"
  | "selection-four"
  | "long"
  | "areas"
  | "structure"
  | "prose"
  | "groups"
  | "split-list-canvas"
  | "empty-ways"
  | "view-statement";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-head-media.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

// `plex`: the page draws in IBM Plex from the built package, as a person sees it, for a test that measures whether a text
// fits (the browser's own font is wider)
const withPage = async (which: Case, run: (page: Page) => Promise<void>, width = 1440, touch = false, plex = false) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  const fonts = plex ? '<link rel="stylesheet" href="/_ui/plex.css">' : "";
  // a real address, so a sort or filter chosen in the bar can write it
  await page.route("http://head-media.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/_ui/")) {
      const file = resolve(dist, `.${path.slice("/_ui".length)}`);
      return file.startsWith(`${dist}/`) ? route.fulfill({ path: file }) : route.fulfill({ status: 404 });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="de"><head><meta charset="utf-8">${fonts}<style>${css}</style><style>${testCss}</style><script>window.__k2Case = ${JSON.stringify(which)};</script></head><body class="k2-ui"><div id="root"></div></body></html>`,
    });
  });
  try {
    await page.goto("http://head-media.test/dateien");
    if (plex)
      await page.evaluate(async () => {
        await Promise.all([400, 500, 600].map((weight) => document.fonts.load(`${weight} 13px "IBM Plex Sans"`)));
        await document.fonts.ready;
      });
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
    // the folders with the place to make one, then the files
    expect(await page.locator(".k2-tiles").count()).toBe(2);
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

// a filter bar that ends in count, order and display in a column of 550 px or less while the window is wide (beside a
// sidebar and a side column): the end goes to a line of its own instead of pressing the statements or lying over them
for (const width of [550, 450, 400])
  test(`on a desktop a filter bar of ${width} px keeps its count, order and display apart from the statements`, async () => {
    await withPage("list", async (page) => {
      await page.evaluate((root) => {
        document.getElementById("root")!.style.width = `${root}px`;
      }, width);
      await settled(page);
      const parts = await page.locator(".k2-fbar").evaluate((element) => {
        const box = (node: Element) => {
          const r = node.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        };
        const tail = element.querySelector(".k2-fbar-tail")!;
        return {
          bar: box(element),
          flow: box(element.querySelector(".k2-fbar-flow")!),
          items: [...element.querySelectorAll(".k2-fbar-flow > *, .k2-fbar-flow .k2-btn")].map(box),
          tail: [...tail.querySelectorAll(".k2-fbar-results, .k2-btn")].map(box),
        };
      });
      const apart = (a: (typeof parts)["bar"], b: (typeof parts)["bar"]) =>
        a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
      for (const item of parts.items) {
        // each statement and button stands inside the statements' room, and nothing of the end lies over it
        expect(item.right).toBeLessThanOrEqual(parts.flow.right + 0.5);
        for (const end of parts.tail) expect(apart(item, end)).toBe(true);
      }
      for (const end of parts.tail) {
        expect(end.left).toBeGreaterThanOrEqual(parts.bar.left - 0.5);
        expect(end.right).toBeLessThanOrEqual(parts.bar.right + 0.5);
      }
      // the statements keep the room of one statement (240 px) instead of what the end leaves them
      expect(parts.flow.right - parts.flow.left).toBeGreaterThanOrEqual(240);
    });
  });

// who shares a file: a team (a mark) and a person in one section start their names on one edge (W1b #4206 r5)
for (const width of [1440, 390])
  test(`at ${width} px a team and a person in the sharing of a file start their names on one edge`, async () => {
    await withPage(
      "list",
      async (page) => {
        const edges = await page
          .locator(".k2-sec", { hasText: "Freigabe" })
          .locator(":scope > .k2-row .k2-row-title")
          .evaluateAll((titles) => titles.map((title) => Math.round(title.getBoundingClientRect().left)));
        expect(edges.length).toBe(2);
        expect(new Set(edges).size).toBe(1);
      },
      width,
    );
  });

// one line between groups: the last row of a group and the head of the next never draw two lines at one edge, in the
// table and in its phone rows (Valentin 26.11., NO DOUBLE LINES)
for (const width of [1440, 1024, 390])
  test(`a grouped list draws one line between its groups at ${width} px`, async () => {
    await withPage(
      "list",
      async (page) => {
        if (width < 768) {
          await page.evaluate(() => document.querySelector(".k2-pane[data-detail]")?.remove());
          await settled(page);
        }
        const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
        expect(layout.double).toEqual([]);
      },
      width,
    );
  });

// while the window is dragged narrower, no drawn frame shows a cut word: the bar folds its deeds before the frame is
// drawn, not one deed per frame (review r13)
test("a selection folds its deeds before the next frame is drawn, so no frame shows a cut word", async () => {
  await withPage("selection-four", async (page) => {
    const frames = await page.evaluate(async () => {
      const root = document.getElementById("root")!;
      const drawn = () => new Promise<void>((done) => requestAnimationFrame(() => setTimeout(done, 0)));
      // what a person sees after a frame: words of the bar wider than their place
      const cut = () =>
        [...document.querySelectorAll<HTMLElement>(".k2-bar[data-selecting] :is(.k2-status-lead, .k2-btn-label)")]
          .filter((words) => words.getClientRects().length > 0 && getComputedStyle(words).clipPath === "none")
          .filter((words) => words.scrollWidth > words.clientWidth + 1)
          .map((words) => words.textContent);
      root.style.width = "1100px";
      await drawn();
      await drawn();
      const seen: string[][] = [];
      for (const width of [900, 760, 640]) {
        root.style.width = `${width}px`;
        for (let frame = 0; frame < 4; frame++) {
          await drawn();
          seen.push(cut().filter((words): words is string => words !== null));
        }
      }
      return seen;
    });
    expect(frames.flat()).toEqual([]);
  });
});

// four deeds with long words and the size of the selection in a column that cannot hold them all: the last deeds go
// into "Mehr" before any word is cut, and each deed stays reachable once (W1b #4206 r5: "In d…" at 1440)
for (const column of [900, 760, 640])
  test(`a selection in a column of ${column} px folds its deeds into "Mehr" before a word is cut`, async () => {
    await withPage("selection-four", async (page) => {
      await page.evaluate((width) => {
        document.getElementById("root")!.style.width = `${width}px`;
      }, column);
      await settled(page);
      await page.waitForTimeout(50);
      const bar = await page.locator(".k2-bar[data-selecting]").evaluate((element) => {
        const edge = element.getBoundingClientRect();
        const parts = [...element.querySelectorAll<HTMLElement>(".k2-bar-start > *, .k2-status-actions > *")].filter(
          (part) => part.getClientRects().length > 0 && !part.matches(".k2-status-actions"),
        );
        return {
          // nothing runs out of the bar, and no word in it is cut
          inside: parts.every((part) => part.getBoundingClientRect().right <= edge.right + 0.5),
          cut: parts
            .flatMap((part) => [part, ...part.querySelectorAll<HTMLElement>(".k2-btn-label")])
            .filter((part) => part.scrollWidth > part.clientWidth + 1 && getComputedStyle(part).clipPath === "none")
            .map((part) => part.textContent),
          shown: [...element.querySelectorAll(".k2-status-actions > .k2-btn:not([data-menu])")].map(
            (button) => button.getAttribute("title") ?? button.textContent?.trim(),
          ),
        };
      });
      expect(bar.inside).toBe(true);
      expect(bar.cut).toEqual([]);
      const all = ["Teilen", "Herunterladen", "In den Ordner verschieben", "In den Papierkorb"];
      expect(all.slice(0, bar.shown.length)).toEqual(bar.shown);
      if (bar.shown.length < all.length) {
        await page.locator(".k2-status-actions .k2-btn[data-menu]").click();
        await settled(page);
        expect(await page.getByRole("menu").getByRole("menuitem").allTextContents()).toEqual(all.slice(bar.shown.length));
      }
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

for (const width of [390, 1440])
  test(`a media tile's name that does not fit ends in '…' and keeps its whole name for those who hover (DR #4229, ${width})`, async () => {
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
    // the first file (the folders and the place to make one stand before the files)
    const tile = page.locator(".k2-tiles[data-variant='media'][aria-label='Dateien'] > .k2-tile").first();
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
    // and says what is selected, quiet after the count
    expect(await page.locator(".k2-bar[data-selecting] .k2-status-meta").textContent()).toBe("4,2 MB · 1 Bild");
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
      expect(await page.locator(".k2-tile-title a").first().getAttribute("href")).toBe("#aufmass");
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

// rows of two lines in a narrow list pane (1024) and on the phone (390, where a row with a mark is 56 with a mark of 40)
for (const [width, size] of [
  [1024, "32x32"],
  [390, "40x40"],
] as const)
  test(`in rows of two lines a file keeps its thumbnail beside its box at ${width} px`, async () => {
    await withPage(
      "list",
      async (page) => {
        // on the phone the open file stands over the list: back to the list, as its way back does
        if (width === 390) {
          await page.evaluate(() => document.querySelector(".k2-pane[data-detail]")?.remove());
          await settled(page);
        }
        const lead = await page.locator(".k2-table-phone .k2-row", { hasText: "Ansicht Front Eiche.jpg" }).evaluate((row) => {
          const element = row.querySelector(":scope > .k2-row-lead")!;
          const box = element.querySelector(".k2-mark")!.getBoundingClientRect();
          const mark = element.querySelector(".k2-mk")!.getBoundingClientRect();
          const text = row.querySelector(".k2-row-title")!.getBoundingClientRect();
          const edge = row.getBoundingClientRect();
          return {
            side: mark.left > box.right,
            mark: `${mark.width}x${mark.height}`,
            middle: Math.abs(box.top + box.height / 2 - (mark.top + mark.height / 2)) < 1,
            // box, mark and name stand in this order inside the row
            order: box.left >= edge.left && text.left >= mark.right && text.right <= edge.right + 0.5,
          };
        });
        expect(lead).toEqual({ side: true, mark: size, middle: true, order: true });
      },
      width,
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

test("a setting keeps 240 px for its name beside its value, goes to one column below a pane of 640 px, and a short value stays beside its name on the phone (review A)", async () => {
  // one page, its window set to each width in turn: the layout follows the pane's width alone. At 800 px of window the
  // settings pane is narrow beside the sidebar and the side column; at 1240 and 1300 it is about 630 and 690 px.
  await withPage(
    "settings",
    async (page) => {
      for (const width of [390, 800, 1024, 1240, 1300, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await settled(page);
        const found = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>("[data-k2-part='Setting']")].map((setting) => {
            const label = setting.querySelector<HTMLElement>(".k2-field-label")!;
            const control = setting
              .querySelector(":scope > :not(.k2-field-label, .k2-field-message, .k2-field-end)")!
              .getBoundingClientRect();
            const box = label.getBoundingClientRect();
            const beside = control.left > box.right - 1 && control.top < box.bottom;
            const short = setting.hasAttribute("data-compact") || !!setting.querySelector(":scope > .k2-choice");
            return {
              name: label.textContent ?? "",
              short,
              beside,
              // beside a wide value a name keeps 240 px; beside a short one it keeps one line
              cramped: beside && ((!short && box.width < 240) || box.height > 20),
              crossed: label.scrollWidth > label.clientWidth + 1 || (beside && box.right > control.left),
            };
          }),
        );
        expect({ width, bad: found.filter((setting) => setting.cramped || setting.crossed).map((setting) => setting.name) }).toEqual({
          width,
          bad: [],
        });
        // on the phone a short value (a switch, a number with its unit) stays beside its name; a wide one goes under it
        if (width === 390) {
          expect(found.filter((setting) => setting.short && !setting.beside).map((setting) => setting.name)).toEqual([]);
          expect(found.filter((setting) => !setting.short && setting.beside).map((setting) => setting.name)).toEqual([]);
          expect(found.filter((setting) => setting.short).length).toBeGreaterThanOrEqual(3);
        }
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

test("on the phone the column of settings that scrolls ends above the floating main action; the panes of its split keep no room of their own (review r6)", async () => {
  await withPage(
    "settings",
    async (page) => {
      const found = await page.evaluate(() => {
        const fab = document.querySelector(".k2-fab")!.getBoundingClientRect();
        const scrolls = [...document.querySelectorAll<HTMLElement>(".k2-pane > .k2-scroll")].map((scroll) => ({
          inner: !!scroll.parentElement!.closest(".k2-split"),
          margin: getComputedStyle(scroll).marginBottom,
          bottom: scroll.getBoundingClientRect().bottom,
        }));
        const outer = scrolls.find((scroll) => !scroll.inner)!;
        const panes = [...document.querySelectorAll(".k2-split > .k2-pane")].map((pane) => pane.getBoundingClientRect());
        return {
          outer: outer.margin,
          above: outer.bottom <= fab.top,
          inner: scrolls.filter((scroll) => scroll.inner).map((scroll) => scroll.margin),
          // the panes of the split follow each other without a gap (only the seam's line between them)
          gap: Math.round(panes[1]!.top - panes[0]!.bottom),
        };
      });
      expect(found).toEqual({ outer: "72px", above: true, inner: ["0px", "0px"], gap: 1 });
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
        under: was ? was.getBoundingClientRect().top >= control.bottom - 0.5 : false,
      };
    });
    expect(found).toEqual({ beside: true, width: 300, was: "geändert · vorher 12 Std.", under: true });
    // the controls of all settings stand in one line down the page
    const lefts = await page
      .locator("[data-k2-part='Setting'] > :is(.k2-input, .k2-check)")
      .evaluateAll((elements) => [...new Set(elements.map((element) => Math.round(element.getBoundingClientRect().left)))]);
    expect(lefts.length).toBe(1);
    // the deed of a setting stands after its value on the value's line, and moves no value (CLEAR AND DENSE f)
    const deed = await page.evaluate(() => {
      const setting = document.querySelector("[data-k2-part='Setting'][data-action]")!;
      const button = setting.querySelector(".k2-field-action button")!;
      const box = button.getBoundingClientRect();
      const control = setting.querySelector(".k2-input")!.getBoundingClientRect();
      return {
        name: button.textContent?.trim(),
        after: box.left >= control.right,
        line: Math.abs(box.top + box.height / 2 - (control.top + control.height / 2)) < 2,
      };
    });
    expect(deed).toEqual({ name: "Auf Standard zurücksetzen", after: true, line: true });
    // the keys follow the eye: the value first, then the deed after it (WCAG 2.4.3)
    await page.locator("[data-k2-part='Setting'][data-action] .k2-field-action button").focus();
    await page.keyboard.press("Shift+Tab");
    const inValue = () =>
      page.evaluate(() => {
        const setting = document.querySelector("[data-k2-part='Setting'][data-action]")!;
        return !!document.activeElement && setting.contains(document.activeElement) && !document.activeElement.closest(".k2-field-action");
      });
    expect(await inValue()).toBe(true);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Auf Standard zurücksetzen");
  });
  await withPage(
    "settings",
    async (page) => {
      // on the phone a wide value (an address) goes under its name; a short one (hours) stays beside it
      const under = (name: string) =>
        page
          .locator("[data-k2-part='Setting']", { hasText: name })
          .first()
          .evaluate(
            (element) =>
              element.querySelector(".k2-input")!.getBoundingClientRect().top >=
              element.querySelector(".k2-field-label")!.getBoundingClientRect().bottom,
          );
      expect({ address: await under("Adresse"), hours: await under("Angemeldet bleiben") }).toEqual({ address: true, hours: false });
    },
    390,
  );
});

// What a setting shows while changed ("geändert · vorher …" and its deed) has its place kept: it coming moves no name,
// no value and no setting after it, at every layout (review r10/r11: the deed came above the value below a pane of
// 800 px, "geändert" moved the value by 26 px and added a row, and at 320 px it lay under the deed).
const settingBoxes = (page: Page) =>
  page.evaluate(() => {
    const round = (box: DOMRect) => [box.left, box.top, box.width, box.height].map((value) => Math.round(value * 2) / 2).join(",");
    const settings = [...document.querySelectorAll<HTMLElement>("[data-k2-part='Setting']")];
    return {
      settings: settings.map((setting) => ({
        setting: round(setting.getBoundingClientRect()),
        label: round(setting.querySelector(":scope > .k2-field-label")!.getBoundingClientRect()),
        control: round(setting.querySelector(":scope > :not(.k2-field-label, .k2-field-message, .k2-field-end)")!.getBoundingClientRect()),
        message: setting.querySelector(":scope > .k2-field-message")
          ? round(setting.querySelector(":scope > .k2-field-message")!.getBoundingClientRect())
          : "",
      })),
      after: round(document.querySelectorAll(".k2-sec")[1]!.getBoundingClientRect()),
    };
  });

const changedPlaces = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-k2-part='Setting']:has(.k2-field-end)")].map((setting) => {
      const box = (element: Element | null) => element?.getBoundingClientRect();
      const own = setting.getBoundingClientRect();
      const label = box(setting.querySelector(":scope > .k2-field-label"))!;
      const control = box(setting.querySelector(":scope > :not(.k2-field-label, .k2-field-message, .k2-field-end)"))!;
      const message = box(setting.querySelector(":scope > .k2-field-message"));
      const chip = box(setting.querySelector(".k2-field-was > .k2-chip"))!;
      const deed = box(setting.querySelector(".k2-field-action button"))!;
      const apart = (a: DOMRect, b: DOMRect) =>
        a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
      const inside = (a: DOMRect) =>
        a.left >= own.left - 0.5 && a.right <= own.right + 0.5 && a.top >= own.top - 0.5 && a.bottom <= own.bottom + 0.5;
      const others = [label, control, ...(message ? [message] : [])];
      return {
        name: setting.querySelector(".k2-field-label")!.textContent,
        // the deed comes after the value as the eye reads: on the value's line after it, or under it
        after:
          deed.top >= control.bottom - 0.5 ||
          (Math.abs(deed.top + deed.height / 2 - (control.top + control.height / 2)) < 2 && deed.left >= control.right),
        inside: inside(chip) && inside(deed),
        // what it was can be read whole (a long value may end in "…"); on a very narrow line the word "geändert" gives
        // way to it
        whole: (() => {
          const shown = setting.querySelector<HTMLElement>(".k2-field-was .k2-chip-text")!;
          return shown.scrollWidth <= shown.clientWidth + 1;
        })(),
        word: setting.querySelector(".k2-field-was-word")!.getBoundingClientRect().width > 1,
        apart: apart(chip, deed) && others.every((other) => apart(chip, other) && apart(deed, other)),
      };
    }),
  );

for (const width of [1440, 700, 390, 320])
  test(`a setting's change moves nothing, and "geändert" and its deed stand apart after the value at ${width} px`, async () => {
    await withPage(
      "setting-change",
      async (page) => {
        const before = await settingBoxes(page);
        await page.evaluate(() => window.__k2SettingChange?.(true));
        await settled(page);
        expect(await settingBoxes(page)).toEqual(before);
        const places = await changedPlaces(page);
        expect(places.length).toBe(4);
        expect(places.filter((place) => !place.after || !place.inside || !place.apart)).toEqual([]);
        // (this page draws in the browser's own font, wider than IBM Plex: whole is measured where the row is wide; the
        // recipe's outline in Plex checks the phone)
        const short = places.filter((place) => place.name === "Angemeldet bleiben" || place.name === "Neue Apps fragen");
        expect(short.map((place) => ({ name: place.name, whole: place.whole || width < 640, word: place.word }))).toEqual(
          // the word gives way below a pane of 384 px (this page's pane is its window less 16 px)
          short.map((place) => ({ name: place.name, whole: true, word: width - 16 >= 384 })),
        );
        // beside the names the values of all settings stand in one line down the page, a short one too (on the phone a
        // short one stands at the end of its name's line instead)
        if (width >= 640) expect(new Set(before.settings.map((setting) => setting.control.split(",")[0])).size).toBe(1);
        // and it goes again as it came
        await page.evaluate(() => window.__k2SettingChange?.(false));
        await settled(page);
        expect(await settingBoxes(page)).toEqual(before);
      },
      width,
    );
  });

// On a narrow phone (a pane of 360 or 375 px) "geändert" gives way so that a short value before the change ("12 Std.",
// "Aus") stands whole beside the deed, in the font people see (review r12: at 360–371 px it read "vorher 12 St…").
for (const pane of [360, 375])
  test(`a short value before a change stands whole beside the deed on a pane of ${pane} px, in IBM Plex`, async () => {
    await withPage(
      "setting-change",
      async (page) => {
        await page.evaluate(() => window.__k2SettingChange?.(true));
        await settled(page);
        const found = await page.evaluate(() => {
          const setting = (name: string) =>
            [...document.querySelectorAll<HTMLElement>("[data-k2-part='Setting']")].find((each) =>
              each.querySelector(".k2-field-label")?.textContent?.includes(name),
            )!;
          const read = (name: string) => {
            const chip = setting(name).querySelector<HTMLElement>(".k2-field-was .k2-chip-text")!;
            const deed = setting(name).querySelector(".k2-field-action button")!.getBoundingClientRect();
            return {
              whole: chip.scrollWidth <= chip.clientWidth + 1,
              apart: chip.getBoundingClientRect().right <= deed.left + 0.5,
            };
          };
          return {
            pane: Math.round(setting("Adresse").closest(".k2-pane")!.getBoundingClientRect().width),
            font:
              getComputedStyle(setting("Adresse")).fontFamily.includes("IBM Plex Sans") && document.fonts.check('500 12px "IBM Plex Sans"'),
            hours: read("Angemeldet bleiben"),
            switch: read("Neue Apps fragen"),
          };
        });
        expect(found).toEqual({ pane, font: true, hours: { whole: true, apart: true }, switch: { whole: true, apart: true } });
      },
      pane + 16,
      false,
      true,
    );
  });

// A setting that never changes in place (no `was`, no `action`) keeps no room for a change: it is as tall as before the
// room was kept (81b5b40, measured in IBM Plex in Chromium and WebKit), at each layout of the settings page (review r12:
// the page grew by 31 % at 1024 px).
const stillHeights: Record<number, Record<string, number>> = {
  1440: { Gemeinschaftsrechner: 72, "Neue Apps fragen": 64, Adresse: 72, "Admins koppeln direkt": 64 },
  1024: { Gemeinschaftsrechner: 76, "Neue Apps fragen": 76, Adresse: 100, "Admins koppeln direkt": 60 },
  700: { Gemeinschaftsrechner: 72, "Neue Apps fragen": 64, Adresse: 72, "Admins koppeln direkt": 64 },
  390: { Gemeinschaftsrechner: 76, "Neue Apps fragen": 76, Adresse: 100, "Admins koppeln direkt": 60 },
};
for (const width of [1440, 1024, 700, 390])
  test(`a setting that cannot change keeps no room for a change at ${width} px`, async () => {
    await withPage(
      "settings",
      async (page) => {
        const found = await page.evaluate(() =>
          Object.fromEntries(
            [...document.querySelectorAll<HTMLElement>("[data-k2-part='Setting']")]
              // the recipe's one setting that changes in place is "Angemeldet bleiben"
              .filter((setting) => !setting.textContent?.includes("Angemeldet bleiben"))
              .map((setting) => [
                setting.querySelector(".k2-field-label")!.textContent,
                Math.round(setting.getBoundingClientRect().height),
              ]),
          ),
        );
        expect(found).toEqual(stillHeights[width]!);
      },
      width,
      false,
      // in IBM Plex, so a hint wraps as a person sees it and alike in both engines
      true,
    );
  });

for (const width of [700, 390])
  test(`the Tab key reaches a setting's value and then its deed, as the eye reads them, at ${width} px (WCAG 2.4.3)`, async () => {
    await withPage(
      "setting-change",
      async (page) => {
        await page.evaluate(() => window.__k2SettingChange?.(true));
        await settled(page);
        for (const name of ["Angemeldet bleiben", "Adresse", "Neue Apps fragen"]) {
          const setting = page.locator("[data-k2-part='Setting']", { hasText: name }).first();
          await setting.locator(".k2-field-action button").focus();
          await page.keyboard.press("Shift+Tab");
          const value = await setting.evaluate((element) => {
            const focused = document.activeElement;
            if (!focused || !element.contains(focused) || focused.closest(".k2-field-action")) return null;
            const box = focused.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom, right: box.right, middle: box.top + box.height / 2 };
          });
          await page.keyboard.press("Tab");
          const deed = await setting.evaluate((element) => {
            const focused = document.activeElement;
            if (!focused?.closest(".k2-field-action") || !element.contains(focused)) return null;
            const box = focused.getBoundingClientRect();
            return { top: box.top, left: box.left, middle: box.top + box.height / 2 };
          });
          // the deed the key reaches next stands after the value as the eye reads: on its line after it, or under it
          const after =
            !!value && !!deed && (deed.top >= value.bottom - 0.5 || (Math.abs(deed.middle - value.middle) < 2 && deed.left >= value.right));
          expect({ name, value: !!value, deed: !!deed, after }).toEqual({ name, value: true, deed: true, after: true });
        }
      },
      width,
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
        // no line between rows); on the phone a row that leads with a mark takes 56 (the mockup's 56 with a mark of 40)
        expect(found.heights).toEqual(width === 1440 ? [44, 52] : [56, 56]);
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

test("key numbers in a pane of about 600 px beside a side column stay whole: four stand two by two, three narrow ones take 14 px (review r5)", async () => {
  await withPage("cells-narrow", async (page) => {
    const found = await page.evaluate(() => ({
      pane: Math.round(document.querySelector(".k2-cells")!.closest(".k2-pane")!.getBoundingClientRect().width),
      cut: [...document.querySelectorAll<HTMLElement>(".k2-cell-value")]
        .filter((value) => value.scrollWidth > value.clientWidth + 1)
        .map((value) => value.textContent),
      rows: [...document.querySelectorAll<HTMLElement>(".k2-cells")].map(
        (cells) => new Set([...cells.children].map((cell) => Math.round(cell.getBoundingClientRect().top))).size,
      ),
      sizes: [...document.querySelectorAll<HTMLElement>(".k2-cells")].map((cells) => [
        Math.round(cells.querySelector(".k2-cell")!.getBoundingClientRect().width),
        getComputedStyle(cells.querySelector(".k2-cell-value")!).fontSize,
      ]),
    }));
    expect(found.pane).toBeGreaterThan(560);
    expect(found.pane).toBeLessThan(640);
    expect(found.cut).toEqual([]);
    // four cells stand two by two and keep the statement's 18 px; three of about 200 px take 14 px; five and six stand
    // in rows of three
    const [four, three] = found.sizes;
    expect(four![1]).toBe("18px");
    expect(three![1]).toBe("14px");
    expect(found.rows).toEqual([2, 1, 2, 2]);
    // each layout draws its own lines, also the rows of three (review r6)
    const lines = await page.evaluate(() =>
      [...document.querySelectorAll(".k2-cells")].flatMap((cells, block) => {
        const items = [...cells.querySelectorAll<HTMLElement>(":scope > .k2-cell")];
        const boxes = items.map((cell) => cell.getBoundingClientRect());
        const top = Math.min(...boxes.map((box) => box.top));
        return items
          .map((cell, index) => {
            const box = boxes[index]!;
            const style = getComputedStyle(cell);
            const after = boxes.some((other) => Math.round(other.top) === Math.round(box.top) && other.right <= box.left + 1);
            const under = Math.round(box.top) > Math.round(top);
            const left = style.borderLeftWidth !== "0px";
            const up = style.borderTopWidth !== "0px";
            return left === after && up === under ? "" : `block ${block} cell ${index + 1}: left ${left}/${after} top ${up}/${under}`;
          })
          .filter(Boolean);
      }),
    );
    expect(lines).toEqual([]);
  });
});

test("key numbers never stand alone as a tall cell: four in a row or two by two, three in a row or two and a line; values whole (review A)", async () => {
  for (const width of [390, 1024, 1440])
    await withPage(
      "cells",
      async (page) => {
        const found = await page.evaluate(() =>
          [...document.querySelectorAll(".k2-cells")].map((cells) => {
            const items = [...cells.querySelectorAll<HTMLElement>(":scope > .k2-cell")];
            const boxes = items.map((cell) => cell.getBoundingClientRect());
            const rows = new Map<number, HTMLElement[]>();
            items.forEach((cell, index) =>
              rows.set(Math.round(boxes[index]!.top), [...(rows.get(Math.round(boxes[index]!.top)) ?? []), cell]),
            );
            return {
              rows: rows.size,
              widths: boxes.map((box) => Math.round(box.width)),
              // a cell alone in its row is one line: its value stands on the line of its label
              alone: [...rows.values()]
                .filter((row) => row.length === 1)
                .map((row) => {
                  const cell = row[0]!;
                  const label = cell.querySelector(".k2-cell-label")!.getBoundingClientRect();
                  const value = cell.querySelector(".k2-cell-value")!.getBoundingClientRect();
                  return Math.abs(label.top + label.height / 2 - (value.top + value.height / 2)) <= 4;
                }),
              values: items
                .map((cell) => cell.querySelector<HTMLElement>(".k2-cell-value")!)
                .filter((value) => value.scrollWidth > value.clientWidth + 1)
                .map((value) => `${value.textContent} (${value.scrollWidth} in ${value.clientWidth})`),
              // a number is one word: it stands on one line, never broken between its digits (review r5)
              numbers: items.flatMap((cell) => {
                const value = cell.querySelector<HTMLElement>(".k2-cell-value")!;
                const text = [...value.childNodes].find(
                  (node) => node.nodeType === Node.TEXT_NODE && /^[\d.,]+$/.test(node.textContent ?? ""),
                );
                if (!text) return [];
                const range = document.createRange();
                range.selectNodeContents(text);
                return [[text.textContent ?? "", range.getClientRects().length] as const];
              }),
            };
          }),
        );
        const [four, three] = found;
        const numbers = found.flatMap((cells) => cells.numbers);
        expect(numbers.map(([text]) => text)).toContain("12.345.678");
        expect(numbers.filter(([, lines]) => lines !== 1)).toEqual([]);
        if (width === 390) {
          // two by two, equal; two and the third as one line across
          expect(four!.rows).toBe(2);
          expect(new Set(four!.widths).size).toBe(1);
          expect(three!.rows).toBe(2);
          expect(three!.alone).toEqual([true]);
        } else {
          // side by side: each cell of four gets at least its 220 px
          expect([four!.rows, three!.rows]).toEqual([1, 1]);
          expect(Math.min(...four!.widths)).toBeGreaterThanOrEqual(220);
        }
        for (const cells of found) expect(cells.values).toEqual([]);
        // five and six: in one row where the pane is 880 px or wider, two to a row on the phone (the odd last one a line
        // across); rows of three in a narrow pane (the test beside a side column)
        const [, , five, six] = found;
        expect([five!.rows, six!.rows]).toEqual(width === 390 ? [3, 3] : [1, 1]);
        if (width === 390) expect(five!.alone).toEqual([true]);
        // every layout draws its own lines: a line on the left only after a cell in the same row, one on top only under
        // a row (none doubled, none missing)
        const lines = await page.evaluate(() =>
          [...document.querySelectorAll(".k2-cells")].flatMap((cells, block) => {
            const items = [...cells.querySelectorAll<HTMLElement>(":scope > .k2-cell")];
            const boxes = items.map((cell) => cell.getBoundingClientRect());
            const top = Math.min(...boxes.map((box) => box.top));
            return items
              .map((cell, index) => {
                const box = boxes[index]!;
                const style = getComputedStyle(cell);
                const after = boxes.some((other) => Math.round(other.top) === Math.round(box.top) && other.right <= box.left + 1);
                const under = Math.round(box.top) > Math.round(top);
                const left = style.borderLeftWidth !== "0px";
                const up = style.borderTopWidth !== "0px";
                return left === after && up === under ? "" : `block ${block} cell ${index + 1}: left ${left}/${after} top ${up}/${under}`;
              })
              .filter(Boolean);
          }),
        );
        expect(lines).toEqual([]);
        // a value is the cell's statement (18 px) where cells stand side by side, 14 px in half a phone
        expect(
          await page
            .locator(".k2-cell-value")
            .first()
            .evaluate((value) => getComputedStyle(value).fontSize),
        ).toBe(width === 390 ? "14px" : "18px");
        // a value with a limit has its bar: 38,2 of 100 fill 38 % of it
        const meter = await page.locator(".k2-cell-meter").evaluate((bar) => ({
          role: bar.getAttribute("role"),
          share: Math.round((bar.firstElementChild!.getBoundingClientRect().width / bar.getBoundingClientRect().width) * 100),
        }));
        expect(meter).toEqual({ role: "meter", share: 38 });
        const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
        expect(layout.problems).toEqual([]);
      },
      width,
      false,
      // in IBM Plex: whether a value stands whole is a question of the font people see (a chip is never wider than its
      // line and ends in "…", so the browser's own, wider font would cut "123.456,78 €")
      true,
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

test("on the phone a drawing taller than its split keeps its pane at the split's height and scrolls inside it (W3)", async () => {
  await withPage(
    "split-tall-canvas",
    async (page) => {
      const found = await page.evaluate(() => {
        const pane = document.querySelector(".k2-canvas[data-fill]")!.closest(".k2-pane")!;
        const split = pane.closest(".k2-split")!.getBoundingClientRect();
        // the drawing's own scroller (a calendar's days)
        const scroll = pane.querySelector<HTMLElement>(".calendar")!;
        const box = pane.getBoundingClientRect();
        return {
          inside: Math.round(box.bottom) <= Math.round(split.bottom) && box.height <= split.height + 0.5,
          scrolls: scroll.scrollHeight > scroll.clientHeight + 1,
        };
      });
      expect(found).toEqual({ inside: true, scrolls: true });
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

// the open folder is the last to give way: the places above fold into "…" first, and the page shows with at least
// its 48 px, cut with "…" only when it alone does not fit, never clipped by what is around it (W1b #4206 r5)
for (const which of ["path", "path-chip"] as const)
  for (const width of [1440, 1024, 390])
    test(`a deep path keeps its open folder in sight at ${width} px (${which})`, async () => {
      await withPage(
        which,
        async (page) => {
          // on the phone the path gives way to the phone bar of the shell, which names the page: wholly, never a cut
          // remnant such as "Werk"
          if (width < 768) {
            expect(
              await page.locator(".k2-path[aria-label='Ort']").evaluateAll((paths) => paths.map((path) => path.getClientRects().length)),
            ).toEqual([0]);
            return;
          }
          const current = await page.evaluate(() => {
            const page = document.querySelector<HTMLElement>(".k2-path[aria-label='Ort'] > b")!;
            const box = page.getBoundingClientRect();
            // every box up to the head that clips: the page lies inside it
            const clipped: string[] = [];
            for (let node = page.parentElement; node && !node.matches("[data-slot='head']"); node = node.parentElement) {
              const style = getComputedStyle(node);
              if (style.overflowX === "visible") continue;
              const room = node.getBoundingClientRect();
              if (box.left < room.left - 0.5 || box.right > room.right + 0.5) clipped.push(node.className);
            }
            const cut = page.scrollWidth > page.clientWidth + 1;
            return {
              shown: page.getClientRects().length > 0 && box.width > 0,
              inside: box.left >= -0.5 && box.right <= innerWidth + 0.5,
              clipped,
              // cut only with "…" and down to no less than 48 px
              cut: cut ? getComputedStyle(page).textOverflow === "ellipsis" && Math.round(box.width) >= 48 : true,
            };
          });
          expect(current).toEqual({ shown: true, inside: true, clipped: [], cut: true });
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

// From DR's look pass (#4229), each in the primitive that owns it.
test("code in prose: a word in the mono face on a quiet tint, a block on its own surface that scrolls sideways; a CodeBlock's lines stay its own (#4246, #4244)", async () => {
  await withPage("prose", async (page) => {
    const found = await page.evaluate(() => {
      const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
      const word = style(".k2-prose p > code");
      const block = style(".k2-prose pre");
      const line = style(".k2-prose .k2-code code");
      return {
        word: [word.fontFamily.includes("monospace"), word.backgroundColor !== "rgba(0, 0, 0, 0)"],
        block: [block.borderTopWidth, block.overflowX],
        line: [line.backgroundColor, line.paddingLeft, line.fontSize === word.fontSize ? "same" : "own"],
      };
    });
    expect(found).toEqual({ word: [true, true], block: ["1px", "auto"], line: ["rgba(0, 0, 0, 0)", "0px", "own"] });
  });
});

test("a group in a section draws no frame of its own, a line parts two groups; a group outside keeps its frame apart from the line above (no box in a box, no double line)", async () => {
  for (const width of [390, 1440])
    await withPage(
      "groups",
      async (page) => {
        const found = await page.evaluate(() => {
          const frame = (group: Element) => {
            const style = getComputedStyle(group);
            return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].join(" ");
          };
          const inside = [...document.querySelectorAll(".k2-sec > .k2-group")];
          const outside = [...document.querySelectorAll(".k2-scroll > .k2-group")];
          const section = document.querySelector(".k2-sec")!.getBoundingClientRect();
          const notice = document.querySelector(".k2-notice")!.getBoundingClientRect();
          return {
            inside: inside.map(frame),
            // inside a section a group stands on the section's edges, as its rows do
            flush: inside.every((group) => Math.round(group.getBoundingClientRect().left) === Math.round(section.left)),
            outside: outside.map(frame),
            gap: Math.round(outside[0]!.getBoundingClientRect().top - notice.bottom),
          };
        });
        expect(found.inside).toEqual(["0px 0px 0px 0px", "1px 0px 0px 0px"]);
        expect(found.flush).toBe(true);
        expect(found.outside).toEqual(["1px 1px 1px 1px", "1px 1px 1px 1px"]);
        expect(found.gap).toBeGreaterThanOrEqual(12);
        const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
        expect(layout.problems).toEqual([]);
      },
      width,
    );
});

test("a home of sections: side by side where both get 360 px, a group head as text, the time at the end of a sentence without a place, a foot without a line under it", async () => {
  for (const width of [1440, 390])
    await withPage(
      "structure",
      async (page) => {
        const found = await page.evaluate(() => {
          const box = (element: Element) => element.getBoundingClientRect();
          const sections = [...document.querySelectorAll(".k2-sec-cols > .k2-sec-col > .k2-sec")].map(box);
          const [plain, placed] = [...document.querySelectorAll(".k2-row[data-activity]")];
          const foot = document.querySelector(".k2-scroll > .k2-bar:last-child")!;
          return {
            side: sections.length === 2 && Math.round(sections[0]!.top) === Math.round(sections[1]!.top),
            head: getComputedStyle(document.querySelector(".k2-gh")!).backgroundColor,
            // the time stands on the line of the sentence: their first letters share one baseline (the bottoms of their
            // text boxes, within the difference of 13 and 12 px type)
            time: (() => {
              const bottom = (element: Element) => {
                const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
                const first = walker.nextNode()!;
                const text = document.createRange();
                text.setStart(first, 0);
                text.setEnd(first, 1);
                return text.getBoundingClientRect().bottom;
              };
              return Math.abs(bottom(plain!.querySelector(".k2-row-l1")!) - bottom(plain!.querySelector(":scope > .k2-row-time")!)) <= 1;
            })(),
            under: placed!.querySelector(":scope > .k2-row-l2")?.textContent,
            foot: getComputedStyle(foot).borderBottomWidth,
          };
        });
        expect(found).toEqual({
          side: width === 1440,
          head: "rgba(0, 0, 0, 0)",
          time: true,
          under: "Werkstatt · 09:40",
          foot: "0px",
        });
        const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
        expect(layout.problems).toEqual([]);
      },
      width,
    );
});

test("on the phone an open detail is the page: the list's filters and its floating main action leave with the list", async () => {
  for (const which of ["list", "closed"] as const)
    await withPage(
      which,
      async (page) => {
        const found = await page.evaluate(() => ({
          bar: !!document.querySelector(".k2-fbar")?.checkVisibility(),
          fab: !!document.querySelector(".k2-fab")?.checkVisibility(),
        }));
        // with the file open its detail is the page; without it the list keeps both
        expect({ which, ...found }).toEqual({ which, bar: which === "closed", fab: which === "closed" });
      },
      390,
    );
});

test("describe reports a hidden primary action on the desktop even while a detail with its way back is open (review r5)", async () => {
  // the head's main action hidden at this width: on the desktop the list and the detail both show, so nothing excuses it
  await withPage("list", async (page) => {
    await page.addStyleTag({ content: "[data-slot='head'] .k2-btn[data-variant='primary'] { display: none !important; }" });
    expect(await describeV2Page(page, "[data-k2-workspace]")).toContain("the primary action is hidden at this width");
  });
  // on the phone the open detail is the page: the list's floating main action gives way to the detail's deeds
  await withPage(
    "list",
    async (page) => {
      expect(await describeV2Page(page, "[data-k2-workspace]")).not.toContain("the primary action is hidden at this width");
    },
    390,
  );
});

test("a setting's name stands alone in its column beside the middle of its value; its help stands under the value and what it was under the name, beside the help (CLEAR AND DENSE f)", async () => {
  await withPage("settings", async (page) => {
    const found = await page.evaluate(() =>
      [...document.querySelectorAll("[data-k2-part='Setting']")].map((setting) => {
        const box = (selector: string) => setting.querySelector(selector)?.getBoundingClientRect();
        const label = box(":scope > .k2-field-label")!;
        const hint = box(":scope > .k2-field-message");
        const control = box(":scope > :not(.k2-field-label, .k2-field-message, .k2-field-end)")!;
        const was = box(":scope > .k2-field-end > .k2-field-was");
        return {
          name: setting.querySelector(".k2-field-label")!.textContent,
          middle: Math.abs((label.top + label.bottom) / 2 - (control.top + control.bottom) / 2) <= 2 && label.right <= control.left,
          // the one line of help starts under the value, on its edge
          help: hint ? hint.top >= control.bottom - 0.5 && Math.abs(hint.left - control.left) <= 1 : true,
          // "geändert" under the name on its edge, on the help's line
          was: was
            ? was.top >= control.bottom - 0.5 && Math.abs(was.left - label.left) <= 1 && (!hint || Math.abs(was.top - control.bottom) <= 1)
            : null,
        };
      }),
    );
    expect(found.filter((setting) => !setting.middle || !setting.help || setting.was === false)).toEqual([]);
    expect(found.length).toBeGreaterThan(3);
    // the recipe's changed setting shows it, so the place is measured, not skipped
    expect(found.filter((setting) => setting.was === true).length).toBe(1);
  });
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

test("on the phone the statements end before 'Ansicht' at rest and fade at their own end, never over the menu (files closed, three people)", async () => {
  for (const which of ["closed", "view-statement"] as const)
    await withPage(
      which,
      async (page) => {
        const found = await page.evaluate(() => {
          const bar = document.querySelector(".k2-fbar")!;
          const view = bar.querySelector(".k2-fbar-view")!;
          const flow = bar.querySelector<HTMLElement>(".k2-fbar-flow")!;
          const statement = bar.querySelector(".k2-stmt")!;
          // where the statement can be seen: inside every box around it that clips
          let seen = statement.getBoundingClientRect().right;
          for (let box = statement.parentElement; box && box !== bar.parentElement; box = box.parentElement)
            if (getComputedStyle(box).overflowX !== "visible") seen = Math.min(seen, box.getBoundingClientRect().right);
          const mask = getComputedStyle(flow).maskImage || getComputedStyle(flow).webkitMaskImage;
          return {
            seen: seen <= view.getBoundingClientRect().left + 0.5,
            strip: flow.getBoundingClientRect().right <= view.getBoundingClientRect().left + 0.5,
            fades: mask.includes("gradient"),
            cover: getComputedStyle(view, "::before").content,
            inside: view.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 0.5,
          };
        });
        expect({ which, ...found }).toEqual({ which, seen: true, strip: true, fades: true, cover: "none", inside: true });
        const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
        expect(layout.problems).toEqual([]);
        // a statement longer than the strip ends in "…" inside it
        const cut = await page.evaluate(() => {
          const words = document.querySelector<HTMLElement>(".k2-fbar .k2-stmt-b")!;
          return { long: words.scrollWidth > words.clientWidth + 1, ellipsis: getComputedStyle(words).textOverflow };
        });
        if (which === "view-statement") expect(cut).toEqual({ long: true, ellipsis: "ellipsis" });
      },
      390,
    );
});

test("on the phone a row that leads with a mark is 56 px with a mark of 40", async () => {
  await withPage(
    "states",
    async (page) => {
      const rows = await page.locator(".k2-row[data-mark]").evaluateAll((elements) =>
        elements.map((row) => {
          const mark = row.querySelector(":scope > .k2-row-lead > .k2-mk")!.getBoundingClientRect();
          return { height: Math.round(row.getBoundingClientRect().height), mark: `${mark.width}x${mark.height}` };
        }),
      );
      expect(rows.length).toBe(4);
      expect([...new Set(rows.map((row) => row.mark))]).toEqual(["40x40"]);
      // a row of one line is exactly 56; one with more lines or states grows from there
      expect(rows[0]!.height).toBe(56);
      expect(rows.every((row) => row.height >= 56)).toBe(true);
    },
    390,
  );
});

test("on the phone a row without a mark keeps its 60 px", async () => {
  await withPage(
    "selection",
    async (page) => {
      const plain = await page
        .locator(".k2-row:not([data-mark])")
        .first()
        .evaluate((row) => Math.round(row.getBoundingClientRect().height));
      expect(plain).toBe(60);
    },
    390,
  );
});

test("beside the phone a row's mark is 32 again", async () => {
  await withPage(
    "list",
    async (page) => {
      const mark = await page
        .locator(".k2-row[data-mark] > .k2-row-lead > .k2-mk")
        .first()
        .evaluate((element) => element.getBoundingClientRect().width);
      expect(mark).toBe(32);
    },
    1024,
  );
});

for (const width of [1440, 1024, 800, 390])
  test(`a bar in the flow of a column puts its end on a line of its own where it has no room, never under its deeds (Files, ${width})`, async () => {
    await withPage(
      "list",
      async (page) => {
        const found = await page.evaluate(() => {
          const bar = document.querySelector(".k2-pane[data-detail] .k2-scroll > .k2-bar")!;
          const end = bar.querySelector(".k2-bar-end")!.getBoundingClientRect();
          const deeds = [...bar.querySelectorAll(".k2-bar-start .k2-btn")].map((button) => button.getBoundingClientRect());
          const pane = bar.closest(".k2-pane")!.getBoundingClientRect();
          return {
            apart: deeds.every((deed) => end.left >= deed.right || end.top >= deed.bottom || end.bottom <= deed.top),
            // inside its pane and in sight of the window
            inside: [end, ...deeds].every((box) => box.right <= Math.min(pane.right, innerWidth) + 0.5),
            // every deed keeps its whole label
            whole: [...bar.querySelectorAll<HTMLElement>(".k2-bar-start .k2-btn")].every(
              (button) => button.scrollWidth <= button.clientWidth + 1,
            ),
          };
        });
        // at 800 the detail column itself reaches past the window (878–951 in 800): MW's item of the narrow detail, not
        // this bar's; there the bar keeps its deeds apart and whole
        expect({ width, ...found }).toEqual({ width, apart: true, inside: width !== 800, whole: true });
        // at 800 the detail stands at its narrowest; the actions of its sections are another place (MW)
        if (width === 800) return;
        const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
        expect(layout.problems).toEqual([]);
      },
      width,
    );
  });

test("in a dialog on the phone a notice of many lines keeps its height above the next field, and a chip longer than its line ends with '…' inside the dialog", async () => {
  await withPage(
    "invitation",
    async (page) => {
      const found = await page.evaluate(() => {
        const notice = document.querySelector(".k2-dialog .k2-notice")!.getBoundingClientRect();
        const text = document.querySelector(".k2-dialog .k2-notice-text")!.getBoundingClientRect();
        const label = document.querySelector(".k2-dialog .k2-field-label")!.getBoundingClientRect();
        const body = document.querySelector(".k2-dialog-body")!.getBoundingClientRect();
        const chip = document.querySelector<HTMLElement>(".k2-dialog .k2-chip")!;
        const words = chip.querySelector<HTMLElement>(".k2-chip-text")!;
        return {
          // the notice holds all its words, and the field's label stands below it
          whole: text.bottom <= notice.bottom + 0.5 && label.top >= notice.bottom,
          chipInside: chip.getBoundingClientRect().right <= body.right + 0.5,
          ellipsis: words.scrollWidth > words.clientWidth && getComputedStyle(words).textOverflow === "ellipsis",
          name: chip.textContent?.trim().startsWith("bartholomew"),
        };
      });
      expect(found).toEqual({ whole: true, chipInside: true, ellipsis: true, name: true });
      // the "…" of the chip is on purpose (its words stay its name); nothing else is cut or out of place
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
      expect(layout.problems).toEqual([]);
    },
    390,
  );
});
