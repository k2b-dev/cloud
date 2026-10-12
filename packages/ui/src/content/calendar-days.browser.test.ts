import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";
import type { CalendarEvent } from "./Calendar";
import { GESTURE_GAP_MS } from "./calendar-day-scroll";

// Stops at day starts, the axis of a gesture, and what stays in place while days load are layout and input results,
// so a real engine renders the shipped stylesheet. The fixture shows Friday, 9 October 2026, 10:48 in Berlin, with
// the days from Friday 2 to Friday 30 October loaded.
const packageRoot = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(packageRoot, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "calendar-days.fixture.ts");
const fixture = `
import { batch, createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Calendar } from ${JSON.stringify(resolve(packageRoot, "dist/browser/index.js"))};

const options = window.fixtureOptions ?? {};
const offset = (wall) => (wall < "2026-10-25T03:00" ? "+02:00" : "+01:00");
const at = (wall) => (wall.length === 10 ? wall : wall + ":00" + offset(wall));
const event = (id, title, start, end, more = {}) => ({ id, title, start: at(start), end: at(end), colorHex: "#0ea5e9", ...more });
const week = (shift, tag, offsite = false) => {
  const day = (value) => {
    const date = new Date(value + "T12:00:00Z");
    date.setUTCDate(date.getUTCDate() + shift);
    return date.toISOString().slice(0, 10);
  };
  return [
    event("standup" + tag, "Stand-up", day("2026-10-05") + "T09:00", day("2026-10-05") + "T09:30"),
    event("review" + tag, "Design review", day("2026-10-07") + "T14:00", day("2026-10-07") + "T15:30"),
    // Two all-day entries over the same days need two rows of the week's all-day row.
    ...(offsite
      ? [
          event("offsite" + tag, "Offsite", day("2026-10-05"), day("2026-10-08"), { allDay: true }),
          event("audit" + tag, "Audit", day("2026-10-06"), day("2026-10-09"), { allDay: true }),
        ]
      : []),
  ];
};
const base = [
  ...week(0, ""),
  event("call", "Supplier call", "2026-10-09T10:30", "2026-10-09T11:15"),
  event("lunch", "Team lunch", "2026-10-09T12:30", "2026-10-09T13:15"),
  event("planning", "Route planning", "2026-10-09T14:00", "2026-10-09T15:30"),
  { id: "invoices", title: "Check invoices", start: at("2026-10-09T16:00"), display: "marker", checked: false, colorHex: "#f59e0b" },
  event("shift", "Night shift", "2026-10-13T23:00", "2026-10-14T01:30"),
  event("fair", "Trade fair", "2026-10-22", "2026-10-28", { allDay: true, colorHex: "#ec4899" }),
  ...week(14, "+2"),
  ...(options.events ?? []),
];
const [from, setFrom] = createSignal("2026-10-02");
const [to, setTo] = createSignal("2026-10-31");
const [date, setDate] = createSignal(options.date ?? "2026-10-09");
const [items, setItems] = createSignal(base);
window.loads = [];
window.slots = [];
window.drops = [];
window.checks = [];
window.visible = [];
window.setDate = setDate;
window.setRange = (from, to) => batch(() => { setFrom(from); setTo(to); });
const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" });
let gates = [];
let earlier = 0;
const gate = (apply) => new Promise((done) => gates.push(() => (apply(), done())));
window.dispose = render(
  () =>
    createComponent(Calendar, {
      view: options.view ?? "day",
      get date() {
        return date();
      },
      get events() {
        return items();
      },
      get range() {
        return { from: from(), to: to() };
      },
      timeZone: "Europe/Berlin",
      dayHours: [6, 22],
      getDateHref: (date, view) => "?view=" + view + "&date=" + date.toISOString(),
      getViewHref: (view) => "?view=" + view,
      onSlotActivate: (slot) => window.slots.push([slot.start.toISOString(), slot.end.toISOString()]),
      onEventActivate: () => {},
      onEventCheck: (event, checked) => { window.checks.push([event.id, checked]); },
      onVisibleDateChange: (date) => window.visible.push(dateKey.format(date)),
      controller: (value) => (window.controller = value),
      onLoadEarlier: () => {
        window.loads.push("earlier");
        return gate(() => {
          earlier++;
          batch(() => {
            setItems((current) => [...week(-7 * earlier, "-" + earlier, true), ...current]);
            const date = new Date(from() + "T12:00:00Z");
            date.setUTCDate(date.getUTCDate() - 7);
            setFrom(date.toISOString().slice(0, 10));
          });
        });
      },
      onLoadLater: () => {
        window.loads.push("later");
      },
    }),
  document.getElementById("host"),
);
document.querySelector("#tray a").addEventListener("pointerdown", (event) =>
  window.controller.dragIn(event, { title: "Write report", minutes: 60 }, (slot) =>
    window.drops.push([slot.start.toISOString(), slot.end.toISOString()]),
  ),
);
window.release = () => {
  const waiting = gates;
  gates = [];
  for (const done of waiting) done();
  return waiting.length;
};
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the calendar day fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const desktop: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };
const phone: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: browserName === "chromium",
  hasTouch: true,
};

type Options = { view?: "day" | "week"; date?: string; events?: CalendarEvent[] };
type Fixture = {
  fixtureOptions: Options;
  dispose: () => void;
  loads: string[];
  slots: string[][];
  drops: string[][];
  checks: [string, boolean][];
  visible: string[];
  setDate: (value: string) => void;
  setRange: (from: string, to: string) => void;
  release: () => number;
};

const open = async (context: BrowserContextOptions, options: Options = {}): Promise<Page> => {
  const page = await browser.newPage({ ...context, timezoneId: "Europe/Berlin", reducedMotion: "reduce" });
  await page.clock.setFixedTime(new Date("2026-10-09T08:48:00Z"));
  await page.setContent(
    `<!doctype html><html lang="en"><head><title>Calendar days</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>` +
      "<style>html, body { margin: 0 } #host { height: calc(100vh - 44px); display: flex; flex-direction: column } #host > * { flex: 1 } #tray { margin: 0; padding: 0 16px } #tray li { height: 44px; display: flex; align-items: center }</style></head>" +
      `<body class="k2b-ui"><ul id="tray"><li data-calendar-drag-source><a href="#task">Write report</a></li></ul><div id="host"></div><script>window.fixtureOptions = ${JSON.stringify(options)}</script><script>${script}</script></body></html>`,
  );
  await page.waitForSelector(options.view === "week" ? "[data-calendar-column]" : "[data-calendar-group]");
  await page.waitForFunction(() => (window as unknown as Fixture).visible.length > 0);
  return page;
};
const loads = (page: Page) => page.evaluate(() => (window as unknown as Fixture).loads);
const scrollTop = (page: Page, selector: string) => page.evaluate((value) => document.querySelector(value)!.scrollTop, selector);
/** A box on screen to the pixel: scroll positions snap to device pixels, layout boxes do not. */
const place = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).boundingBox())!;
  return [box.x, box.y, box.width, box.height].map(Math.round);
};
/**
 * A wheel or trackpad gesture: steps one frame apart, dispatched in the page, as a trackpad sends them. Driving the
 * mouse from the test spaces the steps by the round trip to the browser instead, which a remote engine stretches.
 */
const gesture = (page: Page, selector: string, deltaX: number, deltaY: number, steps: number, shiftKey = false) =>
  page.locator(selector).evaluate(
    (element, step) =>
      new Promise<void>((done) => {
        const target = element.querySelector("[data-calendar-column], [data-calendar-body]") ?? element;
        let left = step.steps;
        const next = () => {
          target.dispatchEvent(
            new WheelEvent("wheel", { deltaX: step.deltaX, deltaY: step.deltaY, shiftKey: step.shiftKey, bubbles: true, cancelable: true }),
          );
          if (--left > 0) requestAnimationFrame(next);
          else done();
        };
        next();
      }),
    { deltaX, deltaY, steps, shiftKey },
  );
const DAYS = ".k2b-calendar-days__scroll";
const WEEK = ".k2b-calendar-week__scroll";
/**
 * Waits until the week strip rests on a day start and the view has read its new place. A settle runs once the scroll
 * rested, and timers stretch on a busy machine, so the test waits for the result instead of a fixed time.
 */
const settledOnDay = async (page: Page) => {
  await page.waitForFunction(
    (selector) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const width = element.querySelector("[data-calendar-column]")!.getBoundingClientRect().width;
      return Math.abs(element.scrollLeft / width - Math.round(element.scrollLeft / width)) < 0.01;
    },
    WEEK,
    { timeout: 10_000 },
  );
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
};
/** Waits until the header names the shown days. */
const titled = (page: Page, text: string) =>
  page.waitForFunction((expected) => document.querySelector(".k2b-calendar-header__title > span")?.textContent === expected, text, {
    timeout: 10_000,
  });
/** The scroll position where a day starts. */
const dayStart = (page: Page, key: string) =>
  page.evaluate(
    (value) =>
      [...document.querySelectorAll<HTMLElement>("[data-calendar-group]")].find((section) =>
        section.dataset.calendarKeys?.split(",").includes(value),
      )!.offsetTop,
    key,
  );

describe(`Calendar day and week views in ${browserName}`, () => {
  test("a finger that holds a task while the calendar goes away starts no drag", async () => {
    const page = await open(phone);
    try {
      const origin = await page.locator("#tray a").evaluate((link) => {
        const rect = link.getBoundingClientRect();
        const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        link.dispatchEvent(
          new PointerEvent("pointerdown", {
            ...point,
            pointerType: "touch",
            pointerId: 7,
            isPrimary: true,
            button: 0,
            bubbles: true,
            cancelable: true,
          }),
        );
        (window as unknown as Fixture).dispose();
        return point;
      });
      // Waiting 800 ms, longer than the 420 ms hold, proves disposal leaves no delayed lift or scroll blocker.
      await page.waitForTimeout(800);
      expect(await page.locator("#tray li").getAttribute("data-lifted")).toBeNull();
      expect(
        await page.evaluate(() => {
          const event = new Event("touchmove", { bubbles: true, cancelable: true });
          document.dispatchEvent(event);
          return event.defaultPrevented;
        }),
      ).toBe(false);
      expect(
        await page.locator("#tray a").evaluate((link) => {
          const event = new Event("contextmenu", { bubbles: true, cancelable: true });
          link.dispatchEvent(event);
          return event.defaultPrevented;
        }),
      ).toBe(false);
      await page.evaluate(
        (origin) =>
          new Promise<void>((done) => {
            let step = 0;
            const move = () => {
              step++;
              window.dispatchEvent(
                new PointerEvent("pointermove", {
                  pointerType: "touch",
                  pointerId: 7,
                  isPrimary: true,
                  clientX: origin.clientX,
                  clientY: origin.clientY + step * 20,
                  bubbles: true,
                  cancelable: true,
                }),
              );
              if (step < 4) requestAnimationFrame(move);
              else done();
            };
            move();
          }),
        origin,
      );
      expect(await page.locator(".k2b-calendar-token").count()).toBe(0);
      await page.evaluate((origin) => {
        window.dispatchEvent(
          new PointerEvent("pointerup", {
            pointerType: "touch",
            pointerId: 7,
            isPrimary: true,
            button: 0,
            clientX: origin.clientX,
            clientY: origin.clientY + 80,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, origin);
      expect(await page.locator(".k2b-calendar-token").count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as Fixture).drops)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a finger that holds a task and lets go without moving leaves scrolling and the task as they were", async () => {
    const page = await open(phone);
    try {
      const hold = async () => {
        const origin = await page.locator("#tray a").evaluate((link) => {
          const rect = link.getBoundingClientRect();
          const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
          link.dispatchEvent(
            new PointerEvent("pointerdown", {
              ...point,
              pointerType: "touch",
              pointerId: 7,
              isPrimary: true,
              button: 0,
              bubbles: true,
              cancelable: true,
            }),
          );
          const menu = new Event("contextmenu", { bubbles: true, cancelable: true });
          link.dispatchEvent(menu);
          return { ...point, menuPrevented: menu.defaultPrevented };
        });
        expect(origin.menuPrevented).toBe(true);
        // The hold lifts the task after 420 ms; timers stretch on a busy machine, so the test waits for the lift.
        await page.waitForSelector('#tray li[data-lifted="true"]', { timeout: 10_000 });
        return origin;
      };
      const touchMovePrevented = () =>
        page.evaluate(() => {
          const event = new Event("touchmove", { bubbles: true, cancelable: true });
          document.dispatchEvent(event);
          return event.defaultPrevented;
        });
      const release = (type: "pointerup" | "pointercancel") =>
        page.evaluate((type) => {
          window.dispatchEvent(new PointerEvent(type, { pointerType: "touch", pointerId: 7, isPrimary: true, button: 0 }));
        }, type);
      const before = await scrollTop(page, DAYS);
      for (const type of ["pointerup", "pointercancel"] as const) {
        await hold();
        expect(await touchMovePrevented()).toBe(true);
        expect(
          await page.evaluate(() => {
            const menu = new Event("contextmenu", { bubbles: true, cancelable: true });
            document.querySelector("#tray a")!.dispatchEvent(menu);
            return menu.defaultPrevented;
          }),
        ).toBe(true);
        await release(type);
        expect(await touchMovePrevented()).toBe(false);
        expect(await page.locator("#tray li").getAttribute("data-lifted")).toBeNull();
        expect(await scrollTop(page, DAYS)).toBe(before);
        expect(await page.evaluate(() => (window as unknown as Fixture).drops)).toEqual([]);
        expect(
          await page.evaluate(() => {
            const menu = new Event("contextmenu", { bubbles: true, cancelable: true });
            document.querySelector("#tray a")!.dispatchEvent(menu);
            return menu.defaultPrevented;
          }),
        ).toBe(false);
      }
      const origin = await hold();
      expect(await touchMovePrevented()).toBe(true);
      await page.evaluate(
        ({ origin, selector }) =>
          new Promise<void>((done) => {
            const bounds = document.querySelector(selector)!.getBoundingClientRect();
            const gap = [
              ...document.querySelectorAll('[data-calendar-body="2026-10-09"] .k2b-calendar-gap:not([data-short]):not([data-past="true"])'),
            ]
              .map((element) => element.getBoundingClientRect())
              .find((rect) => rect.top + rect.height / 2 > bounds.top + 56 && rect.top + rect.height / 2 < bounds.bottom - 56);
            if (!gap) throw new Error("No free time is visible for the external drag.");
            const target = { clientX: gap.left + gap.width / 2, clientY: gap.top + gap.height / 2 };
            let step = 0;
            const move = () => {
              step++;
              window.dispatchEvent(
                new PointerEvent("pointermove", {
                  pointerType: "touch",
                  pointerId: 7,
                  isPrimary: true,
                  clientX: origin.clientX + ((target.clientX - origin.clientX) * step) / 8,
                  clientY: origin.clientY + ((target.clientY - origin.clientY) * step) / 8,
                  bubbles: true,
                  cancelable: true,
                }),
              );
              if (step < 8) requestAnimationFrame(move);
              else done();
            };
            move();
          }),
        { origin, selector: DAYS },
      );
      await release("pointerup");
      expect(await page.evaluate(() => (window as unknown as Fixture).drops.length)).toBe(1);
      expect(await page.locator("#tray li").getAttribute("data-lifted")).toBeNull();
      expect(await touchMovePrevented()).toBe(false);
    } finally {
      await page.close();
    }
  }, 30_000);

  for (const view of ["day", "week"] as const) {
    test(`going to a day outside the loaded days shows that day once it loads (${view})`, async () => {
      const page = await open(desktop, { view });
      try {
        await page.waitForFunction(() => (window as unknown as Fixture).visible.length > 0);
        await page.evaluate(() => (window as unknown as Fixture).setDate("2026-11-18"));
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
        await page.evaluate(() => (window as unknown as Fixture).setRange("2026-11-09", "2026-12-06"));
        await titled(page, view === "day" ? "Wed, Nov 18, 2026" : "Nov 16 – 22, 2026");
        const first = view === "day" ? "2026-11-18" : "2026-11-16";
        await page.waitForFunction((key) => (window as unknown as Fixture).visible.at(-1) === key, first);
        expect(await page.evaluate(() => (window as unknown as Fixture).visible.at(-1))).toBe(first);
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  test("a host date that names the first day on screen keeps the place", async () => {
    const page = await open(desktop);
    try {
      const start = await dayStart(page, "2026-10-13");
      await page.locator(DAYS).evaluate((element, top) => {
        element.scrollTop = top + 300;
      }, start);
      await page.waitForFunction(() => (window as unknown as Fixture).visible.at(-1) === "2026-10-13");
      const before = await scrollTop(page, DAYS);
      await page.evaluate(() => (window as unknown as Fixture).setDate("2026-10-13"));
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      await page.waitForTimeout(300);
      expect(Math.abs((await scrollTop(page, DAYS)) - before)).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("the day view brakes at a day start and settles onto it", async () => {
    const page = await open(desktop);
    try {
      const start = await dayStart(page, "2026-10-13");
      await page.locator(DAYS).evaluate((element, top) => {
        element.scrollTop = top;
      }, start - 160);
      await page.waitForTimeout(400);
      // Eight wheel steps toward the day start would move 160 px; near the start they move much less.
      await gesture(page, DAYS, 0, 20, 8);
      const braked = await scrollTop(page, DAYS);
      expect(braked).toBeGreaterThan(start - 160 + 40);
      expect(braked).toBeLessThan(start);
      // Resting close to the start glides onto it.
      await page.locator(DAYS).evaluate((element, top) => {
        element.scrollTop = top;
      }, start - 25);
      await gesture(page, DAYS, 0, 2, 1);
      await page.waitForFunction(
        ([selector, top]) => Math.round(document.querySelector(selector as string)!.scrollTop) === top,
        [DAYS, start] as const,
        { timeout: 10_000 },
      );
      expect(Math.round(await scrollTop(page, DAYS))).toBe(start);
      // A day start that was passed fills its line.
      await page.locator(DAYS).evaluate((element, top) => {
        element.scrollTop = top;
      }, start - 30);
      await page.waitForTimeout(50);
      const cross = await page.evaluate(() =>
        document
          .querySelector<HTMLElement>('[data-calendar-keys="2026-10-13"] > .k2b-calendar-days__head')!
          .style.getPropertyValue("--k2b-calendar-cross"),
      );
      expect(Number(cross)).toBeGreaterThan(0.5);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("the day view keeps what the reader sees in place while earlier days come in", async () => {
    const page = await open(desktop);
    try {
      // Moving toward the first loaded day asks for the week before it. The view rests in the middle of a day, away
      // from the day starts it settles onto.
      await page.locator(DAYS).evaluate((element) => {
        element.scrollTop = 600;
      });
      await page.waitForTimeout(50);
      await page.locator(DAYS).evaluate((element) => {
        element.scrollTop = 400;
      });
      await page.waitForFunction(() => (window as unknown as Fixture).loads.includes("earlier"));
      const before = await place(page, '[data-calendar-entry="call"]');
      const top = await place(page, '[data-calendar-keys="2026-10-05"] .k2b-calendar-days__head');
      expect(await page.evaluate(() => (window as unknown as Fixture).release())).toBe(1);
      await page.waitForSelector('[data-calendar-entry="standup-1"]', { state: "attached" });
      await page.waitForTimeout(100);
      expect(await place(page, '[data-calendar-entry="call"]')).toEqual(before);
      expect(await place(page, '[data-calendar-keys="2026-10-05"] .k2b-calendar-days__head')).toEqual(top);
      // The days came in above; the view did not ask again on its own.
      await page.waitForTimeout(300);
      expect(await loads(page)).toEqual(["earlier"]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a week gesture keeps its axis and settles on a day start; the arrows move by weeks", async () => {
    const page = await open(desktop, { view: "week" });
    try {
      const width = await page
        .locator("[data-calendar-column]")
        .first()
        .evaluate((column) => column.getBoundingClientRect().width);
      const position = () => page.locator(WEEK).evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }));
      const { left, top } = await position();
      expect(Math.round(left / width)).toBe(3);
      await gesture(page, WEEK, 30, 6, 10);
      // The gesture went sideways only; once it rests, the strip settles on a day start.
      expect((await position()).top).toBe(top);
      await settledOnDay(page);
      const { left: sideways, top: sidewaysTop } = await position();
      expect(sidewaysTop).toBe(top);
      expect(sideways).toBeGreaterThan(left);
      expect(Math.abs(sideways / width - Math.round(sideways / width))).toBeLessThan(0.01);
      // A vertical gesture with a slight sideways drift moves no day. A pause longer than the gap between the wheel
      // events of one gesture makes it a gesture of its own.
      await page.waitForTimeout(GESTURE_GAP_MS + 100);
      await gesture(page, WEEK, 6, 40, 6);
      expect((await position()).left).toBe(sideways);
      await settledOnDay(page);
      const { left: afterVertical } = await position();
      expect(afterVertical).toBe(sideways);
      await page.waitForTimeout(GESTURE_GAP_MS + 100);
      await gesture(page, WEEK, 0, 120, 1, true);
      expect((await position()).left).toBeGreaterThan(afterVertical);
      await settledOnDay(page);
      // Next goes to the start of the next week, Today back to this one.
      await page.getByRole("link", { name: "Next" }).click();
      await titled(page, "Oct 12 – 18, 2026");
      expect(await page.locator(".k2b-calendar-header__title > span").first().textContent()).toBe("Oct 12 – 18, 2026");
      expect(await page.locator(".k2b-calendar-header__today").getAttribute("data-direction")).toBe("left");
      await page.locator(".k2b-calendar-header__today").click();
      await titled(page, "Oct 5 – 11, 2026");
      expect(await page.locator(".k2b-calendar-header__title > span").first().textContent()).toBe("Oct 5 – 11, 2026");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("the week view keeps its days in place while earlier days come in, and its nights open where entries lie", async () => {
    const page = await open(desktop, { view: "week", date: "2026-10-12" });
    try {
      expect(await page.locator(".k2b-calendar-week__moon").getAttribute("aria-expanded")).toBe("true");
      await page.locator(WEEK).evaluate((element) => {
        element.scrollLeft -= element.querySelector("[data-calendar-column]")!.getBoundingClientRect().width * 7;
      });
      await page.waitForFunction(() => (window as unknown as Fixture).loads.includes("earlier"));
      const before = await place(page, '[data-calendar-head="2026-10-05"]');
      const hours = await place(page, '[data-calendar-body="2026-10-07"]');
      await page.evaluate(() => (window as unknown as Fixture).release());
      await page.waitForSelector('[data-calendar-head="2026-09-25"]', { state: "attached" });
      await page.waitForTimeout(100);
      expect(await place(page, '[data-calendar-head="2026-10-05"]')).toEqual(before);
      // The week that came in needs two all-day rows; off screen it changes nothing, and the hours stay put.
      expect(await place(page, '[data-calendar-body="2026-10-07"]')).toEqual(hours);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a checkable to-do in a folded week night keeps its checkbox and its place in the arrow keys", async () => {
    const page = await open(desktop, {
      view: "week",
      date: "2026-10-09",
      events: [
        {
          id: "callback",
          title: "Call back",
          start: "2026-10-07T23:00:00+02:00",
          display: "marker",
          checked: false,
          colorHex: "#f59e0b",
        },
      ],
    });
    try {
      const moon = page.locator(".k2b-calendar-week__moon");
      await page.waitForSelector('.k2b-calendar-week__moon[aria-expanded="true"]');
      expect(await moon.getAttribute("aria-expanded")).toBe("true");
      await moon.click();
      const fold = '[data-calendar-body="2026-10-07"] .k2b-calendar-week__fold-cell';
      await page.waitForSelector(fold, { state: "attached" });
      expect(await moon.getAttribute("aria-expanded")).toBe("false");
      const chip = page.locator(fold).locator(".k2b-calendar-event").filter({ hasText: "Call back" });
      expect(await chip.count()).toBe(1);
      // Folding a night keeps the to-do's checkbox, just as in its open hours.
      const checkbox = page.locator(fold).getByRole("checkbox", { name: "Done: Call back", exact: true });
      expect(await checkbox.count()).toBe(1);
      expect(await checkbox.getAttribute("aria-checked")).toBe("false");
      await page.locator('[data-calendar-body="2026-10-07"] [data-calendar-entry="review"] .k2b-calendar-event').focus();
      // Down passes the free time after Design review and reaches the folded entry after the waking hours.
      for (let step = 0; step < 3; step++) {
        await page.keyboard.press("ArrowDown");
        if (await chip.evaluate((element) => element.contains(document.activeElement))) break;
      }
      await page.waitForFunction((selector) => {
        const active = document.activeElement;
        const cell = document.querySelector(selector);
        return Boolean(cell && active && cell.contains(active) && active.getAttribute("aria-label")?.includes("Call back"));
      }, fold);
      expect(await chip.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      expect(await chip.getAttribute("tabindex")).toBe("0");
      await page.keyboard.press("Space");
      await page.waitForFunction(() => JSON.stringify((window as unknown as Fixture).checks) === JSON.stringify([["callback", true]]));
      expect(await page.evaluate(() => (window as unknown as Fixture).checks)).toEqual([["callback", true]]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("the arrows of the week skip free time too short to show", async () => {
    const page = await open(desktop, { view: "week" });
    try {
      // Between lunch and the planning there are 45 free minutes, which the column hides.
      await page.locator('[data-calendar-entry="lunch"] .k2b-calendar-event').focus();
      await page.keyboard.press("ArrowDown");
      expect(await page.evaluate(() => document.activeElement?.closest<HTMLElement>("[data-calendar-entry]")?.dataset.calendarEntry)).toBe(
        "planning",
      );
    } finally {
      await page.close();
    }
  }, 30_000);

  test("on a phone the week shows three days, a tap shows a column's free time, and the next one proposes an hour", async () => {
    const page = await open(phone, { view: "week" });
    try {
      const visible = await page.locator(WEEK).evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll<HTMLElement>("[data-calendar-column]")]
          .filter((column) => {
            const rect = column.getBoundingClientRect();
            return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
          })
          .map((column) => column.dataset.calendarBody);
      });
      expect(visible).toEqual(["2026-10-09", "2026-10-10", "2026-10-11"]);
      const saturday = page.locator('[data-calendar-column][data-calendar-body="2026-10-10"]');
      const area = (await saturday.boundingBox())!;
      const gap = saturday.locator(".k2b-calendar-gap").first();
      expect(await gap.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
      await page.touchscreen.tap(area.x + area.width / 2, area.y + area.height * 0.72);
      expect(await saturday.getAttribute("data-active")).toBe("true");
      expect(await gap.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      await page.touchscreen.tap(area.x + area.width / 2, area.y + area.height * 0.72);
      const draft = saturday.locator(".k2b-calendar-draft__open");
      await draft.waitFor();
      expect(await draft.textContent()).toMatch(/^\d\d:\d\d–\d\d:\d\d · 1 hr$/);
      await draft.tap();
      expect((await page.evaluate(() => (window as unknown as Fixture).slots)).length).toBe(1);
      // Nothing reaches past the page.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);
});
