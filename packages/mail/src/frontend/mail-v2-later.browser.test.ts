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
});
