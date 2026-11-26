import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { transparentIslands } from "../../scripts/v2-island-css";
import { browserName, launchBrowser, launchHookMs } from "../../test/browser";

// Guards for v2.css as it ships, with every relation also through an island wrapper (scripts/v2-island-css.ts).
//
// Cost (W2, Notebooks graph): the sheet of #4193 made WebKit restyle a page that draws an SVG of 300 nodes anew in
// every frame about 20 times as long as the plain sheet, so its frames, taps, keys and `load` waited. The test times
// the style and layout of 300 new nodes synchronously (`offsetHeight` and a computed style after each redraw; a time
// per frame would sit on the 16.7 ms of a frame and see nothing below it), the best of three batches after a warm-up,
// plain and shipped sheet in turns in the same browser, and prints the ratio, so CI logs add data points.
//
// The threshold comes from these ratios on the test VM (26.11.2026), the Playwright container at --cpus 0.5 / 1 / 2 and
// three runs at once at --cpus 1:
//   WebKit    this transform 1.9 / 3.0–3.4 / 3.2, at once 2.0–2.1   the transform of #4193 14.9 / 20.4–22.4 / 22.1, at once 13.2–14.0
//   Chromium  this transform 1.3 / 1.6 / 1.6, at once 1.2–1.8       the transform of #4193 2.9 / 2.7 / 2.6, at once 2.1–4.0
// WebKit fails above 6: twice the highest ratio of this transform, half the lowest of #4193's. In Chromium the two
// overlap under load, so it fails only above 3, a sheet clearly costlier than this one. WebKit still pays about three
// times the plain sheet's time here; most of it is the child relation through a wrapper (`A > W > B`) itself.
const limit = browserName === "webkit" ? 6 : 3;

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
const page = (css: string, body: string) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style></head><body class="k2-ui">${body}</body></html>`;
const graphPage = (css: string) =>
  page(
    css,
    `<div class="k2-ws" data-k2-workspace=""><div class="k2-ws-main"><div class="k2-split">` +
      `<section class="k2-pane"><div class="k2-scroll">${Array.from({ length: 6 }, (_, s) => section(s)).join("")}<div class="k2-list">${rows}</div></div></section>` +
      `<div class="k2-seam"></div>` +
      `<section class="k2-pane"><div class="k2-scroll"><section class="k2-sec"><div class="k2-canvas"><svg width="800" height="600"><g id="graph"></g></svg></div></section></div></section>` +
      `</div></div></div>`,
  );

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** Milliseconds to style and lay out 20 redraws of the graph's 300 nodes, the best of three batches after a warm-up. */
const styleTime = async (css: string): Promise<number> => {
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await tab.setContent(graphPage(css));
    // settled: the redraws and the style and layout they cause are what is timed, warm-up included
    return await tab.evaluate(() => {
      const graph = document.getElementById("graph")!;
      const ns = "http://www.w3.org/2000/svg";
      // as Solid's `For` does with new objects: every node new, then the page asks for its layout and a style
      const redraw = (f: number) => {
        const nodes = document.createDocumentFragment();
        for (let i = 0; i < 300; i++) {
          const node = document.createElementNS(ns, i % 2 ? "circle" : "line");
          node.setAttribute("class", i % 2 ? "notebook-graph__node" : "notebook-graph__edge");
          node.setAttribute(i % 2 ? "cx" : "x1", String((i * 7 + f) % 800));
          nodes.append(node);
        }
        graph.replaceChildren(nodes);
        void document.body.offsetHeight;
        void getComputedStyle(graph.lastElementChild!).color;
      };
      for (let f = 0; f < 5; f++) redraw(f);
      let best = Number.POSITIVE_INFINITY;
      for (let batch = 0; batch < 3; batch++) {
        const start = performance.now();
        for (let f = 0; f < 20; f++) redraw(f);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    });
  } finally {
    await tab.close();
  }
};

test("a page that redraws 300 nodes styles them with the shipped v2.css in at most the measured multiple of the plain sheet's time", async () => {
  // two passes in turns, the best of each, so a busy moment of the machine counts for neither alone
  let plainTime = Number.POSITIVE_INFINITY;
  let shippedTime = Number.POSITIVE_INFINITY;
  for (let pass = 0; pass < 2; pass++) {
    plainTime = Math.min(plainTime, await styleTime(plain));
    shippedTime = Math.min(shippedTime, await styleTime(shipped));
  }
  const ratio = shippedTime / plainTime;
  console.log(
    `island-css cost ${browserName}: plain ${plainTime.toFixed(1)} ms, shipped ${shippedTime.toFixed(1)} ms, ratio ${ratio.toFixed(2)} (limit ${limit})`,
  );
  expect({ browser: browserName, ratio: Math.round(ratio * 100) / 100, within: ratio <= limit }).toMatchObject({ within: true });
}, 120_000);

// A list of whole selectors drops the whole rule when one of them does not parse, where `:is()` forgave it: the
// shipped sheet keeps every rule the plain one has.
test("the browser keeps every rule of the shipped sheet that it keeps of the plain one", async () => {
  const count = async (css: string) => {
    const tab = await browser.newPage();
    try {
      await tab.setContent(page(css, ""));
      return await tab.evaluate(() => {
        let rules = 0;
        const walk = (list: CSSRuleList) => {
          for (const rule of list) {
            if (rule instanceof CSSStyleRule) rules++;
            if ("cssRules" in rule && !(rule instanceof CSSKeyframesRule)) walk((rule as CSSGroupingRule).cssRules);
          }
        };
        walk(document.styleSheets[0]!.cssRules);
        return rules;
      });
    } finally {
      await tab.close();
    }
  };
  const kept = await count(plain);
  expect(kept).toBeGreaterThan(500);
  expect(await count(shipped)).toBe(kept);
}, 60_000);
