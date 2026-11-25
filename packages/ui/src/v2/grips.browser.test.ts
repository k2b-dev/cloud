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
// sidebar 248 | list 360 | reader 488 (keeps 400) | info 300 (299 and its line). Runs in Chromium and in WebKit (TEST_BROWSER=webkit).
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

const withPage = async (run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Griffe</title><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
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
const values = (page: Page, grip: string) =>
  page.$eval(grip, (element) =>
    ["aria-valuemin", "aria-valuenow", "aria-valuemax", "aria-valuetext"].map((name) => element.getAttribute(name)),
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
    expect(await values(page, grips.side)).toEqual(["200", "248", "475", "248 px"]);
    await page.locator(grips.side).focus();
    await page.keyboard.press("ArrowRight");
    await widths(page, { side: 256 });
    await page.keyboard.press("Shift+ArrowRight");
    await widths(page, { side: 320 });
    expect(await values(page, grips.side)).toEqual(["200", "320", "475", "320 px"]);
    await page.keyboard.press("Home");
    await widths(page, { side: 200 });
    await page.keyboard.press("End");
    await widths(page, { side: 475, list: 280, reader: 400, info: 240 });
    await page.keyboard.press("Enter");
    await widths(page, { side: 248, list: 360, reader: 488, info: 299 });
    expect(await values(page, grips.side)).toEqual(["200", "248", "475", "248 px"]);
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
    expect(await values(page, grips.list)).toEqual(["280", "360", "448", "360 px"]);
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
    expect(await values(page, grips.info)).toEqual(["240", "300", "388", "300 px"]);
    await page.locator(grips.info).focus();
    await page.keyboard.press("ArrowLeft");
    await widths(page, { info: 307, reader: 480 });
    expect(await values(page, grips.info)).toEqual(["240", "308", "388", "308 px"]);
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
    expect(await values(page, grips.subject)).toEqual(["120", "200", "488", "200 px"]);
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
    expect(await values(page, grips.subject)).toEqual(["120", "230", "488", "230 px"]);
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
