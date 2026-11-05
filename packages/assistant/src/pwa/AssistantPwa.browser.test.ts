import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { startAssistantPwaHarness } from "./AssistantPwa.browser-fixture";

// Which columns stand side by side, where the field sits, and whether the tab bar steps aside are layout results of the
// shipped cascade, which happy-dom does not model. A real engine lays out the part in the Cloud app's frame with
// invented data and a replaced network.

let browser: Browser;
let harness: Awaited<ReturnType<typeof startAssistantPwaHarness>>;
beforeAll(async () => {
  [browser, harness] = await Promise.all([launchBrowser(), startAssistantPwaHarness()]);
}, 120_000);
afterAll(async () => {
  await browser?.close();
  harness?.close();
});

const PHONE = { width: 390, height: 844 };
const PORTRAIT = { width: 834, height: 1194 };
const LANDSCAPE = { width: 1194, height: 834 };

const open = async (query: string, size = PHONE): Promise<Page> => {
  const context = await browser.newContext({
    viewport: size,
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: size.width < 768,
    locale: "de-DE",
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-11-04T09:41:00.000Z"));
  await page.goto(`${harness.url}?${query}`);
  await page.waitForSelector("body[data-ready]", { state: "attached" });
  return page;
};
const field = (page: Page) => page.locator("textarea[aria-label]:visible");
const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;
const tabBarShown = (page: Page) => page.evaluate(() => getComputedStyle(document.querySelector(".k2b-tab-bar")!).display !== "none");

describe("The Assistant part on a phone", () => {
  test("the start lists recent chats above the field; a chat opens as a screen of its own and Back returns", async () => {
    const page = await open("screen=start");
    try {
      expect(await page.locator(".assistant-pwa-row").count()).toBe(6);
      expect(await field(page).count()).toBe(1);
      expect(await tabBarShown(page)).toBe(true);
      // The field sits right above the tab bar, with the field's own bottom padding between them.
      const tabs = await box(page, ".k2b-tab-bar");
      const composer = await box(page, ".assistant-pwa-start__composer");
      expect(tabs.y - (composer.y + composer.height)).toBeGreaterThanOrEqual(0);
      expect(tabs.y - (composer.y + composer.height)).toBeLessThanOrEqual(24);

      await page.click("a[href='/pwa/assistant/c/retro']");
      await page.waitForURL(/\/pwa\/assistant\/c\/retro$/);
      await page.locator(".k2b-chat-decision__card").waitFor();
      expect(await tabBarShown(page)).toBe(false);
      const chatComposer = await box(page, ".assistant-pwa-chat__composer");
      // Without the tab bar the field reaches down to the level's bottom padding.
      expect(chatComposer.y + chatComposer.height).toBeGreaterThan(PHONE.height - 24);

      await page.goBack();
      await page.waitForURL(/\/pwa\/assistant(\?|$)/);
      await page.locator(".assistant-pwa-row").first().waitFor();
      expect(await tabBarShown(page)).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("loading, a failed list and no chats keep the field where it is", async () => {
    const places: number[] = [];
    for (const query of ["screen=start", "screen=start-error", "screen=start-empty"]) {
      const page = await open(query);
      try {
        places.push((await box(page, ".assistant-pwa-start__composer textarea[aria-label]")).y);
        if (query === "screen=start-error") {
          expect(await page.getByText("Die Chats ließen sich nicht laden. Neu fragen kannst du trotzdem.").count()).toBe(1);
          await page.evaluate(() => (window as unknown as { harness: { hold: Set<string> } }).harness.hold.add("workspace/sidebar"));
          await page.click(".k2b-placeholder button");
          await page.locator("[aria-label='Chats werden geladen']").waitFor();
          places.push((await box(page, ".assistant-pwa-start__composer textarea[aria-label]")).y);
          await page.evaluate(() => (window as unknown as { harness: { release: () => void } }).harness.release());
          await page.locator(".assistant-pwa-row").first().waitFor();
          places.push((await box(page, ".assistant-pwa-start__composer textarea[aria-label]")).y);
        }
      } finally {
        await page.context().close();
      }
    }
    expect(new Set(places.map(Math.round)).size).toBe(1);
  }, 30_000);

  test("offline the field keeps its text and says why it cannot send; both answers of a question wait", async () => {
    const page = await open("screen=chat-approval-offline&chat=retro");
    try {
      await field(page).fill("Mach daraus die Karte für A6.");
      expect(await page.getByText("Offline. Senden geht wieder mit Netz.").count()).toBe(1);
      expect(await page.locator("button.k2b-chat-composer__send:visible").isDisabled()).toBe(true);
      expect(await field(page).inputValue()).toBe("Mach daraus die Karte für A6.");
      expect(
        await page
          .locator(".k2b-chat-decision__answer")
          .evaluateAll((buttons) => buttons.map((button) => (button as HTMLButtonElement).disabled)),
      ).toEqual([true, true]);
      expect(await page.locator(".k2b-chat-decision__reason").textContent()).toContain("Offline. Antworten geht wieder mit Netz.");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a message the server refuses stays in the chat with Send again, and the field is free", async () => {
    const page = await open("screen=chat-x&chat=pflege&fail=/turns:422");
    try {
      await field(page).fill("Mach daraus bitte die Karte für A6.");
      await page.click("button.k2b-chat-composer__send:visible");
      const failed = page.locator(".k2b-chat-message[data-status='error']");
      await failed.waitFor();
      expect(await failed.textContent()).toContain("Mach daraus bitte die Karte für A6.");
      expect(await field(page).inputValue()).toBe("");
      // Sending again goes through once the server takes it.
      await page.evaluate(() => (window as unknown as { harness: { fail: Set<string> } }).harness.fail.clear());
      await failed.getByRole("button", { name: "Erneut senden" }).click();
      await failed.waitFor({ state: "detached" });
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a new chat starts from the start's field on its own address", async () => {
    // The server holds the turn, so the message stands in the chat as it waits.
    const page = await open("screen=start&hold=/turns");
    try {
      await field(page).fill("Wie lange hält Samt im Schaufenster?");
      await page.click("button.k2b-chat-composer__send:visible");
      await page.waitForURL(/\/pwa\/assistant\/c\/neu-1$/);
      const message = page.locator(".k2b-chat-message[data-role='user']", { hasText: "Wie lange hält Samt im Schaufenster?" });
      await message.waitFor();
      expect(await message.getAttribute("data-status")).toBe("pending");
      expect(await tabBarShown(page)).toBe(false);
      const requests = await page.evaluate(() => (window as unknown as { harness: { requests: string[] } }).harness.requests);
      expect(requests).toContain("POST /api/ai/conversations");
      expect(requests.some((request) => request.startsWith("POST /api/ai/conversations/neu-1/turns"))).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("without an AI model only the field is locked and says why; chats stay readable", async () => {
    const page = await open("screen=noai-chat&chat=pflege");
    try {
      expect(await page.getByText("Kein KI-Modell eingerichtet.").count()).toBe(1);
      expect(await field(page).isDisabled()).toBe(true);
      expect(await page.getByText("Kurz gesagt: Samt nur trocken pflegen und nie reiben.").count()).toBe(1);
      expect(await page.getByRole("link", { name: "Einrichten" }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});

describe("The Assistant part on an iPad", () => {
  test("across, the list stands beside a new chat with one field; upright, one column with the field below", async () => {
    const across = await open("screen=start", LANDSCAPE);
    try {
      const list = await box(across, ".assistant-pwa-list");
      const fresh = await box(across, ".assistant-pwa-new__composer");
      expect(fresh.x).toBeGreaterThan(list.x + list.width - 1);
      expect(await field(across).count()).toBe(1);
    } finally {
      await across.context().close();
    }
    const upright = await open("screen=start", PORTRAIT);
    try {
      expect(await upright.locator(".assistant-pwa-new__composer:visible").count()).toBe(0);
      expect(await field(upright).count()).toBe(1);
      expect(await upright.locator(".assistant-pwa-start__composer textarea[aria-label]:visible").count()).toBe(1);
    } finally {
      await upright.context().close();
    }
  }, 30_000);

  test("a chat that does not exist names neither it nor its owner; beside the list there is no way back", async () => {
    for (const [size, backShown] of [
      [PHONE, true],
      [LANDSCAPE, false],
    ] as const) {
      const page = await open("screen=chat-noaccess", size);
      try {
        expect(await page.getByText("Diesen Chat gibt es nicht, oder er gehört jemand anderem.").count()).toBe(1);
        expect(await page.getByRole("button", { name: "Zurück zu den Chats" }).isVisible()).toBe(backShown);
      } finally {
        await page.context().close();
      }
    }
  }, 30_000);
});
