import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../ui/test/browser";
import { summaryState } from "./_components/mail-summary-fixtures";
import { MAIL_V2_NOW } from "./mail-v2.browser-clock";

// The dialogs of Mail's v2 reader are v2 dialogs (`Dialog`, `confirm` of `@k2b/ui/v2`), not v1's forms: the summary,
// linking an existing task or event of Spaces (with the v2 `Lookup`), and "cannot send yet". They send what v1's did.
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

/** Opens the demo conversation; the summary, the search of Spaces and linking answer as Mail's server does. */
const open = async (query = "") => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = pageErrors(page);
  const sent: Sent[] = [];
  await page.route(/\/conversations\/Demo01\/(summary|spaces\/items|spaces\/link)(\?.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = (request.method() === "GET" ? {} : (request.postDataJSON() ?? {})) as Record<string, unknown>;
    sent.push({ method: request.method(), path: url.pathname, body });
    if (url.pathname.endsWith("/summary"))
      return route.fulfill({ json: summaryState({ summary: String(body.summary), summaryRevision: 2, source: "person" }) });
    if (url.pathname.endsWith("/spaces/items"))
      return route.fulfill({
        json: [
          {
            ref: { app: "spaces", type: "task", id: "DemoTask2" },
            title: "Lieferung Eichenplatten annehmen",
            icon: "ti ti-checkbox",
            metadata: [{ label: "Space", value: "Werkstatt" }],
          },
        ],
      });
    return route.fulfill({ json: { ok: true } });
  });
  await page.addInitScript(pinPageClock, Date.parse(MAIL_V2_NOW));
  await page.goto(`${server.url}${MAIL_V2_PATH}?conversation=Demo01${query}`);
  await page.waitForFunction(() => document.documentElement.dataset.mailV2Ready === "true", undefined, { timeout: 30_000 });
  return { page, errors, sent };
};

/** The open v2 dialog (never v1's, which has no `data-k2-part`). */
const dialog = (page: Page) => page.locator('[data-k2-part="Dialog"]');
const reader = (page: Page) => page.locator('[data-k2-part="Pane"][data-detail]');
/** Waits until the fixture got `count` calls of `method`. */
const calls = async (sent: Sent[], method: string, count: number) => {
  for (let tries = 0; sent.filter((call) => call.method === method).length < count && tries < 100; tries += 1) await Bun.sleep(50);
  const made = sent.filter((call) => call.method === method);
  expect(made.length).toBe(count);
  return made;
};

describe("Mail v2: the reader's dialogs are v2 dialogs", () => {
  test("the summary is written in a v2 dialog: Abbrechen sends nothing, saving sends the text", async () => {
    const { page, errors, sent } = await open();
    try {
      await reader(page).locator('[data-k2-part="Notice"][data-tone="ai"]').getByRole("button", { name: "Bearbeiten" }).click();
      await dialog(page).getByRole("heading", { name: "Zusammenfassung bearbeiten" }).waitFor();
      const text = dialog(page).getByRole("textbox", { name: "Zusammenfassung" });
      expect(await text.inputValue()).toContain("Eichenplatten");
      await dialog(page).getByRole("button", { name: "Abbrechen" }).click();
      await dialog(page).waitFor({ state: "detached" });
      expect(sent).toEqual([]);
      await reader(page).locator('[data-k2-part="Notice"][data-tone="ai"]').getByRole("button", { name: "Bearbeiten" }).click();
      await text.fill("Brandt liefert in KW 49, Kanten geölt.");
      await dialog(page).getByRole("button", { name: "Zusammenfassung speichern" }).click();
      await dialog(page).waitFor({ state: "detached" });
      const [put] = await calls(sent, "PUT", 1);
      expect(put?.body).toMatchObject({ summary: "Brandt liefert in KW 49, Kanten geölt.", expectedSummaryRevision: 1 });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // Review of #4213: a summary the server refuses (too long, changed meanwhile) stays in the dialog, with the reason at
  // the field; saving again sends what is in the field now.
  test("a summary the server refuses stays editable in the open dialog, with the server's reason at the field", async () => {
    const { page, errors } = await open();
    try {
      const puts: { summary: string }[] = [];
      await page.route("**/api/mail/mailboxes/Box001/conversations/Demo01/summary", async (route) => {
        const body = route.request().postDataJSON() as { summary: string };
        puts.push(body);
        if (puts.length === 1) return route.fulfill({ status: 400, json: { message: "Die Zusammenfassung ist zu lang." } });
        return route.fulfill({ json: summaryState({ summary: body.summary, summaryRevision: 2, source: "person" }) });
      });
      await reader(page).locator('[data-k2-part="Notice"][data-tone="ai"]').getByRole("button", { name: "Bearbeiten" }).click();
      const text = dialog(page).getByRole("textbox", { name: "Zusammenfassung" });
      await text.fill("Viel zu lang");
      await dialog(page).getByRole("button", { name: "Zusammenfassung speichern" }).click();
      await dialog(page).getByText("Die Zusammenfassung ist zu lang.").waitFor();
      expect(await text.inputValue()).toBe("Viel zu lang");
      // no Retry beside the dialog: the dialog is the way to try again
      expect(await page.getByRole("button", { name: "Erneut versuchen" }).count()).toBe(0);
      await text.fill("Kurz");
      await dialog(page).getByRole("button", { name: "Zusammenfassung speichern" }).click();
      await dialog(page).waitFor({ state: "detached" });
      expect(puts.map((put) => put.summary)).toEqual(["Viel zu lang", "Kurz"]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  /** Holds the first summary save until the test lets it answer, as a slow server would. */
  const holdFirstSave = async (page: Page, answer: (summary: string) => { status: number; json: unknown }) => {
    let release = () => {};
    const released = new Promise<void>((done) => {
      release = done;
    });
    const puts: string[] = [];
    await page.route("**/api/mail/mailboxes/Box001/conversations/Demo01/summary", async (route) => {
      const { summary } = route.request().postDataJSON() as { summary: string };
      puts.push(summary);
      if (puts.length === 1) await released;
      const { status, json } = answer(summary);
      await route.fulfill({ status, json });
    });
    return { release, puts };
  };

  // Review of #4213: what is saved is what the field shows; while a save runs, the field cannot change.
  test("while the summary saves, its field is locked, so what is stored is what was shown", async () => {
    const { page, errors } = await open();
    try {
      const { release, puts } = await holdFirstSave(page, (summary) => ({
        status: 200,
        json: summaryState({ summary, summaryRevision: 2, source: "person" }),
      }));
      await reader(page).locator('[data-k2-part="Notice"][data-tone="ai"]').getByRole("button", { name: "Bearbeiten" }).click();
      const text = dialog(page).getByRole("textbox", { name: "Zusammenfassung" });
      await text.fill("A");
      await dialog(page).getByRole("button", { name: "Zusammenfassung speichern" }).click();
      await page.waitForFunction(
        () => document.querySelector('[data-k2-part="Dialog"] [data-busy], [data-k2-part="Dialog"] [aria-busy="true"]') !== null,
      );
      expect(await text.isEditable()).toBe(false);
      release();
      await dialog(page).waitFor({ state: "detached" });
      expect(puts).toEqual(["A"]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // Review of #4213: a save that runs keeps the dialog: Abbrechen, Escape and a press outside wait for its answer, so a
  // refusal still stands at the field with the text.
  test("while the summary saves, the dialog stays; a late refusal still shows at the field with the text", async () => {
    const { page, errors } = await open();
    try {
      const { release } = await holdFirstSave(page, () => ({ status: 400, json: { message: "Die Zusammenfassung ist zu lang." } }));
      await reader(page).locator('[data-k2-part="Notice"][data-tone="ai"]').getByRole("button", { name: "Bearbeiten" }).click();
      const text = dialog(page).getByRole("textbox", { name: "Zusammenfassung" });
      await text.fill("Viel zu lang");
      await dialog(page).getByRole("button", { name: "Zusammenfassung speichern" }).click();
      await dialog(page).getByRole("button", { name: "Abbrechen" }).click({ force: true });
      await page.keyboard.press("Escape");
      await page.mouse.click(8, 8);
      await Bun.sleep(300);
      expect(await dialog(page).isVisible()).toBe(true);
      release();
      await dialog(page).getByText("Die Zusammenfassung ist zu lang.").waitFor();
      expect(await text.inputValue()).toBe("Viel zu lang");
      expect(await text.isEditable()).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("Vorhandenes verknüpfen picks a task in the v2 lookup and links it", async () => {
    const { page, errors, sent } = await open();
    try {
      await reader(page).locator(':scope > [data-slot="head"]').getByRole("button", { name: "Weitere Aktionen" }).click();
      await page.getByRole("menuitem", { name: "Vorhandenes verknüpfen …" }).click();
      await dialog(page).getByRole("heading", { name: "Space-Element verknüpfen" }).waitFor();
      const link = dialog(page).getByRole("button", { name: "Space-Element verknüpfen" });
      // nothing chosen yet: nothing to link
      expect(await link.isDisabled()).toBe(true);
      await dialog(page)
        .getByRole("option", { name: /Lieferung Eichenplatten annehmen/ })
        .click();
      await link.click();
      await dialog(page).waitFor({ state: "detached" });
      const [post] = await calls(sent, "POST", 1);
      expect(post).toMatchObject({ path: "/api/mail/mailboxes/Box001/conversations/Demo01/spaces/link", body: { itemId: "DemoTask2" } });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a mailbox that cannot send yet says so in a v2 dialog", async () => {
    const { page, errors } = await open("&sender=none");
    try {
      const message = reader(page).locator('[data-k2-part="Band"]').first();
      await message.getByRole("button", { name: "Nachrichtenaktionen" }).click();
      await page.getByRole("menuitem", { name: "Als neue Nachricht verwenden" }).click();
      await dialog(page).getByRole("heading", { name: "Aus diesem Postfach kann noch nicht gesendet werden" }).waitFor();
      // a mailbox administrator is offered the settings, everyone else reads who can fix it
      const close = dialog(page).getByRole("button", { name: /^(Verstanden|Abbrechen)$/ });
      await close.click();
      await dialog(page).waitFor({ state: "detached" });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
