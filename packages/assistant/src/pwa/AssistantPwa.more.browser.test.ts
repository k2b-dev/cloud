import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled, viewTransitionEnded } from "../../../ui/test/browser";
import { pinAssistantPwaClock, startAssistantPwaHarness } from "./AssistantPwa.browser-fixture";

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
  await page.addInitScript(pinAssistantPwaClock, Date.parse("2026-11-04T09:41:00.000Z"));
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
const field = (page: Page) => page.locator("textarea[aria-label]:visible");
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
      await page.waitForURL(/\/pwa\/assistant\/chats\?q=Gardinen$/);
      await page.getByRole("button", { name: "Suche leeren" }).click();
      await page.locator(".assistant-pwa-all-chats .assistant-pwa-row").first().waitFor();
      await page.waitForURL(/\/pwa\/assistant\/chats$/);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("Reload when search results appear and Back keep the same search", async () => {
    const page = await open("screen=start");
    try {
      await page.click("a[href='/pwa/assistant/chats']");
      await page.locator(".assistant-pwa-all-chats .assistant-pwa-row").first().waitFor();
      // Reload at the observable result, before another task can commit a deferred history update.
      await page.evaluate(() => {
        const list = document.querySelector(".assistant-pwa-all-chats")!;
        const observer = new MutationObserver(() => {
          if (!list.querySelector("h2")?.textContent?.includes("Treffer")) return;
          observer.disconnect();
          sessionStorage.setItem(
            "search-result-rows",
            JSON.stringify([...list.querySelectorAll(".assistant-pwa-row")].map((row) => row.textContent)),
          );
          location.reload();
        });
        observer.observe(list, { childList: true, subtree: true, characterData: true });
      });
      await Promise.all([page.waitForEvent("load"), page.fill("input[type=search]", "samt")]);
      await page.waitForSelector("body[data-ready]", { state: "attached" });
      expect(await page.locator("input[type=search]").inputValue()).toBe("samt");
      expect(page.url()).toMatch(/\/pwa\/assistant\/chats\?q=samt$/);
      await page.locator(".assistant-pwa-all-chats h2", { hasText: "Treffer" }).waitFor();
      const results = await page.evaluate(() => sessionStorage.getItem("search-result-rows"));
      expect(results).toBe(JSON.stringify(await page.locator(".assistant-pwa-all-chats .assistant-pwa-row").allTextContents()));
      await page.locator(".assistant-pwa-all-chats .assistant-pwa-row").first().click();
      await page.waitForURL(/\/pwa\/assistant\/c\//);
      await viewTransitionEnded(page);
      await page.goBack();
      await page.waitForURL(/\/pwa\/assistant\/chats\?q=samt$/);
      await page.waitForFunction(() => document.querySelector<HTMLInputElement>("input[type=search]")?.value === "samt");
      await page.locator(".assistant-pwa-all-chats h2", { hasText: "Treffer" }).waitFor();
      expect(results).toBe(JSON.stringify(await page.locator(".assistant-pwa-all-chats .assistant-pwa-row").allTextContents()));
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("opened in place, the list loads its next page when its end comes into view", async () => {
    const page = await open("screen=start");
    try {
      await page.click("a[href='/pwa/assistant/chats']");
      const end = page.locator(".assistant-pwa-more");
      await end.waitFor();
      const reads = async () => (await requests(page)).filter((request) => request === "GET /api/ai/conversations/page").length;
      const before = await reads();
      await end.scrollIntoViewIfNeeded();
      await page.waitForFunction(
        (count) =>
          (window as unknown as { harness: Harness }).harness.requests.filter((request) => request === "GET /api/ai/conversations/page")
            .length > count,
        before,
      );
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("offline the list stays readable and the reserved line says why searching waits, without moving the list", async () => {
    const online = await open("screen=all");
    const offline = await open("screen=all-offline");
    try {
      const firstRow = async (page: Page) => {
        await settled(page);
        return (await page.locator(".assistant-pwa-all-chats .assistant-pwa-row").first().boundingBox())!.y;
      };
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
      await page.getByText("„Messe Köln: Standplan“ archiviert.").first().waitFor();
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

describe("A recording in the Cloud app", () => {
  const send = (page: Page) => page.locator("button.k2b-chat-composer__send:visible");
  const hint = (page: Page) => page.locator(".k2b-chat-composer__hint:visible");

  test("records above the field without moving it, waits with Send, and takes the text after the field's text", async () => {
    const page = await open("screen=chat-x&chat=pflege&record=1");
    try {
      await field(page).fill("Mach daraus eine Karte für A6 und");
      await settled(page);
      const before = (await field(page).boundingBox())!;
      await page.getByRole("button", { name: "Diktieren" }).click();
      await page.locator(".assistant-pwa-recording .assistant-recording-footer").waitFor();
      expect(await hint(page).textContent()).toContain("Aufnahme läuft. Erst stoppen, dann senden.");
      expect(await send(page).isDisabled()).toBe(true);
      // The live microphone steps aside, and the bar takes its row above the field: the field stays where it was.
      expect(await page.getByRole("button", { name: "Diktieren" }).count()).toBe(0);
      expect((await field(page).boundingBox())!.y).toBe(before.y);

      await page.getByRole("button", { name: "Aufnahme stoppen" }).click();
      await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea[aria-label]")?.value.includes("Verschick"));
      expect(await field(page).inputValue()).toBe("Mach daraus eine Karte für A6 und\n\nVerschick sie an alle.");
      // The field's text became the saved draft first; the recording's text was inserted after it.
      const order = (await requests(page)).filter((request) => /\/(draft|dictations|apply)$/.test(request) && request.startsWith("P"));
      expect(order).toEqual([
        "POST /api/ai/conversations/pflege/dictations",
        "PUT /api/ai/conversations/pflege/draft",
        "POST /api/ai/conversations/pflege/dictations/d1/apply",
      ]);
      expect(await page.locator(".assistant-pwa-recording").count()).toBe(0);
      expect(await send(page).isDisabled()).toBe(false);
      // The device keeps the field with the recording's text.
      expect(await page.evaluate(() => JSON.stringify(localStorage))).toContain("Verschick sie an alle.");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("an insertion whose answer got lost takes the recording's text on Try again, without saving the field over it", async () => {
    const page = await open("screen=chat-x&chat=pflege&record=1&apply=lost");
    try {
      await field(page).fill("Mach daraus eine Karte für A6 und");
      await page.getByRole("button", { name: "Diktieren" }).click();
      await page.getByRole("button", { name: "Aufnahme stoppen" }).click();
      const problem = page.locator(".assistant-pwa-recording [role=alert]");
      await problem.waitFor();
      expect(await problem.textContent()).toContain("Das Diktat konnte nicht eingefügt werden.");
      await page.locator(".assistant-pwa-recording button").first().click();
      await page.getByRole("menuitem", { name: "Erneut versuchen" }).click();
      await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea[aria-label]")?.value.includes("Verschick"));
      expect(await field(page).inputValue()).toBe("Mach daraus eine Karte für A6 und\n\nVerschick sie an alle.");
      expect((await requests(page)).filter((request) => request === "PUT /api/ai/conversations/pflege/draft")).toHaveLength(1);
      await page.locator(".assistant-pwa-recording").waitFor({ state: "detached" });
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("while the recording becomes text Send waits; a failed one says so with Try again and Discard", async () => {
    const page = await open("screen=chat-x&chat=pflege&record=1&transcribe=hold");
    try {
      await page.getByRole("button", { name: "Diktieren" }).click();
      await page.getByRole("button", { name: "Aufnahme stoppen" }).click();
      await page.locator(".assistant-pwa-recording", { hasText: "Wird transkribiert…" }).waitFor();
      expect(await hint(page).textContent()).toContain("Die Aufnahme wird zu Text. Senden wartet darauf.");
      await field(page).fill("Noch etwas");
      expect(await send(page).isDisabled()).toBe(true);
    } finally {
      await page.context().close();
    }
    const failed = await open("screen=chat-x&chat=pflege&record=1&transcribe=fail");
    try {
      await failed.getByRole("button", { name: "Diktieren" }).click();
      await failed.getByRole("button", { name: "Aufnahme stoppen" }).click();
      const problem = failed.locator(".assistant-pwa-recording [role=alert]");
      await problem.waitFor();
      expect(await problem.textContent()).toBe(
        "Die Transkription ist fehlgeschlagen. Du kannst sie erneut versuchen oder die Aufnahme verwerfen.",
      );
      await failed.locator(".assistant-pwa-recording button").first().click();
      expect(await failed.getByRole("menuitem").allTextContents()).toEqual(["Erneut versuchen", "Diktat verwerfen"]);
      await failed.getByRole("menuitem", { name: "Diktat verwerfen" }).click();
      await failed.locator(".assistant-pwa-recording").waitFor({ state: "detached" });
      // Without a recording on the way, sending works again.
      await field(failed).fill("Ohne Aufnahme");
      expect(await send(failed).isDisabled()).toBe(false);
    } finally {
      await failed.context().close();
    }
  }, 30_000);
});

describe("Code in the Cloud app", () => {
  test("a submitted Code version shows its card with what it calls, and a question is answered on the phone", async () => {
    const page = await open("screen=chat-x&chat=pflege&code=1");
    try {
      const card = page.locator(".assistant-code-version");
      await card.waitFor();
      const text = await card.innerText();
      expect(text).toContain("Version 3 von „Rechnungen ablegen“ ist fertig.");
      expect(text).toContain("Was diese Version aufruft");
      expect(await card.locator(".assistant-code-version__target").allInnerTexts()).toEqual([
        expect.stringContaining("an Ordner fo_rechnungen"),
        expect.stringContaining("wo der Code es beim Lauf wählt"),
      ]);
      // A phone cannot switch on; the card says where it works instead of hiding the version.
      expect(text).toContain("Am Telefon lässt sich nicht einschalten.");
      expect(await card.getByRole("button", { name: "Einschalten" }).isDisabled()).toBe(true);
      // Nothing on the card is wider than the phone.
      expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

      await page.getByPlaceholder("Ordnername").fill("Rechnungen 2026");
      await page.getByRole("button", { name: "Antworten" }).click();
      await page.waitForFunction(() =>
        (window as unknown as { harness: Harness }).harness.requests.some((request) => request.includes("/turns/turn-c/actions/survey")),
      );
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
