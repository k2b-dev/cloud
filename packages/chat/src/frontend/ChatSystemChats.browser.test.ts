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
const wide: BrowserContextOptions = { viewport: { width: 2000, height: 1000 } };
const until = async (condition: () => boolean) => {
  const end = performance.now() + 5_000;
  while (!condition()) {
    if (performance.now() > end) throw new Error("Fixture wait timed out");
    await Bun.sleep(20);
  }
};
const load = async (
  options: BrowserContextOptions,
  address: { chat?: string; thread?: string; threadsPage?: boolean; panel?: string; embedded?: boolean } = {},
  setup?: (page: Page) => Promise<void>,
) => {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  // Pin only Date: animation frames, input delays and read reporting keep their real timers.
  await page.addInitScript((timestamp) => {
    const RealDate = Date;
    class PinnedDate extends RealDate {
      constructor(...args: ConstructorParameters<DateConstructor> | []) {
        if (args.length === 0) super(timestamp);
        else super(...args);
      }
      static override now() {
        return timestamp;
      }
    }
    Object.defineProperty(globalThis, "Date", { value: PinnedDate, configurable: true, writable: true });
  }, chatTestNow.getTime());
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await setup?.(page);
    const basePath = address.embedded ? "/app/chat/panel" : "/app/chat";
    const path = address.chat
      ? `${basePath}/c/${address.chat}${address.threadsPage ? "/threads" : address.thread ? `/t/${address.thread}` : ""}${address.panel ? "?panel=info" : ""}`
      : basePath;
    await page.goto(new URL(path, harness.url).href);
    await page.evaluate(
      (props) => {
        document.documentElement.lang = "de";
        window.mountChat(props, "de");
      },
      { ...harness.props(address), embedded: address.embedded },
    );
    await page.locator(".chat-workspace").waitFor();
    await settled(page);
    return { page, errors };
  } catch (error) {
    await context.close();
    throw error;
  }
};
const list = (page: Page, mobile: boolean) => page.locator(mobile ? ".chat-list-page" : ".k2b-app-workspace__sidebar");
const seed = (permission: "admin" | "write" | "read" = "admin") => {
  const ref = { type: "spaces.space", id: "Space1" };
  const chat = harness.addChat({ members: [viewer, nora, tobias], name: "Frühlingsausstellung", count: 3, permission, end: chatTestNow });
  harness.setSystem(chat, ref);
  const names = [
    "Einladung freigeben",
    "Besichtigung",
    "Aufbau",
    "Transport",
    "Alte ungelesene Aufgabe",
    "Alte gelesene Aufgabe",
    "Offene ältere Aufgabe",
  ];
  const threads = names.map((name, index) => {
    const thread = harness.addThread(chat, {
      name,
      description: "Item description",
      count: 1,
      unread: index === 4 ? 1 : 0,
      end: new Date(chatTestNow.getTime() - index * 60_000),
    });
    harness.resourceThread(chat, thread, {
      ref: { type: "spaces.item", id: `Item0${index}` },
      kind: index === 1 ? "event" : "task",
      status: index === 0 ? "Erledigt" : "Offen",
      done: index === 0,
      deadline: index === 1 ? null : "2026-10-24T00:00:00.000Z",
      deadlineAllDay: true,
      assignees: ["Nora"],
      ...(index === 1 ? { startsAt: "2026-10-24T09:00:00.000Z", endsAt: "2026-10-24T10:00:00.000Z", allDay: false } : {}),
      href: `/app/spaces/items/Item0${index}`,
    });
    return thread;
  });
  harness.systemElement({ id: "Item99", title: "Neue Aufgabe", parent: ref });
  harness.systemElement({ id: "Else99", title: "Fremde Aufgabe", parent: { type: "spaces.space", id: "Other1" } });
  return { chat, ref, threads };
};

for (const [name, options, mobile] of [
  ["desktop", desktop, false],
  ["phone", phone, true],
] as const) {
  describe(`System chats on ${name}`, () => {
    test("section starts collapsed, counts reserve space, and opening uses the system endpoint and All threads", async () => {
      const { chat } = seed();
      harness.emptyContainer({ type: "notebooks.notebook", id: "Empty1" }, "Noch ohne Chat");
      const { page, errors } = await load(options);
      try {
        await until(() => harness.systemRequests.some((request) => request.path === "/api/chat/system-chats"));
        const section = list(page, mobile).getByRole("button", { name: /Spaces und Notebooks/ });
        expect(await section.getAttribute("aria-expanded")).toBe("false");
        await settled(page);
        const before = await section.boundingBox();
        const line = await section.evaluate((element) => {
          const style = getComputedStyle(element);
          return Number.parseFloat(style.lineHeight) + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
        });
        expect(before!.height).toBeLessThanOrEqual(line + 1);
        const count = section.locator(".k2b-app-workspace__sidebar-section-count");
        expect(await count.textContent()).toBe("1");
        // The section count is persistent metadata, not an action revealed by hover.
        expect(await count.evaluate((element) => getComputedStyle(element).visibility)).toBe("visible");
        await section.hover();
        await settled(page);
        expect(await section.boundingBox()).toEqual(before);
        expect(
          await list(page, mobile)
            .locator(".k2b-app-workspace__sidebar-section-count")
            .evaluate((element) => element.getBoundingClientRect().width),
        ).toBeGreaterThan(0);
        await section.click();
        await list(page, mobile)
          .getByRole("link", { name: /Frühlingsausstellung/ })
          .first()
          .click();
        await page.waitForURL(`**/c/${chat}`);
        await page.getByPlaceholder("Nachricht an Frühlingsausstellung").waitFor();
        expect(harness.systemRequests.some((request) => request.path.endsWith("/spaces.space/Space1/open"))).toBe(true);
        expect(await page.getByText("Noch ohne Chat", { exact: true }).count()).toBe(0);
        expect(await page.getByRole("button", { name: "Neuer Thread", exact: true }).count()).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test("loading has three skeletons; errors retry to empty without changing the section button", async () => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { page } = await load(options, {}, async (page) => {
        await page.route("**/api/chat/system-chats", async (route) => {
          await pending;
          await route.fulfill({ status: 503, json: { message: "Unavailable" } });
        });
      });
      try {
        const section = list(page, mobile).locator(".chat-system-chats");
        const button = section.getByRole("button", { name: /Spaces und Notebooks/ });
        await button.click();
        expect(await section.locator(".chat-system-chats__skeleton").count()).toBe(3);
        await settled(page);
        const before = await button.boundingBox();
        release();
        await section.getByText("Spaces und Notebooks konnten nicht geladen werden.", { exact: false }).waitFor();
        await page.unroute("**/api/chat/system-chats");
        await section.getByRole("button", { name: "Erneut versuchen" }).click();
        await section
          .getByText("Noch keine. Sobald jemand an einer Aufgabe, einem Termin oder einer Notiz schreibt, erscheint der Chat hier.")
          .waitFor();
        await settled(page);
        expect(await button.boundingBox()).toEqual(before);
      } finally {
        release();
        await page.context().close();
      }
    }, 30_000);

    test("resource addresses auto-expand, show item title, done status and the open link; no manual management", async () => {
      const { chat, threads } = seed();
      const { page, errors } = await load(options, { chat, thread: threads[0] });
      try {
        if (!mobile)
          expect(
            await page
              .locator(".k2b-app-workspace__sidebar .chat-system-chats")
              .getByRole("button", { name: /Spaces und Notebooks/ })
              .getAttribute("aria-expanded"),
          ).toBe("true");
        await page
          .locator(".chat-conversation__header")
          .getByRole("heading", { name: /^Einladung freigeben/ })
          .waitFor();
        const metadata = page.locator(mobile ? ".chat-resource-head__mobile" : ".chat-conversation__header");
        await metadata.getByText("Erledigt", { exact: true }).waitFor();
        expect(await metadata.getByRole("link", { name: "Zur Aufgabe ↗", exact: true }).getAttribute("href")).toBe(
          "/app/spaces/items/Item00",
        );
        expect(await page.getByRole("button", { name: "Personen hinzufügen", exact: true }).count()).toBe(0);
        if (mobile) expect(await page.locator(".chat-resource-head__icon").getByRole("link").isVisible()).toBe(true);
        await page.getByRole("link", { name: "Chat-Info", exact: true }).click();
        await page.getByText("Mitglieder: alle mit Zugriff auf den Space. Zugriff änderst du dort.").waitFor();
        expect(await page.getByRole("button", { name: "Mitglieder suchen", exact: true }).count()).toBe(0);
        expect(await page.getByText("Chat verlassen", { exact: true }).count()).toBe(0);
        if (mobile) {
          await page.getByRole("button", { name: "Chat-Info schließen", exact: true }).click();
          await page.locator(".chat-conversation__back").getByRole("link", { name: "Zurück zu den Threads", exact: true }).click();
          await page.waitForURL(`**/c/${chat}/threads`);
          await page.locator(".chat-conversation__back").getByRole("link", { name: "Zurück zu den Chats", exact: true }).click();
          await page.waitForURL("**/app/chat");
          expect(
            await list(page, true)
              .getByRole("button", { name: /Spaces und Notebooks/ })
              .getAttribute("aria-expanded"),
          ).toBe("true");
        }
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test("overview uses server search, filters, paging and empty/error recovery", async () => {
      const { chat } = seed();
      harness.systemPageSize(3);
      const { page, errors } = await load(options, { chat, threadsPage: true });
      try {
        const directory = page.locator(".chat-threads-page .chat-system-directory");
        await directory.getByRole("link", { name: /Einladung freigeben/ }).waitFor();
        if (mobile) {
          await settled(page);
          const heading = (await page.locator(".chat-threads-page").getByRole("heading").boundingBox())!;
          const action = (await page
            .locator(".chat-threads-page")
            .getByRole("button", { name: "Über ein Element sprechen" })
            .boundingBox())!;
          expect(action.y).toBeGreaterThanOrEqual(heading.y + heading.height);
        }
        await directory.getByRole("button", { name: "Weitere Threads anzeigen" }).click();
        await directory.getByRole("link", { name: /Alte ungelesene Aufgabe/ }).waitFor();
        expect(harness.systemRequests.some((request) => request.query.cursor)).toBe(true);
        await directory.getByRole("button", { name: "Erledigt", exact: true }).click();
        await until(() => harness.systemRequests.some((request) => request.query.filter === "done"));
        await directory.getByRole("link", { name: /Einladung freigeben/ }).waitFor();
        expect(await directory.getByRole("link", { name: /Besichtigung/ }).count()).toBe(0);
        await directory.getByRole("button", { name: "Offen", exact: true }).click();
        await until(() => harness.systemRequests.some((request) => request.query.filter === "open"));
        await directory.getByRole("button", { name: "Ungelesen", exact: true }).click();
        await until(() => harness.systemRequests.some((request) => request.query.filter === "unread"));
        await directory.getByRole("button", { name: "Ungelesen", exact: true }).click();
        await directory.getByRole("searchbox", { name: "Threads suchen" }).fill("Nichts");
        await until(() => harness.systemRequests.some((request) => request.query.q === "Nichts"));
        await page.waitForFunction(() => !document.querySelector('.chat-threads-page .chat-system-directory__results[aria-busy="true"]'));
        // A candidate page can be empty after access checks or filters; its cursor must still be reachable.
        while (await directory.getByRole("button", { name: "Weitere Threads anzeigen" }).count()) {
          await directory.getByRole("button", { name: "Weitere Threads anzeigen" }).click();
          await page.waitForFunction(() => !document.querySelector('.chat-threads-page .chat-system-directory__results[aria-busy="true"]'));
        }
        await directory.getByText("Keine passenden Threads.").waitFor();
        await page.route(`**/api/chat/conversations/${chat}/threads?*`, (route) =>
          route.fulfill({ status: 503, json: { message: "Unavailable" } }),
        );
        await directory.getByRole("searchbox", { name: "Threads suchen" }).fill("Aufgabe");
        await directory.getByRole("button", { name: "Erneut versuchen" }).waitFor();
        await page.unroute(`**/api/chat/conversations/${chat}/threads?*`);
        await directory.getByRole("button", { name: "Erneut versuchen" }).click();
        await page.waitForFunction(() => !document.querySelector('.chat-threads-page .chat-system-directory__results[aria-busy="true"]'));
        expect(new URL(page.url()).searchParams.get("q")).toBe("Aufgabe");
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test("inaccessible chat and thread addresses hide titles and offer a way back", async () => {
      const { chat } = seed();
      for (const address of [{ chat: "Gone01" }, { chat, thread: "Gone01" }]) {
        const { page, errors } = await load(options, address);
        try {
          await page.getByText("Thread nicht verfügbar", { exact: true }).waitFor();
          expect(await page.locator(".chat-conversation").count()).toBe(0);
          await page.getByRole("link", { name: "Zurück zu den Chats", exact: true }).click();
          await page.waitForURL("**/app/chat");
          expect(errors).toEqual([]);
        } finally {
          await page.context().close();
        }
      }
    }, 30_000);
  });
}

test("short list is recent four plus unread plus selected, and All N opens the desktop overview", async () => {
  const { chat, threads } = seed();
  const { page } = await load(desktop, { chat, thread: threads[6] });
  try {
    const section = page.locator(".k2b-app-workspace__sidebar .chat-system-chats");
    await section.locator(`[data-thread="${threads[4]}"]`).waitFor();
    expect(await section.locator("[data-thread]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-thread")))).toEqual([
      "all",
      ...threads.slice(0, 5),
      threads[6]!,
    ]);
    expect(await section.locator(`[data-thread="${threads[5]}"]`).count()).toBe(0);
    await section.getByRole("link", { name: "Alle 7 Threads", exact: true }).click();
    await page.waitForURL(`**/c/${chat}/threads`);
    await page.locator(".chat-threads-page").getByRole("searchbox", { name: "Threads suchen" }).waitFor();
  } finally {
    await page.context().close();
  }
}, 30_000);

test("All threads sends to the container, its chip is not a button, and a reply stays in its item's thread", async () => {
  const { chat, threads } = seed();
  const { page } = await load(desktop, { chat });
  try {
    const origin = page.locator(".k2b-message-row__origin", { hasText: "Frühlingsausstellung" }).first();
    await origin.waitFor();
    expect(await origin.evaluate((element) => element.tagName)).not.toBe("BUTTON");
    const composer = page.getByPlaceholder("Nachricht an Frühlingsausstellung");
    await composer.fill("An den Space");
    await composer.press("Enter");
    await until(() => harness.posted.some((message) => message.body === "An den Space"));
    // The transport omits thread for the container strand (NULL on the server).
    expect(harness.posted.at(-1)?.thread).toBeUndefined();
    await page.getByRole("feed").getByText("An den Space", { exact: true }).waitFor();
    await settled(page);
    const message = page.getByRole("feed").getByText("Einladung freigeben: update 1", { exact: true });
    await message.scrollIntoViewIfNeeded();
    await settled(page);
    await message.click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Antworten/ }).click();
    await page.getByPlaceholder("Antwort in Einladung freigeben").fill("Antwort zur Aufgabe");
    const sent = page.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/messages"),
    );
    await page.getByPlaceholder("Antwort in Einladung freigeben").press("Enter");
    const stored = await (await sent).json();
    // Replies carry the original's ID; the server resolves its thread.
    expect(stored.thread).toBe(threads[0]);
    expect(harness.posted.at(-1)?.replyTo).toBeTruthy();
  } finally {
    await page.context().close();
  }
}, 30_000);

test("2000 px column shows All first, server controls, activity and reader descriptions in both themes", async () => {
  const { chat } = seed();
  const { page, errors } = await load(wide, { chat });
  try {
    const column = page.locator(".chat-thread-column");
    await column.getByRole("searchbox", { name: "Threads suchen" }).waitFor();
    await column.getByRole("link", { name: /Einladung freigeben/ }).waitFor();
    expect(await column.locator("[data-thread]").first().textContent()).toContain("Alle Threads");
    expect(await column.getByText("Zugewiesen an: Nora", { exact: true }).count()).toBeGreaterThan(0);
    expect(await column.locator('time[datetime^="2026-10-24"]').count()).toBeGreaterThan(0);
    expect(await column.getByRole("link", { name: "Allgemein", exact: true }).count()).toBe(0);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => {
        document.documentElement.className = theme;
      }, theme);
      await settled(page);
      const before = await column.getByRole("button", { name: "Offen", exact: true }).boundingBox();
      await column.getByRole("button", { name: "Offen", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.chat-thread-column .chat-system-directory__results[aria-busy="true"]'));
      await settled(page);
      expect(await column.getByRole("button", { name: "Offen", exact: true }).boundingBox()).toEqual(before);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 30_000);

test("writers use the container picker and idempotent for-resource endpoint; failures recover", async () => {
  const { chat } = seed("write");
  harness.failThreads();
  const { page } = await load(desktop, { chat, threadsPage: true });
  try {
    const choose = async () => {
      await page.locator(".chat-threads-page").getByRole("button", { name: "Über ein Element sprechen", exact: true }).click();
      await page.locator('input[role="combobox"]').fill("Aufgabe");
      await page.getByRole("option", { name: /Neue Aufgabe/ }).click();
      expect(await page.getByRole("option", { name: /Fremde Aufgabe/ }).count()).toBe(0);
      await page.getByRole("dialog").getByRole("button", { name: "Hinzufügen", exact: true }).click();
    };
    await choose();
    await page.locator(".k2b-toast", { hasText: "Der Element-Thread konnte nicht geöffnet werden." }).waitFor();
    await choose();
    await page.waitForURL(`**/c/${chat}/t/*`);
    await page
      .locator(".chat-conversation__header")
      .getByRole("heading", { name: /^Neue Aufgabe/ })
      .waitFor();
    expect(
      harness.systemRequests.some(
        (request) => request.path === "/api/search" && request.query.scope_type === "spaces.space" && request.query.scope_id === "Space1",
      ),
    ).toBe(true);
    expect(harness.systemRequests.filter((request) => request.path.endsWith("/for-resource"))).toHaveLength(2);
  } finally {
    await page.context().close();
  }
}, 30_000);

for (const [name, options, entry] of [
  ["desktop list", desktop, "list"],
  ["wide column", wide, "column"],
  ["desktop picker", desktop, "picker"],
  ["phone overview", phone, "overview"],
] as const) {
  test(`${name} opens a scoped item picker, preserves context on cancel and reopens the same discussion`, async () => {
    const { chat } = seed("write");
    const { page, errors } = await load(options, { chat, threadsPage: entry === "overview" });
    try {
      const open = async () => {
        if (entry === "picker") {
          await page.locator(".chat-conversation__picker").getByRole("button").click();
          await page.getByRole("menuitem", { name: "Über ein Element sprechen", exact: true }).click();
        } else {
          const host = page.locator(
            entry === "list" ? ".k2b-app-workspace__sidebar" : entry === "column" ? ".chat-thread-column" : ".chat-threads-page",
          );
          await host.getByRole("button", { name: "Über ein Element sprechen", exact: true }).click();
        }
        await page.getByRole("dialog", { name: "Über ein Element sprechen", exact: true }).waitFor();
      };
      const before = page.url();
      await open();
      await page.getByRole("dialog").getByRole("combobox").press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      expect(page.url()).toBe(before);
      const choose = async () => {
        await page.getByRole("dialog").getByRole("combobox").fill("Aufgabe");
        await page.getByRole("option", { name: /Neue Aufgabe/ }).waitFor();
        expect(await page.getByRole("option", { name: /Fremde Aufgabe/ }).count()).toBe(0);
        await page.getByRole("option", { name: /Neue Aufgabe/ }).click();
        const response = page.waitForResponse((response) => response.url().endsWith("/threads/for-resource"));
        await page.getByRole("dialog").getByRole("button", { name: "Hinzufügen", exact: true }).click();
        expect((await response).ok()).toBe(true);
        await page.waitForURL(`**/c/${chat}/t/*`);
        await page
          .locator(".chat-conversation__header")
          .getByRole("heading", { name: /^Neue Aufgabe/ })
          .waitFor();
      };
      await open();
      await choose();
      const threadAddress = page.url();
      if (entry === "overview") {
        await page.locator(".chat-conversation__back").getByRole("link").click();
        await page.waitForURL(`**/c/${chat}/threads`);
      }
      await open();
      await choose();
      expect(page.url()).toBe(threadAddress);
      expect(harness.systemRequests.filter((request) => request.path.endsWith("/for-resource"))).toHaveLength(2);
      expect(
        harness.systemRequests.some(
          (request) => request.path === "/api/search" && request.query.scope_type === "spaces.space" && request.query.scope_id === "Space1",
        ),
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
}

test("a Notebook writer picks only its notes and opens their resource thread", async () => {
  const ref = { type: "notebooks.notebook", id: "Book01" };
  const chat = harness.addChat({ members: [viewer, nora], name: "Planung", count: 1, end: chatTestNow, permission: "write" });
  harness.setSystem(chat, ref);
  harness.systemElement({ id: "Note01", title: "Ideen", parent: ref, kind: "note" });
  harness.systemElement({ id: "Note02", title: "Fremde Ideen", parent: { ...ref, id: "Book02" }, kind: "note" });
  const { page, errors } = await load(phone, { chat, threadsPage: true });
  try {
    await page.getByRole("button", { name: "Über ein Element sprechen", exact: true }).click();
    await page.getByRole("dialog").getByRole("combobox").fill("Ideen");
    await page.getByRole("option", { name: /Ideen/ }).waitFor();
    expect(await page.getByRole("option", { name: /Fremde Ideen/ }).count()).toBe(0);
    await page.getByRole("option", { name: /Ideen/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Hinzufügen", exact: true }).click();
    await page.waitForURL(`**/c/${chat}/t/*`);
    await page.locator(".chat-resource-head__mobile").getByRole("link", { name: "Zur Notiz ↗" }).waitFor();
    expect(
      harness.systemRequests.some(
        (request) =>
          request.path === "/api/search" && request.query.scope_type === "notebooks.notebook" && request.query.scope_id === "Book01",
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 30_000);

test("notebook rows and note heads use their own icon, link and membership; readers cannot create", async () => {
  const chat = harness.addChat({ members: [viewer, nora], name: "Planung", count: 1, end: chatTestNow, permission: "read" });
  harness.setSystem(chat, { type: "notebooks.notebook", id: "Book01" });
  const note = harness.addThread(chat, { name: "Ideen", count: 1 });
  harness.resourceThread(chat, note, {
    ref: { type: "notebooks.note", id: "Note01" },
    kind: "note",
    status: null,
    done: false,
    href: "/app/notebooks/notes/Note01",
  });
  const { page } = await load(phone, { chat, thread: note, panel: "info" });
  try {
    await page.getByText("Mitglieder: alle mit Zugriff auf das Notebook. Zugriff änderst du dort.").waitFor();
    expect(await page.locator(".chat-system-chats .ti-notebook").count()).toBeGreaterThan(0);
    expect(await page.getByRole("button", { name: "Über ein Element sprechen", exact: true }).count()).toBe(0);
    expect(await page.locator(".chat-resource-head__mobile").getByRole("link", { name: "Zur Notiz ↗" }).getAttribute("href")).toBe(
      "/app/notebooks/notes/Note01",
    );
    expect(await page.locator(".chat-resource-head__mobile").getByText("Offen", { exact: true }).count()).toBe(0);
  } finally {
    await page.context().close();
  }
}, 30_000);

test("system item directory and info keep their links inside the universal panel", async () => {
  const { chat, threads } = seed();
  const { page, errors } = await load(desktop, { chat, threadsPage: true, embedded: true });
  try {
    const directory = page.locator(".chat-threads-page .chat-system-directory");
    const row = directory.locator(`[data-thread="${threads[0]}"]`);
    await row.waitFor();
    const overview = page
      .locator(".k2b-app-workspace__sidebar .chat-system-chats")
      .getByRole("link", { name: "Alle 7 Threads", exact: true });
    await overview.waitFor();
    expect(await overview.getAttribute("href")).toBe(`/app/chat/panel/c/${chat}/threads`);
    expect(await row.getAttribute("href")).toBe(`/app/chat/panel/c/${chat}/t/${threads[0]}`);
    await row.click();
    await page.waitForURL(`**/app/chat/panel/c/${chat}/t/${threads[0]}`);
    const info = page.getByRole("link", { name: "Chat-Info", exact: true });
    expect(await info.getAttribute("href")).toBe(`/app/chat/panel/c/${chat}/t/${threads[0]}?panel=info`);
    expect(await page.locator(".chat-conversation__back a").getAttribute("href")).toBe(`/app/chat/panel/c/${chat}/threads`);
    await info.click();
    await page.getByText("Mitglieder: alle mit Zugriff auf den Space. Zugriff änderst du dort.").waitFor();
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 30_000);

test("discovery advances each provider independently after one source is exhausted", async () => {
  const queries: Record<string, string>[] = [];
  const { page } = await load(desktop, {}, async (page) => {
    await page.route("**/api/chat/system-chats*", async (route) => {
      const query = Object.fromEntries(new URL(route.request().url()).searchParams);
      queries.push(query);
      await route.fulfill({
        json: {
          items: [],
          spacesCursor: query.spacesCursor === undefined ? "Space2" : null,
          notebooksCursor: query.notebooksCursor === undefined ? "Book02" : query.notebooksCursor === "Book02" ? "Book03" : null,
        },
      });
    });
  });
  try {
    await page.getByRole("button", { name: /Spaces und Notebooks/ }).click();
    const more = page.locator(".chat-system-chats").getByRole("button", { name: "Weitere Chats anzeigen" });
    await more.click();
    await until(() => queries.length === 2);
    await page.waitForFunction(() => document.querySelector('.chat-system-chats button[aria-busy="true"]') === null);
    await more.click();
    await until(() => queries.length === 3);
    await more.waitFor({ state: "detached" });
    expect(queries[2]?.spacesCursor).toBe("");
    expect(await more.count()).toBe(0);
  } finally {
    await page.context().close();
  }
}, 30_000);

test("live directory refresh preserves loaded pages and their existing row nodes", async () => {
  const { chat, threads } = seed();
  harness.systemPageSize(3);
  const { page } = await load(desktop, { chat, threadsPage: true });
  try {
    const directory = page.locator(".chat-threads-page .chat-system-directory");
    await directory.getByRole("link", { name: /Einladung freigeben/ }).waitFor();
    await directory.getByRole("button", { name: "Weitere Threads anzeigen" }).click();
    const older = directory.getByRole("link", { name: /Alte gelesene Aufgabe/ });
    await older.waitFor();
    await older.evaluate((node) => node.setAttribute("data-retained", "yes"));
    const before = harness.systemRequests.length;
    const refreshed = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === `/api/chat/conversations/${chat}/threads` && !url.searchParams.has("short") && !url.searchParams.has("cursor")
      );
    });
    harness.receiveIn(chat, nora, "A directory update", { thread: threads[0] });
    await until(() => harness.systemRequests.length > before);
    await refreshed;
    await page.waitForFunction(() => !document.querySelector('.chat-threads-page .chat-system-directory__results[aria-busy="true"]'));
    expect(await older.count()).toBe(1);
    expect(await older.getAttribute("data-retained")).toBe("yes");
  } finally {
    await page.context().close();
  }
}, 30_000);

test("personal Unread and the system directory filter survive reload and Back independently", async () => {
  const { chat, threads } = seed();
  const { page, errors } = await load(desktop, { chat, threadsPage: true });
  try {
    const sidebar = page.locator(".k2b-app-workspace__sidebar");
    const directory = page.locator(".chat-threads-page .chat-system-directory");
    await sidebar.getByRole("button", { name: "Ungelesen", exact: true }).click();
    await page.waitForURL(/listFilter=unread/);
    await directory.getByRole("button", { name: "Erledigt", exact: true }).click();
    await page.waitForURL(/filter=done/);
    await directory.getByRole("link", { name: /Einladung freigeben/ }).click();
    await page.waitForURL((url) => url.pathname === `/app/chat/c/${chat}/t/${threads[0]}`);
    expect(new URL(page.url()).searchParams.get("listFilter")).toBe("unread");
    expect(new URL(page.url()).searchParams.get("filter")).toBe("done");
    await page.reload();
    await page.evaluate(async () => {
      const props = await (await fetch(`/__props?path=${encodeURIComponent(location.pathname + location.search)}`)).json();
      window.mountChat(props, "de");
    });
    await sidebar.getByRole("button", { name: "Ungelesen", exact: true }).waitFor();
    expect(await sidebar.getByRole("button", { name: "Ungelesen", exact: true }).getAttribute("aria-pressed")).toBe("true");
    await page.goBack();
    await page.waitForURL((url) => url.pathname === `/app/chat/c/${chat}/threads`);
    await directory.getByRole("link", { name: /Einladung freigeben/ }).waitFor();
    expect(await directory.getByRole("button", { name: "Erledigt", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect(await sidebar.getByRole("button", { name: "Ungelesen", exact: true }).getAttribute("aria-pressed")).toBe("true");
    await directory.getByRole("button", { name: "Erledigt", exact: true }).click();
    await page.waitForURL((url) => !url.searchParams.has("filter"));
    expect(new URL(page.url()).searchParams.get("listFilter")).toBe("unread");
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 30_000);
