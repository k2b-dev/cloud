import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { measureV2Layout } from "../../../../packages/ui/src/v2/testing";
import { browserName, launchBrowser, settled } from "../../../../packages/ui/test/browser";
import { registerSsrTestPlugin } from "../../../../packages/ui/test/ssr-test-plugin";

// The Fibel demo screens Mail and Kundenakte against the approved mockup (mail.html, akte.html, draft 16): the v2
// layout rules, and the boxes of their parts in the numbers measured in the mockup, in the same shell frame (rail
// 56 px, card inset 8 px; phone bar 52 px). A screen that drifts from its mockup fails here, not in a review.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-screens-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { V2ScreenPage } = await import("./V2DemoPage");
const css = readFileSync(resolve(import.meta.dir, "../../../../packages/ui/src/v2/v2.css"), "utf8");
const dist = resolve(import.meta.dir, "../../../../packages/ui/dist");
const origin = "https://v2-screens.test";
// Fibel's own CSS: the frame of the Cloud shell (rail 56 px, card inset 8 px; on the phone the platform's bar of
// 52 px) and the drawings in a Canvas
const fibel = readFileSync(resolve(import.meta.dir, "../cloud-ui.css"), "utf8").replace(/@import[^;]+;/g, "");

/** The screens of the Fibel pages, each on its page of its own (`V2ScreenPage`), as /en/ui/v2/screen/<name> shows it. */
const screens = {
  mail: "mail",
  // the inbox while nothing is open: the phone's first page
  mailList: "mail-list",
  record: "record",
  deliveries: "deliveries",
  table: "table",
} as const;

/** Boxes relative to the workspace, measured in the mockup at 1440 × 900 and 390 × 844 (left,top width×height). */
const mockup: Record<keyof typeof screens, Record<number, Record<string, [string, string]>>> = {
  mail: {
    1440: {
      head: ['.k2-ws-main > [data-slot="head"] > .k2-bar', "250,1 1125x56"],
      status: ['[data-k2-part="StatusRow"]', "250,57 432x52"],
      row: [".k2-list > .k2-row", "250,109 432x73"],
      readerHead: ['.k2-pane[data-detail] > [data-slot="head"] > .k2-bar', "683,57 692x52"],
      notice: ['.k2-notice[data-tone="ai"]', "683,149 692x85"],
      // the first message 12 px below the framed composer, with no line between them (Valentin, v2 of ui-v2-bausteine)
      message: [".k2-pane[data-detail] .k2-canvas + .k2-band", "683,456 692x285"],
      listGrip: [".k2-split .k2-grip", "677,460 11x20"],
    },
  },
  // the mockup's phone shows the list with nothing open
  mailList: {
    390: {
      head: ['.k2-ws-main > [data-slot="head"] > .k2-bar', "0,0 390x44"],
      status: ['[data-k2-part="StatusRow"]', "0,44 390x52"],
      row: [".k2-list > .k2-row", "0,96 390x73"],
    },
  },
  record: {
    1440: {
      head: ['.k2-ws-main > [data-slot="head"] > .k2-bar', "250,1 1125x56"],
      tabs: ['[data-slot="head"] > .k2-tabs-nav', "250,57 1125x44"],
      notice: [".k2-notice", "250,101 1125x65"],
      cells: [".k2-cells", "250,166 1125x117"],
      section: [".k2-sec", "250,283 765x181"],
      todo: [".k2-sec .k2-row", "250,335 765x60"],
      facts: [".k2-facts", "1016,499 359x200"],
    },
    390: {
      head: ['.k2-ws-main > [data-slot="head"] > .k2-bar', "0,0 390x57"],
      tabs: ['[data-slot="head"] > .k2-tabs-nav', "0,57 390x44"],
      notice: [".k2-notice", "0,101 390x137"],
      cells: [".k2-cells", "0,238 390x279"],
      section: [".k2-sec", "0,517 390x245"],
      todo: [".k2-sec .k2-row", "0,569 390x92"],
    },
  },
  // akte-einlieferungen.html
  deliveries: {
    1440: {
      section: [".k2-sec", "250,101 1125x945"],
      group: [".k2-group", "270,185 1085x254"],
      groupHead: [".k2-gh", "271,186 1083x56"],
      steps: [".k2-steps", "271,286 1083x72"],
      table: [".k2-group .k2-table", "271,636 1083x124"],
      // the inline facts with their end: the part is the line around the list
      facts: ['[data-k2-part="Facts"]', "271,836 1083x32"],
      folded: [".k2-group[data-folded]", "270,897 1085x58"],
    },
    390: {
      // mockup v17: the steps stand 12 px apart on the phone, so all below them moves 16 px down
      section: [".k2-sec", "0,101 390x1421"],
      group: [".k2-group", "16,205 358x382"],
      groupHead: [".k2-gh", "17,206 356x84"],
      steps: [".k2-steps", "17,354 356x148"],
      table: [".k2-group .k2-table", "17,908 356x204"],
      facts: ['[data-k2-part="Facts"]', "17,1192 356x64"],
      folded: [".k2-group[data-folded]", "16,1285 358x102"],
    },
  },
  // tabelle-grids.html; the table is wider than its column and scrolls sideways
  table: {
    1440: {
      head: ['.k2-ws-main > [data-slot="head"] > .k2-bar', "250,1 1125x56"],
      status: ['[data-k2-part="StatusRow"]', "250,57 1125x52"],
      firstHead: ["thead th:nth-child(2)", "294,109 260x36"],
      group: ["tbody tr[data-group]", "250,145 1724x36"],
      row: ["tbody tr:nth-child(2)", "250,181 1724x40"],
      personCell: ["tbody tr:nth-child(2) td:nth-child(5)", "806,181 176x40"],
    },
    390: {
      status: ['[data-k2-part="StatusRow"]', "0,0 390x52"],
      phoneGroup: [".k2-table-phone .k2-bar", "0,52 390x36"],
      phoneRow: [".k2-table-phone .k2-row", "0,88 390x53"],
    },
  },
};

type Browser = Awaited<ReturnType<typeof launchBrowser>>;
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type Page = Awaited<ReturnType<Browser["newPage"]>>;

/**
 * Opens one screen in the shell frame, with the built fonts, so it wraps its text in IBM Plex like the mockup. The page
 * and the fonts come through `page.route` from this process, under an origin of their own: the browser may run in
 * another container (CI's WebKit through `TEST_BROWSER_ENDPOINT`), which sees none of this machine's files.
 */
const show = async (name: keyof typeof screens, width: number, scale = 1): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: width < 768 ? 844 : 900 }, deviceScaleFactor: scale });
  const html = renderToString(() => createComponent(V2ScreenPage, { name: screens[name] }));
  const markup =
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><link rel="stylesheet" href="${origin}/plex.css">` +
    `<link rel="stylesheet" href="${origin}/tabler.css">` +
    `<style>${css}</style><style>${fibel}</style><style>html, body { margin: 0; height: 100%; }</style>` +
    // as every page of @k2b/ssr sends it: an island's host has no box of its own
    `<style>solid-client, solid-island { display: contents; }</style></head>` +
    `<body>${html}</body></html>`;
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/${name}.html`) return route.fulfill({ contentType: "text/html", body: markup });
    // the stylesheets and the fonts they name, from the built package; nothing outside it
    const file = resolve(dist, `.${path}`);
    if (!file.startsWith(`${dist}/`)) return route.fulfill({ status: 404 });
    return route.fulfill({ path: file });
  });
  await page.goto(`${origin}/${name}.html`);
  await page.evaluate(async () => {
    await Promise.all([400, 500, 600].map((weight) => document.fonts.load(`${weight} 13px "IBM Plex Sans"`)));
    // one glyph of the icon font (U+EA0F), so the font itself loads
    await document.fonts.load('16px "tabler-icons"', "");
    await document.fonts.ready;
  });
  await settled(page);
  return page;
};

describe("v2 demo screens keep the mockup", () => {
  for (const name of Object.keys(screens) as (keyof typeof screens)[])
    for (const width of Object.keys(mockup[name]).map(Number))
      for (const scale of [1, 2])
        test(`${name} at ${width} px, DPR ${scale}`, async () => {
          const page = await show(name, width, scale);
          try {
            const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
            expect(layout.problems).toEqual([]);
            const boxes = await page.evaluate((parts) => {
              const ws = document.querySelector("[data-k2-workspace]")!.getBoundingClientRect();
              return Object.fromEntries(
                Object.entries(parts).map(([part, [selector]]) => {
                  const box = document.querySelector(selector)!.getBoundingClientRect();
                  return [part, `${box.left - ws.left},${box.top - ws.top} ${box.width}x${box.height}`];
                }),
              );
            }, mockup[name][width]!);
            // Three texts end within a few px of their place: the meta line of the first statement in the record ("alle
            // 4 offenen Belege …"), the inline facts of a delivery on the phone, and the message in Mail. With the Plex
            // build of @k2b/ui they break in Chromium as in the mockup, in WebKit at another word; the mockup's own font
            // breaks the same in both engines. In WebKit only the parts above them are compared.
            const webkitBreaks: Partial<Record<keyof typeof screens, Record<number, string[]>>> = {
              mail: { 1440: ["message"] },
              record: { 1440: ["cells", "section", "todo", "facts"] },
              deliveries: { 390: ["facts", "folded", "section"] },
            };
            const wraps = new Set(browserName === "webkit" ? (webkitBreaks[name]?.[width] ?? []) : []);
            const expected = Object.fromEntries(Object.entries(mockup[name][width]!).map(([part, [, box]]) => [part, box]));
            for (const part of wraps) {
              delete boxes[part];
              delete expected[part];
            }
            expect(boxes).toEqual(expected);
          } finally {
            await page.close();
          }
        }, 30_000);

  // The mockup draws no phone with a message open; the parts come from the v2 rules: the message takes the place of the
  // list, its way back to the inbox a bar of 44 px above its head, and the list's row opens the message by its address.
  test("mail at 390 px with a message open: the message is the page, with its way back", async () => {
    const page = await show("mail", 390);
    try {
      const found = await page.evaluate(() => {
        const ws = document.querySelector("[data-k2-workspace]")!.getBoundingClientRect();
        const box = (selector: string) => {
          const r = document.querySelector(selector)!.getBoundingClientRect();
          return `${r.left - ws.left},${r.top - ws.top} ${r.width}x${r.height}`;
        };
        return {
          list: document.querySelector('.k2-pane[aria-label="Breite der Liste"]')!.getBoundingClientRect().width,
          detail: box(".k2-pane[data-detail]"),
          back: box(".k2-pane-back"),
        };
      });
      // the head of the workspace (the views) stays above it, 44 px
      expect(found).toEqual({ list: 0, detail: `0,44 390x${844 - 52 - 44}`, back: "0,44 390x44" });
      expect(await page.getByRole("link", { name: "Posteingang" }).getAttribute("href")).toBe("/en/ui/v2/screen/mail-list");
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
    } finally {
      await page.close();
    }
    const list = await show("mailList", 390);
    try {
      expect(await list.locator(".k2-pane[data-detail]").count()).toBe(0);
      expect(await list.locator('.k2-row a.k2-row-open[href="/en/ui/v2/screen/mail"]').count()).toBe(1);
    } finally {
      await list.close();
    }
  }, 30_000);

  test("mail at 390 px with a message open: nothing in it is cut, nothing breaks inside", async () => {
    const page = await show("mail", 390);
    try {
      const found = await page.evaluate(() => {
        const detail = document.querySelector(".k2-pane[data-detail]")!;
        // the line under the head: the facts of the conversation and who reads along; what has no room wraps
        const bar = detail.querySelector(":scope > .k2-scroll > .k2-bar")!;
        const box = bar.getBoundingClientRect();
        const style = getComputedStyle(bar);
        const inner = {
          left: box.left + Number.parseFloat(style.paddingLeft),
          right: box.right - Number.parseFloat(style.paddingRight),
          top: box.top + Number.parseFloat(style.paddingTop),
          bottom: box.bottom - Number.parseFloat(style.paddingBottom),
        };
        const things = [...bar.querySelectorAll(".k2-inline > *, .k2-bar-end > *")];
        const cut = things
          .filter((thing) => {
            const r = thing.getBoundingClientRect();
            // whole inside the bar's padding, and shown by every box around it that clips
            const clipped = (() => {
              for (let up = thing.parentElement; up && up !== bar; up = up.parentElement) {
                const s = getComputedStyle(up);
                if (s.display === "contents" || s.overflow === "visible") continue;
                const c = up.getBoundingClientRect();
                if (r.left < c.left - 0.5 || r.right > c.right + 0.5 || r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5) return true;
              }
              return false;
            })();
            return (
              clipped ||
              r.left < inner.left - 0.5 ||
              r.right > inner.right + 0.5 ||
              r.top < inner.top - 0.5 ||
              r.bottom > inner.bottom + 0.5 ||
              thing.scrollWidth > thing.clientWidth + 0.5
            );
          })
          .map((thing) => thing.textContent?.trim());
        // the end follows the last thing on its line when it has room there
        // things whose middles lie within 8 px of each other stand on one line (a chip, an avatar and a text differ)
        const middles = things
          .map((thing) => {
            const r = thing.getBoundingClientRect();
            return (r.top + r.bottom) / 2;
          })
          .sort((a, b) => a - b);
        const lines = middles.filter((middle, index) => index === 0 || middle - middles[index - 1]! > 8).length;
        // the composer's head: the recipient and the sender's choices each on one line, inside the box
        const top = document.querySelector(".ui-v2-composer__top")!.getBoundingClientRect();
        const parts = [...document.querySelectorAll(".ui-v2-composer__part")].map((part) => {
          const r = part.getBoundingClientRect();
          return [r.height, r.right <= top.right + 0.5];
        });
        // the sender of the message on one line beside its address
        const sender = detail.querySelector(".k2-band > .k2-row .k2-row-title")!.getBoundingClientRect().height;
        return { cut, lines, parts, sender };
      });
      expect(found).toEqual({
        cut: [],
        lines: 2,
        parts: [
          [36, true],
          [36, true],
        ],
        sender: 20,
      });
    } finally {
      await page.close();
    }
  }, 30_000);

  // On the phone the platform's bar (52 px) stands above the app, as the mockup draws it, so the page has no empty
  // strip at the top: the app's switcher in Mail, the way back to a list in a record and in the table.
  for (const [name, title] of [
    ["mail", "Mail"],
    ["mailList", "Mail"],
    ["record", "Kunden"],
    ["table", "Aufträge"],
  ] as const)
    test(`${name} at 390 px: the platform's bar stands above the app`, async () => {
      const page = await show(name, 390);
      try {
        const found = await page.evaluate(() => {
          const bar = document.querySelector(".ui-v2-phonebar")!.getBoundingClientRect();
          return {
            bar: `${bar.left},${bar.top} ${bar.width}x${bar.height}`,
            app: document.querySelector("[data-k2-workspace]")!.getBoundingClientRect().top,
            title: document.querySelector(".ui-v2-phonebar__title")!.textContent,
          };
        });
        expect(found).toEqual({ bar: "0,0 390x52", app: 52, title });
      } finally {
        await page.close();
      }
    }, 30_000);
});
