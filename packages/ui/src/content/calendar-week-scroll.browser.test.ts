import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "calendar-week-scroll.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { Calendar } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
render(() => createComponent(Calendar, { date:"2026-11-14", view:"week", events:[], timeZone:"UTC" }), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the calendar week fixture.");
const script = await build.outputs[0]!.text();
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

test("a narrow week scrolls day headers and hours together inside its rounded frame", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 900 }, reducedMotion: "reduce" });
  try {
    await page.setContent(
      `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="app" style="display:flex;width:480px;height:720px"></div></body></html>`,
    );
    await page.addScriptTag({ content: script });
    await page.locator(".k2b-calendar-time-grid__column").last().waitFor();
    const shape = () =>
      page.locator(".k2b-calendar-time-grid").evaluate((grid) => {
        const frame = grid.closest(".k2b-content-calendar")!;
        const style = getComputedStyle(frame);
        const header = grid.querySelector(".k2b-calendar-time-grid__day:last-child")!.getBoundingClientRect();
        const column = grid.querySelector(".k2b-calendar-time-grid__column:last-child")!.getBoundingClientRect();
        const probe = document.createElement("div");
        probe.style.width = "var(--k2b-radius-surface)";
        frame.append(probe);
        const radius = probe.getBoundingClientRect().width;
        probe.remove();
        return {
          scroll: grid.scrollWidth,
          client: grid.clientWidth,
          left: grid.scrollLeft,
          frameRight: frame.getBoundingClientRect().right,
          headerLeft: header.left,
          headerRight: header.right,
          columnLeft: column.left,
          columnRight: column.right,
          radius,
          radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].map(
            Number.parseFloat,
          ),
        };
      });
    const before = await shape();
    expect(before.scroll).toBeGreaterThan(before.client);
    await page.locator(".k2b-calendar-time-grid").evaluate((grid) => {
      grid.scrollLeft = grid.scrollWidth - grid.clientWidth;
    });
    const after = await shape();
    expect(after.left).toBeGreaterThan(0);
    expect(before.headerLeft - after.headerLeft).toBeCloseTo(after.left, 1);
    expect(before.columnLeft - after.columnLeft).toBeCloseTo(after.left, 1);
    expect(after.headerRight).toBeLessThanOrEqual(after.frameRight);
    expect(after.columnRight).toBeLessThanOrEqual(after.frameRight);
    for (const radius of after.radii) expect(radius).toBeCloseTo(after.radius, 1);
  } finally {
    await page.close();
  }
}, 30_000);
