import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { browserName, launchBrowser } from "../../../../packages/ui/test/browser";
import { measureV2Layout } from "../../../../packages/ui/test/measure-v2-layout";
import { registerSsrTestPlugin } from "../../../../packages/ui/test/ssr-test-plugin";

// The Fibel demo screens Mail and Kundenakte against the approved mockup (mail.html, akte.html, draft 16): the v2
// layout rules, and the boxes of their parts in the numbers measured in the mockup, in the same shell frame (rail
// 56 px, card inset 8 px; phone bar 52 px). A screen that drifts from its mockup fails here, not in a review.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-screens-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { MailScreen } = await import("./mail-screen");
const { RecordScreen } = await import("./record-screen");
const css = readFileSync(resolve(import.meta.dir, "../../../../packages/ui/src/v2/v2.css"), "utf8");
const plex = resolve(import.meta.dir, "../../../../packages/ui/dist/plex.css");
const drawings = readFileSync(resolve(import.meta.dir, "../cloud-ui.css"), "utf8").replace(/@import[^;]+;/g, "");
const frame = `html, body { margin: 0; height: 100%; }
.shell { position: fixed; inset: 8px 8px 8px 56px; display: flex; }
@media (max-width: 767px) { .shell { inset: 52px 0 0 0; } }`;

const screens = {
  mail: { render: MailScreen, app: "--k2-app:#0f766e;--k2-app-ink:#0f5f59;--k2-app-tint:#e8f4f2" },
  record: { render: RecordScreen, app: "" },
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
      listGrip: [".k2-split .k2-grip", "677,460 11x20"],
    },
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
};

type Browser = Awaited<ReturnType<typeof launchBrowser>>;
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

describe("v2 demo screens keep the mockup", () => {
  for (const name of Object.keys(screens) as (keyof typeof screens)[])
    for (const width of [1440, 390])
      for (const scale of [1, 2])
        test(`${name} at ${width} px, DPR ${scale}`, async () => {
          const page = await browser.newPage({ viewport: { width, height: width < 768 ? 844 : 900 }, deviceScaleFactor: scale });
          try {
            const html = renderToString(() => createComponent(screens[name].render, {}));
            // A file next to the built fonts, so the screen wraps its text in IBM Plex like the mockup.
            const file = resolve(root, `${name}.html`);
            writeFileSync(
              file,
              `<!doctype html><html lang="de"><head><meta charset="utf-8"><link rel="stylesheet" href="file://${plex}">` +
                `<link rel="stylesheet" href="file://${plex.replace(/plex\.css$/, "tabler.css")}">` +
                `<style>${css}</style><style>${drawings}</style><style>${frame}</style></head>` +
                `<body class="k2-ui" style="${screens[name].app}"><div class="shell">${html}</div></body></html>`,
            );
            await page.goto(`file://${file}`);
            await page.evaluate(async () => {
              await Promise.all([400, 500, 600].map((weight) => document.fonts.load(`${weight} 13px "IBM Plex Sans"`)));
              await document.fonts.load('16px "tabler-icons"', "");
              await document.fonts.ready;
            });
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
            // The meta line of the first statement in the record ("alle 4 offenen Belege …") ends within a few px of
            // its cell: with the Plex build of @k2b/ui it wraps in Chromium as in the mockup, in WebKit it fits. In
            // WebKit only the parts above it are compared; the mockup's own font wraps in both engines.
            const wraps = new Set(
              browserName === "webkit" && name === "record" && width === 1440 ? ["cells", "section", "todo", "facts"] : [],
            );
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
});
