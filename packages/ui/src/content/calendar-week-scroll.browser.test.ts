import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "calendar-week-scroll.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { Calendar } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const view = window.__calendarView ?? "week";
render(() => createComponent(Calendar, {
  date:"2026-11-14", view, events:[], timeZone:"UTC",
  onSlotActivate:(slot) => { window.__slot = slot.start.toISOString(); },
}), document.getElementById("app"));
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

const load = async (width: number, view: "week" | "day") => {
  const page = await browser.newPage({ viewport: { width: 800, height: 900 }, reducedMotion: "reduce" });
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="app" style="display:flex;width:${width}px;height:720px"></div></body></html>`,
  );
  await page.addScriptTag({ content: `window.__calendarView = ${JSON.stringify(view)};` });
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-calendar-time-grid__column").last().waitFor();
  return page;
};

const shape = (page: Page) =>
  page.locator(".k2b-calendar-time-grid").evaluate((grid) => {
    const frame = grid.closest(".k2b-content-calendar")!;
    const scroll = grid.querySelector<HTMLElement>(".k2b-calendar-time-grid__scroll")!;
    const rect = (selector: string) => grid.querySelector(selector)!.getBoundingClientRect();
    const style = getComputedStyle(frame);
    const probe = document.createElement("div");
    probe.style.width = "var(--k2b-radius-surface)";
    frame.append(probe);
    const radius = probe.getBoundingClientRect().width;
    probe.remove();
    return {
      scrollWidth: scroll.scrollWidth,
      clientWidth: scroll.clientWidth,
      left: scroll.scrollLeft,
      scrollRight: scroll.getBoundingClientRect().right,
      scrollLeftEdge: scroll.getBoundingClientRect().left,
      dayKeys: [...grid.querySelectorAll<HTMLElement>(".k2b-calendar-time-grid__all-day-cell")].map((cell) => cell.dataset.calendarDayKey),
      frameRight: frame.getBoundingClientRect().right,
      daysLeft: grid.querySelector(".k2b-calendar-time-grid__days")!.scrollLeft,
      allDayLeft: grid.querySelector(".k2b-calendar-time-grid__all-day")!.scrollLeft,
      header: rect(".k2b-calendar-time-grid__day:last-child"),
      column: rect(".k2b-calendar-time-grid__column:last-child"),
      gutter: rect(".k2b-calendar-time-grid__gutter"),
      corner: rect(".k2b-calendar-time-grid__corner"),
      radius,
      radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].map(
        Number.parseFloat,
      ),
    };
  });

test("a narrow week scrolls its hours sideways; the day rows follow and the hour gutter stays", async () => {
  const page = await load(480, "week");
  try {
    const before = await shape(page);
    expect(before.scrollWidth).toBeGreaterThan(before.clientWidth);
    // The hours' vertical scrollbar sits at the frame's edge, not beyond it.
    expect(before.scrollRight).toBeLessThanOrEqual(before.frameRight + 0.5);
    await page.locator(".k2b-calendar-time-grid__scroll").evaluate((scroll) => {
      scroll.scrollLeft = scroll.scrollWidth - scroll.clientWidth;
    });
    await page.waitForFunction(() => document.querySelector(".k2b-calendar-time-grid__days")!.scrollLeft > 0);
    const after = await shape(page);
    expect(after.left).toBeGreaterThan(0);
    expect(after.daysLeft).toBeCloseTo(after.left, 0);
    expect(after.allDayLeft).toBeCloseTo(after.left, 0);
    expect(after.header.left).toBeCloseTo(after.column.left, 0);
    expect(after.header.right).toBeCloseTo(after.column.right, 0);
    expect(after.column.right).toBeLessThanOrEqual(after.frameRight);
    expect(after.gutter.left).toBeCloseTo(before.gutter.left, 1);
    expect(after.corner.left).toBeCloseTo(before.corner.left, 1);
    for (const radius of after.radii) expect(radius).toBeCloseTo(after.radius, 1);

    // A drag over the scrolled hours picks the day under the pointer, not one hidden under the gutter.
    const slot = page.locator(".k2b-calendar-time-grid__column").nth(4).locator(".k2b-calendar-time-grid__slot").nth(10);
    await slot.scrollIntoViewIfNeeded();
    const box = (await slot.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height + 24, { steps: 6 });
    await page.mouse.up();
    expect(await page.evaluate(() => (window as unknown as { __slot?: string }).__slot?.slice(0, 10))).toBe(after.dayKeys[4]);
  } finally {
    await page.close();
  }
}, 30_000);

test("a wide week fits without scrolling sideways", async () => {
  const page = await load(760, "week");
  try {
    const wide = await shape(page);
    expect(wide.scrollWidth).toBeLessThanOrEqual(wide.clientWidth);
    expect(wide.header.left).toBeCloseTo(wide.column.left, 0);
    expect(wide.header.right).toBeCloseTo(wide.column.right, 0);
  } finally {
    await page.close();
  }
}, 30_000);

test("a day view on a phone keeps the header over its column while it scrolls", async () => {
  const page = await load(390, "day");
  try {
    await page.locator(".k2b-calendar-time-grid__scroll").evaluate((scroll) => {
      scroll.scrollLeft = scroll.scrollWidth - scroll.clientWidth;
    });
    await page.waitForFunction(() => document.querySelector(".k2b-calendar-time-grid__days")!.scrollLeft > 0);
    const day = await shape(page);
    expect(day.header.left).toBeCloseTo(day.column.left, 0);
    expect(day.header.right).toBeCloseTo(day.column.right, 0);
    expect(day.left).toBeGreaterThan(0);
    expect(day.gutter.left).toBeCloseTo(day.scrollLeftEdge, 0);
  } finally {
    await page.close();
  }
}, 30_000);
