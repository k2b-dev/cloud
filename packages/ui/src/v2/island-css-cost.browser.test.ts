import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { transparentIslands } from "../../scripts/v2-island-css";
import { browserName, launchBrowser, launchHookMs } from "../../test/browser";

// Guard for a stylesheet that costs the page on every change (W2, Notebooks graph): v2.css as it ships, with every
// relation also through an island wrapper, made a page that redraws an SVG of 300 nodes in every frame five times
// slower than the plain sheet in WebKit (5.4 s instead of 1.0 s for 60 frames on the test VM), and taps, keys and the
// page's load waited for it. The shipped sheet may cost the frames at most half again as much as the plain one.
// Runs in Chromium and in WebKit (TEST_BROWSER=webkit), each measured against itself.

const plain = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const shipped = transparentIslands(plain);

// v2 sections with fields, some in islands and one empty island, a list, and beside them the graph's SVG
const field = (i: number) =>
  `<div class="k2-field" data-k2-part="Field"><div class="k2-flabel"><label>Feld ${i}</label></div><div class="k2-input"><input aria-label="Feld ${i}"></div></div>`;
const section = (s: number) => {
  let body = `<div class="k2-sh"><h3>Abschnitt ${s}</h3></div>`;
  for (let i = 0; i < 6; i++) body += i % 2 ? `<solid-island>${field(i)}</solid-island>` : field(i);
  body += `<solid-island></solid-island><div class="k2-choices"><label class="k2-choice"><input type="radio">A</label></div>`;
  return `<section class="k2-sec" data-k2-part="Section">${body}</section>`;
};
const rows = Array.from(
  { length: 30 },
  (_, i) => `<div class="k2-row" data-k2-part="Row"><span class="k2-row-main">Zeile ${i}</span></div>`,
).join("");
const page = (css: string) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style></head><body class="k2-ui">` +
  `<div class="k2-ws" data-k2-workspace=""><div class="k2-ws-main"><div class="k2-split">` +
  `<section class="k2-pane"><div class="k2-scroll">${Array.from({ length: 6 }, (_, s) => section(s)).join("")}<div class="k2-list">${rows}</div></div></section>` +
  `<div class="k2-seam"></div>` +
  `<section class="k2-pane"><div class="k2-scroll"><section class="k2-sec"><div class="k2-canvas"><svg width="800" height="600"><g id="graph"></g></svg></div></section></div></section>` +
  `</div></div></div></body></html>`;

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** The time of 40 frames in which the graph draws its 300 nodes anew, as Solid's `For` does with new objects. */
const frames = async (css: string): Promise<number> => {
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await tab.setContent(page(css));
    return await tab.evaluate(async () => {
      const graph = document.getElementById("graph")!;
      const ns = "http://www.w3.org/2000/svg";
      const frame = () => new Promise<number>((done) => requestAnimationFrame(done));
      await frame();
      const start = performance.now();
      for (let f = 0; f < 40; f++) {
        const nodes = document.createDocumentFragment();
        for (let i = 0; i < 300; i++) {
          const node = document.createElementNS(ns, i % 2 ? "circle" : "line");
          node.setAttribute("class", i % 2 ? "notebook-graph__node" : "notebook-graph__edge");
          node.setAttribute(i % 2 ? "cx" : "x1", String((i * 7 + f) % 800));
          nodes.append(node);
        }
        graph.replaceChildren(nodes);
        await frame();
      }
      return performance.now() - start;
    });
  } finally {
    await tab.close();
  }
};

test("a page that redraws 300 nodes in every frame costs no more with the shipped v2.css than with the plain one", async () => {
  // the best of two rounds of each, taken in turns, so a busy moment of the machine counts for neither alone
  const plainTimes: number[] = [];
  const shippedTimes: number[] = [];
  for (let round = 0; round < 2; round++) {
    plainTimes.push(await frames(plain));
    shippedTimes.push(await frames(shipped));
  }
  const ratio = Math.min(...shippedTimes) / Math.min(...plainTimes);
  expect({ browser: browserName, ratio: Math.round(ratio * 100) / 100, below: ratio <= 1.5 }).toMatchObject({ below: true });
}, 120_000);
