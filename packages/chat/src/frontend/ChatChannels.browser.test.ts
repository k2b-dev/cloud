import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { chatMessages } from "../messages";
import { CreateConversationSchema, CreateOutcomeSchema } from "../service/contracts";
import { chatTestNow, nora, pinPageClock, startChatHarness, viewer } from "./ChatWorkspace.browser-fixture";

// Each test drives a whole flow in a browser, with the same budget as the other Chat browser suites.
setDefaultTimeout(30_000);

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
const mount = async (page: Page, locale: string, path = "/app/chat") => {
  await page.goto(new URL(path, harness.url).href);
  await page.evaluate(
    async ({ path, locale }) => {
      window.mountChat(await (await fetch(`/__props?path=${encodeURIComponent(path)}`)).json(), locale);
    },
    { path, locale },
  );
};
for (const mode of [
  { width: 1440, locale: "en" },
  { width: 390, locale: "de" },
]) {
  describe(`channels ${mode.locale} ${mode.width}`, () => {
    let context: BrowserContext, page: Page;
    const t = chatMessages.resolve([mode.locale]).t;
    beforeEach(async () => {
      context = await browser.newContext({
        viewport: { width: mode.width, height: 900 },
        colorScheme: mode.width === 390 ? "dark" : "light",
        isMobile: mode.width === 390,
        hasTouch: mode.width === 390,
      });
      page = await context.newPage();
      await page.addInitScript(pinPageClock, chatTestNow.getTime());
    });
    afterEach(async () => {
      await context.close();
      harness.reset();
    });
    const discover = () => page.getByRole("link", { name: t.browseChannels, exact: true }).filter({ visible: true });
    const catalog = () => page.getByRole("region", { name: t.browseChannels, exact: true });
    const newChannel = async () => {
      await page.getByRole("button", { name: t.newChat, exact: true }).filter({ visible: true }).click();
      await page.getByRole("radio", { name: t.channelChoice, exact: true }).click();
      return page.getByRole("dialog");
    };
    test("discover is an enhanced page; search, pending, failure/retry, subscribe and Back preserve the page", async () => {
      const id = harness.addChannel("Atlas", "Project decisions");
      harness.addChat({ name: "Planning", members: [viewer, nora], count: 1, end: chatTestNow });
      await mount(page, mode.locale);
      await page.evaluate(() => {
        document.body.dataset.navigationMarker = "kept";
      });
      await discover().click();
      await page.waitForURL("**/app/chat/channels");
      await catalog().getByText(t.discoverSubtitle).waitFor();
      expect(await page.locator("body").getAttribute("data-navigation-marker")).toBe("kept");
      await catalog().getByRole("searchbox").fill("decisions");
      await page.waitForURL("**/app/chat/channels?q=decisions");
      const row = catalog().getByRole("listitem").filter({ hasText: "Atlas" });
      const button = row.getByRole("button");
      await row.waitFor();
      await settled(page);
      const before = await button.boundingBox();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let first = true;
      await page.route("**/api/chat/conversations/*/join", async (route) => {
        if (!first) return route.continue();
        first = false;
        await gate;
        await route.fulfill({ status: 503, json: { message: "Unavailable" } });
      });
      try {
        await button.click();
        await page.waitForFunction(() => document.querySelector(".chat-discover__subscribe")?.getAttribute("aria-busy") === "true");
        await settled(page);
        expect((await button.boundingBox())?.width).toBe(before?.width);
      } finally {
        release();
      }
      await page.getByRole("button", { name: t.retry, exact: true }).click();
      await row.getByRole("button", { name: t.subscribed, exact: true }).waitFor();
      await settled(page);
      expect((await button.boundingBox())?.width).toBe(before?.width);
      expect(harness.props({}).sidebar.items.some((row) => row.id === id)).toBe(true);
      if (mode.width === 1440) await page.getByRole("link").filter({ hasText: "Atlas" }).waitFor();
      await button.click();
      await page.waitForURL(`**/app/chat/c/${id}`);
      await page.goBack();
      await catalog().getByRole("searchbox").waitFor();
      expect(await catalog().getByRole("searchbox").inputValue()).toBe("decisions");
      const path = new URL(page.url()).pathname + new URL(page.url()).search;
      await mount(page, mode.locale, path);
      await catalog().getByRole("button", { name: t.subscribed, exact: true }).waitFor();
      expect(await catalog().getByRole("searchbox").inputValue()).toBe("decisions");
      if (mode.width === 390) {
        await catalog().getByRole("link", { name: t.backToChats, exact: true }).click();
        await discover().waitFor();
      }
    });
    test("a subscription made in another tab shows in the open catalog", async () => {
      harness.addChannel("Atlas", "Project decisions");
      await mount(page, mode.locale, "/app/chat/channels");
      const row = catalog().getByRole("listitem").filter({ hasText: "Atlas" });
      await row.getByRole("button", { name: t.subscribe, exact: true }).waitFor();
      const other = await context.newPage();
      await other.addInitScript(pinPageClock, chatTestNow.getTime());
      await mount(other, mode.locale, "/app/chat/channels");
      await other
        .getByRole("region", { name: t.browseChannels, exact: true })
        .getByRole("listitem")
        .filter({ hasText: "Atlas" })
        .getByRole("button", { name: t.subscribe, exact: true })
        .click();
      // The first tab learns it from its personal live channel, without a reload.
      await row.getByRole("button", { name: t.subscribed, exact: true }).waitFor();
      await other.close();
    });

    test("loading skeleton, catalog error/retry and empty/search-empty states", async () => {
      let fail = true;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(/\/api\/chat\/channels(?:\?|$)/, async (route) => {
        if (!fail) return route.continue();
        await gate;
        await route.fulfill({ status: 503, json: { message: "Unavailable" } });
      });
      await mount(page, mode.locale, "/app/chat/channels");
      try {
        await catalog().getByRole("status", { name: t.loadingChats }).waitFor();
      } finally {
        release();
      }
      await catalog().getByRole("alert").waitFor();
      fail = false;
      await catalog().getByRole("button", { name: t.retry, exact: true }).click();
      await catalog().getByText(t.noChannels, { exact: true }).waitFor();
      await catalog().getByRole("searchbox").fill("missing");
      await catalog()
        .getByText(t.channelSearchEmpty({ query: "missing" }), { exact: true })
        .waitFor();
    });
    test("server paging appends channels and keeps the first page", async () => {
      const one = harness.addChannel("Atlas", "First"),
        two = harness.addChannel("Zephyr", "Second");
      await page.route(/\/api\/chat\/channels(?:\?|$)/, (route) => {
        const more = new URL(route.request().url()).searchParams.has("cursor");
        return route.fulfill({
          json: { items: [harness.props({ chat: more ? two : one }).open!.conversation], nextCursor: more ? null : "next" },
        });
      });
      await mount(page, mode.locale, "/app/chat/channels");
      await catalog().getByText("Atlas", { exact: true }).waitFor();
      await catalog().getByRole("button", { name: t.showMoreChannels }).click();
      await catalog().getByText("Zephyr", { exact: true }).waitFor();
      expect(await catalog().getByRole("listitem").count()).toBe(2);
      const row = catalog().getByRole("listitem").filter({ hasText: "Zephyr" });
      const subscribe = row.getByRole("button", { name: t.subscribe, exact: true });
      await subscribe.focus();
      await page.keyboard.press("Enter");
      const subscribed = row.getByRole("button", { name: t.subscribed, exact: true });
      await subscribed.waitFor();
      expect(await catalog().getByRole("listitem").count()).toBe(2);
      await subscribed.focus();
      await page.keyboard.press("Enter");
      await page.waitForURL(`**/app/chat/c/${two}`);
    });
    test("readers see editors notice, channels have no threads, unsubscribe offers to subscribe again", async () => {
      const id = harness.addChannel("Handbook", "Read the handbook", true, "read");
      harness.addThread(id, { name: "Legacy thread", count: 1, end: chatTestNow });
      harness.setPermission(id, "read");
      await mount(page, mode.locale, `/app/chat/c/${id}`);
      await page.getByText(t.channelReadOnly, { exact: true }).waitFor();
      expect(await page.getByRole("textbox", { name: t.composerLabel({ title: "Handbook" }) }).count()).toBe(0);
      expect(await page.locator(".chat-list__threads, .chat-thread-picker, .chat-thread-column").count()).toBe(0);
      await page
        .locator(".chat-conversation__header")
        .getByRole("button", { name: t.chatActions({ title: "Handbook" }), exact: true })
        .click();
      await page.getByRole("menuitem").filter({ hasText: t.unsubscribeDescription }).click();
      await page.waitForURL("**/app/chat/channels");
      await page.getByText(t.unsubscribed({ name: "Handbook" }), { exact: true }).waitFor();
      expect(harness.props({}).sidebar.items.some((row) => row.id === id)).toBe(false);
      await page.getByRole("button", { name: t.subscribeAgain, exact: true }).click();
      await catalog().getByRole("button", { name: t.subscribed, exact: true }).waitFor();
      expect(harness.props({}).sidebar.items.some((row) => row.id === id)).toBe(true);
    });
    test("create a channel through New chat and edit discovery without thread controls", async () => {
      await mount(page, mode.locale);
      const dialog = await newChannel();
      await dialog.getByRole("textbox", { name: t.name, exact: true }).fill("Studio");
      await dialog.getByRole("textbox", { name: t.purpose, exact: true }).fill("Planning the exhibition");
      await dialog.getByRole("button", { name: t.allAuthenticated, exact: true }).click();
      await dialog.getByText(t.discoveryAudience({ count: 42 }), { exact: true }).waitFor();
      await dialog.getByRole("button", { name: t.newChannel, exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await page.getByRole("textbox", { name: t.composerLabel({ title: "Studio" }) }).waitFor();
      await page.getByRole("link", { name: t.chatInfo, exact: true }).filter({ visible: true }).click();
      const info = page.locator("#k2b-workspace-detail-chat-info");
      await info.getByRole("button", { name: t.chatActions({ title: "Studio" }), exact: true }).click();
      expect(await page.getByRole("menuitem").filter({ hasText: t.newThread }).count()).toBe(0);
      await page.getByRole("menuitem", { name: t.discoverySettings, exact: true }).click();
      await dialog.getByRole("textbox", { name: t.purpose, exact: true }).fill("New purpose");
      await dialog.getByText(t.discoveryAudience({ count: 42 }), { exact: true }).waitFor();
      await dialog.getByRole("button", { name: t.save, exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(harness.props({}).sidebar.items[0]?.purpose).toBe("New purpose");
    });
    test("the audience line keeps the dialog still while it counts, fails, and shows the count", async () => {
      await mount(page, mode.locale);
      const dialog = await newChannel();
      const create = dialog.getByRole("button", { name: t.newChannel, exact: true });
      // settled: focus moves between the dialog's fields and fades their colours meanwhile; the spinner runs on, so only
      // finite transitions are awaited before reading geometry.
      const transitionsDone = () =>
        page.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Number.POSITIVE_INFINITY))
              .map((animation) => animation.finished.catch(() => undefined)),
          ),
        );
      let hold: (() => void) | undefined;
      let first = true;
      await page.route("**/api/chat/channels/preview*", async (route) => {
        if (!first) return route.continue();
        first = false;
        await new Promise<void>((resolve) => {
          hold = resolve;
        });
        await route.fulfill({ status: 503, json: { message: "Unavailable" } });
      });
      await dialog.getByRole("button", { name: t.allAuthenticated, exact: true }).click();
      await dialog.getByText(t.countingAudience).waitFor();
      await transitionsDone();
      const counting = await create.boundingBox();
      // Counting fails, then Try again counts: the line keeps its height through all three. The held request may reach
      // the route only after the dialog shows that it counts.
      const deadline = Date.now() + 10_000; // real clock: bounds the wait for the browser's request
      while (!hold && Date.now() < deadline) await Bun.sleep(20); // real clock: polls the route handler
      hold?.();
      await dialog.getByRole("button", { name: t.retry, exact: true }).waitFor();
      await transitionsDone();
      expect(await create.boundingBox()).toEqual(counting);
      await dialog.getByRole("button", { name: t.retry, exact: true }).click();
      await dialog.getByText(t.discoveryAudience({ count: 42 }), { exact: true }).waitFor();
      await transitionsDone();
      expect(await create.boundingBox()).toEqual(counting);
    });
    test("catalog membership is independent of sidebar pagination and returning refreshes the SSR snapshot", async () => {
      const id = harness.addChannel("Atlas", "Already subscribed", true);
      await page.goto(new URL("/app/chat/channels", harness.url).href);
      await page.evaluate(async (locale) => {
        const props = await (await fetch("/__props?path=/app/chat/channels")).json();
        props.channelPage = await (await fetch("/api/chat/channels")).json();
        props.sidebar = { items: [], nextCursor: "later" };
        window.mountChat(props, locale);
      }, mode.locale);
      await catalog().getByRole("button", { name: t.subscribed, exact: true }).click();
      await page.waitForURL(`**/app/chat/c/${id}`);
      harness.rename(id, "Atlas revised");
      await page.goBack();
      await catalog().getByText("Atlas revised", { exact: true }).waitFor();
      expect(await catalog().getByText("Atlas", { exact: true }).count()).toBe(0);
    });
    test("group audiences work when discovery for everyone is disabled, and failed saves keep input", async () => {
      harness.setAllowAuthenticated(false);
      harness.addGroup({ id: "66666666-6666-4666-8666-666666666666", name: "Studio group", size: 7 });
      await mount(page, mode.locale);
      const dialog = await newChannel();
      await dialog.getByRole("combobox", { name: t.findGroup }).waitFor();
      expect(await dialog.getByRole("button", { name: t.allAuthenticated, exact: true }).count()).toBe(0);
      await dialog.getByRole("textbox", { name: t.name, exact: true }).fill("Group news");
      await dialog.getByRole("textbox", { name: t.purpose, exact: true }).fill("News for the studio");
      await dialog.getByRole("combobox", { name: t.findGroup }).fill("Studio");
      await page.getByRole("option", { name: "Studio group", exact: true }).click();
      await dialog.getByText(t.discoveryAudience({ count: 42 }), { exact: true }).waitFor();
      await dialog.getByRole("button", { name: t.newChannel, exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      // The new channel's address follows once it opened.
      await page.waitForURL(/\/app\/chat\/c\/[^/?]+$/);
      const id = new URL(page.url()).pathname.split("/").at(-1)!;
      await page.getByRole("link", { name: t.chatInfo, exact: true }).filter({ visible: true }).click();
      const info = page.locator("#k2b-workspace-detail-chat-info");
      await info.getByRole("button", { name: t.chatActions({ title: "Group news" }), exact: true }).click();
      await page.getByRole("menuitem", { name: t.discoverySettings, exact: true }).click();
      await dialog.getByRole("textbox", { name: t.purpose, exact: true }).fill("Updated purpose");
      await dialog.getByText(t.discoveryAudience({ count: 42 }), { exact: true }).waitFor();
      await page.route(`**/api/chat/conversations/${id}/discovery`, async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        await route.fulfill({ status: 503, json: { message: "Save unavailable" } });
      });
      await dialog.getByRole("button", { name: t.save, exact: true }).click();
      await dialog.getByText("Save unavailable", { exact: true }).waitFor();
      expect(await dialog.getByRole("textbox", { name: t.purpose, exact: true }).inputValue()).toBe("Updated purpose");
      await page.unroute(`**/api/chat/conversations/${id}/discovery`);
      await dialog.getByRole("button", { name: t.save, exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(harness.props({ chat: id }).open?.conversation.purpose).toBe("Updated purpose");
    });
    test("saving over an audience someone else changed is refused and shows the stored one", async () => {
      harness.addGroup({ id: "77777777-7777-4777-8777-777777777777", name: "Press group", size: 3 });
      const id = harness.addChannel("Press", "Press releases", true);
      await mount(page, mode.locale, `/app/chat/c/${id}`);
      await page.getByRole("link", { name: t.chatInfo, exact: true }).filter({ visible: true }).click();
      const info = page.locator("#k2b-workspace-detail-chat-info");
      await info.getByRole("button", { name: t.chatActions({ title: "Press" }), exact: true }).click();
      await page.getByRole("menuitem", { name: t.discoverySettings, exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText(t.discoveryAudience({ count: 42 }), { exact: true }).waitFor();
      // Another admin narrows the audience to a group while this dialog is open.
      harness.setDiscovery(id, [
        { principal: { type: "group", groupId: "77777777-7777-4777-8777-777777777777" }, permission: "read", displayName: "Press group" },
      ]);
      await dialog.getByRole("textbox", { name: t.purpose, exact: true }).fill("Updated releases");
      await dialog.getByRole("button", { name: t.save, exact: true }).click();
      await dialog.getByText(t.discoveryChanged, { exact: true }).waitFor();
      await dialog.getByText("Press group", { exact: true }).waitFor();
      expect(await dialog.getByRole("textbox", { name: t.purpose, exact: true }).inputValue()).toBe("Updated releases");
      // Only the changed purpose and the audience it started from went to the server.
      expect(harness.discoveryUpdates[0]).toMatchObject({ purpose: "Updated releases", revision: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(harness.discoveryUpdates[0]).not.toHaveProperty("name");
      await dialog.getByText(t.discoveryAudience({ count: 42 }), { exact: true }).waitFor();
      await dialog.getByRole("button", { name: t.save, exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(harness.discoveryUpdates.at(-1)?.entries).toEqual([
        { principal: { type: "group", groupId: "77777777-7777-4777-8777-777777777777" }, permission: "read" },
      ]);
    });

    test("the last manager must choose a successor before unsubscribing", async () => {
      const id = harness.addChannel("Design", "Shared decisions", true);
      await mount(page, mode.locale, `/app/chat/c/${id}`);
      await page
        .locator(".chat-conversation__header")
        .getByRole("button", { name: t.chatActions({ title: "Design" }), exact: true })
        .click();
      await page.getByRole("menuitem").filter({ hasText: t.unsubscribeDescription }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText(t.chooseSuccessor, { exact: true }).waitFor();
      expect(await dialog.getByRole("button", { name: t.leaveChat, exact: true }).isDisabled()).toBe(true);
      expect(harness.props({ chat: id }).open?.conversation.member).toBe(true);
      await dialog.getByRole("combobox", { name: t.successor, exact: true }).fill("Nora");
      await page.getByRole("option", { name: "Nora Weber", exact: true }).click();
      await dialog.getByRole("button", { name: t.leaveChat, exact: true }).click();
      await page.waitForURL("**/app/chat/channels");
      expect(harness.props({ chat: id }).open?.conversation.member).toBe(false);
    });
  });
}

// These recovery cases retain the frozen port’s idempotency and audience safeguards.
afterEach(() => harness.reset());
test("disabled authenticated discovery explains removal without an impossible preview retry", async () => {
  const id = harness.addChannel("Design", "Shared decisions", true);
  harness.setAllowAuthenticated(false);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(pinPageClock, chatTestNow.getTime());
  const t = chatMessages.resolve(["en"]).t;
  try {
    await mount(page, "en", `/app/chat/c/${id}?panel=info`);
    const actions = page
      .locator("#k2b-workspace-detail-chat-info")
      .getByRole("button", { name: t.chatActions({ title: "Design" }), exact: true });
    await actions.focus();
    await page.keyboard.press("Enter");
    const settings = page.getByRole("menuitem", { name: t.discoverySettings, exact: true });
    await settings.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await dialog.getByText(t.authenticatedDiscoveryDisabled + " " + t.removeDisabledAudience, { exact: true }).waitFor();
    expect(await dialog.getByRole("button", { name: t.retry, exact: true }).count()).toBe(0);
    expect(await dialog.getByRole("button", { name: t.save, exact: true }).isEnabled()).toBe(false);
    const remove = dialog.getByRole("button", { name: t.removeName({ name: "All signed-in accounts" }), exact: true });
    await remove.focus();
    await page.keyboard.press("Enter");
    await dialog.getByText(t.discoveryAudience({ count: 0 }), { exact: true }).waitFor();
    await dialog.getByRole("button", { name: t.save, exact: true }).focus();
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    expect(harness.props({ chat: id }).open?.conversation).toMatchObject({ channel: false, member: true });
  } finally {
    await context.close();
  }
});

for (const { locale, width } of [
  { locale: "en", width: 1440 },
  { locale: "de", width: 390 },
]) {
  test(`lost channel creation restores its immutable audience on ${locale} ${width}`, async () => {
    const existing = harness.addChannel("Existing channel", "Existing purpose", true);
    const group = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Project Team", size: 3 };
    harness.addGroup(group);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(pinPageClock, chatTestNow.getTime());
    const t = chatMessages.resolve([locale]).t;
    const requests: ReturnType<typeof CreateConversationSchema.parse>[] = [];
    let committed: string | undefined;
    const releaseResponse = Promise.withResolvers<void>();
    try {
      await mount(page, locale);
      await page.route("**/api/chat/conversations", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        requests.push(CreateConversationSchema.parse(route.request().postDataJSON()));
        if (committed) return route.continue();
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        const outcome = CreateOutcomeSchema.parse(await response.json());
        if (outcome.outcome !== "created") throw new Error("Expected a committed channel");
        committed = outcome.conversation.id;
        await releaseResponse.promise;
        await route.abort("failed");
      });
      const entry = async () => {
        await page.getByRole("button", { name: t.newChat, exact: true }).filter({ visible: true }).click();
        await page.getByRole("radio", { name: t.channelChoice, exact: true }).click();
      };
      await entry();
      let dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox", { name: t.name, exact: true }).fill("Recovered channel");
      await dialog.getByRole("textbox", { name: t.purpose, exact: true }).fill("Preserve the agreed audience");
      await dialog.getByRole("button", { name: t.allAuthenticated, exact: true }).click();
      // The next choice is Read; the already chosen authenticated audience remains Write.
      await dialog.getByRole("combobox", { name: t.joiningPermission, exact: true }).click();
      await page.getByRole("option", { name: t.permissionRead, exact: true }).click();
      await dialog.getByRole("combobox", { name: t.findGroup, exact: true }).fill(group.name);
      await page.getByRole("option", { name: group.name, exact: true }).click();
      await dialog.getByText(t.discoveryAudience({ count: 42 }), { exact: true }).waitFor();
      await settled(page);
      const formHeight = await dialog.locator("form").evaluate((element) => element.getBoundingClientRect().height);
      await dialog.getByRole("button", { name: t.newChannel, exact: true }).click();
      await dialog.getByRole("combobox", { name: t.findGroup, exact: true }).waitFor();
      expect(await dialog.getByRole("radio", { name: t.chatChoice, exact: true }).isDisabled()).toBe(true);
      expect(await dialog.getByRole("combobox", { name: t.findGroup, exact: true }).isDisabled()).toBe(true);
      expect(await dialog.getByRole("combobox", { name: t.joiningPermission, exact: true }).isDisabled()).toBe(true);
      await dialog.getByText(t.discoveryAudience({ count: 42 }), { exact: true }).waitFor();
      await settled(page);
      expect(await dialog.locator("form").evaluate((element) => element.getBoundingClientRect().height)).toBe(formHeight);
      releaseResponse.resolve();
      await dialog.getByRole("alert").waitFor();
      const accepted = requests[0]!;
      expect(accepted.discovery).toEqual([
        { principal: { type: "authenticated" }, permission: "write" },
        { principal: { type: "group", groupId: group.id }, permission: "read" },
      ]);
      expect(accepted.createKey).toMatch(/^[0-9a-f-]{36}$/);
      expect(harness.chatCount()).toBe(2);
      await dialog.getByText(t.createRecovery, { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      // A new-channel intent must never replace an existing channel's settings.
      await mount(page, locale, `/app/chat/c/${existing}?panel=info`);
      await page
        .locator("#k2b-workspace-detail-chat-info")
        .getByRole("button", { name: t.chatActions({ title: "Existing channel" }), exact: true })
        .click();
      await page.getByRole("menuitem", { name: t.discoverySettings, exact: true }).click();
      dialog = page.getByRole("dialog");
      expect(await dialog.getByRole("textbox", { name: t.name, exact: true }).inputValue()).toBe("Existing channel");
      expect(await dialog.getByRole("textbox", { name: t.purpose, exact: true }).inputValue()).toBe("Existing purpose");
      expect(await dialog.getByText(t.createRecovery, { exact: true }).count()).toBe(0);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await mount(page, locale);
      harness.setAllowAuthenticated(false);
      await page.route("**/api/chat/channels/options", (route) => route.fulfill({ status: 503, json: { message: "Unavailable" } }));
      await page.route("**/api/chat/channels/preview*", (route) => route.fulfill({ status: 503, json: { message: "Unavailable" } }));
      const restored = async () => {
        await entry();
        dialog = page.getByRole("dialog");
        await dialog.getByText(t.createRecovery, { exact: true }).waitFor();
        expect(await dialog.getByRole("textbox", { name: t.name, exact: true }).inputValue()).toBe("Recovered channel");
        expect(await dialog.getByRole("textbox", { name: t.purpose, exact: true }).inputValue()).toBe("Preserve the agreed audience");
        expect(await dialog.getByRole("textbox", { name: t.name, exact: true }).isDisabled()).toBe(true);
        await dialog.getByText(group.name, { exact: true }).waitFor();
        await dialog.getByText(t.allAuthenticated, { exact: true }).waitFor();
        const groupRole = dialog.getByRole("combobox", { name: `${t.joiningPermission}: ${group.name}`, exact: true });
        expect(await groupRole.isDisabled()).toBe(true);
        expect((await groupRole.textContent())?.trim()).toBe(t.permissionRead);
        expect(
          (
            await dialog.getByRole("combobox", { name: `${t.joiningPermission}: ${t.allAuthenticated}`, exact: true }).textContent()
          )?.trim(),
        ).toBe(t.permissionWrite);
        expect(await dialog.getByRole("combobox", { name: t.joiningPermission, exact: true }).count()).toBe(0);
        expect(await dialog.getByRole("button", { name: t.removeName({ name: group.name }), exact: true }).isDisabled()).toBe(true);
        expect(await dialog.getByRole("button", { name: t.retry, exact: true }).isEnabled()).toBe(true);
      };
      await restored();
      await page.reload();
      await page.evaluate(
        async ({ locale }) => {
          window.mountChat(await (await fetch("/__props?path=/app/chat")).json(), locale);
        },
        { locale },
      );
      await restored();
      await dialog.getByRole("button", { name: t.retry, exact: true }).click();
      await page.waitForURL((url) => url.pathname === `/app/chat/c/${committed}`);
      await page.getByRole("textbox", { name: t.composerLabel({ title: "Recovered channel" }) }).waitFor();
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(accepted);
      expect(harness.chatCount()).toBe(2);
      expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("chat.create:")).length)).toBe(0);
    } finally {
      releaseResponse.resolve();
      await context.close();
    }
  }, 30_000);
  test(`explicit channel Cancel discards a pending intent on ${locale} ${width}`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(pinPageClock, chatTestNow.getTime());
    const t = chatMessages.resolve([locale]).t;
    try {
      await mount(page, locale);
      await page.route("**/api/chat/conversations", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        await route.abort("failed");
      });
      const entry = async () => {
        await page.getByRole("button", { name: t.newChat, exact: true }).filter({ visible: true }).click();
        await page.getByRole("radio", { name: t.channelChoice, exact: true }).click();
      };
      await entry();
      let dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox", { name: t.name, exact: true }).fill("Committed channel");
      await dialog.getByRole("textbox", { name: t.purpose, exact: true }).fill("A retained server result");
      await dialog.getByRole("button", { name: t.allAuthenticated, exact: true }).click();
      await dialog.getByText(t.discoveryAudience({ count: 42 }), { exact: true }).waitFor();
      await dialog.getByRole("button", { name: t.newChannel, exact: true }).click();
      await dialog.getByText(t.createRecovery, { exact: true }).waitFor();
      expect(harness.chatCount()).toBe(1);
      await dialog.getByRole("button", { name: t.cancel, exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("chat.create:")).length)).toBe(0);
      await entry();
      dialog = page.getByRole("dialog");
      expect(await dialog.getByRole("textbox", { name: t.name, exact: true }).inputValue()).toBe("");
      expect(await dialog.getByRole("textbox", { name: t.purpose, exact: true }).inputValue()).toBe("");
      expect(await dialog.getByText(t.createRecovery, { exact: true }).count()).toBe(0);
      expect(harness.chatCount()).toBe(1);
    } finally {
      await context.close();
    }
  }, 30_000);
}
