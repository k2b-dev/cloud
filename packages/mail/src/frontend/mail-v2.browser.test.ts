import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { measureV2Layout } from "../../../ui/test/measure-v2-layout";
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

const open = async (path: string, width = 1440, height = width < 768 ? 844 : 900): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height } });
  pageErrors(page);
  await page.addInitScript(pinPageClock, Date.parse(MAIL_V2_NOW));
  await page.goto(`${server.url}${path}`);
  await page.waitForFunction(() => document.documentElement.dataset.mailV2Ready === "true", undefined, { timeout: 30_000 });
  return page;
};
/** A conversation of the list (the reader's message heads are rows too). */
const row = (page: Page, sender: string) => page.locator('[data-k2-part="List"] > [data-k2-part="Row"]', { hasText: sender });

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
        expect(pageErrors(page)).toEqual([]);
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
      expect(await page.evaluate(() => document.activeElement?.textContent ?? "")).toContain("Holzwerk Brandt");
      expect(await page.evaluate(() => "stayed" in window)).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("the keyboard opens a row: Tab reaches it, Enter opens it in place", async () => {
    const page = await open(MAIL_V2_PATH);
    try {
      await row(page, "Jonas Hartwig").focus();
      await page.keyboard.press("Enter");
      await page.waitForURL(/conversation=Demo02/);
      expect(await row(page, "Jonas Hartwig").getAttribute("aria-current")).toBe("true");
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
      await row(page, "Lackfabrik Nordhaus").focus();
      await settled(page);
      const before = await row(page, "Lackfabrik Nordhaus").boundingBox();
      server.arrive();
      await row(page, "Neue Sendung 1").waitFor();
      await settled(page);
      expect(await page.evaluate(() => document.activeElement?.textContent ?? "")).toContain("Lackfabrik Nordhaus");
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

  for (const width of [1280, 1024])
    test(`selection mode in the list at ${width} px keeps the v2 layout`, async () => {
      const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`, width);
      try {
        await page.locator('[data-k2-part="StatusRow"]').getByRole("checkbox").click();
        await page.locator('[data-k2-part="StatusRow"][data-selecting]').waitFor();
        await settled(page);
        expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
      } finally {
        await page.close();
      }
    }, 60_000);

  // Known gap of StatusRow (lane C, 23.11.): in a narrow list column the selection's actions run past its edge;
  // they should turn into icons, then "…", by the column's width. This case turns red once the primitive does it:
  // then make it a plain test.
  test.failing("the selection's actions fit a narrow list column (StatusRow gap)", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`, 1024);
    try {
      await page.locator('[data-k2-part="StatusRow"]').getByRole("checkbox").click();
      await page.locator('[data-k2-part="StatusRow"][data-selecting]').waitFor();
      await settled(page);
      const overflow = await page.evaluate(() => {
        const bar = document.querySelector('[data-k2-part="StatusRow"]')!.getBoundingClientRect();
        return Array.from(document.querySelectorAll('[data-k2-part="StatusRow"] [data-k2-part="Button"]'))
          .map((button) => button.getBoundingClientRect())
          .filter((box) => box.right > bar.right + 0.5 || box.left < bar.left - 0.5).length;
      });
      expect(overflow).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);
});
