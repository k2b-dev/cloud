import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { chatTestNow, pinPageClock, startChatHarness, viewer } from "./ChatWorkspace.browser-fixture";

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

const lea = { id: "44444444-4444-4444-8444-444444444444", name: "Lea Muster" };
const ben = { id: "55555555-5555-4555-8555-555555555555", name: "Ben Schulz" };
const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const passage = "the quarterly report is ready for review";

/** A chat where Lea and Ben wrote; the viewer reads it. */
const seed = () => {
  const chat = harness.addChat({ members: [viewer, lea, ben], name: "Planning", count: 0, end: chatTestNow });
  harness.receive(chat, lea, `Good morning! I think ${passage} today, the numbers are in the shared folder.`);
  harness.receive(chat, ben, "Thanks, I read it after lunch.");
  harness.receive(chat, viewer, "The slides are in the same folder as the report.");
  return chat;
};
const load = async (options: BrowserContextOptions, chat: string, locale: "en" | "de" = "en", theme = "light") => {
  const context = await browser.newContext({ ...options, colorScheme: theme === "dark" ? "dark" : "light" });
  await context.addInitScript(pinPageClock, chatTestNow.getTime() + 60_000);
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const errors = pageErrors(page);
  await page.goto(new URL(`/app/chat/c/${chat}?theme=${theme}`, harness.url).href);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(({ props, locale }) => window.mountChat(props, locale), { props: harness.props({ chat }), locale });
  await page.locator(".chat-workspace").waitFor();
  await settled(page);
  return { page, errors };
};
const shot = async (page: Page, name: string) => {
  if (!process.env.CHAT_QUOTE_SHOTS) return;
  await mkdir(process.env.CHAT_QUOTE_SHOTS, { recursive: true });
  await page.screenshot({ path: `${process.env.CHAT_QUOTE_SHOTS}/${name}.png` });
};
/** Selects `text` inside the message that contains it, as the keyboard or a script does. */
const select = (page: Page, text: string) =>
  page.evaluate((text) => {
    const node = [...document.querySelectorAll(".k2b-message-row__text")]
      .flatMap((element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const nodes: Text[] = [];
        for (let next = walker.nextNode(); next; next = walker.nextNode()) nodes.push(next as Text);
        return nodes;
      })
      .find((candidate) => candidate.data.includes(text))!;
    const range = document.createRange();
    range.setStart(node, node.data.indexOf(text));
    range.setEnd(node, node.data.indexOf(text) + text.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  }, text);
/** The box of `text` inside the message that contains it. */
const textBox = (page: Page, text: string) =>
  page.evaluate((text) => {
    const element = [...document.querySelectorAll(".k2b-message-row__text")].find((candidate) => candidate.textContent?.includes(text))!;
    const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode() as Text;
    const range = document.createRange();
    const start = node.data.indexOf(text);
    range.setStart(node, start);
    range.setEnd(node, start + 1);
    const first = range.getBoundingClientRect();
    range.setStart(node, start + text.length - 1);
    range.setEnd(node, start + text.length);
    const last = range.getBoundingClientRect();
    return { x1: first.left + 1, x2: last.right + 1, y: first.top + first.height / 2 };
  }, text);
const rows = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll(".k2b-virtual-feed__item")].map((row) => row.getBoundingClientRect().top));
const pill = (page: Page) => page.locator(".k2b-selection-toolbar:popover-open");

test("a selected passage goes into the composer as a quote, is sent with the answer, and jumps back to its passage", async () => {
  const chat = seed();
  const { page, errors } = await load(desktop, chat);
  try {
    const before = await rows(page);
    const box = await textBox(page, passage);
    await page.mouse.move(box.x1, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x2, box.y, { steps: 6 });
    await page.mouse.up();
    await pill(page).waitFor();
    await settled(page);
    expect(await pill(page).getAttribute("data-side")).toBe("above");
    // The pill floats in the top layer: the history does not move.
    expect(await rows(page)).toEqual(before);
    await shot(page, "01-pill-light-1440");

    await pill(page).getByRole("button", { name: "Quote", exact: true }).click();
    const draft = page.locator(".k2b-chat-composer__quote");
    await draft.waitFor();
    expect(await draft.innerText()).toContain(passage);
    expect(await draft.innerText()).toContain("Lea Muster");
    await page.waitForFunction(() => document.activeElement?.matches(".k2b-chat-composer textarea") === true);
    expect(await pill(page).count()).toBe(0);
    // Once its fade has ended, the pill is gone: closed, not drawn, out of the focus order and the accessibility tree.
    await settled(page);
    const closed = await page.evaluate(() => {
      const toolbar = document.querySelector<HTMLElement>(".k2b-selection-toolbar")!;
      const style = getComputedStyle(toolbar);
      return {
        open: toolbar.matches(":popover-open"),
        display: style.display,
        opacity: style.opacity,
        focus: toolbar.contains(document.activeElement),
      };
    });
    expect(closed).toEqual({ open: false, display: "none", opacity: "0", focus: false });
    expect(await page.getByRole("button", { name: "Quote", exact: true }).count()).toBe(0);
    await shot(page, "02-composer-light-1440");

    await page.keyboard.type("Agreed, I review it before noon.");
    await page.keyboard.press("Enter");
    const sent = page.locator(".k2b-message-row[data-own]", { hasText: "Agreed, I review it" });
    await sent.locator(".k2b-message-quote").waitFor();
    const source = harness.props({ chat }).open!.page.items.find((item) => item.author.id === lea.id)!.id;
    expect(harness.posted.at(-1)).toMatchObject({ body: "Agreed, I review it before noon.", quotes: [{ message: source, text: passage }] });
    expect(harness.posted.at(-1)?.thread).toBeUndefined();
    expect(await draft.count()).toBe(0);
    expect(await sent.locator(".k2b-message-quote .k2b-sr-only").innerText()).toBe("Quote from Lea Muster:");
    await page.locator(".k2b-message-row[data-status='sent']", { hasText: "Agreed, I review it" }).waitFor();
    await settled(page);
    await shot(page, "03-sent-light-1440");

    await sent.locator("button.k2b-message-quote").click();
    await page.waitForFunction(() => CSS.highlights.has("k2b-virtual-feed-passage"));
    const tinted = await page.evaluate(() => [...CSS.highlights.get("k2b-virtual-feed-passage")!][0]!.toString());
    expect(tinted).toBe(passage);
    // Only the passage is tinted, not the whole message.
    expect(await page.locator(".k2b-virtual-feed__item[data-highlighted]").count()).toBe(0);
    await shot(page, "04-jump-light-1440");
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 30_000);

test("Escape closes the pill without leaving the chat, and a deleted original leaves its quote without text", async () => {
  const chat = seed();
  const { page, errors } = await load(desktop, chat);
  try {
    await select(page, "The slides are in the same folder");
    await pill(page).waitFor();
    await page.keyboard.press("Escape");
    await pill(page).waitFor({ state: "detached" });
    expect(await pill(page).count()).toBe(0);
    expect(new URL(page.url()).pathname).toBe(`/app/chat/c/${chat}`);

    await select(page, "slides are in the same folder");
    await pill(page).getByRole("button", { name: "Quote", exact: true }).click();
    await page.locator(".k2b-chat-composer__quote").waitFor();
    await page.keyboard.type("Moved them.");
    await page.keyboard.press("Enter");
    const sent = page.locator(".k2b-message-row[data-own]", { hasText: "Moved them." });
    await page.locator(".k2b-message-row[data-status='sent']", { hasText: "Moved them." }).waitFor();
    expect(await sent.locator(".k2b-message-quote").innerText()).toContain("slides are in the same folder");

    const original = page.locator(".k2b-message-row", { hasText: "The slides are in the same folder" });
    await original.hover();
    await original.getByRole("button", { name: "Message actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete message", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete message", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await sent.locator(".k2b-message-quote", { hasText: "Passage no longer available" }).waitFor();
    expect(await sent.locator(".k2b-message-quote").innerText()).not.toContain("slides");
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 30_000);

test("on a phone, where a held finger opens the menu instead of a selection, Quote in the menu quotes the message", async () => {
  const chat = seed();
  const { page, errors } = await load(phone, chat, "de");
  try {
    const item = page.locator(".k2b-virtual-feed__item", { hasText: passage });
    const box = (await item.locator(".k2b-message-row__text").boundingBox())!;
    const point = { x: box.x + 8, y: box.y + box.height / 2 };
    await page.evaluate(async (point) => {
      const target = document.elementFromPoint(point.x, point.y)!;
      const init: PointerEventInit = {
        pointerType: "touch",
        isPrimary: true,
        pointerId: 1,
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
      };
      target.dispatchEvent(new PointerEvent("pointerdown", init));
      await new Promise((resolve) => setTimeout(resolve, 650)); // real clock: the long press GestureMenu waits for
      target.dispatchEvent(new PointerEvent("pointerup", init));
    }, point);
    const sheet = page.locator("dialog[open]");
    await sheet.waitFor();
    await shot(page, "05-menu-light-390");
    await sheet.getByRole("menuitem", { name: "Zitieren", exact: true }).tap();
    const draft = page.locator(".k2b-chat-composer__quote");
    await draft.waitFor();
    expect(await draft.innerText()).toContain(`Good morning! I think ${passage} today`);
    expect(await draft.locator(".k2b-sr-only").innerText()).toBe("Zitat von Lea Muster:");
    await settled(page);
    await shot(page, "06-composer-light-390");
    await draft.getByRole("button", { name: "Zitat entfernen", exact: true }).tap();
    expect(await draft.count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 30_000);

test("Quote in the menu takes the message's text without its code bar", async () => {
  const chat = seed();
  harness.receive(chat, ben, "Run this first:\n\n```sh\nbun install\n```");
  const { page, errors } = await load(desktop, chat);
  try {
    const row = page.locator(".k2b-message-row", { hasText: "Run this first" });
    await row.hover();
    await row.getByRole("button", { name: "Message actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Quote", exact: true }).click();
    const draft = page.locator(".k2b-chat-composer__quote");
    await draft.waitFor();
    expect(await draft.locator(".k2b-message-quote__text").innerText()).toBe("Run this first: bun install");
    await page.keyboard.type("Done.");
    await page.keyboard.press("Enter");
    await page.locator(".k2b-message-row[data-status='sent']", { hasText: "Done." }).waitFor();
    expect(harness.posted.at(-1)?.quotes?.[0]?.text).toBe("Run this first: bun install");
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 30_000);

// #3702: the focus is in the field before the quote's code has loaded; a send then must carry the quote, never leave it
// behind in the field next to the next one.
test("a send right after Quote carries the quote while its code still loads, and leaves the field without it", async () => {
  const chat = seed();
  const { page, errors } = await load(desktop, chat);
  let release = () => {};
  try {
    const loading = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/chat-quote-selection-*.js", async (route) => {
      await loading;
      await route.continue();
    });
    const row = page.locator(".k2b-message-row", { hasText: passage });
    await row.hover();
    await row.getByRole("button", { name: "Message actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Quote", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.matches(".k2b-chat-composer textarea") === true);
    await page.keyboard.type("Thanks!");
    await page.keyboard.press("Enter");
    // #3999: the message shows as pending at once, while only its post waits for the quote.
    await page.locator(".k2b-message-row[data-status='pending']", { hasText: "Thanks!" }).waitFor();
    expect(harness.posted.some((sent) => sent.body === "Thanks!")).toBe(false);
    release();
    const sent = page.locator(".k2b-message-row[data-status='sent']", { hasText: "Thanks!" });
    await sent.waitFor();
    const source = harness.props({ chat }).open!.page.items.find((item) => item.author.id === lea.id)!.id;
    expect(harness.posted.at(-1)).toMatchObject({ body: "Thanks!", quotes: [{ message: source }] });
    expect(await sent.innerText()).toContain(passage);
    await settled(page);
    expect(await page.locator(".k2b-chat-composer__quote").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    release();
    await page.context().close();
  }
}, 30_000);

// #3999: a send that waited for a quote whose code then failed to load never goes out without it unasked. It stays
// "not sent" with the reason; Retry loads the code again, and "Send without quote" is the person's own choice.
for (const answer of ["Retry", "Send without quote"] as const) {
  test(`a quote whose code fails to load keeps the message back until ${answer}`, async () => {
    const chat = seed();
    const { page, errors } = await load(desktop, chat);
    try {
      let fail = true;
      await page.route("**/chat-quote-selection-*.js", (route) => (fail ? route.abort("failed") : route.continue()));
      const row = page.locator(".k2b-message-row", { hasText: passage });
      await row.hover();
      await row.getByRole("button", { name: "Message actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Quote", exact: true }).click();
      await page.waitForFunction(() => document.activeElement?.matches(".k2b-chat-composer textarea") === true);
      await page.keyboard.type("Thanks!");
      await page.keyboard.press("Enter");
      const sent = page.locator(".k2b-message-row[data-own]", { hasText: "Thanks!" });
      await sent.and(page.locator("[data-status='failed']")).waitFor();
      expect(await sent.locator(".k2b-message-row__line").innerText()).toContain("The quote could not load");
      expect(harness.posted.some((message) => message.body === "Thanks!")).toBe(false);
      fail = false;
      await sent.getByRole("button", { name: answer, exact: true }).click();
      await sent.and(page.locator("[data-status='sent']")).waitFor();
      const source = harness.props({ chat }).open!.page.items.find((item) => item.author.id === lea.id)!.id;
      if (answer === "Retry") {
        expect(harness.posted.at(-1)).toMatchObject({ body: "Thanks!", quotes: [{ message: source }] });
        expect(await sent.innerText()).toContain(passage);
      } else {
        expect(harness.posted.at(-1)?.body).toBe("Thanks!");
        expect(harness.posted.at(-1)?.quotes ?? []).toEqual([]);
      }
      // The failed load shows Cloud's reload notice; nothing else fails on the page.
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
}

test("a send whose quote the server refuses never blocks the next send, and comes back into an empty field", async () => {
  const chat = seed();
  const { page, errors } = await load(desktop, chat);
  try {
    harness.refuseQuotes();
    const held = harness.holdSends();
    await select(page, passage);
    await pill(page).getByRole("button", { name: "Quote", exact: true }).click();
    await page.locator(".k2b-chat-composer__quote").waitFor();
    await page.keyboard.type("This one is refused.");
    await page.keyboard.press("Enter");
    // The next message waits behind the first while the server still holds its answer.
    await page.keyboard.type("This one arrives.");
    await page.keyboard.press("Enter");
    held.answer();
    await page.locator(".k2b-message-row[data-status='sent']", { hasText: "This one arrives." }).waitFor();
    await page.locator(".k2b-toast", { hasText: "The quoted message was changed or deleted" }).waitFor();
    // The field was empty, so text and quote are back in it, and nothing is left as "Not sent".
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>(".k2b-chat-composer textarea")?.value === "This one is refused.",
    );
    expect(await page.locator(".k2b-chat-composer__quote").innerText()).toContain(passage);
    expect(await page.locator(".k2b-message-row", { hasText: "This one is refused." }).count()).toBe(0);
    expect(await page.locator(".k2b-message-row[data-status='failed']").count()).toBe(0);
    expect(harness.posted.map((sent) => sent.body)).toEqual(["This one is refused.", "This one arrives."]);
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 30_000);

test("a refused send stays as Not sent with only Discard while the person already writes the next message", async () => {
  const chat = seed();
  const { page, errors } = await load(desktop, chat);
  try {
    harness.refuseQuotes();
    const held = harness.holdSends();
    await select(page, passage);
    await pill(page).getByRole("button", { name: "Quote", exact: true }).click();
    await page.locator(".k2b-chat-composer__quote").waitFor();
    await page.keyboard.type("This one is refused.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Still writing");
    held.answer();
    const refused = page.locator(".k2b-message-row[data-status='failed']", { hasText: "This one is refused." });
    await refused.waitFor();
    expect(await refused.getByRole("button", { name: "Try again" }).count()).toBe(0);
    expect(await page.evaluate(() => document.querySelector<HTMLTextAreaElement>(".k2b-chat-composer textarea")?.value)).toBe(
      "Still writing",
    );
    await refused.getByRole("button", { name: "Discard" }).click();
    await refused.waitFor({ state: "detached" });
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 30_000);

test("quotes in the dark theme", async () => {
  const chat = seed();
  harness.receive(chat, ben, "One more detail about the numbers.");
  const { page, errors } = await load(desktop, chat, "en", "dark");
  try {
    await select(page, passage);
    await pill(page).getByRole("button", { name: "Quote", exact: true }).click();
    await page.keyboard.type("Thanks!");
    await page.keyboard.press("Enter");
    await page.locator(".k2b-message-row[data-status='sent']", { hasText: "Thanks!" }).waitFor();
    await select(page, "One more detail");
    await pill(page).getByRole("button", { name: "Quote", exact: true }).click();
    await page.locator(".k2b-chat-composer__quote").waitFor();
    await settled(page);
    await shot(page, "07-dark-1440");
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 30_000);
