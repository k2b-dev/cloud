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

  test("while a message is not confirmed, the next one keeps its text and the hint offers to try again", async () => {
    const page = await open("screen=chat-x&chat=pflege&fail=/turns");
    try {
      await field(page).fill("Erste Nachricht");
      await page.click("button.k2b-chat-composer__send:visible");
      await page.getByText("Deine Nachricht ist nicht bestätigt.").waitFor();
      await field(page).fill("Zweite Nachricht");
      await page.click("button.k2b-chat-composer__send:visible");
      await page.waitForTimeout(300);
      expect(await field(page).inputValue()).toBe("Zweite Nachricht");
      const turns = await page.evaluate(
        () =>
          (window as unknown as { harness: { requests: string[] } }).harness.requests.filter((request) => request.endsWith("/turns"))
            .length,
      );
      expect(turns).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("each refused message keeps its own Send again, also after another one went through", async () => {
    const page = await open("screen=chat-x&chat=pflege&fail=/turns:422");
    try {
      for (const text of ["Erste Nachricht", "Zweite Nachricht"]) {
        await field(page).fill(text);
        await page.click("button.k2b-chat-composer__send:visible");
        await page.locator(".k2b-chat-message[data-status='error']", { hasText: text }).waitFor();
      }
      await page.evaluate(() => (window as unknown as { harness: { fail: Set<string>; hold: Set<string> } }).harness.fail.clear());
      await page.evaluate(() => (window as unknown as { harness: { hold: Set<string> } }).harness.hold.add("/turns"));
      await field(page).fill("Dritte Nachricht");
      await page.click("button.k2b-chat-composer__send:visible");
      await page.locator(".k2b-chat-message[data-status='pending']", { hasText: "Dritte Nachricht" }).waitFor();
      expect(await page.locator(".k2b-chat-message[data-status='error']").count()).toBe(2);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("Send again on a refused message keeps what the field holds now", async () => {
    const page = await open("screen=chat-x&chat=pflege&fail=/turns:422&hold=/viewed");
    try {
      await field(page).fill("Erste Nachricht");
      await page.click("button.k2b-chat-composer__send:visible");
      const failed = page.locator(".k2b-chat-message[data-status='error']", { hasText: "Erste Nachricht" });
      await failed.waitFor();
      await field(page).fill("Neuer Text");
      await page.evaluate(() => (window as unknown as { harness: { fail: Set<string> } }).harness.fail.clear());
      await failed.getByRole("button", { name: "Erneut senden" }).click();
      await failed.waitFor({ state: "detached" });
      expect(await field(page).inputValue()).toBe("Neuer Text");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a chat opened from the list fills the field with its saved draft once it has loaded", async () => {
    const page = await open("screen=start&serverDraft=1");
    try {
      await page.click("a[href='/pwa/assistant/c/messe']");
      await page.waitForFunction(
        () => document.querySelector<HTMLTextAreaElement>(".assistant-pwa-chat textarea[aria-label]")?.value === "Vom Web",
      );
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("what this device kept in the field wins over the chat's saved draft after a reload", async () => {
    const context = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true, locale: "de-DE" });
    await context.addInitScript(() => localStorage.setItem("cloud.pwa.draft:robin:assistant.composer%3Apflege", "Vom Gerät"));
    const page = await context.newPage();
    try {
      await page.goto(`${harness.url}?screen=chat-x&chat=pflege&serverDraft=1`);
      await page.waitForSelector("body[data-ready]", { state: "attached" });
      await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea[aria-label]")?.value === "Vom Gerät");
    } finally {
      await context.close();
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
