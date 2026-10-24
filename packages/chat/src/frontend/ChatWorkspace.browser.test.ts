import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Browser, BrowserContextOptions, Locator, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { chatMessages } from "../messages";
import { CreateConversationSchema, CreateOutcomeSchema } from "../service/contracts";
import { chatTestNow, nora, pinPageClock, startChatHarness, tobias, viewer } from "./ChatWorkspace.browser-fixture";

declare global {
  interface Window {
    chatShifts: number;
    chatShiftObserver: PerformanceObserver | undefined;
    chatNavigationMarker: string;
    chatSeen: number;
    chatSeenFrame: number;
    chatReadStarts: { chat: string; at: number }[];
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
/** Records when the page starts each read post, on the page's own clock, so throttle assertions do not depend on event delivery. */
const recordReadStarts = () => {
  window.chatReadStarts = [];
  window.fetch = new Proxy(window.fetch, {
    apply: (target, self, args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      const url = new URL(input instanceof Request ? input.url : input, location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const match = /^\/api\/chat\/conversations\/([^/]+)\/read$/.exec(url.pathname);
      if (method.toUpperCase() === "POST" && match) window.chatReadStarts.push({ chat: match[1]!, at: performance.now() });
      return Reflect.apply(target, self, args);
    },
  });
};
const readStarts = (page: Page, chat: string) =>
  page.evaluate((chat) => window.chatReadStarts.filter((start) => start.chat === chat).map((start) => start.at), chat);
const load = async (
  options: BrowserContextOptions,
  address: { chat?: string; message?: string; panel?: "info" },
  observe = false,
  prepare?: (page: Page) => Promise<void>,
  presentation: { locale?: string; theme?: "light" | "dark"; guest?: boolean } = {},
) => {
  const context = await browser.newContext(options);
  try {
    await context.addInitScript(pinPageClock, harness.now().getTime());
    await context.addInitScript(recordReadStarts);
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const path = address.chat ? `/app/chat/c/${address.chat}${address.message ? `/m/${address.message}` : ""}` : "/app/chat";
    const url = new URL(path, harness.url);
    if (presentation.theme) url.searchParams.set("theme", presentation.theme);
    if (address.panel) url.searchParams.set("panel", address.panel);
    await page.goto(url.href);
    await settle(page);
    // real clock: proves the page reads the pinned day, not the machine's
    expect(await page.evaluate(() => new Date().toISOString().slice(0, 10))).toBe(chatTestNow.toISOString().slice(0, 10));
    if (presentation.theme)
      expect(await page.locator("html").evaluate((element, theme) => element.classList.contains(theme), presentation.theme)).toBe(true);
    if (observe) await observeShifts(page);
    await prepare?.(page);
    await page.evaluate(({ props, locale }) => window.mountChat(props, locale), {
      props: harness.props(address, { guest: presentation.guest }),
      locale: presentation.locale ?? "en",
    });
    await settle(page);
    return { page, errors };
  } catch (error) {
    await context.close();
    throw error;
  }
};
/** A closing dialog hands focus back after it has left; wait for that instead of sampling one frame. */
const focused = async (entry: Locator) => {
  const element = await entry.elementHandle();
  await entry.page().waitForFunction((element) => document.activeElement === element, element);
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
      const chat = harness.addChat({ members: [viewer, nora], count: 40, end: harness.now() });
      const other = harness.addChat({ members: [viewer, tobias], count: 4, end: new Date(harness.now().getTime() - 60_000) });
      const { page, errors } = await load(options, { chat });
      try {
        await page.waitForFunction(() => document.querySelector(".k2b-virtual-feed__viewport")!.scrollTop > 0);
        await page.waitForFunction(() => document.querySelector(".chat-conversation") !== null);
        await until(() => harness.subscribed(chat));
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
      const chat = harness.addChat({ members: [viewer, nora], name: `Layout ${name}`, count: 4, end: harness.now() });
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
      const chat = harness.addChat({ members: [viewer, nora], count: 120, end: harness.now() });
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
    test(`oversized messages keep the draft and recover after shortening on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], count: 4, end: harness.now() });
      const locale = name === "phone" ? "de-DE" : "en";
      const { page, errors } = await load(options, { chat }, false, undefined, { locale });
      try {
        const start = harness.posted.length;
        const field = page.getByRole("textbox");
        const hint = page.locator(".k2b-chat-composer__hint-text");
        const send = page.getByRole("button", { name: locale === "en" ? "Send message" : "Nachricht senden", exact: true });
        const messagesUrl = `**/api/chat/conversations/${chat}/messages`;
        let rejectedPosts = 0;
        // A server refusal must leave the browser assertions running, even if the client guard regresses.
        await page.route(messagesUrl, async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          rejectedPosts++;
          await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ message: "Invalid input" }) });
        });
        for (const body of ["a".repeat(20_001), "😀".repeat(20_001)]) {
          await field.fill(body);
          // Keyboard and touch submission both preserve text that the server would reject.
          if (name === "desktop") await field.press("Enter");
          else await send.click();
          // Touch submission first settles dialog history. The restored, enabled send button proves it finished.
          await page.waitForFunction(() => {
            const send = document.querySelector<HTMLButtonElement>(".k2b-chat-composer__send");
            return send !== null && !send.disabled;
          });
          await page
            .getByText(locale === "en" ? "Shorten to at most 20,000 characters." : "Kürze auf höchstens 20.000 Zeichen.", { exact: true })
            .waitFor();
          expect(await hint.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
          expect((await field.inputValue()) === body).toBe(true);
          expect(rejectedPosts).toBe(0);
          expect(harness.posted.slice(start)).toEqual([]);
          expect(await page.locator('[data-status="failed"], [data-status="pending"]').count()).toBe(0);
        }
        await page.unroute(messagesUrl);
        const valid = "😀".repeat(20_000);
        await field.fill(valid);
        expect(await hint.textContent()).toBe("");
        await send.click();
        await until(() => harness.posted.length === start + 1);
        await page.locator('[data-status="pending"]').waitFor({ state: "detached" });
        expect(await field.inputValue()).toBe("");
        expect(harness.posted.slice(start).map((input) => input.body)).toEqual([valid]);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
    test(`failed send retries one message with the same client ID on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], count: 4, end: harness.now() });
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
      const chat = harness.addChat({ members: [viewer, nora], count: 4, end: harness.now() });
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
        // "Discard" sits next to "Retry" where the failure shows, on a phone and with a mouse alike.
        await failed.getByRole("button", { name: "Discard", exact: true }).click();
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
    const chat = harness.addChat({ members: [viewer, nora], count: 120, end: harness.now() });
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
    const chat = harness.addChat({ members: [viewer, nora], name: "Before rename", count: 4, end: harness.now() });
    const { page, errors } = await load(viewports[0]!.options, { chat });
    try {
      await until(() => harness.subscribed(chat));
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
    const first = harness.addChat({ members: [viewer, nora], name: "First chat", count: 4, end: harness.now() });
    const second = harness.addChat({ members: [viewer, tobias], name: "Second chat", count: 4, end: harness.now() });
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
  const deadline = performance.now() + 5_000;
  while (!condition() && performance.now() < deadline) await Bun.sleep(10);
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
/** Opens a message's menu the way each device does: "…" beside the bubble on a desktop, a long press on a phone. */
const openMessageMenu = async (page: Page, name: string, item: Locator) => {
  if (name === "phone") {
    await item.locator(".k2b-message-row__text").scrollIntoViewIfNeeded();
    const box = (await item.locator(".k2b-message-row__text").boundingBox())!;
    const point = { x: box.x + 8, y: box.y + box.height / 2 };
    // A page that just opened may still be settling; the finger lands once the message is what lies under it.
    const key = await item.getAttribute("data-key");
    await page.waitForFunction(
      ({ point, key }) => document.elementFromPoint(point.x, point.y)?.closest("[data-key]")?.getAttribute("data-key") === key,
      { point, key },
    );
    // Playwright taps only as a whole; the held pointer's lifecycle runs as GestureMenu receives it on a phone.
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
      await new Promise((resolve) => setTimeout(resolve, 650));
      target.dispatchEvent(new PointerEvent("pointerup", init));
    }, point);
    const sheet = page.locator("dialog[open]");
    await sheet.waitFor();
    return sheet;
  }
  await item.locator(".k2b-message-row__bubble").hover();
  await item.getByRole("button", { name: "Message actions", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Message actions", exact: true });
  await menu.waitFor();
  return menu;
};
const chooseFromMessageMenu = async (page: Page, name: string, item: Locator, entry: string) => {
  const menu = await openMessageMenu(page, name, item);
  await menu.getByRole("menuitem", { name: new RegExp(`^${entry}`) }).click();
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
  // Give a pending report a full batching interval on the page's clock and check both fetch starts and server reads.
  const startsBefore = (await readStarts(page, chat)).length;
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1_050)));
  expect(await readStarts(page, chat)).toHaveLength(startsBefore);
  expect(chatReads(chat)).toHaveLength(before);
};

describe("ChatWorkspace browser read state", () => {
  beforeEach(() => harness.reset());
  test("Escape in the sidebar neither reports a read nor announces", async () => {
    const chat = harness.addChat({ members: [viewer, nora], count: 150, unread: 98, end: harness.now() });
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
      const three = harness.addChat({ members: [viewer, nora], name: "Three unread", count: 8, unread: 3, end: harness.now() });
      const capped = harness.addChat({ members: [viewer, tobias], name: "Many unread", count: 181, unread: 120, end: harness.now() });
      const read = harness.addChat({ members: [viewer, nora], name: "Already read", count: 8, end: harness.now() });
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
      const chat = harness.addChat({ members: [viewer, nora], count: 48, unread: 25, end: harness.now() });
      const start = harness.props({ chat }).open!.conversation.read!.lastReadSeq!;
      const { page, errors } = await load(options, { chat }, false, async (page) => {
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
        const starts = await readStarts(page, chat);
        // Page-clock fetch starts: 50 ms covers only the in-page reporter-clock-to-fetch gap and Date.now's whole milliseconds.
        expect(starts.length).toBeLessThanOrEqual(1 + Math.floor((starts.at(-1)! - starts[0]! + 50) / 1_000));
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`marker stays on its opening message during arrivals and header jump preserves height on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], count: 48, unread: 25, end: harness.now() });
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
        const chat = harness.addChat({ members: [viewer, nora], count: 8, end: harness.now() });
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
      const chat = harness.addChat({ members: [viewer, nora], count: 150, unread: 98, end: harness.now() });
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
      const chat = harness.addChat({ members: [viewer, nora], count: 40, end: harness.now() });
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
        harness.addChat({ members: [viewer, nora], name: `Small ${i}`, count: 4, unread: 2, end: harness.now() }),
      );
      const { page, errors } = await load(options, {});
      try {
        await until(() => harness.subscribed());
        await readAllAction(page, name);
        await page.waitForFunction(() => document.querySelectorAll("[data-unread]").length === 0);
        expect(await page.getByRole("dialog").count()).toBe(0);
        expect(small.every((chat) => harness.props({ chat }).open!.conversation.unread === 0)).toBe(true);
        // More than one server batch also proves that `more` is followed until every count clears.
        await page.context().close();
        harness.reset();
        const many = Array.from({ length: 51 }, (_, i) =>
          harness.addChat({ members: [viewer, nora], name: `Batch ${i}`, count: 4, unread: 2, end: harness.now() }),
        );
        const second = await load(options, {});
        try {
          await until(() => harness.subscribed());
          await readAllAction(second.page, name);
          const dialog = second.page.getByRole("dialog");
          await dialog.waitFor();
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
          expect(many.every((chat) => harness.props({ chat }).open!.conversation.unread === 2)).toBe(true);
          expect(await rows(second.page, name).locator("[data-unread]").count()).toBe(51);
          await readAllAction(second.page, name);
          await dialog.getByRole("button", { name: "Mark all read", exact: true }).click();
          await second.page.waitForFunction(() => document.querySelectorAll("[data-unread]").length === 0);
          expect(many.every((chat) => harness.props({ chat }).open!.conversation.unread === 0)).toBe(true);
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
        harness.addChat({ members: [viewer, nora], name: `Threshold ${i}`, count: 4, unread: 2, end: harness.now() }),
      );
      const { page, errors } = await load(options, {});
      try {
        await until(() => harness.subscribed());
        await readAllAction(page, name);
        const dialog = page.getByRole("dialog", { name: "Mark all chats read?", exact: true });
        await dialog.waitFor();
        expect(chats.every((chat) => harness.props({ chat }).open!.conversation.unread === 2)).toBe(true);
        await dialog.getByRole("button", { name: "Mark all read", exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll("[data-unread]").length === 0);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`row mark unread and read, message mark unread pauses reporting, Escape reads the head on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], name: "Read actions", count: 8, end: harness.now() });
      const dot = harness.addChat({ members: [viewer], name: "No incoming text", count: 4, end: harness.now() });
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
        // settled: the menu helper waits for its target under the pointer, Playwright for the button.
        await chooseFromMessageMenu(page, name, item, "Mark unread from here");
        await marker(page).waitFor();
        expect(await marker(page).evaluate((element) => element.closest("[data-key]")!.getAttribute("data-key"))).toBe(target);
        await until(() => harness.props({ chat }).open!.conversation.read!.unreadFromSeq === 5);
        const count = chatReads(chat).length;
        harness.receive(chat, nora, "Stays unread while open");
        await page.getByRole("feed").getByText("Stays unread while open", { exact: true }).waitFor();
        await noReportsForBatch(page, chat, count);
        await page.locator(".k2b-virtual-feed__viewport").click();
        await page.keyboard.press("Escape");
        await until(() => chatReads(chat).length === count + 1);
        expect(chatReads(chat).at(-1)).toEqual({ chat, seq: 9 });
        await marker(page).waitFor({ state: "detached" });
        expect(harness.props({ chat }).open!.conversation.unread).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`"Mark unread from here" in the message menu: undo, failure with retry, own messages, copy on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], name: "Menu actions", count: 8, end: harness.now() });
      const { page, errors } = await load(options, { chat }, true);
      try {
        await until(() => harness.subscribed(chat));
        const target = page.locator(`[data-key="${harness.messageId(chat, 5)}"]`);
        const own = page.locator(`[data-key="${harness.messageId(chat, 7)}"]`);

        // Own messages never count as unread, so their menu has no such entry; "Reply" and "Copy text" are on every message.
        // settled: the menu helper waits for its target under the pointer, Playwright for the button.
        const ownMenu = await openMessageMenu(page, name, own);
        expect(await ownMenu.getByRole("menuitem").allInnerTexts()).toEqual([
          expect.stringContaining("Reply"),
          expect.stringContaining("Copy text"),
        ]);
        await page.keyboard.press("Escape");
        await ownMenu.waitFor({ state: "hidden" });

        // A failure leaves the marker and read state as they were and offers "Try again".
        harness.failUnread();
        await chooseFromMessageMenu(page, name, target, "Mark unread from here");
        const failed = page.locator(".k2b-toast").filter({ hasText: "The read state could not be changed." });
        await failed.waitFor();
        expect(await marker(page).count()).toBe(0);
        expect(harness.props({ chat }).open!.conversation.read!.unreadFromSeq).toBe(null);
        await failed.getByRole("button", { name: "Try again", exact: true }).click();
        // An action closes its message, so it cannot run twice.
        await failed.waitFor({ state: "detached" });
        await until(() => harness.props({ chat }).open!.conversation.read!.unreadFromSeq === 5);
        await marker(page).waitFor();
        expect(await marker(page).evaluate((element) => element.closest("[data-key]")!.getAttribute("data-key"))).toBe(
          harness.messageId(chat, 5),
        );

        // The success names whose message it starts at and offers "Undo", which puts everything back. Meanwhile the
        // chat counts as unread in the list.
        const done = page.locator(".k2b-toast").filter({ hasText: "Unread from Nora’s message" });
        await done.waitFor();
        if (name === "desktop") await row(page, name, chat).locator('[data-unread="count"]').waitFor();
        await done.getByRole("button", { name: "Undo", exact: true }).click();
        await done.waitFor({ state: "detached" });
        await until(() => harness.props({ chat }).open!.conversation.read!.unreadFromSeq === null);
        await marker(page).waitFor({ state: "detached" });
        expect(harness.props({ chat }).open!.conversation.unread).toBe(0);
        if (name === "desktop") await row(page, name, chat).locator("[data-unread]").waitFor({ state: "detached" });

        if (name === "desktop") {
          // Alt+click (Option+click) runs it directly.
          await target.locator(".k2b-message-row__text").click({ modifiers: ["Alt"] });
          await until(() => harness.props({ chat }).open!.conversation.read!.unreadFromSeq === 5);
          await marker(page).waitFor();
          // The entry teaches the shortcut and says what it does.
          const menu = await openMessageMenu(page, name, target);
          const entry = menu.getByRole("menuitem", { name: /^Mark unread from here/ });
          expect(await entry.innerText()).toContain("“New messages” starts at this message.");
          expect(await entry.locator("kbd.k2b-kbd").count()).toBe(1);
          await page.keyboard.press("Escape");
        }

        await page
          .context()
          .grantPermissions(["clipboard-read", "clipboard-write"])
          .catch(() => {});
        // settled: the menu helper waits for its target under the pointer, Playwright for the button.
        await chooseFromMessageMenu(page, name, target, "Copy text");
        await page.locator("[data-k2b-live]").getByText("Copied", { exact: true }).waitFor({ state: "attached" });
        if (errors.length) expect(errors).toEqual([]);
        if (name === "desktop") expect(await page.evaluate(() => window.chatShifts)).toBeLessThan(0.001);
      } finally {
        await page.context().close();
      }
    }, 45_000);

    test(`Undo restores an earlier unread boundary that is not loaded on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], name: "Long history", count: 160, end: harness.now() });
      const { page, errors } = await load(options, { chat });
      try {
        await until(() => harness.subscribed(chat));
        // An earlier "Mark unread from here" far above the loaded page.
        const earlier = harness.messageId(chat, 6);
        expect(
          await page.evaluate(
            async ({ chat, earlier }) =>
              (
                await fetch(`/api/chat/conversations/${chat}/unread`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ message: earlier }),
                })
              ).status,
            { chat, earlier },
          ),
        ).toBe(200);
        await until(() => harness.props({ chat }).open!.conversation.read!.unreadFromSeq === 6);
        const target = page.locator(".k2b-message-row:not([data-own])").last().locator("xpath=ancestor::*[@data-key][1]");
        // settled: the menu helper waits for its target under the pointer, Playwright for the button.
        await chooseFromMessageMenu(page, name, target, "Mark unread from here");
        const done = page.locator(".k2b-toast").filter({ hasText: "Unread from" });
        await done.waitFor();
        expect(harness.props({ chat }).open!.conversation.read!.unreadFromSeq).toBeGreaterThan(6);
        await done.getByRole("button", { name: "Undo", exact: true }).click();
        await until(() => harness.props({ chat }).open!.conversation.read!.unreadFromSeq === 6);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 45_000);

    test(`Escape independently marks the open head read and removes its marker on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], count: 48, unread: 25, end: harness.now() });
      const { page, errors } = await load(options, { chat });
      try {
        await marker(page).waitFor();
        await until(() => harness.subscribed(chat));
        await page.keyboard.press("Escape");
        await until(() => chatReads(chat).some((read) => read.seq === 48));
        await marker(page).waitFor({ state: "detached" });
        expect(harness.props({ chat }).open!.conversation.unread).toBe(0);
        if (name === "desktop") expect(await row(page, name, chat).locator("[data-unread]").count()).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`visible live arrivals keep the one-second read batching bound on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], count: 8, end: harness.now() });
      const { page, errors } = await load(options, { chat });
      try {
        await until(() => harness.subscribed(chat));
        for (let i = 1; i <= 5; i++) {
          harness.receive(chat, nora, `Batch arrival ${i}`);
          await page.getByRole("feed").getByText(`Batch arrival ${i}`, { exact: true }).waitFor();
          await settle(page);
        }
        await until(() => chatReads(chat).at(-1)?.seq === 13);
        const starts = await readStarts(page, chat);
        // Page-clock fetch starts: 50 ms covers only the in-page reporter-clock-to-fetch gap and Date.now's whole milliseconds.
        expect(starts.length).toBeLessThanOrEqual(1 + Math.floor((starts.at(-1)! - starts[0]! + 50) / 1_000));
        expect(chatReads(chat).map((read) => read.seq)).toEqual(
          [...new Set(chatReads(chat).map((read) => read.seq))].sort((a, b) => a - b),
        );
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`live counts and another-device reads move no sidebar geometry on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], name: "Live count", count: 4, end: harness.now() });
      const dot = harness.addChat({ members: [viewer], name: "Dot only", count: 4, end: harness.now() });
      harness.addChat({ members: [viewer, tobias], name: "Stable neighbour", count: 4, end: harness.now() });
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

describe("Chat member input mode", () => {
  beforeEach(() => harness.reset());
  for (const width of [1440, 820, 390]) {
    for (const theme of ["light", "dark"] as const) {
      test(`member removal follows touch and trackpad mode without moving at ${width}px in ${theme}`, async () => {
        const chat = harness.addChat({ members: [viewer, nora], count: 4, end: harness.now() });
        harness.setPermission(chat, "admin");
        const t = chatMessages.resolve(["en"]).t;
        const { page, errors } = await load(
          { viewport: { width, height: 900 }, hasTouch: width < 1024, isMobile: width < 1024, reducedMotion: "reduce" },
          { chat, panel: "info" },
          false,
          undefined,
          { theme },
        );
        try {
          const panel = page.locator("#k2b-workspace-detail-chat-info");
          await panel.waitFor({ state: "visible" });
          await panel.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
          const row = panel.locator(".chat-member-row").filter({ hasText: nora.name });
          const action = row.locator(".chat-member-row__remove");
          const remove = row.getByRole("button", { name: t.removeName({ name: nora.name }), exact: true });
          await remove.waitFor();
          await panel.getByRole("button", { name: t.closeChatInfo, exact: true }).focus();
          await page.mouse.move(0, 0);
          await settled(page);
          const box = await row.boundingBox();
          const actionBox = await action.boundingBox();
          const opacity = async (value: string) => {
            const element = await action.elementHandle();
            await page.waitForFunction(({ element, value }) => element !== null && getComputedStyle(element).opacity === value, {
              element,
              value,
            });
          };
          const canHover = await page.evaluate(() => {
            delete document.documentElement.dataset.k2bInput;
            return matchMedia("(any-hover: hover)").matches;
          });
          await opacity(width < 640 || !canHover ? "1" : "0");
          // The shared controller owns these attributes. Exercise its public CSS contract in both pointer environments.
          for (const mode of ["touch", "trackpad", "touch"] as const) {
            await page.evaluate((mode) => {
              document.documentElement.dataset.k2bInput = mode;
            }, mode);
            await opacity(width < 640 || mode === "touch" ? "1" : "0");
            expect(await row.boundingBox()).toEqual(box);
            expect(await action.boundingBox()).toEqual(actionBox);
          }
          await page.evaluate(() => {
            document.documentElement.dataset.k2bInput = "trackpad";
          });
          await remove.focus();
          await opacity("1");
          expect(await row.boundingBox()).toEqual(box);
          await page.keyboard.press("Enter");
          const dialog = page.getByRole("dialog");
          await dialog.waitFor();
          await dialog.getByRole("button", { name: t.cancel, exact: true }).click();
          await dialog.waitFor({ state: "hidden" });
          await focused(remove);
          expect(await row.boundingBox()).toEqual(box);
          expect(errors).toEqual([]);
        } finally {
          await page.context().close();
        }
      }, 30_000);
    }
  }
});

describe("ChatWorkspace start chats and members", () => {
  beforeEach(() => harness.reset());
  for (const { name, options } of viewports) {
    const locale = name === "phone" ? "de" : "en";
    const t = chatMessages.resolve([locale]).t;
    for (const kind of ["anyway", "group", "fresh"] as const) {
      test(`lost create response retries exactly one ${kind} chat on ${name} in ${locale}`, async () => {
        const chat = harness.addChat({ members: [viewer, nora], count: 4, end: harness.now() });
        harness.setPermission(chat, "admin");
        const group = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Project Team", size: 3 };
        harness.addGroup(group);
        const { page, errors } = await load(options, kind === "fresh" ? { chat } : {}, false, undefined, { locale });
        const requests: ReturnType<typeof CreateConversationSchema.parse>[] = [];
        let drop = true;
        let createdId: string | undefined;
        try {
          await page.route("**/api/chat/conversations", async (route) => {
            if (route.request().method() !== "POST") return route.continue();
            const body = CreateConversationSchema.parse(route.request().postDataJSON());
            requests.push(body);
            if (drop && (body.allowDuplicate || kind === "group")) {
              drop = false;
              // Commit at the HTTP fixture first, then discard only the response on its way to the browser.
              const response = await route.fetch();
              expect(response.status()).toBe(201);
              const outcome = CreateOutcomeSchema.parse(await response.json());
              if (outcome.outcome !== "created") throw new Error("Expected the committed chat");
              createdId = outcome.conversation.id;
              await route.abort("failed");
            } else await route.continue();
          });
          const entry = () =>
            kind === "fresh"
              ? page.locator(".chat-conversation__header").getByRole("button", { name: t.addPeople, exact: true })
              : page.getByRole("button", { name: t.newChat, exact: true }).filter({ visible: true });
          const title = kind === "fresh" ? t.addPeople : t.newChat;
          await entry().click();
          let dialog = page.getByRole("dialog", { name: title, exact: true });
          const person = kind === "fresh" ? tobias.name : kind === "group" ? group.name : nora.name;
          await dialog.getByRole("combobox").fill(person);
          await page.getByRole("option", { name: person }).click();
          await dialog.getByRole("textbox", { name: t.name, exact: true }).fill("Recovered intent");
          if (kind === "fresh") {
            const start = dialog.getByRole("button", { name: t.startWithoutHistory, exact: true });
            await start.click();
          } else {
            await dialog.getByRole("button", { name: t.startChat, exact: true }).click();
            if (kind === "anyway") await dialog.getByRole("button", { name: t.createAnyway, exact: true }).click();
          }
          await dialog.getByRole("alert").waitFor();
          if (!createdId) throw new Error("The dropped response must identify the committed chat");
          const destination = `/app/chat/c/${createdId}`;
          expect(createdId).not.toBe(chat);
          const accepted = requests.at(-1)!;
          expect(accepted.createKey).toMatch(/^[0-9a-f-]{36}$/);
          expect(harness.chatCount()).toBe(2);
          await dialog.getByText(t.createRecovery, { exact: true }).waitFor();
          if (kind === "anyway") {
            for (const match of await dialog.getByRole("list", { name: t.existingChatsLabel }).getByRole("button").all())
              expect(await match.isDisabled()).toBe(true);
          }
          // Dismissing is temporary: only the explicit Cancel button discards this intent.
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
          await focused(entry());
          await entry().click();
          dialog = page.getByRole("dialog", { name: title, exact: true });
          await dialog.getByText(t.createRecovery, { exact: true }).waitFor();
          if (kind !== "anyway") {
            expect(await dialog.getByRole("textbox", { name: t.name, exact: true }).isDisabled()).toBe(true);
            // Reopen after a real document reload: same tab, same immutable unresolved intent.
            await page.reload();
            await settle(page);
            await page.evaluate(({ props, locale }) => window.mountChat(props, locale), {
              props: harness.props(kind === "fresh" ? { chat } : {}),
              locale,
            });
            await entry().click();
            dialog = page.getByRole("dialog", { name: title, exact: true });
            await dialog.getByText(t.createRecovery, { exact: true }).waitFor();
            expect(await dialog.getByRole("textbox", { name: t.name, exact: true }).inputValue()).toBe("Recovered intent");
          }
          await dialog.getByRole("button", { name: t.retry, exact: true }).click();
          // The source chat already matches a generic chat URL; wait for the originally committed ID.
          await page.waitForURL((url) => url.pathname === destination);
          await page.locator(".chat-conversation__header").getByText("Recovered intent", { exact: true }).waitFor();
          await dialog.waitFor({ state: "hidden" });
          expect(requests.at(-1)).toEqual(accepted);
          expect(harness.chatCount()).toBe(2);
          const id = new URL(page.url()).pathname.split("/").at(-1)!;
          expect(id).toBe(createdId);
          expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("chat.create:")).length)).toBe(0);
          // An explicit cancellation discards a later dialog and returns keyboard focus to its entry.
          if (name === "phone") {
            await page.getByRole("link", { name: t.backToChats, exact: true }).click();
            await page.waitForURL((url) => url.pathname === "/app/chat");
          }
          const newChat = page.getByRole("button", { name: t.newChat, exact: true }).filter({ visible: true });
          await newChat.click();
          const fresh = page.getByRole("dialog", { name: t.newChat, exact: true });
          await fresh.getByRole("textbox", { name: t.name, exact: true }).waitFor();
          expect(await fresh.getByRole("textbox", { name: t.name, exact: true }).inputValue()).toBe("");
          await fresh.getByRole("button", { name: t.cancel, exact: true }).click();
          await fresh.waitFor({ state: "hidden" });
          await focused(newChat);
          expect(errors).toEqual([]);
        } finally {
          await page.context().close();
        }
      }, 30_000);
    }
  }
  for (const { name, options } of viewports) {
    for (const theme of ["light", "dark"] as const) {
      for (const locale of ["en", "de"]) {
        const t = chatMessages.resolve([locale]).t;
        const presentation = { theme, locale };
        const scenario = `${name}, ${theme}, ${locale}`;
        test(`New chat and Add people dismiss and restore entry focus without shifts on ${scenario}`, async () => {
          const chat = harness.addChat({ members: [viewer, nora], count: 4, end: harness.now() });
          harness.setPermission(chat, "admin");
          const { page, errors } = await load(options, {}, false, undefined, presentation);
          try {
            const newChat = page.getByRole("button", { name: t.newChat, exact: true }).filter({ visible: true });
            expect(await newChat.count()).toBe(1);
            if (name === "phone") expect(await page.locator(".chat-list-page").isVisible()).toBe(true);
            await observeShifts(page);
            for (const dismissal of ["escape", "cancel"]) {
              await newChat.click();
              const dialog = page.getByRole("dialog", { name: t.newChat, exact: true });
              await dialog.waitFor();
              await page.waitForTimeout(600);
              expect(await page.evaluate(() => window.chatShifts)).toBe(0);
              if (dismissal === "escape") await page.keyboard.press("Escape");
              else await dialog.getByRole("button", { name: t.cancel, exact: true }).click();
              await dialog.waitFor({ state: "hidden" });
              await focused(newChat);
              await page.waitForTimeout(600);
              expect(await page.evaluate(() => window.chatShifts)).toBe(0);
            }
            const list = page.locator(name === "phone" ? ".chat-list-page" : ".k2b-app-workspace__sidebar");
            await list.locator(`a[href="/app/chat/c/${chat}"]`).click();
            await page.waitForURL(`**/app/chat/c/${chat}`);
            const header = page.locator(".chat-conversation__header");
            const height = (await header.boundingBox())!.height;
            const entries = [{ entry: header.getByRole("button", { name: t.addPeople, exact: true }), title: t.addPeople }];
            if (name === "desktop") entries.push({ entry: newChat, title: t.newChat });
            await observeShifts(page);
            for (const { entry, title } of entries) {
              for (const dismissal of ["escape", "cancel"]) {
                await entry.click();
                const dialog = page.getByRole("dialog", { name: title, exact: true });
                await dialog.waitFor();
                await page.waitForTimeout(600);
                expect((await header.boundingBox())!.height).toBe(height);
                expect(await page.evaluate(() => window.chatShifts)).toBe(0);
                if (dismissal === "escape") await page.keyboard.press("Escape");
                else await dialog.getByRole("button", { name: t.cancel, exact: true }).click();
                await dialog.waitFor({ state: "hidden" });
                await focused(entry);
                await page.waitForTimeout(600);
                expect((await header.boundingBox())!.height).toBe(height);
                expect(await page.evaluate(() => window.chatShifts)).toBe(0);
              }
            }
            expect(errors).toEqual([]);
          } finally {
            await page.context().close();
          }
        }, 30_000);

        test(`Chat info keeps URL state across reload and its responsive geometry without shifts on ${scenario}`, async () => {
          const chat = harness.addChat({ members: [viewer, nora], count: 4, end: harness.now() });
          harness.setPermission(chat, "admin");
          harness.seedMembers(chat, 101);
          const { page, errors } = await load(options, { chat }, false, undefined, presentation);
          try {
            const header = page.locator(".chat-conversation__header");
            const height = (await header.boundingBox())!.height;
            const panel = page.locator("#k2b-workspace-detail-chat-info");
            const assertPanel = async () => {
              await panel.waitFor({ state: "visible" });
              // Geometry is only final once the panel's entry transition has run; a fixed wait loses that race on a busy machine.
              await panel.evaluate((element) =>
                Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined))),
              );
              await page.waitForTimeout(600);
              const box = await panel.boundingBox();
              expect(box).not.toBeNull();
              if (name === "phone") expect(box).toEqual({ x: 0, y: 0, width: 390, height: 844 });
              else expect(box!.x).toBeGreaterThan(1000);
              expect((await header.boundingBox())!.height).toBe(height);
              expect(await page.evaluate(() => window.chatShifts)).toBe(0);
            };
            const closePanel = async () => {
              await panel.getByRole("button", { name: t.closeChatInfo, exact: true }).click();
              await panel.waitFor({ state: "hidden" });
              await page.waitForTimeout(600);
              await page.waitForURL((url) => !url.searchParams.has("panel"));
              expect((await header.boundingBox())!.height).toBe(height);
              expect(await page.evaluate(() => window.chatShifts)).toBe(0);
            };
            await observeShifts(page);
            await header.getByRole("link", { name: t.chatInfo, exact: true }).click();
            await page.waitForURL((url) => url.searchParams.get("panel") === "info");
            await assertPanel();
            await panel.getByRole("button", { name: t.showMoreMembers, exact: true }).waitFor();
            await closePanel();
            await header.getByRole("link", { name: t.chatInfo, exact: true }).click();
            await assertPanel();
            // Reload the same route with the info prop SSR would supply. The fixture
            // chooses theme from the URL, so put the current theme back before reload.
            const address = new URL(page.url());
            address.searchParams.set("theme", theme);
            await page.evaluate((url) => history.replaceState(history.state, "", url), address.href);
            await page.reload();
            await settle(page);
            await observeShifts(page);
            await page.evaluate(({ props, locale }) => window.mountChat(props, locale), {
              props: harness.props({ chat, panel: "info" }),
              locale,
            });
            await assertPanel();
            expect(new URL(page.url()).searchParams.get("panel")).toBe("info");
            await closePanel();
            expect(errors).toEqual([]);
          } finally {
            await page.context().close();
          }
        }, 30_000);

        test(`creating through New chat opens in place and appears in the list on ${scenario}`, async () => {
          const person = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Casey New" };
          harness.addPerson(person);
          harness.addChat({ members: [viewer, nora], count: 4, end: harness.now() });
          const { page, errors } = await load(options, {}, false, undefined, presentation);
          try {
            await page.evaluate(() => {
              window.chatNavigationMarker = "created-in-place";
            });
            await page.getByRole("button", { name: t.newChat, exact: true }).filter({ visible: true }).click();
            const dialog = page.getByRole("dialog", { name: t.newChat, exact: true });
            await dialog.getByRole("combobox").fill(person.name);
            await page.getByRole("option", { name: person.name }).click();
            await dialog.getByRole("textbox", { name: t.name, exact: true }).fill("Created through dialog");
            const created = page.waitForResponse(
              (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/chat/conversations",
            );
            await dialog.getByRole("button", { name: t.startChat, exact: true }).click();
            expect((await created).status()).toBe(201);
            await page.waitForURL(/\/app\/chat\/c\/[0-9A-Za-z]{6}$/);
            const id = new URL(page.url()).pathname.split("/").at(-1)!;
            await page.locator(".chat-conversation__header").getByText("Created through dialog", { exact: true }).waitFor();
            expect(await page.evaluate(() => window.chatNavigationMarker)).toBe("created-in-place");
            expect(harness.members(id).some((member) => member.principal.type === "user" && member.principal.userId === person.id)).toBe(
              true,
            );
            await dialog.waitFor({ state: "hidden" });
            if (name === "phone") {
              await page.getByRole("link", { name: t.backToChats, exact: true }).click();
              await page.waitForURL((url) => url.pathname === "/app/chat");
            }
            const list = page.locator(name === "phone" ? ".chat-list-page" : ".k2b-app-workspace__sidebar");
            await list.locator(`a[href="/app/chat/c/${id}"]`).getByText("Created through dialog", { exact: true }).waitFor();
            expect(await page.evaluate(() => window.chatNavigationMarker)).toBe("created-in-place");
            expect(errors).toEqual([]);
          } finally {
            await page.context().close();
          }
        }, 30_000);
      }
    }
  }
});

// Route-owned visibility must use the same info route from every entry point.
describe("Chat info reopening", () => {
  beforeEach(() => harness.reset());
  for (const { name, options } of viewports) {
    test(`info stays reachable after X and preserves Back on ${name}`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], count: 8, end: harness.now() });
      const { page, errors } = await load(options, { chat });
      try {
        const toggle = page.locator('.chat-conversation__header a[aria-controls="k2b-workspace-detail-chat-info"]');
        expect(await toggle.isVisible()).toBe(true);
        expect(await toggle.isEnabled()).toBe(true);
        // A surviving Info link must remain a real hit target beside People,
        // including the phone's fixed conversation header.
        await toggle.click({ trial: true });
        await page.locator(".chat-conversation__header").getByRole("button", { name: "Add people", exact: true }).click({ trial: true });
        await toggle.focus();
        await page.keyboard.press("Enter");
        await page.waitForURL("**?panel=info");
        expect(await toggle.getAttribute("aria-expanded")).toBe("true");
        await page.getByRole("button", { name: "Close chat info", exact: true }).click();
        await page.waitForURL(`**/c/${chat}`);
        expect(await toggle.isVisible()).toBe(true);
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        await toggle.click();
        await page.waitForURL("**?panel=info");
        await page.goBack();
        await page.waitForURL(`**/c/${chat}`);
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        await page.reload();
        // This harness mounts explicitly rather than hydrating an island.
        await page.evaluate((props) => window.mountChat(props, "en"), harness.props({ chat }));
        await settle(page);
        expect(await toggle.isVisible()).toBe(true);
        expect(await toggle.isEnabled()).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }
  test("no info action can reveal a retained chat without selection", async () => {
    const { page, errors } = await load(viewports[0]!.options, {});
    try {
      const toggle = page.locator("[data-app-workspace-detail-toggle]");
      expect(await toggle.isVisible()).toBe(false);
      expect(await page.locator('.chat-conversation__header a[aria-controls="k2b-workspace-detail-chat-info"]').count()).toBe(0);
      expect(await page.locator(".k2b-app-workspace__detail").isVisible()).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  });
});
