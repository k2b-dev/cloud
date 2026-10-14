import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { nora, startChatHarness, tobias, viewer } from "./ChatWorkspace.browser-fixture";

declare global {
  interface Window {
    chatShifts: number;
    chatShiftObserver: PerformanceObserver | undefined;
    chatNavigationMarker: string;
    chatSeen: number;
    chatSeenFrame: number;
  }
}
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
const viewports: { name: string; options: BrowserContextOptions }[] = [
  { name: "desktop", options: { viewport: { width: 1440, height: 900 } } },
  { name: "phone", options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];
const observeShifts = (page: Page) =>
  page.evaluate(() => {
    window.chatShifts = 0;
    window.chatShiftObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if ("hadRecentInput" in entry && !entry.hadRecentInput && "value" in entry && typeof entry.value === "number")
          window.chatShifts += entry.value;
      }
    });
    // WebKit has no Layout Instability API. The geometry assertions still run in both engines.
    if (PerformanceObserver.supportedEntryTypes.includes("layout-shift")) window.chatShiftObserver.observe({ type: "layout-shift" });
  });
const settle = (page: Page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
const load = async (
  options: BrowserContextOptions,
  address: { chat?: string; message?: string },
  observe = false,
  prepare?: (page: Page) => Promise<void>,
) => {
  const context = await browser.newContext(options);
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const path = address.chat ? `/app/chat/c/${address.chat}${address.message ? `/m/${address.message}` : ""}` : "/app/chat";
    await page.goto(new URL(path, harness.url).href);
    await settle(page);
    if (observe) await observeShifts(page);
    await prepare?.(page);
    await page.evaluate((props) => window.mountChat(props, "en"), harness.props(address, new Date()));
    await settle(page);
    return { page, errors };
  } catch (error) {
    await context.close();
    throw error;
  }
};
const inFeed = async (page: Page, selector: string) => {
  const bounds = await page.locator(selector).evaluate((row) => {
    const viewport = row.closest(".k2b-virtual-feed__viewport")!;
    const box = row.getBoundingClientRect();
    const feed = viewport.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, feedTop: feed.top, feedBottom: feed.bottom };
  });
  expect(bounds.top).toBeGreaterThanOrEqual(bounds.feedTop);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.feedBottom + 1);
};

describe("ChatWorkspace browser full view", () => {
  for (const { name, options } of viewports) {
    test(`live arrivals keep layout stable and follow the newest message on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], count: 40, end: new Date() });
      const other = harness.addChat({ members: [viewer, tobias], count: 4, end: new Date(Date.now() - 60_000) });
      const { page, errors } = await load(options, { chat });
      try {
        await page.waitForFunction(() => document.querySelector(".k2b-virtual-feed__viewport")!.scrollTop > 0);
        // Wait for the live subscriptions rather than depending on a socket-opening delay.
        await page.waitForFunction(() => document.querySelector(".chat-conversation") !== null);
        await Bun.sleep(100);
        const sidebar = page.locator(".k2b-app-workspace__sidebar a[href]");
        const order = await sidebar.evaluateAll((rows) => rows.map((row) => row.getAttribute("href")));
        await observeShifts(page);
        for (let i = 1; i <= 5; i++) harness.receive(chat, nora, `Live arrival ${i}`);
        harness.receive(other, tobias, "Changed elsewhere");
        await page.locator(".chat-conversation").getByText("Live arrival 5", { exact: true }).waitFor();
        await settle(page);
        await inFeed(page, `.k2b-virtual-feed__item[data-key="${harness.messageId(chat, 45)}"]`);
        expect(await page.evaluate(() => window.chatShifts)).toBe(0);
        if (name === "desktop") expect(await sidebar.evaluateAll((rows) => rows.map((row) => row.getAttribute("href")))).toEqual(order);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
    test(`index and conversation use the ${name} layout`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], name: `Layout ${name}`, count: 4, end: new Date() });
      const { page, errors } = await load(options, {});
      try {
        if (name === "phone") {
          expect(await page.locator(`.chat-list-page a[href="/app/chat/c/${chat}"]`).isVisible()).toBe(true);
          expect(await page.getByText("Choose a chat", { exact: true }).isVisible()).toBe(false);
          await page.locator(`.chat-list-page a[href="/app/chat/c/${chat}"]`).click();
          await page.waitForURL(`**/app/chat/c/${chat}`);
          const frame = await page.locator(".chat-conversation").boundingBox();
          expect(frame).toEqual({ x: 0, y: 0, width: 390, height: 844 });
          const composer = await page.locator(".chat-conversation__composer").boundingBox();
          expect(composer).not.toBeNull();
          expect(composer!.y).toBeGreaterThanOrEqual(0);
          expect(composer!.y + composer!.height).toBeLessThanOrEqual(844);
          // The back button returns to the list in place, through the entry the list left in the history.
          await page.evaluate(() => {
            window.chatNavigationMarker = "survives";
          });
          await page.getByRole("link", { name: "Back to chats", exact: true }).click();
          await page.waitForURL("**/app/chat");
          await page.locator(`.chat-list-page a[href="/app/chat/c/${chat}"]`).waitFor();
          expect(await page.locator(".chat-conversation").count()).toBe(0);
          expect(await page.evaluate(() => window.chatNavigationMarker)).toBe("survives");
        } else {
          expect(await page.locator(".k2b-app-workspace__sidebar").isVisible()).toBe(true);
          expect(await page.getByText("Choose a chat", { exact: true }).isVisible()).toBe(true);
          expect(await page.locator(".chat-list-page").isVisible()).toBe(false);
        }
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
    test(`a middle deep link is visible and highlighted without a shift on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], count: 120, end: new Date() });
      const message = harness.messageId(chat, 60);
      const { page, errors } = await load(options, { chat, message }, true);
      try {
        const selector = `[data-key="${message}"]`;
        await page.locator(`${selector}[data-highlighted]`).waitFor();
        await inFeed(page, selector);
        expect(await page.evaluate(() => window.chatShifts)).toBe(0);
        await page.locator(`${selector}[data-highlighted]`).waitFor({ state: "detached" });
        await settle(page);
        expect(await page.evaluate(() => window.chatShifts)).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
    test(`failed send retries one message with the same client ID on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], count: 4, end: new Date() });
      const { page, errors } = await load(options, { chat });
      try {
        const start = harness.posted.length;
        harness.failSends();
        await page.getByRole("textbox").fill(`Retry on ${name}`);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page.locator('[data-status="failed"]').getByText("Not sent", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        const row = page.locator('.k2b-message-row[data-status="sent"]', { hasText: `Retry on ${name}` });
        await row.waitFor();
        await settle(page);
        expect(harness.posted.slice(start)).toEqual([
          { chat, clientId: harness.posted[start]!.clientId, body: `Retry on ${name}` },
          { chat, clientId: harness.posted[start]!.clientId, body: `Retry on ${name}` },
        ]);
        expect(await page.locator(".k2b-message-row", { hasText: `Retry on ${name}` }).count()).toBe(1);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
    test(`a later send waits behind a failed one until it is discarded on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], count: 4, end: new Date() });
      const { page, errors } = await load(options, { chat });
      try {
        const start = harness.posted.length;
        harness.failSends();
        const send = async (text: string) => {
          await page.getByRole("textbox").fill(text);
          await page.getByRole("button", { name: "Send message", exact: true }).click();
        };
        await send(`Refused on ${name}`);
        const failed = page.locator('.k2b-message-row[data-status="failed"]', { hasText: `Refused on ${name}` });
        await failed.waitFor();
        await send(`Waiting on ${name}`);
        await page.locator('.k2b-message-row[data-status="pending"]', { hasText: `Waiting on ${name}` }).waitFor();
        await page.getByText("Later messages wait for the one that was not sent.", { exact: true }).waitFor();
        expect(harness.posted.slice(start).map((input) => input.body)).toEqual([`Refused on ${name}`]);
        // A phone shows the row's actions on the first tap, a mouse while it rests on the row.
        if (options.hasTouch) await failed.locator(".k2b-message-row__bubble").tap();
        else await failed.hover();
        await failed.getByRole("button", { name: "Discard message", exact: true }).click();
        await page.locator('.k2b-message-row[data-status="sent"]', { hasText: `Waiting on ${name}` }).waitFor();
        await failed.waitFor({ state: "detached" });
        expect(harness.posted.slice(start).map((input) => input.body)).toEqual([`Refused on ${name}`, `Waiting on ${name}`]);
        expect(await page.getByText("Later messages wait for the one that was not sent.", { exact: true }).count()).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }
  test("going back to a deep link in the same chat shows and highlights its message again", async () => {
    const chat = harness.addChat({ members: [viewer, nora], count: 120, end: new Date() });
    const message = harness.messageId(chat, 60);
    const { page, errors } = await load(viewports[0]!.options, { chat, message });
    try {
      const selector = `[data-key="${message}"]`;
      await page.locator(`${selector}[data-highlighted]`).waitFor();
      await page.locator(`${selector}[data-highlighted]`).waitFor({ state: "detached" });
      await page.locator(`.k2b-app-workspace__sidebar a[href="/app/chat/c/${chat}"]`).click();
      await page.waitForURL(`**/app/chat/c/${chat}`);
      await page.locator(selector).waitFor({ state: "detached" });
      await page.goBack();
      await page.waitForURL(`**/app/chat/c/${chat}/m/${message}`);
      await page.locator(`${selector}[data-highlighted]`).waitFor();
      await inFeed(page, selector);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
  test("a live rename and lost access update the page trail and document title", async () => {
    const chat = harness.addChat({ members: [viewer, nora], name: "Before rename", count: 4, end: new Date() });
    const { page, errors } = await load(viewports[0]!.options, { chat });
    try {
      // Wait for the live subscriptions before the server announces the change.
      await Bun.sleep(100);
      harness.rename(chat, "After rename");
      await page.waitForFunction(() => document.title === "After rename");
      await page.locator(".chat-conversation__header", { hasText: "After rename" }).waitFor();
      harness.revoke(chat);
      await page.waitForFunction(() => document.title === "No access");
      await page.locator(".k2b-app-workspace__main", { hasText: "No access" }).waitFor();
      expect(await page.locator(".k2b-app-workspace__main").innerText()).not.toContain("After rename");
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
  test("sidebar navigation and browser Back change the chat without reloading", async () => {
    const first = harness.addChat({ members: [viewer, nora], name: "First chat", count: 4, end: new Date() });
    const second = harness.addChat({ members: [viewer, tobias], name: "Second chat", count: 4, end: new Date() });
    const { page, errors } = await load(viewports[0]!.options, { chat: first });
    try {
      await page.evaluate(() => {
        window.chatNavigationMarker = "survives";
      });
      await page.locator(`.k2b-app-workspace__sidebar a[href="/app/chat/c/${second}"]`).click();
      await page.waitForURL(`**/app/chat/c/${second}`);
      expect(await page.locator(".chat-conversation__header").innerText()).toContain("Second chat");
      expect(await page.evaluate(() => window.chatNavigationMarker)).toBe("survives");
      await page.goBack();
      await page.waitForFunction(() => document.querySelector(".chat-conversation__header")?.textContent?.includes("First chat"));
      expect(new URL(page.url()).pathname).toBe(`/app/chat/c/${first}`);
      expect(await page.evaluate(() => window.chatNavigationMarker)).toBe("survives");
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});

// Bun's expect has no polling matcher; poll server-side observations while the browser runs.
const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
  expect(condition()).toBe(true);
};
const rows = (page: Page, name: string) => page.locator(name === "phone" ? ".chat-list-page" : ".k2b-app-workspace__sidebar");
const row = (page: Page, name: string, chat: string) => rows(page, name).locator(`a[href="/app/chat/c/${chat}"]`);
const chatReads = (chat: string) => harness.reads.filter((read) => read.chat === chat);
const marker = (page: Page) => page.locator(".k2b-virtual-feed__marker");
const scrollFeed = async (page: Page, direction: number) => {
  const feed = page.locator(".k2b-virtual-feed__viewport");
  // A real input cancels VirtualFeed's protection against residual momentum after a jump.
  await feed.dispatchEvent("wheel", { deltaY: direction });
  await feed.evaluate((element, delta) => {
    element.scrollTop += (delta * element.clientHeight) / 2;
  }, direction);
  await settle(page);
};
const rowAction = async (page: Page, name: string, chat: string, action: "Mark unread" | "Mark read") => {
  const link = row(page, name, chat);
  await link.hover();
  await link
    .locator("..")
    .getByRole("button", { name: /^Actions for / })
    .click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
};
const readAllAction = async (page: Page, name: string) => {
  await rows(page, name).locator(".k2b-app-workspace__sidebar-section-header").hover();
  await rows(page, name).getByRole("button", { name: "Actions for all chats", exact: true }).click();
  await page.getByRole("menuitem", { name: "Mark all read", exact: true }).click();
};
const noReportsForBatch = async (page: Page, chat: string, before: number) => {
  // A pending report gets a full batching interval to run; negative assertions need this window.
  await page.waitForTimeout(1_050);
  expect(chatReads(chat)).toHaveLength(before);
};

describe("ChatWorkspace browser read state", () => {
  beforeEach(() => harness.reset());
  test("Escape in the sidebar neither reports a read nor announces", async () => {
    const chat = harness.addChat({ members: [viewer, nora], count: 150, unread: 98, end: new Date() });
    const { page, errors } = await load(viewports[0]!.options, { chat, message: harness.messageId(chat, 120) });
    try {
      await until(() => harness.subscribed(chat));
      await row(page, "desktop", chat).focus();
      await page.keyboard.press("Escape");
      await noReportsForBatch(page, chat, 0);
      expect(await page.locator("[data-k2b-live]").getByText("Chat marked read", { exact: true }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
  for (const { name, options } of viewports) {
    test(`unread counts, accessible names, cap and open row on ${name}`, async () => {
      const three = harness.addChat({ members: [viewer, nora], name: "Three unread", count: 8, unread: 3, end: new Date() });
      const capped = harness.addChat({ members: [viewer, tobias], name: "Many unread", count: 181, unread: 120, end: new Date() });
      const read = harness.addChat({ members: [viewer, nora], name: "Already read", count: 8, end: new Date() });
      const { page, errors } = await load(options, {});
      try {
        expect(await row(page, name, three).locator('[data-unread="count"] [aria-hidden="true"]').innerText()).toBe("3");
        expect(
          await rows(page, name)
            .getByRole("link", { name: /Three unread.*3 unread/ })
            .count(),
        ).toBe(1);
        expect(await row(page, name, capped).locator('[data-unread="count"] [aria-hidden="true"]').innerText()).toBe("99+");
        expect(
          await rows(page, name)
            .getByRole("link", { name: /Many unread.*99.*unread/ })
            .count(),
        ).toBe(1);
        expect(await row(page, name, read).locator("[data-unread]").count()).toBe(0);
        await row(page, name, three).click();
        await page.waitForURL(`**/c/${three}`);
        if (name === "desktop") expect(await row(page, name, three).locator("[data-unread]").count()).toBe(0);
        else expect(await page.locator(`a[href="/app/chat/c/${three}"] [data-unread]`).count()).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`opening unread history reports only contiguous visible messages and batches on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], count: 48, unread: 25, end: new Date() });
      const start = harness.props({ chat }, new Date()).open!.conversation.read!.lastReadSeq!;
      const requests: { seq: number; at: number }[] = [];
      const { page, errors } = await load(options, { chat }, false, async (page) => {
        page.on("request", (request) => {
          if (request.url().endsWith(`/conversations/${chat}/read`)) requests.push({ seq: request.postDataJSON().seq, at: Date.now() });
        });
        await page.evaluate((start) => {
          window.chatSeen = start;
          const sample = () => {
            const viewport = document.querySelector(".k2b-virtual-feed__viewport");
            if (viewport) {
              const bounds = viewport.getBoundingClientRect();
              const visible = [...viewport.querySelectorAll<HTMLElement>("[data-key]")]
                .filter((item) => {
                  const box = item.getBoundingClientRect();
                  return box.top >= bounds.top && box.bottom <= bounds.bottom;
                })
                .map((item) => Number(item.dataset.key!.slice(-4)));
              if (visible.length && Math.min(...visible) <= window.chatSeen + 1) window.chatSeen = Math.max(window.chatSeen, ...visible);
            }
            window.chatSeenFrame = requestAnimationFrame(sample);
          };
          sample();
        }, start);
      });
      try {
        await marker(page).waitFor();
        const key = await marker(page).evaluate((element) => element.closest("[data-key]")!.getAttribute("data-key"));
        expect(key).toBe(harness.messageId(chat, start + 1));
        await inFeed(page, ".k2b-virtual-feed__marker");
        const offset = await marker(page).evaluate(
          (element) => element.getBoundingClientRect().top - element.closest(".k2b-virtual-feed__viewport")!.getBoundingClientRect().top,
        );
        expect(offset).toBeLessThan(80);
        await until(() => chatReads(chat).length > 0);
        expect(chatReads(chat).at(-1)!.seq).toBeLessThan(48);
        for (let step = 0; step < 12; step++) {
          const seen = await page.evaluate(() => window.chatSeen);
          expect(chatReads(chat).every((read) => read.seq <= seen)).toBe(true);
          await scrollFeed(page, 1);
        }
        await until(() => chatReads(chat).at(-1)?.seq === 48);
        expect(chatReads(chat).map((read) => read.seq)).toEqual(
          [...new Set(chatReads(chat).map((read) => read.seq))].sort((a, b) => a - b),
        );
        expect(requests.length).toBeLessThanOrEqual(1 + Math.floor((requests.at(-1)!.at - requests[0]!.at + 50) / 1_000));
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`marker stays on its opening message during arrivals and header jump preserves height on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], count: 48, unread: 25, end: new Date() });
      const { page, errors } = await load(options, { chat });
      try {
        await marker(page).waitFor();
        await until(() => harness.subscribed(chat));
        const original = await marker(page).evaluate((element) => ({
          key: element.closest("[data-key]")!.getAttribute("data-key"),
          text: element.closest("[data-key]")!.textContent,
          top: element.getBoundingClientRect().top,
        }));
        for (let i = 1; i <= 3; i++) harness.receive(chat, nora, `Unread live ${i}`);
        await page.getByRole("button", { name: "Jump to latest, 3 new", exact: true }).waitFor();
        await settle(page);
        const after = await marker(page).evaluate((element) => ({
          key: element.closest("[data-key]")!.getAttribute("data-key"),
          text: element.closest("[data-key]")!.textContent,
          top: element.getBoundingClientRect().top,
        }));
        expect(after).toEqual(original);
        const header = await page.locator(".chat-conversation__header").boundingBox();
        for (let i = 0; i < 3; i++) await scrollFeed(page, 1);
        const jump = page.getByRole("button", { name: "New messages", exact: true });
        await jump.waitFor();
        expect((await page.locator(".chat-conversation__header").boundingBox())!.height).toBe(header!.height);
        await jump.click();
        await inFeed(page, ".k2b-virtual-feed__marker");
        expect(await marker(page).evaluate((element) => element.closest("[data-key]")!.getAttribute("data-key"))).toBe(original.key);
        expect((await page.locator(".chat-conversation__header").boundingBox())!.height).toBe(header!.height);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    for (const inactive of ["hidden", "unfocused"] as const) {
      test(`${inactive} tab reports nothing until visible and focused on ${name}`, async () => {
        const chat = harness.addChat({ members: [viewer, nora], count: 8, end: new Date() });
        const { page, errors } = await load(options, { chat }, false, async (page) => {
          await page.evaluate((inactive) => {
            Object.defineProperty(document, "visibilityState", { configurable: true, value: inactive === "hidden" ? "hidden" : "visible" });
            document.hasFocus = () => inactive !== "unfocused";
            document.dispatchEvent(new Event("visibilitychange"));
          }, inactive);
        });
        try {
          if (inactive === "unfocused") await until(() => harness.subscribed(chat));
          for (let i = 1; i <= 3; i++) harness.receive(chat, nora, `Inactive arrival ${i}`);
          if (inactive === "unfocused") {
            await page.getByRole("feed").getByText("Inactive arrival 3", { exact: true }).waitFor();
            await inFeed(page, `[data-key="${harness.messageId(chat, 11)}"]`);
          }
          await noReportsForBatch(page, chat, 0);
          await page.evaluate(() => {
            Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
            document.hasFocus = () => true;
            document.dispatchEvent(new Event("visibilitychange"));
            window.dispatchEvent(new Event("focus"));
          });
          // A hidden tab's live connection may deliver what it held back in more than one batch; each read is still
          // contiguous and batched, and the last one reaches the newest message.
          await until(() => chatReads(chat).at(-1)?.seq === 11);
          const seqs = chatReads(chat).map((read) => read.seq);
          expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b));
          expect(seqs.length).toBeLessThanOrEqual(2);
          await noReportsForBatch(page, chat, seqs.length);
          expect(errors).toEqual([]);
        } finally {
          await page.context().close();
        }
      }, 30_000);
    }

    test(`deep link beyond the read frontier waits for the gap on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], count: 150, unread: 98, end: new Date() });
      const message = harness.messageId(chat, 120);
      const { page, errors } = await load(options, { chat, message });
      try {
        await page.locator(`[data-key="${message}"][data-highlighted]`).waitFor();
        await inFeed(page, `[data-key="${message}"]`);
        await noReportsForBatch(page, chat, 0);
        expect(await marker(page).count()).toBe(0);
        expect(await page.getByRole("button", { name: "New messages", exact: true }).count()).toBe(0);
        // Read back through the gap in overlapping half-screen steps, including paged older history.
        for (let i = 0; i < 45 && chatReads(chat).length === 0; i++) await scrollFeed(page, -1);
        await until(() => chatReads(chat).length > 0);
        expect(chatReads(chat)[0]!.seq).toBeLessThan(120);
        for (let i = 0; i < 45 && (chatReads(chat).at(-1)?.seq ?? 0) < 120; i++) await scrollFeed(page, 1);
        await until(() => (chatReads(chat).at(-1)?.seq ?? 0) >= 120);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`a system message before the marker does not block reading to the head on ${name}`, async () => {
      // Enough read history that the marker opens out of view, so the chat jumps to it and the system message right
      // after the read position (41) stays above the view.
      const chat = harness.addChat({ members: [viewer, nora], count: 40, end: new Date() });
      harness.rename(chat, "System before unread");
      for (let i = 0; i < 48; i++) harness.receive(chat, nora, `Incoming message ${i}`);
      const { page, errors } = await load(options, { chat });
      try {
        await marker(page).waitFor();
        expect(await marker(page).evaluate((element) => element.closest("[data-key]")!.getAttribute("data-key"))).toBe(
          harness.messageId(chat, 42),
        );
        await inFeed(page, ".k2b-virtual-feed__marker");
        expect(
          await page.locator(`[data-key="${harness.messageId(chat, 41)}"]`).evaluate((element) => {
            const viewport = element.closest(".k2b-virtual-feed__viewport")!.getBoundingClientRect();
            return element.getBoundingClientRect().bottom <= viewport.top + 1;
          }),
        ).toBe(true);
        await until(() => chatReads(chat).length > 0);
        expect(chatReads(chat).at(-1)!.seq).toBeLessThan(89);
        for (let step = 0; step < 40 && (chatReads(chat).at(-1)?.seq ?? 0) < 89; step++) await scrollFeed(page, 1);
        await until(() => chatReads(chat).at(-1)?.seq === 89);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`mark all read skips confirmation below ten and cancels or batches above it on ${name}`, async () => {
      const small = Array.from({ length: 9 }, (_, i) =>
        harness.addChat({ members: [viewer, nora], name: `Small ${i}`, count: 4, unread: 2, end: new Date() }),
      );
      const { page, errors } = await load(options, {});
      try {
        await until(() => harness.subscribed());
        await readAllAction(page, name);
        await page.waitForFunction(() => document.querySelectorAll("[data-unread]").length === 0);
        expect(await page.getByRole("dialog").count()).toBe(0);
        expect(small.every((chat) => harness.props({ chat }, new Date()).open!.conversation.unread === 0)).toBe(true);
        // More than one server batch also proves that `more` is followed until every count clears.
        await page.context().close();
        harness.reset();
        const many = Array.from({ length: 51 }, (_, i) =>
          harness.addChat({ members: [viewer, nora], name: `Batch ${i}`, count: 4, unread: 2, end: new Date() }),
        );
        const second = await load(options, {});
        try {
          await until(() => harness.subscribed());
          await readAllAction(second.page, name);
          const dialog = second.page.getByRole("dialog");
          await dialog.waitFor();
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
          expect(many.every((chat) => harness.props({ chat }, new Date()).open!.conversation.unread === 2)).toBe(true);
          expect(await rows(second.page, name).locator("[data-unread]").count()).toBe(51);
          await readAllAction(second.page, name);
          await dialog.getByRole("button", { name: "Mark all read", exact: true }).click();
          await second.page.waitForFunction(() => document.querySelectorAll("[data-unread]").length === 0);
          expect(many.every((chat) => harness.props({ chat }, new Date()).open!.conversation.unread === 0)).toBe(true);
          expect(second.errors).toEqual([]);
        } finally {
          await second.page.context().close();
        }
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`exactly ten unread chats require confirmation before any changes on ${name}`, async () => {
      const chats = Array.from({ length: 10 }, (_, i) =>
        harness.addChat({ members: [viewer, nora], name: `Threshold ${i}`, count: 4, unread: 2, end: new Date() }),
      );
      const { page, errors } = await load(options, {});
      try {
        await until(() => harness.subscribed());
        await readAllAction(page, name);
        const dialog = page.getByRole("dialog", { name: "Mark all chats read?", exact: true });
        await dialog.waitFor();
        expect(chats.every((chat) => harness.props({ chat }, new Date()).open!.conversation.unread === 2)).toBe(true);
        await dialog.getByRole("button", { name: "Mark all read", exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll("[data-unread]").length === 0);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`row mark unread and read, message mark unread pauses reporting, Escape reads the head on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], name: "Read actions", count: 8, end: new Date() });
      const dot = harness.addChat({ members: [viewer], name: "No incoming text", count: 4, end: new Date() });
      const { page, errors } = await load(options, {});
      try {
        await until(() => harness.subscribed());
        await rowAction(page, name, dot, "Mark unread");
        await row(page, name, dot).locator('[data-unread="dot"]').waitFor();
        await rowAction(page, name, chat, "Mark unread");
        await row(page, name, chat).locator('[data-unread="count"]').waitFor();
        expect(await row(page, name, chat).locator('[data-unread] [aria-hidden="true"]').innerText()).toBe("1");
        await rowAction(page, name, chat, "Mark read");
        await row(page, name, chat).locator("[data-unread]").waitFor({ state: "detached" });
        await row(page, name, chat).click();
        await page.waitForURL(`**/c/${chat}`);
        const target = harness.messageId(chat, 5);
        const item = page.locator(`[data-key="${target}"]`);
        if (name === "phone") await item.tap();
        else await item.hover();
        await item.getByRole("button", { name: "Mark unread from here", exact: true }).click();
        await marker(page).waitFor();
        expect(await marker(page).evaluate((element) => element.closest("[data-key]")!.getAttribute("data-key"))).toBe(target);
        await until(() => harness.props({ chat }, new Date()).open!.conversation.read!.unreadFromSeq === 5);
        const count = chatReads(chat).length;
        harness.receive(chat, nora, "Stays unread while open");
        await page.getByRole("feed").getByText("Stays unread while open", { exact: true }).waitFor();
        await noReportsForBatch(page, chat, count);
        await page.locator(".k2b-virtual-feed__viewport").click();
        await page.keyboard.press("Escape");
        await until(() => chatReads(chat).length === count + 1);
        expect(chatReads(chat).at(-1)).toEqual({ chat, seq: 9 });
        await marker(page).waitFor({ state: "detached" });
        expect(harness.props({ chat }, new Date()).open!.conversation.unread).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`Escape independently marks the open head read and removes its marker on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], count: 48, unread: 25, end: new Date() });
      const { page, errors } = await load(options, { chat });
      try {
        await marker(page).waitFor();
        await until(() => harness.subscribed(chat));
        await page.keyboard.press("Escape");
        await until(() => chatReads(chat).some((read) => read.seq === 48));
        await marker(page).waitFor({ state: "detached" });
        expect(harness.props({ chat }, new Date()).open!.conversation.unread).toBe(0);
        if (name === "desktop") expect(await row(page, name, chat).locator("[data-unread]").count()).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`visible live arrivals keep the one-second read batching bound on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], count: 8, end: new Date() });
      const requests: number[] = [];
      const { page, errors } = await load(options, { chat }, false, async (page) => {
        page.on("request", (request) => {
          if (request.url().endsWith(`/conversations/${chat}/read`)) requests.push(Date.now());
        });
      });
      try {
        await until(() => harness.subscribed(chat));
        for (let i = 1; i <= 5; i++) {
          harness.receive(chat, nora, `Batch arrival ${i}`);
          await page.getByRole("feed").getByText(`Batch arrival ${i}`, { exact: true }).waitFor();
          await settle(page);
        }
        await until(() => chatReads(chat).at(-1)?.seq === 13);
        expect(requests.length).toBeLessThanOrEqual(1 + Math.floor((requests.at(-1)! - requests[0]! + 50) / 1_000));
        expect(chatReads(chat).map((read) => read.seq)).toEqual(
          [...new Set(chatReads(chat).map((read) => read.seq))].sort((a, b) => a - b),
        );
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`live counts and another-device reads move no sidebar geometry on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], name: "Live count", count: 4, end: new Date() });
      const dot = harness.addChat({ members: [viewer], name: "Dot only", count: 4, end: new Date() });
      harness.addChat({ members: [viewer, tobias], name: "Stable neighbour", count: 4, end: new Date() });
      const { page, errors } = await load(options, {});
      const geometry = () =>
        rows(page, name)
          .locator("a[href]")
          .evaluateAll((links) =>
            links.map((link) => {
              const time = link.querySelector("time")!.getBoundingClientRect();
              return {
                href: link.getAttribute("href"),
                height: link.getBoundingClientRect().height,
                time: { left: time.left, top: time.top, width: time.width },
              };
            }),
          );
      try {
        await until(() => harness.subscribed());
        const before = await geometry();
        await page.evaluate(() => {
          window.chatNavigationMarker = "survives read from another device";
        });
        await observeShifts(page);
        let received = 0;
        for (const count of [1, 2, 10, 100]) {
          while (received < count) harness.receive(chat, nora, `Counter arrival ${++received}`);
          await page.waitForFunction(
            ({ chat, count }) =>
              [...document.querySelectorAll(`a[href="/app/chat/c/${chat}"] [data-unread]`)].some(
                (element) => element.querySelector('[aria-hidden="true"]')?.textContent?.trim() === (count === 100 ? "99+" : String(count)),
              ),
            { chat, count },
          );
          await settle(page);
          expect(await geometry()).toEqual(before);
          expect(await page.evaluate(() => window.chatShifts)).toBe(0);
        }
        harness.readElsewhere(chat, 104);
        await row(page, name, chat).locator("[data-unread]").waitFor({ state: "detached" });
        expect(new URL(page.url()).pathname).toBe("/app/chat");
        expect(await page.evaluate(() => window.chatNavigationMarker)).toBe("survives read from another device");
        expect(await geometry()).toEqual(before);
        await rowAction(page, name, dot, "Mark unread");
        await row(page, name, dot).locator('[data-unread="dot"]').waitFor();
        await settle(page);
        expect(await geometry()).toEqual(before);
        expect(await page.evaluate(() => window.chatShifts)).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }
});
