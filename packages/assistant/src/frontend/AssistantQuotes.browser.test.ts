import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AiConversation, AiOpenQuestions, AiStoredMessage } from "@k2b/cloud/ai";
import type { Browser, Page, Route } from "playwright";
import { aiQuoteMarker } from "../../../cloud/src/ai/quote-markers";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { emptySidebarSnapshot } from "./AssistantChatSidebar.fixture";

// Quoting in Gustav's chat: text selected in a finished answer or in the person's own message offers "Quote"; the passage
// joins the draft above the field and is saved with it, and a sent message shows what it quoted above its text. The
// whole workspace runs here against routes that answer like the Assistant's server.

const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");
const entry = resolve(import.meta.dir, "AssistantQuotes.browser-entry.tsx");
const fakeLive = resolve(import.meta.dir, "AssistantQuotes.browser-live.ts");
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
/** Pins only the page's Date to `at`; timers and animation frames keep running as in a real browser. */
const pinPageClock = (at: number) => {
  const RealDate = Date;
  const offset = at - RealDate.now(); // real clock: the page's distance to the pinned instant
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0)
        super(RealDate.now() + offset); // real clock: flows from the pinned instant
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now() {
      return RealDate.now() + offset; // real clock: flows from the pinned instant
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
};
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

type Locale = "de" | "en";
type ChatId = "Wart42" | "Tops42" | "Urlb42";

const chat: AiConversation = {
  id: "Wart42",
  shortId: "Wart42",
  title: "Wartung Oktober",
  titleSource: "user",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: at(2),
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "user123",
  createdAt: at(600),
  updatedAt: at(2),
};

const message = (id: string, seq: number, role: "user" | "assistant", texts: string[], minutesAgo: number): AiStoredMessage => ({
  id,
  shortId: id,
  conversationId: "Wart42",
  seq,
  kind: "message",
  message: { role, content: texts.map((text) => ({ type: "text" as const, text })) },
  loopId: `loop-${seq}`,
  modelId: role === "assistant" ? "standard" : null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: role === "assistant" ? "stop" : null,
  compactedAt: null,
  meta: null,
  createdAt: at(minutesAgo),
});

const ANSWER = "Der Stromanschluss mit 3 kW ist im Angebot enthalten. Internet stellt die Messe und rechnet es getrennt ab.";
const PASSAGE = "Internet stellt die Messe";
const history: AiStoredMessage[] = [
  message("u1", 1, "user", ["Was steht im Angebot zu Strom und Internet?"], 30),
  message("a1", 2, "assistant", [ANSWER], 29),
  // A message that quoted an earlier passage shows it above its text.
  message("u2", 3, "user", ["Und was kostet das Internet?", aiQuoteMarker({ from: "assistant", text: PASSAGE })], 20),
  message("a2", 4, "assistant", ["Zuletzt 190,00 € für drei Tage."], 19),
];

/** The server state the routes answer from. */
type State = { locale: Locale; drafts: unknown[] };
const conversationsOf = (_state: State) => [chat];
const questionsOf = (_state: State): AiOpenQuestions => ({ items: [], count: 0 });
const detailOf = (_state: State, _id: ChatId) => ({
  conversation: chat,
  messages: history,
  hasMoreMessages: false,
  activeTurn: null,
  timeline: [],
});

const propsOf = (state: State, url: URL) => {
  const id = (url.searchParams.get("conversation") ?? "Wart42") as ChatId;
  const detail = detailOf(state, id);
  return {
    userId: "user123",
    cloudUrl: assets.url.origin,
    status: {
      ok: true,
      enabled: true,
      status: "ok",
      selection: null,
      effectiveDefault: { class: "balanced" },
      classes: [],
      visionModelConfigured: false,
      error: null,
      options: [],
    },
    models: [{ id: "standard", label: "Standard", description: "", icon: { kind: "mark", text: "AI", color: "0" }, classes: ["balanced"] }],
    selection: null,
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
    projects: [],
    initialProject: null,
    initialProjectChats: null,
    initialProjectContext: null,
    approvals: { page: { items: [], nextCursor: null, count: 0, elsewhere: 0 }, open: false },
  };
};

let browser: Browser;
let assets: ReturnType<typeof Bun.serve>;
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
        name: "assistant-quotes",
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
  // Keep compiled assets off the Playwright route-fulfillment channel, including remote WebKit.
  assets = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/harness.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (path === "/harness.css") return new Response(css, { headers: { "content-type": "text/css" } });
      if (path.startsWith("/ui/")) return new Response(Bun.file(resolve(ui, "dist", path.slice(4))));
      return new Response("Not found", { status: 404 });
    },
  });
  browser = await launchBrowser();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  assets?.stop(true);
});

type View = { name: string; width: number; height: number; touch: boolean; column?: string };
const desktop: View = { name: "1440", width: 1440, height: 900, touch: false };
const phone: View = { name: "390", width: 390, height: 844, touch: true };

const open = async (view: View, state: State, options: { theme?: "light" | "dark"; path?: string } = {}) => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    locale: state.locale,
  });
  await context.addInitScript(pinPageClock, now);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  // Loads the harness does not answer: each one would leave part of the page broken without failing it.
  const unrouted: string[] = [];
  const sidebarLoads: string[] = [];
  const errors = pageErrors(page);
  await page.route(`${assets.url.href}**`, async (route: Route) => {
    const url = new URL(route.request().url());
    if (
      url.pathname === "/harness.js" ||
      url.pathname === "/harness.css" ||
      url.pathname.startsWith("/ui/") ||
      url.pathname === "/api/assistant/artifacts/runtime/chart-parts"
    )
      return route.continue();
    if (url.pathname === "/app/assistant") {
      const harness = { locale: state.locale, props: propsOf(state, url) };
      const column = view.column
        ? `display:flex;justify-content:flex-end;height:100vh` // The panel column sits at the right edge.
        : "display:flex;height:100vh";
      const inner = view.column
        ? `<div id="root" style="width:${view.column};display:flex;height:100vh"></div>`
        : `<div id="root" style="display:flex;width:100%;height:100vh"></div>`;
      return route.fulfill({
        contentType: "text/html",
        body:
          `<!doctype html><html lang="${state.locale}" class="${options.theme ?? "light"}"><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"></head>` +
          `<body class="k2b-ui" style="margin:0"><div style="${column}">${inner}</div>` +
          `<script>window.harness = ${JSON.stringify(harness).replace(/</g, "\\u003c")};</script><script type="module" src="/harness.js"></script></body></html>`,
      });
    }
    if (url.pathname === "/api/assistant/workspace/sidebar") {
      sidebarLoads.push(url.pathname);
      return route.fulfill({ json: { conversations: conversationsOf(state), projects: [], doneCount: 0, questions: questionsOf(state) } });
    }
    const chat = /^\/api\/ai\/conversations\/(Wart42|Tops42|Urlb42)$/.exec(url.pathname);
    if (chat) {
      return route.fulfill({ json: detailOf(state, chat[1] as ChatId) });
    }
    // The draft saves as the server does: what it holds comes back with the next revision.
    if (url.pathname === "/api/ai/conversations/Wart42/draft" && route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { content: unknown[] };
      state.drafts.push(body.content);
      return route.fulfill({ json: { content: body.content, revision: state.drafts.length, updatedAt: new Date(now).toISOString() } });
    }
    // The chat's stream stays open and quiet.
    if (url.pathname.endsWith("/stream")) return;
    if (url.pathname === "/api/approvals") return route.fulfill({ json: { items: [], nextCursor: null, count: 0, elsewhere: 0 } });
    if (url.pathname === "/api/capabilities/v1/queries/core/code.attention.list")
      return route.fulfill({ json: { data: { items: [], nextCursor: null } } });
    if (url.pathname === "/api/capabilities/v1/catalog")
      return route.fulfill({ json: { protocolVersion: 2, apps: [], page: { hasMore: false } } });
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
    // No reading view here, and every chat starts without tabs.
    if (url.pathname === "/api/assistant/workspace/web-reader") return route.fulfill({ json: { available: false } });
    if (/^\/api\/assistant\/workspace\/conversations\/\w+\/tabs$/.test(url.pathname))
      return route.fulfill({
        json:
          route.request().method() === "GET"
            ? { state: { tabs: [], layout: null, front: null }, revision: 0 }
            : { conflict: false, revision: 1 },
      });
    const contextPath = /^\/api\/assistant\/workspace\/conversations\/(\w+)\/context$/.exec(url.pathname);
    if (contextPath) return route.fulfill({ json: emptySidebarSnapshot({ chatId: contextPath[1]! }) });
    unrouted.push(`${route.request().method()} ${url.pathname}`);
    return route.fulfill({ status: 503, json: { message: "unavailable" } });
  });
  await page.goto(`${assets.url.origin}${options.path ?? "/app/assistant?conversation=Wart42"}`);
  await page.locator("textarea").first().waitFor({ timeout: 30_000 });
  return { page, unrouted, errors, sidebarLoads, close: () => context.close() };
};
/** Selects `passage` inside the first element that `selector` names, as a person's drag would. */
const select = (page: Page, selector: string, passage: string) =>
  page.evaluate(
    ([selector, passage]) => {
      const element = document.querySelector(selector!)!;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const start = node.textContent!.indexOf(passage!);
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + passage!.length);
        const selection = document.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      throw new Error(`No text "${passage}" in ${selector}`);
    },
    [selector, passage] as const,
  );

describe("Quoting in Gustav's chat", () => {
  for (const view of [desktop, phone])
    test(`at ${view.name} a passage of an answer joins the draft above the field and is saved with it`, async () => {
      const state: State = { locale: "de", drafts: [] };
      const { page, errors, unrouted, close } = await open(view, state);
      try {
        const answer = ".ai-turn__text[data-answer]";
        await page.locator(answer).first().waitFor();
        await select(page, answer, PASSAGE);
        const quote = page.getByRole("button", { name: "Zitieren" });
        await quote.waitFor();
        await quote.click();
        // The passage stands above the field with whose words it are, and the focus is in the field.
        const row = page.locator(".k2b-chat-composer__quote");
        await row.waitFor();
        expect(await row.textContent()).toContain("Gustav");
        expect(await row.textContent()).toContain(PASSAGE);
        await settled(page);
        expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
        // Set ASSISTANT_SHOTS to a directory to keep a picture of the quote above the field.
        if (process.env.ASSISTANT_SHOTS) await page.screenshot({ path: `${process.env.ASSISTANT_SHOTS}/quote-draft-${view.name}.png` });
        // It is saved with the draft, apart from the text, once the draft's save comes due.
        const saved = () =>
          (state.drafts.at(-1) as unknown[] | undefined)?.some((part) => JSON.stringify(part) === JSON.stringify(expected));
        const expected = { type: "quote", from: "assistant", text: PASSAGE };
        for (let wait = 0; wait < 100 && !saved(); wait++) await page.waitForTimeout(50); // settled: the save is debounced
        expect(saved()).toBe(true);
        // Removed, it leaves the draft.
        await page.getByRole("button", { name: "Zitat entfernen" }).click();
        await row.waitFor({ state: "detached" });
        expect(errors).toEqual([]);
        expect(unrouted).toEqual([]);
      } finally {
        await close();
      }
    }, 60_000);

  test("steps, statuses and quotes are no passage; the person's own text is", async () => {
    const state: State = { locale: "de", drafts: [] };
    const { page, close } = await open(desktop, state);
    try {
      await page.locator(".ai-user-text").first().waitFor();
      // The passage a sent message quoted shows above its text, and selecting in it offers nothing.
      const quoted = page.locator(".ai-user-quotes .k2b-message-quote");
      expect(await quoted.textContent()).toContain(PASSAGE);
      if (process.env.ASSISTANT_SHOTS) await page.screenshot({ path: `${process.env.ASSISTANT_SHOTS}/quote-sent-1440.png` });
      expect(await quoted.textContent()).toContain("Gustav");
      await select(page, ".ai-user-quotes", PASSAGE);
      await settled(page);
      expect(await page.getByRole("button", { name: "Zitieren" }).count()).toBe(0);
      // The person's own words are a passage.
      await select(page, ".ai-user-text", "Strom und Internet");
      await page.getByRole("button", { name: "Zitieren" }).click();
      await page.locator(".k2b-chat-composer__quote").waitFor();
      expect(await page.locator(".k2b-chat-composer__quote").textContent()).toContain("Du");
    } finally {
      await close();
    }
  }, 60_000);
});
