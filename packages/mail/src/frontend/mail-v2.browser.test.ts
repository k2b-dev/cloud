import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { summaryState } from "./_components/mail-summary-fixtures";
import { MAIL_V2_NOW } from "./mail-v2.browser-clock";

// Mail's mailbox on the @k2b/ui v2 pilot: the real island and controller with the mockup's data. The boxes of its
// parts are the numbers measured in the approved mockup (mail.html, the same frame as the Fibel screen tests), and
// the behaviour is v1's: rows open in place, Escape returns to the row, a live mail keeps the focus and the scroll.
setSystemTime(new Date(MAIL_V2_NOW));
const { startMailV2Server, MAIL_V2_PATH } = await import("./mail-v2.browser-server");

const mockup: Record<number, Record<string, [selector: string, box: string]>> = {
  1440: {
    head: ['.k2-ws-main > [data-slot="head"] > .k2-bar', "250,1 1125x56"],
    status: ['[data-k2-part="StatusRow"]', "250,57 432x52"],
    row: ['[data-k2-part="List"] > [data-k2-part="Row"]', "250,109 432x73"],
    readerHead: ['[data-k2-part="Pane"][data-detail] > [data-slot="head"] > .k2-bar', "683,57 692x52"],
    notice: ['[data-k2-part="Notice"][data-tone="ai"]', "683,149 692x85"],
    listGrip: ['[data-k2-part="Pane.Split"] .k2-grip', "677,460 11x20"],
  },
  390: {
    head: ['.k2-ws-main > [data-slot="head"] > .k2-bar', "0,0 390x44"],
    status: ['[data-k2-part="StatusRow"]', "0,44 390x52"],
    row: ['[data-k2-part="List"] > [data-k2-part="Row"]', "0,96 390x73"],
  },
};

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

/** The errors each page threw from its start; `pageErrors` collects only from the call on, so `open` keeps its list. */
const errorsOf = new WeakMap<Page, string[]>();
const open = async (path: string, width = 1440, height = width < 768 ? 844 : 900): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height } });
  errorsOf.set(page, pageErrors(page));
  await page.addInitScript(pinPageClock, Date.parse(MAIL_V2_NOW));
  await page.goto(`${server.url}${path}`);
  await page.waitForFunction(() => document.documentElement.dataset.mailV2Ready === "true", undefined, { timeout: 30_000 });
  return page;
};
/** A conversation of the list (the reader's message heads are rows too). */
const row = (page: Page, sender: string) => page.locator('[data-k2-part="List"] > [data-k2-part="Row"]', { hasText: sender });
/** The row's own link that opens its conversation; it takes the focus. */
const rowLink = (page: Page, sender: string) => row(page, sender).locator(":scope > a[href]");
/** The text of the row that holds the focus. */
const focusedRow = (page: Page) => page.evaluate(() => document.activeElement?.closest('[data-k2-part="Row"]')?.textContent ?? "");

describe("Mail on the v2 pilot", () => {
  for (const [width, path] of [
    [1440, `${MAIL_V2_PATH}?conversation=Demo01`],
    [390, MAIL_V2_PATH],
  ] as const)
    test(`keeps the mockup at ${width} px`, async () => {
      const page = await open(path, width);
      try {
        expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
        const boxes = await page.evaluate((parts) => {
          const ws = document.querySelector("[data-k2-workspace]")!.getBoundingClientRect();
          return Object.fromEntries(
            Object.entries(parts).map(([part, [selector]]) => {
              const box = document.querySelector(selector)?.getBoundingClientRect();
              return [part, box ? `${box.left - ws.left},${box.top - ws.top} ${box.width}x${box.height}` : "missing"];
            }),
          );
        }, mockup[width]!);
        expect(boxes).toEqual(Object.fromEntries(Object.entries(mockup[width]!).map(([part, [, box]]) => [part, box])));
        expect(errorsOf.get(page)).toEqual([]);
      } finally {
        await page.close();
      }
    }, 60_000);

  test("a row opens its conversation in place, and Escape returns to the row", async () => {
    const page = await open(MAIL_V2_PATH);
    try {
      await page.evaluate(() => Object.assign(window, { stayed: true }));
      await row(page, "Holzwerk Brandt").click();
      await page.waitForURL(/conversation=Demo01/);
      await page.locator('[data-k2-part="Pane"][data-detail]').getByText("Angebot Eichenplatten – Liefertermin").first().waitFor();
      expect(await page.evaluate(() => "stayed" in window)).toBe(true);
      expect(await row(page, "Holzwerk Brandt").getAttribute("aria-current")).toBe("true");
      await page.locator("body").press("Escape");
      await page.waitForURL((url) => !url.searchParams.has("conversation"));
      expect(await page.locator('[data-k2-part="Pane"][data-detail]').count()).toBe(0);
      expect(await focusedRow(page)).toContain("Holzwerk Brandt");
      expect(await page.evaluate(() => "stayed" in window)).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("the keyboard opens a row: Tab reaches it, Enter opens it in place", async () => {
    const page = await open(MAIL_V2_PATH);
    try {
      await rowLink(page, "Jonas Hartwig").focus();
      await page.keyboard.press("Enter");
      await page.waitForURL(/conversation=Demo02/);
      expect(await row(page, "Jonas Hartwig").getAttribute("aria-current")).toBe("true");
    } finally {
      await page.close();
    }
  }, 60_000);

  // As in v1's mail shell: each mailbox's list keeps its own place in history (the list's `scrollKey`), in place.
  test("back and forward bring each mailbox's list back where it was", async () => {
    const page = await open(MAIL_V2_PATH, 1440, 560);
    try {
      await page.evaluate(() => Object.assign(window, { stayed: true }));
      const list = page.locator('[data-k2-part="Pane"] > [data-scroll-preserve^="mail-list-"]');
      const position = () => list.evaluate((element) => element.scrollTop);
      const scrollTo = async (y: number) => {
        await list.evaluate((element, y) => {
          element.scrollTop = y;
        }, y);
        await settled(page);
        expect(await position(), "the list really scrolls").toBe(y);
      };
      await scrollTo(120);
      await page.locator('[data-k2-part="Nav.Item"][href="/app/mail/Box002"]').click();
      await page.waitForURL(/\/app\/mail\/Box002$/);
      await settled(page);
      expect(await position(), "another mailbox starts at its list's top").toBe(0);
      await scrollTo(60);
      await page.goBack();
      await page.waitForURL(/\/app\/mail\/Box001$/);
      await settled(page);
      expect(await position(), "Back restores the first mailbox's place").toBe(120);
      await page.goForward();
      await page.waitForURL(/\/app\/mail\/Box002$/);
      await settled(page);
      expect(await position(), "Forward restores the second mailbox's place").toBe(60);
      expect(await page.evaluate(() => "stayed" in window)).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("on the phone the reader's way back names the list and returns to its row", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`, 390);
    try {
      // The way back is named by the list's title, which the server sends.
      const back = page.locator('[data-k2-part="Pane"][data-detail]').getByRole("link", { name: "Alle E-Mails", exact: true });
      await back.waitFor();
      await back.click();
      await page.waitForURL((url) => !url.searchParams.has("conversation"));
      await row(page, "Holzwerk Brandt").waitFor();
      expect(await focusedRow(page)).toContain("Holzwerk Brandt");
    } finally {
      await page.close();
    }
  }, 60_000);

  test("in a selection each row has its box, which shows and changes what is selected", async () => {
    const page = await open(MAIL_V2_PATH);
    try {
      const status = page.locator('[data-k2-part="StatusRow"]');
      await status.getByRole("checkbox").click();
      await page.locator('[data-k2-part="StatusRow"][data-selecting]').waitFor();
      const boxes = page.locator('[data-k2-part="List"] > [data-k2-part="Row"]').getByRole("checkbox");
      const count = await boxes.count();
      expect(count).toBeGreaterThan(1);
      for (let index = 0; index < count; index += 1) expect(await boxes.nth(index).isChecked()).toBe(true);
      await boxes.first().click();
      expect(await boxes.first().isChecked()).toBe(false);
      expect(await status.textContent()).toContain(`${count - 1}`);
      expect(errorsOf.get(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // v1's menus, built by the same shared parts: no button in the reader stands there without doing something.
  test("the reader's Later and More and each message's More offer v1's entries", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`);
    try {
      const head = page.locator('[data-k2-part="Pane"][data-detail] > [data-slot="head"]');
      await head.getByRole("button", { name: "Später" }).click();
      await page.getByRole("menuitem", { name: "Erinnere mich …" }).waitFor();
      await page.keyboard.press("Escape");
      await head.getByRole("button", { name: "Weitere Aktionen" }).click();
      await page.getByRole("menuitem", { name: /^Als (un)?gelesen markieren$/ }).waitFor();
      await page.getByRole("menuitem", { name: "Aktivität anzeigen" }).waitFor();
      // "…" holds the rare deeds: what the head shows as a button is not repeated there.
      expect(await page.getByRole("menuitem", { name: "Archivieren" }).count()).toBe(0);
      await page.keyboard.press("Escape");
      const message = page.locator('[data-k2-part="Pane"][data-detail] [data-k2-part="Band"]').first();
      await message.getByRole("button", { name: "Nachrichtenaktionen" }).click();
      await page.getByRole("menuitem", { name: "Technische Details" }).waitFor();
      await page.getByRole("menuitem", { name: "Antworten" }).waitFor();
      await page.getByRole("menuitem", { name: "Als neue Nachricht verwenden" }).waitFor();
      await page.keyboard.press("Escape");
      // The head's "…": the open mailbox's rare deeds, led by pinning and hiding it (v1's mailbox menu).
      await page.locator('[data-k2-workspace] .k2-ws-main > [data-slot="head"]').getByRole("button", { name: "Weitere Aktionen" }).click();
      await page.getByRole("menuitem", { name: "Ausblenden", exact: true }).waitFor();
      await page.getByRole("menuitem", { name: "Einstellungen" }).waitFor();
      await page.keyboard.press("Escape");
      // The head's filter menu at the search field, v1's (F9).
      await page.locator('[data-k2-workspace] [data-slot="head"] [data-k2-part="Input"]').getByRole("button", { name: "Filter" }).click();
      await page.getByRole("menuitem", { name: "Weitere Filter …" }).waitFor();
      expect(await page.locator("[data-k2-workspace] button[disabled]").count()).toBe(0);
      expect(errorsOf.get(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("the reader names what other apps linked to the conversation, and one link opens it", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`);
    try {
      const linked = page.locator('[data-k2-part="Pane"][data-detail]').getByRole("link", { name: "1 verknüpft" });
      await linked.waitFor();
      expect(await linked.getAttribute("href")).toBe("/app/spaces/tasks/DemoTask1");
      expect(errorsOf.get(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // At 1024 px the sidebar is a drawer, at 1440 px a column (#4123): the workspace keeps room for the reader and the
  // list keeps its width, so opening and closing a mail moves nothing; the reader's place says so while none is open.
  for (const width of [1024, 1440])
    test(`at ${width} px opening and closing a mail moves neither the list nor the sidebar`, async () => {
      const page = await open(MAIL_V2_PATH, width);
      try {
        const place = () =>
          page.evaluate(() => {
            const row = document.querySelector('[data-k2-part="List"] > [data-k2-part="Row"]')!.getBoundingClientRect();
            const nav = document.querySelector('[data-k2-workspace] [data-k2-part="Nav"]')?.getBoundingClientRect();
            return { rowLeft: Math.round(row.left), rowWidth: Math.round(row.width), sidebar: Boolean(nav && nav.width > 0) };
          });
        await page.getByText("Keine Nachricht ausgewählt").waitFor();
        const before = await place();
        // a column at 1440 px, a closed drawer at 1024 px: the comparison is of a sidebar that is there or not by design
        expect(before.sidebar).toBe(width === 1440);
        await rowLink(page, "Holzwerk Brandt").click();
        await page.waitForURL(/conversation=Demo01/);
        await settled(page);
        expect(await place()).toEqual(before);
        expect(await page.getByText("Keine Nachricht ausgewählt").count()).toBe(0);
        expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
        await page.locator("body").press("Escape");
        await page.waitForURL((url) => !url.searchParams.has("conversation"));
        await settled(page);
        expect(await place()).toEqual(before);
        expect(errorsOf.get(page)).toEqual([]);
      } finally {
        await page.close();
      }
    }, 60_000);

  // The summary is written through v1's save: a failed save keeps the text behind Retry, which sends it again.
  test("a failed summary save offers Retry, which sends the same text again", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`);
    try {
      const puts: unknown[] = [];
      await page.route("**/api/mail/mailboxes/Box001/conversations/Demo01/summary", async (route) => {
        if (route.request().method() !== "PUT") return route.fallback();
        const body = route.request().postDataJSON() as { summary: string; expectedSummaryRevision: number };
        puts.push(body);
        if (puts.length === 1) return route.fulfill({ status: 503, json: { error: "Gerade nicht erreichbar" } });
        return route.fulfill({
          json: summaryState({ summary: body.summary, summaryRevision: body.expectedSummaryRevision + 1, source: "person" }),
        });
      });
      await page.locator('[data-k2-part="Notice"][data-tone="ai"]').getByRole("button", { name: "Bearbeiten" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Zusammenfassung speichern" }).click();
      const retry = page.getByRole("button", { name: "Erneut versuchen" });
      await retry.waitFor();
      const saved = page.waitForResponse((response) => response.url().endsWith("/summary") && response.request().method() === "PUT");
      await retry.click();
      expect((await saved).ok()).toBe(true);
      expect(puts.length).toBe(2);
      expect(puts[1]).toEqual(puts[0]);
      expect((puts[0] as { summary: string }).summary).toContain("Eichenplatten");
    } finally {
      await page.close();
    }
  }, 60_000);

  // The search field shows the page's search: a folder opened after a search shows none, Back brings the search back.
  test("the search field follows the page: another folder clears it, Back brings the search back", async () => {
    const page = await open(MAIL_V2_PATH);
    try {
      const field = page.locator('[data-k2-workspace] [data-slot="head"] input[type="search"]');
      await field.fill("Angebot");
      await field.press("Enter");
      await page.waitForURL((url) => url.searchParams.get("q") === "Angebot");
      await settled(page);
      await page.locator('[data-k2-part="Nav"]').getByRole("link", { name: "Gesendet" }).click();
      await page.waitForURL(/folder=Sent1/);
      await settled(page);
      expect(await field.inputValue()).toBe("");
      await page.goBack();
      await page.waitForURL((url) => url.searchParams.get("q") === "Angebot");
      await settled(page);
      expect(await field.inputValue()).toBe("Angebot");
      expect(errorsOf.get(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // At 1024 px "Wartet auf Antwort" has no room: it leads "Weitere", which counts it, and opens in place like the tab.
  test("at 1024 px a tab without room leads the Weitere menu and opens in place", async () => {
    const page = await open(MAIL_V2_PATH, 1024);
    try {
      await page.evaluate(() => Object.assign(window, { stayed: true }));
      const tabs = page.locator('[data-k2-workspace] [data-k2-part="Tabs"]');
      expect(await tabs.getByRole("link", { name: /Wartet auf Antwort/ }).isVisible()).toBe(false);
      const more = tabs.getByRole("button", { name: /Weitere/ });
      expect(await more.textContent()).toContain("+9");
      await more.click();
      const first = page.getByRole("menuitem").first();
      expect(await first.textContent()).toContain("Wartet auf Antwort");
      await first.click();
      await page.waitForURL(/view=waiting/);
      await settled(page);
      expect(await page.evaluate(() => "stayed" in window)).toBe(true);
      expect(errorsOf.get(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // v1's sidebar deeds: archive, bin and spam fold under "Mehr"; the group's "…" holds a new mailbox and the deleted
  // ones; each mailbox's "…" pins or releases and hides it. The head's "Weitere" lists the views that wait behind it.
  test("the sidebar's Mehr, the group's and each mailbox's deeds, and the head's further views", async () => {
    const page = await open(MAIL_V2_PATH);
    try {
      await page.evaluate(() => Object.assign(window, { stayed: true }));
      const nav = page.locator('[data-k2-workspace] [data-k2-part="Nav"]');
      const more = nav.getByRole("button", { name: "Mehr", exact: true });
      expect(await more.getAttribute("aria-expanded")).toBe("false");
      expect(await nav.getByRole("link", { name: "Papierkorb" }).count()).toBe(0);
      await more.click();
      await nav.getByRole("link", { name: "Papierkorb" }).click();
      await page.waitForURL(/folder=Trash1/);
      await settled(page);
      // the open folder keeps its fold open
      expect(await more.getAttribute("aria-expanded")).toBe("true");
      await nav.getByRole("button", { name: "Postfächer verwalten" }).click();
      await page.getByRole("menuitem", { name: "Neues Postfach" }).waitFor();
      await page.getByRole("menuitem", { name: "Gelöschte Postfächer" }).waitFor();
      await page.keyboard.press("Escape");
      await nav.getByRole("button", { name: "Aktionen für Kontakt" }).click();
      await page.getByRole("menuitem", { name: "Nicht mehr anheften" }).waitFor();
      await page.getByRole("menuitem", { name: "Ausblenden", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page
        .locator('[data-k2-workspace] [data-k2-part="Tabs"]')
        .getByRole("button", { name: /Weitere/ })
        .click();
      await page.getByRole("menuitem", { name: /^Erledigt/ }).click();
      await page.waitForURL(/view=done/);
      // a view from the menu opens in place, like a tab
      expect(await page.evaluate(() => "stayed" in window)).toBe(true);
      expect(errorsOf.get(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // As v1's sidebar: the hidden mailboxes fold into one quiet entry, which opens them below itself.
  test("the sidebar's Hidden entry opens the hidden mailboxes below itself", async () => {
    const page = await open(MAIL_V2_PATH);
    try {
      const nav = page.locator('[data-k2-part="Nav"]');
      expect(await nav.getByRole("link", { name: "Archiv 2024" }).count()).toBe(0);
      await nav.getByRole("button", { name: "Ausgeblendet (1)" }).click();
      await nav.getByRole("link", { name: "Archiv 2024" }).waitFor();
      await nav.getByRole("button", { name: "Ausgeblendet (1)" }).click();
      await nav.getByRole("link", { name: "Archiv 2024" }).waitFor({ state: "detached" });
      expect(errorsOf.get(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // The frame is a sandboxed document: it loads Cloud's shared faces across origins (Core sends them with CORS).
  test("a message's text reads in IBM Plex Sans, not in the system's font", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`);
    try {
      const frame = page.frameLocator('[data-k2-part="Pane"][data-detail] iframe').first();
      await frame.locator("p").first().waitFor();
      const plex = await frame.locator("body").evaluate(async () => {
        await document.fonts.ready;
        const faces = [...document.fonts].filter((face) => face.family.replaceAll('"', "") === "IBM Plex Sans");
        return { declared: faces.length > 0, loaded: faces.some((face) => face.status === "loaded") };
      });
      expect(plex).toEqual({ declared: true, loaded: true });
      expect(errorsOf.get(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("Forward in the reader's More opens Mail's reply box as a forward", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`);
    try {
      const head = page.locator('[data-k2-part="Pane"][data-detail] > [data-slot="head"]');
      await head.getByRole("button", { name: "Weitere Aktionen" }).click();
      await page.getByRole("menuitem", { name: "Weiterleiten" }).click();
      await page.locator('[data-k2-part="Canvas"] [contenteditable="true"]').first().waitFor();
      expect(errorsOf.get(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("the reply rests as the mockup's composer and starts Mail's reply box on a click", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`);
    try {
      const composer = page.locator('[data-k2-part="Composer"]');
      await composer.waitFor();
      expect(await composer.textContent()).toContain("Holzwerk Brandt");
      // The sender's signature, as the server renders it, under the text.
      await composer.locator(".k2-composer-signature").getByText("Tischlerei Solberg & Kramer").waitFor();
      await composer.locator(".k2-composer-start").click();
      await page.locator('[data-k2-part="Canvas"] [data-mail-reply-box-frame]').waitFor();
      // Mail's own composer writes there, in the same frame: its editor takes text, the head and the foot stay v2's.
      await page.locator('[data-k2-part="Canvas"] [data-mail-reply-box="mail"] [contenteditable="true"]').first().waitFor();
      expect(await composer.count()).toBe(1);
      expect(await page.locator('[data-k2-part="Canvas"] [data-k2-part="Composer"]').count()).toBe(1);
      const send = composer.locator('[data-k2-part="Button"][data-variant="primary"]');
      expect(await send.textContent()).toBe("Senden");
      // v1's green split button and its tool row are not drawn in the frame.
      expect(await composer.locator(".k2b-split-button, .mail-reply-box-foot").count()).toBe(0);
      expect(errorsOf.get(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  /** Answers the reply's draft, lease, review and send as Mail's API does, and keeps what the page asked. */
  const answerReplyApi = async (page: Page, options: { sendFails?: boolean } = {}) => {
    const calls: string[] = [];
    const commands: unknown[] = [];
    // Each send the page makes resolves the next waiting promise, so a test waits for exactly the send it caused.
    let next = Promise.withResolvers<unknown>();
    const stamp = MAIL_V2_NOW;
    let draft: Record<string, unknown> | null = null;
    await page.route("**/api/mail/mailboxes/Box001/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace("/api/mail/mailboxes/Box001", "");
      const method = request.method();
      calls.push(`${method} ${path}`);
      if (method === "POST" && path === "/draft-seeds/materialize") {
        const body = request.postDataJSON();
        draft = {
          id: "DrfNew",
          mailboxId: "Box001",
          conversationId: body.origin.input.conversationId,
          intent: body.origin.input.intent,
          sourceMessageId: body.origin.input.sourceMessageId,
          derivedFromMessageId: null,
          derivationKind: null,
          ...body.draft,
          attachments: [],
          createdBy: { kind: "user", userId: "Usr001" },
          lastEditedBy: { kind: "user", userId: "Usr001" },
          lastEditedByDisplayName: "Mira Solberg",
          recoveryCopyCount: 0,
          revision: 1,
          state: "draft",
          deliveryClass: "normal",
          suggestion: false,
          createdAt: stamp,
          updatedAt: stamp,
        };
        return route.fulfill({ json: { ...draft, creationOutcome: "created" } });
      }
      if (method === "POST" && path === "/commands") {
        const body = request.postDataJSON();
        commands.push(body);
        next.resolve(body);
        next = Promise.withResolvers<unknown>();
        if (options.sendFails)
          return route.fulfill({ status: 503, json: { code: "SMTP_UNAVAILABLE", message: "Der Mailserver antwortet nicht." } });
        return route.fulfill({
          json: { id: "00000000-0000-4000-8000-0000000000f1", result: { conversationId: "Demo01", outboxSubmissionId: "Dlv001" } },
        });
      }
      const drafted = /^\/drafts\/DrfNew(\/.*)?$/.exec(path);
      if (drafted && draft) {
        const rest = drafted[1] ?? "";
        if (rest === "/lease" && (method === "POST" || method === "PUT"))
          return route.fulfill({
            json: {
              holder: { kind: "user", id: "Usr001", displayName: "Mira Solberg", avatarHash: null },
              acquiredAt: stamp,
              expiresAt: new Date(Date.parse(stamp) + 10 * 60_000).toISOString(),
              token: "00000000-0000-4000-8000-0000000000c1",
            },
          });
        if (rest === "/lease" && method === "DELETE") return route.fulfill({ status: 204, body: "" });
        if (rest === "/lease") return route.fulfill({ json: null });
        if (rest === "/attachment-uploads") return route.fulfill({ json: [] });
        if (rest === "" && method === "PUT") {
          draft = { ...draft, ...request.postDataJSON().draft, revision: Number(draft.revision) + 1 };
          return route.fulfill({ json: draft });
        }
        if (rest === "" && method === "GET") return route.fulfill({ json: draft });
        if (rest === "/safety-review")
          return route.fulfill({
            json: { revision: draft.revision, fingerprint: "f".repeat(64), warnings: [], contentHash: "a".repeat(64) },
          });
      }
      return route.fallback();
    });
    return { calls, commands, nextSend: () => next.promise };
  };
  /** Opens the reply of the first conversation and types into Mail's editor in the frame. */
  const openReply = async (page: Page, text: string) => {
    await page.locator(".k2-composer-start").click();
    const editor = page.locator('[data-k2-part="Canvas"] [data-mail-reply-box="mail"] [contenteditable="true"]').first();
    await editor.waitFor();
    await editor.click();
    await page.keyboard.type(text);
    return page.locator('[data-k2-part="Canvas"] [data-k2-part="Composer"]');
  };

  test("the open reply sends what was typed through Mail's own send, from the frame's Send", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`);
    try {
      const api = await answerReplyApi(page);
      const composer = await openReply(page, "Danke, KW 49 passt uns.");
      const sent = api.nextSend();
      await composer.locator('[data-k2-part="Button"][data-variant="primary"]').click();
      const command = (await sent) as { draftId?: string };
      // The draft that was sent is the one the seed became, with the typed text saved before the send.
      expect(command.draftId).toBe("DrfNew");
      expect(api.calls).toContain("POST /draft-seeds/materialize");
      expect(api.calls).toContain("POST /drafts/DrfNew/safety-review");
      expect(api.commands).toHaveLength(1);
      expect(errorsOf.get(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a failed send keeps the reply open with its text, and Send repeats it", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`);
    try {
      const api = await answerReplyApi(page, { sendFails: true });
      const composer = await openReply(page, "Danke, KW 49 passt uns.");
      const send = composer.locator('[data-k2-part="Button"][data-variant="primary"]');
      const first = api.nextSend();
      await send.click();
      await first;
      await page.locator('[data-k2-part="Canvas"] [data-mail-reply-box="mail"][data-send-failed]').waitFor();
      // The reason is said, and the text waits in the same frame for the next try.
      await page.getByText("Der Mailserver antwortet nicht.").first().waitFor();
      expect(await composer.locator('[contenteditable="true"]').first().textContent()).toContain("Danke, KW 49 passt uns.");
      await settled(page);
      const again = api.nextSend();
      await send.click();
      // The same draft goes out again through the same command.
      expect(((await again) as { draftId?: string }).draftId).toBe("DrfNew");
      expect(api.commands).toHaveLength(2);
      expect(errorsOf.get(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("opening the reply moves nothing in its row: the mode, To, the recipient and the sender keep their place", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`);
    try {
      await answerReplyApi(page);
      // x of the mode's symbol, "An", the recipient's name and the sender's control, and the placeholder's type
      const row = () =>
        page.evaluate(() => {
          const composer = Array.from(document.querySelectorAll('[data-k2-part="Composer"]')).at(-1)!;
          const head = composer.querySelector(".k2-composer-head")!;
          const x = (element: Element | null | undefined) => (element ? Math.round(element.getBoundingClientRect().x * 10) / 10 : null);
          const name = head.querySelector(".mail-recipient-pill") ?? head.querySelector(".k2-composer-to > .k2-text:not(.k2-t-meta)");
          const from = Array.from(head.querySelectorAll('[data-k2-part="Button"]')).find((button) =>
            button.textContent?.startsWith("von "),
          );
          const words =
            composer.querySelector(".cm-placeholder") ??
            composer.querySelector('[data-k2-part="Composer"] .k2-composer-start, .k2-composer-start');
          const style = words ? getComputedStyle(words) : null;
          return {
            mode: x(head.querySelector(".k2-composer-to > .k2-icon")),
            to: x(head.querySelector(".k2-composer-to > .k2-t-meta")),
            name: x(name),
            nameText: name?.textContent?.trim(),
            from: x(from),
            fromMenu: from?.getAttribute("aria-haspopup"),
            placeholder: style && { size: style.fontSize, line: style.lineHeight, family: style.fontFamily, color: style.color },
          };
        });
      const resting = await row();
      await page.locator(".k2-composer-start").click();
      await page.locator('[data-k2-part="Canvas"] [data-mail-reply-box="mail"] [contenteditable="true"]').first().waitFor();
      await page.locator('[data-k2-part="Canvas"] .cm-placeholder').waitFor();
      await settled(page);
      const opened = await row();
      // every part is there, so equal places compare numbers, not two missing parts
      for (const [part, value] of Object.entries(resting)) expect(value, part).not.toBeNull();
      for (const [part, value] of Object.entries(resting)) expect(value, part).not.toBeUndefined();
      expect(opened).toEqual(resting);
      // The name alone, whole while there is room; the address is the chip's hint.
      const chip = page.locator('[data-k2-part="Canvas"] .mail-recipient-pill');
      expect(await chip.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await chip.getAttribute("title")).toContain("einkauf@holzwerk-brandt.example");
      expect(errorsOf.get(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("the reply's mode is one choice at the top of More: choosing the note closes the menu and shows the note", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`);
    try {
      await answerReplyApi(page);
      const composer = await openReply(page, "Hallo");
      await composer.getByRole("button", { name: "Mehr" }).click();
      const reply = page.getByRole("menuitemradio", { name: "Antworten", exact: true });
      await reply.waitFor();
      expect(await reply.getAttribute("aria-checked")).toBe("true");
      expect(await page.getByRole("group", { name: "Antwortart" }).count()).toBe(1);
      await page.getByRole("menuitemradio", { name: /Interne Notiz/ }).click();
      // The menu closes on the choice; the draft steps aside for the internal note in the same place.
      await page.locator('[data-k2-part="Canvas"] [data-mail-reply-box="note"]').waitFor();
      // (the note's own mode menu is v1's and keeps its entries closed in the page; the v2 menu leaves it)
      await page.waitForFunction(() => document.querySelector(".k2-menu") === null);
      expect(await page.locator('[data-k2-part="Canvas"] [data-mail-reply-box="mail"]').isHidden()).toBe(true);
      expect(errorsOf.get(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("Cc and Bcc of the open reply open Mail's recipient rows in the frame", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`);
    try {
      await answerReplyApi(page);
      const composer = await openReply(page, "Hallo");
      await composer.locator('[data-k2-part="Button"]', { hasText: /^Cc$/ }).click();
      await composer.locator(".mail-inline-draft-rows").waitFor();
      expect(await composer.locator(".mail-inline-draft-rows input").count()).toBe(2);
      // Cc and Bcc have their rows now; the head no longer offers them.
      expect(await composer.locator('[data-k2-part="Button"]', { hasText: /^(Cc|Bcc)$/ }).count()).toBe(0);
      expect(errorsOf.get(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // As in v1: a list scrolled down holds the focused row in place; at the very top the new mail shows above.
  test("a live mail keeps the focused row focused and a scrolled list where it was", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`, 1440, 560);
    try {
      const list = page.locator('[data-k2-part="Pane"] > [data-scroll-preserve^="mail-list-"]');
      await list.evaluate((element) => {
        element.scrollTop = 120;
      });
      expect(await list.evaluate((element) => element.scrollTop)).toBe(120);
      await rowLink(page, "Lackfabrik Nordhaus").focus();
      await settled(page);
      const before = await row(page, "Lackfabrik Nordhaus").boundingBox();
      server.arrive();
      await row(page, "Neue Sendung 1").waitFor();
      await settled(page);
      expect(await focusedRow(page)).toContain("Lackfabrik Nordhaus");
      // The new row above pushes nothing out of place: the focused row stays where the person looks.
      const after = await row(page, "Lackfabrik Nordhaus").boundingBox();
      expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  }, 60_000);
});

// The live states the mockup has no picture of: each measured on its own, so a double line, a line inside one thing
// or a lost edge shows in the state where it appears (Valentin's findings of 23.11. passed the screens above).
describe("Mail on the v2 pilot in its live states", () => {
  /** The lines inside each message: a message's text, attachments and head are one band, closed by its own line. */
  const linesInsideMessages = (page: Page) =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-k2-part="Pane"][data-detail] [data-k2-part="Band"]')).flatMap((band) =>
        Array.from(band.querySelectorAll("*"))
          .filter((element) => !element.parentElement?.closest("[data-k2-canvas]"))
          .filter((element) => {
            const style = getComputedStyle(element);
            const framed = ["Top", "Right", "Bottom", "Left"].filter(
              (side) => Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0,
            );
            // A divider is one side alone; a framed or rounded box (a tile, a button) is no line.
            return framed.length === 1 && Number.parseFloat(style.borderRadius) === 0;
          })
          .map((element) => `${element.getAttribute("data-k2-part") ?? element.tagName.toLowerCase()} in a message`),
      ),
    );

  test("a thread of several messages: one line between two messages, none above the attachments", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`, 1440, 2200);
    try {
      await settled(page);
      expect(await page.locator('[data-k2-part="Pane"][data-detail] [data-k2-part="Band"] [data-k2-part="Tiles"]').count()).toBe(1);
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
      expect(await linesInsideMessages(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("the open composer keeps the place of the resting one and draws no second line", async () => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`, 1440, 2200);
    try {
      await page.locator(".k2-composer-signature").getByText("Tischlerei Solberg & Kramer").waitFor();
      const resting = await page.locator('[data-k2-part="Composer"]').boundingBox();
      const restingSignature = await page.locator(".k2-composer-signature").boundingBox();
      await page.locator(".k2-composer-start").click();
      await page.locator('[data-k2-part="Canvas"] [contenteditable="true"]').first().waitFor();
      // The seed carries the sender's signature, as the server derives it; the frame shows it once it loaded.
      const signature = page.locator('[data-k2-part="Canvas"] [data-mail-draft-signature]');
      await signature.getByText("Tischlerei Solberg & Kramer").waitFor();
      await settled(page);
      const open = await page.locator('[data-k2-part="Canvas"] [data-k2-part="Composer"]').boundingBox();
      // The signature looks as it did at rest: the same edge and the same two quiet lines, no block of its own.
      const openSignature = await signature.boundingBox();
      expect({ left: openSignature?.x, height: openSignature?.height }).toEqual({
        left: restingSignature?.x,
        height: restingSignature?.height,
      });
      // 8 px from the column's edges and 12 px below the summary, like the resting frame. Head and foot keep their
      // height; the text grows only by the quote of the answered message, which shows what goes along, and one line.
      expect({ left: open?.x, top: open?.y, width: open?.width }).toEqual({ left: resting?.x, top: resting?.y, width: resting?.width });
      const quote = (await page.locator('[data-k2-part="Canvas"] .mail-quote-card').boundingBox())?.height ?? 0;
      expect((open?.height ?? 0) - (resting?.height ?? 0) - quote).toBeLessThanOrEqual(24);
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
      expect(await linesInsideMessages(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  const selectionKeepsLayout = async (width: number) => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`, width);
    try {
      await page.locator('[data-k2-part="StatusRow"]').getByRole("checkbox").click();
      await page.locator('[data-k2-part="StatusRow"][data-selecting]').waitFor();
      await settled(page);
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
    } finally {
      await page.close();
    }
  };
  test("selection mode in the list at 1280 px keeps the v2 layout", () => selectionKeepsLayout(1280), 60_000);
  test("selection mode in the list at 1024 px keeps the v2 layout", () => selectionKeepsLayout(1024), 60_000);

  /**
   * What a narrow place cuts: a button or tab past the edge of its column, and a first line of a list row that wraps
   * instead of ending in "…". Neither is a line or a type role, so the layout measure does not see them.
   */
  const cutOff = (page: Page) =>
    page.evaluate(() => {
      const found: string[] = [];
      for (const control of Array.from(document.querySelectorAll('[data-k2-workspace] :is([data-k2-part="Button"], .k2-tab)'))) {
        const column = control.closest("[data-k2-column]")?.getBoundingClientRect();
        const box = control.getBoundingClientRect();
        if (column && box.width > 0 && (box.right > column.right + 0.5 || box.left < column.left - 0.5))
          found.push(`${control.getAttribute("aria-label") ?? control.textContent?.trim()} runs past its column`);
      }
      for (const line of Array.from(document.querySelectorAll('[data-k2-part="List"] > [data-k2-part="Row"] > .k2-row-l1')))
        if (line.getBoundingClientRect().height > 20.5) found.push(`"${line.textContent?.trim()}" wraps in its row`);
      return found;
    });
  const cutAt = async (width: number, select: boolean) => {
    const page = await open(`${MAIL_V2_PATH}?conversation=Demo01`, width);
    try {
      if (select) {
        await page.locator('[data-k2-part="StatusRow"]').getByRole("checkbox").click();
        await page.locator('[data-k2-part="StatusRow"][data-selecting]').waitFor();
      }
      await settled(page);
      return await cutOff(page);
    } finally {
      await page.close();
    }
  };

  test("at 1440 px nothing is cut: every control within its column, every row's first line on one line", async () => {
    expect(await cutAt(1440, false)).toEqual([]);
  }, 60_000);

  // The StatusRow turns its selection's actions into icons, then "…", by the column's width (#4077).
  test("with a selection the selection's actions fit the list column", async () => {
    expect(await cutAt(1440, true)).toEqual([]);
  }, 60_000);

  // At 1024 px the head's tabs give way to its actions (the Bar's end keeps its room), and a row's first line ends in
  // "…" before its note (#4083).
  test("at 1024 px nothing is cut: the head's actions keep their room, every row's first line on one line", async () => {
    expect(await cutAt(1024, false)).toEqual([]);
  }, 60_000);
});

// The worst realistic data (break-ui 25.11., mail-v2.browser-worst-fixture.ts): long names, addresses and tags, many
// marks, tags, links and readers. Nothing may be pressed to nothing, stand one letter per line, or be cut without "…".
describe("Mail on the v2 pilot with worst-case data", () => {
  const worst = `${MAIL_V2_PATH}?fixture=worst`;
  for (const width of [1440, 1024, 390] as const)
    for (const [state, path] of [
      ["the list", worst],
      ["the reader", `${worst}&conversation=Worst01`],
    ] as const)
      test(`${state} at ${width} px keeps every text readable`, async () => {
        const page = await open(path, width);
        try {
          await settled(page);
          const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
          expect(layout.squeezed).toEqual([]);
          expect(layout.cut).toEqual([]);
          expect(errorsOf.get(page)).toEqual([]);
        } finally {
          await page.close();
        }
      }, 60_000);

  test("the reader's state line shows three tags and the rest behind +N, the readers as faces and a count", async () => {
    const page = await open(`${worst}&conversation=Worst01`, 1440);
    try {
      const status = page.locator('[data-k2-part="Pane"][data-detail] > [data-slot="status"]');
      expect(await status.locator('.k2-chip[data-kind="tag"]').count()).toBe(3);
      await status.getByRole("button", { name: /^\+\d+$/ }).waitFor();
      await status.getByText(/^\d+ lesen mit$/).waitFor();
      // with 12 tags, 14 links and 5 readers the line takes two lines at most (it took 170 px), each tag cut to ~16 letters
      expect((await status.locator(":scope > .k2-bar").boundingBox())?.height ?? 0).toBeLessThanOrEqual(80);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("the open reply keeps To whole and the sender within half the head", async () => {
    const page = await open(`${worst}&conversation=Worst01`, 1440);
    try {
      await page.locator(".k2-composer-start").click();
      await page.locator('[data-k2-part="Canvas"] [data-k2-part="Composer"]').waitFor();
      await settled(page);
      const head = await page.locator('[data-k2-part="Canvas"] .k2-composer-head').boundingBox();
      const end = await page.locator('[data-k2-part="Canvas"] .k2-composer-head-end').boundingBox();
      expect((end?.width ?? 0) <= (head?.width ?? 0) / 2 + 1).toBe(true);
      expect((end?.x ?? 0) + (end?.width ?? 0)).toBeLessThanOrEqual((head?.x ?? 0) + (head?.width ?? 0) + 0.5);
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).squeezed).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // "Jede Liste, die potenziell unendlich wachsen kann, muss virtualisiert sein" (maintainer, 25.11.).
  test("1,000 conversations keep only the rows in view in the page, from the first render to the last row", async () => {
    const page = await open(`${MAIL_V2_PATH}?fixture=huge`, 1440);
    try {
      const rows = page.locator('[data-k2-part="List"] > [data-k2-part="Row"]');
      expect(await rows.count()).toBeLessThanOrEqual(60);
      expect(await page.evaluate(() => document.querySelectorAll("*").length)).toBeLessThan(1500);
      expect(await rows.first().getAttribute("aria-setsize")).toBe("1000");
      const list = page.locator('[data-k2-part="Pane"] > [data-scroll-preserve^="mail-list-"]');
      await list.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('[data-k2-part="List"] > [data-k2-part="Row"]')).some(
          (row) => row.getAttribute("aria-posinset") === "1000",
        ),
      );
      await settled(page);
      expect(await rows.count()).toBeLessThanOrEqual(60);
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
