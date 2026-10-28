import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Browser, BrowserContextOptions, Locator, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
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
  const deadline = performance.now() + 5_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("Condition not met in time");
    await Bun.sleep(20);
  }
};
/** The page for an address, rendered from the harness's SSR props like the server does. */
const load = async (options: BrowserContextOptions, address: { chat?: string; thread?: string; threadsPage?: boolean }) => {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const errors = pageErrors(page);
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
  await settled(page);
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
      // The send names its thread from its first frame, so the chip adds no line when the server confirms it.
      // settled: every frame of the send is the subject, also the unsettled ones.
      await page.evaluate(() => {
        const seen: { chip: boolean; height: number }[] = [];
        (window as unknown as { ownRow: typeof seen }).ownRow = seen;
        new MutationObserver(() => {
          const row = [...document.querySelectorAll(".k2b-message-row[data-own]")]
            .filter((element) => element.querySelector(".k2b-message-row__text")?.textContent?.trim() === "For everyone")
            .at(-1);
          if (row) seen.push({ chip: row.querySelector(".k2b-message-row__origin") !== null, height: row.getBoundingClientRect().height });
        }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      });
      await page.keyboard.press("Enter");
      await until(() => harness.posted.some((post) => post.body === "For everyone"));
      // The stored row may show beside the send for a moment (#1753); the last one is the send.
      await page
        .locator(".k2b-message-row[data-own]", { has: page.getByText("For everyone", { exact: true }) })
        .last()
        .locator(".k2b-message-row__origin", { hasText: "General" })
        .waitFor();
      const frames = await page.evaluate(() => (window as unknown as { ownRow: { chip: boolean; height: number }[] }).ownRow);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.every((frame) => frame.chip)).toBe(true);
      expect(new Set(frames.map((frame) => frame.height)).size).toBe(1);
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

  test("in a chat without threads, admins create the first one from the chat's info", async () => {
    const chat = harness.addChat({
      members: [viewer, nora, tobias],
      name: "Lab",
      count: 4,
      end: new Date(chatTestNow.getTime() - 3_600_000),
    });
    const { page, errors } = await load(desktop, { chat });
    try {
      // Without threads, the chat looks as before: no thread rows and no picker.
      await page.getByRole("feed").getByText("Yes, at 7. Two boxes are damaged.", { exact: true }).waitFor();
      expect(await page.locator(".chat-thread-picker").count()).toBe(0);
      expect(await threadRow(page, "general").count()).toBe(0);
      await page.getByRole("link", { name: "Chat info", exact: true }).click();
      await page.locator("#k2b-workspace-detail-chat-info").getByRole("button", { name: "Actions for Lab", exact: true }).click();
      await page.getByRole("menuitem", { name: /^New thread/ }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name").fill("Samples");
      await dialog.getByRole("button", { name: "Create", exact: true }).click();
      await page.waitForURL(/\/t\/[^/?]+(\?panel=info)?$/);
      await page.locator(".chat-thread-picker", { hasText: "Samples" }).waitFor();
      await threadRow(page, "general").waitFor();
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("switching from a chat without threads to one with threads keeps the conversation on screen", async () => {
    const { chat } = seed();
    const plain = harness.addChat({ members: [viewer, nora], count: 3, end: new Date(chatTestNow.getTime() - 7_200_000) });
    for (const width of [1440, 2000]) {
      const { page, errors } = await load({ viewport: { width, height: 900 } }, { chat: plain });
      try {
        await page.getByRole("feed").getByText("Yes, at 7. Two boxes are damaged.", { exact: true }).waitFor();
        await sidebar(page).locator(`a[href="/app/chat/c/${chat}"]`).first().click();
        await page.waitForURL(`**/c/${chat}`);
        await page.getByRole("feed").getByText("Problems: update 1", { exact: true }).waitFor();
        await page.getByRole("textbox", { name: "Message to General" }).waitFor();
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }
  }, 45_000);

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
      await page.getByRole("dialog").getByRole("button", { name: "Archive thread", exact: true }).click();
      await page.waitForURL(`**/t/general`);
      const toast = page.locator(".k2b-toast", { hasText: "“News” archived" });
      await toast.waitFor();
      expect(harness.thread(chat, updates)?.archived).toBe(true);
      await toast.getByRole("button", { name: "Undo", exact: true }).click();
      // The action closes its message, which then covers nothing.
      await toast.waitFor({ state: "detached" });
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

describe("Chat threads in four columns", () => {
  test("from a 1800 px window the threads move into their own column; the reading column keeps 760 px at the limit", async () => {
    const { chat, problems, updates } = seed();
    for (const width of [1800, 1799]) {
      const wide = width >= 1800;
      const { page, errors } = await load({ viewport: { width, height: 1000 } }, { chat, thread: problems });
      try {
        const column = page.locator(".chat-thread-column");
        expect(await column.isVisible()).toBe(wide);
        expect(await page.locator(".chat-list__threads").isVisible()).toBe(!wide);
        expect(await page.locator(".chat-thread-picker").isVisible()).toBe(!wide);
        // The head names the thread and its description in place of the chat's title and the picker.
        expect(await page.locator(".chat-conversation__wide-title").isVisible()).toBe(wide);
        if (wide) expect(await page.locator(".chat-conversation__wide-subtitle").innerText()).toBe("Report outages");
        const item = await page.locator(".k2b-virtual-feed__item").first().boundingBox();
        expect(item?.width).toBe(760);
        if (wide) {
          expect(await column.locator('[aria-current="page"]').getAttribute("data-thread")).toBe(problems);
          await column.locator(`[data-thread="${updates}"]`).click();
          await page.waitForURL(`**/t/${updates}`);
          await page.locator(".chat-conversation__wide-name", { hasText: "Updates" }).waitFor();
        }
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }
  }, 45_000);
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
      await threads.getByText("Problems", { exact: true }).waitFor();
      // Back from the thread page leads to the chats.
      await page.getByRole("link", { name: "Back to chats", exact: true }).click();
      await page.locator(".chat-list-page").waitFor();
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a thread opened by its address returns to its chat's thread page, not to the chats", async () => {
    const { chat, problems } = seed();
    const { page, errors } = await load(phone, { chat, thread: problems });
    try {
      await page.getByRole("link", { name: "Back to the threads", exact: true }).click();
      await page.waitForURL(`**/c/${chat}/threads`);
      await page.locator(".chat-threads-page").getByText("Updates", { exact: true }).waitFor();
      expect(await page.locator(".chat-list-page").isVisible()).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a thread created from Info on the thread page goes back to the thread page, not to Info", async () => {
    const { chat } = seed();
    const { page, errors } = await load(phone, { chat, threadsPage: true });
    try {
      await page.locator(".chat-threads-page").getByRole("link", { name: "Chat info", exact: true }).click();
      await page.waitForURL(/panel=info/);
      await page.locator("#k2b-workspace-detail-chat-info").getByRole("button", { name: "Actions for IT", exact: true }).click();
      await page.getByRole("menuitem", { name: /^New thread/ }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name").fill("Printers");
      await dialog.getByRole("button", { name: "Create", exact: true }).click();
      await page.waitForURL(/\/t\/[^/?]+$/);
      await page.getByRole("link", { name: "Back to the threads", exact: true }).click();
      await page.waitForURL(`**/c/${chat}/threads`);
      await page.locator(".chat-threads-page").getByText("Printers", { exact: true }).waitFor();
      expect(new URL(page.url()).searchParams.get("panel")).toBeNull();
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

for (const system of [false, true])
  for (const selected of ["all", "thread"] as const)
    test(`unread-gap recovery retains ${system ? "system" : "ordinary"} ${selected} selection in the panel`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], name: "Gap recovery", count: 3, end: chatTestNow });
      const thread = harness.addThread(chat, { name: "Selected", count: 5, end: chatTestNow });
      const other = harness.addThread(chat, { name: "Other", count: 2, end: chatTestNow });
      if (system) harness.setSystem(chat, { type: "spaces.space", id: "Space1" });
      else harness.archive(chat, true);
      const context = await browser.newContext({ ...desktop, reducedMotion: "reduce" });
      const page = await context.newPage();
      page.setDefaultTimeout(5_000);
      const errors = pageErrors(page);
      const view = selected === "all" ? "all" : thread;
      const path = `/app/chat/panel/c/${chat}${view === "all" ? "" : `/t/${view}`}`;
      const suffix = system ? "?listFilter=unread&filter=done" : "?list=archive&filter=unread";
      try {
        await page.goto(new URL(path + suffix, harness.url).href);
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate((props) => window.mountChat(props, "en"), {
          ...harness.props({ chat, thread: view, archived: !system, filter: "unread" }),
          embedded: true,
        });
        await until(() => harness.subscribed(chat));
        // Establish a visible range before hidden-tab replay.
        const feed = page.locator(".k2b-virtual-feed__viewport");
        await feed.waitFor();
        await settled(page);
        const boundary = harness.thread(chat, thread)!.read!.lastReadSeq!;
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
          document.hasFocus = () => false;
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await until(() => !harness.subscribed(chat));
        let last = "";
        for (let index = 0; index < 60; index++) {
          harness.receiveIn(chat, nora, `Gap arrival ${index}`, { thread });
          last = harness.messageId(chat, harness.props({ chat }).open!.page.seqHead);
          if (index % 3 === 0) harness.receiveIn(chat, nora, `Other arrival ${index}`, { thread: other });
        }
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
          document.hasFocus = () => true;
          document.dispatchEvent(new Event("visibilitychange"));
          window.dispatchEvent(new Event("focus"));
        });
        await page.locator(`[data-key="${last}"] .k2b-message-row__text`).waitFor({ state: "attached" });
        const jump = page.getByRole("button", { name: "New messages", exact: true });
        await jump.waitFor();
        expect(harness.thread(chat, thread)!.read!.lastReadSeq).toBe(boundary);
        // Replace the loaded prefix with the newest page, so recovery must request this view's snapshot.
        await page.route(
          `**/api/chat/conversations/${chat}/changes?*`,
          (route) => route.fulfill({ status: 409, json: { code: "RESYNC_REQUIRED", message: "Expired" } }),
          { times: 1 },
        );
        await page.route(`**/api/chat/conversations/${chat}/messages?before=*`, (route) =>
          route.fulfill({ status: 503, json: { message: "Unavailable" } }),
        );
        const previousHeight = await feed.evaluate((element) => element.scrollHeight);
        const replacement = page.waitForResponse(
          (response) => response.url().includes(`/conversations/${chat}/messages`) && response.request().method() === "GET",
        );
        harness.resync(chat);
        await replacement;
        await page.waitForFunction(
          (height) => document.querySelector(".k2b-virtual-feed__viewport")!.scrollHeight < height,
          previousHeight,
        );
        await settled(page);
        await jump.waitFor();
        const recovered = page.waitForResponse((response) => response.url().includes(`/conversations/${chat}/snapshot`) && response.ok());
        await jump.click();
        await recovered;
        await page.locator(`[data-key="${harness.messageId(chat, 11)}"] .k2b-message-row__text`).waitFor();
        await jump.waitFor({ state: "hidden" });
        expect(new URL(page.url()).pathname).toBe(path);
        if (system) {
          expect(new URL(page.url()).searchParams.get("listFilter")).toBe("unread");
          expect(new URL(page.url()).searchParams.get("filter")).toBe("done");
        }
        if (!system) {
          expect(new URL(page.url()).searchParams.get("list")).toBe("archive");
          expect(new URL(page.url()).searchParams.get("filter")).toBe("unread");
        }
        const full = page.getByRole("link", { name: "Open full view", exact: true });
        expect(new URL((await full.getAttribute("href"))!, page.url()).pathname).toBe(path.replace("/panel", ""));
        if (selected === "thread") expect(harness.thread(chat, other)!.read!.lastReadSeq).toBe(10);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 30_000);
