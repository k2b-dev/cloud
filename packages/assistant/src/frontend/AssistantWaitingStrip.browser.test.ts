import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AiConversation, AiOpenQuestion, AiOpenQuestions, AiStoredMessage, AiTurnBlock } from "@k2b/cloud/ai";
import type { Browser, Page, Route } from "playwright";
import { actionFixtures } from "../../../cloud/src/ai/chat/action-question.fixtures";
import { openQuestionFromRow } from "../../../cloud/src/ai/open-questions";
import { launchBrowser } from "../../../ui/test/browser";
import { emptySidebarSnapshot } from "./AssistantChatSidebar.fixture";

// "Waiting for you" is layout and focus: its reserved row, whether it shows while a card's answers are in view, a
// jump into another chat that lands on the sentence, and the slash list over it. The whole workspace runs here against
// routes that answer like the Assistant's server, with live updates driven by the test.

const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");
const entry = resolve(import.meta.dir, "AssistantWaitingStrip.browser-entry.tsx");
const fakeLive = resolve(import.meta.dir, "AssistantWaitingStrip.browser-live.ts");
const entrySource = `
import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import AssistantWorkspace from ${JSON.stringify(resolve(import.meta.dir, "AssistantWorkspace.island.tsx"))};

render(
  () => (
    <LocaleProvider locale={window.harness.locale}>
      <AssistantWorkspace {...window.harness.props} />
    </LocaleProvider>
  ),
  document.getElementById("root"),
);
`;
// The live socket is the test's: \`window.live\` holds the handlers the workspace subscribed with.
const fakeLiveSource = `
export const liveConnection = () => ({
  subscribe: (_channel, _scope, handlers) => {
    window.live = handlers;
    return { close() {} };
  },
});
`;

// One fixed clock for fixtures and page.
const now = Date.parse("2026-10-17T12:10:00.000Z");
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

type Locale = "de" | "en";
type Scenario = "three" | "two" | "one" | "none";
type ChatId = "Wart42" | "Tops42" | "Urlb42";

const titles = (locale: Locale): Record<ChatId, string> => ({
  Wart42: locale === "de" ? "Wartung Oktober" : "October maintenance",
  Tops42: "Team Ops Wochenplanung",
  Urlb42: locale === "de" ? "Urlaubsplanung" : "Vacation planning",
});

/** Which question is open where, as the multi scenario of the card mockup: 3, 2 and none pending, plus one alone. */
const pendingKeys = (scenario: Scenario): { Wart42: ("mail" | "del")[]; Tops42: "routine"[] } =>
  scenario === "three"
    ? { Wart42: ["mail", "del"], Tops42: ["routine"] }
    : scenario === "two"
      ? { Wart42: ["del"], Tops42: ["routine"] }
      : scenario === "one"
        ? { Wart42: ["mail"], Tops42: [] }
        : { Wart42: [], Tops42: [] };

const conversation = (locale: Locale, id: ChatId, minutesAgo: number, waiting: boolean): AiConversation => ({
  id,
  shortId: id,
  title: titles(locale)[id],
  titleSource: "user",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: at(minutesAgo),
  archivedAt: null,
  runStatus: waiting ? "needs_attention" : "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "user123",
  createdAt: at(600),
  updatedAt: at(minutesAgo),
});

const message = (id: string, seq: number, role: "user" | "assistant", text: string, minutesAgo: number): AiStoredMessage => ({
  id,
  shortId: id,
  conversationId: "Wart42",
  seq,
  kind: "message",
  message: role === "user" ? { role, content: [{ type: "text", text }] } : { role, content: [{ type: "text", text }] },
  loopId: null,
  modelProfileId: role === "assistant" ? "standard" : null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta: null,
  createdAt: at(minutesAgo),
});

/** The server state the routes answer from; a test changes it and tells the page through `window.live`. */
type State = { locale: Locale; scenario: Scenario };

const tools = (locale: Locale) => {
  const fixtures = actionFixtures(locale);
  return { mail: fixtures.mail!.block, del: fixtures.del!.block, routine: fixtures.routine!.block };
};

const toolBlock = (locale: Locale, key: "mail" | "del" | "routine", open: boolean): AiTurnBlock => {
  const block = tools(locale)[key];
  return open ? block : { ...block, status: key === "del" ? "rejected" : "completed", result: { ok: true } };
};

/** A question as the server's read presents it from the chat's tool block. */
const question = (locale: Locale, key: "mail" | "del" | "routine", chat: ChatId, minutesAgo: number): AiOpenQuestion => {
  const block = tools(locale)[key] as Extract<AiTurnBlock, { kind: "tool" }>;
  return openQuestionFromRow(
    {
      id: `req-${key}`,
      conversationId: chat,
      conversationTitle: titles(locale)[chat],
      displayCallId: block.callId,
      appId: block.presentation?.kind === "capability" ? block.presentation.appId : "core",
      sentence: "",
      toolName: block.name,
      createdAt: new Date(at(minutesAgo)),
      block,
    },
    { locale, timeZone: "Europe/Berlin" },
  );
};

const questionsOf = (state: State): AiOpenQuestions => {
  const pending = pendingKeys(state.scenario);
  const items: AiOpenQuestion[] = [
    ...pending.Wart42.map((key, index) => ({ key, chat: "Wart42" as const, minutesAgo: 4 - index })),
    ...pending.Tops42.map((key) => ({ key, chat: "Tops42" as const, minutesAgo: 40 })),
  ]
    .map(({ key, chat, minutesAgo }) => question(state.locale, key, chat, minutesAgo))
    // Newest first, as the server reads them.
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { items, count: items.length };
};

const conversationsOf = (state: State) => {
  const pending = pendingKeys(state.scenario);
  return [
    conversation(state.locale, "Wart42", 2, pending.Wart42.length > 0),
    conversation(state.locale, "Tops42", 40, pending.Tops42.length > 0),
    conversation(state.locale, "Urlb42", 90, false),
  ];
};

const detailOf = (state: State, id: ChatId) => {
  const de = state.locale === "de";
  const pending = pendingKeys(state.scenario);
  const chat = conversationsOf(state).find((item) => item.id === id)!;
  // A long history above the questions, so they can scroll out of view.
  const history = Array.from({ length: 6 }, (_, index) => [
    message(`u${index}`, index * 2 + 1, "user", de ? `Frage ${index + 1} zur Wartung im Oktober.` : `Question ${index + 1} about the October maintenance.`, 300 - index * 20),
    message(
      `a${index}`,
      index * 2 + 2,
      "assistant",
      de
        ? "Ich habe die Termine geprüft. Das Wartungsfenster liegt am Dienstag von 18 bis 20 Uhr, Mail und Files sind in der Zeit kurz nicht erreichbar. Die Retro am Freitag steht einmal im Kalender."
        : "I checked the dates. The maintenance window is on Tuesday from 6 to 8 pm; Mail and Files are briefly unavailable then. Friday's retro is in the calendar once.",
      299 - index * 20,
    ),
  ]).flat();
  const blocks: AiTurnBlock[] =
    id === "Wart42"
      ? [
          { id: "intro", kind: "text", text: de ? "Zwei Dinge brauchen dein Ja:" : "Two things need your yes:" },
          toolBlock(state.locale, "mail", pending.Wart42.includes("mail")),
          ...(state.scenario === "one" ? [] : [toolBlock(state.locale, "del", pending.Wart42.includes("del"))]),
        ]
      : id === "Tops42"
        ? [{ id: "intro", kind: "text", text: de ? "Das richte ich als Routine ein." : "I'll set this up as a routine." }, toolBlock(state.locale, "routine", pending.Tops42.length > 0)]
        : [];
  const waiting = blocks.some((block) => block.kind === "tool" && block.status === "awaiting_approval");
  return {
    conversation: chat,
    messages: id === "Wart42" ? history : [],
    hasMoreMessages: false,
    activeTurn: blocks.length
      ? {
          turnId: `turn-${id}`,
          attempt: 1,
          seq: 20,
          status: waiting ? "waiting_for_action" : "completed",
          blocks,
          modelProfileId: "standard",
          createdAt: at(5),
        }
      : null,
    timeline: [],
  };
};

const propsOf = (state: State, url: URL) => {
  const id = (url.searchParams.get("conversation") ?? "Wart42") as ChatId;
  const detail = detailOf(state, id);
  return {
    userId: "user123",
    cloudUrl: "http://localhost:4799",
    status: { ok: true, enabled: true, defaultModelId: "standard", visionModelConfigured: false, error: null, models: [] },
    models: [{ id: "standard", label: "Standard", provider: "ollama", model: "standard", capabilities: ["streaming"], dataBoundary: "private" }],
    lastModelId: "standard",
    timeZone: "Europe/Berlin",
    renderedAt: new Date(now).toISOString(),
    initialLiveCursor: "s6t.cloud-live-core.0",
    initialConversations: conversationsOf(state),
    initialDoneCount: 0,
    initialQuestions: questionsOf(state),
    initialConversationId: id,
    initialArtifactPath: null,
    initialWorkspaceHref: `${url.pathname}${url.search}`,
    initialDetail: detail,
    initialContext: null,
    initialContextClosed: true,
    projects: [],
    initialProject: null,
    initialProjectChats: null,
    initialProjectContext: null,
    approvals: { page: { items: [], nextCursor: null, count: 0, elsewhere: 0 }, open: false },
  };
};

let browser: Browser;
let css: string;
let script: string;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: entrySource, [fakeLive]: fakeLiveSource },
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "assistant-waiting-strip",
        setup(builder) {
          builder.onResolve({ filter: /^@k2b\/cloud\/browser\/live$/ }, () => ({ path: fakeLive }));
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const source = path === entry ? entrySource : await Bun.file(path).text();
            const result = await transformAsync(source, {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the Assistant workspace harness.");
  script = await build.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", cloud))).default;
  const stylesheets = [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")];
  const outputs = await Promise.all(
    stylesheets.map(async (path) => {
      const output = await Bun.build({ entrypoints: [path], plugins: [tailwind] });
      if (!output.success) throw new AggregateError(output.logs, `Could not compile ${path}.`);
      return output.outputs[0]!.text();
    }),
  );
  // Icons and the typeface load from @k2b/ui's build, so rows look and measure as they do in Cloud.
  const fonts = ["plex.css", "tabler.css"]
    .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, "url($1/ui/"))
    .join("\n");
  css = [fonts, "@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  browser = await launchBrowser();
}, 180_000);
afterAll(async () => {
  await browser?.close();
});

type View = { name: string; width: number; height: number; touch: boolean; column?: string };
const desktop: View = { name: "1440", width: 1440, height: 900, touch: false };
const phone: View = { name: "390", width: 390, height: 844, touch: true };
// The side panel the Assistant moves into: a 22 rem column at the right edge of a wide screen.
const panel: View = { name: "panel", width: 1440, height: 900, touch: false, column: "22rem" };

const open = async (view: View, state: State, options: { theme?: "light" | "dark"; path?: string } = {}) => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    locale: state.locale,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.clock.setFixedTime(now);
  const unexpected: string[] = [];
  const sidebarLoads: string[] = [];
  page.on("pageerror", (error) => unexpected.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") unexpected.push(`console: ${message.text()}`);
  });
  await page.route("http://localhost:4799/**", async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/harness.js") return route.fulfill({ body: script, contentType: "text/javascript" });
    if (url.pathname.startsWith("/ui/")) return route.fulfill({ path: resolve(ui, "dist", url.pathname.slice(4)) });
    if (url.pathname === "/app/assistant") {
      const harness = { locale: state.locale, props: propsOf(state, url) };
      const column = view.column
        ? `display:flex;justify-content:flex-end;height:100vh` // The panel column sits at the right edge.
        : "display:flex;height:100vh";
      const inner = view.column ? `<div id="root" style="width:${view.column};display:flex;height:100vh"></div>` : `<div id="root" style="display:flex;width:100%;height:100vh"></div>`;
      return route.fulfill({
        contentType: "text/html",
        body:
          `<!doctype html><html lang="${state.locale}" class="${options.theme ?? "light"}"><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
          `<body class="k2b-ui" style="margin:0"><div style="${column}">${inner}</div>` +
          `<script>window.harness = ${JSON.stringify(harness).replace(/</g, "\\u003c")};</script><script src="/harness.js"></script></body></html>`,
      });
    }
    if (url.pathname === "/api/assistant/workspace/sidebar") {
      sidebarLoads.push(url.pathname);
      return route.fulfill({ json: { conversations: conversationsOf(state), projects: [], doneCount: 0, questions: questionsOf(state) } });
    }
    const chat = /^\/api\/ai\/conversations\/(Wart42|Tops42|Urlb42)$/.exec(url.pathname);
    if (chat) return route.fulfill({ json: detailOf(state, chat[1] as ChatId) });
    // The chat's stream stays open and quiet.
    if (url.pathname.endsWith("/stream")) return;
    if (url.pathname === "/api/approvals") return route.fulfill({ json: { items: [], nextCursor: null, count: 0, elsewhere: 0 } });
    if (url.pathname === "/api/capabilities/v1/catalog") return route.fulfill({ json: { protocolVersion: 2, apps: [], page: { hasMore: false } } });
    // The rest of the chat's own loads answer empty, so the page shows nothing but the chat.
    const empty: Record<string, unknown> = {
      "/api/ai/resources/recent": { resources: [] },
      "/api/ai/quotas": { enabled: false, balances: [] },
      "/api/ai/skills": { skills: [] },
      "/api/ai/tasks": [],
    };
    if (url.pathname in empty) return route.fulfill({ json: empty[url.pathname] });
    if (url.pathname.endsWith("/viewed")) return route.fulfill({ status: 204 });
    if (url.pathname.endsWith("/queue")) return route.fulfill({ json: [] });
    if (url.pathname.endsWith("/dictations")) return route.fulfill({ json: { items: [], nextCursor: null } });
    const contextPath = /^\/api\/assistant\/workspace\/conversations\/(\w+)\/context$/.exec(url.pathname);
    if (contextPath) return route.fulfill({ json: emptySidebarSnapshot({ chatId: contextPath[1]! }) });
    unexpected.push(`${route.request().method()} ${url.pathname}`);
    return route.fulfill({ status: 503, json: { message: "unavailable" } });
  });
  await page.goto(`http://localhost:4799${options.path ?? "/app/assistant?conversation=Wart42"}`);
  try {
    await page.locator("textarea").first().waitFor({ timeout: 30_000 });
  } catch (error) {
    await page.screenshot({ path: "/tmp/s1-3b/shots/debug-open.png" });
    console.log("DEBUG", unexpected, await page.locator("body").innerHTML().then((h) => h.slice(0, 3000)));
    throw error;
  }
  return { page, unexpected, sidebarLoads, close: async () => { if (unexpected.length) console.log("DEBUG", unexpected); await context.close(); } };
};

const strip = (page: Page) => page.locator("nav.assistant-waiting");
const entries = (page: Page) =>
  strip(page)
    .locator(".assistant-waiting__entry")
    .evaluateAll((buttons) => buttons.map((button) => (button.textContent ?? "").replace(/\s+/g, " ").trim()));
const rect = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { top: Math.round(box.top), bottom: Math.round(box.bottom), left: Math.round(box.left), right: Math.round(box.right), height: Math.round(box.height) };
    });
const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const until = async (page: Page, condition: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await page.waitForTimeout(25);
  }
  throw new Error(`Did not settle: ${what}`);
};
/** Tells the page that the owner's chats changed, as Core's socket does. */
const changed = (page: Page, conversationId: string | null) =>
  page.evaluate(
    ([conversationId, at]) =>
      (window as unknown as { live: { apply: (events: unknown[]) => Promise<void> } }).live.apply([
        {
          data: { type: "ai.invalidated", changeId: crypto.randomUUID(), conversationId, projectId: null, domains: ["conversation-list", "conversation-detail"], at },
          cursor: `s6t.cloud-live-core.${Date.now()}`,
        },
      ]),
    [conversationId, new Date(now).toISOString()] as const,
  );
/** Scrolls the chat's timeline: the scrollable ancestor of its first message. */
const scrollTimeline = (page: Page, to: "top" | "end") =>
  page.locator(".k2b-chat-decision").first().evaluate((card, to) => {
    let scroller: HTMLElement | null = card.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY)))
      scroller = scroller.parentElement;
    if (!scroller) throw new Error("No scrolling timeline");
    scroller.scrollTop = to === "top" ? 0 : scroller.scrollHeight;
  }, to);
const focusedSentence = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    return active?.classList.contains("k2b-chat-decision__sentence") ? (active.closest("[data-chat-anchor]")?.getAttribute("data-chat-anchor") ?? "") : null;
  });

const short = (locale: Locale, key: "mail" | "del" | "routine") => question(locale, key, "Wart42", 0).short;
const height = (view: View) => (view.touch ? 44 : 40);

describe("Waiting for you", () => {
  for (const view of [desktop, phone, panel])
    for (const theme of ["light", "dark"] as const)
      test(`3, 2 and none pending at ${view.name} in ${theme}: one row above the field, no Approve all`, async () => {
        const state: State = { locale: "de", scenario: "three" };
        const { page, unexpected, close } = await open(view, state, { theme });
        try {
          await strip(page).waitFor();
          expect(await strip(page).getAttribute("aria-label")).toBe("Wartet auf dich");
          // This chat's questions first, in the order they were asked, then the other chat's with its name.
          expect(await entries(page)).toEqual([short("de", "mail"), short("de", "del"), `${short("de", "routine")} in Team Ops Wochenplanung`]);
          expect(await strip(page).getAttribute("data-quiet")).toBeNull();
          // Every entry is a ghost button; there is no way to answer several at once.
          expect(await strip(page).locator(".assistant-waiting__entry").count()).toBe(3);
          expect(await strip(page).locator(".assistant-waiting__entry:not([data-variant='ghost'])").count()).toBe(0);
          expect(await page.getByRole("button", { name: /alle (freigeben|bestätigen|erlauben)|approve all/i }).count()).toBe(0);
          // The row sits right above the field, inside the composer's width, at one fixed height; it scrolls sideways.
          const row = await rect(page, "nav.assistant-waiting");
          const field = await rect(page, ".k2b-chat-composer");
          expect(row.bottom).toBeLessThanOrEqual(field.top + 1);
          expect(field.top - row.bottom).toBeLessThanOrEqual(12);
          expect(row.left).toBeGreaterThanOrEqual(field.left - 1);
          expect(row.right).toBeLessThanOrEqual(field.right + 1);
          expect(row.height).toBe(height(view));
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          const composerTop = field.top;

          // Two pending: the mail was answered elsewhere; the row and the field stay where they were.
          state.scenario = "two";
          await changed(page, "Wart42");
          await until(page, async () => (await entries(page)).length === 2, "two entries");
          expect(await entries(page)).toEqual([short("de", "del"), `${short("de", "routine")} in Team Ops Wochenplanung`]);
          expect(await rect(page, "nav.assistant-waiting")).toEqual(row);
          expect((await rect(page, ".k2b-chat-composer")).top).toBe(composerTop);

          // None pending: no row, as in the mockup.
          state.scenario = "none";
          await changed(page, null);
          await strip(page).waitFor({ state: "detached" });
          expect(unexpected.filter((line) => line.startsWith("pageerror"))).toEqual([]);
        } finally {
          await close();
        }
      }, 60_000);

  for (const view of [desktop, phone, panel])
    test(`one question here at ${view.name}: the row keeps its place hidden while its answers are in view`, async () => {
      const { page, unexpected, close } = await open(view, { locale: "de", scenario: "one" });
      try {
        await page.locator(".k2b-chat-decision__answers").first().waitFor();
        await strip(page).waitFor({ state: "attached" });
        await settle(page);
        // The chat opens at its end, where the answers are.
        expect(await strip(page).getAttribute("data-quiet")).toBe("");
        expect(await strip(page).evaluate((nav) => getComputedStyle(nav).visibility)).toBe("hidden");
        const row = await rect(page, "nav.assistant-waiting");
        const field = await rect(page, ".k2b-chat-composer");
        expect(row.height).toBe(height(view));
        // Hidden, it is out of the tab order and the accessibility tree.
        expect(await page.getByRole("navigation", { name: "Wartet auf dich" }).count()).toBe(0);

        await scrollTimeline(page, "top");
        await until(page, async () => (await strip(page).getAttribute("data-quiet")) === null, "row shows");
        expect(await strip(page).evaluate((nav) => getComputedStyle(nav).visibility)).toBe("visible");
        expect(await entries(page)).toEqual([short("de", "mail")]);
        // The reserved place: nothing moved.
        expect(await rect(page, "nav.assistant-waiting")).toEqual(row);
        expect(await rect(page, ".k2b-chat-composer")).toEqual(field);

        // The entry leads back to the question.
        await strip(page).locator(".assistant-waiting__entry").first().click();
        await until(page, async () => (await focusedSentence(page)) === "tool-mail-1", "sentence focused");
        await until(page, async () => (await strip(page).getAttribute("data-quiet")) === "", "row hides again");
        expect(await rect(page, "nav.assistant-waiting")).toEqual(row);
        expect(await rect(page, ".k2b-chat-composer")).toEqual(field);
        expect(unexpected.filter((line) => line.startsWith("pageerror"))).toEqual([]);
      } finally {
        await close();
      }
    }, 60_000);

  for (const view of [desktop, phone])
    test(`a jump into another chat at ${view.name} focuses its sentence; reload and back keep the place`, async () => {
      const state: State = { locale: "de", scenario: "three" };
      const { page, unexpected, close } = await open(view, state);
      try {
        await strip(page).waitFor();
        await strip(page).getByRole("button", { name: /in Team Ops Wochenplanung/ }).click();
        await page.waitForURL(/conversation=Tops42$/);
        await until(page, async () => (await focusedSentence(page)) === "tool-routine-1", "sentence of the other chat focused");
        // The sentence is in view, and the open chat's question now leads the row; the others name their chat.
        const sentence = await rect(page, '[data-chat-anchor="tool-routine-1"] .k2b-chat-decision__sentence');
        expect(sentence.top).toBeGreaterThanOrEqual(0);
        expect(sentence.bottom).toBeLessThanOrEqual((await rect(page, "nav.assistant-waiting")).top);
        const there = [short("de", "routine"), `${short("de", "mail")} in Wartung Oktober`, `${short("de", "del")} in Wartung Oktober`];
        expect(await entries(page)).toEqual(there);

        await page.reload();
        await strip(page).waitFor();
        expect(new URL(page.url()).search).toBe("?conversation=Tops42");
        expect(await entries(page)).toEqual(there);

        await page.goBack();
        await page.waitForURL(/conversation=Wart42$/);
        await until(page, async () => (await entries(page))[0] === short("de", "mail"), "first chat's row");
        expect(await entries(page)).toEqual([short("de", "mail"), short("de", "del"), `${short("de", "routine")} in Team Ops Wochenplanung`]);

        // A jump in the open chat stays in it and lands on that sentence.
        await strip(page).locator(".assistant-waiting__entry").nth(1).click();
        await until(page, async () => (await focusedSentence(page)) === "tool-del-1", "sentence in this chat focused");
        expect(new URL(page.url()).search).toBe("?conversation=Wart42");
        expect(unexpected.filter((line) => line.startsWith("pageerror"))).toEqual([]);
      } finally {
        await close();
      }
    }, 60_000);

  for (const view of [desktop, phone, panel])
    test(`the slash list at ${view.name} opens over the row without moving it or the field`, async () => {
      const { page, close } = await open(view, { locale: "de", scenario: "three" });
      try {
        await strip(page).waitFor();
        const row = await rect(page, "nav.assistant-waiting");
        const field = await rect(page, ".k2b-chat-composer");
        await page.locator("textarea").first().focus();
        await page.keyboard.type("/");
        const list = page.locator('.k2b-chat-composer-accessory[data-commands] [role="listbox"]');
        await list.waitFor();
        const box = await rect(page, '.k2b-chat-composer-accessory[data-commands] [role="listbox"]');
        // The list stands over the row's place and ends at the field.
        expect(box.bottom).toBeLessThanOrEqual(field.top + 1);
        expect(box.top).toBeLessThan(row.top);
        expect(await strip(page).evaluate((nav) => getComputedStyle(nav).visibility)).toBe("hidden");
        expect(await rect(page, "nav.assistant-waiting")).toEqual(row);
        expect(await rect(page, ".k2b-chat-composer")).toEqual(field);
        await page.keyboard.press("Escape");
        await list.waitFor({ state: "detached" });
        expect(await strip(page).evaluate((nav) => getComputedStyle(nav).visibility)).toBe("visible");
        expect(await rect(page, "nav.assistant-waiting")).toEqual(row);
      } finally {
        await close();
      }
    }, 60_000);
});
