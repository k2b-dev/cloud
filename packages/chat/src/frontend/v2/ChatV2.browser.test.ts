import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../ui/test/browser";
import { nora, pinPageClock, startChatHarness, tobias, viewer } from "../ChatWorkspace.browser-fixture";
import { chatShellPage } from "../ChatWorkspace.shell-fixture";

// Chat on @k2b/ui v2 inside Cloud's real shell: the list beside the open chat at every width, a chat that opens from
// the list in place, the phone's page of one chat with its way back, and the v2 layout rules at 390 and 1440 px.
// With CLOUD_CHAT_V2_SHOTS set to a folder, the test also leaves its pictures there.
const shots = process.env.CLOUD_CHAT_V2_SHOTS;

let harness: Awaited<ReturnType<typeof startChatHarness>>;
let shell: Awaited<ReturnType<typeof chatShellPage>>;
let browser: Browser;
let open: string;
let invoice: string;

const people = [
  { id: "44444444-4444-4444-8444-444444444444", name: "Lena Hoffmann" },
  { id: "55555555-5555-4555-8555-555555555555", name: "Jonas Keller" },
  { id: "66666666-6666-4666-8666-666666666666", name: "Mira Solberg" },
  { id: "77777777-7777-4777-8777-777777777777", name: "Ada Renz" },
  { id: "88888888-8888-4888-8888-888888888888", name: "Felix Braun" },
  { id: "99999999-9999-4999-8999-999999999999", name: "Sara Yilmaz" },
] as const;

/** The page's props as the server reads them from the address. */
const propsFor = (path: string) => {
  const url = new URL(path, "https://chat.test");
  return harness.props({
    chat: /\/c\/([^/]+)/.exec(url.pathname)?.[1],
    thread: /\/t\/([^/]+)/.exec(url.pathname)?.[1],
    panel: url.searchParams.get("panel") === "info" ? "info" : undefined,
    forYouPage: url.pathname.endsWith("/for-you"),
    channelsPage: url.pathname.endsWith("/channels"),
    threadsPage: url.pathname.endsWith("/threads"),
    query: url.searchParams.get("q") ?? "",
  });
};

const pin = (chat: string) =>
  harness.fetch(
    new Request(new URL(`/api/chat/conversations/${chat}/personal`, harness.url), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    }),
  );

beforeAll(async () => {
  shell = await chatShellPage(
    (request) => {
      const url = new URL(request.url);
      return propsFor(url.pathname + url.search);
    },
    { ui: "v2" },
  );
  harness = await startChatHarness({ renderPage: shell.render });
  for (const person of people) harness.addPerson(person);
  const [lena, jonas, mira, ada, felix, sara] = people;
  const end = harness.now();
  const minutes = (count: number) => new Date(end.getTime() - count * 60_000);
  // A screen full of chats as a team has them: people, groups, pins, channels, some unread.
  const workshop = harness.addChat({ members: [nora, tobias, lena], name: "Werkstatt Nord", count: 9, end: minutes(4), unread: 2 });
  harness.addChat({ members: [nora], count: 6, end: minutes(12), unread: 3 });
  open = harness.addChat({ members: [tobias, jonas, mira], name: "Lieferung KW 49", count: 14, end: minutes(25), spacing: 2 });
  invoice = harness.addThread(open, { name: "Rechnung 4471", count: 4, unread: 1 });
  harness.addThread(open, { name: "Abholung Montag", count: 3 });
  harness.setNotifications(open, { level: "mentions", choice: "mentions", until: null, defaultLevel: "all", following: null });
  harness.addChat({ members: [lena], count: 5, end: minutes(48) });
  harness.addChat({ members: [jonas], count: 4, end: minutes(95), unread: 1 });
  harness.addChat({ members: [ada, felix], name: "Messe Leipzig", count: 7, end: minutes(180) });
  harness.addChat({ members: [mira], count: 3, end: minutes(60 * 20) });
  harness.addChat({ members: [felix], count: 5, end: minutes(60 * 30) });
  harness.addChat({ members: [sara], count: 2, end: minutes(60 * 50) });
  harness.addChat({ members: [ada], count: 4, end: minutes(60 * 75) });
  harness.addChannel("Ankündigungen", "News for the whole team", true);
  harness.addChannel("IT-Hilfe", "Questions about devices and accounts", true);
  await pin(workshop);
  browser = await launchBrowser({ serveShellCatalog: true });
  void viewer;
}, 240_000);
afterAll(async () => {
  await browser?.close();
  harness?.stop();
  shell?.stop();
});

const load = async (path: string, width: number, height: number) => {
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone, colorScheme: "light" });
  await context.addInitScript(pinPageClock, harness.now().getTime());
  await context.addCookies([{ url: harness.url, name: "theme", value: "light" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  const errors = pageErrors(page);
  await page.goto(new URL(path, harness.url).href);
  await settled(page);
  await page.evaluate(
    ({ props }) => {
      document.getElementById("root")!.replaceChildren();
      return window.mountChat(props, "en", "v2");
    },
    { props: propsFor(path) },
  );
  await settled(page);
  return { page, errors, close: () => context.close() };
};

const shoot = async (page: Page, name: string) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
};

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const) {
  test(`the list and the open chat keep the v2 rules at ${width} px`, async () => {
    const { page, errors, close } = await load(`/app/chat/c/${open}`, width, height);
    try {
      await page.locator(".chat-conversation__composer").waitFor();
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]", skip: '[data-k2-part="Canvas"]' });
      expect({ width, problems: layout.problems }).toEqual({ width, problems: [] });
      // The composer stands inside the screen, under the history, at every width.
      const composer = await page.locator(".chat-conversation__composer").boundingBox();
      expect(composer).not.toBeNull();
      expect(composer!.y + composer!.height).toBeLessThanOrEqual(height);
      // The pictures show the real shell: its logo loads (the fixture serves Cloud's own).
      const logo = page.locator('img[src="/branding/logo"]').first();
      if (await logo.isVisible()) expect(await logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
      await shoot(page, `02-chat-light-${width}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);
}

test("a chat opens from the list in place and the list stays", async () => {
  const { page, errors, close } = await load("/app/chat", 1440, 900);
  try {
    await shoot(page, "01-list-light-1440");
    await page.locator('[data-k2-part="Row"]', { hasText: "Lieferung KW 49" }).first().locator("a").click();
    await page.waitForURL(new RegExp(`/app/chat/c/${open}`));
    await page.locator(".chat-conversation__composer").waitFor();
    expect(await page.locator('[data-k2-part="Row"][data-current]', { hasText: "Lieferung KW 49" }).count()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

test("on the phone the list is the page, a chat is a page of its own, and its way back returns to the list", async () => {
  const { page, errors, close } = await load("/app/chat", 390, 844);
  try {
    const row = page.locator('[data-k2-part="Row"]', { hasText: "Werkstatt Nord" }).first();
    await row.waitFor();
    const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
    expect(layout.problems).toEqual([]);
    await shoot(page, "01-list-light-390");
    await row.locator("a").click();
    await page.waitForURL(/\/app\/chat\/c\//);
    await page.locator(".chat-conversation__composer").waitFor();
    expect(await row.isVisible()).toBe(false);
    await settled(page);
    // The way back stands in the phone bar and takes a tap: nothing of the chat lies over it.
    const hit = await page.evaluate(() => {
      const back = document.querySelector<HTMLElement>('[data-k2-part="Back"] a')!;
      const box = back.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { box: [box.left, box.top, box.width, box.height], top: top?.outerHTML.slice(0, 160), inside: back.contains(top) };
    });
    expect({ inside: hit.inside, top: hit.top }).toEqual({ inside: true, top: expect.any(String) });
    await page.locator('[data-k2-part="Back"] a').first().click();
    await page.waitForURL((url) => url.pathname === "/app/chat");
    await row.waitFor();
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

for (const [width, height] of [
  [1024, 768],
  [1920, 1080],
] as const)
  test(`the chat page at ${width} px`, async () => {
    const { page, errors, close } = await load(`/app/chat/c/${open}`, width, height);
    try {
      await page.locator(".chat-conversation__composer").waitFor();
      await shoot(page, `02-chat-light-${width}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

test("For you lists who mentioned or answered the reader, and a row opens the message", async () => {
  const it = harness.addChat({ members: [nora, tobias], name: "IT", count: 3, end: new Date(harness.now().getTime() - 3_600_000) });
  const item = (kind: "mention" | "reply", author: typeof nora, unread: boolean, minutes: number) => ({
    kind,
    conversation: { id: it, title: "IT", kind: "chat" as const },
    thread: { id: "general", name: "General" },
    message: {
      id: `msg${String(minutes).padStart(7, "0")}`,
      seq: minutes,
      author: { type: "user" as const, id: author.id, name: author.name },
      preview: "Can you look at it?",
      createdAt: new Date(harness.now().getTime() - minutes * 60_000).toISOString(),
    },
    unread,
  });
  harness.setForYou([item("mention", nora, true, 5), item("reply", tobias, false, 50)]);
  const { page, errors, close } = await load("/app/chat/for-you", 1440, 900);
  try {
    const rows = page.locator('[data-k2-part="Row"]', { hasText: "mentioned you" });
    await rows.first().waitFor();
    expect(await page.locator('[data-k2-part="Row"]', { hasText: "Tobias replied to you" }).count()).toBe(1);
    const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
    expect(layout.problems).toEqual([]);
    await shoot(page, "04-for-you-light-1440");
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

test("Discover channels lists the channels, and Subscribe subscribes in place", async () => {
  harness.addChannel("Werkstatt-Termine", "Dates and slots of the workshop", false);
  const { page, errors, close } = await load("/app/chat/channels", 1440, 900);
  try {
    const row = page.locator('[data-k2-part="Row"]', { hasText: "Werkstatt-Termine" });
    await row.waitFor();
    const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
    expect(layout.problems).toEqual([]);
    await shoot(page, "05-channels-light-1440");
    await row.getByRole("button", { name: "Subscribe" }).click();
    await row.getByRole("button", { name: "Subscribed" }).waitFor();
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

test("on the phone a chat with threads opens its threads first, and a thread opens from there", async () => {
  const { page, errors, close } = await load("/app/chat", 390, 844);
  try {
    await page.locator('[data-k2-part="Row"]', { hasText: "Lieferung KW 49" }).first().locator("a").click();
    await page.waitForURL(new RegExp(`/app/chat/c/${open}/threads`));
    const thread = page.locator('[data-k2-part="Row"]', { hasText: "Rechnung 4471" });
    await thread.waitFor();
    expect(await page.locator('[data-k2-part="Row"]', { hasText: "Abholung Montag" }).count()).toBeGreaterThan(0);
    const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
    expect(layout.problems).toEqual([]);
    await shoot(page, "07-threads-light-390");
    await thread.locator("a").click();
    await page.waitForURL(new RegExp(`/app/chat/c/${open}/t/`));
    await page.locator(".chat-conversation__composer").waitFor();
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const)
  test(`the chat's info shows its purpose, notifications and members at ${width} px`, async () => {
    const { page, errors, close } = await load(`/app/chat/c/${open}?panel=info`, width, height);
    try {
      const info = page.locator('[data-k2-part="Pane"][aria-label="Chat info"]');
      await info.locator('[data-k2-part="Row"]', { hasText: "Tobias Brandt" }).waitFor();
      expect(await info.getByText("Notifications").count()).toBeGreaterThan(0);
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]", skip: '[data-k2-part="Canvas"]' });
      expect({ width, problems: layout.problems }).toEqual({ width, problems: [] });
      await shoot(page, `08-info-light-${width}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

test("a mention that arrives live shows as '@' on its row and moves no row", async () => {
  const { page, errors, close } = await load("/app/chat", 1440, 900);
  try {
    const first = page.locator('[data-k2-part="Row"]').first();
    await first.waitFor();
    const before = await first.boundingBox();
    // An existing chat: the list keeps its order while messages arrive elsewhere, as in v1. A message in a thread
    // reads the chat's row again, with its "@" count from the server; it is said once, on the row.
    harness.setNotifications(open, { level: "mentions", choice: "mentions", until: null, defaultLevel: "all", following: null }, 2);
    harness.receiveIn(open, nora, "@Robin kannst du das prüfen?", { thread: invoice });
    await page.locator('[data-k2-part="Row"]', { hasText: "Lieferung KW 49" }).locator(".k2-row-meta", { hasText: "@" }).waitFor();
    expect(await first.boundingBox()).toEqual(before);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

/** A place with three discussions about its items: one done, one with a new message, one open. */
const placeWithDiscussions = (name: string) => {
  const place = harness.addChat({ members: [nora, tobias], name, count: 3, end: harness.now() });
  harness.setSystem(place, { type: "spaces.space", id: `Space-${name}` });
  const threads = ["Einladung freigeben", "Besichtigung", "Aufbau"].map((title, index) => {
    const thread = harness.addThread(place, {
      name: title,
      count: 1,
      unread: index === 1 ? 1 : 0,
      end: new Date(harness.now().getTime() - (3 - index) * 30_000),
    });
    harness.resourceThread(place, thread, {
      ref: { type: "spaces.item", id: `${name}-Item0${index}` },
      title,
      permission: "read",
      typeTitle: "Item",
      icon: "ti ti-package",
      status: index === 0 ? "Erledigt" : "Offen",
      done: index === 0,
      href: `/app/spaces/items/${name}-Item0${index}`,
    });
    return thread;
  });
  return { place, threads };
};

// B (study v2-chat-threads-study, Valentin's v8 comment on the discussions column): a place has no column of its own.
// Its "General" stream holds its discussions as cards at their last activity; a card opens the discussion as a page
// of its own, whose way back leads to the place.
for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const)
  test(`a place's discussions stand as cards in its General stream and open as pages that lead back, at ${width} px`, async () => {
    const { place, threads } = placeWithDiscussions(`Ausstellung ${width}`);
    const { page, errors, close } = await load(`/app/chat/c/${place}/t/general`, width, height);
    try {
      const cards = page.locator(".chat-discussion");
      await cards.first().waitFor();
      // by their last activity, the done one first; state in words, the new one marked
      expect(await cards.locator(".chat-discussion__name").allInnerTexts()).toEqual(["Einladung freigeben", "Besichtigung", "Aufbau"]);
      expect(await cards.nth(0).locator(".chat-discussion__state").innerText()).toBe("Erledigt");
      expect(await cards.nth(1).getAttribute("data-unread")).toBe("");
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]", skip: '[data-k2-part="Canvas"]' });
      expect({ width, problems: layout.problems }).toEqual({ width, problems: [] });
      await shoot(page, `09-discussions-light-${width}`);
      // a card opens its discussion as a page, named after the item, with the place as its way back
      await cards.nth(1).click();
      await page.waitForURL(new RegExp(`/c/${place}/t/${threads[1]}`));
      await page.locator(".chat-conversation__composer").waitFor();
      const detail = page.locator('[data-k2-part="Pane"][data-detail]');
      await detail.locator('[data-k2-part="RecordHead"]', { hasText: "Besichtigung" }).waitFor();
      await shoot(page, `09-discussion-open-light-${width}`);
      const back = page.locator('[data-k2-part="Back"] a', { hasText: `Ausstellung ${width}` }).first();
      if (width < 768) {
        await back.click();
        await page.waitForURL(new RegExp(`/c/${place}/t/general`));
        await cards.first().waitFor();
      } else expect(await back.getAttribute("href")).toContain(`/c/${place}/t/general`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 90_000);

test("a place's head menu filters its cards by state and finds the discussions of that state from the server", async () => {
  const { place } = placeWithDiscussions("Filterort");
  const { page, errors, close } = await load(`/app/chat/c/${place}/t/general`, 1440, 900);
  try {
    const cards = page.locator(".chat-discussion");
    await cards.first().waitFor();
    const before = harness.systemRequests.length;
    await page.locator('[data-k2-part="Pane"][data-detail] [data-slot="head"] button[aria-haspopup="menu"]').first().click();
    await page.getByRole("menuitemradio", { name: "Done" }).click();
    // the cards follow at once; the server's list for "done" is asked for
    await page.waitForFunction(() => document.querySelectorAll(".chat-discussion").length === 1);
    expect(await cards.locator(".chat-discussion__name").allInnerTexts()).toEqual(["Einladung freigeben"]);
    const asked = () => harness.systemRequests.slice(before).some((request) => request.query.filter === "done");
    for (let tries = 0; tries < 50 && !asked(); tries++) await page.waitForTimeout(100);
    expect(asked()).toBe(true);
    // the menu lists the server's discussions of that state, each opening its page
    await page.locator('[data-k2-part="Pane"][data-detail] [data-slot="head"] button[aria-haspopup="menu"]').first().click();
    await page.getByRole("menuitemradio", { name: /Einladung freigeben/ }).waitFor();
    expect(await page.getByRole("menuitemradio", { name: /Besichtigung/ }).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

test("a chat the reader may not see says so without naming it, and leads back to the chats", async () => {
  const { page, errors, close } = await load("/app/chat/c/Nope0001", 1440, 900);
  try {
    const detail = page.locator('[data-k2-part="Pane"][data-detail]');
    await detail.locator('[data-k2-part="Empty"]').waitFor();
    expect(await detail.getByText("This chat does not exist, or you are not a member of it.").count()).toBe(1);
    const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
    expect(layout.problems).toEqual([]);
    await shoot(page, "10-no-access-light-1440");
    await detail.getByRole("link", { name: "Back to chats" }).click();
    await page.waitForURL((url) => url.pathname === "/app/chat");
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

// Read state on v2 (the old suites mount v1): opening reports the read and clears the row, the marker stands before the
// first unread message, and "Mark unread" from the row's menu makes the row unread again.
test("opening an unread chat reports the read and clears its row, and Mark unread brings it back", async () => {
  const chat = harness.addChat({ members: [nora], name: "Lesestand Lager", count: 12, unread: 4, end: harness.now() });
  const start = harness.props({ chat }).open!.conversation.read!.lastReadSeq!;
  const { page, errors, close } = await load("/app/chat", 1440, 900);
  try {
    const row = page.locator('[data-k2-part="Row"]', { hasText: "Lesestand Lager" }).first();
    await row.waitFor();
    expect(await row.getAttribute("data-unread")).toBe("");
    expect(await row.locator(".k2-row-meta").innerText()).toBe("4");
    await row.locator("a").first().click();
    await page.waitForURL(new RegExp(`/app/chat/c/${chat}`));
    const marker = page.locator(".k2b-virtual-feed__marker");
    await marker.waitFor();
    expect(await marker.evaluate((element) => element.closest("[data-key]")?.getAttribute("data-key"))).toBe(
      `${chat}${String(start + 1).padStart(4, "0")}`,
    );
    for (let tries = 0; tries < 100 && !harness.reads.some((read) => read.chat === chat); tries++) await page.waitForTimeout(100);
    expect(harness.reads.some((read) => read.chat === chat && read.seq > start)).toBe(true);
    await page.waitForFunction((title) => {
      const found = [...document.querySelectorAll<HTMLElement>('[data-k2-part="Row"]')].find((entry) => entry.textContent?.includes(title));
      return found !== undefined && !found.hasAttribute("data-unread");
    }, "Lesestand Lager");
    // The row's menu: "Mark unread" makes it unread again, as v1's does.
    await row.hover();
    await row.locator('button[aria-haspopup="menu"]').click();
    await page.getByRole("menuitem", { name: "Mark unread" }).click();
    await page.waitForFunction((title) => {
      const found = [...document.querySelectorAll<HTMLElement>('[data-k2-part="Row"]')].find((entry) => entry.textContent?.includes(title));
      return found?.hasAttribute("data-unread") === true;
    }, "Lesestand Lager");
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

// break-ui: the worst names and counts a list meets. Rows keep their sign and time, names are cut with "…", nothing
// leaves its column, and the v2 rules hold at both widths. Last in the file: these chats join the list from here on.
test("the list keeps its shape with the worst names and counts", async () => {
  const end = harness.now();
  harness.addPerson({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Q" });
  harness.addPerson({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Maximiliane Alexandra von Hohenzollern-Sigmaringen-Wittelsbach" });
  harness.addChat({ members: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Q" }], count: 4, end });
  harness.addChat({
    members: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Maximiliane Alexandra von Hohenzollern-Sigmaringen-Wittelsbach" }],
    count: 130,
    unread: 120,
    end,
    spacing: 0.1,
  });
  harness.addChat({ members: [nora], name: "projektabstimmung.lieferanten.werkstatt-nord@example.org", count: 3, end });
  harness.addChat({ members: [tobias], name: "東京オフィス · 物流チーム 🚚📦", count: 3, end });
  harness.addChannel("🎉", "", true);
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    const { page, errors, close } = await load("/app/chat", width, height);
    try {
      await page.locator('[data-k2-part="Row"]', { hasText: "Hohenzollern" }).first().waitFor();
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
      expect({ width, problems: layout.problems }).toEqual({ width, problems: [] });
      // No row grows wider than its list.
      const overflow = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-k2-part="Row"]')).filter((row) => row.scrollWidth > row.clientWidth + 1)
            .length,
      );
      expect(overflow).toBe(0);
      await shoot(page, `06-worst-light-${width}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }
}, 120_000);
