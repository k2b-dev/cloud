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
    panel: url.searchParams.get("panel") === "info" ? "info" : undefined,
    forYouPage: url.pathname.endsWith("/for-you"),
    channelsPage: url.pathname.endsWith("/channels"),
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
  harness.addThread(open, { name: "Rechnung 4471", count: 4, unread: 1 });
  harness.addThread(open, { name: "Abholung Montag", count: 3 });
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
