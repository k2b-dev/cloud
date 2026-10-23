import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Browser, BrowserContextOptions } from "playwright";
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
const load = async (options: BrowserContextOptions, address: { chat: string; panel?: string }) => {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(new URL(`/app/chat/c/${address.chat}${address.panel ? "?panel=info" : ""}`, harness.url).href);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(({ props }) => window.mountChat(props, "en"), { props: harness.props(address) });
  await page.locator(".chat-workspace").waitFor();
  return { page, errors };
};
/** A team chat where Nora shared a task the viewer may open, a task they may not, and a link. */
const seed = () => {
  const chat = harness.addChat({ members: [viewer, nora, tobias], name: "IT", count: 4, end: new Date(chatTestNow.getTime() - 3_600_000) });
  const open = harness.addElement({ id: "cooling", title: "Delivery cooling shelves", preview: "Task in IT planning · due 30.10." });
  const hidden = harness.addElement({ id: "old-case", title: "Old case", readable: false });
  harness.receiveShared(chat, nora, "Here is the task:", [open]);
  harness.receiveShared(chat, nora, "And the old case:", [hidden]);
  harness.receiveShared(chat, tobias, "Guide at https://example.com/vpn", []);
  return { chat };
};

describe("Shared Cloud elements", () => {
  for (const [name, options] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`${name}: a card shows the element the reader may open, and only "not available" otherwise`, async () => {
      const { chat } = seed();
      const { page, errors } = await load(options, { chat });
      try {
        const card = page.locator(".k2b-message-row", { hasText: "Here is the task:" }).locator(".k2b-resource-card");
        await card.getByText("Delivery cooling shelves", { exact: true }).waitFor();
        expect(await card.getAttribute("href")).toBe("/app/spaces/task/cooling");
        const hidden = page.locator(".k2b-message-row", { hasText: "And the old case:" }).locator(".k2b-resource-card");
        await page.locator('.k2b-resource-card[data-state="no_access"]').waitFor();
        await until(() => harness.readerCalls() >= 2);
        // Without access, nothing of the element shows: no title, no place.
        expect(await hidden.innerText()).not.toContain("Old case");
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("the composer shares an element from the picker; a message may be only the element", async () => {
    const chat = harness.addChat({ members: [viewer, nora], count: 3, end: new Date(chatTestNow.getTime() - 3_600_000) });
    harness.addElement({ id: "inventory", title: "Inventory hall 3", preview: "Event in Warehouse · Mon 27.10." });
    const { page, errors } = await load(desktop, { chat });
    try {
      await page.getByRole("button", { name: "Add to chat", exact: true }).click();
      await page.getByRole("menuitem", { name: "Share a Cloud element" }).click();
      await page.locator('input[role="combobox"]').fill("Inventory");
      await page.getByRole("option", { name: /Inventory hall 3/ }).click();
      await page.locator(".k2b-chat-composer").getByText("Inventory hall 3").waitFor();
      await page.keyboard.press("Enter");
      await until(() => harness.posted.some((post) => post.refs?.length === 1));
      expect(harness.posted.at(-1)).toMatchObject({ body: "", refs: [{ type: "spaces.task", id: "inventory" }] });
      // The sent message shows the card at once and keeps it once stored.
      await page.locator(".k2b-message-row[data-own] .k2b-resource-card").getByText("Inventory hall 3", { exact: true }).waitFor();
      expect(await page.locator(".k2b-chat-composer").getByText("Inventory hall 3").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});

describe("Shared in the chat's info", () => {
  test("lists links and elements newest first, filters by kind, and a row jumps to its message", async () => {
    const { chat } = seed();
    const { page, errors } = await load(desktop, { chat, panel: "info" });
    try {
      const section = page.locator("#k2b-workspace-detail-chat-info .chat-shared");
      const rows = section.locator(".chat-shared__row");
      await rows.first().waitFor();
      expect(await rows.locator(".chat-shared__title").allInnerTexts()).toEqual([
        "example.com/vpn",
        "Element not available",
        "Delivery cooling shelves",
      ]);
      expect(await rows.nth(1).locator(".chat-shared__meta").innerText()).toContain("No access");
      await section.getByRole("button", { name: "Links", exact: true }).click();
      await section.locator(".chat-shared__row", { hasText: "Delivery cooling shelves" }).waitFor({ state: "detached" });
      expect(await rows.count()).toBe(1);
      await section.getByRole("button", { name: "Images", exact: true }).click();
      await section.getByText("Nothing for this filter.", { exact: true }).waitFor();
      await section.getByRole("button", { name: "All", exact: true }).click();
      await section.locator(".chat-shared__row", { hasText: "Delivery cooling shelves" }).click();
      await page.locator(".k2b-virtual-feed__item[data-highlighted]", { hasText: "Here is the task:" }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("an empty chat says nothing was shared; a failure offers Try again", async () => {
    const chat = harness.addChat({ members: [viewer, nora], count: 2, end: new Date(chatTestNow.getTime() - 3_600_000) });
    harness.failShared();
    const { page, errors } = await load(desktop, { chat, panel: "info" });
    try {
      const section = page.locator("#k2b-workspace-detail-chat-info .chat-shared");
      await section.getByText("Shared items could not be loaded.").waitFor();
      await section.getByRole("button", { name: "Try again", exact: true }).click();
      await section.getByText("Nothing shared yet.", { exact: true }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
