import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type axeCore from "axe-core";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-grips.client";

// Every grip moves its column. Guard for a focusable control without behaviour: the seam and column grips were
// separators in the tab order that did nothing.
// The pane seams (sidebar, a list on the left, an info column on the right) and the table's column grips follow a
// pointer drag and the keys: arrows 8 px, Shift 64 px, Home the minimum, End the most the columns around give, Enter
// the default; aria-valuenow, -min and -max say it in px. Fixture: test/v2-grips.client.tsx in a 1400 px window,
// sidebar 248 | list 360 | reader 488 (keeps 400) | info 300 (299 and its line). Runs in Chromium and in WebKit
// (TEST_BROWSER=webkit); a touch drag only in Chromium (Playwright's WebKit cannot send one).
// WEBKIT_HELD: Playwright's WebKit renders no frame while a mouse button is held, and ui-sdk's bindDrag reports moves
// once per frame, so widths during a drag (and Escape while held) are checked in Chromium only; the release applies the
// last position in both.

declare global {
  interface Window {
    axe?: typeof axeCore;
  }
}

const webkit = browserName === "webkit";
const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const axeSource = readFileSync(Bun.resolveSync("axe-core/axe.min.js", import.meta.dir), "utf8");
const testCss = "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-grips.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>, options: { dir?: "rtl"; touch?: boolean } = {}) => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 }, hasTouch: options.touch });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"${options.dir ? ` dir="${options.dir}"` : ""}><head><meta charset="utf-8"><title>Griffe</title><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const grips = {
  side: '.k2-grip[aria-label="Breite der Ordner"]',
  list: '.k2-grip[aria-label="Liste"]',
  info: '.k2-grip[aria-label="Angaben"]',
  subject: '.k2-cgrip[aria-label="Betreff"]',
};
const columns = {
  side: ".k2-ws-side",
  list: 'section[aria-label="Liste"]',
  reader: 'section[aria-label="Leser"]',
  info: 'section[aria-label="Angaben"]',
  subject: ".k2-table th:nth-child(1)",
  from: ".k2-table th:nth-child(2)",
};
type Name = keyof typeof columns;

/** Waits until the rendered widths of `expected` match (whole px). */
const widths = (page: Page, expected: Partial<Record<Name, number>>) =>
  page
    .waitForFunction(
      ({ selectors, want }) =>
        Object.entries(want).every(
          ([name, px]) =>
            Math.round(document.querySelector(selectors[name as keyof typeof selectors])?.getBoundingClientRect().width ?? -1) === px,
        ),
      { selectors: columns, want: expected },
    )
    .then(
      () => true,
      async () => {
        const seen = await page.evaluate(
          (selectors) =>
            Object.fromEntries(
              Object.entries(selectors).map(([name, s]) => [name, document.querySelector(s)?.getBoundingClientRect().width]),
            ),
          columns,
        );
        throw new Error(`widths ${JSON.stringify(expected)} not reached: ${JSON.stringify(seen)}`);
      },
    );
/** Waits until the grip says `expected`: aria-valuemin, -valuenow, -valuemax and -valuetext. */
const values = (page: Page, grip: string, expected: string[]) =>
  page
    .waitForFunction(
      ({ selector, want }) => {
        const element = document.querySelector(selector);
        const said = ["aria-valuemin", "aria-valuenow", "aria-valuemax", "aria-valuetext"].map((name) => element?.getAttribute(name));
        return JSON.stringify(said) === JSON.stringify(want);
      },
      { selector: grip, want: expected },
    )
    .then(
      () => true,
      async () => {
        const seen = await page.$eval(grip, (element) =>
          ["aria-valuemin", "aria-valuenow", "aria-valuemax", "aria-valuetext"].map((name) => element.getAttribute(name)),
        );
        throw new Error(`${grip}: ${JSON.stringify(expected)} not said: ${JSON.stringify(seen)}`);
      },
    );

const drag = async (page: Page, grip: string, dx: number) => {
  const box = await page.locator(grip).boundingBox();
  if (!box) throw new Error(`no ${grip}`);
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y, { steps: 4 });
};

test("the sidebar grip: keys move it 8 and 64 px, Home and End go to the limits, Enter back; the values follow", async () => {
  await withPage(async (page) => {
    await widths(page, { side: 248, list: 360, reader: 488, info: 299 });
    // the most: the columns keep their minimum beside it (1398 inside the edge − 1 − 280 − 400 − 240 − 2)
    await values(page, grips.side, ["200", "248", "475", "248 px"]);
    await page.locator(grips.side).focus();
    await page.keyboard.press("ArrowRight");
    await widths(page, { side: 256 });
    await page.keyboard.press("Shift+ArrowRight");
    await widths(page, { side: 320 });
    await values(page, grips.side, ["200", "320", "475", "320 px"]);
    await page.keyboard.press("Home");
    await widths(page, { side: 200 });
    await page.keyboard.press("End");
    await widths(page, { side: 475, list: 280, reader: 400, info: 240 });
    await page.keyboard.press("Enter");
    await widths(page, { side: 248, list: 360, reader: 488, info: 299 });
    await values(page, grips.side, ["200", "248", "475", "248 px"]);
  });
});

test("the sidebar grip: a drag moves it, the release keeps the width and the focus stays on the grip", async () => {
  await withPage(async (page) => {
    await drag(page, grips.side, 40);
    await page.mouse.up();
    await widths(page, { side: 288, reader: 448 });
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Breite der Ordner");
    expect(await page.locator("[data-dragging]").count()).toBe(0);
    await page.keyboard.press("ArrowLeft");
    await widths(page, { side: 280 });
    // a drag stops at the limits
    await drag(page, grips.side, -400);
    await page.mouse.up();
    await widths(page, { side: 200 });
  });
});

test.skipIf(webkit)("a drag follows the pointer live and Escape puts the width back [skipped in WebKit: WEBKIT_HELD]", async () => {
  await withPage(async (page) => {
    await drag(page, grips.list, 60);
    await widths(page, { list: 420, reader: 428 });
    expect(await page.locator(`${grips.list}[data-dragging]`).count()).toBe(1);
    await page.keyboard.press("Escape");
    await widths(page, { list: 360, reader: 488 });
    await page.mouse.up();
    await widths(page, { list: 360, reader: 488 });
  });
});

test("a pane on the left grows to the right; End stops where the reader keeps 400 px", async () => {
  await withPage(async (page) => {
    await values(page, grips.list, ["280", "360", "448", "360 px"]);
    await page.locator(grips.list).focus();
    await page.keyboard.press("ArrowRight");
    await widths(page, { list: 368, reader: 480 });
    await page.keyboard.press("End");
    await widths(page, { list: 448, reader: 400, info: 299 });
    await page.keyboard.press("Home");
    await widths(page, { list: 280, reader: 568 });
    await drag(page, grips.list, 30);
    await page.mouse.up();
    await widths(page, { list: 310, reader: 538 });
  });
});

test("a pane on the right (the info column) grows to the left, with its line in its width", async () => {
  await withPage(async (page) => {
    await values(page, grips.info, ["240", "300", "388", "300 px"]);
    await page.locator(grips.info).focus();
    await page.keyboard.press("ArrowLeft");
    await widths(page, { info: 307, reader: 480 });
    await values(page, grips.info, ["240", "308", "388", "308 px"]);
    await page.keyboard.press("ArrowRight");
    await widths(page, { info: 299, reader: 488 });
    await page.keyboard.press("End");
    await widths(page, { info: 387, reader: 400, list: 360 });
    await drag(page, grips.info, 100);
    await page.mouse.up();
    await widths(page, { info: 287, reader: 500 });
  });
});

test("a table's column grip moves the column before it by keys and by a drag, at most the table's visible width", async () => {
  await withPage(async (page) => {
    await widths(page, { subject: 200, from: 140 });
    await values(page, grips.subject, ["120", "200", "488", "200 px"]);
    await page.locator(grips.subject).focus();
    await page.keyboard.press("ArrowRight");
    await widths(page, { subject: 208, from: 140 });
    await page.keyboard.press("Shift+ArrowLeft");
    await widths(page, { subject: 144 });
    await page.keyboard.press("Home");
    await widths(page, { subject: 120 });
    await page.keyboard.press("End");
    await widths(page, { subject: 488, from: 140 });
    await page.keyboard.press("Enter");
    await widths(page, { subject: 200 });
    await drag(page, grips.subject, 30);
    await page.mouse.up();
    await widths(page, { subject: 230, from: 140 });
    await values(page, grips.subject, ["120", "230", "488", "230 px"]);
  });
});

// The browser takes a touch gesture that starts on an element without touch-action: none (a pan of the table's
// scroller), and cancels the pointer: the drag ended back at the start. Chromium only: Playwright's WebKit has no way
// to send a touch drag (no CDP, and touchscreen only taps).
test.skipIf(webkit)("a touch drag moves a table column [skipped in WebKit: no touch drag]", async () => {
  await withPage(
    async (page) => {
      const box = await page.locator(grips.subject).boundingBox();
      if (!box) throw new Error("no grip");
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 4; step++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + step * 16, y }] });
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await widths(page, { subject: 264, from: 140 });
    },
    { touch: true },
  );
});

// In a right-to-left page a table's grip stands on the line before its column, and the sidebar stands on the right:
// its grip moves with the pointer and the arrow keys the way they point. (The table comes first: a wider sidebar leaves
// the reader too narrow for it, and it turns into the phone's rows.)
test("right to left: arrows and a drag move the grip the way they point, and a table grip stands on its line", async () => {
  await withPage(
    async (page) => {
      const place = await page.evaluate(
        ({ grip, column }) => {
          const box = document.querySelector(grip)!.getBoundingClientRect();
          return Math.abs(box.left + box.width / 2 - document.querySelector(column)!.getBoundingClientRect().left);
        },
        { grip: grips.subject, column: columns.subject },
      );
      expect(place).toBeLessThanOrEqual(1);
      await drag(page, grips.subject, -30);
      await page.mouse.up();
      await widths(page, { subject: 230 });
      await page.locator(grips.side).focus();
      await page.keyboard.press("ArrowLeft");
      await widths(page, { side: 256 });
      await page.keyboard.press("ArrowRight");
      await widths(page, { side: 248 });
      await drag(page, grips.side, -40);
      await page.mouse.up();
      await widths(page, { side: 288 });
    },
    { dir: "rtl" },
  );
});

// A grip says the width its column has and the most it can take now, also after the window or a neighbour changed.
test("the values follow the layout: a neighbour that grows, a narrower window", async () => {
  await withPage(async (page) => {
    await page.locator(grips.list).focus();
    await page.keyboard.press("End");
    await widths(page, { list: 448, reader: 400 });
    // the reader keeps its minimum, so the info column has nothing left to take
    await values(page, grips.info, ["240", "300", "300", "300 px"]);
    await page.setViewportSize({ width: 1250, height: 800 });
    await page.waitForFunction(
      ({ list, info }) =>
        [list, info].every(({ grip, column, line }) => {
          const element = document.querySelector(grip)!;
          const now = Math.round(document.querySelector(column)!.getBoundingClientRect().width + line);
          return element.getAttribute("aria-valuenow") === String(now) && Number(element.getAttribute("aria-valuemax")) >= now;
        }),
      { list: { grip: grips.list, column: columns.list, line: 0 }, info: { grip: grips.info, column: columns.info, line: 1 } },
    );
  });
});

test("a wider sidebar gives way when the window narrows, so the columns keep their minimum", async () => {
  await withPage(async (page) => {
    await page.locator(grips.side).focus();
    await page.keyboard.press("End");
    await widths(page, { side: 475 });
    // 1248 inside the edge − 1 − 280 − 400 − 240 − 2
    await page.setViewportSize({ width: 1250, height: 800 });
    await widths(page, { side: 325, list: 280, reader: 400, info: 240 });
    await values(page, grips.side, ["200", "325", "325", "325 px"]);
  });
});

// A drag whose pointer capture is lost (the grip leaves the page, another element takes the pointer) ends there; it
// did not, and moves kept resizing until a release somewhere else. A browser says the capture is lost before the next
// pointer event (WebKit only then), so a move follows the release.
test("a drag ends when the grip loses the pointer capture", async () => {
  await withPage(async (page) => {
    await page.evaluate(() =>
      document.addEventListener("pointerdown", (event) => Reflect.set(window, "__k2Pointer", event.pointerId), true),
    );
    const box = await page.locator(grips.list).boundingBox();
    await drag(page, grips.list, 30);
    await page.locator(grips.list).evaluate((grip) => grip.releasePointerCapture(Number(Reflect.get(window, "__k2Pointer"))));
    await page.mouse.move((box?.x ?? 0) + 60, (box?.y ?? 0) + 10, { steps: 2 });
    await page.waitForFunction(() => !document.querySelector("[data-dragging]"));
    await settled(page);
    // the drag ended where it was; what the pointer does now moves nothing
    const kept = await page.$eval(columns.list, (column) => Math.round(column.getBoundingClientRect().width));
    await page.mouse.move((box?.x ?? 0) + 120, (box?.y ?? 0) + 10, { steps: 4 });
    await page.mouse.up();
    await settled(page);
    await widths(page, { list: kept });
  });
});

// Grips show only on demand (design review 26.11.: grips at rest made every table head and divider busy). Only their
// opacity changes, so nothing moves; a hidden grip still takes the pointer.
const shown = (page: Page) =>
  page.evaluate(
    (selectors) =>
      Object.fromEntries(Object.entries(selectors).map(([name, s]) => [name, getComputedStyle(document.querySelector(s)!).opacity])),
    grips,
  );
const boxes = (page: Page) =>
  page.evaluate(
    (selectors) =>
      [...Object.values(selectors), ".k2-ws-side", ".k2-table th:nth-child(1)"].map((s) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height];
      }),
    grips,
  );

test("1440: grips rest hidden and show under the pointer along their line and in the head, on keyboard focus and while dragged, without moving anything", async () => {
  await withPage(async (page) => {
    const rest = await boxes(page);
    expect(await shown(page)).toEqual({ side: "0", list: "0", info: "0", subject: "0" });
    // the line of the sidebar, well below its pill
    const side = await page.locator(grips.side).boundingBox();
    if (!side) throw new Error("no sidebar grip");
    await page.mouse.move(side.x + side.width / 2, side.y + 200);
    await settled(page);
    expect(await shown(page)).toEqual({ side: "1", list: "0", info: "0", subject: "0" });
    // the head of the table, on a column's words
    const head = await page.locator(".k2-table th:nth-child(3)").boundingBox();
    if (!head) throw new Error("no head");
    await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
    await settled(page);
    expect(await shown(page)).toEqual({ side: "0", list: "0", info: "0", subject: "1" });
    expect(await boxes(page)).toEqual(rest);
    // away from every line: hidden again; then the keyboard reaches the first grip
    await page.mouse.move(5, 795);
    await settled(page);
    expect(await shown(page)).toEqual({ side: "0", list: "0", info: "0", subject: "0" });
    for (
      let step = 0;
      step < 10 && (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) !== "Breite der Ordner";
      step++
    )
      await page.keyboard.press("Tab");
    await settled(page);
    expect(await shown(page)).toEqual({ side: "1", list: "0", info: "0", subject: "0" });
    // a hidden grip takes the pointer: a press on the list's line drags it, and it shows while it is dragged
    await page.locator(grips.list).evaluate((grip) => grip.blur());
    await drag(page, grips.list, 20);
    expect(await page.locator(`${grips.list}[data-dragging]`).count()).toBe(1);
    expect((await shown(page)).list).toBe("1");
    await page.mouse.up();
    await widths(page, { list: 380 });
    await page.mouse.move(5, 795);
    await page.locator(grips.list).evaluate((grip) => grip.blur());
    await settled(page);
    expect((await shown(page)).list).toBe("0");
  });
});

// Without hover (a touch screen) the seam grips stay, and a table's grips show while its head is pressed or holds
// the focus.
test("touch: seam grips stay; table grips show while the head holds the focus", async () => {
  await withPage(
    async (page) => {
      // the page sees a touch screen: no hover
      expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
      expect(await shown(page)).toEqual({ side: "1", list: "1", info: "1", subject: "0" });
      await page.locator(grips.subject).focus();
      await settled(page);
      expect((await shown(page)).subject).toBe("1");
    },
    { touch: true },
  );
});

test("390: no grip shows on the phone", async () => {
  await withPage(async (page) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await settled(page);
    const seen = await page.evaluate(
      () => [...document.querySelectorAll(".k2-grip, .k2-cgrip")].filter((grip) => grip.checkVisibility({ opacityProperty: true })).length,
    );
    expect(seen).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});

test("every grip is a named separator in the tab order and the page passes axe", async () => {
  await withPage(async (page) => {
    for (const grip of Object.values(grips)) {
      const element = page.locator(grip);
      expect(await element.getAttribute("role")).toBe("separator");
      expect(await element.getAttribute("tabindex")).toBe("0");
    }
    await page.addScriptTag({ content: axeSource });
    const violations = await page.evaluate(async () => {
      const result = await window.axe!.run(document, {
        resultTypes: ["violations"],
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      });
      return result.violations.map(
        (violation) => `${violation.impact} ${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
      );
    });
    expect(violations).toEqual([]);
  });
});
