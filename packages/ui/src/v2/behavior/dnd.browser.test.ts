// Contract test for v2 drag and drop on @ui-sdk/core through our Solid 1 adapter (ported from the spike's test/dnd.ts
// and test/transfer.ts): a sortable list whose rows move live while dragging, drag onto a target, and drag between
// lists; mouse, keyboard, touch. Runs in Chromium and in WebKit (TEST_BROWSER=webkit).
//
// Known Playwright-WebKit limits, noted on each test they affect instead of hidden:
// - WEBKIT_HELD: Playwright's WebKit (Linux, Docker) renders no frame while a mouse button is held (the spike measured
//   18 frames per 300 ms at rest, 0 while held), so rows cannot move live during a mouse drag there. The drop still
//   lands right; those checks run in WebKit too. Real Safari and iPhone are unchecked (a manual check is planned).
// - WEBKIT_TOUCH: touch is driven through Chromium's CDP; Playwright's WebKit has no touch input here.
// - Every pointer scenario opens a fresh page: in Playwright's WebKit the pointerup of a mouse drag right after a drop
//   is lost, so that second drag never ends.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, launchHookMs, pageErrors, settled } from "../../../test/browser";
import { contractCss, demoBundle, heard, openDemo, serverMarkup } from "../../../test/v2-behavior/harness";

const webkit = browserName === "webkit";
let browser: Browser;
let board: string;
let transfer: string;
let css: string;
let boardMarkup: string;
let transferMarkup: string;
beforeAll(async () => {
  [board, transfer, css, boardMarkup, transferMarkup] = await Promise.all([
    demoBundle("board"),
    demoBundle("transfer"),
    contractCss(),
    serverMarkup("board"),
    serverMarkup("transfer"),
  ]);
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (bundle: "board" | "transfer", run: (page: Page) => Promise<void>, touch = false) => {
  const page = await openDemo(browser, bundle === "board" ? board : transfer, css, {
    markup: bundle === "board" ? boardMarkup : transferMarkup,
    touch,
  });
  const errors = pageErrors(page);
  try {
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

type Point = { x: number; y: number };
// The dragged copy is a clone of the item; it is not part of the order.
const folderOrder = (page: Page) =>
  page.$$eval(".sortable__item:not([data-drag-preview]) [data-drop-target]", (items) =>
    items.map((item) => (item as HTMLElement).dataset.dropTarget),
  );
const mailIds = (page: Page) =>
  page.$$eval("[data-mail]:not([data-drag-preview])", (rows) => rows.map((row) => (row as HTMLElement).dataset.mail));
const lists = (page: Page) =>
  page.$$eval("[data-list]", (els) =>
    Object.fromEntries(
      els.map((el) => [
        (el as HTMLElement).dataset.list,
        [...el.querySelectorAll<HTMLElement>("[data-item]:not([data-drag-preview])")].map((item) => item.dataset.item),
      ]),
    ),
  );
const center = async (page: Page, selector: string): Promise<Point> => {
  await settled(page);
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
// Past the middle of an item: a sortable list places the moving item after an item once the pointer passes its middle.
const below = async (page: Page, selector: string): Promise<Point> => {
  const point = await center(page, selector);
  return { x: point.x, y: point.y + 10 };
};
const press = async (page: Page, from: Point, to: Point) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step++)
    await page.mouse.move(from.x + ((to.x - from.x) * step) / 12, from.y + ((to.y - from.y) * step) / 12);
};
const until = (page: Page, condition: string, arg?: unknown) =>
  page.waitForFunction(condition, arg).then(
    () => true,
    () => false,
  );
const folderAt = (index: number, id: string | undefined) =>
  `[...document.querySelectorAll(".sortable__item:not([data-drag-preview]) [data-drop-target]")][${index}]?.dataset.dropTarget === ${JSON.stringify(id)}`;
const touchOf = async (page: Page) => {
  const cdp = await page.context().newCDPSession(page);
  return (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
};

test("server markup: the sortable list is a listbox with one tab stop; the board has three listboxes", () => {
  const list = boardMarkup.slice(boardMarkup.indexOf('role="listbox"'));
  expect(list).toContain('role="option"');
  expect((boardMarkup.match(/tabindex="0"/g) ?? []).length).toBe(1);
  expect((transferMarkup.match(/role="listbox"/g) ?? []).length).toBe(3);
  expect((transferMarkup.match(/role="option"/g) ?? []).length).toBe(6);
  expect((transferMarkup.match(/tabindex="0"/g) ?? []).length).toBe(1);
});

test("mouse sort: the drop moves the folder and removes the dragged copy", async () => {
  await withPage("board", async (page) => {
    const before = await folderOrder(page);
    await press(page, await center(page, ".sortable__item >> nth=0"), await below(page, ".sortable__item >> nth=2"));
    expect(await page.locator("[data-drag-preview]").count()).toBe(1);
    await page.mouse.up();
    expect(await until(page, folderAt(2, before[0]))).toBe(true);
    expect((await folderOrder(page)).length).toBe(before.length);
    expect(await until(page, '!document.querySelector("[data-drag-preview]")')).toBe(true);
  });
});

// WEBKIT_HELD: no frame renders while the button is held in Playwright's WebKit.
test.skipIf(webkit)("mouse sort: rows move live while the button is held [skipped in WebKit: WEBKIT_HELD]", async () => {
  await withPage("board", async (page) => {
    const before = await folderOrder(page);
    await press(page, await center(page, ".sortable__item >> nth=0"), await below(page, ".sortable__item >> nth=2"));
    expect(await until(page, folderAt(2, before[0]))).toBe(true);
    await page.mouse.up();
  });
});

test("keyboard sort: Space lifts, arrows move the row live, Space drops, focus stays; Escape cancels", async () => {
  await withPage("board", async (page) => {
    await page.locator(".sortable__item").first().focus();
    const lifted = (await folderOrder(page))[0];
    await page.keyboard.press("Space");
    expect(await heard(page, "aufgenommen")).toBe(true);
    await page.keyboard.press("ArrowDown");
    expect(await until(page, folderAt(1, lifted))).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");
    expect(await until(page, folderAt(2, lifted))).toBe(true);
    expect(await heard(page, "abgelegt")).toBe(true);
    expect(
      await page.evaluate(
        (id) => document.activeElement?.querySelector("[data-drop-target]")?.getAttribute("data-drop-target") === id,
        lifted,
      ),
    ).toBe(true);
    const beforeEscape = await folderOrder(page);
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Escape");
    expect(await heard(page, "Abgebrochen")).toBe(true);
    expect(await folderOrder(page)).toEqual(beforeEscape);
  });
});

test("drag onto: the mouse drop moves the mail into the folder and announces it", async () => {
  await withPage("board", async (page) => {
    const mails = await mailIds(page);
    await press(page, await center(page, "[data-mail] >> nth=0"), await center(page, '[data-drop-target="archive"]'));
    await page.mouse.up();
    expect(await until(page, `!document.querySelector('[data-mail="${mails[0]}"]')`)).toBe(true);
    expect((await page.locator('[data-drop-target="archive"]').textContent()) ?? "").toContain("1");
    expect(await heard(page, "verschoben nach Archiv")).toBe(true);
  });
});

// WEBKIT_HELD: the mark and the status line update during the held drag, which renders no frame in Playwright's WebKit.
test.skipIf(webkit)(
  "drag onto: the target under the pointer is marked and named while dragging [skipped in WebKit: WEBKIT_HELD]",
  async () => {
    await withPage("board", async (page) => {
      await press(page, await center(page, "[data-mail] >> nth=0"), await center(page, '[data-drop-target="archive"]'));
      expect(await until(page, `document.querySelectorAll('[data-drop-target="archive"][data-over]').length === 1`)).toBe(true);
      expect((await page.getByTestId("board-status").textContent()) ?? "").toContain("nach Archiv");
      await page.mouse.up();
    });
  },
);

test("Escape during a pointer drag cancels it: sorting, drag onto and between lists change nothing", async () => {
  await withPage("board", async (page) => {
    const folders = await folderOrder(page);
    await press(page, await center(page, ".sortable__item >> nth=0"), await below(page, ".sortable__item >> nth=2"));
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect(await until(page, '!document.querySelector("[data-drag-preview]")')).toBe(true);
    expect(await folderOrder(page)).toEqual(folders);
  });
  await withPage("board", async (page) => {
    const mails = await mailIds(page);
    await press(page, await center(page, "[data-mail] >> nth=0"), await center(page, '[data-drop-target="archive"]'));
    await page.keyboard.press("Escape");
    expect(await heard(page, "Abgebrochen")).toBe(true);
    await page.mouse.up();
    expect(await mailIds(page)).toEqual(mails);
    expect(await page.locator("[data-drop-target][data-over]").count()).toBe(0);
  });
  await withPage("transfer", async (page) => {
    const before = await lists(page);
    const to = await center(page, '[data-item="t4"]');
    await press(page, await center(page, '[data-item="t1"]'), { x: to.x, y: to.y + 10 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect(await until(page, '!document.querySelector("[data-drag-preview]")')).toBe(true);
    expect(await lists(page)).toEqual(before);
  });
});

test("drag onto: releasing outside every target changes nothing", async () => {
  await withPage("board", async (page) => {
    const before = await mailIds(page);
    await press(page, await center(page, "[data-mail] >> nth=0"), { x: 900, y: 800 });
    await page.mouse.up();
    expect(await heard(page, "Abgebrochen")).toBe(true);
    expect(await mailIds(page)).toEqual(before);
  });
});

test("drag onto with the keyboard: Space lifts, arrows choose the target, Enter drops, focus moves on; Escape cancels", async () => {
  await withPage("board", async (page) => {
    const second = (await folderOrder(page))[1];
    const moved = (await mailIds(page))[0];
    await page.locator("[data-mail] .handle").first().focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowDown");
    expect(
      await until(page, `document.querySelector("[data-drop-target][data-over]")?.dataset.dropTarget === ${JSON.stringify(second)}`),
    ).toBe(true);
    expect(await page.locator("[data-drop-target][data-over]").count()).toBe(1);
    await page.keyboard.press("Enter");
    expect(await until(page, `!document.querySelector('[data-mail="${moved}"]')`)).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.classList.contains("handle") ?? false)).toBe(true);
    const ids = await mailIds(page);
    await page.locator("[data-mail] .handle").first().focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("Escape");
    expect(await heard(page, "Abgebrochen")).toBe(true);
    expect(await mailIds(page)).toEqual(ids);
  });
});

// WEBKIT_TOUCH: touch input exists only through Chromium's CDP here.
test.skipIf(webkit)(
  "touch: a swipe scrolls, a hold then a move drags onto a folder; folders sort live [skipped in WebKit: WEBKIT_TOUCH]",
  async () => {
    await withPage(
      "board",
      async (page) => {
        const touch = await touchOf(page);
        const ids = await mailIds(page);
        const from = await center(page, "[data-mail] >> nth=0");
        const to = await center(page, '[data-drop-target="invoices"]');
        await touch("touchStart", from.x, from.y);
        for (let step = 1; step <= 6; step++) await touch("touchMove", from.x, from.y - step * 12);
        await touch("touchEnd", from.x, from.y - 72);
        expect(await mailIds(page)).toEqual(ids);
        await touch("touchStart", from.x, from.y);
        // fixed wait: the hold that lifts the item is a duration (400 ms) by design.
        await page.waitForTimeout(550);
        for (let step = 1; step <= 12; step++)
          await touch("touchMove", from.x + ((to.x - from.x) * step) / 12, from.y + ((to.y - from.y) * step) / 12);
        expect(await until(page, `document.querySelectorAll('[data-drop-target="invoices"][data-over]').length === 1`)).toBe(true);
        await touch("touchEnd", to.x, to.y);
        expect(await until(page, `!document.querySelector('[data-mail="${ids[0]}"]')`)).toBe(true);
        const order = await folderOrder(page);
        const a = await center(page, ".sortable__item >> nth=0");
        const b = await below(page, ".sortable__item >> nth=2");
        await touch("touchStart", a.x, a.y);
        for (let step = 1; step <= 12; step++) await touch("touchMove", a.x, a.y + ((b.y - a.y) * step) / 12);
        expect(await until(page, folderAt(2, order[0]))).toBe(true);
        await touch("touchEnd", b.x, b.y);
        expect(await until(page, folderAt(2, order[0]))).toBe(true);
      },
      true,
    );
  },
);

test("between lists with the mouse: the drop commits the move into the other list", async () => {
  await withPage("transfer", async (page) => {
    const to = await center(page, '[data-item="t4"]');
    await press(page, await center(page, '[data-item="t1"]'), { x: to.x, y: to.y + 10 });
    await page.mouse.up();
    expect(
      await until(page, `document.querySelector('[data-list="later"] [data-item="t1"]') && !document.querySelector("[data-drag-preview]")`),
    ).toBe(true);
    expect(await lists(page)).toEqual({ today: ["t2", "t3"], later: ["t4", "t1", "t5"], done: ["t6"] });
  });
});

// WEBKIT_HELD: the item crosses into the other list during the held drag.
test.skipIf(webkit)("between lists with the mouse: the item moves into the other list live [skipped in WebKit: WEBKIT_HELD]", async () => {
  await withPage("transfer", async (page) => {
    const to = await center(page, '[data-item="t4"]');
    await press(page, await center(page, '[data-item="t1"]'), { x: to.x, y: to.y + 10 });
    expect(await until(page, `document.querySelector('[data-list="later"] [data-item="t1"]:not([data-drag-preview])')`)).toBe(true);
    expect(await page.locator("[data-drag-preview]").count()).toBe(1);
    await page.mouse.up();
  });
});

test("between lists with the keyboard: Right changes the list live, Space drops, focus stays; Escape restores", async () => {
  await withPage("transfer", async (page) => {
    await page.locator('[data-item="t2"]').focus();
    await page.keyboard.press("Space");
    expect(await heard(page, "aufgenommen")).toBe(true);
    await page.keyboard.press("ArrowRight");
    expect(await until(page, `document.querySelector('[data-list="later"] [data-item="t2"]')`)).toBe(true);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    expect(await until(page, `document.querySelector('[data-list="done"] [data-item="t2"]')`)).toBe(true);
    expect(await heard(page, "abgelegt in Erledigt")).toBe(true);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.item)).toBe("t2");
    const before = await lists(page);
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Escape");
    expect(await until(page, `document.querySelector('[data-list="done"] [data-item="t2"]')`)).toBe(true);
    expect(await lists(page)).toEqual(before);
  });
});

// WEBKIT_TOUCH: touch input exists only through Chromium's CDP here.
test.skipIf(webkit)("between lists by touch: the item moves live and the drop commits it [skipped in WebKit: WEBKIT_TOUCH]", async () => {
  await withPage(
    "transfer",
    async (page) => {
      const touch = await touchOf(page);
      const a = await center(page, '[data-item="t3"]');
      const b = await center(page, '[data-item="t6"]');
      await touch("touchStart", a.x, a.y);
      for (let step = 1; step <= 14; step++)
        await touch("touchMove", a.x + ((b.x - a.x) * step) / 14, a.y + ((b.y + 10 - a.y) * step) / 14);
      expect(await until(page, `document.querySelector('[data-list="done"] [data-item="t3"]:not([data-drag-preview])')`)).toBe(true);
      await touch("touchEnd", b.x, b.y + 10);
      expect(await until(page, `!document.querySelector("[data-drag-preview]")`)).toBe(true);
      expect(await lists(page)).toEqual({ today: ["t1", "t2"], later: ["t4", "t5"], done: ["t6", "t3"] });
    },
    true,
  );
});
