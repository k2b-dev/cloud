import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-head-block.client";
import type { Kind } from "../../test/v2-head-block.fixture";
import { measureV2Layout } from "./testing";

// Look rules 30 and 31 (Valentin 27.11.): a pane's head and its status row are one block, with one line under it and no
// line between its rows; where the pane is wide (1200 px and more), or the head holds actions only, they stand in one
// row. The head's search is its symbol on every width and opens in place when pressed. And a row of one line keeps its
// height when it carries a deed beside its time. All of it is decided while the parts are made: the server's page and
// the live one show the same. The window is set like Cloud's shell, 66 px beside the workspace.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0 0 0 66px; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
let server: (kind: Kind) => { html: string; script: string };
const temp = mkdtempSync(resolve(tmpdir(), "k2-v2-head-block-"));
beforeAll(async () => {
  const serverFile = resolve(temp, "server.js");
  await Bun.write(serverFile, await bundleV2Entry("v2-head-block.server.tsx", "ssr"));
  ({ render: server } = (await import(serverFile)) as { render: typeof server });
  [client, browser] = await Promise.all([bundleV2Entry("v2-head-block.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
});

/** The page as the server sent it; with `live` hydrated over it, which fails on any node the client makes differently. */
const withPage = async (width: number, kind: Kind, live: boolean, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  const { html, script } = server(kind);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${script}<style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${html}</div></body></html>`,
    );
    if (live) {
      await page.addScriptTag({ content: `window.__k2HeadKind = ${JSON.stringify(kind)};` });
      await page.addScriptTag({ content: client });
      await page.waitForFunction(() => window.__k2Hydrated === true);
    }
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

type Box = { x: number; y: number; width: number; height: number };
const boxOf = (page: Page, selector: string): Promise<Box | null> =>
  page.evaluate((selector) => {
    const found = document.querySelector(selector)?.getBoundingClientRect();
    return found
      ? { x: Math.round(found.x), y: Math.round(found.y), width: Math.round(found.width), height: Math.round(found.height) }
      : null;
  }, selector);
const middle = (box: Box | null) => (box ? box.y + box.height / 2 : Number.NaN);

/** Lines across the head block (a control's frame is no line): the head's, the status row's, the block's own. */
const linesOf = (page: Page) =>
  page.evaluate(() => {
    const block = document.querySelector<HTMLElement>('.k2-pane > [data-slot="head"]');
    if (!block) throw new Error("no head");
    const pane = block.parentElement!.getBoundingClientRect();
    return [block, ...block.querySelectorAll<HTMLElement>("*")].filter((element) => {
      const style = getComputedStyle(element);
      const drawn = style.display !== "contents" && parseFloat(style.borderBottomWidth) > 0 && style.borderBottomStyle !== "none";
      return drawn && element.getBoundingClientRect().width >= pane.width * 0.8;
    }).length;
  });

const path = '.k2-pane > [data-slot="head"] [data-k2-part="Path"]';
const filter = '.k2-pane > [data-slot="head"] [data-slot="status"] .k2-status-lead';
const search = '.k2-pane > [data-slot="head"] .k2-input[data-search]';

describe("a pane's head and its status row are one block", () => {
  // the fixture has no sidebar: its pane is the window less the shell's 66 px, wide from a window of 1266 px
  for (const live of [false, true])
    for (const [width, oneRow] of [
      [390, false],
      [1024, false],
      [1440, true],
      [1920, true],
    ] as const)
      test(`with a path at ${width}px ${oneRow ? "in one row" : "in two rows"} (${live ? "hydrated" : "server"})`, async () => {
        await withPage(width, "path", live, async (page) => {
          const gap = middle(await boxOf(page, filter)) - middle(await boxOf(page, path));
          if (oneRow) expect(Math.abs(gap)).toBeLessThan(4);
          // two rows: the status row under the head; from 768 px close together (a head of 48 px over a row of 44)
          else expect(gap).toBeGreaterThan(30);
          if (!oneRow && width >= 768) expect(gap).toBeLessThan(52);
          expect(await linesOf(page)).toBe(1);
          if (width > 390) expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
        });
      });

  for (const width of [390, 1440])
    test(`a head of actions only shares the status row's row at ${width}px`, async () => {
      await withPage(width, "actions", true, async (page) => {
        expect(Math.abs(middle(await boxOf(page, search)) - middle(await boxOf(page, filter)))).toBeLessThan(8);
        expect(await linesOf(page)).toBe(1);
      });
    });

  // #4373: the main action the floating button repeats (`Button floats`) leaves the head on the phone; the block and
  // the head search stay as they are, on the server's page and the live one
  for (const live of [false, true])
    for (const width of [390, 1440])
      test(`with the floating button's twin at ${width}px (${live ? "hydrated" : "server"})`, async () => {
        await withPage(width, "floats", live, async (page) => {
          const twin = page.locator('.k2-pane > [data-slot="head"] .k2-bar-end > [data-floats]');
          expect(await twin.isVisible()).toBe(width > 390);
          expect(await page.locator('.k2-pane > [data-slot="head"]').getAttribute("data-block")).toBe("");
          expect((await boxOf(page, search))?.width).toBe(36);
          expect(await page.locator(search).getAttribute("data-head-search")).toBe("");
          expect(await linesOf(page)).toBe(1);
          const gap = middle(await boxOf(page, filter)) - middle(await boxOf(page, path));
          if (width > 390) {
            // one row, and nothing folds beside the twin
            expect(Math.abs(gap)).toBeLessThan(4);
            expect(await page.locator('.k2-pane > [data-slot="head"] .k2-bar-fold').count()).toBe(0);
          } else expect(gap).toBeGreaterThan(30);
        });
      });
});

describe("a line of state under a head is no toolbar", () => {
  for (const width of [1440, 1920])
    test(`a plain bar under the head keeps its own row and line at ${width}px`, async () => {
      await withPage(width, "state", true, async (page) => {
        expect(await page.locator('.k2-pane > [data-slot="head"]').getAttribute("data-block")).toBeNull();
        const head = await boxOf(page, '.k2-pane > [data-slot="head"] > .k2-bar');
        const state = await boxOf(page, '.k2-pane > [data-slot="status"] > .k2-bar');
        expect(state!.y).toBeGreaterThanOrEqual(head!.y + head!.height);
      });
    });
});

describe("the head's bar stays one box with the toolbar in it", () => {
  for (const width of [1024, 1440, 1920])
    test(`with room, nothing folds into "…" at ${width}px, neither the head's end nor its path`, async () => {
      await withPage(width, "path", true, async (page) => {
        for (const name of ["Teilen", "Laden"])
          expect(await page.locator('.k2-pane > [data-slot="head"] .k2-bar-end').getByRole("button", { name }).isVisible()).toBe(true);
        expect(await page.locator('.k2-pane > [data-slot="head"] .k2-bar-fold').count()).toBe(0);
        // the start takes its room in the block's grid: the path shows its places, not "…"
        expect(await page.locator(path).getAttribute("data-fold")).toBe("0");
        expect(await page.locator(path).getByRole("link", { name: "Alle Ablagen" }).isVisible()).toBe(true);
      });
    });

  test('a long path folds into "…" where the pane is narrow and unfolds when the room comes back', async () => {
    await withPage(768, "longPath", true, async (page) => {
      const fold = () => page.locator(path).getAttribute("data-fold");
      expect(await fold()).not.toBe("0");
      expect(await page.locator(path).getByRole("button", { name: "Weitere Orte" }).isVisible()).toBe(true);
      // in one row the start's column is as wide as what it holds: the path asks for its whole width, not its folded one
      await page.setViewportSize({ width: 1920, height: 800 });
      await page.waitForFunction((path) => document.querySelector(path)?.getAttribute("data-fold") === "0", path);
      await settled(page);
      expect(await fold()).toBe("0");
      for (const name of ["Alle Ablagen", "Werkstatt", "Lager Nord", "Angebote", "Kunden 2027", "Ausschreibung"])
        expect(await page.locator(path).getByRole("link", { name }).isVisible()).toBe(true);
      // and folds again when the room goes
      await page.setViewportSize({ width: 768, height: 800 });
      await page.waitForFunction((path) => document.querySelector(path)?.getAttribute("data-fold") !== "0", path);
      expect(await fold()).not.toBe("0");
    });
  });

  // In two rows the toolbar stands under the head's end but between start and end in the page: `reading-flow` lets
  // Chromium follow the rows (WebKit and Firefox do not know it yet and go start, toolbar, end).
  for (const [width, order] of [
    [1024, "path, the head's actions, then the toolbar"],
    [1920, "path, toolbar, then the head's actions"],
  ] as const)
    test(`the Tab key goes as the eye does at ${width}px: ${order}`, async () => {
      await withPage(width, "path", true, async (page) => {
        await page.locator('.k2-pane > [data-slot="head"] [data-k2-part="Path"] a').first().focus();
        // where each control ends on the screen (an open search grows to the left over its place, its end stays)
        const places: { x: number; y: number; name: string }[] = [];
        for (let step = 0; step < 7; step++) {
          places.push(
            await page.evaluate(() => {
              const active = document.activeElement!;
              const box = (active.closest(".k2-input") ?? active).getBoundingClientRect();
              return {
                x: Math.round(box.right),
                y: Math.round(box.top + box.height / 2),
                name: active.textContent || active.getAttribute("aria-label") || "",
              };
            }),
          );
          await page.keyboard.press("Tab");
        }
        // each next control stands to the right in the same row, or in a row further down
        const back = places.slice(1).filter((place, at) => {
          const before = places[at]!;
          return !(place.y > before.y + 12 || (Math.abs(place.y - before.y) <= 12 && place.x > before.x));
        });
        if (browserName === "webkit" && width === 1024) {
          // the known gap: WebKit has no `reading-flow` yet and goes as the page does, start, toolbar, end; this turns
          // red once it follows the rows, and the case joins the others
          expect(places.map((place) => place.name)).toEqual(["Alle Ablagen", "Filter", "Name", "Suchen", "Teilen", "Laden", "Neu"]);
          return;
        }
        expect(back).toEqual([]);
      });
    });
});

/**
 * What the eye sees of the open search: every point across its field, every 8 px at its middle, shows the field itself,
 * nothing cut or lying over it; and every control of the head beside it is in sight where it stands.
 */
const sightOf = (page: Page) =>
  page.evaluate((search) => {
    const box = document.querySelector(search)!;
    const field = box.getBoundingClientRect();
    const hidden: string[] = [];
    for (let x = Math.ceil(field.left) + 1; x < field.right - 1; x += 8) {
      const hit = document.elementFromPoint(x, field.top + field.height / 2);
      if (!hit || !box.contains(hit)) hidden.push(`${Math.round(x)}: ${hit?.className || hit?.tagName || "nothing"}`);
    }
    const covered = [...document.querySelectorAll<HTMLElement>('.k2-pane > [data-slot="head"] .k2-btn')]
      .filter((button) => button.checkVisibility({ visibilityProperty: true }))
      .filter((button) => {
        const place = button.getBoundingClientRect();
        const hit = document.elementFromPoint(place.left + place.width / 2, place.top + place.height / 2);
        return !(hit && button.contains(hit));
      })
      .map((button) => button.textContent || button.getAttribute("aria-label"));
    return { width: Math.round(field.width), hidden, covered };
  }, search);

describe("the head's search is its symbol on every width", () => {
  for (const width of [1024, 1440])
    test(`at ${width}px it opens over its place when pressed, keeps its words in the row, and folds back when empty`, async () => {
      await withPage(width, "path", true, async (page) => {
        const field = page.locator(`${search} > input`);
        expect((await boxOf(page, search))?.width).toBe(36);
        // the folded symbol names itself under the pointer (its box, which the field covers)
        expect(await page.locator(search).getAttribute("title")).toBe("Suchen");
        // pressed: a short overlay that grows to the left over its place, whole in sight; nothing beside it moves or folds
        const neighbours = () =>
          Promise.all([
            boxOf(page, '.k2-pane > [data-slot="head"] .k2-bar-end > .k2-btn:nth-of-type(1)'),
            boxOf(page, '.k2-pane > [data-slot="head"] .k2-bar-end > .k2-btn:nth-of-type(3)'),
            boxOf(page, filter),
          ]);
        const before = await neighbours();
        await field.click();
        await settled(page);
        expect((await sightOf(page)).width).toBe(184);
        expect((await sightOf(page)).hidden).toEqual([]);
        expect(await neighbours()).toEqual(before);
        await field.fill("Angebot");
        await settled(page);
        expect(await neighbours()).toEqual(before);
        // left with its words: it takes its width in the row, whole in sight, and every control beside it too
        await page.keyboard.press("Tab");
        await settled(page);
        expect(await sightOf(page)).toEqual({ width: 184, hidden: [], covered: [] });
        // emptied, it folds back to its symbol
        await field.fill("");
        await page.keyboard.press("Tab");
        await settled(page);
        expect((await boxOf(page, search))?.width).toBe(36);
      });
    });

  test("Escape leaves it on the desktop and keeps its words, unless the app takes Escape", async () => {
    await withPage(1440, "path", true, async (page) => {
      const field = page.locator(`${search} > input`);
      await field.click();
      await field.fill("Angebot");
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await field.evaluate((input) => document.activeElement === input)).toBe(false);
      expect(await field.inputValue()).toBe("Angebot");
      expect(await sightOf(page)).toEqual({ width: 184, hidden: [], covered: [] });
      // empty, Escape folds it back to its symbol
      await field.click();
      await field.fill("");
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await field.evaluate((input) => document.activeElement === input)).toBe(false);
      expect((await boxOf(page, search))?.width).toBe(36);
    });
  });

  test('"/" opens it where nobody types', async () => {
    await withPage(1440, "path", true, async (page) => {
      await page.locator("body").click({ position: { x: 600, y: 500 } });
      await page.keyboard.press("/");
      expect(await page.evaluate(() => document.activeElement?.closest(".k2-input[data-search]") !== null)).toBe(true);
      expect((await sightOf(page)).width).toBe(184);
    });
  });

  test('"/" counts with AltGr, not while a key composes or a menu stands open', async () => {
    await withPage(1440, "path", true, async (page) => {
      const slash = (init: { ctrlKey?: boolean; altKey?: boolean; modifierAltGraph?: boolean }, from?: string, keyCode?: number) =>
        page.evaluate(
          ({ init, from, keyCode }) => {
            (document.activeElement as HTMLElement | null)?.blur();
            const target = from ? document.querySelector<HTMLElement>(from)! : document.body;
            if (from) {
              target.setAttribute("aria-expanded", "true");
              target.focus();
            }
            const event = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true, ...init });
            if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: keyCode });
            target.dispatchEvent(event);
            const opened = document.activeElement?.closest(".k2-input[data-search]") !== null;
            if (from) target.removeAttribute("aria-expanded");
            return opened;
          },
          { init, from, keyCode },
        );
      // AltGr is Ctrl+Alt on Windows (German: AltGr+7 is "{", but other layouts type "/" with it)
      expect(await slash({ ctrlKey: true, altKey: true, modifierAltGraph: true })).toBe(true);
      expect(await slash({ ctrlKey: true, altKey: true })).toBe(false);
      // an IME composes
      expect(await slash({}, undefined, 229)).toBe(false);
      // a control whose menu stands open keeps its keys
      expect(await slash({}, '.k2-pane > [data-slot="head"] .k2-bar-end > .k2-btn:nth-of-type(1)')).toBe(false);
      expect(await slash({})).toBe(true);
    });
  });

  for (const live of [false, true])
    test(`words from the address keep it open on the server's page alone and after it (${live ? "hydrated" : "server"})`, async () => {
      await withPage(1440, "filled", live, async (page) => {
        expect(await sightOf(page)).toEqual({ width: 184, hidden: [], covered: [] });
        expect(await page.locator(`${search} > input`).inputValue()).toBe("Angebot");
        if (!live) return;
        // a caller that empties the field itself: it folds once the focus leaves
        await page.locator(`${search} > input`).focus();
        await page.evaluate(() => {
          (document.querySelector(".k2-input[data-search] > input") as HTMLInputElement).value = "";
        });
        await page.keyboard.press("Tab");
        expect((await boxOf(page, search))?.width).toBe(36);
      });
    });

  test("a search with more at its end (a filter, as Mail's) keeps its field from 768 px", async () => {
    await withPage(1440, "withEnd", true, async (page) => {
      expect((await boxOf(page, search))?.width).toBe(184);
      expect(await page.getByRole("button", { name: "Filter der Suche" }).isVisible()).toBe(true);
    });
  });

  for (const live of [false, true])
    test(`a search inside its end is no head search (${live ? "hydrated" : "server"})`, async () => {
      await withPage(1440, "nested", live, async (page) => {
        const marks = () =>
          page.evaluate((search) => {
            const [own, nested] = [...document.querySelectorAll(search)];
            const of = (box: Element | undefined) =>
              box ? [box.hasAttribute("data-head-search"), box.getAttribute("title"), box.hasAttribute("data-filled")] : null;
            return { own: of(own), nested: of(nested) };
          }, search);
        expect(await marks()).toEqual({ own: [true, "Suchen", false], nested: [false, null, false] });
        if (!live) return;
        // its keys are its own: typing fills only it, and Escape is the browser's (it clears the words), the focus stays
        const inner = page.getByRole("searchbox", { name: "Im Filter suchen" });
        await inner.focus();
        await page.keyboard.type("Rechnung");
        expect(await marks()).toEqual({ own: [true, "Suchen", false], nested: [false, null, false] });
        await page.keyboard.press("Escape");
        await settled(page);
        expect(await inner.evaluate((input) => document.activeElement === input)).toBe(true);
      });
    });
});

// The case DR's #4470 moves into the pane's first row: shared here so both pull requests check the same page.
describe("a workspace head of actions only above a pane's toolbar", () => {
  for (const width of [390, 1024, 1440])
    test(`keeps the page whole at ${width}px`, async () => {
      await withPage(width, "workspace", true, async (page) => {
        expect(await page.locator(".k2-status-lead").isVisible()).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width > 390) expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
      });
    });
});

describe("a row of one line keeps its height beside its deed", () => {
  test("on the desktop the time stands before the deed, in the same line as every row's", async () => {
    await withPage(1440, "rows", true, async (page) => {
      const rows = await page.locator(".k2-list > .k2-row").evaluateAll((elements) =>
        elements.map((row) => {
          const box = (selector: string) => row.querySelector(selector)?.getBoundingClientRect() ?? null;
          const time = box(".k2-row-time");
          const deed = box(".k2-row-end");
          return { height: Math.round(row.getBoundingClientRect().height), time, deed };
        }),
      );
      // every row as tall as a row with its time alone (the third: a time, no deed)
      expect(rows.map((row) => row.height)).toEqual(rows.map(() => rows[2]!.height));
      const both = rows[0]!;
      expect(both.time!.right).toBeLessThanOrEqual(both.deed!.left);
      expect(Math.abs(both.time!.top + both.time!.height / 2 - (both.deed!.top + both.deed!.height / 2))).toBeLessThan(4);
      expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
    });
  });
  test("on the phone the deed takes the row under the text, never over the time", async () => {
    await withPage(390, "rows", true, async (page) => {
      const row = page.locator(".k2-list > .k2-row").first();
      const time = (await row.locator(".k2-row-time").boundingBox())!;
      const deed = (await row.locator(".k2-row-end").boundingBox())!;
      expect(deed.y).toBeGreaterThanOrEqual(time.y + time.height - 1);
    });
  });
});
