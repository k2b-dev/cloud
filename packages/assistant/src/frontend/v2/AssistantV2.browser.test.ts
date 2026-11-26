import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appAccentStyle, appV2InkStyle } from "@k2b/cloud/ssr/app-appearance";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page, Route } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";
import { FIXTURE_NOW as APPS_NOW, myAppsFixture } from "../code-overview.fixture";
import {
  type AssistantV2FixtureState,
  FIXTURE_APPROVAL,
  FIXTURE_AUTOMATIONS,
  FIXTURE_MESSAGES,
  FIXTURE_NOW,
  FIXTURE_OPEN_ID,
  FIXTURE_PLACE_CHATS,
  FIXTURE_QUESTIONS,
  FIXTURE_WORST_MESSAGES,
  fixtureConversations,
  fixtureProjects,
} from "./assistant-v2.fixture";

// The Assistant's page on v2, inside Cloud's shell: the sidebar, the head, a chat with its answers and the composer.
// The test stands in for the server: the page gets the props the server renders, the API answers from the same
// invented data. Set ASSISTANT_V2_SHOTS=<dir> to keep the pictures for the design review.

const ui = resolve(import.meta.dir, "../../../../ui");
const cloud = resolve(import.meta.dir, "../../../../cloud");
const entry = resolve(import.meta.dir, "AssistantV2.browser-harness.tsx");
const fakeLive = resolve(import.meta.dir, "AssistantV2.browser-live.ts");
const fakeLiveSource = "export const liveConnection = () => ({ subscribe: () => ({ close() {} }) });\n";
const shots = process.env.ASSISTANT_V2_SHOTS?.trim();
const ORIGIN = "https://cloud.example.test";
const plum = "#8e1b6f";

type View = { name: string; width: number; height: number; touch: boolean };
const wide: View = { name: "1440", width: 1440, height: 900, touch: false };
const narrow: View = { name: "1024", width: 1024, height: 768, touch: false };
const phone: View = { name: "390", width: 390, height: 844, touch: true };
const large: View = { name: "1920", width: 1920, height: 1080, touch: false };

const pinPageClock = (instant: number) => {
  const RealDate = Date;
  const offset = instant - RealDate.now(); // real clock: the page's distance to the pinned instant
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

const MODELS = [
  {
    id: "standard",
    label: "Standard",
    description: "Für den Alltag",
    icon: { kind: "mark", text: "AI", color: "0" },
    classes: ["balanced"],
  },
];
/** The open chat's context as the server reads it: no files or results yet. */
const contextOf = (chatId: string) => ({
  chatId,
  viewerUserId: "user-mira",
  now: FIXTURE_NOW,
  timeZone: "Europe/Berlin",
  results: [],
  resultsTruncated: false,
  files: [],
  fileCount: 0,
  working: { groups: [], groupCount: 0, looseFiles: [], count: 0, bytes: 0 },
  storage: { usedBytes: 0, maxBytes: 1_000_000_000 },
  sources: [],
  sourceCount: 0,
  sourceCursor: null,
  skills: [],
  memories: [
    { id: "mem-1", content: "Rechnungen von Steinwerk Nord immer gegen das Angebot prüfen." },
    {
      id: "mem-2",
      content:
        "Bei Abweichungen zwischen Rechnung und Angebot zuerst die Montagestunden, dann die Anfahrt und zuletzt Materialpreise vergleichen; Rückfragen an Lieferanten freundlich und kurz formulieren, mit Rechnungsnummer, Datum des Angebots, genauer Position und dem Betrag der Abweichung, und nie ohne Rücksprache mit Mira einen Abzug ankündigen, auch wenn die Abweichung eindeutig ist und der Lieferant schon öfter falsch abgerechnet hat.",
    },
  ],
  runCount: 0,
  runs: [],
});

type Scene = {
  state?: AssistantV2FixtureState;
  open?: boolean;
  waiting?: boolean;
  tabs?: boolean;
  archived?: boolean;
  /** The page's clock, when the scene's data has its own day (My apps & automations). */
  now?: string;
};
/** A web page the person left open beside the chat, as the server stores the chat's tabs. */
const storedTabs = (chatId: string) => ({
  chatId,
  snapshot: {
    revision: 1,
    state: {
      tabs: [{ id: "web-1", key: JSON.stringify(["web", chatId, "https://lieferant.example.org/katalog"]), title: "Lieferant" }],
      layout: null,
      front: "web-1",
    },
  },
});
const propsOf = (scene: Scene, url: URL) => {
  const state = scene.state ?? "usual";
  const conversations = fixtureConversations(state);
  const openId =
    scene.open === false || url.searchParams.has("approvals")
      ? null
      : (url.searchParams.get("conversation") ?? (state === "usual" ? FIXTURE_OPEN_ID : state === "worst" ? "Wst001" : null));
  const open = openId ? conversations.find((conversation) => conversation.id === openId) : undefined;
  return {
    embedded: false,
    userId: "user-mira",
    cloudUrl: ORIGIN,
    status: {
      ok: true,
      enabled: true,
      status: "ok",
      selection: null,
      effectiveDefault: { class: "balanced" },
      classes: [{ class: "balanced", variantId: "standard" }],
      visionModelConfigured: false,
      error: null,
      options: MODELS,
    },
    models: MODELS,
    timeZone: "Europe/Berlin",
    renderedAt: FIXTURE_NOW,
    initialLiveCursor: "s6t.cloud-live-core.0",
    initialConversations: conversations,
    initialCounts: {
      unread: 0,
      needsAttention: 0,
      places: { total: state === "empty" ? 0 : FIXTURE_PLACE_CHATS.length, unread: 0, needsAttention: 0 },
      hasArchived: Boolean(scene.archived),
    },
    initialDoneCount: conversations.filter((conversation) => conversation.isDone).length,
    // The server lists at most 100 open chats and says when more exist (AI_SIDEBAR_CONVERSATIONS_MAX).
    initialMoreConversations: state === "huge",
    initialPlaceChats: state === "empty" ? { total: 0, items: [] } : { total: FIXTURE_PLACE_CHATS.length, items: FIXTURE_PLACE_CHATS },
    initialQuestions: scene.waiting ? FIXTURE_QUESTIONS : { items: [], count: 0 },
    initialConversationId: open?.id ?? null,
    initialArtifactPath: null,
    initialWorkspaceHref: `${url.pathname}${url.search}`,
    initialDetail: open
      ? {
          conversation: open,
          messages: (state === "worst" ? FIXTURE_WORST_MESSAGES : FIXTURE_MESSAGES).map((entry) => ({ ...entry, conversationId: open.id })),
          hasMoreMessages: false,
          activeTurn: null,
          timeline: [],
        }
      : null,
    initialContext: open ? contextOf(open.id) : null,
    initialTabs: open && scene.tabs ? storedTabs(open.id) : null,
    projects: fixtureProjects(state),
    initialProject: null,
    initialProjectChats: null,
    initialProjectContext: null,
    approvals:
      url.searchParams.get("approvals") === "1"
        ? {
            page: { items: scene.waiting ? [FIXTURE_APPROVAL] : [], nextCursor: null, count: scene.waiting ? 1 : 0, elsewhere: 0 },
            open: true,
          }
        : { page: { items: [], nextCursor: null, count: 0, elsewhere: 0 }, open: false },
    ...(url.searchParams.get("approvals") === "1" ? { initialAutomations: scene.waiting ? FIXTURE_AUTOMATIONS : [] } : {}),
    code:
      url.pathname === "/app/assistant/code"
        ? { has: true, open: true, page: myAppsFixture("normal").initial }
        : { has: true, open: false },
    initialCodeBlock: null,
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
    files: { [fakeLive]: fakeLiveSource },
    target: "browser",
    format: "esm",
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "assistant-v2",
        setup(builder) {
          builder.onResolve({ filter: /^@k2b\/cloud\/browser\/live$/ }, () => ({ path: fakeLive }));
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the Assistant v2 harness.");
  script = await build.outputs.find((output) => output.kind === "entry-point")!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", cloud))).default;
  const stylesheets = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const outputs = await Promise.all(
    stylesheets.map(async (path) => {
      const output = await Bun.build({ entrypoints: [path], plugins: [tailwind] });
      if (!output.success) throw new AggregateError(output.logs, `Could not compile ${path}.`);
      return output.outputs[0]!.text();
    }),
  );
  const fonts = ["plex.css", "tabler.css"]
    .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, "url($1/ui/"))
    .join("\n");
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = [fonts, "@layer properties, theme, base, components, utilities;", ...outputs, v2Css].join("\n");
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const open = async (view: View, address: string, scene: Scene = {}) => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    colorScheme: "light",
    locale: "de",
    timezoneId: "Europe/Berlin",
  });
  await context.addInitScript(pinPageClock, Date.parse(scene.now ?? FIXTURE_NOW));
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = pageErrors(page);
  const unanswered: string[] = [];
  const calls: string[] = [];
  const posted: { path: string; body: unknown }[] = [];
  let created = 0;
  const sent: string[] = [];
  await page.route(`${ORIGIN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/app/assistant" || url.pathname === "/app/assistant/code") {
      const harness = { locale: "de", props: propsOf(scene, url) };
      const colors = [appAccentStyle(plum), appV2InkStyle(plum)].filter(Boolean).join(";");
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body:
          `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"></head>` +
          `<body class="k2b-ui app-accent-scope" data-k2b-primary="ai" style="margin:0;${colors}"><div id="root"></div>` +
          `<script>window.harness = ${JSON.stringify(harness).replace(/</g, "\\u003c")};</script>` +
          `<script type="module" src="/harness.js"></script></body></html>`,
      });
    }
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
    if (url.pathname === "/harness.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    if (url.pathname.startsWith("/ui/")) return route.fulfill({ path: resolve(ui, "dist", url.pathname.slice(4)) });
    calls.push(`${method} ${url.pathname}${url.search}`);
    const conversations = fixtureConversations(scene.state ?? "usual");
    if (method !== "GET") posted.push({ path: url.pathname, body: route.request().postDataJSON() });
    if (url.pathname === "/api/ai/conversations" && method === "POST") {
      created++;
      return route.fulfill({
        status: 201,
        json: {
          ...conversations[0],
          id: "New001",
          shortId: "New001",
          title: "Neuer Chat",
          titleSource: "default",
          pinnedAt: null,
          runStatus: "idle",
          unreadCompletion: false,
          projectId: null,
        },
      });
    }
    if (url.pathname.startsWith("/api/approvals/") && method === "POST")
      return route.fulfill({ json: { id: FIXTURE_APPROVAL.id, status: "approved", outcome: "approved" } });
    const done = /^\/api\/assistant\/workspace\/conversations\/([^/]+)\/done$/.exec(url.pathname);
    if (done && method !== "GET") {
      const found = conversations.find((conversation) => conversation.id === done[1]);
      return route.fulfill({ json: { ...found, isDone: true } });
    }
    const preview = /^\/api\/assistant\/workspace\/conversations\/([^/]+)\/preview$/.exec(url.pathname);
    if (preview) return route.fulfill({ json: { model: "Standard", files: [{ path: "/Rechnung 2026-118.pdf" }], hasMoreSources: false } });
    const chat = /^\/api\/ai\/conversations\/(\w+)(\/.*)?$/.exec(url.pathname);
    if (chat) {
      const [, , suffix = ""] = chat;
      if (suffix === "/stream") return; // stays open like a quiet stream
      if (suffix === "/viewed") return route.fulfill({ json: {} });
      if (suffix === "/dictations") return route.fulfill({ json: { items: [], nextCursor: null } });
      if (suffix === "/queue" || suffix === "/timeline") return route.fulfill({ json: [] });
      const openChat = conversations.find((conversation) => conversation.id === chat[1]) ?? null;
      if (suffix === "/draft" && method === "PUT") {
        const body = route.request().postDataJSON() as { content: unknown; expectedRevision?: number };
        return route.fulfill({ json: { content: body.content, revision: (body.expectedRevision ?? 0) + 1, updatedAt: FIXTURE_NOW } });
      }
      if (suffix === "/turns" && method === "POST") {
        const body = route.request().postDataJSON() as { message?: string; content?: unknown };
        sent.push(JSON.stringify(body));
        return route.fulfill({ status: 201, json: { turn: { id: "turn9", status: "completed" }, message: FIXTURE_MESSAGES[0] } });
      }
      if (suffix === "/archive" && method === "POST") return route.fulfill({ status: 204 });
      if (suffix === "" && method === "GET" && openChat) {
        // After a message went out, the chat holds it and Gustav's finished answer: the stream has ended.
        const answered = sent.length > 0;
        return route.fulfill({
          json: {
            conversation: { ...openChat, draft: { content: [], revision: answered ? 9 : 0, updatedAt: FIXTURE_NOW } },
            messages: [
              ...FIXTURE_MESSAGES.map((entry) => ({ ...entry, conversationId: openChat.id })),
              ...(answered
                ? [
                    {
                      ...FIXTURE_MESSAGES[2]!,
                      id: "m5",
                      shortId: "m5",
                      seq: 5,
                      conversationId: openChat.id,
                      message: { role: "user", content: [{ type: "text", text: "Und die Anfahrt?" }] },
                    },
                    {
                      ...FIXTURE_MESSAGES[3]!,
                      id: "m6",
                      shortId: "m6",
                      seq: 6,
                      conversationId: openChat.id,
                      message: { role: "assistant", content: [{ type: "text", text: "Die Anfahrt war nicht vereinbart." }] },
                    },
                  ]
                : []),
            ],
            hasMoreMessages: false,
            activeTurn: null,
            timeline: [],
          },
        });
      }
    }
    const chatContext = /^\/api\/assistant\/workspace\/conversations\/(\w+)\/context$/.exec(url.pathname);
    if (chatContext) return route.fulfill({ json: contextOf(chatContext[1]!) });
    if (/^\/api\/assistant\/workspace\/projects\/\w+\/context$/.test(url.pathname))
      return route.fulfill({
        json: { projectId: url.pathname.split("/")[5], knowledge: [], files: [], references: [], skills: { items: [] } },
      });
    if (url.pathname === "/api/assistant/workspace/sidebar") {
      const state = scene.state ?? "usual";
      return route.fulfill({
        json: {
          conversations,
          counts: {
            unread: 0,
            needsAttention: 0,
            places: { total: FIXTURE_PLACE_CHATS.length, unread: 0, needsAttention: 0 },
            hasArchived: false,
          },
          placeChats: state === "empty" ? { total: 0, items: [] } : { total: FIXTURE_PLACE_CHATS.length, items: FIXTURE_PLACE_CHATS },
          projects: fixtureProjects(state),
          doneCount: conversations.filter((conversation) => conversation.isDone).length,
          moreConversations: state === "huge",
          questions: scene.waiting ? FIXTURE_QUESTIONS : { items: [], count: 0 },
        },
      });
    }
    const quiet: Record<string, unknown> = {
      "/api/ai/resources/recent": { resources: [] },
      "/api/ai/quotas": { enabled: false, balances: [] },
      "/api/approvals/counts": { total: 0, apps: {} },
      "/api/assistant/workspace/web-reader": { available: false },
      "/api/apps/badges": { total: 0, apps: {} },
    };
    if (url.pathname in quiet) return route.fulfill({ json: quiet[url.pathname] });
    if (url.pathname === "/branding/logo")
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="5" fill="#334155"/></svg>',
      });
    unanswered.push(`${method} ${url.pathname}`);
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await page.goto(`${ORIGIN}${address}`);
  await page.waitForSelector('body[data-ready="true"]');
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  return { context, page, errors, unanswered, calls, posted, sent, created: () => created };
};

/** The rules of v2 on the resting page: no outline problem and no layout finding outside the chat's own drawing. */
const layoutProblems = async (page: Page): Promise<string[]> => {
  await page.mouse.move(0, 0);
  const outline = await describeV2Page(page, "[data-k2-workspace]");
  const layout = await measureV2Layout(page, { root: "[data-k2-workspace]", skip: "[data-k2-canvas]" });
  return [...(outline.includes("Problems (") ? [outline] : []), ...layout.problems];
};

/** Waits for something the test's routes saw, at most five seconds. */
const until = async (seen: () => boolean) => {
  for (let tries = 0; tries < 50 && !seen(); tries++) await Bun.sleep(100);
};

const shoot = async (page: Page, name: string) => {
  if (!shots) return;
  await page.screenshot({ path: resolve(shots, `${name}.png`) });
};

describe("Assistant on v2", () => {
  for (const view of [wide, narrow, phone])
    for (const state of ["usual", "worst", "empty"] as const)
      test(`${view.name} ${state}: the page keeps the v2 rules and shows no loading on its first picture`, async () => {
        const { context, page, errors, unanswered } = await open(view, "/app/assistant", { state });
        try {
          await shoot(page, `${view.name}-${state}`);
          expect(await page.locator('[data-k2-part="Loading"]').count()).toBe(0);
          expect(await layoutProblems(page)).toEqual([]);
          expect(errors).toEqual([]);
          expect(unanswered).toEqual([]);
        } finally {
          await context.close();
        }
      }, 60_000);

  for (const view of [phone, narrow, wide, large])
    test(`${view.name}: My apps & automations states today's runs, shows the day and one row per app that opens its Code`, async () => {
      const { context, page, errors, unanswered } = await open(view, "/app/assistant/code", { open: false, now: APPS_NOW });
      try {
        const pane = page.locator('[data-k2-part="Pane"][aria-label="Meine Apps & Automationen"]');
        // The phone shows the table as rows of two lines; every width has the links to the Code.
        await pane.locator('a[href^="/app/assistant/code/c_"]').first().waitFor();
        await settled(page);
        await shoot(page, `${view.name}-apps`);
        expect(await pane.locator('[data-k2-part="StatusRow"]').textContent()).toContain("Läufe heute");
        // One row per app, in the server's order, each a link to its Code (the day line's marks are links too).
        const rows = await pane.evaluate((root) =>
          [...root.querySelectorAll<HTMLAnchorElement>('a[href^="/app/assistant/code/c_"]')]
            .filter((link) => !link.closest(".assistant-apps__today") && link.getClientRects().length > 0)
            // On the phone the link lies over its row of two lines; the row carries the words.
            .map((link) => (link.textContent?.trim() || link.parentElement?.textContent?.trim()) ?? ""),
        );
        const titles = ["Wochenbericht Vertrieb", "Rückfragen sammeln", "Stoffpreise prüfen", "Angebote nachfassen"];
        expect(rows).toHaveLength(titles.length);
        for (const [index, title] of titles.entries()) expect(rows[index]).toContain(title);
        expect(await layoutProblems(page)).toEqual([]);
        expect(errors).toEqual([]);
        expect(unanswered).toEqual([]);
      } finally {
        await context.close();
      }
    }, 60_000);

  test("on the phone the chat fills the screen and its composer stands in view", async () => {
    const { context, page, errors } = await open(phone, "/app/assistant");
    try {
      const composer = page.locator(".assistant-chat-composer");
      const rect = await composer.boundingBox();
      expect(rect && rect.y + rect.height <= phone.height).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("New chat in the sidebar starts a chat and names it in the head", async () => {
    const { context, page, errors, created } = await open(wide, "/app/assistant");
    try {
      await page.getByRole("button", { name: "Neuer Chat" }).click();
      await page.waitForURL(/conversation=New001/);
      expect(created()).toBe(1);
      expect(await page.locator('[data-k2-part="Path"]').textContent()).toContain("Neuer Chat");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a message goes out from the composer in the v2 pane", async () => {
    const { context, page, errors, sent, posted } = await open(wide, "/app/assistant");
    try {
      const field = page.locator(".assistant-chat-composer textarea").first();
      await field.fill("Und die Anfahrt?");
      await field.press("Enter");
      await until(() => sent.length > 0);
      // The answer streams through Cloud's shared chat parts (tested with them); here the turn goes out with its text.
      expect(posted.some((entry) => entry.path.endsWith("/draft") && JSON.stringify(entry.body).includes("Und die Anfahrt?"))).toBe(true);
      expect(sent).toHaveLength(1);
      expect(await field.inputValue()).toBe("");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("Waiting for you keeps the v2 rules, and an approval is decided in place", async () => {
    for (const view of [wide, phone]) {
      const { context, page, errors, posted } = await open(view, "/app/assistant?approvals=1", { waiting: true });
      try {
        await shoot(page, `${view.name}-waiting`);
        expect(await layoutProblems(page)).toEqual([]);
        expect(await page.getByText("Version 2 von „Lagerliste exportieren“ einschalten").count()).toBe(1);
        expect(await page.getByRole("button", { name: "Chat wiederherstellen" }).count()).toBe(1);
        // One count of what waits: the sidebar's badge and the page's statement say the same, the server's count (5),
        // although the page's first lists hold fewer questions than that.
        if (view === wide) {
          expect(await page.locator('[data-k2-part="Nav"] a[href="/app/assistant?approvals=1"] .k2-ni-count').textContent()).toBe("5");
          expect(await page.locator('[data-k2-part="StatusRow"]').textContent()).toContain("5 offen");
        }
        if (view === wide) {
          await page.getByRole("button", { name: "Rückfrage zu Rechnung 2026-118 an Frau Berger senden" }).click();
          await until(() => posted.some((entry) => entry.path.startsWith("/api/approvals/")));
          expect(posted.some((entry) => entry.path.startsWith("/api/approvals/"))).toBe(true);
        }
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 90_000);

  test("a chat is renamed in its settings from the head's menu", async () => {
    const { context, page, errors } = await open(wide, "/app/assistant");
    try {
      await page
        .locator('[data-k2-workspace] [data-slot="head"]')
        .getByRole("button", { name: "Weitere Aktionen für diesen Chat" })
        .click();
      await page.getByRole("menuitem", { name: "Chat bearbeiten …" }).click();
      await page.getByRole("textbox", { name: "Name" }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a chat is archived after the question and the page leaves it", async () => {
    const { context, page, errors, posted } = await open(wide, "/app/assistant");
    try {
      await page
        .locator('[data-k2-workspace] [data-slot="head"]')
        .getByRole("button", { name: "Weitere Aktionen für diesen Chat" })
        .click();
      await page.getByRole("menuitem", { name: "Archivieren …" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Chat archivieren" }).click();
      await page.waitForURL((url) => !url.search.includes("conversation="));
      expect(posted.some((entry) => entry.path === "/api/ai/conversations/Tod003/archive")).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the search of every chat opens Cloud's search in the Assistant's chats", async () => {
    const { context, page, errors } = await open(wide, "/app/assistant");
    try {
      const search = page.getByRole("searchbox", { name: "Alle Chats durchsuchen" });
      await search.fill("Rechnung");
      await search.press("Enter");
      const searches = await page.waitForFunction(
        () => (window as unknown as { searches: unknown[] }).searches.length > 0 && (window as unknown as { searches: unknown[] }).searches,
      );
      expect(JSON.stringify(await searches.jsonValue())).toContain('"appId":"assistant"');
      expect(JSON.stringify(await searches.jsonValue())).toContain('"query":"Rechnung"');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("on the phone the shell's menu gets the sidebar's entries, chats with their deeds", async () => {
    const { context, page, errors } = await open(phone, "/app/assistant");
    try {
      await shoot(page, "390-chat");
      // The shell's phone menu reads what the page provides; its own rendering is the shell's and tested there.
      const items = await page.evaluate(() => {
        type Item = { label: string; href?: string; actions?: { label: string }[]; children?: Item[] };
        const state = (window as unknown as { __cloudWorkspaceNavigation?: { label: string; navigation: { items: () => Item[] } } })
          .__cloudWorkspaceNavigation;
        const flat = (list: Item[]): Item[] => list.flatMap((item) => [item, ...flat(item.children ?? [])]);
        return state ? { label: state.label, items: flat(state.navigation.items()) } : null;
      });
      expect(items?.label).toBe("Gustav");
      const chat = items?.items.find((item) => item.label === "Urlaubsplanung Dezember");
      expect(chat?.href).toBe("/app/assistant?conversation=Yes001");
      expect(chat?.actions?.map((action) => action.label)).toContain("Chat bearbeiten …");
      expect(items?.items.some((item) => item.label === "Werkstatt Angebote")).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("measure: elements on the first picture, usual and the most open chats the sidebar lists", async () => {
    for (const state of ["usual", "huge"] as const) {
      const started = performance.now();
      const { context, page, errors } = await open(wide, "/app/assistant", { state });
      try {
        const ready = Math.round(performance.now() - started);
        // The end of the bounded list: "Weitere Chats …" in the picture.
        if (state === "huge") await page.getByRole("button", { name: "Weitere Chats …" }).scrollIntoViewIfNeeded();
        await shoot(page, `1440-measure-${state}`);
        const counts = await page.evaluate(() => ({
          all: document.querySelectorAll("*").length,
          nav: document.querySelectorAll('[data-k2-part="Nav"] *').length,
          loading: document.querySelectorAll('[data-k2-part="Loading"]').length,
        }));
        console.log(`measure ${state}: ready ${ready} ms, elements ${counts.all}, in the sidebar ${counts.nav}, loading ${counts.loading}`);
        expect(counts.loading).toBe(0);
        if (state === "huge") {
          expect(await page.getByRole("button", { name: "Weitere Chats …" }).count()).toBe(1);
          // The sidebar's bound keeps the page small: 100 chats stay under 1,200 elements.
          expect(counts.all).toBeLessThan(1_200);
        }
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 90_000);

  // The stored tab's place under the chat on the phone is Z2's gap (a); its visibility test comes with Z2.
  test("on the phone a stored tab is no detail on the first picture, and the composer stands in view", async () => {
    const { context, page, errors } = await open(phone, "/app/assistant", { tabs: true });
    try {
      expect(await page.locator('[data-k2-part="Pane"][data-detail]').count()).toBe(0);
      const composer = await page.locator(".assistant-chat-composer").boundingBox();
      expect(composer && composer.y + composer.height <= phone.height).toBe(true);
      await shoot(page, "390-chat-with-tabs");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  const openInThisChat = async (page: Page) => {
    await page.locator('[data-k2-workspace] [data-slot="head"]').getByRole("button", { name: "Weitere Aktionen für diesen Chat" }).click();
    await page.getByRole("menuitem", { name: "In diesem Chat" }).click();
  };

  test("wide: In diesem Chat opens the chat's context as a tab beside the chat, and the chat stays", async () => {
    const { context, page, errors } = await open(wide, "/app/assistant");
    try {
      await openInThisChat(page);
      const tabs = page.locator('[data-k2-part="Pane"][aria-label="Offene Tabs des Chats"]');
      await tabs.waitFor();
      await tabs.getByText("Kontext").first().waitFor();
      expect(await page.locator('[data-k2-part="Pane"][aria-label="Chat"]').count()).toBe(1);
      expect(await page.locator(".assistant-chat-composer").isVisible()).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("phone: In diesem Chat is the page with exactly one way back, which returns to the chat with the focus", async () => {
    const { context, page, errors } = await open(phone, "/app/assistant");
    try {
      await openInThisChat(page);
      await page.locator('[data-k2-part="Pane"][data-detail]').waitFor();
      // One way back: the pane's own; v1's "back to the chat" above the tabs stays away.
      const back = page.locator('[data-k2-part="Back"]').filter({ visible: true });
      expect(await back.count()).toBe(1);
      expect(await page.locator(".artifact-mobile-toggle").filter({ visible: true }).count()).toBe(0);
      // Said once: the tab chip names "Kontext"; its content is v2's sections of rows (the chat's Project first).
      const detail = page.locator('[data-k2-part="Pane"][data-detail]');
      await detail.locator('[data-k2-part="Section"]').first().waitFor();
      // The pane's own heading stays for assistive technology only (1 px), so the eye reads "Kontext" once.
      const seen = await detail.evaluate(
        (pane) =>
          [...pane.querySelectorAll("*")].filter(
            (element) =>
              element.childElementCount === 0 && element.textContent?.trim() === "Kontext" && element.getBoundingClientRect().width > 2,
          ).length,
      );
      expect(seen).toBe(1);
      expect(await detail.locator('[data-k2-part="Row"]', { hasText: "Projektanweisungen" }).count()).toBe(1);
      // A long memory keeps its row short, as v1 clamped it: at most three lines of text.
      const longMemory = detail.locator('[data-k2-part="Row"]', { hasText: "Bei Abweichungen" });
      await longMemory.waitFor();
      expect((await longMemory.boundingBox())?.height ?? 0).toBeLessThanOrEqual(80);
      await shoot(page, "390-in-this-chat");
      await back.getByRole("button").or(back.getByRole("link")).first().click();
      await page.locator('[data-k2-part="Pane"][data-detail]').waitFor({ state: "detached" });
      expect(await page.locator(".assistant-chat-composer").isVisible()).toBe(true);
      await page.waitForFunction(() => document.activeElement !== document.body);
      expect(await page.evaluate(() => document.activeElement?.closest(".assistant-chat-composer") !== null)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a person with only archived chats keeps All chats in the sidebar; a person without any chat does not get it", async () => {
    for (const archived of [true, false]) {
      const { context, page, errors } = await open(wide, "/app/assistant", { state: "empty", archived });
      try {
        const entry = page.locator('[data-k2-part="Nav"]').getByText("Alle Chats", { exact: true });
        expect(await entry.count()).toBe(archived ? 1 : 0);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 60_000);
});
