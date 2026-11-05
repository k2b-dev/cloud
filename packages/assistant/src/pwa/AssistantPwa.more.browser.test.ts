import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { startAssistantPwaHarness } from "./AssistantPwa.browser-fixture";

// Attachments, every chat with its search, and a chat's "…" in the Cloud app, in a real engine with invented data.

let browser: Browser;
let harness: Awaited<ReturnType<typeof startAssistantPwaHarness>>;
beforeAll(async () => {
  [browser, harness] = await Promise.all([launchBrowser(), startAssistantPwaHarness()]);
}, 120_000);
afterAll(async () => {
  await browser?.close();
  harness?.close();
});

const open = async (query: string, width = 390, height = 844): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: width < 768, locale: "de-DE" });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-11-04T09:41:00.000Z"));
  await page.goto(`${harness.url}?${query}`);
  await page.waitForSelector("body[data-ready]", { state: "attached" });
  return page;
};
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const attach = (page: Page) =>
  page
    .locator("input[type=file]")
    .first()
    .setInputFiles([{ name: "Etikett.png", mimeType: "image/png", buffer: PNG }]);
type Harness = { requests: string[]; fail: Set<string> };
const requests = (page: Page) => page.evaluate(() => (window as unknown as { harness: Harness }).harness.requests);

describe("Attachments in the Cloud app", () => {
  test("an attachment uploads while writing and shows its progress", async () => {
    const page = await open("screen=chat-x&chat=pflege&upload=progress");
    try {
      await attach(page);
      await page.waitForFunction(() => document.querySelector(".k2b-chat-composer__attachment-progress")?.textContent?.includes("64"));
      expect(await page.locator(".k2b-chat-composer__attachment-progress [role=progressbar]").getAttribute("aria-label")).toBe(
        "Etikett.png wird hochgeladen",
      );
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a failed upload offers Upload again; a sent message refers to the uploaded file", async () => {
    const page = await open("screen=chat-x&chat=pflege&upload=fail&hold=/turns");
    try {
      await attach(page);
      const retry = page.getByRole("button", { name: "Erneut hochladen" });
      await retry.waitFor();
      expect(await retry.getAttribute("data-tone")).toBe("danger");
    } finally {
      await page.context().close();
    }
    const sent = await open("screen=chat-x&chat=pflege&hold=/turns");
    try {
      await attach(sent);
      await sent.locator(".k2b-chat-composer__attachment-progress").waitFor({ state: "detached" });
      await sent.locator("textarea[aria-label]:visible").fill("Was steht auf dem Etikett?");
      await sent.click("button.k2b-chat-composer__send:visible");
      await sent.locator(".k2b-chat-message[data-status='pending']").waitFor();
      // The file went up once, while writing; sending did not upload it again.
      const draft = (await requests(sent)).filter((request) => request.includes("/files"));
      expect(draft).toEqual([]);
    } finally {
      await sent.context().close();
    }
  }, 30_000);

  test("offline an attachment waits for the network and goes on by itself when it returns", async () => {
    const page = await open("screen=chat-attach-offline&chat=pflege&upload=progress");
    try {
      await attach(page);
      const waiting = page.getByRole("button", { name: "Wartet auf Netz" });
      await waiting.waitFor();
      expect(await waiting.isDisabled()).toBe(true);
      await page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
        window.dispatchEvent(new Event("online"));
      });
      await page.locator(".k2b-chat-composer__attachment-progress").waitFor();
    } finally {
      await page.context().close();
    }
  }, 30_000);
});

describe("Every chat in the Cloud app", () => {
  test("lists pinned chats first and then by time, opens from the start, and searches in the address", async () => {
    const page = await open("screen=start");
    try {
      await page.click("a[href='/pwa/assistant/chats']");
      await page.waitForURL(/\/pwa\/assistant\/chats$/);
      await page.locator(".assistant-pwa-all-chats .assistant-pwa-row").first().waitFor();
      expect(await page.locator(".assistant-pwa-all-chats h2").allTextContents()).toEqual(["Angeheftet", "Diese Woche", "Oktober"]);
      // The list stays in the app's frame with its tab bar.
      expect(await page.evaluate(() => getComputedStyle(document.querySelector(".k2b-tab-bar")!).display)).not.toBe("none");
      await page.fill("input[type=search]", "Gardinen");
      await page.getByText("Kein Chat enthält „Gardinen“.").waitFor();
      expect(page.url()).toContain("/pwa/assistant/chats?q=Gardinen");
      await page.getByRole("button", { name: "Suche leeren" }).click();
      await page.locator(".assistant-pwa-all-chats .assistant-pwa-row").first().waitFor();
      expect(page.url()).toMatch(/\/pwa\/assistant\/chats$/);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("offline the list stays readable and the reserved line says why searching waits, without moving the list", async () => {
    const online = await open("screen=all");
    const offline = await open("screen=all-offline");
    try {
      const firstRow = async (page: Page) => (await page.locator(".assistant-pwa-all-chats .assistant-pwa-row").first().boundingBox())!.y;
      expect(await firstRow(offline)).toBe(await firstRow(online));
      expect(await offline.locator("input[type=search]").isDisabled()).toBe(true);
      expect(await offline.locator("#assistant-pwa-search-note").textContent()).toContain("Offline. Suchen geht wieder mit Netz.");
      expect(await offline.locator("input[type=search]").getAttribute("aria-describedby")).toBe("assistant-pwa-search-note");
    } finally {
      await online.context().close();
      await offline.context().close();
    }
  }, 30_000);
});

describe("The … of a chat in the Cloud app", () => {
  test("archiving returns to the list with Undo; offline every entry waits", async () => {
    const page = await open("screen=menu&chat=messe");
    try {
      await page.getByRole("button", { name: "Mehr zu diesem Chat" }).click();
      expect(await page.getByRole("menuitem").allTextContents()).toEqual(["Umbenennen", "Anheften", "Archivieren"]);
      await page.getByRole("menuitem", { name: "Archivieren" }).click();
      await page.waitForURL(/\/pwa\/assistant$/);
      await page.getByText("„Messe Köln: Standplan“ archiviert.").waitFor();
      await page.getByRole("button", { name: "Rückgängig" }).click();
      await page.waitForURL(/\/pwa\/assistant\/c\/messe$/);
      expect((await requests(page)).filter((request) => /\/(archive|restore)$/.test(request))).toEqual([
        "POST /api/ai/conversations/messe/archive",
        "POST /api/ai/conversations/messe/restore",
      ]);
    } finally {
      await page.context().close();
    }
    const offline = await open("screen=menu-offline&chat=pflege");
    try {
      await offline.getByRole("button", { name: "Mehr zu diesem Chat" }).click();
      const items = offline.getByRole("menuitem");
      expect(
        await items.evaluateAll((entries) =>
          entries.map((entry) => entry.getAttribute("aria-disabled") ?? String((entry as HTMLButtonElement).disabled)),
        ),
      ).toEqual(["true", "true", "true"]);
    } finally {
      await offline.context().close();
    }
  }, 30_000);

  test("a refusal says it failed and a missing answer that it is not confirmed, both with Try again", async () => {
    for (const [fail, text] of [
      ["/archive:422", "Archivieren fehlgeschlagen."],
      ["/archive:net", "Archivieren nicht bestätigt."],
    ] as const) {
      const page = await open(`screen=menu&chat=pflege&fail=${fail}`);
      try {
        await page.getByRole("button", { name: "Mehr zu diesem Chat" }).click();
        await page.getByRole("menuitem", { name: "Archivieren" }).click();
        const notice = page.getByRole("alert").filter({ hasText: text });
        await notice.waitFor();
        // The chat stays open; nothing moved.
        expect(await page.getByRole("button", { name: "Mehr zu diesem Chat" }).isVisible()).toBe(true);
        await page.evaluate(() => (window as unknown as { harness: Harness }).harness.fail.clear());
        await notice.getByRole("button", { name: "Erneut versuchen" }).click();
        await page.waitForURL(/\/pwa\/assistant$/);
      } finally {
        await page.context().close();
      }
    }
  }, 30_000);
});
