import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { chatTestNow, nora, startChatHarness, tobias, viewer } from "./ChatWorkspace.browser-fixture";

let harness: Awaited<ReturnType<typeof startChatHarness>>;
let browser: Browser;
beforeAll(async () => {
  harness = await startChatHarness();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  harness?.stop();
});
beforeEach(() => harness.reset());

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const minutesAgo = (minutes: number) => new Date(chatTestNow.getTime() - minutes * 60_000).toISOString();

const load = async (options: BrowserContextOptions, address: { chat: string; thread?: string }) => {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  await page.addInitScript((timestamp) => {
    const RealDate = Date;
    class PinnedDate extends RealDate {
      constructor(...args: ConstructorParameters<DateConstructor> | []) {
        if (args.length === 0) super(timestamp);
        else super(...args);
      }
      static override now() {
        return timestamp;
      }
    }
    Object.defineProperty(globalThis, "Date", { value: PinnedDate, configurable: true, writable: true });
  }, chatTestNow.getTime());
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(new URL(`/app/chat/c/${address.chat}${address.thread ? `/t/${address.thread}` : ""}`, harness.url).href);
  await page.evaluate((props) => {
    document.documentElement.lang = "de";
    window.mountChat(props, "de");
  }, harness.props(address));
  await page.locator(".chat-workspace").waitFor();
  await settled(page);
  return { page, errors };
};

/** A Space chat with two item threads, one change between messages, and four changes in a row. */
const seed = () => {
  const ref = { type: "spaces.space", id: "Space1" };
  const chat = harness.addChat({ members: [viewer, nora, tobias], name: "Frühlingsausstellung", count: 2, end: new Date(minutesAgo(30)) });
  harness.setSystem(chat, ref);
  const [invitation, light] = ["Einladung freigeben", "Lichtprobe"].map((name, index) => {
    const thread = harness.addThread(chat, { name, description: "Item", count: 1, end: new Date(minutesAgo(40 + index)) });
    harness.resourceThread(chat, thread, {
      ref: { type: "spaces.item", id: `Item0${index}` },
      kind: index === 1 ? "event" : "task",
      status: "Offen",
      done: false,
      href: `/app/spaces/items/Item0${index}`,
    });
    return thread;
  }) as [string, string];
  harness.addItemEvents(chat, [
    {
      id: "e1",
      at: minutesAgo(35),
      icon: "ti ti-progress",
      sentence: "Mara hat den Status auf „In Prüfung“ gesetzt",
      count: 1,
      thread: { id: invitation, name: "Einladung freigeben" },
    },
    {
      id: "e2",
      at: minutesAgo(9),
      icon: "ti ti-calendar-time",
      sentence: "Tim hat den Termin verschoben",
      count: 1,
      thread: { id: light, name: "Lichtprobe" },
    },
    {
      id: "e3",
      at: minutesAgo(8),
      icon: "ti ti-pencil",
      sentence: "Elif hat die Beschreibung geändert",
      count: 1,
      thread: { id: invitation, name: "Einladung freigeben" },
    },
    {
      id: "e4",
      at: minutesAgo(7),
      icon: "ti ti-paperclip",
      sentence: "Du hast „Raumplan-v3.pdf“ angehängt",
      count: 1,
      thread: { ref: { type: "spaces.item", id: "Item99" }, name: "Raumplan abstimmen" },
    },
    {
      id: "e5",
      at: minutesAgo(6),
      icon: "ti ti-calendar",
      sentence: "Lena hat die Fälligkeit auf 23. Okt. gesetzt",
      count: 1,
      thread: { id: light, name: "Lichtprobe" },
    },
  ]);
  return { chat, invitation, light };
};
const feed = (page: Page) => page.getByRole("feed");

describe("Item events in a Space chat", () => {
  for (const [name, options] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`${name}: All threads shows changes as quiet rows with their item, and four in a row as one line that opens`, async () => {
      const { chat } = seed();
      const { page, errors } = await load(options, { chat });
      try {
        const single = feed(page).locator(".k2b-message-event-row", { hasText: "Mara hat den Status auf „In Prüfung“ gesetzt" });
        await single.waitFor();
        expect(await single.locator(".k2b-message-row__origin").innerText()).toBe("Einladung freigeben");
        expect(await single.locator(".k2b-message-row__bubble").count()).toBe(0);
        const group = feed(page).getByRole("button", { name: /^4 Änderungen an Lichtprobe, Einladung freigeben und 1 weiteren/ });
        await group.waitFor();
        expect(await group.getAttribute("aria-expanded")).toBe("false");
        expect(await feed(page).getByText("Elif hat die Beschreibung geändert").count()).toBe(0);
        await group.click();
        await feed(page).getByText("Elif hat die Beschreibung geändert").waitFor();
        expect(await group.getAttribute("aria-expanded")).toBe("true");
        // A change to an item without a thread names the item too.
        await feed(page).locator(".k2b-message-event-row", { hasText: "Raumplan-v3.pdf" }).getByText("Raumplan abstimmen").waitFor();
        await group.click();
        await feed(page).getByText("Elif hat die Beschreibung geändert").waitFor({ state: "detached" });
        // Changes are no messages: the chat's preview still names its last message.
        expect(await page.getByText("Mara hat den Status", { exact: false }).count()).toBe(1);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("a group keeps the keyboard focus while it opens and closes", async () => {
    const { chat } = seed();
    const { page, errors } = await load(desktop, { chat });
    try {
      const group = feed(page).getByRole("button", { name: /^4 Änderungen an/ });
      await group.focus();
      await page.keyboard.press("Enter");
      await feed(page).getByText("Elif hat die Beschreibung geändert").waitFor();
      expect(await group.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      await feed(page).getByText("Elif hat die Beschreibung geändert").waitFor({ state: "detached" });
      expect(await group.getAttribute("aria-expanded")).toBe("false");
      expect(await group.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("when the owning app is unavailable the chat says so and reads the changes again on request", async () => {
    const { chat } = seed();
    harness.failItemEvents(1);
    const { page, errors } = await load(desktop, { chat });
    const reads: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/events")) reads.push(request.url());
    });
    try {
      await page.getByText("Die Änderungen an den Elementen konnten nicht geladen werden.").waitFor();
      expect(await feed(page).locator(".k2b-message-event-row").count()).toBe(0);
      // An update of the chat that keeps its messages (read on another device) neither hides the notice nor asks again.
      const asked = reads.length;
      harness.readElsewhere(chat, 99);
      await page.waitForTimeout(800); // real clock: gives the live update time to arrive
      await page.getByText("Die Änderungen an den Elementen konnten nicht geladen werden.").waitFor();
      expect(reads.length).toBe(asked);
      await page.getByRole("button", { name: "Erneut versuchen" }).click();
      await feed(page).getByText("Mara hat den Status auf „In Prüfung“ gesetzt").waitFor();
      await page.getByText("Die Änderungen an den Elementen konnten nicht geladen werden.").waitFor({ state: "detached" });
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("an item's thread shows only its own changes, without item labels", async () => {
    const { chat, light } = seed();
    const { page, errors } = await load(desktop, { chat, thread: light });
    try {
      await feed(page).getByText("Tim hat den Termin verschoben").waitFor();
      await feed(page).getByText("Lena hat die Fälligkeit auf 23. Okt. gesetzt").waitFor();
      expect(await feed(page).getByText("Elif hat die Beschreibung geändert").count()).toBe(0);
      expect(await feed(page).locator(".k2b-message-event-row .k2b-message-row__origin").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
