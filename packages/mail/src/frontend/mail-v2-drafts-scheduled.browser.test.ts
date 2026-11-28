import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../ui/test/browser";
import { MAIL_V2_NOW } from "./mail-v2.browser-clock";

// Drafts and the Outbox of Mail's v2 pilot: their own entries in rows, with v1's deeds from each row's menu. A draft
// is deleted after the question, with the revision its row showed; a send is cancelled after the person chose what
// becomes of it. The fixture's drafts and sends are in mail-v2.browser-fixture.tsx (`v2Drafts`, `v2Scheduled`).
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

const open = async (query: string) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = pageErrors(page);
  await page.addInitScript(pinPageClock, Date.parse(MAIL_V2_NOW));
  await page.goto(`${server.url}${MAIL_V2_PATH}${query}`);
  await page.waitForFunction(() => document.documentElement.dataset.mailV2Ready === "true", undefined, { timeout: 30_000 });
  return { page, errors };
};
const rows = (page: Page) => page.locator('[data-k2-part="List"] > [data-k2-part="Row"]');
/** Opens a row's "…" as a pointer does: it shows while the pointer is over the row. */
const openRowMenu = async (page: Page, text: string) => {
  const row = rows(page).filter({ hasText: text });
  await row.hover();
  await row.getByRole("button").last().click();
};

describe("Mail v2 Drafts and Outbox", () => {
  test("Drafts lists each draft by its recipients: a new message opens as a window over the list, a reply in its conversation", async () => {
    const { page, errors } = await open("?folder=Drafts1");
    try {
      expect(await rows(page).count()).toBe(3);
      expect(await page.locator('[data-k2-part="StatusRow"]').textContent()).toContain("3 Entwürfe");
      // a draft is no conversation: nothing to select
      expect(await page.locator('[data-k2-part="StatusRow"] input[type="checkbox"]').count()).toBe(0);
      const fresh = rows(page).filter({ hasText: "Architekturbüro Winter" });
      expect(await fresh.textContent()).toContain("Entwurf");
      expect(await fresh.locator("a[href]").first().getAttribute("href")).toBe(`${MAIL_V2_PATH}?folder=Drafts1&draft=DemoDrf1`);
      const reply = rows(page).filter({ hasText: "Holzwerk Brandt" });
      expect(await reply.textContent()).toContain("+1");
      expect(await reply.locator("a[href]").first().getAttribute("href")).toStartWith(`${MAIL_V2_PATH}/compose/DemoDrf2?`);
      expect(await rows(page).filter({ hasText: "Keine Empfänger" }).textContent()).toContain("(Kein Betreff)");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a draft is deleted from its menu after the question, with the revision its row showed, and leaves the list", async () => {
    const { page, errors } = await open("?folder=Drafts1");
    try {
      const sent: unknown[] = [];
      await page.route("**/api/mail/mailboxes/Box001/drafts/DemoDrf1/discard", async (route) => {
        sent.push(route.request().postDataJSON());
        await route.fulfill({ json: {} });
      });
      await openRowMenu(page, "Architekturbüro Winter");
      await page.getByRole("menuitem", { name: "Entwurf löschen" }).click();
      const question = page.getByRole("alertdialog");
      expect(await question.textContent()).toContain("Angebot Treppe Haus am Hang");
      expect(sent).toEqual([]);
      await question.getByRole("button", { name: "Entwurf löschen" }).click();
      await rows(page).filter({ hasText: "Architekturbüro Winter" }).waitFor({ state: "detached" });
      expect(sent).toEqual([{ expectedRevision: 2 }]);
      expect(await rows(page).count()).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("the Outbox says when each send goes and what holds it; a cancel asks first, and closing the question cancels nothing", async () => {
    const { page, errors } = await open("?scheduled=1");
    try {
      const sent: unknown[] = [];
      await page.route("**/api/mail/mailboxes/Box001/scheduled-sends/DemoSnd1/cancel", async (route) => {
        sent.push(route.request().postDataJSON());
        await route.fulfill({ json: { disposition: "discard", draftId: "DemoDrS1" } });
      });
      expect(await page.locator('[data-k2-part="StatusRow"]').textContent()).toContain("3 Nachrichten warten auf die Zustellung");
      expect(await page.locator('[data-k2-part="StatusRow"] input[type="checkbox"]').count()).toBe(0);
      expect(await rows(page).filter({ hasText: "Familie Oswald" }).textContent()).toContain("morgen, ");
      expect(await rows(page).filter({ hasText: "Stadtwerke Auental" }).textContent()).toContain("Wartet auf Anmeldung");
      expect(await rows(page).filter({ hasText: "Spedition Falk" }).textContent()).toContain("Nächster Versuch heute, ");

      await openRowMenu(page, "Familie Oswald");
      await page.getByRole("menuitem", { name: "Zustellung abbrechen" }).click();
      const question = page.getByRole("dialog", { name: "Zustellung abbrechen?" });
      await question.waitFor();
      await page.keyboard.press("Escape");
      await question.waitFor({ state: "hidden" });
      expect(sent).toEqual([]);

      await openRowMenu(page, "Familie Oswald");
      await page.getByRole("menuitem", { name: "Zustellung abbrechen" }).click();
      await question.getByRole("button", { name: "Nachricht verwerfen" }).click();
      await page.waitForFunction(() => document.body.textContent?.includes("verworfen"), undefined, { timeout: 10_000 });
      expect(sent).toEqual([{ disposition: "discard" }]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
