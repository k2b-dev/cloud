import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Browser, BrowserContextOptions, Locator, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
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

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 5_000; // real clock: bounds the wait for the in-memory server
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await Bun.sleep(20);
  }
};
/** The page for an address, rendered from the harness's SSR props like the server does. */
const load = async (options: BrowserContextOptions, address: { chat?: string; thread?: string; threadsPage?: boolean }) => {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const path = address.chat
    ? `/app/chat/c/${address.chat}${address.threadsPage ? "/threads" : address.thread ? `/t/${address.thread}` : ""}`
    : "/app/chat";
  await page.goto(new URL(path, harness.url).href);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(({ props }) => window.mountChat(props, "en"), { props: harness.props(address) });
  await page.locator(".chat-workspace").waitFor();
  return { page, errors };
};
/** IT with General history and three threads; Problems has two unread messages, one thread is archived. */
const seed = () => {
  const chat = harness.addChat({ members: [viewer, nora, tobias], name: "IT", count: 6, end: new Date(chatTestNow.getTime() - 3_600_000) });
  const at = (minutes: number) => new Date(chatTestNow.getTime() - minutes * 60_000);
  const old = harness.addThread(chat, { name: "Old network", count: 1, archived: true, end: at(50) });
  const updates = harness.addThread(chat, { name: "Updates", description: "Announcements", count: 2, end: at(30) });
  const problems = harness.addThread(chat, { name: "Problems", description: "Report outages", count: 4, unread: 2, end: at(5) });
  return { chat, old, updates, problems };
};
const sidebar = (page: Page) => page.locator(".k2b-app-workspace__sidebar");
const threadRow = (page: Page, view: string) => sidebar(page).locator(`[data-thread="${view}"]`);
const longPress = async (page: Page, target: Locator) => {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const point = { x: box.x + 8, y: box.y + box.height / 2 };
  await page.evaluate(async (point) => {
    const element = document.elementFromPoint(point.x, point.y)!;
    const init: PointerEventInit = {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 1,
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
    };
    element.dispatchEvent(new PointerEvent("pointerdown", init));
    await new Promise((resolve) => setTimeout(resolve, 650));
    element.dispatchEvent(new PointerEvent("pointerup", init));
  }, point);
};

describe("Chat threads on a desktop", () => {
  test("the open chat lists its threads with counts; a thread opens in place, by its address, and Back returns", async () => {
    const { chat, problems, updates } = seed();
    const { page, errors } = await load(desktop, { chat });
    try {
      await until(() => harness.subscribed(chat));
      // "All threads" first, then General, then the active threads by activity; archived ones only in the picker.
      expect(
        await sidebar(page)
          .locator("[data-thread] .k2b-app-workspace__sidebar-item-label")
          .evaluateAll((labels) => labels.map((label) => label.textContent?.trim())),
      ).toEqual(["All threads", "General", "Problems", "Updates"]);
      expect(await threadRow(page, "all").getAttribute("aria-current")).toBe("page");
      // The chat's own row shows its members while its threads carry the counts.
      expect(await sidebar(page).locator(`a[href="/app/chat/c/${chat}"]`).first().textContent()).toContain("3 members");
      await threadRow(page, problems).click();
      await page.waitForURL(`**/c/${chat}/t/${problems}`);
      await page.locator(".chat-thread-picker", { hasText: "Problems" }).waitFor();
      expect(await page.getByRole("feed").getByText("Problems: update 1", { exact: true }).count()).toBe(1);
      expect(await page.getByRole("feed").getByText("Updates: update 1", { exact: true }).count()).toBe(0);
      // "All threads" read everything it showed; the open thread reports reads for itself only.
      expect(harness.readViews.length).toBeGreaterThan(0);
      expect(harness.readViews.every((read) => read.thread === "all")).toBe(true);
      const before = harness.readViews.length;
      harness.receiveIn(chat, nora, "The printer is offline again", { thread: problems });
      await page.getByRole("feed").getByText("The printer is offline again", { exact: true }).waitFor();
      await until(() => harness.readViews.length > before);
      expect(harness.readViews.slice(before).every((read) => read.thread === problems)).toBe(true);
      await page.goBack();
      await page.waitForURL(`**/c/${chat}`);
      await threadRow(page, "all").and(page.locator('[aria-current="page"]')).waitFor();
      await threadRow(page, updates).click();
      await page.waitForURL(`**/t/${updates}`);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("All threads labels each message with its thread, and writing there goes to General", async () => {
    const { chat, problems } = seed();
    const { page, errors } = await load(desktop, { chat });
    try {
      const chip = page.locator(".k2b-message-row__origin", { hasText: "Problems" }).first();
      await chip.waitFor();
      expect(await page.locator(".k2b-message-row__origin", { hasText: "General" }).count()).toBeGreaterThan(0);
      await page.getByRole("textbox", { name: "Message to General" }).fill("For everyone");
      await page.keyboard.press("Enter");
      await until(() => harness.posted.some((post) => post.body === "For everyone"));
      expect(harness.posted.find((post) => post.body === "For everyone")).toEqual(
        expect.not.objectContaining({ thread: expect.anything() }),
      );
      await chip.click();
      await page.waitForURL(`**/t/${problems}`);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a reply quotes its original, stays in its thread, and the quote jumps back", async () => {
    const { chat, problems } = seed();
    const { page, errors } = await load(desktop, { chat, thread: problems });
    try {
      const original = page.locator(".k2b-message-row:not([data-own])", { hasText: "Problems: update 4" });
      await original.locator(".k2b-message-row__bubble").hover();
      await original.getByRole("button", { name: "Message actions", exact: true }).click();
      const entry = page.getByRole("menuitem", { name: /^Reply/ });
      expect(await entry.innerText()).toContain("The reply stays in this thread, with a quote.");
      await entry.click();
      const field = page.getByRole("textbox", { name: "Message to Problems" });
      expect(await field.getAttribute("placeholder")).toBe("Reply …");
      await page.locator(".k2b-chat-composer__reply", { hasText: "Problems: update 4" }).waitFor();
      await field.fill("On it");
      await page.keyboard.press("Enter");
      await until(() => harness.posted.some((post) => post.body === "On it"));
      expect(harness.posted.find((post) => post.body === "On it")?.replyTo).toBeDefined();
      const reply = page.locator(".k2b-message-row[data-own]", { hasText: "On it" });
      // The stored reply's quote is a button; the send that is still on its way shows it as text.
      await reply.locator("button.k2b-message-row__quote", { hasText: "Problems: update 4" }).click();
      await page.locator(".k2b-virtual-feed__item[data-highlighted]", { hasText: "Problems: update 4" }).waitFor();
      expect(await page.locator(".k2b-chat-composer__reply").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("admins create a thread: a taken name shows at once, a failure keeps the text, success opens it", async () => {
    const { chat } = seed();
    const { page, errors } = await load(desktop, { chat });
    try {
      await threadRow(page, "all").waitFor();
      await sidebar(page).getByText("New thread", { exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      const name = dialog.getByLabel("Name");
      await name.fill("updates");
      await dialog.getByText("“updates” already exists in IT.").waitFor();
      expect(await dialog.getByRole("button", { name: "Create", exact: true }).isDisabled()).toBe(true);
      await name.fill("Lager");
      await dialog.getByLabel("Description").fill("Everything about the warehouse");
      harness.failThreads();
      await dialog.getByRole("button", { name: "Create", exact: true }).click();
      await dialog.getByText("The thread could not be created. Your text is kept.").waitFor();
      expect(await name.inputValue()).toBe("Lager");
      await dialog.getByRole("button", { name: "Try again", exact: true }).click();
      await page.locator(".k2b-toast", { hasText: "Thread “Lager” created" }).waitFor();
      await page.waitForURL(/\/t\/[^/]+$/);
      await page.locator(".chat-thread-picker", { hasText: "Lager" }).waitFor();
      await threadRow(page, "general").click();
      await page.getByRole("feed").getByText(`${viewer.name} created the thread “Lager”`, { exact: true }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("rename and archive in the head; archived threads stay readable, Undo and Restore bring them back", async () => {
    const { chat, updates, old } = seed();
    const { page, errors } = await load(desktop, { chat, thread: updates });
    try {
      await page.getByRole("button", { name: "More actions", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Rename thread/ }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name").fill("News");
      await dialog.getByRole("button", { name: "Rename", exact: true }).click();
      await page.locator(".k2b-toast", { hasText: "Renamed to “News”" }).waitFor();
      await page.getByRole("feed").getByText(`${viewer.name} renamed “Updates” to “News”`, { exact: true }).waitFor();

      await page.getByRole("button", { name: "More actions", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Archive thread/ }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Archive", exact: true }).click();
      await page.waitForURL(`**/t/general`);
      const toast = page.locator(".k2b-toast", { hasText: "“News” archived" });
      await toast.waitFor();
      expect(harness.thread(chat, updates)?.archived).toBe(true);
      await toast.getByRole("button", { name: "Undo", exact: true }).click();
      await page.waitForURL(`**/t/${updates}`);
      await until(() => harness.thread(chat, updates)?.archived === false);

      // An archived thread opens from the picker, reads normally, and admins restore it in place of the composer.
      await page.locator(".chat-thread-picker").click();
      await page.getByRole("menuitem", { name: "Old network" }).click();
      await page.waitForURL(`**/t/${old}`);
      const notice = page.locator(".chat-conversation__notice", { hasText: "Archived. The history stays readable." });
      await notice.waitFor();
      expect(await page.locator(".chat-conversation textarea:not([aria-hidden])").count()).toBe(0);
      await notice.getByRole("button", { name: "Restore", exact: true }).click();
      await page.locator(".k2b-toast", { hasText: "Restored" }).waitFor();
      await page.getByRole("textbox", { name: "Message to Old network" }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 45_000);

  test("readers see a quiet notice instead of the composer, no reply, and no thread management", async () => {
    const { chat, problems } = seed();
    harness.setPermission(chat, "read");
    const { page, errors } = await load(desktop, { chat, thread: problems });
    try {
      await page.locator(".chat-conversation__notice", { hasText: "You can only read in IT." }).waitFor();
      expect(await sidebar(page).getByText("New thread", { exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "More actions", exact: true }).count()).toBe(0);
      const message = page.locator(".k2b-message-row:not([data-own])").last();
      await message.locator(".k2b-message-row__bubble").hover();
      await message.getByRole("button", { name: "Message actions", exact: true }).click();
      expect(await page.getByRole("menuitem", { name: /^Reply/ }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("Mark unread from here in a thread keeps that thread bold with its count while it is open", async () => {
    const { chat, problems } = seed();
    const { page, errors } = await load(desktop, { chat, thread: problems });
    try {
      await until(() => harness.subscribed(chat));
      await until(() => harness.thread(chat, problems)?.read?.unreadFromSeq === null && harness.readViews.length > 0);
      const message = page.locator(".k2b-message-row:not([data-own])", { hasText: "Problems: update 2" });
      await message.locator(".k2b-message-row__bubble").hover();
      await message.getByRole("button", { name: "Message actions", exact: true }).click();
      const entry = page.getByRole("menuitem", { name: /^Mark unread from here/ });
      expect(await entry.innerText()).toContain("“Problems” counts as unread again.");
      await entry.click();
      await threadRow(page, problems).locator('[data-unread="count"]').waitFor();
      expect(harness.thread(chat, problems)?.read?.unreadFromSeq).not.toBeNull();
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});

describe("Chat threads on a phone", () => {
  test("a chat with threads opens its thread page; a thread opens as its own page; back returns to the threads", async () => {
    const { chat, problems } = seed();
    const { page, errors } = await load(phone, {});
    try {
      await page.locator(`.chat-list-page a[href="/app/chat/c/${chat}"]`).click();
      await page.waitForURL(`**/c/${chat}/threads`);
      const threads = page.locator(".chat-threads-page");
      await threads.getByText("Problems", { exact: true }).waitFor();
      await threads.getByText("Old network", { exact: true }).waitFor({ state: "detached" });
      await threads.getByText("Archived · 1", { exact: true }).click();
      await threads.getByText("Old network", { exact: true }).waitFor();
      await threads.getByText("Problems", { exact: true }).click();
      await page.waitForURL(`**/t/${problems}`);
      await page.locator(".chat-conversation__thread-name", { hasText: "Problems" }).waitFor();
      await page.getByRole("link", { name: "Back to the threads", exact: true }).click();
      await page.waitForURL(`**/c/${chat}/threads`);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a long press offers Reply, and the reply goes to the message's thread", async () => {
    const { chat, problems } = seed();
    const { page, errors } = await load(phone, { chat, thread: problems });
    try {
      const original = page.locator(".k2b-message-row:not([data-own])", { hasText: "Problems: update 3" });
      await original.waitFor();
      await longPress(page, original.locator(".k2b-message-row__text"));
      const sheet = page.locator("dialog[open]");
      await sheet.getByRole("menuitem", { name: /^Reply/ }).click();
      await page.locator(".k2b-chat-composer__reply", { hasText: "Problems: update 3" }).waitFor();
      await page.getByRole("textbox", { name: "Message to Problems" }).fill("Seen");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await until(() => harness.posted.some((post) => post.body === "Seen"));
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
