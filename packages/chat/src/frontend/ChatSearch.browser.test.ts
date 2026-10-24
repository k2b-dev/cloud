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
const load = async (options: BrowserContextOptions, address: { chat?: string } = {}) => {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(new URL(address.chat ? `/app/chat/c/${address.chat}` : "/app/chat", harness.url).href);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(({ props }) => window.mountChat(props, "en"), { props: harness.props(address) });
  await page.locator(".chat-workspace").waitFor();
  await settled(page);
  return { page, errors };
};
const list = (page: Page, mobile: boolean) => page.locator(mobile ? ".chat-list-page" : ".k2b-app-workspace__sidebar");
const minutesAgo = (minutes: number) => new Date(chatTestNow.getTime() - minutes * 60_000);
/** IT with a "Printer problems" thread, Purchasing, and the Space "Spring fair" with the task "Print posters". */
const seed = () => {
  const it = harness.addChat({ members: [viewer, nora, tobias], name: "IT", count: 2, end: minutesAgo(30) });
  const printer = harness.addThread(it, { name: "Printer problems", count: 1, end: minutesAgo(20) });
  harness.addChat({ members: [viewer, nora], name: "Purchasing", count: 1, end: minutesAgo(60) });
  const fair = harness.addChat({ members: [viewer, nora], name: "Spring fair", count: 1, end: minutesAgo(90) });
  harness.setSystem(fair, { type: "spaces.space", id: "Space1" });
  const posters = harness.addThread(fair, { name: "Print posters", count: 1, end: minutesAgo(10) });
  harness.resourceThread(fair, posters, {
    ref: { type: "spaces.item", id: "Item01" },
    kind: "task",
    status: "Open",
    done: false,
    href: "/app/spaces/items/Item01",
  });
  return { it, printer, fair, posters };
};

describe("Search in the chat list", () => {
  for (const [name, options, mobile] of [
    ["desktop", desktop, false],
    ["phone", phone, true],
  ] as const) {
    test(`${name}: typing replaces the list with hits that say what they are; a thread hit opens its thread`, async () => {
      const { it, printer } = seed();
      const { page, errors } = await load(options);
      try {
        const field = list(page, mobile).getByRole("searchbox", { name: "Search" });
        await field.fill("print");
        const results = list(page, mobile).locator(".chat-search");
        await results.getByText("Thread in IT").waitFor();
        await results.getByText("Task in Spring fair").waitFor();
        // The list itself is gone while searching.
        expect(await list(page, mobile).getByText("New chat").count()).toBe(0);
        expect(harness.searchQueries.at(-1)).toBe("print");
        await results.getByRole("link", { name: /Printer problems/ }).click();
        await page.waitForURL(`**/app/chat/c/${it}/t/${printer}`);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("a chat hit is its ordinary row; nothing found says so; Escape brings the list back", async () => {
    seed();
    const { page, errors } = await load(desktop);
    try {
      const sidebar = list(page, false);
      const field = sidebar.getByRole("searchbox", { name: "Search" });
      await field.fill("purch");
      await sidebar
        .locator(".chat-search")
        .getByRole("link", { name: /Purchasing/ })
        .waitFor();
      await field.fill("zebra");
      await sidebar.getByText("Nothing found for “zebra”.").waitFor();
      await field.press("Escape");
      await sidebar.getByText("New chat").waitFor();
      expect(await field.inputValue()).toBe("");
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("when Spaces and Notebooks fail, the other hits stay with a line to try again; a failed search recovers", async () => {
    seed();
    harness.searchContainer({ type: "notebooks.notebook", id: "Book01" }, "Print shop notes");
    harness.failSearchSystem();
    const { page, errors } = await load(desktop);
    try {
      const sidebar = list(page, false);
      const search = sidebar.locator(".chat-search");
      await sidebar.getByRole("searchbox", { name: "Search" }).fill("print");
      await search.getByText("Search in Spaces and Notebooks failed.").waitFor();
      await search.getByText("Thread in IT").waitFor();
      harness.failSearchSystem(false);
      await search.getByRole("button", { name: "Try again" }).click();
      await search.getByText("Print shop notes").waitFor();
      expect(await search.getByText("Search in Spaces and Notebooks failed.").count()).toBe(0);
      harness.failSearch();
      await sidebar.getByRole("searchbox", { name: "Search" }).fill("printe");
      await search.getByText("Search failed. Try again.").waitFor();
      await search.getByRole("button", { name: "Try again" }).click();
      await search.getByText("Thread in IT").waitFor();
      expect(errors.filter((error) => !error.includes("503"))).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("opening an item thread from the search unfolds “Spaces and Notebooks”", async () => {
    const { fair, posters } = seed();
    const { page, errors } = await load(desktop);
    try {
      const sidebar = list(page, false);
      await sidebar.getByRole("button", { name: /Spaces and Notebooks/, expanded: false }).waitFor();
      await sidebar.getByRole("searchbox", { name: "Search" }).fill("posters");
      await sidebar
        .locator(".chat-search")
        .getByRole("link", { name: /Print posters/ })
        .click();
      await page.waitForURL(`**/app/chat/c/${fair}/t/${posters}`);
      await sidebar.getByRole("searchbox", { name: "Search" }).press("Escape");
      await sidebar.getByRole("button", { name: /Spaces and Notebooks/, expanded: true }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
