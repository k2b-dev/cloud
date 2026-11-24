import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { MAIL_V2_NOW } from "./mail-v2.browser-clock";

// Mail's mailbox on the @k2b/ui v2 pilot: the real island and controller with the mockup's data. The boxes of its
// parts are the numbers measured in the approved mockup (mail.html, the same frame as the Fibel screen tests), and
// the behaviour is v1's: rows open in place, Escape returns to the row, a live mail keeps the focus and the scroll.
setSystemTime(new Date(MAIL_V2_NOW));
const { startMailV2Server, MAIL_V2_PATH } = await import("./mail-v2.browser-server");

const mockup: Record<number, Record<string, [selector: string, box: string]>> = {
  1440: {
    head: ['.k2-ws-main > [data-slot="head"] > .k2-bar', "250,1 1125x56"],
    status: ['[data-k2-part="StatusRow"]', "250,57 432x52"],
    row: ['[data-k2-part="List"] > [data-k2-part="Row"]', "250,109 432x73"],
    readerHead: ['[data-k2-part="Pane"][data-detail] > [data-slot="head"] > .k2-bar', "683,57 692x52"],
    notice: ['[data-k2-part="Notice"][data-tone="ai"]', "683,149 692x85"],
    listGrip: ['[data-k2-part="Pane.Split"] .k2-grip', "677,460 11x20"],
  },
  390: {
    head: ['.k2-ws-main > [data-slot="head"] > .k2-bar', "0,0 390x44"],
    status: ['[data-k2-part="StatusRow"]', "0,44 390x52"],
    row: ['[data-k2-part="List"] > [data-k2-part="Row"]', "0,96 390x73"],
  },
};

/** Pins only the page's Date to the server's frozen instant, so SSR and hydration name the same day (timers run). */
const pinPageClock = (at: number) => {
  const RealDate = Date;
  const offset = at - RealDate.now(); // real clock: the page's distance to the pinned instant
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0)
        super(RealDate.now() + offset); // real clock: flows from the pinned instant
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now() {
      return RealDate.now() + offset; // real clock: flows from the pinned instant
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
};

let server: Awaited<ReturnType<typeof startMailV2Server>>;
let browser: Browser;
beforeAll(async () => {
  server = await startMailV2Server({ now: () => Date.parse(MAIL_V2_NOW) });
  browser = await launchBrowser();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

/** The errors each page threw from its start; `pageErrors` collects only from the call on, so `open` keeps its list. */
const errorsOf = new WeakMap<Page, string[]>();
const open = async (path: string, width = 1440, height = width < 768 ? 844 : 900): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height } });
  errorsOf.set(page, pageErrors(page));
  await page.addInitScript(pinPageClock, Date.parse(MAIL_V2_NOW));
  await page.goto(`${server.url}${path}`);
  await page.waitForFunction(() => document.documentElement.dataset.mailV2Ready === "true", undefined, { timeout: 30_000 });
  return page;
};
/** A conversation of the list (the reader's message heads are rows too). */
const row = (page: Page, sender: string) => page.locator('[data-k2-part="List"] > [data-k2-part="Row"]', { hasText: sender });
/** The row's own link that opens its conversation; it takes the focus. */
const rowLink = (page: Page, sender: string) => row(page, sender).locator(":scope > a[href]");
/** The text of the row that holds the focus. */
const focusedRow = (page: Page) => page.evaluate(() => document.activeElement?.closest('[data-k2-part="Row"]')?.textContent ?? "");

describe("Mail on the v2 pilot", () => {
  for (const [width, path] of [
    [1440, `${MAIL_V2_PATH}?conversation=Demo01`],
    [390, MAIL_V2_PATH],
  ] as const)
    test(`keeps the mockup at ${width} px`, async () => {
      const page = await open(path, width);
      try {
        expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
        const boxes = await page.evaluate((parts) => {
          const ws = document.querySelector("[data-k2-workspace]")!.getBoundingClientRect();
          return Object.fromEntries(
            Object.entries(parts).map(([part, [selector]]) => {
              const box = document.querySelector(selector)?.getBoundingClientRect();
              return [part, box ? `${box.left - ws.left},${box.top - ws.top} ${box.width}x${box.height}` : "missing"];
            }),
          );
        }, mockup[width]!);
        expect(boxes).toEqual(Object.fromEntries(Object.entries(mockup[width]!).map(([part, [, box]]) => [part, box])));
        expect(errorsOf.get(page)).toEqual([]);
      } finally {
        await page.close();
      }
    }, 60_000);

  test("a row opens its conversation in place, and Escape returns to the row", async () => {
    const page = await open(MAIL_V2_PATH);
    try {
      await page.evaluate(() => Object.assign(window, { stayed: true }));
      await row(page, "Holzwerk Brandt").click();
      await page.waitForURL(/conversation=Demo01/);
      await page.locator('[data-k2-part="Pane"][data-detail]').getByText("Angebot Eichenplatten – Liefertermin").first().waitFor();
      expect(await page.evaluate(() => "stayed" in window)).toBe(true);
      expect(await row(page, "Holzwerk Brandt").getAttribute("aria-current")).toBe("true");
      await page.locator("body").press("Escape");
      await page.waitForURL((url) => !url.searchParams.has("conversation"));
      expect(await page.locator('[data-k2-part="Pane"][data-detail]').count()).toBe(0);
      expect(await focusedRow(page)).toContain("Holzwerk Brandt");
      expect(await page.evaluate(() => "stayed" in window)).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("the keyboard opens a row: Tab reaches it, Enter opens it in place", async () => {
    const page = await open(MAIL_V2_PATH);
    try {
      await rowLink(page, "Jonas Hartwig").focus();
      await page.keyboard.press("Enter");
      await page.waitForURL(/conversation=Demo02/);
      expect(await row(page, "Jonas Hartwig").getAttribute("aria-current")).toBe("true");
    } finally {
      await page.close();
    }
  }, 60_000);

  // As in v1's mail shell: each mailbox's list keeps its own place in history (the list's `scrollKey`), in place.
  test("back and forward bring each mailbox's list back where it was", async () => {
    const page = await open(MAIL_V2_PATH, 1440, 560);
    try {
      await page.evaluate(() => Object.assign(window, { stayed: true }));
      const list = page.locator('[data-k2-part="Pane"]:not([data-detail]) > .k2-scroll');
      const position = () => list.evaluate((element) => element.scrollTop);
      const scrollTo = async (y: number) => {
        await list.evaluate((element, y) => {
          element.scrollTop = y;
        }, y);
        await settled(page);
        expect(await position(), "the list really scrolls").toBe(y);
      };
      await scrollTo(120);
      await page.locator('[data-k2-part="Nav.Item"][href="/app/mail/Box002"]').click();
      await page.waitForURL(/\/app\/mail\/Box002$/);
      await settled(page);
      expect(await position(), "another mailbox starts at its list's top").toBe(0);
      await scrollTo(60);
      await page.goBack();
      await page.waitForURL(/\/app\/mail\/Box001$/);
      await settled(page);
      expect(await position(), "Back restores the first mailbox's place").toBe(120);
      await page.goForward();
      await page.waitForURL(/\/app\/mail\/Box002$/);
      await settled(page);
      expect(await position(), "Forward restores the second mailbox's place").toBe(60);
      expect(await page.evaluate(() => "stayed" in window)).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("on the phone the reader's way back names the list and returns to its row", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`, 390);
    try {
      // The way back is named by the list's title, which the server sends.
      const back = page.locator('[data-k2-part="Pane"][data-detail]').getByRole("link", { name: "Posteingang", exact: true });
      await back.waitFor();
      await back.click();
      await page.waitForURL((url) => !url.searchParams.has("conversation"));
      await row(page, "Holzwerk Brandt").waitFor();
      expect(await focusedRow(page)).toContain("Holzwerk Brandt");
    } finally {
      await page.close();
    }
  }, 60_000);

  test("the reply rests as the mockup's composer and starts Mail's reply box on a click", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`);
    try {
      const composer = page.locator('[data-k2-part="Composer"]');
      await composer.waitFor();
      expect(await composer.textContent()).toContain("Holzwerk Brandt");
      await composer.locator(".k2-composer-start").click();
      await page.locator('[data-k2-part="Canvas"] [data-mail-reply-box-frame]').waitFor();
      // Mail's own composer writes there: its editor takes text.
      await page.locator('[data-k2-part="Canvas"] [contenteditable="true"]').first().waitFor();
      expect(await composer.count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);

  // As in v1: a list scrolled down holds the focused row in place; at the very top the new mail shows above.
  test("a live mail keeps the focused row focused and a scrolled list where it was", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`, 1440, 560);
    try {
      const list = page.locator('[data-k2-part="Pane"]:not([data-detail]) > .k2-scroll');
      await list.evaluate((element) => {
        element.scrollTop = 120;
      });
      expect(await list.evaluate((element) => element.scrollTop)).toBe(120);
      await rowLink(page, "Lackfabrik Nordhaus").focus();
      await settled(page);
      const before = await row(page, "Lackfabrik Nordhaus").boundingBox();
      server.arrive();
      await row(page, "Neue Sendung 1").waitFor();
      await settled(page);
      expect(await focusedRow(page)).toContain("Lackfabrik Nordhaus");
      // The new row above pushes nothing out of place: the focused row stays where the person looks.
      const after = await row(page, "Lackfabrik Nordhaus").boundingBox();
      expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  }, 60_000);
});

// The live states the mockup has no picture of: each measured on its own, so a double line, a line inside one thing
// or a lost edge shows in the state where it appears (Valentin's findings of 23.11. passed the screens above).
describe("Mail on the v2 pilot in its live states", () => {
  /** The lines inside each message: a message's text, attachments and head are one band, closed by its own line. */
  const linesInsideMessages = (page: Page) =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-k2-part="Pane"][data-detail] [data-k2-part="Band"]')).flatMap((band) =>
        Array.from(band.querySelectorAll("*"))
          .filter((element) => !element.parentElement?.closest("[data-k2-canvas]"))
          .filter((element) => {
            const style = getComputedStyle(element);
            const framed = ["Top", "Right", "Bottom", "Left"].filter(
              (side) => Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0,
            );
            // A divider is one side alone; a framed or rounded box (a tile, a button) is no line.
            return framed.length === 1 && Number.parseFloat(style.borderRadius) === 0;
          })
          .map((element) => `${element.getAttribute("data-k2-part") ?? element.tagName.toLowerCase()} in a message`),
      ),
    );

  test("a thread of several messages: one line between two messages, none above the attachments", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`, 1440, 2200);
    try {
      await settled(page);
      expect(await page.locator('[data-k2-part="Pane"][data-detail] [data-k2-part="Band"] [data-k2-part="Tiles"]').count()).toBe(1);
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
      expect(await linesInsideMessages(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("the open composer keeps the place of the resting one and draws no second line", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`, 1440, 2200);
    try {
      const resting = await page.locator('[data-k2-part="Composer"]').boundingBox();
      await page.locator(".k2-composer-start").click();
      await page.locator('[data-k2-part="Canvas"] [contenteditable="true"]').first().waitFor();
      await settled(page);
      const open = await page.locator('[data-k2-part="Canvas"] [data-mail-reply-box-frame]').boundingBox();
      // 8 px from the column's edges and 12 px below the summary, like the resting frame.
      expect({ left: open?.x, top: open?.y, width: open?.width }).toEqual({ left: resting?.x, top: resting?.y, width: resting?.width });
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
      expect(await linesInsideMessages(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  const selectionKeepsLayout = async (width: number) => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`, width);
    try {
      await page.locator('[data-k2-part="StatusRow"]').getByRole("checkbox").click();
      await page.locator('[data-k2-part="StatusRow"][data-selecting]').waitFor();
      await settled(page);
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
    } finally {
      await page.close();
    }
  };
  test("selection mode in the list at 1280 px keeps the v2 layout", () => selectionKeepsLayout(1280), 60_000);
  // The same 1024 px gap as below: the measure now names it ("Neue Nachricht" cut in the head's Bar).
  test.failing("selection mode in the list at 1024 px keeps the v2 layout", () => selectionKeepsLayout(1024), 60_000);

  /**
   * What a narrow place cuts: a button or tab past the edge of its column, and a first line of a list row that wraps
   * instead of ending in "…". Neither is a line or a type role, so the layout measure does not see them.
   */
  const cutOff = (page: Page) =>
    page.evaluate(() => {
      const found: string[] = [];
      for (const control of Array.from(document.querySelectorAll('[data-k2-workspace] :is([data-k2-part="Button"], .k2-tab)'))) {
        const column = control.closest("[data-k2-column]")?.getBoundingClientRect();
        const box = control.getBoundingClientRect();
        if (column && box.width > 0 && (box.right > column.right + 0.5 || box.left < column.left - 0.5))
          found.push(`${control.getAttribute("aria-label") ?? control.textContent?.trim()} runs past its column`);
      }
      for (const line of Array.from(document.querySelectorAll('[data-k2-part="List"] > [data-k2-part="Row"] > .k2-row-l1')))
        if (line.getBoundingClientRect().height > 20.5) found.push(`"${line.textContent?.trim()}" wraps in its row`);
      return found;
    });
  const cutAt = async (width: number, select: boolean) => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`, width);
    try {
      if (select) {
        await page.locator('[data-k2-part="StatusRow"]').getByRole("checkbox").click();
        await page.locator('[data-k2-part="StatusRow"][data-selecting]').waitFor();
      }
      await settled(page);
      return await cutOff(page);
    } finally {
      await page.close();
    }
  };

  test("at 1440 px nothing is cut: every control within its column, every row's first line on one line", async () => {
    expect(await cutAt(1440, false)).toEqual([]);
  }, 60_000);

  // The StatusRow turns its selection's actions into icons, then "…", by the column's width (#4077).
  test("with a selection the selection's actions fit the list column", async () => {
    expect(await cutAt(1440, true)).toEqual([]);
  }, 60_000);

  // Known gap of the primitives (lane C, 23.11.); it turns red once the primitives handle it: then make it a plain
  // test. Bar and Row at 1024 px: the head's end runs past the card, and a row's first line wraps instead of "…".
  test.failing("at 1024 px nothing is cut (Bar and Row gaps)", async () => {
    expect(await cutAt(1024, false)).toEqual([]);
  }, 60_000);
});
