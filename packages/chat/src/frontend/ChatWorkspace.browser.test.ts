import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { nora, startChatHarness, tobias, viewer } from "./ChatWorkspace.browser-fixture";

declare global {
  interface Window {
    chatShifts: number;
    chatShiftObserver: PerformanceObserver | undefined;
    chatNavigationMarker: string;
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
const load = async (options: BrowserContextOptions, address: { chat?: string; message?: string }, observe = false) => {
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
  }
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
