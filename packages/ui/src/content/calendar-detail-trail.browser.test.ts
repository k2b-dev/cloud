import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "calendar-detail-trail.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, Calendar, DetailPanel, PageTrailProvider } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const [open, setOpen] = createSignal(false);
render(() => createComponent(PageTrailProvider, { trail:{title:"Calendar",ancestors:[]}, get children() { return createComponent(AppWorkspace, {
  get children() { return [
    createComponent(AppWorkspace.Sidebar, { id:"navigation", get children() { return createComponent(AppWorkspace.SidebarDesktop, { get children() { return createComponent(AppWorkspace.SidebarItem, {href:"/calendar",active:true,children:"Calendar"}); } }); } }),
    createComponent(AppWorkspace.Content, { get children() { return [
      createComponent(AppWorkspace.Main, { class:"fixture-main", scroll:false, get children() { return createComponent(Calendar, {
        class:"fixture-calendar", view:document.body.dataset.view, date:"2026-07-19", timeZone:"UTC", startHour:8,
        events:[{id:"sunday",title:"Sunday meeting",start:"2026-07-19T10:00:00Z",end:"2026-07-19T11:00:00Z"}],
        onEventActivate:() => setOpen(true),
      }); } }),
      createComponent(AppWorkspace.Detail, { id:"event", width:document.body.dataset.width, get open() { return open(); }, onClose:() => setOpen(false),
        get children() { return createComponent(DetailPanel, { get children() { return createComponent(DetailPanel.Header, {title:"Selected event"}); } }); },
      }),
    ]; } }),
  ]; },
}); } }), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the calendar detail trail fixture.");
const script = await build.outputs[0]!.text();
setDefaultTimeout(30_000);
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type View = "week" | "day";
type PanelWidth = "md" | "lg";
const eventOf = (page: Page) => page.locator("[data-calendar-event]", { hasText: "Sunday meeting" });
const touch: BrowserContextOptions = { hasTouch: true, isMobile: true };
// Main's 0.5 rem padding is the one Spaces gives its calendar, so the surface ends one gap before the panel.
const load = async (width: number, height: number, view: View, options: BrowserContextOptions = {}, panel: PanelWidth = "md") => {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce", ...options });
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>
    .k2b-ui .k2b-app-workspace{border:0;--k2b-workspace-radius:0px}
    .fixture-main{padding:0.5rem;display:flex;flex-direction:column}
    .fixture-calendar{flex:1;min-height:0}
    </style></head><body class="k2b-ui" style="margin:0"><div id="app" style="height:100vh"></div></body></html>`,
  );
  await page.evaluate(
    ([view, panel]) => {
      document.body.dataset.view = view;
      document.body.dataset.width = panel;
    },
    [view, panel],
  );
  await page.addScriptTag({ content: script });
  await eventOf(page).waitFor();
  await page.bringToFront();
  const closed = await columns(page);
  await eventOf(page).click();
  // The workspace reveals the clicked event in the frame after the panel opens, and a reduced-motion panel has no
  // animation to wait for. A frame requested now runs after that reveal, so every measurement sees its result.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await page.waitForFunction(() => document.querySelector(".k2b-app-workspace__detail")!.getAnimations().length === 0);
  // The reveal's scroll event must reach the header and all-day row before measuring their alignment.
  await page.waitForFunction(() => {
    const hoursScroll = document.querySelector(".k2b-calendar-time-grid__scroll")!.scrollLeft;
    return (
      document.querySelector(".k2b-calendar-time-grid__days")!.scrollLeft === hoursScroll &&
      document.querySelector(".k2b-calendar-time-grid__all-day")!.scrollLeft === hoursScroll
    );
  });
  return { page, closed };
};
/** The width of every day column and how far its header cell is off it. */
const columns = (page: Page) =>
  page.evaluate(() => {
    const headers = [...document.querySelectorAll(".k2b-calendar-time-grid__day")];
    return [...document.querySelectorAll(".k2b-calendar-time-grid__column")].map((column, index) => {
      const rect = column.getBoundingClientRect();
      return { width: rect.width, headerOffset: Math.abs(headers[index]!.getBoundingClientRect().left - rect.left) };
    });
  });
/** The event, its grid, and the hour gutter, measured against the panel's left edge. */
const placement = (page: Page) =>
  eventOf(page).evaluate((event) => {
    const rect = event.getBoundingClientRect();
    const scroll = event.closest<HTMLElement>(".k2b-calendar-time-grid__scroll")!;
    const scroller = scroll.getBoundingClientRect();
    const grid = event.closest<HTMLElement>(".k2b-calendar-time-grid")!;
    const top = Math.max(rect.top, scroller.top);
    const bottom = Math.min(rect.bottom, scroller.bottom);
    const hit = document.elementFromPoint((rect.left + rect.right) / 2, (top + bottom) / 2);
    const detail = document.querySelector(".k2b-app-workspace__detail")!;
    return {
      left: rect.left,
      right: rect.right,
      scrollerLeft: scroller.left,
      gutterLeft: grid.querySelector(".k2b-calendar-time-grid__gutter")!.getBoundingClientRect().left,
      gridLeft: grid.getBoundingClientRect().left,
      hoursScroll: scroll.scrollLeft,
      daysScroll: grid.querySelector(".k2b-calendar-time-grid__days")!.scrollLeft,
      allDayScroll: grid.querySelector(".k2b-calendar-time-grid__all-day")!.scrollLeft,
      frameScroll: grid.scrollLeft,
      dayOverflow: scroll.scrollWidth - scroll.clientWidth,
      contentRight: grid.querySelector(".k2b-calendar-time-grid__grid")!.getBoundingClientRect().right,
      panel: detail.getBoundingClientRect().left,
      panelSpace: getComputedStyle(detail).getPropertyValue("--k2b-detail-space").trim(),
      hit: hit?.closest("[data-calendar-event]") === event,
    };
  });

describe("calendar beside the workspace detail", () => {
  for (const [width, height, panel] of [
    [820, 1180, "md"],
    [768, 1024, "md"],
    // The drawer is capped at the workspace minus 21 rem here, so it is narrower than the large panel.
    [768, 1024, "lg"],
  ] as const) {
    test(`${width}×${height} touch tablet, ${panel} drawer: the week keeps its days and scrolls Sunday out beside the drawer`, async () => {
      const { page, closed } = await load(width, height, "week", touch, panel);
      try {
        const main = await page.locator(".k2b-app-workspace__main").boundingBox();
        const shape = await placement(page);
        // The drawer overlays Main, which keeps its width.
        expect(shape.panel).toBeLessThan(main!.x + main!.width);
        // No day narrows, and the header and all-day row scroll with the days.
        const open = await columns(page);
        for (const [index, column] of open.entries()) {
          expect(column.width).toBeCloseTo(closed[index]!.width, 0);
          expect(column.headerOffset).toBeLessThan(0.5);
        }
        expect(shape.hoursScroll).toBeGreaterThan(0);
        expect(shape.daysScroll).toBe(shape.hoursScroll);
        expect(shape.allDayScroll).toBe(shape.hoursScroll);
        expect(shape.frameScroll).toBe(0);
        // The whole event ends one gap before the drawer, not further left.
        expect(shape.right).toBeLessThanOrEqual(shape.panel);
        expect(shape.right).toBeGreaterThan(shape.panel - 32);
        expect(shape.hit).toBe(true);
        expect(shape.panelSpace).toBe("0px");
      } finally {
        await page.close();
      }
    });
    test(`${width}×${height} touch tablet, ${panel} drawer: the day narrows beside the drawer and keeps its hours in view`, async () => {
      const { page } = await load(width, height, "day", touch, panel);
      try {
        const shape = await placement(page);
        expect(shape.dayOverflow).toBe(0);
        expect(shape.hoursScroll).toBe(0);
        expect(shape.frameScroll).toBe(0);
        expect(shape.gutterLeft).toBeCloseTo(shape.gridLeft, 0);
        for (const column of await columns(page)) expect(column.headerOffset).toBeLessThan(0.5);
        // The day ends one gap before the drawer, and the whole event is beside it.
        expect(shape.contentRight).toBeLessThanOrEqual(shape.panel);
        expect(shape.contentRight).toBeGreaterThan(shape.panel - 24);
        expect(shape.left).toBeGreaterThanOrEqual(shape.scrollerLeft);
        expect(shape.right).toBeLessThanOrEqual(shape.panel);
        expect(shape.hit).toBe(true);
      } finally {
        await page.close();
      }
    });
  }
  for (const view of ["week", "day"] as const) {
    for (const [width, height] of [
      [1280, 800],
      [1440, 900],
    ] as const) {
      test(`${width}×${height}: the ${view} view keeps the Sunday event and a rounded surface beside the panel`, async () => {
        const { page } = await load(width, height, view);
        try {
          const shape = await placement(page);
          expect(shape.right).toBeLessThanOrEqual(shape.panel + 0.5);
          expect(shape.hit).toBe(true);
          expect(shape.frameScroll).toBe(0);
          const surface = await page.locator(".k2b-content-calendar").evaluate((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return {
              right: rect.right,
              innerLeft: rect.left + element.clientLeft,
              innerRight: rect.left + element.clientLeft + element.clientWidth,
              radii: [style.borderTopRightRadius, style.borderBottomRightRadius].map(Number.parseFloat),
            };
          });
          expect(shape.right).toBeLessThanOrEqual(surface.innerRight + 0.5);
          expect(shape.gridLeft).toBeCloseTo(surface.innerLeft, 0);
          expect(surface.right).toBeCloseTo(shape.panel - 8, 0);
          for (const radius of surface.radii) expect(radius).toBeGreaterThan(0);
        } finally {
          await page.close();
        }
      });
    }
  }
  test("390×844 touch phone: the day view reveals the event above the half sheet", async () => {
    const { page } = await load(390, 844, "day", { hasTouch: true });
    try {
      await page.waitForFunction(
        (event) =>
          event.getBoundingClientRect().bottom <= document.querySelector(".k2b-app-workspace__detail")!.getBoundingClientRect().top,
        await eventOf(page).elementHandle(),
      );
      const sheet = await page.locator(".k2b-app-workspace__detail").boundingBox();
      expect(sheet!.y + sheet!.height).toBeCloseTo(844, 1);
      expect(sheet!.height).toBeCloseTo(844 * 0.55, 1);
    } finally {
      await page.close();
    }
  });
});
