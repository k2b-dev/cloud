import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../ui/test/browser";
import { MAIL_V2_NOW } from "./mail-v2.browser-clock";

// "Später" and "Erinnere mich" of Mail's v2 reader: each opens a submenu of times (today at 17:00 while that is ahead,
// tomorrow at 8:00, the next week's Monday at 8:00) and "Datum und Uhrzeit …". A time goes through the same calls as
// before: the conversation's collaboration for "Später anzeigen", the person's reminder for "Erinnere mich". The
// fixture's clock is Friday, 10:00, in UTC, so the next week is "Montag".
setSystemTime(new Date(MAIL_V2_NOW));
const { startMailV2Server, MAIL_V2_PATH } = await import("./mail-v2.browser-server");

/** Pins only the page's Date to the server's frozen instant, so SSR and hydration name the same day (timers run). */
const pinPageClock = (at: number) => {
  const RealDate = Date;
  const offset = at - RealDate.now(); // real clock: the page's distance to the pinned instant
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0)
        super(RealDate.now() + offset); // real clock: flows from the pinned instant
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now() {
      return RealDate.now() + offset; // real clock: flows from the pinned instant
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
};

let server: Awaited<ReturnType<typeof startMailV2Server>>;
let browser: Browser;
beforeAll(async () => {
  server = await startMailV2Server({ now: () => Date.parse(MAIL_V2_NOW) });
  browser = await launchBrowser();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

type Sent = { method: string; path: string; body: Record<string, unknown> };

/** Opens the demo conversation and answers the collaboration and reminder calls as Mail's server does. */
const open = async (width = 1440) => {
  const page = await browser.newPage({ viewport: { width, height: width < 768 ? 844 : 900 }, hasTouch: width < 768 });
  const errors = pageErrors(page);
  const sent: Sent[] = [];
  await page.route(/\/conversations\/Demo01\/(collaboration|reminder)$/, async (route) => {
    const request = route.request();
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    const path = new URL(request.url()).pathname;
    sent.push({ method: request.method(), path, body });
    const at = new Date(Date.parse(MAIL_V2_NOW)).toISOString();
    await route.fulfill({
      json: path.endsWith("/reminder")
        ? {
            id: "DemoReminder1",
            conversationId: "Demo01",
            userId: "user-mira",
            dueAt: body.dueAt,
            state: "pending",
            revision: 1,
            createdAt: at,
            updatedAt: at,
          }
        : { conversationId: "Demo01", assignees: [], workStatus: "waiting", snoozedUntil: body.snoozedUntil ?? null, revision: 2 },
    });
  });
  await page.addInitScript(pinPageClock, Date.parse(MAIL_V2_NOW));
  await page.goto(`${server.url}${MAIL_V2_PATH}?conversation=Demo01`);
  await page.waitForFunction(() => document.documentElement.dataset.mailV2Ready === "true", undefined, { timeout: 30_000 });
  return { page, errors, sent };
};

const head = (page: Page) => page.locator('[data-k2-part="Pane"][data-detail] > [data-slot="head"]');
/** The open menus, outermost first (a submenu is a menu of its own). */
const menus = (page: Page) => page.locator('[role="menu"]');
/** How many menus are open (a submenu is a menu of its own). */
const openMenus = (page: Page, count: number) =>
  page.waitForFunction((count) => document.querySelectorAll('[role="menu"]').length === count, count, { timeout: 5_000 });
/** The entries of the open menu at `level` (0 the outermost): their words, and the hint at their end. */
const entries = (page: Page, level: number) =>
  page
    .locator('[role="menu"]')
    .nth(level)
    .locator('[role="menuitem"]')
    .evaluateAll((items) =>
      items.map((item) =>
        [item.querySelector(".k2-mi-label")?.textContent, item.querySelector(".k2-mi-meta")?.textContent].filter(Boolean).join(" · "),
      ),
    );
/**
 * Waits until the menu's sheet rests: slid in all the way, its bottom on the bottom of the window, its top still for
 * five frames. A step changes the sheet's height and it glides to its new place; a tap while it moves scrolls the
 * sheet, which takes that for a swipe down and closes (seen on slow CI runners).
 */
const sheetAtRest = (page: Page) =>
  page.waitForFunction(
    () => {
      const state = window as unknown as { sheetTop?: number; sheetStill?: number };
      const sheet = document.querySelector<HTMLElement>('.k2-menu[data-presentation="sheet"]:not([data-nested])');
      const box = sheet?.getBoundingClientRect();
      const placed = !!box && sheet?.style.getPropertyValue("--drawer-progress") === "1" && Math.round(box.bottom) === window.innerHeight;
      state.sheetStill = placed && box?.top === state.sheetTop ? (state.sheetStill ?? 0) + 1 : 0;
      state.sheetTop = box?.top;
      return (state.sheetStill ?? 0) >= 5;
    },
    undefined,
    { polling: "raf", timeout: 5_000 },
  );
/** Waits until the fixture got `count` calls. */
const calls = async (sent: Sent[], count: number) => {
  for (let tries = 0; sent.length < count && tries < 100; tries += 1) await Bun.sleep(50);
  expect(sent.length).toBe(count);
};

describe("Mail v2: Später and Erinnere mich offer times", () => {
  test("Später anzeigen opens its times to the side; the keys walk in and out; a time snoozes the conversation", async () => {
    const { page, errors, sent } = await open();
    try {
      await head(page).getByRole("button", { name: "Später" }).click();
      await openMenus(page, 1);
      expect(await entries(page, 0)).toEqual(["Später anzeigen", "Erinnere mich"]);
      expect(await page.getByRole("menuitem", { name: "Später anzeigen" }).getAttribute("aria-haspopup")).toBe("menu");
      // The keys: the arrow right opens the times and enters them, the arrow left goes back to the entry.
      await page.getByRole("menuitem", { name: "Später anzeigen" }).focus();
      await page.keyboard.press("ArrowRight");
      await openMenus(page, 2);
      expect(await entries(page, 1)).toEqual([
        "Heute, 17:00",
        "Morgen, 8:00 · Sa., 28. Nov.",
        "Montag, 8:00 · 30. Nov.",
        "Datum und Uhrzeit …",
      ]);
      await page.keyboard.press("ArrowLeft");
      await openMenus(page, 1);
      expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Später anzeigen");
      // A time chosen with the keys snoozes the conversation until then, through the same call as v1's form.
      await page.keyboard.press("ArrowRight");
      await openMenus(page, 2);
      await page.keyboard.press("ArrowDown");
      expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Morgen, 8:00");
      await page.keyboard.press("Enter");
      await openMenus(page, 0);
      await calls(sent, 1);
      expect(sent[0]).toMatchObject({ method: "PATCH", body: { snoozedUntil: "2026-11-28T08:00:00.000Z", expectedRevision: 1 } });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("Datum und Uhrzeit … opens the calendar beside the times; a past time is refused, a later one sets the reminder", async () => {
    const { page, errors, sent } = await open();
    try {
      await head(page).getByRole("button", { name: "Später" }).click();
      await page.getByRole("menuitem", { name: "Erinnere mich" }).hover();
      await page.getByRole("menuitem", { name: "Datum und Uhrzeit …" }).hover();
      const calendar = page.locator('[data-k2-part="DatePicker"]');
      await calendar.waitFor();
      // beside the times, as a submenu: the head's button stands on the right, so the times open to the left and the
      // calendar goes on to the left, never back over the menu it came from
      const [later, times, panel] = await Promise.all([0, 1, 2].map((level) => menus(page).nth(level).boundingBox()));
      expect(!!later && !!times && times.x + times.width <= later.x + 1).toBe(true);
      expect(!!times && !!panel && panel.x + panel.width <= times.x + 1).toBe(true);
      // the days before today cannot be picked (Friday, 27 November, in the fixture's UTC)
      expect(await calendar.locator('[data-value="2026-11-26"]').getAttribute("aria-disabled")).toBe("true");
      // today at 8:00 has passed: refused under the calendar, the menu stays
      await calendar.locator('[data-value="2026-11-27"]').click();
      await calendar.getByRole("button", { name: "Übernehmen" }).click();
      await calendar.getByRole("alert").getByText("Dieser Zeitpunkt ist schon vorbei.").waitFor();
      expect(sent).toEqual([]);
      // the digits of the time are the field's, not the menu's typeahead
      await calendar.locator('[data-value="2026-12-02"]').click();
      const time = calendar.getByRole("textbox", { name: "Uhrzeit" });
      await time.fill("");
      await time.pressSequentially("1430");
      expect(await time.inputValue()).toBe("1430");
      await time.press("Enter");
      await openMenus(page, 0);
      await calls(sent, 1);
      expect(sent[0]).toMatchObject({ method: "PUT", body: { dueAt: "2026-12-02T14:30:00.000Z", expectedRevision: null } });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("on the phone the times are the sheet's next step, and one sets the reminder", async () => {
    const { page, errors, sent } = await open(390);
    try {
      await head(page).getByRole("button", { name: "Später" }).tap();
      const sheet = page.locator('[role="menu"]:not([data-nested])');
      await sheet.waitFor();
      expect(await sheet.getAttribute("data-presentation")).toBe("sheet");
      await sheetAtRest(page);
      await page.getByRole("menuitem", { name: "Erinnere mich" }).tap();
      await page.getByRole("menuitem", { name: /^Montag, 8:00/ }).waitFor();
      await sheetAtRest(page);
      // the step stands on screen in the sheet's place; the entry it came from leads back
      const step = await page.locator('[role="menu"][data-nested]').boundingBox();
      expect(step && step.x >= 0 && step.x + step.width <= 390).toBe(true);
      expect(await page.getByRole("menuitem", { name: "Später anzeigen" }).isVisible()).toBe(false);
      expect(await entries(page, 1)).toEqual([
        "Heute, 17:00",
        "Morgen, 8:00 · Sa., 28. Nov.",
        "Montag, 8:00 · 30. Nov.",
        "Datum und Uhrzeit …",
      ]);
      // the calendar is the step after the times, on screen, with days a finger can hit
      await page.getByRole("menuitem", { name: "Datum und Uhrzeit …" }).tap();
      const day = page.locator('[data-k2-part="DatePicker"] [data-value="2026-12-02"]');
      await day.waitFor();
      await sheetAtRest(page);
      const cell = await day.boundingBox();
      expect(cell && cell.x >= 0 && cell.x + cell.width <= 390 && cell.height >= 44).toBe(true);
      await page.getByRole("menuitem", { name: "Datum und Uhrzeit …" }).tap();
      await day.waitFor({ state: "detached" });
      await sheetAtRest(page);
      await page.getByRole("menuitem", { name: /^Montag, 8:00/ }).tap();
      await openMenus(page, 0);
      await calls(sent, 1);
      expect(sent[0]).toMatchObject({ method: "PUT", body: { dueAt: "2026-11-30T08:00:00.000Z", expectedRevision: null } });
      // the reminder is set: the menu offers to change and remove it
      await head(page).getByRole("button", { name: "Später" }).tap();
      await page.getByRole("menuitem", { name: "Erinnerung ändern" }).waitFor();
      await sheetAtRest(page);
      await page.getByRole("menuitem", { name: "Erinnerung entfernen" }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
