import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { chatTestNow, nora, startChatHarness, viewer } from "./ChatWorkspace.browser-fixture";

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
/** One transparent pixel. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 5_000; // real clock: bounds the wait for the in-memory server
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time"); // real clock: bounds the wait
    await Bun.sleep(20);
  }
};
const load = async (options: BrowserContextOptions, chat: string) => {
  const context = await browser.newContext(options);
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
/** Pastes files into the composer's field, as a person pasting from the clipboard. */
const paste = (page: Page, files: { name: string; type: string; base64?: string; text?: string }[]) =>
  page.locator(".k2b-chat-composer textarea:not([aria-hidden])").evaluate((field, list) => {
    const data = new DataTransfer();
    for (const file of list) {
      const bytes = file.base64
        ? Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0))
        : new TextEncoder().encode(file.text ?? "");
      data.items.add(new File([bytes], file.name, { type: file.type }));
    }
    field.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, files);

describe("Chat attachments", () => {
  for (const [name, options] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`${name}: pasted files upload, a failed one is retried, and the message shows the image and the document`, async () => {
      const chat = harness.addChat({ members: [viewer, nora], count: 2, end: new Date(chatTestNow.getTime() - 3_600_000) });
      const { page, errors } = await load(options, chat);
      try {
        harness.failUploads(1);
        await paste(page, [
          { name: "lager.png", type: "image/png", base64: PIXEL },
          { name: "Raumplan.pdf", type: "application/pdf", text: "%PDF-1.4 plan" },
        ]);
        const composer = page.locator(".k2b-chat-composer");
        await composer.getByText("lager.png").waitFor();
        await composer.getByText("Raumplan.pdf").waitFor();
        // The first upload failed: its chip offers "Try again", and sending waits.
        const retry = composer.getByRole("button", { name: "Try again" });
        await retry.waitFor();
        await page.locator(".k2b-chat-composer textarea:not([aria-hidden])").fill("Here is the plan");
        await page.getByRole("button", { name: "Send message" }).click();
        await page.locator(".k2b-toast", { hasText: "A file could not be uploaded. Try again or remove it." }).waitFor();
        expect(await page.locator(".k2b-chat-composer textarea:not([aria-hidden])").inputValue()).toBe("Here is the plan");
        expect(harness.posted).toEqual([]);
        await retry.click();
        await retry.waitFor({ state: "detached" });
        // The notice can cover the send button; it leaves on its own.
        await page.locator(".k2b-toast", { hasText: "A file could not be uploaded." }).waitFor({ state: "detached", timeout: 15_000 });
        await page.getByRole("button", { name: "Send message" }).click();
        await until(() => harness.posted.length === 1);
        // Both uploads ran at once; whichever failed first got the later ID when it was tried again.
        expect(harness.posted[0]?.body).toBe("Here is the plan");
        expect([...(harness.posted[0]?.attachments ?? [])].sort()).toEqual(["A00001", "A00002"]);
        const row = page.locator(".k2b-message-row[data-own]", { hasText: "Here is the plan" });
        // The live copy can arrive before the send's answer and show beside it for a moment (#1911); wait for one row.
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll(".k2b-message-row[data-own]")].filter((row) => row.textContent?.includes("Here is the plan"))
              .length === 1,
        );
        // The image reserves its area from the stored size; the document names its kind and size.
        const image = row.getByRole("button", { name: "lager.png", exact: true });
        await image.waitFor();
        const box = await image.boundingBox();
        expect(box && Math.round((box.width / box.height) * 100)).toBe(133);
        await row.getByText("Raumplan.pdf").waitFor();
        await row.getByText(/^PDF · \d+ B$/).waitFor();
        expect(await composer.getByText("lager.png").count()).toBe(0);
        // An image opens large with "Save to Files" beside "Download".
        await image.click();
        const dialog = page.locator("dialog[open]");
        await dialog.waitFor();
        await dialog.getByRole("button", { name: /Save/ }).waitFor();
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("removing an uploaded file discards it on the server; a rejected send keeps the upload and its retry", async () => {
    const chat = harness.addChat({ members: [viewer, nora], count: 2, end: new Date(chatTestNow.getTime() - 3_600_000) });
    const { page, errors } = await load(desktop, chat);
    try {
      await paste(page, [{ name: "notes.txt", type: "text/plain", text: "notes" }]);
      const composer = page.locator(".k2b-chat-composer");
      await composer.getByText("notes.txt").waitFor();
      // The chip shows a spinner while it uploads; the stored upload is what removing discards.
      await composer.locator(".animate-spin").waitFor({ state: "detached" });
      await composer.getByRole("button", { name: /Remove notes\.txt/ }).click();
      await until(() => harness.discarded.length === 1);
      expect(harness.discarded).toEqual(["A00001"]);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("Shared lists images as a grid and documents as rows, each opening its message", async () => {
    const chat = harness.addChat({ members: [viewer, nora], count: 2, end: new Date(chatTestNow.getTime() - 3_600_000) });
    const { page, errors } = await load(desktop, chat);
    try {
      await paste(page, [
        { name: "lager.png", type: "image/png", base64: PIXEL },
        { name: "Raumplan.pdf", type: "application/pdf", text: "%PDF-1.4 plan" },
      ]);
      await page.locator(".k2b-chat-composer").getByText("Raumplan.pdf").waitFor();
      await page.getByRole("button", { name: "Send message" }).click();
      await until(() => harness.posted.length === 1);
      await page
        .getByRole("link", { name: /Chat info/ })
        .first()
        .click();
      const panel = page.locator(".chat-shared");
      await panel.getByRole("button", { name: "Images" }).click();
      const grid = panel.locator(".chat-shared__grid");
      await grid.locator(".chat-shared__thumb").first().waitFor();
      expect(await grid.locator(".chat-shared__thumb").count()).toBe(1);
      await panel.getByRole("button", { name: "Documents" }).click();
      await panel.locator(".chat-shared__row", { hasText: "Raumplan.pdf" }).waitFor();
      expect(await panel.locator(".chat-shared__row").count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
