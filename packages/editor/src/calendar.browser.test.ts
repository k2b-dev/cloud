import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { launchBrowser, pageErrors, settled } from "../../ui/test/browser";
import type { ChartInput } from "./charts";
import { notebookChartFrameHtml, notebookChartHeight, renderNotebookChartFigure } from "./markdown/lib/chart-blocks";

const input: ChartInput = {
  kind: "heatmap",
  layout: "calendar",
  title: "Opens per day",
  scale: "sequential",
  data: Array.from({ length: 182 }, (_, i): [string, number] => [
    new Date(Date.UTC(2026, 4, 11) + i * 86400000).toISOString().slice(0, 10),
    i,
  ]),
};
for (const width of [390, 800, 1440, 1920])
  test(`calendar notebook placeholder and content fit at ${width}px`, async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } }),
        errors = pageErrors(page);
      const placeholder = notebookChartFrameHtml(
        { ...input, height: notebookChartHeight(input, "en-GB") },
        '<p class="notebook-book-chart__status">Loading</p>',
      );
      const figure = renderNotebookChartFigure(input, "en-GB")!;
      await page.setContent(
        `<!doctype html><html><head><style>${await Bun.file(resolve(import.meta.dir, "../../ui/dist/styles.css")).text()}${await Bun.file(resolve(import.meta.dir, "styles.css")).text()}body{margin:0;font-family:Arial}main{padding:24px}.notebook-book-content{width:66%;min-width:0}@media(max-width:700px){.notebook-book-content{width:100%}}</style></head><body class="k2b-ui"><main><section class="notebook-book-content">${placeholder}</section></main></body></html>`,
      );
      await settled(page);
      const box = (e: Element) => {
        const b = e.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      };
      const frame = page.locator(".notebook-book-chart"),
        viewport = page.locator(".notebook-book-chart__viewport");
      const first = await frame.evaluate(box),
        firstViewport = await viewport.evaluate(box);
      await page.locator("section").evaluate((e, html) => (e.innerHTML = html), figure);
      await settled(page);
      expect(await frame.evaluate(box)).toEqual(first);
      expect(await viewport.evaluate(box)).toEqual(firstViewport);
      const chart = page.locator(".k2b-chart"),
        svg = page.locator(".k2b-chart__svg");
      const drawing = await svg.boundingBox(),
        cell = await chart.locator("[data-chart-datum] rect").first().boundingBox();
      expect(Math.abs(cell!.width - cell!.height)).toBeLessThan(0.2);
      expect(cell!.width).toBeGreaterThanOrEqual(13.9);
      expect(cell!.width).toBeLessThanOrEqual(32.1);
      expect(Math.abs(drawing!.height + 16 - firstViewport.height)).toBeLessThan(1);
      await page.emulateMedia({ media: "print" });
      await page
        .locator("section")
        .evaluate((e, html) => (e.innerHTML = html), renderNotebookChartFigure(input, "en-GB", { print: true })!);
      await settled(page);
      const printed = await page.locator(".k2b-chart__svg").boundingBox(),
        paper = await viewport.boundingBox();
      expect(printed!.width).toBeLessThanOrEqual(paper!.width + 1);
      expect(Math.abs(printed!.height - paper!.height)).toBeLessThan(1);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
