import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../ui/test/browser";
import { MAIL_V2_NOW } from "./mail-v2.browser-clock";

// While no mail is open, Mail's v2 reader shows the mails its mailbox received per day of the last 53 weeks: a line that
// sums them up, the Heat below it, and the sentence of the empty reader under both. It fits the reader from 1024 to
// 1920 px without cutting the newest weeks; a new mailbox says it has none yet; opening a mail replaces it. The
// fixture's clock is Friday, 27 November 2026, 10:00 UTC.
setSystemTime(new Date(MAIL_V2_NOW));
const { startMailV2Server, MAIL_V2_PATH } = await import("./mail-v2.browser-server");

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

const withPage = async (width: number, query: string, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = pageErrors(page);
  try {
    await page.goto(`${server.url}${MAIL_V2_PATH}${query}`);
    await page.waitForFunction(() => document.documentElement.dataset.mailV2Ready === "true");
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** The empty reader: its line, the days of its Heat and whether they all stand inside it. */
const reader = (page: Page) =>
  page.evaluate(() => {
    const place = document.querySelector<HTMLElement>("[data-detail-empty]");
    if (!place) return null;
    const box = place.getBoundingClientRect();
    const days = [...place.querySelectorAll<HTMLElement>("[data-heat-day]")].map((day) => day.getBoundingClientRect());
    return {
      line: place.querySelector(".k2-detail-hero > .k2-text")?.textContent ?? null,
      sentence: place.querySelector(".k2-state-text")?.textContent ?? null,
      days: days.length,
      inside: days.every((day) => day.left >= box.left - 0.5 && day.right <= box.right + 0.5),
      size: Math.round((days[0]?.width ?? 0) * 10) / 10,
      today: place.querySelector('[aria-current="date"]')?.getAttribute("aria-label") ?? null,
    };
  });

for (const width of [1024, 1440, 1920])
  test(`at ${width} px the empty reader shows the year of mail above its sentence, every week inside it`, async () => {
    await withPage(width, "", async (page) => {
      const found = await reader(page);
      expect(found).not.toBeNull();
      expect(found!.line).toMatch(/^[\d.]+ Mails in den letzten 12 Monaten$/);
      expect(found!.sentence).toBe("Keine Nachricht ausgewählt");
      // 53 weeks from Monday: Saturday and Sunday stop at the week before this Friday
      expect(found!.days).toBe(369);
      expect(found!.inside).toBe(true);
      expect(found!.size).toBeGreaterThanOrEqual(3);
      expect(found!.size).toBeLessThanOrEqual(12);
      expect(found!.today).toMatch(/ am Fr\., 27\. Nov\.$/);
    });
  });

test("a new mailbox without mail says so, and every day stands quiet", async () => {
  await withPage(1440, "?received=none", async (page) => {
    const found = await reader(page);
    expect(found!.line).toBe("Noch keine Mails in den letzten 12 Monaten");
    expect(await page.locator("[data-detail-empty] [data-heat-day]:not([data-tone='0'])").count()).toBe(0);
  });
});

test("a huge mailbox groups its thousands and keeps the line on one line", async () => {
  await withPage(1440, "?received=huge", async (page) => {
    const found = await reader(page);
    expect(found!.line).toMatch(/^\d{1,3}(\.\d{3})+ Mails in den letzten 12 Monaten$/);
    expect(found!.today).toMatch(/^\d{1,3}\.\d{3} Mails am Fr\., 27\. Nov\.$/);
    const lines = await page.locator(".k2-detail-hero > .k2-text").evaluate((line) => Math.round(line.getBoundingClientRect().height));
    expect(lines).toBeLessThanOrEqual(20);
  });
});

test("an open mail takes the reader's place; the year of mail is not drawn behind it", async () => {
  await withPage(1440, "?conversation=Demo01", async (page) => {
    expect(await reader(page)).toBeNull();
    expect(await page.locator("[data-heat-day]").count()).toBe(0);
  });
});
