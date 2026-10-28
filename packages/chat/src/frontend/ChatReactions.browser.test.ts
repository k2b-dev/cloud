import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Browser, BrowserContextOptions, Locator, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { chatMessages } from "../messages";
import { chatTestNow, nora, pinPageClock, startChatHarness, tobias, viewer } from "./ChatWorkspace.browser-fixture";

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
const t = chatMessages.resolve(["en"]).t;

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 5_000; // real clock: bounds the wait for the in-memory server
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time"); // real clock: bounds the wait
    await Bun.sleep(20);
  }
};
const load = async (options: BrowserContextOptions, chat: string) => {
  const context = await browser.newContext(options);
  await context.addInitScript(pinPageClock, chatTestNow.getTime());
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(new URL(`/app/chat/c/${chat}`, harness.url).href);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(({ props }) => window.mountChat(props, "en"), { props: harness.props({ chat }) });
  await page.locator(".chat-workspace").waitFor();
  return { page, errors };
};
const message = (page: Page, text: string) => page.locator(".k2b-virtual-feed__item", { hasText: text });
/** Opens a message's menu: "…" with a mouse, a long press on a phone. */
const openMenu = async (page: Page, phoneSize: boolean, item: Locator) => {
  if (phoneSize) {
    const box = (await item.locator(".k2b-message-row__text").boundingBox())!;
    const point = { x: box.x + 8, y: box.y + box.height / 2 };
    const key = await item.getAttribute("data-key");
    // settled: the finger lands once the message is what lies under it.
    await page.waitForFunction(
      ({ point, key }) => document.elementFromPoint(point.x, point.y)?.closest("[data-key]")?.getAttribute("data-key") === key,
      { point, key },
    );
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
    return sheet;
  }
  await item.locator(".k2b-message-row__bubble").hover();
  await item.getByRole("button", { name: "Message actions", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Message actions", exact: true });
  await menu.waitFor();
  return menu;
};
const pick = async (page: Page, name: string) => {
  await page.getByRole("combobox", { name: "Search emoji" }).fill(name);
  await page.getByRole("option").first().waitFor();
  await page.keyboard.press("Enter");
};
/** A team chat where Nora wrote last; the viewer reads it. */
const seed = () => {
  const chat = harness.addChat({ members: [viewer, nora, tobias], name: "IT", count: 3, end: new Date(chatTestNow.getTime() - 3_600_000) });
  const last = harness.props({ chat }).open!.page.items.at(-1)!;
  return { chat, last };
};

describe("Reactions", () => {
  for (const [name, options] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`${name}: react from the message menu, see others react live, and take a reaction back in place`, async () => {
      const { chat, last } = seed();
      const { page, errors } = await load(options, chat);
      try {
        const item = message(page, last.body!);
        await item.waitFor();
        // Another person's message without reactions reserves no line for them.
        expect(await item.locator(".k2b-reaction-bar").count()).toBe(0);
        const menu = await openMenu(page, name === "phone", item);
        await menu.getByRole("menuitem", { name: new RegExp(`^${t.addReaction}`) }).click();
        await pick(page, "thumbs up");
        const thumbs = item.getByRole("button", { name: /👍/ });
        await thumbs.waitFor();
        expect(await thumbs.getAttribute("aria-pressed")).toBe("true");
        await until(() => harness.reactionRequests.some((request) => request.method === "PUT" && request.emoji === "👍"));
        // Nora reacts too; the open chat shows it without a reload.
        harness.react(chat, last.id, nora.id, "🎉");
        await item.getByRole("button", { name: /🎉/ }).waitFor();
        // Pointer and focus leave the reactions, so no hint fades in while the row is measured.
        await page.mouse.move(1, 1);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.waitForFunction(() => !document.querySelector(".k2b-tooltip:popover-open"));
        await settled(page);
        const height = (await item.boundingBox())!.height;
        // Taking a reaction back keeps the line, so nothing below moves.
        await thumbs.click();
        await thumbs.waitFor({ state: "detached" });
        await until(() => harness.reactionRequests.some((request) => request.method === "DELETE" && request.emoji === "👍"));
        harness.react(chat, last.id, nora.id, "🎉", false);
        await item.getByRole("button", { name: /🎉/ }).waitFor({ state: "detached" });
        await page.mouse.move(1, 1);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.waitForFunction(() => !document.querySelector(".k2b-tooltip:popover-open"));
        await settled(page);
        expect((await item.boundingBox())!.height).toBe(height);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("a failed reaction goes back and says so", async () => {
    const { chat, last } = seed();
    harness.react(chat, last.id, nora.id, "👀");
    const { page, errors } = await load(desktop, chat);
    try {
      const item = message(page, last.body!);
      const eyes = item.getByRole("button", { name: /👀/ });
      await eyes.waitFor();
      harness.failReactions();
      await eyes.click();
      await page.locator(".k2b-toast", { hasText: "Reactions are unavailable." }).waitFor();
      await until(() => harness.reactionRequests.some((request) => request.method === "PUT"));
      await page.waitForFunction(
        () => document.querySelector(".k2b-reaction-bar [aria-pressed]")?.getAttribute("aria-pressed") === "false",
      );
      expect(await eyes.innerText()).toContain("1");
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a channel reader cannot write but can react", async () => {
    const id = harness.addChannel("Handbook", "Read the handbook", true, "read");
    harness.setPermission(id, "read");
    const last = harness.props({ chat: id }).open!.page.items.at(-1)!;
    const { page, errors } = await load(desktop, id);
    try {
      await page.getByText(t.channelReadOnly, { exact: true }).waitFor();
      expect(await page.locator("textarea:not([aria-hidden])").count()).toBe(0);
      const item = message(page, last.body!);
      const menu = await openMenu(page, false, item);
      await menu.getByRole("menuitem", { name: new RegExp(`^${t.addReaction}`) }).click();
      await pick(page, "thumbs up");
      await item.getByRole("button", { name: /👍/ }).waitFor();
      await until(() => harness.reactionRequests.some((request) => request.method === "PUT"));
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
