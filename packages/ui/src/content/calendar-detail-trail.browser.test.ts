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
        ...(document.body.dataset.hours ? {dayHours:[6,22],range:{from:"2026-07-13",to:"2026-07-20"}} : {}),
        events:[
          {id:"sunday",title:"Sunday meeting",start:"2026-07-19T10:00:00Z",end:"2026-07-19T11:00:00Z"},
          ...(document.body.dataset.lanes ? [
            {id:"standup",title:"Sunday standup",start:"2026-07-19T10:15:00Z",end:"2026-07-19T11:00:00Z"},
            {id:"review",title:"Sunday review",start:"2026-07-19T10:30:00Z",end:"2026-07-19T11:30:00Z"},
          ] : []),
          {id:"monday",title:"Monday review",start:"2026-07-13T10:00:00Z",end:"2026-07-13T11:00:00Z"},
          ...[1, 2, 3, 4, 5].map((n) => ({id:"tuesday-" + n,title:"Tuesday call " + n,start:"2026-07-14T10:00:00Z",end:"2026-07-14T11:00:00Z"})),
        ],
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
/** The event a test opens: "Sunday meeting", or with lanes, which share Sunday 10:00 in three lanes, one of them. */
const eventOf = (page: Page, title = "Sunday meeting") => page.locator("[data-calendar-event]", { hasText: title });
const motion: BrowserContextOptions = { reducedMotion: "no-preference" };
const touch: BrowserContextOptions = { hasTouch: true, isMobile: true };
// Main's 0.5 rem padding is the one Spaces gives its calendar, so the surface ends one gap before the panel.
const load = async (
  width: number,
  height: number,
  view: View,
  options: BrowserContextOptions = {},
  panel: PanelWidth = "md",
  hours = false,
  lane?: string,
) => {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce", ...options });
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>
    .k2b-ui .k2b-app-workspace{border:0;--k2b-workspace-radius:0px}
    .fixture-main{padding:0.5rem;display:flex;flex-direction:column}
    .fixture-calendar{flex:1;min-height:0}
    </style></head><body class="k2b-ui" style="margin:0"><div id="app" style="height:100vh"></div></body></html>`,
  );
  await page.evaluate(
    ([view, panel, hours, lane]) => {
      document.body.dataset.view = view;
      document.body.dataset.width = panel;
      if (hours) document.body.dataset.hours = view;
      if (lane) document.body.dataset.lanes = "3";
    },
    [view, panel, hours, lane] as const,
  );
  await page.addScriptTag({ content: script });
  await eventOf(page).waitFor();
  await page.bringToFront();
  if (hours) {
    expect(await eventOf(page, lane).count()).toBe(1);
    await hoursSettled(page);
    const closed = view === "week" ? await hoursColumns(page) : [];
    await eventOf(page, lane).click();
    await page.locator(".k2b-app-workspace__detail").waitFor();
    await page.waitForFunction(() => document.querySelector(".k2b-app-workspace__detail")!.getAnimations().length === 0);
    await hoursSettled(page);
    return { page, closed };
  }
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

/** Resolves once the hours have not scrolled for ten frames and the day and all-day rows match them. */
const settled = async (page: Page) => {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const scroll = document.querySelector<HTMLElement>(".k2b-calendar-time-grid__scroll")!;
        let last = scroll.scrollLeft;
        let still = 0;
        const tick = () => {
          still = scroll.scrollLeft === last ? still + 1 : 0;
          last = scroll.scrollLeft;
          if (still >= 10) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  await page.waitForFunction(() => {
    const hoursScroll = document.querySelector(".k2b-calendar-time-grid__scroll")!.scrollLeft;
    return (
      document.querySelector(".k2b-calendar-time-grid__days")!.scrollLeft === hoursScroll &&
      document.querySelector(".k2b-calendar-time-grid__all-day")!.scrollLeft === hoursScroll
    );
  });
};
/** The Monday event and day header against the right edge of the sticky hour gutter and corner they scroll under. */
const mondayEdges = (page: Page) =>
  page.evaluate(() => {
    const grid = document.querySelector(".k2b-calendar-time-grid")!;
    const event = [...grid.querySelectorAll("[data-calendar-event]")].find((element) => element.textContent?.includes("Monday review"))!;
    return {
      event: event.getBoundingClientRect().left,
      gutter: grid.querySelector(".k2b-calendar-time-grid__gutter")!.getBoundingClientRect().right,
      header: grid.querySelector(".k2b-calendar-time-grid__day")!.getBoundingClientRect().left,
      corner: grid.querySelector(".k2b-calendar-time-grid__corner")!.getBoundingClientRect().right,
    };
  });

/**
 * Resolves once the strip rests: ten still frames, which outlast its 140 ms settle timer, at a place it settles on, a
 * day start beside the hours, a day end at the trail's end, or either scroll limit. The day view only needs to be still.
 */
const hoursSettled = (page: Page) =>
  page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const week = document.querySelector<HTMLElement>(".k2b-calendar-week__scroll");
        const scroll = week ?? document.querySelector<HTMLElement>(".k2b-calendar-days__scroll")!;
        let left = scroll.scrollLeft;
        let top = scroll.scrollTop;
        let still = 0;
        const tick = () => {
          still = scroll.scrollLeft === left && scroll.scrollTop === top ? still + 1 : 0;
          left = scroll.scrollLeft;
          top = scroll.scrollTop;
          const gutter = week?.querySelector(".k2b-calendar-week__gutter")?.getBoundingClientRect().right;
          // The end of the view, without a scrollbar, less the trail's scroll padding.
          const end =
            scroll.getBoundingClientRect().left +
            scroll.clientLeft +
            scroll.clientWidth -
            (Number.parseFloat(getComputedStyle(scroll).scrollPaddingRight) || 0);
          const atRest =
            !week ||
            Math.abs(left) < 0.5 ||
            Math.abs(left - (scroll.scrollWidth - scroll.clientWidth)) < 0.5 ||
            [...week.querySelectorAll("[data-calendar-column]")].some((column) => {
              const rect = column.getBoundingClientRect();
              return Math.abs(rect.left - gutter!) < 0.5 || Math.abs(rect.right - end) < 0.5;
            });
          if (still >= 10 && atRest) resolve(true);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
const hoursColumns = (page: Page) =>
  page.evaluate(() => {
    const heads = [...document.querySelectorAll<HTMLElement>(".k2b-calendar-week__head")];
    return [...document.querySelectorAll<HTMLElement>("[data-calendar-column]")].map((column) => {
      const rect = column.getBoundingClientRect();
      const head = heads.find((head) => Number(head.dataset.col) + 2 === Number(column.style.gridColumn))!;
      return { width: rect.width, headerOffset: Math.abs(head.getBoundingClientRect().left - rect.left) };
    });
  });
const hoursPlacement = (page: Page, lane?: string) =>
  eventOf(page, lane).evaluate((event) => {
    const rect = event.getBoundingClientRect();
    const scroll = event.closest<HTMLElement>(".k2b-calendar-week__scroll, .k2b-calendar-days__scroll")!;
    const scroller = scroll.getBoundingClientRect();
    const top = Math.max(rect.top, scroller.top);
    const bottom = Math.min(rect.bottom, scroller.bottom);
    const hit = document.elementFromPoint(
      (Math.max(rect.left, scroller.left) + Math.min(rect.right, scroller.right)) / 2,
      (top + bottom) / 2,
    );
    const panel = document.querySelector(".k2b-app-workspace__detail")!.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      scrollerLeft: scroller.left,
      gutterLeft: scroll.querySelector(".k2b-calendar-week__gutter")?.getBoundingClientRect().left,
      trackRight: scroll.querySelector(".k2b-calendar-days__track")?.getBoundingClientRect().right,
      columnRight: event.closest("[data-calendar-column]")?.getBoundingClientRect().right,
      gutterRight: scroll.querySelector(".k2b-calendar-week__gutter")?.getBoundingClientRect().right,
      trailEnd:
        scroller.left + scroll.clientLeft + scroll.clientWidth - (Number.parseFloat(getComputedStyle(scroll).scrollPaddingRight) || 0),
      overflow: scroll.scrollWidth - scroll.clientWidth,
      scrollLeft: scroll.scrollLeft,
      panelLeft: panel.left,
      panelTop: panel.top,
      hit: hit?.closest("[data-calendar-event]") === event,
    };
  });

describe("dayHours calendar beside the workspace detail", () => {
  test("1280×800: a resize keeps the week's first day, and a strip a resize clamped settles on a day start", async () => {
    const { page } = await load(1280, 800, "week", {}, "md", true);
    try {
      await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>(".k2b-calendar-week__scroll")!;
        const width = scroller.querySelector("[data-calendar-column]")!.getBoundingClientRect().width;
        scroller.scrollLeft = 2 * width;
      });
      await hoursSettled(page);
      await page.setViewportSize({ width: 1240, height: 800 });
      await hoursSettled(page);
      const resized = await hoursPlacement(page);
      const width = (await hoursColumns(page))[0]!.width;
      expect(resized.scrollLeft).toBeCloseTo(2 * width, 0);

      await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>(".k2b-calendar-week__scroll")!;
        scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth;
      });
      await hoursSettled(page);
      const before = await hoursPlacement(page);
      await page.setViewportSize({ width: 1120, height: 800 });
      await hoursSettled(page);
      const clamped = await hoursPlacement(page);
      const narrowWidth = (await hoursColumns(page))[0]!.width;
      expect(clamped.scrollLeft).toBeLessThan(before.scrollLeft);
      expect(Math.abs(clamped.scrollLeft - Math.round(clamped.scrollLeft / narrowWidth) * narrowWidth)).toBeLessThan(0.5);
    } finally {
      await page.close();
    }
  });

  for (const [width, height, panel] of [
    [820, 1180, "md"],
    [768, 1024, "md"],
    [768, 1024, "lg"],
  ] as const) {
    test(`${width}×${height} touch tablet, ${panel} drawer: the dayHours week keeps aligned days and settles Sunday beside the drawer`, async () => {
      const { page, closed } = await load(width, height, "week", touch, panel, true);
      try {
        const open = await hoursColumns(page);
        expect(open).toHaveLength(7);
        for (const [index, column] of open.entries()) {
          expect(closed[index]!.width).toBeCloseTo(closed[0]!.width, 0);
          expect(closed[index]!.headerOffset).toBeLessThan(0.5);
          expect(column.width).toBeCloseTo(open[0]!.width, 0);
          expect(column.width).toBeCloseTo(closed[index]!.width, 0);
          expect(column.headerOffset).toBeLessThan(0.5);
        }
        const shape = await hoursPlacement(page);
        expect(shape.scrollLeft).toBeGreaterThan(0);
        expect(Math.abs(shape.gutterLeft! - shape.scrollerLeft)).toBeLessThan(0.5);
        // The strip settles with Sunday's end at the trail's end, not back on a day start under the drawer.
        expect(Math.abs(shape.columnRight! - shape.trailEnd)).toBeLessThan(0.5);
        expect(shape.right).toBeLessThanOrEqual(shape.panelLeft);
        expect(shape.right).toBeGreaterThan(shape.panelLeft - 32);
        expect(shape.hit).toBe(true);
      } finally {
        await page.close();
      }
    });
    test(`${width}×${height} touch tablet, ${panel} drawer: the dayHours day keeps its track and whole event beside the drawer`, async () => {
      const { page } = await load(width, height, "day", touch, panel, true);
      try {
        const shape = await hoursPlacement(page);
        expect(shape.overflow).toBe(0);
        expect(shape.scrollLeft).toBe(0);
        expect(shape.left).toBeGreaterThanOrEqual(shape.scrollerLeft);
        expect(shape.right).toBeLessThanOrEqual(shape.trackRight!);
        expect(shape.hit).toBe(true);
        // The track narrows into the space beside the drawer and ends one gap before it.
        expect(shape.trackRight!).toBeLessThanOrEqual(shape.panelLeft);
        expect(shape.trackRight!).toBeGreaterThan(shape.panelLeft - 32);
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
      test(`${width}×${height}: the dayHours ${view} event stays hit-testable beside the panel`, async () => {
        const { page } = await load(width, height, view, {}, "md", true);
        try {
          const shape = await hoursPlacement(page);
          expect(shape.right).toBeLessThanOrEqual(shape.panelLeft + 0.5);
          expect(shape.hit).toBe(true);
        } finally {
          await page.close();
        }
      });
    }
    test(`390×844 touch phone: the dayHours ${view} event stays hit-testable above the sheet`, async () => {
      const { page } = await load(390, 844, view, touch, "md", true);
      try {
        const shape = await hoursPlacement(page);
        expect(shape.bottom).toBeLessThanOrEqual(shape.panelTop);
        expect(shape.hit).toBe(true);
      } finally {
        await page.close();
      }
    });
  }

  // A smooth reveal starts a frame before the strip reads it; a resize or settle on the way must not stop or undo it.
  test("1280×800 with motion: the dayHours week scrolls Sunday out beside the panel", async () => {
    const { page } = await load(1280, 800, "week", motion, "md", true);
    try {
      const shape = await hoursPlacement(page);
      expect(shape.scrollLeft).toBeGreaterThan(0);
      expect(shape.right).toBeLessThanOrEqual(shape.panelLeft + 0.5);
      expect(shape.hit).toBe(true);
    } finally {
      await page.close();
    }
  });
  test("390×844 touch phone with motion: the dayHours week scrolls Sunday above the sheet", async () => {
    const { page } = await load(390, 844, "week", { ...touch, ...motion }, "md", true);
    try {
      const shape = await hoursPlacement(page);
      expect(shape.bottom).toBeLessThanOrEqual(shape.panelTop);
      expect(shape.hit).toBe(true);
    } finally {
      await page.close();
    }
  });
  test("820×1180 touch tablet with motion: the dayHours week settles Sunday's end beside the drawer", async () => {
    const { page } = await load(820, 1180, "week", { ...touch, ...motion }, "md", true);
    try {
      const shape = await hoursPlacement(page);
      expect(Math.abs(shape.columnRight! - shape.trailEnd)).toBeLessThan(0.5);
      expect(shape.right).toBeLessThanOrEqual(shape.panelLeft);
      expect(shape.hit).toBe(true);
    } finally {
      await page.close();
    }
  });
  // A narrow lane ends well inside its day, so the nearest day edge would slide the strip back over it.
  for (const [width, height, panel, lane] of [
    [820, 1180, "md", "Sunday meeting"],
    [768, 1024, "lg", "Sunday standup"],
  ] as const) {
    test(`${width}×${height} touch tablet, ${panel} drawer: ${lane} in a lane of three settles whole beside the drawer`, async () => {
      const { page } = await load(width, height, "week", touch, panel, true, lane);
      try {
        const shape = await hoursPlacement(page, lane);
        expect(shape.right).toBeLessThanOrEqual(shape.trailEnd + 0.5);
        expect(shape.left).toBeGreaterThanOrEqual(shape.gutterRight! - 0.5);
        expect(shape.hit).toBe(true);
      } finally {
        await page.close();
      }
    });
  }
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
          // The gutter sits inside the hour scroller, so it moves if anything around the hours scrolls (#1031).
          expect(shape.gutterLeft).toBeCloseTo(surface.innerLeft, 0);
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
  test("820×1180 touch tablet with motion: the smooth reveal scrolls Sunday out beside the drawer", async () => {
    const { page } = await load(820, 1180, "week", { ...touch, reducedMotion: "no-preference" });
    try {
      await settled(page);
      const shape = await placement(page);
      expect(shape.hoursScroll).toBeGreaterThan(0);
      expect(shape.daysScroll).toBe(shape.hoursScroll);
      expect(shape.allDayScroll).toBe(shape.hoursScroll);
      expect(shape.right).toBeLessThanOrEqual(shape.panel);
      expect(shape.right).toBeGreaterThan(shape.panel - 32);
      expect(shape.hit).toBe(true);
    } finally {
      await page.close();
    }
  });
  test("820×1180 touch tablet: Monday's event and header scroll back into view beside the hour gutter", async () => {
    const { page } = await load(820, 1180, "week", touch);
    try {
      expect((await placement(page)).hoursScroll).toBeGreaterThan(64);
      await page.evaluate(() =>
        [...document.querySelectorAll("[data-calendar-event]")]
          .find((element) => element.textContent?.includes("Monday review"))!
          .scrollIntoView({ block: "nearest", inline: "nearest" }),
      );
      await settled(page);
      const event = await mondayEdges(page);
      expect(event.event).toBeGreaterThanOrEqual(event.gutter - 0.5);
      await page.evaluate(() => {
        document.querySelector<HTMLElement>(".k2b-calendar-time-grid__scroll")!.scrollLeft = 10_000;
      });
      await settled(page);
      await page.evaluate(() =>
        document.querySelector(".k2b-calendar-time-grid__day")!.scrollIntoView({ block: "nearest", inline: "nearest" }),
      );
      await settled(page);
      const header = await mondayEdges(page);
      expect(header.header).toBeGreaterThanOrEqual(header.corner - 0.5);
    } finally {
      await page.close();
    }
  });
  test("820×1180: Tuesday's overflow menu stays above the hour gutter it opens over", async () => {
    const { page } = await load(820, 1180, "week", touch);
    try {
      await page.evaluate(() => {
        document.querySelector<HTMLElement>(".k2b-calendar-time-grid__scroll")!.scrollLeft = 0;
      });
      await settled(page);
      await page.evaluate(() => document.querySelector<HTMLElement>(".k2b-calendar-time-grid__overflow")!.click());
      const covered = await page.locator(".k2b-calendar-time-grid__overflow-menu").evaluate((menu) => {
        const box = menu.getBoundingClientRect();
        const gutter = menu.closest(".k2b-calendar-time-grid")!.querySelector(".k2b-calendar-time-grid__gutter")!.getBoundingClientRect();
        const y = box.top + box.height / 2;
        const xs = [box.left + 2, (Math.max(box.left, gutter.left) + gutter.right) / 2, gutter.right - 2];
        return { overlaps: box.left < gutter.right, hits: xs.map((x) => menu.contains(document.elementFromPoint(x, y))) };
      });
      expect(covered.overlaps).toBe(true);
      expect(covered.hits).toEqual([true, true, true]);
    } finally {
      await page.close();
    }
  });
  test("390×844 touch phone: the week reveals a Monday event beside the hour gutter, not under it", async () => {
    const { page } = await load(390, 844, "week", { hasTouch: true });
    try {
      await page.keyboard.press("Escape");
      await page.locator(".k2b-app-workspace__detail").waitFor({ state: "hidden" });
      await page.evaluate(() => {
        document.querySelector<HTMLElement>(".k2b-calendar-time-grid__scroll")!.scrollLeft = 10_000;
        [...document.querySelectorAll<HTMLElement>("[data-calendar-event]")]
          .find((element) => element.textContent?.includes("Monday review"))!
          .focus({ preventScroll: true });
      });
      await settled(page);
      expect((await mondayEdges(page)).event).toBeLessThan((await mondayEdges(page)).gutter);
      await page.keyboard.press("Enter");
      await page.locator(".k2b-app-workspace__detail").waitFor();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await settled(page);
      const edges = await mondayEdges(page);
      expect(edges.event).toBeGreaterThanOrEqual(edges.gutter - 0.5);
    } finally {
      await page.close();
    }
  });
});
