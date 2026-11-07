import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { chatTestNow, nora, startChatHarness, viewer } from "./ChatWorkspace.browser-fixture";

let harness: Awaited<ReturnType<typeof startChatHarness>>;
let browser: Browser;
beforeAll(async () => {
  harness = await startChatHarness();
  browser = await launchBrowser({ serveShellCatalog: true });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  harness?.stop();
});

beforeEach(() => harness.reset());

for (const width of [1440, 390]) {
  test(`a deferred form keeps its frame through loading, failed download and retry at ${width}px`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    let release = () => {};
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5_000);
      let first = true;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/NewChatDialog-*.js", async (route) => {
        if (!first) return route.continue();
        first = false;
        await pending;
        await route.fulfill({ status: 503, body: "Unavailable" });
      });
      await page.goto(harness.url);
      await page.evaluate((props) => window.mountChat(props, "en"), harness.props({}));
      await page.getByRole("button", { name: "New chat", exact: true }).filter({ visible: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("status").getByText("Loading…", { exact: true }).waitFor();
      await settled(page);
      const frame = await dialog.boundingBox();
      if (process.env.CHAT_SCREENSHOTS)
        await page.screenshot({ path: `${process.env.CHAT_SCREENSHOTS}/dialog-loading-light-${width}.png` });
      release();
      await dialog.getByRole("alert").waitFor();
      if (process.env.CHAT_SCREENSHOTS) await page.screenshot({ path: `${process.env.CHAT_SCREENSHOTS}/dialog-failed-light-${width}.png` });
      expect(await dialog.boundingBox()).toEqual(frame);
      await dialog.getByRole("button", { name: "Try again", exact: true }).click();
      await dialog.locator("input").first().waitFor();
      await settled(page);
      expect(await dialog.boundingBox()).toEqual(frame);
      if (process.env.CHAT_SCREENSHOTS) await page.screenshot({ path: `${process.env.CHAT_SCREENSHOTS}/dialog-ready-light-${width}.png` });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
    } finally {
      release();
      await context.close();
    }
  }, 30_000);
}

// A live hint can arrive after SSR while the first destination chunk is still downloading.
test("For you discards its SSR seed when a live hint arrives during the chunk download", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let release = () => {};
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/ForYou-*.js", async (route) => {
      await pending;
      await route.continue();
    });
    await page.goto(new URL("/app/chat/for-you", harness.url).href);
    await page.evaluate((props) => window.mountChat(props, "en"), harness.props({ forYouPage: true }));
    await page.getByRole("status").getByText("Loading…", { exact: true }).waitFor();
    harness.setForYou(
      [
        {
          kind: "mention",
          conversation: { id: "chat01", title: "Lindenhof", kind: "chat" },
          thread: { id: "Thr001", name: "Accounting" },
          message: {
            id: "msg9999999",
            seq: 9,
            author: { type: "user", id: nora.id, name: nora.name },
            preview: "Please approve",
            createdAt: chatTestNow.toISOString(),
          },
          unread: true,
        },
      ],
      true,
    );
    // The updated badge proves the workspace applied the live revision before the import resolves.
    await page
      .getByRole("link", { name: /For you/ })
      .filter({ visible: true })
      .first()
      .getByText("1", { exact: true })
      .waitFor();
    release();
    await page.getByText("Accounting · Lindenhof", { exact: true }).waitFor();
    expect(await page.getByText("Nothing for you yet.", { exact: true }).count()).toBe(0);
  } finally {
    release();
    await context.close();
  }
}, 30_000);

test("closing and reopening Info in the same chat preserves its member search", async () => {
  const chat = harness.addChat({ members: [viewer, nora], count: 8, end: harness.now() });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    await page.goto(new URL(`/app/chat/c/${chat}?panel=info`, harness.url).href);
    await page.evaluate((props) => window.mountChat(props, "en"), harness.props({ chat, panel: "info" }));
    const search = page.getByRole("searchbox", { name: "Search members", exact: true });
    await search.fill("Nora");
    await page.getByRole("button", { name: "Close chat info", exact: true }).click();
    await page.waitForURL(`**/c/${chat}`);
    await settled(page);
    await page.locator('.chat-conversation__header a[aria-controls="k2b-workspace-detail-chat-info"]').click();
    await search.waitFor();
    expect(await search.inputValue()).toBe("Nora");
  } finally {
    await context.close();
  }
}, 30_000);
