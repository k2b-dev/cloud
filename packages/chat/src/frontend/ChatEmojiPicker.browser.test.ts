import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { chatTestNow, nora, pinPageClock, startChatHarness, viewer } from "./ChatWorkspace.browser-fixture";

// The emoji picker loads the first time it opens. That first opening must look and behave like every later one: one
// toggle to open and none to close, the focus in its search, and the picker beside the composer's emoji button.
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

const load = async () => {
  const chat = harness.addChat({ members: [viewer, nora], name: "Planning", count: 0, end: chatTestNow });
  harness.receive(chat, nora, "Lunch at noon?");
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(pinPageClock, chatTestNow.getTime() + 60_000);
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const errors = pageErrors(page);
  await page.goto(new URL(`/app/chat/c/${chat}`, harness.url).href);
  await page.evaluate(({ props }) => window.mountChat(props, "en"), { props: harness.props({ chat }) });
  await page.locator(".chat-workspace").waitFor();
  await settled(page);
  // Every open and close of the picker from now on, before its code has loaded.
  await page.evaluate(() => {
    const log: string[] = [];
    (window as unknown as { toggles: string[] }).toggles = log;
    document.addEventListener(
      "toggle",
      (event) => {
        if ((event.target as Element).matches(".k2b-emoji-picker-popover")) log.push((event as ToggleEvent).newState);
      },
      true,
    );
  });
  return { page, errors };
};
const button = (page: Page) => page.locator(".chat-conversation__composer").getByRole("button", { name: "Insert emoji", exact: true });
const opened = async (page: Page) => {
  const search = page.getByRole("combobox", { name: "Search emoji" });
  await search.waitFor();
  await page.waitForFunction(() => document.activeElement?.closest(".k2b-emoji-picker-popover") != null);
  await settled(page);
  return page.evaluate(() => {
    const picker = document.querySelector(".k2b-emoji-picker-popover")!.getBoundingClientRect();
    const anchor = document.querySelector<HTMLElement>(".chat-conversation__composer button[aria-expanded='true']")!;
    const box = anchor.getBoundingClientRect();
    return {
      toggles: [...(window as unknown as { toggles: string[] }).toggles],
      expanded: anchor.getAttribute("aria-expanded"),
      // Above the button and aligned with its end, as every later opening places it.
      gap: box.top - picker.bottom,
      end: Math.abs(box.right - picker.right),
    };
  });
};

test("a click opens the picker the first time without flicker, beside the emoji button, with the focus in its search and back after Escape", async () => {
  const { page, errors } = await load();
  try {
    // A press on the emoji button keeps the focus where it was, such as in the field; Escape returns it there.
    const before = await page.evaluateHandle(() => document.activeElement);
    await button(page).click();
    const first = await opened(page);
    expect(first.toggles).toEqual(["open"]);
    expect(first.expanded).toBe("true");
    expect(first.gap).toBeGreaterThanOrEqual(0);
    expect(first.gap).toBeLessThan(16);
    expect(first.end).toBeLessThan(1);
    await page.keyboard.press("Escape");
    await page.waitForFunction((element) => document.activeElement === element, before);
    expect(await button(page).getAttribute("aria-expanded")).not.toBe("true");
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 30_000);

test("the keyboard opens the picker the first time and Escape returns the focus to the emoji button", async () => {
  const { page, errors } = await load();
  try {
    await button(page).focus();
    await page.keyboard.press("Enter");
    const first = await opened(page);
    expect(first.toggles).toEqual(["open"]);
    expect(first.gap).toBeGreaterThanOrEqual(0);
    expect(first.end).toBeLessThan(1);
    await page.keyboard.press("Escape");
    await page.waitForFunction((element) => document.activeElement === element, await button(page).elementHandle());
    // The second opening, with the code loaded, lands in the same place.
    await page.keyboard.press("Enter");
    const second = await opened(page);
    expect(second.toggles).toEqual(["open", "closed", "open"]);
    expect(second.gap).toBeCloseTo(first.gap, 0);
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 30_000);
