import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";
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
    if (Date.now() > deadline) throw new Error("Condition not met in time"); // real clock: bounds the wait
    await Bun.sleep(20);
  }
};
const load = async (options: BrowserContextOptions, address: { chat?: string; forYouPage?: boolean }) => {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const path = address.forYouPage ? "/app/chat/for-you" : address.chat ? `/app/chat/c/${address.chat}` : "/app/chat";
  await page.goto(new URL(path, harness.url).href);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(({ props }) => window.mountChat(props, "en"), { props: harness.props(address) });
  await page.locator(".chat-workspace").waitFor();
  await settled(page);
  return { page, errors };
};
/** Nora mentioned the reader in IT's "Problems" thread; Tobias answered them in General of a chat. */
const seed = () => {
  const it = harness.addChat({ members: [viewer, nora, tobias], name: "IT", count: 3, end: new Date(chatTestNow.getTime() - 3_600_000) });
  const item = (
    kind: "mention" | "reply",
    author: typeof nora,
    thread: { id: string; name: string },
    unread: boolean,
    minutes: number,
  ) => ({
    kind,
    conversation: { id: it, title: "IT", kind: "chat" as const },
    thread,
    message: {
      id: `msg${String(minutes).padStart(7, "0")}`,
      seq: minutes,
      author: { type: "user" as const, id: author.id, name: author.name },
      preview: "Can you look at it?",
      createdAt: new Date(chatTestNow.getTime() - minutes * 60_000).toISOString(),
    },
    unread,
  });
  harness.setForYou([
    item("mention", nora, { id: "general", name: "General" }, true, 5),
    item("reply", tobias, { id: "general", name: "General" }, false, 50),
  ]);
  return { it };
};
const forYouRow = (page: Page) =>
  page
    .getByRole("link", { name: /For you/ })
    .filter({ visible: true })
    .first();

describe("For you", () => {
  for (const [name, options] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`${name}: the list counts unread mentions and replies; the page lists them, newest first, and a row opens its message`, async () => {
      seed();
      const { page, errors } = await load(options, {});
      try {
        expect(await forYouRow(page).innerText()).toContain("1");
        await forYouRow(page).click();
        await page.waitForURL("**/app/chat/for-you");
        const section = page.getByRole("region", { name: "For you" });
        await section.getByText("Mentions and replies to you, from all apps").waitFor();
        const rows = section.locator(".chat-for-you__row");
        await rows.first().waitFor();
        expect(await rows.locator(".chat-for-you__title").allInnerTexts()).toEqual(["Nora mentioned you", "Tobias replied to you"]);
        expect(await rows.nth(0).getAttribute("data-unread")).toBe("");
        expect(await rows.nth(1).getAttribute("data-unread")).toBeNull();
        // A read row keeps the count's place, so rows line up and nothing moves when one is read.
        const counts = await rows
          .locator(".chat-for-you__count")
          .evaluateAll((spans) => spans.map((span) => span.getBoundingClientRect().width));
        expect(counts[0]).toBe(counts[1]);
        await rows.nth(0).click();
        await page.waitForURL("**/app/chat/c/**");
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("loads from its address, recovers from an error, says when there is nothing, and follows the live hint", async () => {
    harness.failForYou(2);
    const { page, errors } = await load(desktop, { forYouPage: true });
    try {
      const section = page.getByRole("region", { name: "For you" });
      await section.getByText("“For you” could not be loaded.").waitFor();
      await section.getByRole("button", { name: "Try again" }).click();
      await section.getByText("“For you” could not be loaded.").waitFor();
      await section.getByRole("button", { name: "Try again" }).click();
      await section.getByText("Nothing for you yet.").waitFor();
      // A new mention arrives: the count and the page follow without a reload.
      seed();
      harness.setForYou(
        [
          {
            kind: "mention",
            conversation: { id: "zzzzzz", title: "Lindenhof", kind: "chat" },
            thread: { id: "Thr001", name: "Accounting" },
            message: {
              id: "msg9999999",
              seq: 9,
              author: { type: "user", id: nora.id, name: nora.name },
              preview: "@you please approve",
              createdAt: chatTestNow.toISOString(),
            },
            unread: true,
          },
        ],
        true,
      );
      await section.getByText("Accounting · Lindenhof").waitFor();
      expect(await forYouRow(page).innerText()).toContain("1");
      expect(errors.filter((error) => !error.includes("503"))).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a mention in a Space's chat opens there and unfolds “Spaces and Notebooks”", async () => {
    const space = harness.addChat({ members: [viewer, nora], name: "Spring fair", count: 2, end: chatTestNow });
    harness.setSystem(space, { type: "spaces.space", id: "Space1" });
    harness.setForYou([
      {
        kind: "mention",
        conversation: { id: space, title: "Spring fair", kind: "system" },
        thread: { id: "general", name: "General" },
        message: {
          id: "msg0000001",
          seq: 1,
          author: { type: "user", id: nora.id, name: nora.name },
          preview: "@you the poster",
          createdAt: chatTestNow.toISOString(),
        },
        unread: true,
      },
    ]);
    const { page, errors } = await load(desktop, { forYouPage: true });
    try {
      const sidebar = page.locator(".k2b-app-workspace__sidebar");
      await sidebar.getByRole("button", { name: /Spaces and Notebooks/, expanded: false }).waitFor();
      await page.getByRole("region", { name: "For you" }).locator(".chat-for-you__row").first().click();
      await page.waitForURL(`**/app/chat/c/${space}**`);
      await sidebar.getByRole("button", { name: /Spaces and Notebooks/, expanded: true }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("@ in the composer suggests members and sends the mention with the person's identity", async () => {
    const { it } = seed();
    const { page, errors } = await load(desktop, { chat: it });
    try {
      const field = page.getByRole("textbox", { name: "Message to IT" });
      await field.click();
      await page.keyboard.type("Hi @no");
      const list = page.getByRole("listbox", { name: "People" });
      await list.getByRole("option", { name: /Nora/ }).waitFor();
      await page.keyboard.press("Enter");
      await page.keyboard.type("can you check?");
      await page.keyboard.press("Enter");
      await until(() => harness.posted.length === 1);
      const sent = harness.posted[0]!;
      expect(sent.body).toBe(`Hi @${nora.name} can you check?`);
      expect(sent.mentions).toEqual([{ start: 3, end: 4 + nora.name.length, principal: { type: "user", id: nora.id } }]);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
