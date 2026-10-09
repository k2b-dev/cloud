import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type axeCore from "axe-core";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";
import type { TimelineController } from "./Timeline";

// Axis choice, lanes, scrolling, and the reading position are layout results, so a real engine renders the shipped
// stylesheet. The fixture loads a week around Thursday 8 October 2026, 14:20, Europe/Berlin. Each test drives real
// pages, so it gets the 30 s budget of the other page-driving suites rather than the 5 s unit default.
declare global {
  interface Window {
    axe?: typeof axeCore;
  }
}

const packageRoot = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(packageRoot, "dist/styles.css"), "utf8");
const axeSource = readFileSync(Bun.resolveSync("axe-core/axe.min.js", import.meta.dir), "utf8");
const entry = resolve(import.meta.dir, "timeline.fixture.ts");
const fixture = `
import { batch, createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Timeline } from ${JSON.stringify(resolve(packageRoot, "dist/browser/index.js"))};
import { timelineFrom, timelineItems, timelineNow, timelineTo, timelineZone } from ${JSON.stringify(resolve(packageRoot, "test/timeline-data.ts"))};

const options = window.fixtureOptions ?? {};
const DAY = 86_400_000;
const shift = (value, days) => new Date(new Date(value).getTime() + days * DAY).toISOString();
const week = (items, days, tag) =>
  items.map((item) => ({ ...item, id: item.id + tag, start: shift(item.start, days), ...(item.end ? { end: shift(item.end, days) } : {}) }));
// A year of six meetings a day, for bounded rendering.
const year = () =>
  Array.from({ length: 365 * 6 }, (_, index) => {
    const day = Math.floor(index / 6);
    const start = new Date(Date.UTC(2026, 9, 7 + day, 6 + (index % 6) * 2));
    return { id: "y" + index, label: "Meeting " + index, start: start.toISOString(), end: new Date(start.getTime() + 90 * 60_000).toISOString() };
  });
// A quiet weekend with nightly backups and tasks due at 23:59, and a third all-day item on Thursday.
const nights = [
  ...["10T02:00", "11T02:00", "12T02:00"].map((at, index) => ({ id: "b" + index, label: "Backup", start: "2026-10-" + at + ":00+02:00", kind: "marker" })),
  ...["10T23:59", "11T23:59"].map((at, index) => ({ id: "d" + index, label: "Report " + index, start: "2026-10-" + at + ":00+02:00", kind: "marker", checked: false })),
  { id: "h", label: "Harbour festival", start: "2026-10-08", allDay: true },
];
const base = timelineItems.filter((item) => !(options.drop ?? []).includes(item.id));
// What the week before holds: the same week, nothing, or one meeting on the morning of the first loaded day.
const before = (count) =>
  options.earlier === "empty"
    ? []
    : options.earlier === "wednesday"
      ? count === 1 ? [{ id: "w", label: "Planning", start: "2026-10-07T10:00:00+02:00", end: "2026-10-07T11:00:00+02:00" }] : []
      : week(timelineItems, -7 * count, "-" + count);
const [from, setFrom] = createSignal(options.from ?? timelineFrom);
const [to, setTo] = createSignal(options.long ? shift(timelineTo, 358) : timelineTo);
const [items, setItems] = createSignal(options.long ? year() : options.nights ? [...base, ...nights] : base);
window.loads = [];
window.activated = [];
window.toggled = [];
let gates = [];
let earlier = 0;
let later = 0;
const gate = (apply) => new Promise((done) => gates.push(() => (apply(), done())));
const started = performance.now();
render(
  () =>
    createComponent(Timeline, {
      get items() {
        return items();
      },
      get from() {
        return from();
      },
      get to() {
        return to();
      },
      now: timelineNow,
      timeZone: timelineZone,
      label: "Product team",
      onActivate: options.noActivate ? undefined : (item) => window.activated.push(item.id),
      onToggle: (item, checked) => {
        window.toggled.push([item.id, checked]);
        setItems((current) => current.map((value) => (value.id === item.id ? { ...value, checked } : value)));
      },
      controller: (controller) => (window.timeline = controller),
      onLoadEarlier: options.load
        ? () => {
            window.loads.push("earlier");
            return gate(() => {
              earlier++;
              batch(() => {
                setItems((current) => [...before(earlier), ...current]);
                setFrom(shift(from(), -7));
              });
            });
          }
        : undefined,
      onLoadLater: options.load
        ? () => {
            window.loads.push("later");
            return gate(() => {
              later++;
              batch(() => {
                setItems((current) => [...current, ...week(timelineItems, 7 * later, "+" + later)]);
                setTo(shift(to(), 7));
              });
            });
          }
        : undefined,
    }),
  document.getElementById("host"),
);
window.mountTime = performance.now() - started;
window.release = () => {
  const waiting = gates;
  gates = [];
  for (const done of waiting) done();
  return waiting.length;
};
window.viewport = () => document.querySelector(".k2b-timeline__viewport");
window.entry = (id) => document.querySelector('[data-entry-id="' + id + '"]');
// The place of an item on screen in every frame, to prove that nothing the reader sees moves.
let record = null;
const sample = () => {
  if (!record) return;
  const box = window.entry(record.id)?.getBoundingClientRect();
  record.places.push(box ? [box.left, box.top] : [NaN, NaN]);
  requestAnimationFrame(sample);
};
window.probe = {
  start(id) {
    record = { id, places: [] };
    sample();
  },
  stop() {
    const places = record.places;
    record = null;
    const [left, top] = places[0];
    return { frames: places.length, drift: Math.max(...places.map(([x, y]) => Math.max(Math.abs(x - left), Math.abs(y - top)))) };
  },
};
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the Timeline fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const desktop: BrowserContextOptions = { viewport: { width: 1280, height: 760 } };
const ipad: BrowserContextOptions = { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

type Options = {
  load?: boolean;
  long?: boolean;
  theme?: "dark";
  tallPage?: boolean;
  /** Start of the loaded range instead of Wednesday 18:00. */
  from?: string;
  /** Fixture items to leave out. */
  drop?: readonly string[];
  /** What loading the week before adds: the same week (default), nothing, or a meeting on the first loaded day. */
  earlier?: "week" | "empty" | "wednesday";
  /** Adds a weekend of night items and a third all-day item on Thursday. */
  nights?: boolean;
  noActivate?: boolean;
};

const open = async (context: BrowserContextOptions, options: Options = {}): Promise<Page> => {
  const page = await browser.newPage(context);
  const host = options.tallPage ? "height: 32rem" : "height: 100vh";
  await page.setContent(
    `<!doctype html><html lang="en"><head><title>Timeline</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>` +
      `<style>html, body { margin: 0 } #host { ${host}; display: flex; flex-direction: column; background: var(--k2b-surface) }</style></head>` +
      `<body class="k2b-ui${options.theme === "dark" ? " k2b-dark" : ""}"><main><h1 class="k2b-sr-only">Timeline</h1><div id="host"></div>` +
      `${options.tallPage ? '<div style="height: 200vh"></div>' : ""}</main>` +
      `<script>window.fixtureOptions = ${JSON.stringify(options)}</script><script>${script}</script></body></html>`,
  );
  await page.waitForFunction(() => document.querySelector(".k2b-timeline__slot"));
  return page;
};
const frames = (page: Page, count = 3) =>
  page.evaluate(
    (n) =>
      new Promise<void>((done) => {
        let left = n;
        const next = () => (--left <= 0 ? done() : requestAnimationFrame(next));
        requestAnimationFrame(next);
      }),
    count,
  );
const axis = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.querySelector(".k2b-timeline__viewport")!).getPropertyValue("--k2b-timeline-axis").trim());
const box = (page: Page, id: string) =>
  page.evaluate((value) => {
    const rect = document.querySelector(`[data-entry-id="${value}"]`)!.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }, id);
const focusedId = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.entryId);
const inView = (page: Page, id: string) =>
  page.evaluate((value) => {
    const port = document.querySelector(".k2b-timeline__viewport")!.getBoundingClientRect();
    const rect = document.querySelector(`[data-entry-id="${value}"]`)!.getBoundingClientRect();
    return rect.left >= port.left - 1 && rect.right <= port.right + 1 && rect.top >= port.top - 1 && rect.bottom <= port.bottom + 1;
  }, id);
type Fixture = {
  timeline: TimelineController;
  loads: string[];
  toggled: Array<[string, boolean]>;
  release: () => number;
  probe: { start: (id: string) => void; stop: () => { frames: number; drift: number } };
};
const loads = (page: Page) => page.evaluate(() => (window as unknown as Fixture).loads);
const release = (page: Page) => page.evaluate(() => (window as unknown as Fixture).release());
const probeStart = (page: Page, id: string) => page.evaluate((value) => (window as unknown as Fixture).probe.start(value), id);
const probeStop = (page: Page) => page.evaluate(() => (window as unknown as Fixture).probe.stop());
const scrollWidth = (page: Page) => page.evaluate(() => document.querySelector(".k2b-timeline__viewport")!.scrollWidth);
/** An item well inside the view. */
const watchedItem = (page: Page) =>
  page.evaluate(() => {
    const port = document.querySelector(".k2b-timeline__viewport")!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>("[data-entry-id]")].find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left > port.left + 150 && rect.right < port.right - 150 && rect.top >= port.top && rect.bottom <= port.bottom;
    })!.dataset.entryId!;
  });
/** Scrolls forward until the timeline renders an entry, then puts it in the middle of the view. */
const reveal = (page: Page, id: string) =>
  page.evaluate(async (value) => {
    const port = document.querySelector(".k2b-timeline__viewport")!;
    const find = () => document.querySelector(`[data-entry-id="${value}"]`);
    for (let step = 0; step < 50 && !find(); step++) {
      port.scrollBy({ left: 400, top: 400 });
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    }
    find()!.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  }, id);
/** Releases the first load at the start, then scrolls near the start again, where the week before that is asked for. */
const nearStartWithLoadPending = async (page: Page) => {
  await page.waitForFunction(() => (window as unknown as Fixture).loads.length === 1);
  await release(page);
  await frames(page, 4);
  await page.evaluate(() => {
    document.querySelector(".k2b-timeline__viewport")!.scrollLeft = 600;
  });
  await page.waitForFunction(() => (window as unknown as Fixture).loads.length === 2);
};
const scrollPosition = (page: Page) =>
  page.evaluate(() => {
    const port = document.querySelector(".k2b-timeline__viewport")!;
    return { left: port.scrollLeft, top: port.scrollTop, page: window.scrollY };
  });

describe(`@k2b/ui Timeline in ${browserName}`, () => {
  test("runs horizontally in a wide container and turns vertical in a narrow one, from the stylesheet alone", async () => {
    const wide = await open(desktop);
    const narrow = await open(phone);
    try {
      expect(await axis(wide)).toBe("horizontal");
      // 16:00–17:30 is one and a half hours of 54 px, less the gap between neighbours.
      expect(Math.round((await box(wide, "e6")).width)).toBe(78);
      const [workshop, offer] = [await box(wide, "e3"), await box(wide, "e4")];
      expect(Math.round(workshop.height)).toBe(Math.round(offer.height));
      expect(offer.top).toBeGreaterThan(workshop.top + workshop.height);

      expect(await axis(narrow)).toBe("vertical");
      expect(Math.round((await box(narrow, "e6")).height)).toBe(70);
      const [phoneWorkshop, phoneOffer] = [await box(narrow, "e3"), await box(narrow, "e4")];
      expect(phoneOffer.left).toBeGreaterThan(phoneWorkshop.left + phoneWorkshop.width);
      const overflow = await narrow.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    } finally {
      await wide.close();
      await narrow.close();
    }
  }, 30_000);

  test("is one tab stop whose arrow keys walk the items across days and scroll only as far as needed", async () => {
    const page = await open({ ...desktop, reducedMotion: "reduce" });
    try {
      await page.keyboard.press("Tab");
      expect(await focusedId(page)).toBe("t1");
      const before = (await scrollPosition(page)).left;
      const walked: string[] = [];
      for (let step = 0; step < 6; step++) {
        await page.keyboard.press("ArrowRight");
        walked.push((await focusedId(page))!);
        // Without motion the scroll is done when the key is handled.
        expect(await inView(page, walked.at(-1)!)).toBe(true);
      }
      expect(walked).toEqual(["e6", "t2", "e7", "n1", "e8", "e9"]);
      expect((await scrollPosition(page)).left).toBeGreaterThan(before);
      await page.keyboard.press("PageDown");
      expect(await focusedId(page)).toBe("a3");
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".k2b-timeline")))).toBe(false);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("scrolls the focused item into view smoothly when motion is allowed", async () => {
    const page = await open(desktop);
    try {
      await page.keyboard.press("Tab");
      await page.keyboard.press("PageDown");
      expect(await focusedId(page)).toBe("n1");
      await page.waitForFunction(() => {
        const port = document.querySelector(".k2b-timeline__viewport")!.getBoundingClientRect();
        const rect = document.activeElement!.getBoundingClientRect();
        return rect.left >= port.left && rect.right <= port.right;
      });
    } finally {
      await page.close();
    }
  }, 30_000);

  test("Space checks a task or opens an item exactly once, and Enter on +n lists the hidden items", async () => {
    const page = await open({ ...desktop, reducedMotion: "reduce" });
    try {
      await page.keyboard.press("Tab");
      await page.keyboard.press("Space");
      expect(await page.evaluate(() => (window as unknown as { toggled: unknown[] }).toggled)).toEqual([["t1", true]]);
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Space");
      await frames(page);
      expect(await page.evaluate(() => (window as unknown as { activated: string[] }).activated)).toEqual(["e6"]);

      // Monday 10:00–12:00 holds two meetings beyond the third lane.
      await page.keyboard.press("PageDown");
      await page.keyboard.press("PageDown");
      for (let step = 0; step < 4; step++) await page.keyboard.press("ArrowRight");
      expect(await focusedId(page)).toBe("more:e14");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector("[role='menu']:popover-open"));
      const options = await page.evaluate(() =>
        [...document.querySelectorAll("[role='menu']:popover-open [role='menuitem']")].map((item) => item.textContent),
      );
      expect(options).toEqual(["Call with Weber print shop10:00–10:45", "Harbour office meeting10:15–12:00"]);
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => (window as unknown as { activated: string[] }).activated)).toEqual(["e6", "e14"]);
      expect(await focusedId(page)).toBe("more:e14");
    } finally {
      await page.close();
    }
  }, 30_000);

  for (const [name, context] of [
    ["horizontal", desktop],
    ["vertical", phone],
  ] as const) {
    test(`loading days before and after the view moves nothing the reader sees (${name})`, async () => {
      const page = await open({ ...context, reducedMotion: "reduce" }, { load: true });
      try {
        // At the start edge the timeline asks for the week before at once.
        await page.waitForFunction(() => (window as unknown as { loads: string[] }).loads.includes("earlier"));
        const watched = "e1";
        const before = await scrollPosition(page);
        await page.evaluate((id) => (window as unknown as { probe: { start: (id: string) => void } }).probe.start(id), watched);
        await frames(page, 2);
        await page.evaluate(() => (window as unknown as { release: () => number }).release());
        await frames(page, 4);
        const earlier = await page.evaluate(() =>
          (window as unknown as { probe: { stop: () => { frames: number; drift: number } } }).probe.stop(),
        );
        expect(earlier.frames).toBeGreaterThan(4);
        expect(earlier.drift).toBeLessThan(1);
        const after = await scrollPosition(page);
        expect(name === "horizontal" ? after.left : after.top).toBeGreaterThan(name === "horizontal" ? before.left : before.top);
        // The earlier week is out of view, so nothing else loads before the reader goes there.
        expect(await page.evaluate(() => (window as unknown as { loads: string[] }).loads)).toEqual(["earlier"]);

        // At the end edge the week after loads, and the end stays where it is.
        await page.evaluate(() => {
          const port = document.querySelector(".k2b-timeline__viewport")!;
          port.scrollTo({ left: port.scrollWidth, top: port.scrollHeight });
        });
        await page.waitForFunction(() => (window as unknown as { loads: string[] }).loads.includes("later"));
        const ending = await page.evaluate(() => {
          const ids = [...document.querySelectorAll<HTMLElement>("[data-entry-id]")].map((element) => element.dataset.entryId!);
          return ids.at(-1)!;
        });
        await page.evaluate((id) => (window as unknown as { probe: { start: (id: string) => void } }).probe.start(id), ending);
        await page.evaluate(() => (window as unknown as { release: () => number }).release());
        await frames(page, 4);
        const later = await page.evaluate(() => (window as unknown as { probe: { stop: () => { drift: number } } }).probe.stop());
        expect(later.drift).toBeLessThan(1);
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  for (const [axisName, context] of [
    ["horizontal", desktop],
    ["vertical", phone],
  ] as const) {
    for (const [name, options] of [
      ["from midnight, in a night", { from: "2026-10-08T00:00:00+02:00" }],
      ["on an empty first day", { from: "2026-10-07T00:00:00+02:00", drop: ["e1"], earlier: "empty" }],
      ["on a partly loaded first day whose morning is busy", { from: "2026-10-07T18:00:00+02:00", drop: ["e1"], earlier: "wednesday" }],
    ] as const) {
      test(`loading earlier days moves nothing the reader sees when the range starts ${name} (${axisName})`, async () => {
        const page = await open({ ...context, reducedMotion: "reduce" }, { load: true, ...options });
        try {
          await page.waitForFunction(() => (window as unknown as Fixture).loads.length === 1);
          // Thursday's stand-up, in view from the start on both axes.
          await probeStart(page, "e2");
          await frames(page, 2);
          expect(await release(page)).toBe(1);
          await frames(page, 4);
          expect((await probeStop(page)).drift).toBeLessThan(1);
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  }

  for (const [axisName, context] of [
    ["horizontal", desktop],
    ["vertical", phone],
  ] as const) {
    test(`stops asking for earlier days that only fold into the empty days at the start, until the reader comes back (${axisName})`, async () => {
      const page = await open(
        { ...context, reducedMotion: "reduce" },
        { load: true, from: "2026-10-07T00:00:00+02:00", drop: ["e1"], earlier: "empty" },
      );
      try {
        // An empty week folds into the fold at the start, so the reader stays near it; that must not ask for the next one.
        for (let round = 0; round < 4; round++) {
          await release(page);
          await frames(page, 4);
        }
        expect(await loads(page)).toEqual(["earlier"]);
        // Away from the start and back, the reader asks again.
        await page.evaluate(() => {
          const port = document.querySelector(".k2b-timeline__viewport")!;
          port.scrollTo({ left: port.scrollWidth / 2, top: port.scrollHeight / 2 });
        });
        await frames(page, 4);
        await page.evaluate(() => document.querySelector(".k2b-timeline__viewport")!.scrollTo({ left: 0, top: 0 }));
        await page.waitForFunction(() => (window as unknown as Fixture).loads.filter((edge) => edge === "earlier").length === 2);
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  test("a mouse wheel glides the strip by its notch, then stops and leaves other scrolls alone", async () => {
    const page = await open(desktop);
    try {
      const port = await page.evaluate(() => {
        const rect = document.querySelector(".k2b-timeline__viewport")!.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await page.mouse.move(port.x, port.y);
      await page.mouse.wheel(0, 100);
      await page.waitForFunction(() => document.querySelector(".k2b-timeline__viewport")!.scrollLeft >= 100);
      await frames(page, 10);
      expect((await scrollPosition(page)).left).toBe(100);
      // Nothing pulls a later scroll back to where the wheel went.
      await page.evaluate(() => {
        document.querySelector(".k2b-timeline__viewport")!.scrollLeft = 1500;
      });
      await frames(page, 30);
      expect((await scrollPosition(page)).left).toBe(1500);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("days that load while the wheel glides keep what the reader sees, and the glide still goes its whole way", async () => {
    const page = await open(desktop, { load: true });
    try {
      await nearStartWithLoadPending(page);
      const watched = await watchedItem(page);
      const [before, width] = [await box(page, watched), await scrollWidth(page)];
      await page.mouse.move(640, 400);
      await page.mouse.wheel(0, -100);
      await frames(page, 2);
      expect(await release(page)).toBe(1);
      await page.waitForFunction((value) => document.querySelector(".k2b-timeline__viewport")!.scrollWidth > value, width);
      await frames(page, 20);
      // Back by one notch: the item moved right by exactly that, and nothing else loaded.
      expect(Math.abs((await box(page, watched)).left - before.left - 100)).toBeLessThan(1);
      expect(await loads(page)).toEqual(["earlier", "earlier"]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("days that load while the reader scrolls wait until the scroll rests, then keep what the reader sees", async () => {
    const page = await open({ ...desktop, reducedMotion: "reduce" }, { load: true });
    try {
      await nearStartWithLoadPending(page);
      const width = await scrollWidth(page);
      // A scroll that keeps going, as momentum does: the load arrives in its middle and waits.
      const widths = await page.evaluate(async () => {
        const port = document.querySelector(".k2b-timeline__viewport")!;
        const seen: number[] = [];
        for (let frame = 0; frame < 30; frame++) {
          if (frame === 5) (window as unknown as Fixture).release();
          port.scrollLeft -= 4;
          await new Promise(requestAnimationFrame);
          seen.push(port.scrollWidth);
        }
        return seen;
      });
      expect(new Set(widths)).toEqual(new Set([width]));
      const watched = await watchedItem(page);
      await probeStart(page, watched);
      await page.waitForFunction((value) => document.querySelector(".k2b-timeline__viewport")!.scrollWidth > value, width);
      await frames(page, 4);
      expect((await probeStop(page)).drift).toBeLessThan(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("days that load as the strip starts to glide to a time wait until it arrives there", async () => {
    const page = await open(desktop, { load: true });
    try {
      await nearStartWithLoadPending(page);
      await frames(page, 12);
      const width = await scrollWidth(page);
      // The week before arrives before the smooth scroll reports its first frame; holding the view in place then would stop it.
      await page.evaluate(() => {
        const fixture = window as unknown as Fixture;
        fixture.timeline.scrollToTime("2026-10-12T08:30:00+02:00");
        fixture.release();
      });
      await page.waitForFunction((value) => document.querySelector(".k2b-timeline__viewport")!.scrollWidth > value, width);
      await frames(page, 4);
      // The time sits 16 px after the start of the view; Monday's stand-up there starts half its 3 px gap later.
      const offset = await page.evaluate(
        () =>
          (document.querySelector('[data-entry-id="e11"]')?.getBoundingClientRect().left ?? Number.NaN) -
          document.querySelector(".k2b-timeline__viewport")!.getBoundingClientRect().left,
      );
      expect(Math.abs(offset - 17.5)).toBeLessThan(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  // A finger that stays down needs a touch the page creates; WebKit's Touch constructor throws "Illegal constructor".
  test.skipIf(browserName === "webkit")(
    "days that load while a finger is on the strip wait until it lifts",
    async () => {
      const page = await open({ ...ipad, reducedMotion: "reduce" }, { load: true });
      try {
        await nearStartWithLoadPending(page);
        const width = await scrollWidth(page);
        await page.evaluate(() => {
          const target = document.querySelector(".k2b-timeline__track")!;
          const touch = new Touch({ identifier: 1, target, clientX: 400, clientY: 400 });
          target.dispatchEvent(new TouchEvent("touchstart", { touches: [touch], changedTouches: [touch], bubbles: true }));
          (window as unknown as { lift: () => void }).lift = () =>
            target.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [touch], bubbles: true }));
        });
        expect(await release(page)).toBe(1);
        await page.waitForTimeout(400);
        expect(await scrollWidth(page)).toBe(width);
        const watched = await watchedItem(page);
        await probeStart(page, watched);
        await page.evaluate(() => (window as unknown as { lift: () => void }).lift());
        await page.waitForFunction((value) => document.querySelector(".k2b-timeline__viewport")!.scrollWidth > value, width);
        await frames(page, 4);
        expect((await probeStop(page)).drift).toBeLessThan(1);
      } finally {
        await page.close();
      }
    },
    30_000,
  );

  for (const [axisName, context] of [
    ["horizontal", desktop],
    ["vertical", phone],
  ] as const) {
    test(`keeps a busy night or fold inside the strip and puts the rest behind +n (${axisName})`, async () => {
      const page = await open({ ...context, reducedMotion: "reduce" }, { nights: true });
      try {
        await reveal(page, "more:b1");
        for (const id of ["b0", "d0", "more:b1"]) expect(await inView(page, id)).toBe(true);
        expect(await page.evaluate(() => ["b1", "d1", "b2"].filter((id) => document.querySelector(`[data-entry-id="${id}"]`)))).toEqual([]);
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  test("a +n menu says when its items happen, and checks a task that only its checkbox may change", async () => {
    const page = await open({ ...phone, reducedMotion: "reduce" }, { nights: true, noActivate: true });
    const rows = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("[role='menu']:popover-open :is([role='menuitem'], [role='menuitemcheckbox'])")].map((row) => [
          row.getAttribute("role"),
          row.textContent,
        ]),
      );
    try {
      await page.click('[data-entry-id="more:a2"]');
      await page.waitForFunction(() => document.querySelector("[role='menu']:popover-open"));
      expect(await rows()).toEqual([
        ["menuitem", "October onboarding workshopAll day, Thu, Oct 8 – Fri, Oct 9"],
        ["menuitem", "Harbour festivalAll day, Thu, Oct 8"],
      ]);
      await page.keyboard.press("Escape");

      await reveal(page, "more:b1");
      await page.click('[data-entry-id="more:b1"]');
      await page.waitForFunction(() => document.querySelector("[role='menu']:popover-open"));
      expect(await rows()).toEqual([
        ["menuitem", "Backup02:00"],
        ["menuitemcheckbox", "Report 123:59"],
        ["menuitem", "Backup02:00"],
      ]);
      await page.click("[role='menu']:popover-open [role='menuitemcheckbox']");
      expect(await page.evaluate(() => (window as unknown as Fixture).toggled)).toEqual([["d1", true]]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("the wheel scrolls the strip sideways where it is the page's scroll area, and the page where the page scrolls", async () => {
    const primary = await open({ ...desktop, reducedMotion: "reduce" });
    const inPage = await open({ ...desktop, reducedMotion: "reduce" }, { tallPage: true });
    try {
      for (const page of [primary, inPage]) {
        const strip = await page.evaluate(() => {
          const rect = document.querySelector(".k2b-timeline__viewport")!.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        });
        await page.mouse.move(strip.x, strip.y);
      }
      await primary.mouse.wheel(0, 240);
      await primary.waitForFunction(() => document.querySelector(".k2b-timeline__viewport")!.scrollLeft > 0);
      expect((await scrollPosition(primary)).page).toBe(0);

      await inPage.mouse.wheel(0, 240);
      await inPage.waitForFunction(() => window.scrollY > 0);
      expect((await scrollPosition(inPage)).left).toBe(0);
      // A sideways gesture, such as a trackpad's, scrolls the strip natively everywhere.
      await inPage.mouse.wheel(240, 0);
      await inPage.waitForFunction(() => document.querySelector(".k2b-timeline__viewport")!.scrollLeft > 0);
    } finally {
      await primary.close();
      await inPage.close();
    }
  }, 30_000);

  for (const [name, context] of [
    ["iPad", ipad],
    ["phone", phone],
  ] as const) {
    test(`leaves panning, momentum, and pinch-zoom to the browser on touch (${name})`, async () => {
      const page = await open(context);
      try {
        expect(await axis(page)).toBe(name === "iPad" ? "horizontal" : "vertical");
        const styles = await page.evaluate(() => {
          const port = document.querySelector(".k2b-timeline__viewport")!;
          const item = document.querySelector(".k2b-timeline__item")!;
          const style = getComputedStyle(port);
          return {
            touch: [style.touchAction, getComputedStyle(item).touchAction],
            overflow: [style.overflowX, style.overflowY],
            overscroll: style.overscrollBehaviorX,
          };
        });
        expect(styles.touch).toEqual(["auto", "auto"]);
        expect(styles.overflow).toEqual(name === "iPad" ? ["auto", "hidden"] : ["hidden", "auto"]);
        // Sideways overscroll never turns into history navigation; vertical scrolling chains to the page.
        expect(styles.overscroll).toBe(name === "iPad" ? "contain" : "auto");
        const prevented = await page.evaluate(() => {
          const item = document.querySelector(".k2b-timeline__item")!;
          return ["touchstart", "touchmove", "touchend"].map((type) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            item.dispatchEvent(event);
            return event.defaultPrevented;
          });
        });
        expect(prevented).toEqual([false, false, false]);
        const target = await box(page, "t1");
        await page.touchscreen.tap(target.left + target.width / 2, target.top + Math.min(target.height / 2, 30));
        await page.waitForFunction(() => (window as unknown as { activated: string[] }).activated.length > 0);
        expect(await page.evaluate(() => (window as unknown as { activated: string[] }).activated)).toEqual(["t1"]);
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  test("keeps the day heading at the top edge while its day scrolls by on a phone", async () => {
    const page = await open({ ...phone, reducedMotion: "reduce" });
    try {
      await page.evaluate(() => {
        document.querySelector(".k2b-timeline__viewport")!.scrollTop = 900;
      });
      await frames(page);
      const stuck = await page.evaluate(() => {
        const port = document.querySelector(".k2b-timeline__viewport")!.getBoundingClientRect();
        const heading = [...document.querySelectorAll(".k2b-timeline__heading")].find(
          (element) => Math.abs(element.getBoundingClientRect().top - port.top) < 1,
        );
        return heading?.textContent;
      });
      expect(stuck).toBe("TodayThu, Oct 8");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("renders a year of items in a bounded window and fills it in while scrolling", async () => {
    const page = await open({ ...desktop, reducedMotion: "reduce" }, { long: true });
    try {
      const first = await page.evaluate(() => ({
        groups: document.querySelectorAll(".k2b-timeline__group").length,
        slots: document.querySelectorAll(".k2b-timeline__slot").length,
        mount: (window as unknown as { mountTime: number }).mountTime,
      }));
      console.log(`Timeline: a year of ${365 * 6} items mounts in ${first.mount.toFixed(0)} ms with ${first.groups} days rendered`);
      expect(first.groups).toBeLessThanOrEqual(8);
      expect(first.slots).toBeLessThanOrEqual(60);
      await page.evaluate(() => {
        const port = document.querySelector(".k2b-timeline__viewport")!;
        port.scrollLeft = port.scrollWidth / 2;
      });
      await page.waitForFunction(() =>
        [...document.querySelectorAll<HTMLElement>(".k2b-timeline__slot")].some((slot) => {
          const port = document.querySelector(".k2b-timeline__viewport")!.getBoundingClientRect();
          const rect = slot.getBoundingClientRect();
          return rect.right > port.left && rect.left < port.right;
        }),
      );
      const middle = await page.evaluate(() => document.querySelectorAll(".k2b-timeline__group").length);
      // The window moved: the days around the middle, plus the day that holds the tab stop.
      expect(middle).toBeLessThanOrEqual(9);
    } finally {
      await page.close();
    }
  }, 30_000);

  for (const [axisName, context] of [
    ["horizontal", desktop],
    ["vertical", phone],
  ] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`passes axe (${axisName}, ${theme})`, async () => {
        const page = await open(context, theme === "dark" ? { theme } : {});
        try {
          await page.addScriptTag({ content: axeSource });
          const violations = await page.evaluate(async () => {
            const result = await window.axe!.run(document, {
              runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
              resultTypes: ["violations"],
            });
            return result.violations.map(
              (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
            );
          });
          expect(violations).toEqual([]);
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  }
});
