import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// Uniform weeks, sticky geometry, pinned focus, and edge autoscroll need a real engine and the shipped CSS.
const packageRoot = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(packageRoot, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "calendar-month.fixture.ts");
const fixture = `
import { batch, createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Calendar } from ${JSON.stringify(resolve(packageRoot, "dist/browser/index.js"))};
const [from, setFrom] = createSignal("2026-08-31");
const [to, setTo] = createSignal("2026-12-21");
const [date, setDate] = createSignal("2026-10-09");
const [items, setItems] = createSignal([
  { id: "trip", title: "Autumn trip", start: "2026-10-28", end: "2026-11-11", allDay: true },
  { id: "setup", title: "Fair setup", start: "2026-10-07", end: "2026-10-14", allDay: true },
]);
const key = (date) => new Intl.DateTimeFormat("en-CA", {timeZone: "Europe/Berlin"}).format(date);
const add = (key, days) => { const d = new Date(key + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
let gates = [];
const api = window.monthFixture = { loads: [], visible: [], drops: [], selections: [], commands: [], setDate,
  setRange: (first, end) => batch(() => { setFrom(first); setTo(end); }),
  release: () => { const waiting = gates; gates = []; for (const done of waiting) done(); return waiting.length; },
};
const load = (edge) => {
  api.loads.push(edge);
  return new Promise((done) => gates.push(() => {
    batch(() => {
      const first = edge === "earlier" ? add(from(), -56) : to();
      setItems((current) => [...current, { id: edge + first, title: "Loaded " + edge, start: first, end: add(first, 7), allDay: true }]);
      if (edge === "earlier") setFrom(first); else setTo(add(to(), 56));
    });
    done();
  }));
};
render(() => createComponent(Calendar, {
  view: "month", get date() { return date(); }, get events() { return items(); },
  get range() { return { from: from(), to: to() }; }, timeZone: "Europe/Berlin", withWeekNumbers: true,
  onDateChange: (day) => setDate(key(day)),
  onSelectionChange: (range) => api.selections.push(range ? [key(range.start), key(range.end)] : null),
  onEventDrop: (event, next) => api.drops.push([event.id, key(next.start), key(next.end)]),
  onVisibleDateChange: (first, last, focus) => api.visible.push([key(first), key(last), key(focus)]),
  onLoadEarlier: () => load("earlier"), onLoadLater: () => load("later"),
  onCommandsChange: (commands) => { api.commands = commands; },
}), document.getElementById("host"));
const grid = document.querySelector(".k2b-calendar-month");
api.initial = { top: grid.scrollTop, height: grid.querySelector(".k2b-calendar-month__week").getBoundingClientRect().height };
window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.target.closest?.("input,textarea,[popover]")) return;
  const command = api.commands.find((command) => command.shortcut?.toLowerCase() === event.key.toLowerCase());
  if (command) { event.preventDefault(); command.run(); }
});
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the continuous month fixture.");
const script = await build.outputs[0]!.text();

type MonthFixture = {
  loads: string[];
  visible: string[][];
  drops: string[][];
  selections: (string[] | null)[];
  initial: { top: number; height: number };
  setDate: (key: string) => void;
  setRange: (from: string, to: string) => void;
  release: () => number;
};
declare global {
  interface Window {
    monthFixture: MonthFixture;
  }
}
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});
const GRID = ".k2b-calendar-month[data-continuous]";
const cell = (key: string) => `[data-calendar-day-key="${key}"]`;
const title = (page: Page) => page.locator(".k2b-calendar-header__title > span").first().textContent();
const open = async (motion: "reduce" | "no-preference" = "reduce") => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, timezoneId: "Europe/Berlin", reducedMotion: motion });
  await page.clock.setFixedTime(new Date("2026-10-09T08:00:00Z"));
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style><style>body{margin:0}#host{height:100vh;display:flex;flex-direction:column}#host>*{flex:1}</style></head><body class="k2b-ui"><div id="host"></div><script>${script}</script></body></html>`,
  );
  await page.waitForFunction(() => window.monthFixture.visible.length > 0);
  return page;
};
const scrollRow = async (page: Page, week: string, fraction = 0) => {
  await page.locator(GRID).evaluate(
    (grid, target) => {
      const row = grid.querySelector<HTMLElement>("[data-week-key]")!;
      const height = row.getBoundingClientRect().height;
      const dayNumber = (key: string) => Date.parse(`${key}T00:00:00Z`) / 86_400_000;
      const index =
        Number(row.style.getPropertyValue("--k2b-calendar-week-index")) + (dayNumber(target.week) - dayNumber(row.dataset.weekKey!)) / 7;
      grid.scrollTop = (index + target.fraction) * height;
    },
    { week, fraction },
  );
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
};
const atWeek = async (page: Page, week: string) => {
  await page.waitForFunction((key) => {
    const grid = document.querySelector(".k2b-calendar-month")!;
    const row = grid.querySelector<HTMLElement>(`[data-week-key="${key}"]`);
    return (
      row &&
      Math.abs(grid.scrollTop - Number(row.style.getPropertyValue("--k2b-calendar-week-index")) * row.getBoundingClientRect().height) <= 1
    );
  }, week);
};
const clickDay = async (page: Page, key: string) => {
  const bounds = (await page.locator(cell(key)).boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height - 8);
};

describe(`continuous month in ${browserName}`, () => {
  test("mount positions the first's week before paint; outside days and each first name their month", async () => {
    const page = await open();
    try {
      const initial = await page.evaluate(() => window.monthFixture.initial);
      expect(Math.abs(initial.top - 4 * initial.height)).toBeLessThanOrEqual(1);
      await atWeek(page, "2026-09-28");
      expect(await title(page)).toBe("October 2026");
      expect(await page.locator(cell("2026-09-30")).getAttribute("data-outside")).toBe("true");
      expect(await page.locator(cell("2026-10-01")).getAttribute("data-outside")).toBeNull();
      expect(await page.locator(`${cell("2026-11-01")} .k2b-calendar-month__day-number`).textContent()).toBe("Nov 1");
      expect(await page.locator(".k2b-calendar-month__scroll-label").getAttribute("data-show")).toBe("false");
      expect(await page.evaluate(() => window.monthFixture.visible.at(-1))).toEqual(["2026-09-28", "2026-11-01", "2026-10-09"]);
    } finally {
      await page.close();
    }
  }, 30_000);
  test("scrolling names the center month's days, reports visible rows and focus, and lets the label rest", async () => {
    const page = await open();
    try {
      // The label shows the new month while the view moves; it may leave again before the host hears of the month.
      await page.evaluate(() => {
        const label = document.querySelector<HTMLElement>(".k2b-calendar-month__scroll-label")!;
        new MutationObserver(() => {
          if (label.dataset.show === "true") label.dataset.seen = label.textContent ?? "";
        }).observe(label, { attributes: true, attributeFilter: ["data-show"] });
      });
      await scrollRow(page, "2026-10-26");
      await page.waitForFunction(
        () => document.querySelector<HTMLElement>(".k2b-calendar-month__scroll-label")?.dataset.seen === "November 2026",
      );
      await page.waitForFunction(() => window.monthFixture.visible.at(-1)?.[2] === "2026-11-01");
      expect(await title(page)).toBe("November 2026");
      expect(await page.locator(cell("2026-10-31")).getAttribute("data-outside")).toBe("true");
      expect(await page.locator(cell("2026-11-01")).getAttribute("data-outside")).toBeNull();
      expect(await page.evaluate(() => window.monthFixture.visible.at(-1))).toEqual(["2026-10-26", "2026-11-29", "2026-11-01"]);
      await page.waitForFunction(() => document.querySelector(".k2b-calendar-month__scroll-label")?.getAttribute("data-show") === "false");
    } finally {
      await page.close();
    }
  }, 30_000);
  test("prepending eight weeks asks once and preserves the same cells and their pixels while loading", async () => {
    const page = await open();
    try {
      await scrollRow(page, "2026-09-07", 0.25);
      await page.waitForFunction(() => window.monthFixture.loads.includes("earlier"));
      const before = (await page.locator(cell("2026-09-14")).boundingBox())!;
      await page.locator(cell("2026-09-14")).evaluate((element) => {
        element.setAttribute("data-retained", "true");
      });
      await scrollRow(page, "2026-09-07", 0.3);
      expect(await page.evaluate(() => window.monthFixture.loads.filter((edge) => edge === "earlier").length)).toBe(1);
      const position = (await page.locator(cell("2026-09-14")).boundingBox())!;
      await page.evaluate(() => window.monthFixture.release());
      const after = (await page.locator(cell("2026-09-14")).boundingBox())!;
      expect(Math.abs(after.y - position.y)).toBeLessThanOrEqual(1);
      expect(await page.locator(cell("2026-09-14")).getAttribute("data-retained")).toBe("true");
      expect(before.height).toBe(after.height);
      expect(await page.locator(".k2b-calendar-event", { hasText: "Fair setup" }).count()).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  }, 30_000);
  test("arrows align the first's week, and rapid steps accumulate across three months", async () => {
    const page = await open("no-preference");
    try {
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await atWeek(page, "2026-10-26");
      expect(await title(page)).toBe("November 2026");
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await atWeek(page, "2026-09-28");
      await page.evaluate(() => window.monthFixture.setRange("2026-08-31", "2027-04-12"));
      await page.getByRole("button", { name: "Next", exact: true }).evaluate((button) => {
        if (button instanceof HTMLElement) {
          button.click();
          button.click();
          button.click();
        }
      });
      await atWeek(page, "2026-12-28");
      expect(await title(page)).toBe("January 2027");
    } finally {
      await page.close();
    }
  }, 30_000);
  test("Today and H align October and pulse once; reduced motion jumps without a pulse", async () => {
    const page = await open("no-preference");
    try {
      await scrollRow(page, "2026-11-09");
      await page.getByRole("button", { name: "Today", exact: true }).click();
      await atWeek(page, "2026-09-28");
      await page.locator(`${cell("2026-10-09")} [data-pulse="true"]`).waitFor();
      await page.waitForFunction(() => !document.querySelector("[data-pulse='true']"));
      await scrollRow(page, "2026-11-09");
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await page.keyboard.press("h");
      await atWeek(page, "2026-09-28");
      await page.locator(`${cell("2026-10-09")} [data-pulse="true"]`).waitFor();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForFunction(() => !document.querySelector("[data-pulse='true']"));
      await scrollRow(page, "2026-11-09");
      await page.getByRole("button", { name: "Today", exact: true }).click();
      await atWeek(page, "2026-09-28");
      expect(await page.locator("[data-pulse='true']").count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);
  test("keyboard extends across month boundaries, PageDown selects Nov 9, and virtual scrolling pins focus and selection", async () => {
    const page = await open();
    try {
      await scrollRow(page, "2026-10-26");
      await clickDay(page, "2026-10-31");
      await page.keyboard.press("Shift+ArrowRight");
      expect(await page.locator(`${cell("2026-10-31")}[aria-selected='true']`).count()).toBe(1);
      expect(await page.locator(`${cell("2026-11-01")}[aria-selected='true']`).count()).toBe(1);
      await page.getByRole("button", { name: "Today", exact: true }).click();
      await clickDay(page, "2026-10-09");
      await page.keyboard.press("PageDown");
      await atWeek(page, "2026-10-26");
      expect(await page.locator(`${cell("2026-11-09")}[aria-selected='true']`).count()).toBe(1);
      await page.evaluate(() => window.monthFixture.setRange("2026-08-31", "2027-06-07"));
      // A wheel actually scrolls without a snapping rule, keeping the offscreen focus element connected.
      const grid = (await page.locator(GRID).boundingBox())!;
      await page.mouse.move(grid.x + grid.width / 2, grid.y + grid.height / 2);
      await page.mouse.wheel(0, 4500);
      await page.waitForFunction(() => document.querySelector(".k2b-calendar-month")!.scrollTop > 3000);
      expect(await page.locator(cell("2026-11-09")).evaluate((element) => element === document.activeElement)).toBe(true);
      await page.mouse.wheel(0, -4500);
      await scrollRow(page, "2026-10-26");
      expect(await page.locator(`${cell("2026-11-09")}[aria-selected='true']`).count()).toBe(1);
      expect(await page.locator(cell("2026-11-09")).evaluate((element) => element === document.activeElement)).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);
  test("grabbing a middle day moves a bar by that day offset, and drawing at the edge autoscrolls", async () => {
    const page = await open();
    try {
      const bar = (await page.locator(".k2b-calendar-event", { hasText: "Fair setup" }).first().boundingBox())!;
      const middle = (await page.locator(cell("2026-10-09")).boundingBox())!;
      const target = (await page.locator(cell("2026-10-16")).boundingBox())!;
      await page.mouse.move(middle.x + middle.width / 2, bar.y + bar.height / 2);
      await page.mouse.down();
      await page.mouse.move(target.x + target.width / 2, target.y + bar.y - middle.y + bar.height / 2, { steps: 8 });
      await page.mouse.up();
      expect(await page.evaluate(() => window.monthFixture.drops)).toEqual([["setup", "2026-10-14", "2026-10-21"]]);
      const start = (await page.locator(cell("2026-10-16")).boundingBox())!;
      const grid = (await page.locator(GRID).boundingBox())!;
      const top = await page.locator(GRID).evaluate((element) => element.scrollTop);
      await page.mouse.move(start.x + start.width / 2, start.y + start.height - 8);
      await page.mouse.down();
      await page.mouse.move(start.x + start.width / 2, grid.y + grid.height - 4, { steps: 8 });
      await page.waitForFunction((old) => document.querySelector(".k2b-calendar-month")!.scrollTop > old + 30, top);
      await page.mouse.up();
      expect(await page.locator('[aria-selected="true"]').count()).toBeGreaterThan(7);
    } finally {
      await page.close();
    }
  }, 30_000);
});
