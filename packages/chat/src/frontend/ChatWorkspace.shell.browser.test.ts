import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { nora, pinPageClock, startChatHarness, viewer } from "./ChatWorkspace.browser-fixture";
import { chatShellPage } from "./ChatWorkspace.shell-fixture";

let harness: Awaited<ReturnType<typeof startChatHarness>>;
let shell: Awaited<ReturnType<typeof chatShellPage>>;
let browser: Browser;
beforeAll(async () => {
  shell = await chatShellPage((request) => {
    const url = new URL(request.url);
    const chat = /\/c\/([^/]+)/.exec(url.pathname)?.[1];
    return harness.props({ chat, panel: url.searchParams.get("panel") === "info" ? "info" : undefined });
  });
  harness = await startChatHarness({ renderPage: shell.render });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  harness?.stop();
  shell?.stop();
});

const geometry = () =>
  [".chat-conversation", ".chat-conversation__header", ".chat-conversation__composer"].map((selector) => {
    const rect = document.querySelector(selector)!.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
const load = async (chat: string, theme: "light" | "dark", options: BrowserContextOptions) => {
  const context = await browser.newContext({ ...options, colorScheme: theme });
  try {
    await context.addInitScript(pinPageClock, harness.now().getTime());
    await context.addCookies([{ url: harness.url, name: "theme", value: theme }]);
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(new URL(`/app/chat/c/${chat}`, harness.url).href);
    await settled(page);
    const server = await page.evaluate(geometry);
    await page.evaluate(
      ({ props }) => {
        document.getElementById("root")!.replaceChildren();
        window.mountChat(props, "en");
      },
      { props: harness.props({ chat }) },
    );
    // Read immediately after mounting, before waiting out any client transitions.
    expect(await page.evaluate(geometry)).toEqual(server);
    await settled(page);
    expect(await page.locator("html").evaluate((element, theme) => element.classList.contains(theme), theme)).toBe(true);
    return { page, errors };
  } catch (error) {
    await context.close();
    throw error;
  }
};
const field = (page: Page) => page.locator('.chat-conversation__composer textarea:not([aria-hidden="true"])');
const focused = (page: Page) => page.waitForFunction(() => document.activeElement?.matches(".chat-conversation__composer textarea"));
const sent = async (page: Page, chat: string, body: string) => {
  await page.locator('.k2b-message-row[data-status="sent"]', { hasText: body }).waitFor();
  expect(harness.posted.filter((message) => message.chat === chat).map((message) => message.body)).toEqual([body]);
};
const phoneFrame = async (page: Page, height: number) => {
  const [frame, header, composer] = await page.evaluate(geometry);
  expect(frame).toEqual({ x: 0, y: 0, width: 390, height });
  expect(header!.y).toBe(0);
  expect(composer!.y).toBeGreaterThan(header!.y + header!.height);
  expect(composer!.y + composer!.height).toBe(height);
};

for (const theme of ["light", "dark"] as const) {
  test(`phone full-shell composer accepts touch, focus and send in ${theme}`, async () => {
    const chat = harness.addChat({ members: [viewer, nora], count: 4, end: harness.now() });
    const { page, errors } = await load(chat, theme, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      expect(await page.locator('.cloud-tab-bar a[data-tab="chat"]').isVisible()).toBe(true);
      await phoneFrame(page, 844);
      await field(page).tap();
      await focused(page);
      const body = `Full shell touch ${theme}`;
      await page.keyboard.insertText(body);
      await page.getByRole("button", { name: "Send message", exact: true }).tap();
      await sent(page, chat, body);
      // The same real frame follows a shorter viewport and then a desktop resize.
      await page.setViewportSize({ width: 390, height: 600 });
      await settled(page);
      await phoneFrame(page, 600);
      await field(page).tap();
      await focused(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await settled(page);
      const desktop = await page.locator(".chat-conversation").boundingBox();
      expect(desktop!.x).toBeGreaterThan(0);
      expect(desktop!.height).toBeLessThan(900);
      await page.setViewportSize({ width: 390, height: 844 });
      await settled(page);
      await phoneFrame(page, 844);
      // The information screen stays above the conversation and returns to it.
      await page.getByRole("link", { name: "Chat info", exact: true }).tap();
      const info = page.locator("#k2b-workspace-detail-chat-info");
      await info.waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const rect = document.querySelector("#k2b-workspace-detail-chat-info")?.getBoundingClientRect();
        return rect?.x === 0 && rect.y === 0 && rect.width === 390 && rect.height === 844;
      });
      expect(await info.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
      await info.getByRole("button", { name: "Close chat info", exact: true }).tap();
      await info.waitFor({ state: "hidden" });
      await field(page).tap();
      await focused(page);
      // Returning to the list restores normal shell navigation hit testing.
      await page.getByRole("link", { name: "Back to chats", exact: true }).tap();
      await page.waitForURL("**/app/chat");
      await page.locator(".chat-conversation").waitFor({ state: "hidden" });
      const tab = page.locator('.cloud-tab-bar a[data-tab="chat"]');
      await tab.tap();
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test(`desktop full-shell composer is keyboard reachable and sends with Enter in ${theme}`, async () => {
    const chat = harness.addChat({ members: [viewer, nora], count: 4, end: harness.now() });
    const { page, errors } = await load(chat, theme, { viewport: { width: 1440, height: 900 } });
    try {
      const focusable = await page.locator("a[href],button,input,textarea,select,[tabindex]").count();
      for (let index = 0; index <= focusable; index += 1) {
        await page.keyboard.press("Tab");
        if (await field(page).evaluate((element) => document.activeElement === element)) break;
      }
      await focused(page);
      const body = `Full shell keyboard ${theme}`;
      await page.keyboard.insertText(body);
      await page.keyboard.press("Enter");
      await sent(page, chat, body);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
}
