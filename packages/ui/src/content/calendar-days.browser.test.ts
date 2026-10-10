import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

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
const week = (shift, tag) => {
  const day = (value) => {
    const date = new Date(value + "T12:00:00Z");
    date.setUTCDate(date.getUTCDate() + shift);
    return date.toISOString().slice(0, 10);
  };
  return [
    event("standup" + tag, "Stand-up", day("2026-10-05") + "T09:00", day("2026-10-05") + "T09:30"),
    event("review" + tag, "Design review", day("2026-10-07") + "T14:00", day("2026-10-07") + "T15:30"),
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
];
const [from, setFrom] = createSignal("2026-10-02");
const [items, setItems] = createSignal(base);
window.loads = [];
window.slots = [];
let gates = [];
let earlier = 0;
const gate = (apply) => new Promise((done) => gates.push(() => (apply(), done())));
render(
  () =>
    createComponent(Calendar, {
      view: options.view ?? "day",
      date: options.date ?? "2026-10-09",
      get events() {
        return items();
      },
      get range() {
        return { from: from(), to: "2026-10-31" };
      },
      timeZone: "Europe/Berlin",
      dayHours: [6, 22],
      getDateHref: (date, view) => "?view=" + view + "&date=" + date.toISOString(),
      getViewHref: (view) => "?view=" + view,
      onSlotActivate: (slot) => window.slots.push([slot.start.toISOString(), slot.end.toISOString()]),
      onEventActivate: () => {},
      onLoadEarlier: () => {
        window.loads.push("earlier");
        return gate(() => {
          earlier++;
          batch(() => {
            setItems((current) => [...week(-7 * earlier, "-" + earlier), ...current]);
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

type Options = { view?: "day" | "week"; date?: string };
type Fixture = { loads: string[]; slots: string[][]; release: () => number };

const open = async (context: BrowserContextOptions, options: Options = {}): Promise<Page> => {
  const page = await browser.newPage({ ...context, timezoneId: "Europe/Berlin", reducedMotion: "reduce" });
  await page.clock.setFixedTime(new Date("2026-10-09T08:48:00Z"));
  await page.setContent(
    `<!doctype html><html lang="en"><head><title>Calendar days</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>` +
      "<style>html, body { margin: 0 } #host { height: 100vh; display: flex; flex-direction: column } #host > * { flex: 1 }</style></head>" +
      `<body class="k2b-ui"><div id="host"></div><script>window.fixtureOptions = ${JSON.stringify(options)}</script><script>${script}</script></body></html>`,
  );
  await page.waitForSelector(options.view === "week" ? "[data-calendar-column]" : "[data-calendar-group]");
  await page.waitForTimeout(150);
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
      await page.waitForTimeout(600);
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
      await page.waitForTimeout(600);
      const { left: sideways, top: sidewaysTop } = await position();
      expect(sidewaysTop).toBe(top);
      expect(sideways).toBeGreaterThan(left);
      expect(Math.abs(sideways / width - Math.round(sideways / width))).toBeLessThan(0.01);
      await page.waitForTimeout(200);
      await gesture(page, WEEK, 6, 40, 6);
      await page.waitForTimeout(600);
      const { left: afterVertical } = await position();
      expect(afterVertical).toBe(sideways);
      await gesture(page, WEEK, 0, 120, 1, true);
      await page.waitForTimeout(600);
      expect((await position()).left).toBeGreaterThan(afterVertical);
      // Next goes to the start of the next week, Today back to this one.
      await page.getByRole("link", { name: "Next" }).click();
      await page.waitForTimeout(400);
      expect(await page.locator(".k2b-calendar-header__title > span").first().textContent()).toBe("Oct 12 – 18, 2026");
      expect(await page.locator(".k2b-calendar-header__today").getAttribute("data-direction")).toBe("left");
      await page.locator(".k2b-calendar-header__today").click();
      await page.waitForTimeout(400);
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
      await page.evaluate(() => (window as unknown as Fixture).release());
      await page.waitForSelector('[data-calendar-head="2026-09-25"]', { state: "attached" });
      await page.waitForTimeout(100);
      expect(await place(page, '[data-calendar-head="2026-10-05"]')).toEqual(before);
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
