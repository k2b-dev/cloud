import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { browserName, launchBrowser, pageErrors, settled } from "../../test/browser";

const root = resolve(import.meta.dir, "../..");
const entry = resolve(import.meta.dir, "calendar-event-gestures.fixture.ts");
const build = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Calendar, LocaleProvider } from ${JSON.stringify(resolve(root, "dist/browser/index.js"))};
const options = window.options;
const [events, setEvents] = createSignal([
  { id: "owned", title: "Private focus", start: options.allDay ? "2026-10-24" : "2026-10-24T09:30:00+02:00", end: options.allDay ? "2026-10-25" : "2026-10-24T10:30:00+02:00", href: options.link ? "#owned" : undefined, allDay: options.allDay },
  { id: "readonly", title: "Shared focus", start: "2026-10-24T11:00:00+02:00", end: "2026-10-24T12:00:00+02:00", editable: false },
  { id: "todo", title: "Send report", start: "2026-10-24T13:00:00+02:00", display: "marker", checked: false },
]);
window.changes = [];
window.opens = [];
window.checks = [];
window.refresh = () => setEvents(events().map(event => ({ ...event })));
const change = (kind, event, next) => {
  window.changes.push([kind, event.id, next.start.toISOString(), next.end.toISOString(), next.allDay]);
  if (options.update) setEvents(events().map(item => item.id === event.id ? { ...item, ...next } : item));
};
window.dispose = render(() => createComponent(LocaleProvider, {
  locale: options.locale ?? "en",
  get children() { return createComponent(Calendar, {
    date: "2026-10-24", view: options.view ?? "day",
    get events() { return events(); },
    dayHours: options.legacy ? undefined : [6,22],
    dateConfig: { timeZone: "Europe/Berlin" },
    getDateHref: date => "?date=" + date.toISOString(),
    onEventDrop: options.resizeOnly ? undefined : (event, next) => change("move", event, next),
    onEventResize: (event, next) => change("resize", event, next),
    onEventActivate: event => window.opens.push(event.id),
    onEventCheck: (event, value) => window.checks.push([event.id, value]),
  }); },
}), document.getElementById("host"));`,
  },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle calendar event gesture fixture.");
const script = await build.outputs[0]!.text();
const css = readFileSync(resolve(root, "dist/styles.css"), "utf8");
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type Change = [string, string, string, string, boolean];
type Fixture = {
  changes: Change[];
  opens: string[];
  checks: [string, boolean][];
  dispose: () => void;
  refresh: () => void;
};
type Options = {
  view?: "day" | "week" | "month";
  legacy?: boolean;
  allDay?: boolean;
  link?: boolean;
  update?: boolean;
  resizeOnly?: boolean;
  locale?: string;
};
const open = async (options: Options = {}, touch = false) => {
  const page = await browser.newPage({
    viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    hasTouch: touch,
    isMobile: touch && browserName === "chromium",
    timezoneId: "America/New_York", // The calendar's context, not the browser's timezone, owns day edits.
    reducedMotion: "reduce",
  });
  const errors = pageErrors(page);
  await page.evaluate((at) => {
    const RealDate = Date;
    const offset = at - RealDate.now();
    class PinnedDate extends RealDate {
      constructor(...args: ConstructorParameters<DateConstructor> | []) {
        if (args.length === 0) super(RealDate.now() + offset);
        else super(...(args as ConstructorParameters<DateConstructor>));
      }
      static override now() {
        return RealDate.now() + offset;
      }
    }
    globalThis.Date = PinnedDate as DateConstructor;
  }, Date.parse("2026-10-24T08:00:00Z"));
  await page.setContent(
    `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>body {margin:0} #host {height:95vh;display:flex;flex-direction:column} #host > * {flex:1}</style><body class="k2b-ui"><div id="host"></div><script>window.options=${JSON.stringify(options)}</script><script>${script}</script></body></html>`,
  );
  const chip = page.locator("[data-calendar-event]").filter({ hasText: "Private focus" }).first();
  await chip.waitFor();
  await chip.scrollIntoViewIfNeeded();
  await settled(page);
  return { page, chip, errors };
};
const changes = (page: Page) => page.evaluate(() => (window as unknown as Fixture).changes);
const touchBlocked = (page: Page) =>
  page.evaluate(() => {
    const event = new Event("touchmove", { bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  });
const pointer = async (page: Page, target: Locator, type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", dy = 0) => {
  await target.waitFor({ state: "visible" });
  const box = (await target.boundingBox())!;
  return target.evaluate(
    (element, { type, x, y }) => {
      const event = new PointerEvent(type, {
        clientX: x,
        clientY: y,
        pointerId: 7,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { type, x: box.x + box.width / 2, y: box.y + box.height / 2 + dy },
  );
};
const held = (page: Page) =>
  page.waitForFunction(() => {
    const event = new Event("touchmove", { bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  });

for (const options of [{ view: "day" }, { view: "week" }, { view: "day", legacy: true }, { view: "month" }] as Options[]) {
  test(`${JSON.stringify(options)}: keyboard moves across DST and readonly still opens`, async () => {
    const { page, chip, errors } = await open({ ...options, update: true, link: true });
    try {
      expect(await chip.getAttribute("aria-description")).toContain("Alt+Left/Right");
      await chip.focus();
      await page.keyboard.press("Alt+ArrowRight");
      const edits = await changes(page);
      // Berlin leaves DST on Oct 25: 09:30 becomes 08:30Z while keeping one elapsed hour.
      expect(edits[0]).toEqual(["move", "owned", "2026-10-25T08:30:00.000Z", "2026-10-25T09:30:00.000Z", false]);
      // The host may move the event outside the view; return to an entry still in the current day.
      const readonly = page.locator("[data-calendar-event]").filter({ hasText: "Shared focus" }).first();
      await readonly.focus();
      await page.keyboard.press("Alt+ArrowDown");
      await page.keyboard.press("Alt+ArrowRight");
      await page.keyboard.press("Alt+Shift+ArrowDown");
      await page.keyboard.press("Alt+Shift+ArrowRight");
      expect(await changes(page)).toEqual(edits);
      expect(await readonly.getAttribute("aria-description")).toBeNull();
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => (window as unknown as Fixture).opens)).toContain("readonly");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
}

for (const options of [{ view: "day" }, { view: "week" }, { view: "day", legacy: true }] as Options[]) {
  test(`${JSON.stringify(options)}: timed keyboard duration, positive end, and ordinary activation`, async () => {
    const { page, chip, errors } = await open(options);
    try {
      await chip.focus();
      await page.keyboard.press("Alt+ArrowDown");
      await page.keyboard.press("Alt+ArrowUp");
      await page.keyboard.press("Alt+Shift+ArrowDown");
      await page.keyboard.press("Alt+Shift+ArrowUp");
      expect(await changes(page)).toEqual([
        ["move", "owned", "2026-10-24T07:45:00.000Z", "2026-10-24T08:45:00.000Z", false],
        ["move", "owned", "2026-10-24T07:15:00.000Z", "2026-10-24T08:15:00.000Z", false],
        ["resize", "owned", "2026-10-24T07:30:00.000Z", "2026-10-24T08:45:00.000Z", false],
        ["resize", "owned", "2026-10-24T07:30:00.000Z", "2026-10-24T08:15:00.000Z", false],
      ]);
      await page.keyboard.press("Alt+Shift+ArrowLeft");
      expect((await changes(page)).length).toBe(4);
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => (window as unknown as Fixture).opens)).toEqual(["owned"]);
      if (!options.legacy) {
        const todo = page.locator("[data-calendar-event]").filter({ hasText: "Send report" }).first();
        await todo.focus();
        await page.keyboard.press("Space");
        expect(await page.evaluate(() => (window as unknown as Fixture).checks)).toEqual([["todo", true]]);
        await page.keyboard.press("Alt+Shift+ArrowDown");
        expect((await changes(page)).length).toBe(4);
      }
      if (options.view === "week") {
        await chip.focus();
        await page.keyboard.press("ArrowDown");
        expect(await chip.evaluate((element) => element === document.activeElement)).toBe(false);
        expect((await changes(page)).length).toBe(4);
      }
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
}

test("all-day keyboard moves preserve both civil-date endpoints across DST", async () => {
  const { page, chip } = await open({ view: "week", allDay: true, update: true });
  try {
    await chip.focus();
    await page.keyboard.press("Alt+ArrowRight");
    expect((await changes(page))[0]).toEqual(["move", "owned", "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z", true]);
    await page.keyboard.press("Alt+ArrowLeft");
    expect((await changes(page))[1]).toEqual(["move", "owned", "2026-10-23T22:00:00.000Z", "2026-10-24T22:00:00.000Z", true]);
  } finally {
    await page.close();
  }
}, 30_000);

test("month and all-day keyboard durations use calendar days, with localized resize-only instructions", async () => {
  for (const options of [{ view: "month" }, { view: "week", allDay: true, resizeOnly: true, locale: "de" }] as Options[]) {
    const { page, chip } = await open(options);
    try {
      await chip.focus();
      await page.keyboard.press("Alt+Shift+ArrowRight");
      expect((await changes(page))[0]).toEqual([
        "resize",
        "owned",
        options.allDay ? "2026-10-23T22:00:00.000Z" : "2026-10-24T07:30:00.000Z",
        options.allDay ? "2026-10-25T23:00:00.000Z" : "2026-10-25T09:30:00.000Z",
        Boolean(options.allDay),
      ]);
      await page.keyboard.press("Alt+ArrowDown");
      expect((await changes(page)).length).toBe(1);
      if (options.resizeOnly) {
        expect(await chip.getAttribute("aria-description")).toContain("Umschalt");
        await page.keyboard.press("Alt+ArrowRight");
        expect((await changes(page)).length).toBe(1);
      }
    } finally {
      await page.close();
    }
  }
}, 30_000);

for (const options of [{ view: "day" }, { view: "week" }, { view: "month" }, { view: "day", legacy: true }] as Options[]) {
  test(`${JSON.stringify(options)}: touch hold moves an existing event and suppresses its trailing click after the host updates`, async () => {
    const { view } = options;
    const { page, chip, errors } = await open({ ...options, update: true }, true);
    try {
      await pointer(page, chip, "pointerdown");
      expect(await touchBlocked(page)).toBe(false);
      await held(page);
      expect(await chip.getAttribute("data-touch-held")).toBe("true");
      const dy = view === "month" ? 0 : 35;
      if (view === "month") {
        const target = page.locator('[data-calendar-day="2026-10-25"], [data-calendar-day-key="2026-10-25"]');
        const bounds = (await target.first().boundingBox())!;
        await page.evaluate(
          ({ x, y }) =>
            window.dispatchEvent(
              new PointerEvent("pointermove", {
                clientX: x,
                clientY: y,
                pointerId: 7,
                pointerType: "touch",
                isPrimary: true,
                button: 0,
                bubbles: true,
                cancelable: true,
              }),
            ),
          { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
        );
      } else await pointer(page, chip, "pointermove", dy);
      await pointer(page, chip, "pointerup", dy);
      const edit = (await changes(page))[0]!;
      expect(edit.slice(0, 2)).toEqual(["move", "owned"]);
      expect(edit[2]).not.toBe("2026-10-24T07:30:00.000Z");
      expect(new Date(edit[3]).getTime() - new Date(edit[2]).getTime()).toBe(3_600_000);
      await chip.dispatchEvent("click", { detail: 1 });
      expect(await page.evaluate(() => (window as unknown as Fixture).opens)).toEqual([]);
      expect(await touchBlocked(page)).toBe(false);
      expect(await chip.getAttribute("data-touch-held")).toBeNull();
      await chip.tap();
      expect(await page.evaluate(() => (window as unknown as Fixture).opens)).toEqual(["owned"]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
}

test("touch click guard preserves Enter on calendar links", async () => {
  const { page, chip } = await open({ link: true }, true);
  try {
    await chip.focus();
    await pointer(page, chip, "pointerdown");
    await held(page);
    await pointer(page, chip, "pointerup");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => (window as unknown as Fixture).opens)).toEqual(["owned"]);
    await chip.dispatchEvent("click", { detail: 1 });
    expect(await page.evaluate(() => (window as unknown as Fixture).opens)).toEqual(["owned"]);
  } finally {
    await page.close();
  }
}, 30_000);

for (const legacy of [false, true]) {
  test(`touch resize reaches grips and commits through the existing session (legacy=${legacy})`, async () => {
    const { page, chip } = await open({ legacy }, true);
    try {
      const frame = chip.locator("..");
      const grip = frame.locator(legacy ? ".k2b-calendar-time-grid__resize" : '.k2b-calendar-band__grip[data-edge="end"]');
      expect(
        await grip.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element;
        }),
      ).toBe(true);
      await settled(page);
      expect(await grip.evaluate((element) => getComputedStyle(element).touchAction)).toBe("auto");
      expect(
        await grip.evaluate((element, legacy) => Number(getComputedStyle(element, legacy ? undefined : "::after").opacity), legacy),
      ).toBeGreaterThan(0);
      await pointer(page, grip, "pointerdown");
      expect(await touchBlocked(page)).toBe(false);
      await held(page);
      await pointer(page, grip, "pointermove", 30);
      await pointer(page, grip, "pointerup", 30);
      const edit = (await changes(page))[0]!;
      expect(edit.slice(0, 3)).toEqual(["resize", "owned", "2026-10-24T07:30:00.000Z"]);
      expect(new Date(edit[3]).getTime()).toBeGreaterThan(new Date("2026-10-24T08:30:00Z").getTime());
      expect(await touchBlocked(page)).toBe(false);
    } finally {
      await page.close();
    }
  }, 30_000);
}

test("touch release, swipe, cancellation, blur, Escape, disposal and readonly leave no edits or scroll blockers", async () => {
  for (const ending of ["pointerup", "pointercancel", "move", "blur", "Escape", "dispose", "readonly"] as const) {
    const { page, chip } = await open({}, true);
    try {
      const target = ending === "readonly" ? page.locator("[data-calendar-event]").filter({ hasText: "Shared focus" }).first() : chip;
      await pointer(page, target, "pointerdown");
      if (ending === "move") await pointer(page, target, "pointermove", 20);
      else if (ending === "pointerup" || ending === "pointercancel") await pointer(page, target, ending);
      else if (ending === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      else if (ending === "Escape") await page.keyboard.press("Escape");
      else if (ending === "dispose") await page.evaluate(() => (window as unknown as Fixture).dispose());
      await page.waitForTimeout(450); // Prove cancellation removed the delayed hold.
      if (ending === "readonly") {
        await pointer(page, target, "pointermove", 35);
        await pointer(page, target, "pointerup", 35);
      }
      expect(await changes(page)).toEqual([]);
      expect(await touchBlocked(page)).toBe(false);
    } finally {
      await page.close();
    }
  }
}, 30_000);

if (browserName === "chromium")
  test("native touch scrolls before hold and moves without scrolling after hold", async () => {
    const { page, chip, errors } = await open({}, true);
    const session = await page.context().newCDPSession(page);
    try {
      const scroller = page.locator(".k2b-calendar-days__scroll");
      const position = () => scroller.evaluate((element) => element.scrollTop);
      let box = (await chip.boundingBox())!;
      const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const before = await position();
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x, y: start.y - 65 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForFunction(
        ([selector, before]) => document.querySelector(selector as string)!.scrollTop !== before,
        [".k2b-calendar-days__scroll", before],
      );
      expect(await changes(page)).toEqual([]);
      await chip.scrollIntoViewIfNeeded();
      await settled(page);
      box = (await chip.boundingBox())!;
      const heldStart = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const heldBefore = await position();
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [heldStart] });
      await held(page);
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: heldStart.x, y: heldStart.y + 40 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      expect((await changes(page))[0]?.slice(0, 2)).toEqual(["move", "owned"]);
      expect(await position()).toBe(heldBefore);
      expect(await page.evaluate(() => (window as unknown as Fixture).opens)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await session.detach();
      await page.close();
    }
  }, 30_000);

for (const ending of ["pointerup", "pointercancel", "blur", "Escape", "dispose"] as const) {
  test(`armed touch cleanup on ${ending} leaves no ghost, edit, or blocked scrolling`, async () => {
    const { page, chip } = await open({}, true);
    try {
      await pointer(page, chip, "pointerdown");
      await held(page);
      if (ending !== "pointerup") await pointer(page, chip, "pointermove", 30);
      if (ending === "pointerup" || ending === "pointercancel") await pointer(page, chip, ending);
      else if (ending === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      else if (ending === "Escape") await page.keyboard.press("Escape");
      else await page.evaluate(() => (window as unknown as Fixture).dispose());
      expect(await touchBlocked(page)).toBe(false);
      expect(await changes(page)).toEqual([]);
      expect(await page.locator(".k2b-calendar-ghost").count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);
}

for (const legacy of [false, true]) {
  test(`mouse still moves and resizes through the shared callbacks (legacy=${legacy})`, async () => {
    const { page, chip, errors } = await open({ legacy });
    try {
      let box = (await chip.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40, { steps: 4 });
      await page.mouse.up();
      expect((await changes(page))[0]?.slice(0, 2)).toEqual(["move", "owned"]);
      const grip = chip.locator("..").locator(legacy ? ".k2b-calendar-time-grid__resize" : '.k2b-calendar-band__grip[data-edge="end"]');
      await settled(page);
      box = (await grip.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40, { steps: 4 });
      await page.mouse.up();
      expect((await changes(page))[1]?.slice(0, 2)).toEqual(["resize", "owned"]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
}

for (const view of ["day", "week", "month"] as const) {
  test(`${view}: keyboard edits keep the event focused after the host updates its dates`, async () => {
    const { page, chip } = await open({ view, update: true });
    try {
      await chip.focus();
      const key = view === "month" ? "Alt+Shift+ArrowRight" : "Alt+ArrowDown";
      await page.keyboard.press(key);
      expect(await chip.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press(key);
      expect((await changes(page)).length).toBe(2);
      // The canonical server refresh arrives in a later task, after the optimistic update.
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            window.setTimeout(() => {
              (window as unknown as Fixture).refresh();
              done();
            }, 20),
          ),
      );
      expect(await chip.evaluate((element) => element === document.activeElement)).toBe(true);
      const next = page.getByRole("link", { name: "Next", exact: true });
      await next.focus();
      await page.evaluate(() => (window as unknown as Fixture).refresh());
      expect(await next.evaluate((element) => element === document.activeElement)).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);
}

if (browserName === "chromium") {
  for (const legacy of [false, true]) {
    test(`native touch taps open and held grips resize without scrolling (legacy=${legacy})`, async () => {
      const { page, chip, errors } = await open({ legacy }, true);
      const session = await page.context().newCDPSession(page);
      try {
        await chip.tap();
        expect(await page.evaluate(() => (window as unknown as Fixture).opens)).toEqual(["owned"]);
        const scroller = page.locator(legacy ? ".k2b-calendar-time-grid__scroll" : ".k2b-calendar-days__scroll");
        for (const edge of legacy ? (["end"] as const) : (["start", "end"] as const)) {
          const grip = chip
            .locator("..")
            .locator(legacy ? ".k2b-calendar-time-grid__resize" : `.k2b-calendar-band__grip[data-edge="${edge}"]`);
          if (!legacy) {
            const before = await page.evaluate(() => (window as unknown as Fixture).opens.length);
            await grip.tap();
            expect(await page.evaluate(() => (window as unknown as Fixture).opens.length)).toBe(before + 1);
          }
          await settled(page);
          const box = (await grip.boundingBox())!;
          const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          const beforeScroll = await scroller.evaluate((element) => element.scrollTop);
          await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
          await held(page);
          expect(await grip.getAttribute("data-touch-held")).toBe("true");
          await session.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: start.x, y: start.y + (edge === "end" ? 35 : -35) }],
          });
          await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          const edit = (await changes(page)).at(-1)!;
          expect(edit.slice(0, 2)).toEqual(["resize", "owned"]);
          if (edge === "end") {
            expect(edit[2]).toBe("2026-10-24T07:30:00.000Z");
            expect(new Date(edit[3]).getTime()).toBeGreaterThan(Date.parse("2026-10-24T08:30:00Z"));
          } else {
            expect(new Date(edit[2]).getTime()).toBeLessThan(Date.parse("2026-10-24T07:30:00Z"));
            expect(edit[3]).toBe("2026-10-24T08:30:00.000Z");
          }
          expect(await scroller.evaluate((element) => element.scrollTop)).toBe(beforeScroll);
          expect(await grip.getAttribute("data-touch-held")).toBeNull();
          expect(await touchBlocked(page)).toBe(false);
        }
        expect(errors).toEqual([]);
      } finally {
        await session.detach();
        await page.close();
      }
    }, 30_000);
  }
}
