import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
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

// several drags in one test; a busy runner needs more than the default five seconds
setDefaultTimeout(20_000);

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
  // tall enough that the media grids, the table and its last rows all stand in view
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
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

// the files stand in a selection: a listbox of options
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
  await frames(page);
  if (rest) await page.waitForTimeout(rest);
};

/** The drag follows the pointer once per frame; WebKit's frames can come late. */
const frames = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

test("server markup: media tiles send their grid with one Tab stop and a '…' per tile out of the tab order", () => {
  expect(markup).toMatch(/class="k2-tiles\s*"[^>]*data-variant="media"/);
  const grid = markup.slice(markup.indexOf('aria-label="Dateien als Kacheln"'), markup.indexOf('aria-label="Verknüpfungen"'));
  expect(grid.match(/class="k2-tile\s*"[^>]*tabindex="0"/g)?.length).toBe(1);
  expect(markup).toContain('class="k2-tile-menu"');
});

test("tiles: one Tab stop, arrows follow the grid, Space selects, Enter opens", async () => {
  await withPage(async (page) => {
    await tile(page, "Belege").focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.activeElement?.querySelector(".k2-tile-title")?.textContent === "Fotos");
    await page.keyboard.press("Space");
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".k2-tile[data-selected]")].some((tile) => tile.textContent?.includes("Fotos")),
    );
    await page.keyboard.press("End");
    await page.waitForFunction(() => document.activeElement?.querySelector(".k2-tile-title")?.textContent === "Angebot.pdf");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.hash === "#angebot");
    // the tiles are one stop: Tab leaves them, past their boxes, names and "…"
    await tile(page, "Angebot.pdf").focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest(".k2-tiles")?.getAttribute("aria-label") ?? null)).not.toBe(
      "Dateien als Kacheln",
    );
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
    // the zone exists only while a drag is under way: lift first, then go there
    await settled(page);
    await dragTo(page, tile(page, "Angebot.pdf"), tile(page, "Messestand.jpg"));
    await settled(page);
    const zone = await page.getByText("Hier loslassen: nichts passiert").boundingBox();
    if (!zone) throw new Error("no zone while dragging");
    await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height / 2, { steps: 6 });
    await frames(page);
    await page.mouse.up();
    await settled(page);
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
    await settled(page);
    const box = await year.boundingBox();
    if (!box) throw new Error("2025 not shown");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await frames(page);
    await page.mouse.up();
    expect(await page.evaluate(() => window.__moves)).toEqual(["angebot>archiv-2025"]);
  });
});

test("drag: selected rows go together onto a folder row; a click without moving still opens the row", async () => {
  await withPage(async (page) => {
    await tableRow(page, "Messestand.jpg").locator("input").check();
    await tableRow(page, "Angebot.pdf").locator("input").check();
    await settled(page);
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

// ── Review findings (Codex, 26.11.) ──────────────────────────────────────────────────────────────────────────────

/** Moves the pressed pointer to the middle of `to` and waits for the drag to follow. */
const moveTo = async (page: Page, to: { x: number; y: number; width: number; height: number }) => {
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
  await frames(page);
};

test("drag: the place that says 'nothing happens' wins over a folder under it", async () => {
  await withPage(async (page) => {
    // make the window end so that the folder row "Belege" lies under that place
    const rowBox = await tableRow(page, "Belege").boundingBox();
    if (!rowBox) throw new Error("no row");
    await page.setViewportSize({ width: 1440, height: Math.round(rowBox.y + rowBox.height / 2 + 46) });
    await settled(page);
    await dragTo(page, tile(page, "Angebot.pdf"), tile(page, "Messestand.jpg"));
    await settled(page);
    const zone = await page.getByText("Hier loslassen: nichts passiert").boundingBox();
    if (!zone) throw new Error("no zone");
    // the row lies under that place (the library finds targets by their boxes, as here)
    await settled(page);
    const rowNow = await tableRow(page, "Belege").boundingBox();
    if (!rowNow) throw new Error("no row");
    const middle = { x: zone.x + zone.width / 2, y: zone.y + zone.height / 2 };
    const under = middle.x >= rowNow.x && middle.x < rowNow.x + rowNow.width && middle.y >= rowNow.y && middle.y < rowNow.y + rowNow.height;
    expect(under).toBe(true);
    await moveTo(page, zone);
    expect(await tableRow(page, "Belege").getAttribute("data-drop-over")).toBeNull();
    await page.mouse.up();
    expect(await page.evaluate(() => window.__moves)).toBeUndefined();
  });
});

test("drag: a selection with an entry that cannot move moves nothing, and every folder says so", async () => {
  await withPage(async (page) => {
    await page.evaluate(() => window.__select?.(["gesperrt", "angebot"]));
    await dragTo(page, tile(page, "Angebot.pdf"), folder(page, "Projekte"));
    expect(await folder(page, "Projekte").getAttribute("data-drop-refused")).toBe("");
    await page.mouse.up();
    expect(await page.evaluate(() => window.__moves)).toBeUndefined();
  });
});

test("drag: what is dragged is fixed when it is lifted, and the folder is asked again when it is let go", async () => {
  await withPage(async (page) => {
    await dragTo(page, tile(page, "Angebot.pdf"), folder(page, "Projekte"));
    // the selection changes under the drag: the drag keeps what it lifted
    await page.evaluate(() => window.__select?.(["angebot", "messe"]));
    await settled(page);
    await moveTo(page, (await folder(page, "Archiv").boundingBox())!);
    await page.mouse.up();
    expect(await page.evaluate(() => window.__moves)).toEqual(["angebot>archiv"]);
    // the folder stops taking files while the pointer is down: letting go moves nothing
    await settled(page);
    await dragTo(page, tile(page, "Werkstatt mit einem sehr langen Dateinamen, der nicht passt.jpg"), folder(page, "Projekte"));
    expect(await folder(page, "Projekte").getAttribute("data-drop-over")).toBe("");
    await page.evaluate(() => {
      window.__refuseAll = true;
    });
    await page.mouse.up();
    expect(await page.evaluate(() => window.__moves)).toEqual(["angebot>archiv"]);
  });
});

test("drag: a folder never goes into a folder that lies in it", async () => {
  await withPage(async (page) => {
    await page.getByRole("treeitem", { name: "Projekte", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await settled(page);
    await dragTo(page, folder(page, "Projekte"), folder(page, "Website"));
    expect(await folder(page, "Website").getAttribute("data-drop-refused")).toBe("");
    await page.mouse.up();
    expect(await page.evaluate(() => window.__moves)).toBeUndefined();
  });
});

test("tiles: a tile's deeds open from its '…', a right-click and Shift+F10 - the way to move without dragging", async () => {
  await withPage(async (page) => {
    await tile(page, "Angebot.pdf").focus();
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: "Verschieben nach …" }).click();
    expect(await page.evaluate(() => window.__deeds)).toEqual(["move:angebot"]);
    await tile(page, "Messestand.jpg").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Löschen" }).click();
    expect(await page.evaluate(() => window.__deeds)).toEqual(["move:angebot", "delete:messe"]);
    // the "…" is no Tab stop of its own: the grid stays one stop
    expect(
      await tiles(page)
        .locator("button[aria-haspopup]")
        .evaluateAll((buttons) => buttons.every((b) => b.tabIndex === -1)),
    ).toBe(true);
  });
});

test("drag: a folder of another scope with the same key never takes the entry", async () => {
  await withPage(async (page) => {
    const other = page.getByRole("list", { name: "Andere Ablage" }).getByRole("listitem").first();
    await dragTo(page, tile(page, "Angebot.pdf"), other);
    expect(await other.getAttribute("data-drop-over")).toBeNull();
    await page.mouse.up();
    expect(await page.evaluate(() => window.__moves)).toBeUndefined();
    expect(await page.evaluate(() => window.__deeds)).toBeUndefined();
  });
});

test("files: a folder from the computer is refused visibly; nothing is handed on", async () => {
  await withPage(async (page) => {
    const result = await page.evaluate(() => {
      const element = document.querySelector('.k2-table tbody tr[data-drop-target="belege"]');
      if (!element) return "missing";
      // a directory as the browser hands it over: an item whose entry is a directory
      const proto = DataTransferItem.prototype as unknown as { webkitGetAsEntry: () => unknown };
      proto.webkitGetAsEntry = () => ({ isDirectory: true, isFile: false, name: "Belege 2025" });
      const data = new DataTransfer();
      data.items.add(new File([""], "Belege 2025", { type: "" }));
      element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
      return element.hasAttribute("data-drop-refused") ? "refused" : "not refused";
    });
    expect(result).toBe("refused");
    expect(await page.evaluate(() => window.__files)).toBeUndefined();
  });
});

// ── Delta review (Codex, 26.11.) ─────────────────────────────────────────────────────────────────────────────────

test("drag: an entry that is no folder in its list never takes a drop, also when its key is a folder elsewhere", async () => {
  await withPage(async (page) => {
    const shortcut = page.getByRole("list", { name: "Verknüpfungen" }).getByRole("listitem").first();
    await dragTo(page, tile(page, "Angebot.pdf"), shortcut);
    expect(await shortcut.getAttribute("data-drop-over")).toBeNull();
    expect(await folder(page, "Projekte").getAttribute("data-drop-over")).toBeNull();
    await page.mouse.up();
    expect(await page.evaluate(() => window.__moves)).toBeUndefined();
  });
});

test("drag: a selection the app changes in place during the drag does not move more", async () => {
  await withPage(async (page) => {
    await page.evaluate(() => window.__select?.(["angebot"]));
    await dragTo(page, tile(page, "Angebot.pdf"), folder(page, "Projekte"));
    await page.evaluate(() => window.__growSelection?.("messe"));
    await page.mouse.up();
    expect(await page.evaluate(() => window.__moves)).toEqual(["angebot>projekte"]);
  });
});

// ── Review r2 (Opus, 26.11.) ─────────────────────────────────────────────────────────────────────────────────────

test("server markup: each tile's '…' is out of the tab order and hidden from screen readers before the page is live", () => {
  const triggers = [...markup.matchAll(/<span class="k2-tile-menu"[^>]*><button([^>]*)>/g)].map((match) => match[1] ?? "");
  expect(triggers.length).toBeGreaterThan(0);
  for (const trigger of triggers) {
    expect(trigger).toContain('tabindex="-1"');
    expect(trigger).toContain('aria-hidden="true"');
  }
});

test("tiles in a selection say whether the focused one is selected; Space changes it", async () => {
  await withPage(async (page) => {
    const grid = page.getByRole("listbox", { name: "Dateien als Kacheln" });
    expect(await grid.getAttribute("aria-multiselectable")).toBe("true");
    const fotos = grid.getByRole("option", { name: "Fotos", exact: true });
    expect(await fotos.getAttribute("aria-selected")).toBe("false");
    await fotos.focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-selected") === "true");
    // tiles without a selection stay a list of items
    expect(await page.getByRole("list", { name: "Andere Ablage" }).getByRole("listitem").count()).toBe(1);
  });
});

test("Space on a tile never scrolls the page, also without a selection", async () => {
  await withPage(async (page) => {
    await page.setViewportSize({ width: 1440, height: 500 });
    await settled(page);
    // a list without a selection that has more page below it
    const other = page.getByRole("list", { name: "Verknüpfungen" }).getByRole("listitem").first();
    await other.focus();
    await settled(page);
    // the scroller around the tile: it can scroll down from where it stands
    const before = await other.evaluate((tile) => {
      let box: HTMLElement | null = tile.parentElement;
      while (box && !(box.scrollHeight > box.clientHeight && getComputedStyle(box).overflowY !== "visible")) box = box.parentElement;
      const scroller = box ?? (document.scrollingElement as HTMLElement);
      (window as unknown as { __scroller: HTMLElement }).__scroller = scroller;
      // what is left to scroll below, from where the focused tile stands now
      return { top: scroller.scrollTop, room: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop };
    });
    expect(before.room).toBeGreaterThan(0);
    await page.keyboard.press("Space");
    await settled(page);
    expect(await page.evaluate(() => (window as unknown as { __scroller: HTMLElement }).__scroller.scrollTop)).toBe(before.top);
  });
});

test("arrows follow the screen in a right-to-left page", async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      document.documentElement.dir = "rtl";
    });
    await settled(page);
    const names = await page
      .locator(".k2-tiles[aria-label='Dateien als Kacheln'] > .k2-tile .k2-tile-title")
      .evaluateAll((titles) => titles.map((title) => title.textContent));
    await page.locator(".k2-tiles[aria-label='Dateien als Kacheln'] > .k2-tile").first().focus();
    // the second tile stands to the left of the first in a right-to-left grid
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction((second) => document.activeElement?.querySelector(".k2-tile-title")?.textContent === second, names[1]);
  });
});

// ── Review r3 (Opus, 26.11.) ─────────────────────────────────────────────────────────────────────────────────────

test("server markup: a tile with deeds names Shift+F10", () => {
  expect(markup).toMatch(/<div[^>]*aria-keyshortcuts="Shift\+F10"[^>]*role="option"|role="option"[^>]*aria-keyshortcuts="Shift\+F10"/);
});

test("tiles: a long press opens a tile's deeds (a phone, also with VoiceOver, has no Shift+F10)", async () => {
  await withPage(async (page) => {
    // core's long press binding marks the area with its delay in every engine
    expect(await tile(page, "Angebot.pdf").evaluate((element) => (element as HTMLElement).style.getPropertyValue("--hold-delay"))).toBe(
      "500ms",
    );
  });
});

test("tiles: the deed after the tiles stands outside the listbox, which holds only its options", async () => {
  await withPage(async (page) => {
    expect(await page.getByRole("button", { name: "Alle laden" }).count()).toBe(1);
    expect(await tiles(page).getByRole("button", { name: "Alle laden" }).count()).toBe(0);
  });
});
