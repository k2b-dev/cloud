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
      createComponent(AppWorkspace.Detail, { id:"event", get open() { return open(); }, onClose:() => setOpen(false),
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
const eventOf = (page: Page) => page.locator("[data-calendar-event]", { hasText: "Sunday meeting" });
// Main's 0.5 rem padding is the one Spaces gives its calendar, so the surface ends one gap before the panel.
const load = async (width: number, height: number, view: View, options: BrowserContextOptions = {}) => {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce", ...options });
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>
    .k2b-ui .k2b-app-workspace{border:0;--k2b-workspace-radius:0px}
    .fixture-main{padding:0.5rem;display:flex;flex-direction:column}
    .fixture-calendar{flex:1;min-height:0}
    </style></head><body class="k2b-ui" style="margin:0"><div id="app" style="height:100vh"></div></body></html>`,
  );
  await page.evaluate((view) => {
    document.body.dataset.view = view;
  }, view);
  await page.addScriptTag({ content: script });
  await eventOf(page).waitFor();
  await page.bringToFront();
  await eventOf(page).click();
  await page.waitForFunction(() => document.querySelector(".k2b-app-workspace__detail")!.getAnimations().length === 0);
  return page;
};
/** The event's part inside its scroller, measured against the panel's left edge. */
const placement = (page: Page) =>
  eventOf(page).evaluate((event) => {
    const rect = event.getBoundingClientRect();
    const scroller = event.closest(".k2b-calendar-time-grid__scroll")!.getBoundingClientRect();
    const left = Math.max(rect.left, scroller.left);
    const right = Math.min(rect.right, scroller.right);
    const top = Math.max(rect.top, scroller.top);
    const bottom = Math.min(rect.bottom, scroller.bottom);
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return {
      left: rect.left,
      right: rect.right,
      visibleRight: right,
      scrollerLeft: scroller.left,
      panel: document.querySelector(".k2b-app-workspace__detail")!.getBoundingClientRect().left,
      hit: hit?.closest("[data-calendar-event]") === event,
    };
  });

describe("calendar beside the workspace detail", () => {
  for (const view of ["week", "day"] as const) {
    test(`820×1180 touch tablet: the ${view} view keeps the Sunday event beside the drawer`, async () => {
      const page = await load(820, 1180, view, { hasTouch: true, isMobile: true });
      try {
        const main = await page.locator(".k2b-app-workspace__main").boundingBox();
        const shape = await placement(page);
        // The drawer overlays Main, which keeps its width.
        expect(shape.panel).toBeLessThan(main!.x + main!.width);
        expect(shape.left).toBeGreaterThanOrEqual(shape.scrollerLeft);
        expect(shape.hit).toBe(true);
        // A day column is at least 32 rem wide and scrolls when it is wider than the space beside the
        // drawer; its visible part then ends beside the drawer, as the whole week does.
        expect(view === "week" ? shape.right : shape.visibleRight).toBeLessThanOrEqual(shape.panel + 0.5);
      } finally {
        await page.close();
      }
    });
    for (const [width, height] of [
      [1280, 800],
      [1440, 900],
    ] as const) {
      test(`${width}×${height}: the ${view} view keeps the Sunday event and a rounded surface beside the panel`, async () => {
        const page = await load(width, height, view);
        try {
          const shape = await placement(page);
          expect(shape.right).toBeLessThanOrEqual(shape.panel + 0.5);
          expect(shape.hit).toBe(true);
          const surface = await page.locator(".k2b-content-calendar").evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              right: element.getBoundingClientRect().right,
              radii: [style.borderTopRightRadius, style.borderBottomRightRadius].map(Number.parseFloat),
            };
          });
          expect(surface.right).toBeCloseTo(shape.panel - 8, 0);
          for (const radius of surface.radii) expect(radius).toBeGreaterThan(0);
        } finally {
          await page.close();
        }
      });
    }
  }
  test("390×844 touch phone: the day view reveals the event above the half sheet", async () => {
    const page = await load(390, 844, "day", { hasTouch: true });
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
