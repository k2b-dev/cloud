import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// Faces, the link count, the calendar's own detail, and the to-do check need a real engine and the shipped CSS.
const packageRoot = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(packageRoot, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "calendar-event-fields.fixture.ts");
const fixture = `
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Calendar } from ${JSON.stringify(resolve(packageRoot, "dist/browser/index.js"))};
const options = window.fixtureOptions;
const team = ["Jonas Weber", "Helga Sommer", "Erika Berg", "Karl Klein", "Mira Lind"].map((name) => ({ name }));
const [items, setItems] = createSignal([
  { id: "round", title: "Team round", start: "2026-11-05T09:00:00+01:00", end: "2026-11-05T10:00:00+01:00", color: "blue", icon: "ti ti-users",
    attendees: team, links: [{ label: "Minutes", href: "/minutes" }, { label: "Video room", href: "https://video.example/room" }],
    href: "/events/round", data: { spaceItemId: "Item01", calendarEvent: "ignored", "bad-key": "ignored" } },
  { id: "todo", title: "Call the restorer", start: "2026-11-05T17:00:00+01:00", end: "2026-11-05T18:00:00+01:00", color: "emerald", checked: false },
  { id: "late", title: "Send the invoice", start: "2026-11-04T11:00:00+01:00", end: "2026-11-04T12:00:00+01:00", color: "amber", checked: false },
  { id: "done", title: "Pack the vase", start: "2026-11-04T14:00:00+01:00", end: "2026-11-04T15:00:00+01:00", color: "cyan", checked: true },
]);
const api = window.fieldsFixture = { activated: [] };
render(() => createComponent(Calendar, {
  view: options.view, date: "2026-11-05", get events() { return items(); }, timeZone: "Europe/Berlin", dayHours: options.view === "month" ? undefined : [7, 21],
  ...(options.activate ? { onEventActivate: (event) => api.activated.push(event.id) } : {}),
  onEventCheck: (event, checked) => setItems((all) => all.map((item) => (item.id === event.id ? { ...item, checked } : item))),
}), document.getElementById("host"));
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the event fields fixture.");
const script = await build.outputs[0]!.text();

/** Starts the page's wall clock at `at`; only `Date` changes, so timers and frames keep running. */
const pinPageClock = (at: number) => {
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
};

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (options: { view: "week" | "month"; activate?: boolean; width?: number; touch?: boolean }) => {
  const page = await browser.newPage({
    viewport: { width: options.width ?? 1280, height: 900 },
    timezoneId: "Europe/Berlin",
    reducedMotion: "reduce",
    hasTouch: options.touch,
    isMobile: options.touch && browserName === "chromium",
  });
  await page.evaluate(pinPageClock, Date.parse("2026-11-05T15:30:00+01:00"));
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>body{margin:0}#host{height:100vh;display:flex;flex-direction:column}#host>*{flex:1}</style></head><body class="k2b-ui"><div id="host"></div><script>window.fixtureOptions = ${JSON.stringify(options)}</script><script>${script}</script></body></html>`,
  );
  await page.locator('[data-calendar-event][aria-label^="Team round"]').first().waitFor();
  return page;
};
const entryOf = (page: Page, title: string) => page.locator(`[data-calendar-event][aria-label^="${title}"]`).first();

describe(`calendar event fields in ${browserName}`, () => {
  test("a band shows three faces and the rest as +n, the link count, its icon, and data attributes; the time stays whole", async () => {
    const page = await open({ view: "week" });
    try {
      const round = entryOf(page, "Team round");
      const look = await round.evaluate((element) => {
        const meta = element.querySelector<HTMLElement>(".k2b-calendar-event__meta")!;
        return {
          faces: element.querySelectorAll(".k2b-avatar").length,
          more: element.querySelector(".k2b-avatar-stack__more")?.textContent,
          links: element.querySelector(".k2b-calendar-event__links")?.textContent,
          icon: element.querySelector(".k2b-calendar-event__title > .k2b-calendar-event__icon.ti-users") !== null,
          timeWhole: meta.scrollWidth <= meta.clientWidth,
          item: element.getAttribute("data-space-item-id"),
          refused: element.hasAttribute("data-calendar-event") && element.getAttribute("data-calendar-event") === "",
          label: element.getAttribute("aria-label"),
        };
      });
      expect(look).toEqual({
        faces: 3,
        more: "+2",
        links: "2",
        icon: true,
        timeWhole: true,
        item: "Item01",
        refused: true,
        label: "Team round, 09:00 to 10:00, 5 people, 2 links",
      });
    } finally {
      await page.close();
    }
  }, 30_000);

  test("the month shows no faces and no link count; its day list shows one face", async () => {
    const page = await open({ view: "month" });
    try {
      const round = entryOf(page, "Team round");
      expect(await round.locator(".k2b-avatar, .k2b-calendar-event__links").count()).toBe(0);
      await page.locator('[data-calendar-day-key="2026-11-05"]').focus();
      await page.keyboard.press(" ");
      const listed = page.locator('.k2b-calendar-day-list [data-calendar-event][aria-label^="Team round"]');
      await listed.waitFor();
      expect(await listed.locator(".k2b-avatar").count()).toBe(1);
      expect(await listed.locator(".k2b-avatar-stack__more").count()).toBe(0);
      expect(await listed.locator(".k2b-calendar-event__links").textContent()).toBe("2");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("done strikes through in the month, and an open entry in the past turns red there too", async () => {
    const page = await open({ view: "month" });
    try {
      const state = (title: string) =>
        entryOf(page, title).evaluate((element) => ({
          done: element.getAttribute("data-done"),
          overdue: element.getAttribute("data-overdue"),
          line: getComputedStyle(element.querySelector(".k2b-calendar-event__title")!).textDecorationLine,
          label: element.getAttribute("aria-label"),
        }));
      expect(await state("Pack the vase")).toMatchObject({ done: "true", overdue: null, line: "line-through" });
      expect(await state("Send the invoice")).toMatchObject({
        done: null,
        overdue: "true",
        label: "Send the invoice, 11:00 to 12:00, overdue",
      });
      expect(await state("Call the restorer")).toMatchObject({ done: null, overdue: null });
    } finally {
      await page.close();
    }
  }, 30_000);

  test("without onEventActivate an entry opens the calendar's detail; Escape closes it and returns the focus", async () => {
    const page = await open({ view: "week" });
    try {
      const round = entryOf(page, "Team round");
      // A link with a modifier still opens where the reader asked: the calendar leaves that click alone. The page stops
      // the navigation itself, after the calendar's own handler, so the test stays on its page.
      const leftAlone = await round.evaluate(
        (element) =>
          new Promise<boolean>((done) => {
            window.addEventListener(
              "click",
              (click) => {
                done(!click.defaultPrevented);
                click.preventDefault();
              },
              { once: true },
            );
            element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
          }),
      );
      expect(leftAlone).toBe(true);
      expect(await page.locator('.k2b-calendar-popover[data-kind="event"]:popover-open').count()).toBe(0);
      await round.click();
      const detail = page.locator('.k2b-calendar-popover[data-kind="event"]');
      await detail.waitFor();
      expect(await detail.getAttribute("aria-label")).toBe("Details: Team round");
      expect(await detail.locator(".k2b-calendar-detail__people li").allTextContents()).toEqual([
        "JWJonas Weber",
        "HSHelga Sommer",
        "EBErika Berg",
        "KKKarl Klein",
        "MLMira Lind",
      ]);
      expect(
        await detail.locator(".k2b-calendar-detail__links a").evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
      ).toEqual(["/minutes", "https://video.example/room"]);
      expect(await detail.getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/events/round");
      expect(await round.getAttribute("data-selected")).toBe("true");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('.k2b-calendar-popover[data-kind="event"]:popover-open'));
      expect(await round.evaluate((element) => element === document.activeElement)).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("with onEventActivate the host opens the entry and the calendar draws no detail", async () => {
    const page = await open({ view: "week", activate: true });
    try {
      await entryOf(page, "Team round").click();
      expect(await page.evaluate(() => (window as unknown as { fieldsFixture: { activated: string[] } }).fieldsFixture.activated)).toEqual([
        "round",
      ]);
      expect(await page.locator('.k2b-calendar-popover[data-kind="event"]').count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("the check is a ring in the title's line inside the band, and checking it moves nothing", async () => {
    const page = await open({ view: "week" });
    try {
      const band = page.locator('.k2b-calendar-band[data-calendar-entry="todo"]');
      const check = band.locator('button.k2b-calendar-check[role="checkbox"]');
      const geometry = () =>
        band.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const ring = element.querySelector(".k2b-calendar-check circle")!.getBoundingClientRect();
          const title = element.querySelector(".k2b-calendar-event__title")!.getBoundingClientRect();
          const line = Number.parseFloat(getComputedStyle(element.querySelector(".k2b-calendar-event__title")!).lineHeight);
          return {
            inside: ring.left - box.left >= 4 && ring.top - box.top >= 4,
            inLine: Math.abs(ring.top + ring.height / 2 - (title.top + line / 2)) <= 1.5,
            beforeTitle:
              ring.right <=
              title.left + Number.parseFloat(getComputedStyle(element.querySelector(".k2b-calendar-event")!).paddingInlineStart),
            places: [ring.left, ring.top, title.left, title.top].map(Math.round),
          };
        });
      const before = await geometry();
      expect(before).toMatchObject({ inside: true, inLine: true, beforeTitle: true });
      expect(await check.getAttribute("aria-checked")).toBe("false");
      expect(await check.getAttribute("aria-label")).toBe("Done: Call the restorer");
      await check.click();
      await page.waitForFunction(
        () => document.querySelector('[data-calendar-entry="todo"] .k2b-calendar-check')?.getAttribute("aria-checked") === "true",
      );
      expect((await geometry()).places).toEqual(before.places);
    } finally {
      await page.close();
    }
  }, 30_000);

  if (browserName === "chromium")
    test("on a touch screen the check reaches 44 px without taking room", async () => {
      const page = await open({ view: "week", touch: true, width: 820 });
      try {
        const reach = await page.locator('.k2b-calendar-band[data-calendar-entry="todo"] button.k2b-calendar-check').evaluate((element) => {
          const before = getComputedStyle(element, "::before");
          return { width: before.width, height: before.height, box: Math.round(element.getBoundingClientRect().width) };
        });
        expect(reach).toEqual({ width: "44px", height: "44px", box: 24 });
      } finally {
        await page.close();
      }
    }, 30_000);
});
