import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// The top layer, layout near the viewport edges, touch input, and the phone
// media query decide where the card opens, none of which happy-dom models, so
// a real engine runs the shipped browser build.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "hover-card.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { HoverCard, ProgressPath } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const steps = [
  { label: "Received", detail: "Nov 7", done: true },
  { label: "Brought to returns", detail: "Nov 9", done: true },
  { label: "Booked in", detail: "Nov 9", done: true },
  { label: "Owner told", detail: "not yet", icon: "ti ti-mail" },
  { label: "Back or gone", detail: "not yet", icon: "ti ti-circle-check" },
];
const glyph = (text) => {
  const span = document.createElement("span");
  span.className = "glyph";
  span.textContent = text;
  return span;
};
const trigger = (id) =>
  createComponent(HoverCard.Trigger, {
    id,
    "aria-label": "Path of B7A02",
    title: "B7A02 Pewter jug",
    width: "32rem",
    get content() {
      return createComponent(ProgressPath, { steps, label: "Path" });
    },
    hint: "Dispose: the owner agreed.",
    get children() {
      return glyph(id);
    },
  });

const tall = () =>
  createComponent(HoverCard.Trigger, {
  id: "tall",
  "aria-label": "Long notes",
  title: "Notes",
  get content() {
    const list = document.createElement("div");
    list.className = "long";
    list.textContent = "A long note. ".repeat(400);
    return list;
  },
  hint: "The title and this line stay.",
  get children() {
    return glyph("tall");
  },
});

render(() => [trigger("top-left"), trigger("bottom-right"), tall()], document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the hover card fixture for the browser.");
const script = await build.outputs[0]!.text();

const html =
  "<!doctype html><html><head><meta name='viewport' content='width=device-width, initial-scale=1'>" +
  `<style>${css}</style><style>
    body { margin: 0; }
    #app { position: fixed; inset: 0; }
    #top-left { position: absolute; top: 24px; left: 24px; }
    #bottom-right { position: absolute; right: 12px; bottom: 16px; }
    #tall { position: absolute; top: 24px; left: 240px; }
    .glyph { display: block; width: 88px; height: 20px; }
    #below { position: absolute; top: 120px; left: 24px; }
  </style></head><body class="k2b-ui" data-theme="light">` +
  "<div id='app'></div><p id='below'>Text below</p>" +
  "</body></html>";

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (options: BrowserContextOptions) => {
  const page = await (await browser.newContext(options)).newPage();
  // Fake timers make the delays exact; Playwright's mouse needs no animation frames.
  await page.clock.install({ time: new Date("2026-11-14T09:00:00Z") });
  await page.setContent(html);
  await page.addScriptTag({ content: script });
  // An installed clock still follows real time until it is paused.
  await page.clock.pauseAt(new Date("2026-11-14T09:01:00Z"));
  return page;
};
const close = (page: Page) => page.context().close();

type Box = { top: number; left: number; right: number; bottom: number; width: number; height: number };
const box = (page: Page, selector: string) =>
  // settled: only opacity fades; the card's geometry never animates, and the paused clock's exact moment is the subject.
  page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const { top, left, right, bottom, width, height } = element.getBoundingClientRect();
    return { top, left, right, bottom, width, height };
  }, selector) as Promise<Box | null>;
/** The card that belongs to a trigger, by its description. */
const cardOf = (id: string) => `[id="${id}"] + .k2b-hover-card`;
const open = (page: Page, id: string) =>
  // settled: only opacity fades; the card's geometry never animates, and the paused clock's exact moment is the subject.
  page.evaluate((selector) => document.querySelector(selector)!.matches(":popover-open"), cardOf(id));
const layout = (page: Page) =>
  // settled: only opacity fades; the card's geometry never animates, and the paused clock's exact moment is the subject.
  page.evaluate(() =>
    [...document.querySelectorAll("#top-left, #bottom-right, #below, .glyph")].map((element) => {
      const { top, left, width, height } = element.getBoundingClientRect();
      return [top, left, width, height];
    }),
  );
const pointAt = async (page: Page, selector: string) => {
  const target = (await box(page, selector))!;
  await page.mouse.move(target.left + target.width / 2, target.top + target.height / 2);
};

describe("HoverCard", () => {
  test("opens below its control, start-aligned, in its first frame's place, without moving the page", async () => {
    const page = await load(desktop);
    try {
      const before = await layout(page);
      await pointAt(page, "#top-left");
      await page.clock.runFor(399);
      expect(await open(page, "top-left")).toBe(false);
      await page.clock.runFor(2);
      expect(await open(page, "top-left")).toBe(true);

      const first = (await box(page, cardOf("top-left")))!;
      const anchor = (await box(page, "#top-left"))!;
      expect(first.left).toBe(anchor.left);
      expect(first.top).toBe(anchor.bottom + 6);
      expect(first.width).toBe(512);
      await page.clock.runFor(500);
      expect(await box(page, cardOf("top-left"))).toEqual(first);
      expect(await layout(page)).toEqual(before);
    } finally {
      await close(page);
    }
  });

  test("flips above and stays inside the viewport at the bottom right edge, and stays open over the card", async () => {
    const page = await load(desktop);
    try {
      const before = await layout(page);
      await pointAt(page, "#bottom-right");
      await page.clock.runFor(400);
      expect(await open(page, "bottom-right")).toBe(true);
      const card = (await box(page, cardOf("bottom-right")))!;
      const anchor = (await box(page, "#bottom-right"))!;
      expect(card.bottom).toBe(anchor.top - 6);
      expect(card.right).toBe(1440 - 8);
      expect(card.top).toBeGreaterThanOrEqual(8);
      expect(await layout(page)).toEqual(before);

      // Up across the gap into the card, then rest there.
      await page.mouse.move(anchor.left + anchor.width / 2, anchor.top - 3);
      await page.mouse.move(card.left + 40, card.top + 40);
      await page.clock.runFor(1_000);
      expect(await open(page, "bottom-right")).toBe(true);
      expect(await box(page, cardOf("bottom-right"))).toEqual(card);

      await page.mouse.move(700, 300);
      await page.clock.runFor(199);
      expect(await open(page, "bottom-right")).toBe(true);
      await page.clock.runFor(2);
      expect(await open(page, "bottom-right")).toBe(false);
    } finally {
      await close(page);
    }
  });

  test("a card taller than the screen stays inside it and scrolls its body, keeping title and hint", async () => {
    const page = await load({ viewport: { width: 1024, height: 480 } });
    try {
      await pointAt(page, "#tall");
      await page.clock.runFor(400);
      expect(await open(page, "tall")).toBe(true);
      const card = (await box(page, cardOf("tall")))!;
      expect(card.top).toBeGreaterThanOrEqual(8);
      expect(card.bottom).toBeLessThanOrEqual(480 - 8);
      // settled: the card's geometry never animates; the paused clock's exact moment is the subject.
      const body = await page.evaluate((selector) => {
        const element = document.querySelector<HTMLElement>(`${selector} .k2b-hover-card__body`)!;
        return { scrolls: element.scrollHeight > element.clientHeight, overflow: getComputedStyle(element).overflowY };
      }, cardOf("tall"));
      expect(body).toEqual({ scrolls: true, overflow: "auto" });
      const hint = (await box(page, `${cardOf("tall")} .k2b-hover-card__hint`))!;
      expect(hint.bottom).toBeLessThanOrEqual(card.bottom);
    } finally {
      await close(page);
    }
  });

  test("on a phone a pen tap turns a card its hover opened into a bottom sheet", async () => {
    const page = await load(phone);
    try {
      await page.evaluate(() =>
        document.getElementById("top-left")!.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "pen" })),
      );
      await page.clock.runFor(400);
      expect(await open(page, "top-left")).toBe(true);
      // settled: reads an attribute, not geometry, at the paused clock's exact moment.
      expect(await page.evaluate((selector) => document.querySelector(selector)!.hasAttribute("data-sheet"), cardOf("top-left"))).toBe(
        false,
      );
      await page.evaluate(() => {
        const trigger = document.getElementById("top-left")!;
        trigger.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "pen", bubbles: true }));
        trigger.click();
      });
      expect(await open(page, "top-left")).toBe(true);
      const sheet = (await box(page, cardOf("top-left")))!;
      expect([sheet.left, sheet.width, sheet.bottom]).toEqual([0, 390, 844]);
    } finally {
      await close(page);
    }
  });

  test("on a phone a tap opens a bottom sheet with the steps one below the other, and a tap outside closes it", async () => {
    const page = await load(phone);
    try {
      const before = await layout(page);
      const anchor = (await box(page, "#top-left"))!;
      await page.touchscreen.tap(anchor.left + anchor.width / 2, anchor.top + anchor.height / 2);
      expect(await open(page, "top-left")).toBe(true);
      const sheet = (await box(page, cardOf("top-left")))!;
      expect([sheet.left, sheet.width, sheet.bottom]).toEqual([0, 390, 844]);
      // settled: the sheet does not animate its geometry; this reads the layout right after the tap.
      const steps = await page.evaluate(
        (selector) =>
          [...document.querySelectorAll(`${selector} .k2b-progress-path__step`)].map((step) => step.getBoundingClientRect().top),
        cardOf("top-left"),
      );
      expect(steps).toHaveLength(5);
      for (let index = 1; index < steps.length; index++) expect(steps[index]!).toBeGreaterThan(steps[index - 1]!);
      expect(await layout(page)).toEqual(before);

      // A second tap on the trigger closes it, a tap opens it again, and a tap outside closes it.
      await page.touchscreen.tap(anchor.left + anchor.width / 2, anchor.top + anchor.height / 2);
      expect(await open(page, "top-left")).toBe(false);
      await page.touchscreen.tap(anchor.left + anchor.width / 2, anchor.top + anchor.height / 2);
      expect(await open(page, "top-left")).toBe(true);
      await page.touchscreen.tap(200, 300);
      expect(await open(page, "top-left")).toBe(false);
    } finally {
      await close(page);
    }
  });
});
