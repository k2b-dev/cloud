import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../ui/test/browser";
import { nora, pinPageClock, startChatHarness, tobias } from "../ChatWorkspace.browser-fixture";
import { chatShellPage } from "../ChatWorkspace.shell-fixture";

// break-ui on every v2 screen of Chat, at 390 and 1440 px, inside Cloud's shell: the worst realistic data the schema
// allows (a chat's name up to 80 characters, a purpose up to 300, a message up to 20,000 code points; links up to
// 2,048), mixed across rows as real data is. Every screen keeps the v2 rules, nothing grows wider than its column,
// and the composer stays in sight. With CLOUD_CHAT_V2_SHOTS set to a folder, the pictures stay there.
const shots = process.env.CLOUD_CHAT_V2_SHOTS;

let harness: Awaited<ReturnType<typeof startChatHarness>>;
let shell: Awaited<ReturnType<typeof chatShellPage>>;
let browser: Browser;
const ids: Record<"long" | "rtl" | "huge" | "many" | "empty" | "threads", string> = {
  long: "",
  rtl: "",
  huge: "",
  many: "",
  empty: "",
  threads: "",
};

const person = (id: string, name: string) => ({ id: `${id}-0000-4000-8000-000000000000`.slice(0, 36), name });
const aleksandra = person("a1a1a1a1", "Aleksandra Wiśniewska-Kowalczyk");
const bartholomew = person("b2b2b2b2", "bartholomew.fitzgerald@northwind-industries-holdings.example.com");
const jo = person("c3c3c3c3", "Jo");
const layla = person("d4d4d4d4", "ليلى الحسيني");
const hana = person("e5e5e5e5", "鈴木 花子");

const propsFor = (path: string) => {
  const url = new URL(path, "https://chat.test");
  return harness.props({
    chat: /\/c\/([^/]+)/.exec(url.pathname)?.[1],
    thread: /\/t\/([^/]+)/.exec(url.pathname)?.[1],
    threadsPage: url.pathname.endsWith("/threads"),
    forYouPage: url.pathname.endsWith("/for-you"),
    channelsPage: url.pathname.endsWith("/channels"),
    query: url.searchParams.get("q") ?? "",
  });
};

beforeAll(async () => {
  shell = await chatShellPage(
    (request) => {
      const url = new URL(request.url);
      return propsFor(url.pathname + url.search);
    },
    { ui: "v2" },
  );
  harness = await startChatHarness({ renderPage: shell.render });
  for (const entry of [aleksandra, bartholomew, jo, layla, hana]) harness.addPerson(entry);
  const end = harness.now();
  const ago = (minutes: number) => new Date(end.getTime() - minutes * 60_000);
  // The longest name the schema takes (80), an e-mail as a person, two letters, right-to-left, CJK with emoji.
  ids.long = harness.addChat({
    members: [aleksandra, nora],
    name: "Projektabstimmung Lieferantenmanagement Werkstatt Nord und Süd – Quartal 4/2026",
    count: 6,
    end: ago(1),
    unread: 4,
  });
  harness.addChat({ members: [bartholomew], count: 4, end: ago(3), unread: 1 });
  harness.addChat({ members: [jo], count: 3, end: ago(7) });
  ids.rtl = harness.addChat({ members: [layla], name: "مجموعة المشتريات – فرع الرياض", count: 5, end: ago(12) });
  harness.addChat({ members: [hana], name: "東京オフィス · 物流チーム 🚚📦", count: 4, end: ago(30) });
  // A chat nobody wrote in yet, and one muted with mentions waiting.
  ids.empty = harness.addChat({ members: [tobias], name: "Neue Runde", count: 0, end: ago(40) });
  const muted = harness.addChat({ members: [nora, tobias], name: "Kantine", count: 8, end: ago(90), unread: 3 });
  harness.setNotifications(muted, { level: "none", choice: "none", until: null, defaultLevel: "all", following: null }, 2);
  // The largest history a team gathers: ten thousand messages (9,999: the fixture's message IDs carry four digits).
  ids.many = harness.addChat({ members: [nora, tobias, aleksandra], name: "Betrieb", count: 9_999, end: ago(120), spacing: 0.05 });
  // Messages at their limits: a pasted log, a link as long as links get, a word without a break, emoji, RTL.
  ids.huge = harness.addChat({ members: [nora, layla], name: "Störung Lager", count: 3, end: ago(200) });
  const log = Array.from(
    { length: 120 },
    (_, line) =>
      `2026-11-26T22:${String(line % 60).padStart(2, "0")}:07Z WARN lager-sync[${4200 + line}]: retry ${line} for order 4471-${line}`,
  ).join("\n");
  harness.receive(ids.huge, nora, `Der ganze Log von heute Nacht:\n\n\`\`\`\n${log}\n\`\`\``);
  harness.receive(
    ids.huge,
    nora,
    `https://files.example.org/share/s/7f3c2a9e1b4d4c8fa6e0d2b9c1a7e5f3/Lieferantenvertrag_Werkstatt_Nord_2026_final_v12_unterschrieben_gegengezeichnet.pdf?download=1&token=${"9f8e7d6c5b4a".repeat(12)}`,
  );
  harness.receive(ids.huge, aleksandra, "Donaudampfschifffahrtselektrizitätenhauptbetriebswerkbauunterbeamtengesellschaft");
  harness.receive(ids.huge, jo, "🎉🎉🎉");
  harness.receive(ids.huge, layla, "تم إرسال الطلب رقم ٤٤٧١ إلى المورد، وننتظر التأكيد قبل يوم الخميس.");
  // A channel with the longest purpose, one with a single subscriber.
  harness.addChannel(
    "Ankündigungen der Geschäftsführung für alle Standorte, Werkstätten und Außenlager",
    "Hier stehen alle Ankündigungen der Geschäftsführung: Termine der Betriebsversammlungen, Änderungen bei Arbeitszeiten, Urlaubsplanung, neue Regeln für Fahrzeuge und Werkzeuge, Ansprechpersonen für Fragen zur Abrechnung sowie Hinweise zu Schulungen, Arbeitssicherheit und Vertretungen.",
    true,
  );
  harness.addChannel("🎉", "", false);
  // Threads with long names and a full archive.
  ids.threads = harness.addChat({ members: [nora, tobias], name: "Lieferung KW 49", count: 4, end: ago(300) });
  harness.addThread(ids.threads, {
    name: "Rückfrage zur Rechnung 4471 wegen doppelt berechneter Frachtkosten und Zollgebühren",
    count: 3,
    unread: 2,
  });
  harness.addThread(ids.threads, { name: "Q", count: 1 });
  for (let index = 0; index < 12; index += 1) harness.addThread(ids.threads, { name: `Abholung ${index + 1}`, count: 1, archived: true });
  // For you: a mention by the longest name, a reply in an RTL chat.
  const mention = (kind: "mention" | "reply", chat: string, title: string, author: typeof nora, minutes: number, unread: boolean) => ({
    kind,
    conversation: { id: chat, title, kind: "chat" as const },
    thread: { id: "general", name: "General" },
    message: {
      id: `msg${String(minutes).padStart(7, "0")}`,
      seq: minutes,
      author: { type: "user" as const, id: author.id, name: author.name },
      preview: "Kannst du das prüfen?",
      createdAt: ago(minutes).toISOString(),
    },
    unread,
  });
  harness.setForYou([
    mention("mention", ids.long, "Projektabstimmung Lieferantenmanagement Werkstatt Nord und Süd – Quartal 4/2026", aleksandra, 2, true),
    mention("reply", ids.rtl, "مجموعة المشتريات – فرع الرياض", layla, 15, false),
    mention("mention", ids.huge, "Störung Lager", bartholomew, 250, true),
  ]);
  browser = await launchBrowser({ serveShellCatalog: true });
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
  page.setDefaultTimeout(10_000);
  const errors = pageErrors(page);
  await page.goto(new URL(path, harness.url).href);
  await settled(page);
  await page.evaluate(
    ({ props }) => {
      document.getElementById("root")!.replaceChildren();
      return window.mountChat(props, "de", "v2");
    },
    { props: propsFor(path) },
  );
  await settled(page);
  return { page, errors, close: () => context.close() };
};

/** The v2 rules hold, and no row, pane or message grows wider than its column. */
const intact = async (page: Page, width: number, name: string) => {
  // The picture first, so a break is seen as well as named.
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, `${name}-light-${width}.png`) });
  }
  const layout = await measureV2Layout(page, { root: "[data-k2-workspace]", skip: '[data-k2-part="Canvas"]' });
  expect({ name, width, problems: layout.problems }).toEqual({ name, width, problems: [] });
  // v2's rows and panes, and the history itself: nothing scrolls sideways (a message row's hover tools may reach past
  // its edge inside the clipped history; what counts is that the history never scrolls sideways).
  const wide = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-k2-part="Row"], [data-k2-part="Pane"], .k2b-virtual-feed'))
      .filter((element) => element.offsetParent !== null && element.scrollWidth > element.clientWidth + 1)
      .map(
        (element) =>
          `${element.dataset.k2Part ?? element.className}: ${element.textContent?.slice(0, 40)} (${element.scrollWidth}/${element.clientWidth})`,
      ),
  );
  expect({ name, width, wide }).toEqual({ name, width, wide: [] });
};

/** The open page beside the list (on the phone the page itself). */
const detail = (page: Page) => page.locator('[data-k2-part="Pane"][data-detail]');

const screens = (): readonly { name: string; path: () => string; ready: (page: Page) => Promise<unknown> }[] => [
  { name: "11-worst-list", path: () => "/app/chat", ready: (page) => page.getByText("Projektabstimmung").first().waitFor() },
  {
    name: "12-worst-chat",
    path: () => `/app/chat/c/${ids.huge}`,
    ready: (page) => page.locator(".k2b-message-row", { hasText: "Donaudampf" }).first().waitFor(),
  },
  {
    name: "13-worst-rtl",
    path: () => `/app/chat/c/${ids.rtl}`,
    ready: (page) => page.locator(".chat-conversation__composer").waitFor(),
  },
  {
    name: "14-worst-empty",
    path: () => `/app/chat/c/${ids.empty}`,
    ready: (page) => page.locator(".chat-conversation__composer").waitFor(),
  },
  {
    name: "15-worst-10000",
    path: () => `/app/chat/c/${ids.many}`,
    ready: (page) => page.locator(".chat-conversation__composer").waitFor(),
  },
  { name: "16-worst-for-you", path: () => "/app/chat/for-you", ready: (page) => detail(page).getByText("ليلى").first().waitFor() },
  {
    name: "17-worst-channels",
    path: () => "/app/chat/channels",
    ready: (page) => detail(page).getByText("Geschäftsführung").first().waitFor(),
  },
  {
    name: "18-worst-threads",
    path: () => `/app/chat/c/${ids.threads}/threads`,
    ready: (page) => page.getByText("Rückfrage zur Rechnung").first().waitFor(),
  },
];

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const)
  test(`every Chat screen keeps its shape with the worst data at ${width} px`, async () => {
    for (const screen of screens()) {
      // The threads page is the phone's; a wide window opens the chat with its threads in the head.
      if (screen.name === "18-worst-threads" && width > 600) continue;
      const { page, errors, close } = await load(screen.path(), width, height);
      try {
        await screen.ready(page);
        await intact(page, width, screen.name);
        const composer =
          (await page.locator(".chat-conversation__composer").count()) > 0
            ? await page.locator(".chat-conversation__composer").boundingBox()
            : null;
        if (composer)
          expect({ screen: screen.name, bottom: composer.y + composer.height <= height }).toEqual({ screen: screen.name, bottom: true });
        expect({ screen: screen.name, errors }).toEqual({ screen: screen.name, errors: [] });
      } finally {
        await close();
      }
    }
  }, 240_000);

test("about ten thousand messages keep a bounded history in the page", async () => {
  const { page, close } = await load(`/app/chat/c/${ids.many}`, 1440, 900);
  try {
    await page.locator(".chat-conversation__composer").waitFor();
    // The feed renders the rows in view, never the whole history.
    expect(await page.locator(".k2b-virtual-feed__item").count()).toBeLessThan(200);
    expect(await page.evaluate(() => document.querySelectorAll("*").length)).toBeLessThan(6_000);
  } finally {
    await close();
  }
}, 60_000);

// What only a primitive fixes. Each turns into a real assertion when its part lands (owner in the PR text of #4362).
test.todo("every chat row keeps one height with the worst names: Row cuts its title and line 2 with … (MW)", () => {});
test.todo("right-to-left previews and names read right to left inside a row: Row text dir=auto (MW)", () => {});
test.todo("initials skip punctuation, so 東京オフィス · 物流チーム reads 東物 (G, #4376)", () => {});
test.todo("the list sections fold and keep their folded state from the preference (R, Section open/onOpenChange)", () => {});
test.todo("the phone head with only a search takes no room (Z2, #4255)", () => {});
test.todo("the list stays bounded in the DOM at 1,000 chats (MW, #4211)", () => {});
