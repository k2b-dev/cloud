import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-state-timeline.client";

// The state timeline on a v2 screen (test/v2-state-timeline.client.tsx: long lane names, eight states with their own
// colours), as lane C found it in gateway-ops (#4205): a state's colour wins over the series colour, in its regions and
// in the legend; lane names and the legend stay inside the chart at every width.

const css = `${readFileSync(resolve(import.meta.dir, "../v2/v2.css"), "utf8")}\n${readFileSync(resolve(import.meta.dir, "../styles/chart.css"), "utf8")}`;
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-state-timeline.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** `dir`: the page is written right to left; `twin`: a hidden timeline of the same lanes stands first on the page. */
type PageOptions = { dir?: "rtl"; twin?: boolean; longStates?: boolean; timeAxis?: boolean };

const withPage = async (width: number, run: (page: Page) => Promise<void>, options: PageOptions = {}) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"${options.dir ? ` dir="${options.dir}"` : ""}><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    if (options.twin) await page.evaluate(() => Reflect.set(window, "__k2Twin", true));
    if (options.longStates) await page.evaluate(() => Reflect.set(window, "__k2LongStates", true));
    if (options.timeAxis) await page.evaluate(() => Reflect.set(window, "__k2TimeAxis", true));
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await page.locator(".k2-canvas > .k2b-chart > .k2b-chart__svg > svg").waitFor();
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

for (const width of [1440, 390])
  test(`at ${width}: a state's own colour fills its regions and its swatch in the legend`, async () => {
    await withPage(width, async (page) => {
      const fills = await page.evaluate(() => {
        const chart = document.querySelector(".k2-canvas > .k2b-chart > .k2b-chart__svg > svg")!;
        const region = (state: string) =>
          [...chart.querySelectorAll(".stdlib-chart-state-region")].find((rect) =>
            rect.closest("[aria-label]")?.getAttribute("aria-label")?.endsWith(state),
          );
        const swatches = [...chart.closest(".k2b-chart")!.querySelectorAll(".stdlib-chart-legend rect, .k2b-chart__legend rect")].map(
          (rect) => getComputedStyle(rect).fill,
        );
        return {
          failed: region("Fehlgeschlagen") ? getComputedStyle(region("Fehlgeschlagen")!).fill : "none",
          ok: region("Erfolgreich") ? getComputedStyle(region("Erfolgreich")!).fill : "none",
          swatches: swatches.slice(0, 4),
        };
      });
      expect(fills.failed).toBe("rgb(239, 68, 68)");
      expect(fills.ok).toBe("rgb(16, 185, 129)");
      expect(fills.swatches).toEqual(["rgb(16, 185, 129)", "rgb(239, 68, 68)", "rgb(59, 130, 246)", "rgb(245, 158, 11)"]);
    });
  });

/**
 * Where the lane names and the legend of the visible timeline stand: names that leave the chart or reach into the
 * plot, other text outside the chart, legend entries outside the chart or out of reach of its scroll, the pitch of
 * the lanes, and whether the clip of the names is the timeline's own (an id the page resolves to another drawing is
 * not).
 */
const measure = (page: Page) =>
  page.evaluate(() => {
    const host = document.querySelector(".k2-canvas > .k2b-chart")!;
    const box = host.getBoundingClientRect();
    const svg = host.querySelector(".k2b-chart__svg > svg")!;
    const at = (rect: DOMRect) => `${Math.round(rect.left - box.left)}..${Math.round(rect.right - box.left)} of ${Math.round(box.width)}`;
    const plotLeft = Math.min(...[...svg.querySelectorAll(".stdlib-chart-state-region")].map((rect) => rect.getBoundingClientRect().left));
    // The clip the page applies to the names: the element its id resolves to, which must stand in this drawing.
    const group = svg.querySelector(".stdlib-chart-state-labels");
    const clipId = /url\(#([^)]+)\)/.exec(group?.getAttribute("clip-path") ?? "")?.[1];
    const clip = clipId ? document.getElementById(clipId) : null;
    const ownClip = clip !== null && svg.contains(clip);
    const shape = clip?.querySelector("rect");
    const matrix = group instanceof SVGGraphicsElement ? group.getScreenCTM() : null;
    const clipRight =
      shape instanceof SVGRectElement && matrix
        ? new DOMPoint(shape.x.baseVal.value + shape.width.baseVal.value, 0).matrixTransform(matrix).x
        : Number.POSITIVE_INFINITY;
    const lanes = [...svg.querySelectorAll(".stdlib-chart-state-label")];
    const lanesOutside = lanes
      .map((text) => ({ text: text.textContent ?? "", rect: text.getBoundingClientRect() }))
      .filter(({ rect }) => rect.left < box.left - 0.5 || Math.min(rect.right, clipRight) > plotLeft + 0.5)
      .map(
        ({ text, rect }) =>
          `${text} ${at(rect)}, clipped at ${Math.round(clipRight - box.left)}, plot from ${Math.round(plotLeft - box.left)}`,
      );
    const centres = lanes.map((text) => {
      const rect = text.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    const pitch = Math.min(...centres.slice(1).map((centre, index) => centre - centres[index]!));
    const outside = [...svg.querySelectorAll("text:not(.stdlib-chart-state-label)")]
      .map((text) => ({ text: text.textContent ?? "", rect: text.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && (rect.left < box.left - 0.5 || rect.right > box.right + 0.5))
      .map(({ text, rect }) => `${text} ${at(rect)}`);
    // The legend's entries, wherever the chart draws them: each whole in the chart, and in its legend's reach (a legend
    // with more lines than room scrolls, and takes the focus for that).
    const legend = [...host.querySelectorAll(".k2b-chart__legend-item, .stdlib-chart-legend text")];
    const list = host.querySelector<HTMLElement>(".k2b-chart__legend");
    const reach = list ? list.getBoundingClientRect().top + list.scrollHeight : box.bottom;
    const legendOutside = legend
      .map((entry) => ({ text: entry.textContent ?? "", rect: entry.getBoundingClientRect() }))
      .filter(
        ({ rect }) =>
          rect.left < box.left - 0.5 ||
          rect.right > box.right + 0.5 ||
          rect.top < (list?.getBoundingClientRect().top ?? box.top) - 0.5 ||
          rect.bottom > reach + 0.5,
      )
      .map(({ text, rect }) => `${text} ${at(rect)}`);
    const scrolls = list ? list.scrollHeight > list.clientHeight + 1 : false;
    return {
      lanesOutside,
      outside,
      legendOutside,
      ownClip,
      pitch: Math.round(pitch * 10) / 10,
      legendScrolls: scrolls,
      legendFocusable: list?.tabIndex === 0,
      lanes: lanes.length,
      legend: legend.length,
    };
  });

const inside = (found: Awaited<ReturnType<typeof measure>>) => {
  expect(found.lanesOutside).toEqual([]);
  expect(found.outside).toEqual([]);
  expect(found.legendOutside).toEqual([]);
  expect(found.ownClip).toBe(true);
  // a lane keeps 18 px at least (three quarters of its 24); a legend that needs more room scrolls
  expect(found.pitch).toBeGreaterThanOrEqual(17.9);
  // the legend takes the focus while it scrolls, and only then
  expect(found.legendFocusable).toBe(found.legendScrolls);
  expect(found.lanes).toBe(6);
  expect(found.legend).toBe(8);
};

for (const width of [1440, 390])
  test(`at ${width}: lane names and the legend stay inside the chart, every lane and every state shown`, async () => {
    await withPage(width, async (page) => {
      const found = await measure(page);
      inside(found);
      // one line of states at 1440: nothing to scroll, so the legend takes no focus
      if (width === 1440) expect(found.legendScrolls).toBe(false);
    });
  });

test("at 390, in a page written right to left: lane names start at the left edge of the chart and stay in their column", async () => {
  await withPage(390, async (page) => inside(await measure(page)), { dir: "rtl" });
});

test("at 1440, with a hidden timeline of the same lanes first on the page: the names are clipped by this timeline's own clip", async () => {
  await withPage(1440, async (page) => inside(await measure(page)), { twin: true });
});

test("at 390, with eight long state names: the lanes keep 18 px each and the legend scrolls instead", async () => {
  await withPage(
    390,
    async (page) => {
      const found = await measure(page);
      inside(found);
      expect(found.legendScrolls).toBe(true);
    },
    { longStates: true },
  );
});

for (const width of [1440, 390])
  test(`at ${width}, over instants: the axis reads round clock times in German, and a run's tooltip says how long it took`, async () => {
    await withPage(
      width,
      async (page) => {
        const axis = await page.evaluate(() => {
          const chart = document.querySelector(".k2-canvas > .k2b-chart > .k2b-chart__svg > svg")!;
          const labels = [...chart.querySelectorAll<SVGTextElement>(".stdlib-chart-heatmap-label")];
          const boxes = labels.map((label) => label.getBoundingClientRect());
          return {
            texts: labels.map((label) => label.textContent),
            apart: boxes.every((box, index) => index === 0 || box.left >= boxes[index - 1]!.right),
          };
        });
        // 06:00 to 18:00 in steps of whole hours, never a minute of a decimal step, and no label on another
        expect(axis.texts.length).toBeGreaterThanOrEqual(4);
        for (const text of axis.texts) expect(text).toMatch(/^(0[6-9]|1[0-8]):00$/);
        expect(axis.apart).toBe(true);
        // the tooltip of a run: its clock times and its duration with a unit
        await page.locator(".k2-canvas > .k2b-chart").focus();
        await page.keyboard.press("ArrowRight");
        const tooltip = page.locator(".k2-canvas .k2b-chart__tooltip");
        await page.waitForFunction(() => (document.querySelector(".k2-canvas .k2b-chart__tooltip")?.textContent ?? "").includes("min"));
        const text = (await tooltip.textContent()) ?? "";
        expect(text).toMatch(/\d\d:\d\d/);
        expect(text).toMatch(/\d+ (min|h)/);
        expect(text).not.toMatch(/\d\.\d{3}/);
      },
      { timeAxis: true },
    );
  });
