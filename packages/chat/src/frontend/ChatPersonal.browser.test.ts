import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { chatMessages } from "../messages";
import { nora, startChatHarness, tobias, viewer } from "./ChatWorkspace.browser-fixture";

let harness: Awaited<ReturnType<typeof startChatHarness>>;
let browser: Browser;
beforeAll(async () => {
  harness = await startChatHarness();
  browser = await launchBrowser();
}, 60_000);
beforeEach(() => harness.reset());
afterAll(async () => {
  await browser?.close();
  harness?.stop();
});
const add = (name: string, unread = 0) => harness.addChat({ name, members: [viewer, nora], count: 4, end: harness.now(), unread });
const pin = async (context: BrowserContext, id: string) => {
  const response = await context.request.put(new URL(`/api/chat/conversations/${id}/personal`, harness.url).href, {
    data: { pinned: true },
  });
  expect(response.ok()).toBe(true);
  expect((await response.json()).pinnedRank).toBeNumber();
};
const start = async (phone: boolean, locale: string, path = "/app/chat") => {
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: phone,
    hasTouch: phone,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.addInitScript(
    ({ locale }) => {
      window.addEventListener("load", async () => {
        const response = await fetch(`/__props?path=${encodeURIComponent(location.pathname + location.search)}`);
        window.mountChat(await response.json(), locale);
      });
    },
    { locale },
  );
  await page.goto(new URL(path, harness.url).href);
  await page
    .getByRole("button", { name: chatMessages.resolve([locale]).t.newChat, exact: true })
    .filter({ visible: true })
    .waitFor();
  return { page, context, errors };
};
const visible = (page: Page) => page.locator(".chat-list-page:visible, .k2b-app-workspace__sidebar-desktop:visible");
const actions = async (page: Page, title: string, locale: string) => {
  const t = chatMessages.resolve([locale]).t;
  const row = visible(page).locator(".k2b-app-workspace__sidebar-item", { has: page.getByText(title, { exact: true }) });
  await row.hover();
  await row.getByRole("button", { name: t.chatActions({ title }), exact: true }).click();
};
const order = async (page: Page) => visible(page).locator(".chat-list-pins .k2b-app-workspace__sidebar-item-label").allTextContents();

for (const phone of [false, true]) {
  const locale = phone ? "de" : "en";
  const t = chatMessages.resolve([locale]).t;
  describe(`personal chat list ${phone ? "phone DE" : "desktop EN"}`, () => {
    test("archive survives a new message and reload; restore recovers the pin position", async () => {
      const first = add("Design room"),
        second = add("Delivery room");
      const { page, context, errors } = await start(phone, locale);
      try {
        await pin(context, first);
        await pin(context, second);
        await page.reload();
        await visible(page).getByText("Design room", { exact: true }).waitFor();
        expect(await order(page)).toEqual(["Design room", "Delivery room"]);
        await actions(page, "Design room", locale);
        await page.getByRole("menuitem", { name: t.archiveChat, exact: true }).click();
        await visible(page).getByText("Design room", { exact: true }).waitFor({ state: "hidden" });
        harness.receive(first, nora, "A new message does not restore the chat");
        await page.getByRole("link", { name: t.archive, exact: true }).filter({ visible: true }).click();
        await page.waitForURL("**/app/chat/archive");
        await visible(page).getByText("Design room", { exact: true }).waitFor();
        await page.reload();
        await actions(page, "Design room", locale);
        await page.getByRole("menuitem", { name: t.restoreChat, exact: true }).click();
        await visible(page).getByText("Design room", { exact: true }).waitFor({ state: "hidden" });
        await visible(page).getByRole("button", { name: t.allChats, exact: true }).click();
        await visible(page).getByText("Design room", { exact: true }).waitFor();
        expect(await order(page)).toEqual(["Design room", "Delivery room"]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 30_000);

    test("Unread retains a newly read row until exit, and the URL works through reload and Back", async () => {
      const chat = add("Unread design", 2);
      add("Already read");
      const { page, context, errors } = await start(phone, locale);
      try {
        await visible(page).getByRole("button", { name: t.unreadChats, exact: true }).click();
        await page.waitForURL("**?filter=unread");
        await visible(page).getByText("Unread design", { exact: true }).waitFor();
        expect(await visible(page).getByText("Already read", { exact: true }).count()).toBe(0);
        harness.readElsewhere(chat, 4);
        await page.waitForFunction(
          () => ![...document.querySelectorAll(".chat-list__unread")].some((element) => element.textContent?.trim()),
        );
        expect(await visible(page).getByText("Unread design", { exact: true }).count()).toBe(1);
        await visible(page).getByRole("button", { name: t.allChats, exact: true }).click();
        await page.waitForURL("**/app/chat");
        await visible(page).getByRole("button", { name: t.unreadChats, exact: true }).click();
        await page.waitForURL("**?filter=unread");
        await visible(page).getByText(t.noUnreadChats, { exact: true }).waitFor();
        await page.reload();
        await visible(page).getByText(t.noUnreadChats, { exact: true }).waitFor();
        expect(await visible(page).getByRole("button", { name: t.unreadChats, exact: true }).getAttribute("aria-pressed")).toBe("true");
        await page.goBack();
        await page.waitForURL("**/app/chat");
        await visible(page).getByText("Already read", { exact: true }).waitFor();
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 30_000);

    test("pin menu ordering and collapsed sections persist, including failure and retry", async () => {
      const first = add("Alpha"),
        second = add("Beta");
      const { page, context, errors } = await start(phone, locale);
      try {
        await pin(context, first);
        await pin(context, second);
        await page.reload();
        await actions(page, "Beta", locale);
        let reject = true;
        await page.route("**/api/chat/conversations/*/personal", async (route) => {
          if (reject) {
            reject = false;
            await route.fulfill({ status: 503, json: { message: "Unavailable" } });
          } else await route.continue();
        });
        await page.getByRole("menuitem", { name: t.moveUp, exact: true }).click();
        await visible(page).getByRole("alert").waitFor();
        expect(await order(page)).toEqual(["Alpha", "Beta"]);
        await visible(page).getByRole("button", { name: t.retry, exact: true }).click();
        await page.waitForFunction(() =>
          [...document.querySelectorAll(".chat-list-pins")]
            .filter((element) => element.getBoundingClientRect().width > 0)
            .some((element) => element.textContent?.indexOf("Beta")! < element.textContent?.indexOf("Alpha")!),
        );
        expect(await order(page)).toEqual(["Beta", "Alpha"]);
        let rejectPreferences = true;
        await page.route("**/api/chat/preferences", async (route) => {
          if (route.request().method() === "PUT" && rejectPreferences) {
            rejectPreferences = false;
            await route.fulfill({ status: 503, json: { message: "Unavailable" } });
          } else await route.continue();
        });
        await visible(page).getByRole("button", { name: t.pinnedChats, exact: true }).click();
        await visible(page).getByRole("alert").waitFor();
        expect(await visible(page).getByRole("button", { name: t.pinnedChats, exact: true }).getAttribute("aria-expanded")).toBe("true");
        await visible(page).getByRole("button", { name: t.retry, exact: true }).click();
        await page.waitForFunction(() =>
          [...document.querySelectorAll('[aria-expanded="false"]')].some(
            (element) => element.textContent?.includes("Pinned") || element.textContent?.includes("Angeheftet"),
          ),
        );
        await page.reload();
        expect(await visible(page).getByRole("button", { name: t.pinnedChats, exact: true }).getAttribute("aria-expanded")).toBe("false");
        await visible(page).getByRole("button", { name: t.pinnedChats, exact: true }).click();
        expect(await order(page)).toEqual(["Beta", "Alpha"]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 30_000);
  });
}

test("sixteen pins scroll without a cap and pointer and keyboard drag both save", async () => {
  const ids = Array.from({ length: 16 }, (_, index) => add(`Room ${String(index + 1).padStart(2, "0")}`));
  const { page, context, errors } = await start(false, "en");
  try {
    for (const id of ids.slice(0, 15)) await pin(context, id);
    await page.reload();
    const pins = visible(page).locator(".chat-list-pins");
    await pins.getByText("Room 15", { exact: true }).waitFor();
    expect(await pins.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    await pin(context, ids[15]!);
    await page.reload();
    await pins.getByText("Room 16", { exact: true }).waitFor();
    const box = await pins.evaluate((element) => ({
      height: element.clientHeight,
      content: element.scrollHeight,
      overflow: getComputedStyle(element).overflowY,
    }));
    expect(box.content).toBeGreaterThan(box.height);
    expect(box.overflow).toBe("auto");
    await pins.getByRole("link", { name: /Room 01/ }).focus();
    const handle = pins.getByRole("button", { name: "Move Room 01", exact: true });
    await handle.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".chat-list-pins")?.textContent?.startsWith("Room 02"));
    expect(await handle.evaluate((element) => element === document.activeElement)).toBe(true);
    await handle.and(page.locator('[aria-disabled="false"]')).waitFor();
    await pins.getByRole("link", { name: /Room 01/ }).hover();
    const source = pins.getByRole("button", { name: "Move Room 01", exact: true });
    await source.hover();
    const from = await source.boundingBox(),
      target = await pins.locator("[data-dnd-droppable]", { has: page.getByText("Room 03", { exact: true }) }).boundingBox();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height * 0.75, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(() => {
      const names = [...document.querySelectorAll(".chat-list-pins .k2b-app-workspace__sidebar-item-label")].map(
        (element) => element.textContent,
      );
      return names.indexOf("Room 01") > names.indexOf("Room 03");
    });
    const expected = await order(page);
    await page.reload();
    await visible(page).getByText("Room 16", { exact: true }).waitFor();
    expect(await order(page)).toEqual(expected);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 30_000);

for (const mode of ["all", "unread", "archive"] as const) {
  test(`next page appends below the current ${mode} list`, async () => {
    const ids = Array.from({ length: 53 }, (_, index) =>
      harness.addChat({
        name: `Paged ${String(index + 1).padStart(2, "0")}`,
        members: [viewer, nora],
        count: 4,
        end: new Date(harness.now().valueOf() + index * 1000),
        unread: mode === "unread" ? 2 : 0,
      }),
    );
    if (mode === "archive")
      for (const id of ids) {
        const response = await fetch(new URL(`/api/chat/conversations/${id}/personal`, harness.url), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ archived: true }),
        });
        expect(response.ok).toBe(true);
      }
    const path = mode === "archive" ? "/app/chat/archive" : `/app/chat${mode === "unread" ? "?filter=unread" : ""}`;
    const { page, context, errors } = await start(false, "en", path);
    const names = () =>
      visible(page)
        .locator(".k2b-app-workspace__sidebar-item-label")
        .allTextContents()
        .then((values) => values.filter((value) => value.startsWith("Paged ")));
    try {
      const expected = ids.map((_, index) => `Paged ${String(index + 1).padStart(2, "0")}`).reverse();
      expect(await names()).toEqual(expected.slice(0, 50));
      await visible(page).getByText("Show more chats", { exact: true }).click();
      await visible(page).getByText("Paged 01", { exact: true }).waitFor();
      expect(await names()).toEqual(expected);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);
}

test("a removed pin neighbor refreshes the list and retries only the read before a new position", async () => {
  const first = add("Alpha"),
    second = add("Beta");
  const { page, context, errors } = await start(false, "en");
  try {
    await pin(context, first);
    await pin(context, second);
    await page.reload();
    await actions(page, "Beta", "en");
    let attempts = 0;
    await page.route(`**/api/chat/conversations/${second}/personal`, async (route) => {
      attempts++;
      const response = await context.request.put(new URL(`/api/chat/conversations/${first}/personal`, harness.url).href, {
        data: { pinned: false },
      });
      expect(response.ok()).toBe(true);
      await route.continue();
    });
    await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
    await visible(page).getByRole("alert").filter({ hasText: "Choose the position again" }).waitFor();
    await visible(page).getByRole("button", { name: "Try again", exact: true }).click();
    await visible(page).getByRole("alert").waitFor({ state: "hidden" });
    expect(attempts).toBe(1);
    expect(await order(page)).toEqual(["Beta"]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 30_000);

test("loading the next page keeps a previously arrived live row at the top", async () => {
  for (let index = 0; index < 53; index++)
    harness.addChat({
      name: `Earlier ${index}`,
      members: [viewer, nora],
      count: 1,
      end: new Date(harness.now().valueOf() - (index + 1) * 1000),
    });
  const { page, context, errors } = await start(false, "en");
  try {
    const arriving = add("Live arrival");
    harness.receive(arriving, nora, "Arrived after the list opened");
    await visible(page).getByText("Live arrival", { exact: true }).waitFor();
    const names = () => visible(page).locator('a[href*="/app/chat/c/"] .k2b-app-workspace__sidebar-item-label').allTextContents();
    const previous = await names();
    expect(previous[0]).toBe("Live arrival");
    await visible(page).getByText("Show more chats", { exact: true }).click();
    await visible(page).getByText("Earlier 52", { exact: true }).waitFor();
    expect((await names()).slice(0, previous.length)).toEqual(previous);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 30_000);

test("Back supersedes a pending filter switch and leaves URL and list in the archive", async () => {
  const archived = add("Archived design");
  add("Unread design", 2);
  await fetch(new URL(`/api/chat/conversations/${archived}/personal`, harness.url), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  const { page, context, errors } = await start(false, "en", "/app/chat/archive");
  let release: (() => void) | undefined;
  try {
    await visible(page).getByRole("button", { name: "Unread", exact: true }).click();
    await page.waitForURL("**/app/chat/archive?filter=unread");
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let intercepted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      intercepted = resolve;
    });
    await page.route("**/api/chat/conversations?**", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("archived") === "false" && url.searchParams.get("unread") === "false") {
        intercepted?.();
        await pending;
      }
      await route.continue();
    });
    await visible(page).getByRole("button", { name: "All", exact: true }).click();
    await started;
    await page.goBack();
    await page.waitForURL("**/app/chat/archive");
    release?.();
    await visible(page).getByText("Archived design", { exact: true }).waitFor();
    await visible(page).getByRole("button", { name: "All", exact: true }).and(page.locator(":not([disabled])")).waitFor();
    expect(new URL(page.url()).pathname).toBe("/app/chat/archive");
    expect(new URL(page.url()).search).toBe("");
    expect(await visible(page).getByText("Unread design", { exact: true }).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    release?.();
    await context.close();
  }
}, 30_000);

test("active filters add no duplicate history and the archive unread chip toggles in place", async () => {
  add("Unread design", 2);
  const { page, context, errors } = await start(false, "en");
  try {
    const initial = await page.evaluate(() => history.length);
    await visible(page).getByRole("button", { name: "All", exact: true }).click();
    expect(await page.evaluate(() => history.length)).toBe(initial);
    await visible(page).getByRole("button", { name: "Unread", exact: true }).click();
    await page.waitForURL("**?filter=unread");
    const filtered = await page.evaluate(() => history.length);
    await visible(page).getByRole("button", { name: "Unread", exact: true }).click();
    expect(await page.evaluate(() => history.length)).toBe(filtered);
    await page.goto(new URL("/app/chat/archive?filter=unread", harness.url).href);
    await visible(page).getByRole("button", { name: "Unread", exact: true }).click();
    await page.waitForURL("**/app/chat/archive");
    expect(await visible(page).getByRole("button", { name: "Unread", exact: true }).getAttribute("aria-pressed")).toBe("false");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 30_000);

for (const failRefresh of [false, true])
  test(`choosing an existing chat supersedes a pending list without stuck loading (refresh failure=${failRefresh})`, async () => {
    const existing = add("Existing design", 2);
    const other = harness.addChat({ name: "Another unread", members: [viewer, nora, tobias], count: 4, end: harness.now(), unread: 2 });
    const { page, context, errors } = await start(false, "en", "/app/chat?filter=unread");
    let release: (() => void) | undefined;
    try {
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let intercepted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        intercepted = resolve;
      });
      let allReads = 0;
      let unreadReads = 0;
      await page.route("**/api/chat/conversations?**", async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("unread") === "true") unreadReads++;
        if (url.searchParams.get("archived") === "false" && url.searchParams.get("unread") === "false") {
          allReads++;
          if (allReads === 1) {
            intercepted?.();
            await held;
          } else if (allReads === 2 && failRefresh) {
            await route.fulfill({ status: 503, json: { message: "Unavailable" } });
            return;
          }
        }
        await route.continue();
      });
      await visible(page).getByRole("button", { name: "All", exact: true }).click();
      await started;
      await page.getByRole("button", { name: "New chat", exact: true }).filter({ visible: true }).click();
      const dialog = page.getByRole("dialog", { name: "New chat", exact: true });
      await dialog.getByRole("combobox").fill(nora.name);
      await page.getByRole("option", { name: nora.name }).click();
      await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
      await dialog.getByRole("button", { name: "Open existing", exact: true }).click();
      await page.waitForURL(`**/app/chat/c/${existing}`);
      release?.();
      if (failRefresh) {
        await visible(page).getByRole("alert").waitFor();
        await visible(page).getByText("Another unread", { exact: true }).click();
        await page.waitForURL(`**/app/chat/c/${other}?filter=unread`);
        const entries = await page.evaluate(() => history.length);
        const readsBeforeRetry = unreadReads;
        const allBeforeRetry = allReads;
        await visible(page).getByRole("button", { name: "Try again", exact: true }).click();
        await visible(page).getByRole("alert").waitFor({ state: "hidden" });
        expect(unreadReads).toBe(readsBeforeRetry + 1);
        expect(allReads).toBe(allBeforeRetry);
        expect(await page.evaluate(() => history.length)).toBe(entries);
        expect(await visible(page).getByRole("button", { name: "Unread", exact: true }).getAttribute("aria-pressed")).toBe("true");
        await visible(page).getByRole("button", { name: "All", exact: true }).click();
        await page.waitForURL(`**/app/chat/c/${other}`);
      }
      await visible(page).getByRole("button", { name: "All", exact: true }).and(page.locator(":not([disabled])")).waitFor();
      expect(await visible(page).locator(".chat-list-status").textContent()).toBe("");
      await visible(page).getByRole("button", { name: "Unread", exact: true }).click();
      await page.waitForURL(`**/app/chat/c/${failRefresh ? other : existing}?filter=unread`);
      expect(errors).toEqual([]);
    } finally {
      release?.();
      await context.close();
    }
  }, 30_000);
