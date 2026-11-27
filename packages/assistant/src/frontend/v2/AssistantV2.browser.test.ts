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
/** The person's settings and the models a Project can default to, as the server reads them (and its API answers). */
const PREFS = {
  userId: "user-mira",
  memoryEnabled: true,
  memoryLearningEnabled: true,
  suggestNextMessage: true,
  selection: null,
  updatedAt: FIXTURE_NOW,
};
const PEOPLE_MODELS = {
  status: "ok" as const,
  selection: null,
  effectiveDefault: { class: "balanced" as const },
  classes: [{ class: "balanced" as const, variantId: "standard" }],
  options: MODELS,
};
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
  /** The chats at places could not be listed (null), until the test lets them come back. */
  placesFailed?: boolean;
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
/** A Project the person opened: its chats and what Gustav knows there, as the server reads them. */
const projectOf = (projectId: string, conversations: AiConversationLike[], state: AssistantV2FixtureState = "usual") => {
  const project = fixtureProjects(state === "empty" ? "usual" : state).find((entry) => entry.id === projectId);
  if (!project) return null;
  const items = conversations.filter((conversation) => conversation.projectId === projectId);
  const stamp = "2026-11-20T08:00:00.000Z";
  return {
    project,
    // The worst Project has the 500 chats a busy year brings; the empty one has none yet.
    chats:
      state === "worst"
        ? { items: conversations.slice(0, 20).map((chat) => ({ ...chat, projectId })), total: 500, page: 1, perPage: 20, hasNext: true }
        : state === "empty"
          ? { items: [], total: 0, page: 1, perPage: 20, hasNext: false }
          : { items, total: items.length, page: 1, perPage: 20, hasNext: false },
    context: {
      projectId,
      skills: { items: [], page: 1, hasNext: false },
      knowledge: [
        {
          id: "kn1",
          shortId: "kn1",
          projectId,
          title: "Mahnstufen und Fristen",
          content: "# Mahnstufen",
          createdAt: stamp,
          updatedAt: stamp,
        },
        { id: "kn2", shortId: "kn2", projectId, title: "Kontenrahmen SKR03", content: "# SKR03", createdAt: stamp, updatedAt: stamp },
      ],
      files: [
        { id: "fi1", shortId: "fi1", projectId, path: "Belege/Oktober.pdf", mediaType: "application/pdf", size: 48_000, updatedAt: stamp },
        {
          id: "fi2",
          shortId: "fi2",
          projectId,
          path: "Monatsabschluss.xlsx",
          mediaType: "application/vnd.ms-excel",
          size: 12_000,
          updatedAt: stamp,
        },
      ],
      references: [],
      ...(state === "worst"
        ? {
            knowledge: [
              {
                id: "kn9",
                shortId: "kn9",
                projectId,
                title: "Auflagen der unteren Denkmalschutzbehörde für Fenster, Dachgauben und Fassadenfarbe (Bescheid vom 3. März)",
                content: "# Auflagen",
                createdAt: stamp,
                updatedAt: stamp,
              },
              { id: "kn8", shortId: "kn8", projectId, title: "🏛️ Förderung KfW 261", content: "# KfW", createdAt: stamp, updatedAt: stamp },
              { id: "kn7", shortId: "kn7", projectId, title: "見積もり条件", content: "# 条件", createdAt: stamp, updatedAt: stamp },
              { id: "kn6", shortId: "kn6", projectId, title: "Ö", content: "# Ö", createdAt: stamp, updatedAt: stamp },
            ],
            files: [
              {
                id: "fi9",
                shortId: "fi9",
                projectId,
                path: "Pläne/Bestand/Grundriss_Erdgeschoss_Hauptstrasse_12_Stand_2026-11-03_final_v7_freigegeben.pdf",
                mediaType: "application/pdf",
                size: 48_000_000,
                updatedAt: stamp,
              },
            ],
          }
        : {}),
    },
  };
};
type AiConversationLike = ReturnType<typeof fixtureConversations>[number];

const propsOf = (scene: Scene, url: URL) => {
  const state = scene.state ?? "usual";
  const conversations = fixtureConversations(state);
  const openId =
    scene.open === false || url.searchParams.has("approvals") || url.searchParams.has("project")
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
    initialPlaceChats: scene.placesFailed
      ? null
      : state === "empty"
        ? { total: 0, items: [] }
        : { total: FIXTURE_PLACE_CHATS.length, items: FIXTURE_PLACE_CHATS },
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
    // As the server does: the opened Project stands in the list even where the sidebar has none yet.
    projects: ((opened) => [
      ...fixtureProjects(state),
      ...(opened && !fixtureProjects(state).some((entry) => entry.id === opened.id) ? [opened] : []),
    ])(url.searchParams.get("project") ? projectOf(url.searchParams.get("project")!, conversations, state)?.project : undefined),
    ...(() => {
      const opened = url.searchParams.get("project");
      const project = opened ? projectOf(opened, conversations, state) : null;
      return {
        initialProject: project?.project ?? null,
        initialProjectChats: project?.chats ?? null,
        initialProjectContext: project?.context ?? null,
      };
    })(),
    // The settings pages, as the server reads them from the address.
    initialPrefsTab: url.searchParams.get("prefs") ? (url.searchParams.get("prefs") as "personalization") : null,
    initialProjectSettings: url.searchParams.get("settings") === "1",
    // What the settings pages show first, read on the server (no OpenAI-compatible API here).
    initialPrefs: url.searchParams.get("prefs") ? { prefs: PREFS, access: null } : null,
    initialProjectSettingsSeed: url.searchParams.get("settings") === "1" ? { models: PEOPLE_MODELS, access: [] } : null,
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
        ? { has: true, open: true, page: myAppsFixture(state === "worst" ? "schlimm" : state === "empty" ? "leer" : "normal").initial }
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
  let placesFail = Boolean(scene.placesFailed);
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
          `<script>window.assistantV2Harness = ${JSON.stringify(harness).replace(/</g, "\\u003c")};</script>` +
          `<script type="module" src="/harness.js"></script></body></html>`,
      });
    }
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
    if (url.pathname === "/harness.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    if (url.pathname.startsWith("/ui/")) return route.fulfill({ path: resolve(ui, "dist", url.pathname.slice(4)) });
    calls.push(`${method} ${url.pathname}${url.search}`);
    const conversations = fixtureConversations(scene.state ?? "usual");
    if (method !== "GET") posted.push({ path: url.pathname, body: route.request().postDataJSON() });
    // Gustav's settings: the person's preferences and their personalization, as the server keeps them.
    if (url.pathname === "/api/ai/prefs" && method === "GET") return route.fulfill({ json: PREFS });
    if (url.pathname === "/api/ai/memories" && method === "GET")
      return route.fulfill({
        json:
          scene.state === "worst"
            ? [
                "Rechnungen von Steinwerk Nord immer gegen das Angebot prüfen, zuerst die Montagestunden, dann die Anfahrt und zuletzt die Materialpreise, und nie ohne Rücksprache einen Abzug ankündigen.",
                "🪚 Werkstatt schließt freitags um 14 Uhr",
                "日本の取引先には丁寧語で書く",
                "Ö",
              ].map((content, index) => ({
                id: `mem${index}`,
                shortId: `mem${index}`,
                userId: "user-mira",
                kind: index === 1 ? "fact" : "preference",
                content,
                priority: index === 0 ? "pinned" : "normal",
                source: "user",
                sourceConversationId: null,
                sourceMessageId: null,
                resourceRef: null,
                createdAt: FIXTURE_NOW,
                updatedAt: FIXTURE_NOW,
              }))
            : [],
      });
    if (url.pathname === "/api/ai/prefs/system-prompt" && method === "GET")
      return route.fulfill({ json: { prompt: "Du bist Gustav, der Assistent von Mira.", renderedAt: FIXTURE_NOW } });
    if (url.pathname === "/api/ai/approval-preferences" && method === "GET") return route.fulfill({ json: { approvals: [] } });
    if (url.pathname.endsWith("/skills") && method === "GET") return route.fulfill({ json: { skills: [] } });
    // A Project's settings: the models to choose from, who has access, and the save.
    if (url.pathname === "/api/ai/models" && method === "GET") return route.fulfill({ json: PEOPLE_MODELS });
    if (/^\/api\/ai\/projects\/[^/]+\/access$/.test(url.pathname) && method === "GET") return route.fulfill({ json: { access: [] } });
    if (/^\/api\/ai\/projects\/[^/]+$/.test(url.pathname) && method === "PATCH") {
      const project = fixtureProjects("usual").find((entry) => url.pathname.endsWith(`/${entry.id}`));
      return route.fulfill({ json: { ...project, ...(route.request().postDataJSON() as object) } });
    }
    // The operator offers no OpenAI-compatible API here, so the settings show no API tab.
    if (url.pathname === "/api/ai/status" && method === "GET")
      return route.fulfill({ json: { openaiApi: { enabled: false }, options: [] } });
    // All chats: one page of the person's history, searched and filtered as the server does it.
    if (url.pathname.endsWith("/conversations/page") && method === "GET") {
      const q = url.searchParams.get("q")?.toLocaleLowerCase();
      const archivedView = url.searchParams.get("archived") === "true";
      const items = (archivedView ? conversations.slice(0, 2).map((chat) => ({ ...chat, archivedAt: FIXTURE_NOW })) : conversations).filter(
        (chat) => !q || chat.title.toLocaleLowerCase().includes(q),
      );
      const total = scene.state === "worst" && !q ? 500 : items.length;
      return route.fulfill({ json: { items: items.slice(0, 20), total, page: 1, perPage: 20, hasNext: total > 20 } });
    }
    if (url.pathname.endsWith("/restore") && method === "POST") {
      const id = url.pathname.split("/").at(-2);
      return route.fulfill({ json: conversations.find((chat) => chat.id === id) ?? conversations[0] });
    }
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
          placeChats: placesFail
            ? null
            : state === "empty"
              ? { total: 0, items: [] }
              : { total: FIXTURE_PLACE_CHATS.length, items: FIXTURE_PLACE_CHATS },
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
  return {
    context,
    page,
    errors,
    unanswered,
    calls,
    posted,
    sent,
    created: () => created,
    recoverPlaces: () => {
      placesFail = false;
    },
  };
};

/** The rules of v2 on the resting page: no outline problem and no layout finding outside the chat's own drawing. */
const layoutProblems = async (page: Page): Promise<string[]> => {
  await page.mouse.move(0, 0);
  const outline = await describeV2Page(page, "[data-k2-workspace]");
  const layout = await measureV2Layout(page, { root: "[data-k2-workspace]", skip: "[data-k2-canvas]" });
  return [...(outline.includes("Problems (") ? [outline] : []), ...layout.problems];
};

/** Waits for something the test's routes saw; the test's own timeout bounds it. */
const until = async (seen: () => boolean) => {
  while (!seen()) await Bun.sleep(100);
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
          // At 1024 an open chat's path and the head's actions share the head, and v2's path does not give way
          // before a button yet, so "Neuer Chat" is cut; #4392 lets a bar's start give way. Its own case below.
          if (view !== narrow || state === "empty") expect(await layoutProblems(page)).toEqual([]);
          expect(errors).toEqual([]);
          expect(unanswered).toEqual([]);
        } finally {
          await context.close();
        }
      }, 60_000);
  for (const state of ["usual", "worst"] as const)
    test.todo(`1024 ${state}: an open chat's head keeps "Neuer Chat" whole beside its path (#4392)`, async () => {
      const { context, page } = await open(narrow, "/app/assistant", { state });
      try {
        expect(await layoutProblems(page)).toEqual([]);
      } finally {
        await context.close();
      }
    });

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
        if (view === phone) {
          // On the phone the shell's bar holds the one search; New chat floats as the list's main action.
          expect(await page.locator(".k2-fab:visible").textContent()).toContain("Neuer Chat");
          // The status row's end (the exception chips) is hidden on the phone (gap for R); creating in the chat
          // stays one press away in the head.
          expect(await page.locator('[data-slot="head"]').getByRole("button", { name: "Im Chat erstellen" }).isVisible()).toBe(true);
        }
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

  for (const view of [phone, narrow, wide, large])
    test(`${view.name}: a Project shows its head, what it holds, its chats with the composer, and its context`, async () => {
      const { context, page, errors, unanswered } = await open(view, "/app/assistant?project=Prj03", { open: false });
      try {
        const pane = page.locator('[data-k2-part="Pane"][aria-label="Buchhaltung 2026"]');
        await pane.locator('[data-k2-part="RecordHead"]').waitFor();
        await settled(page);
        await shoot(page, `${view.name}-project`);
        expect(await pane.locator('[data-k2-part="RecordHead"]').textContent()).toBe("Buchhaltung 2026");
        // What it holds, from the server's read: three chats, two pieces of knowledge, two files, no references.
        expect((await pane.locator('[data-k2-part="Cells"]').textContent())?.replace(/\s+/g, " ")).toMatch(
          /Chats\s*3.*Projektwissen\s*2.*Dateien\s*2.*Referenzen\s*0/,
        );
        for (const title of ["Rechnung 2026-118 prüfen", "Mahnung an Kunde Berger formulieren", "Steuerberater: Fragen zur Umsatzsteuer"]) {
          expect(await pane.getByText(title).count()).toBe(1);
          // Each chat's settings stay one press away from its row, as in v1.
          expect(await pane.getByRole("button", { name: `${title} bearbeiten` }).count()).toBe(1);
        }
        expect(await page.getByPlaceholder("Neuen Chat in Buchhaltung 2026 beginnen").count()).toBe(1);
        if (view !== phone) expect(await page.locator('[data-k2-part="Pane"][aria-label="Projektkontext"]').isVisible()).toBe(true);
        // The composer starts the Project's new chat: nothing floats over it, and "Neuer Chat" stays in the head.
        expect(await page.locator(".k2-fab:visible").count()).toBe(0);
        expect(await page.locator('[data-slot="head"]').getByRole("button", { name: "Neuer Chat" }).isVisible()).toBe(true);
        expect(await layoutProblems(page)).toEqual([]);
        expect(errors).toEqual([]);
        expect(unanswered).toEqual([]);
      } finally {
        await context.close();
      }
    }, 60_000);

  /** break-ui: every screen with the worst realistic data and with none; each break is named, by screen and width. */
  const SCREENS = [
    { name: "apps", address: "/app/assistant/code", pane: "Meine Apps & Automationen", states: ["worst", "empty"] },
    {
      name: "project",
      address: "/app/assistant?project=Prj09",
      pane: "Sanierung Altbau Hauptstraße 12 mit Denkmalschutzauflagen und Fördermitteln",
      states: ["worst"],
    },
    { name: "project-empty", address: "/app/assistant?project=Prj01", pane: "Werkstatt Angebote", states: ["empty"] },
    { name: "prefs", address: "/app/assistant?prefs=personalization", pane: "Personalisieren", states: ["worst", "empty"] },
    { name: "project-settings", address: "/app/assistant?project=Prj09&settings=1", pane: "Projekt-Einstellungen", states: ["worst"] },
  ] as const;
  for (const view of [phone, wide])
    test(`${view.name} break-ui: every Assistant screen holds its worst and its empty data`, async () => {
      const breaks: Record<string, string[]> = {};
      for (const screen of SCREENS)
        for (const state of screen.states) {
          // My apps & automations reads its own day; the page clock follows it, as in the apps test.
          const { context, page, errors, unanswered } = await open(view, screen.address, {
            state,
            open: false,
            ...(screen.name === "apps" ? { now: APPS_NOW } : {}),
          });
          try {
            const pane = page.locator(`[data-k2-part="Pane"][aria-label="${screen.pane}"]`).first();
            await pane.waitFor({ timeout: 10_000 }).catch(() => undefined);
            await settled(page);
            await shoot(page, `${view.name}-break-${screen.name}-${state}`);
            const found = [
              ...((await pane.count()) === 0 ? [`no pane "${screen.pane}"`] : []),
              ...(await layoutProblems(page)),
              ...errors,
              ...unanswered.map((entry) => `unanswered ${entry}`),
            ];
            if (found.length) breaks[`${screen.name} ${state}`] = found;
          } finally {
            await context.close();
          }
        }
      if (view === wide) {
        // All chats: the worst history of 500 chats, opened from the sidebar.
        const { context, page, errors, unanswered } = await open(view, "/app/assistant", { state: "worst" });
        try {
          await page.locator('[data-k2-part="Nav"]').getByText("Alle Chats", { exact: true }).click();
          await page.getByRole("dialog", { name: "Alle Chats" }).locator('[data-k2-part="Row"]').first().waitFor();
          await settled(page);
          await shoot(page, `${view.name}-break-all-chats-worst`);
          const found = [...(await layoutProblems(page)), ...errors, ...unanswered.map((entry) => `unanswered ${entry}`)];
          if (found.length) breaks["all-chats worst"] = found;
        } finally {
          await context.close();
        }
      }
      expect(breaks).toEqual({});
    }, 240_000);

  test("on the phone the chat fills the screen and its composer stands in view", async () => {
    const { context, page, errors } = await open(phone, "/app/assistant");
    try {
      // A chat's main action is its composer: nothing floats over it.
      expect(await page.locator(".k2-fab:visible").count()).toBe(0);
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
      // A symbol in the head (SEARCH + CREATE), so the path keeps the head's room.
      await page.locator('[data-slot="head"]').getByRole("button", { name: "Alle Chats durchsuchen" }).click();
      const searches = await page.waitForFunction(
        () =>
          (window as unknown as { assistantV2Searches: unknown[] }).assistantV2Searches.length > 0 &&
          (window as unknown as { assistantV2Searches: unknown[] }).assistantV2Searches,
      );
      expect(JSON.stringify(await searches.jsonValue())).toContain('"appId":"assistant"');
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

  // One pane at a time on the phone, as in v1: the one in front is the detail, and the other one gives way.
  test("on the phone a stored tab stays behind the chat on the first picture, and the composer stands in view", async () => {
    const { context, page, errors } = await open(phone, "/app/assistant", { tabs: true });
    try {
      expect(await page.locator('[data-k2-part="Pane"][aria-label="Chat"]').getAttribute("data-detail")).toBe("");
      expect(await page.locator('[data-k2-part="Pane"][aria-label="Offene Tabs des Chats"]').isVisible()).toBe(false);
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
      const detail = page.locator('[data-k2-part="Pane"][aria-label="Offene Tabs des Chats"][data-detail]');
      await detail.waitFor();
      expect(await page.locator('[data-k2-part="Pane"][aria-label="Chat"]').isVisible()).toBe(false);
      // One way back: the pane's own; v1's "back to the chat" above the tabs stays away.
      const back = page.locator('[data-k2-part="Back"]').filter({ visible: true });
      expect(await back.count()).toBe(1);
      expect(await page.locator(".artifact-mobile-toggle").filter({ visible: true }).count()).toBe(0);
      // Said once: the tab chip names "Kontext"; its content is v2's sections of rows (the chat's Project first).
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
      // Back in the chat, the tabs give way: one pane at a time.
      await page.locator('[data-k2-part="Pane"][aria-label="Offene Tabs des Chats"]').waitFor({ state: "hidden" });
      expect(await page.locator(".assistant-chat-composer").isVisible()).toBe(true);
      await page.waitForFunction(() => document.activeElement !== document.body);
      expect(await page.evaluate(() => document.activeElement?.closest(".assistant-chat-composer") !== null)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  for (const view of [wide, narrow])
    test(`${view.name}: All chats opens as a v2 dialog, searches, and restores an archived chat`, async () => {
      const { context, page, errors, unanswered, posted } = await open(view, "/app/assistant");
      try {
        await page.locator('[data-k2-part="Nav"]').getByText("Alle Chats", { exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Alle Chats" });
        await dialog.locator('[data-k2-part="Row"]').first().waitFor();
        await settled(page);
        await shoot(page, `${view.name}-all-chats`);
        expect(await dialog.locator('[data-k2-part="Row"]').count()).toBe(20);
        // The search narrows the page as the server does.
        await dialog.getByRole("searchbox").fill("Rechnung");
        await dialog.locator('[data-k2-part="Row"]').nth(1).waitFor({ state: "detached" });
        expect(await dialog.locator('[data-k2-part="Row"]').first().textContent()).toContain("Rechnung 2026-118 prüfen");
        // Archived chats are restored from their row.
        await dialog.getByRole("searchbox").fill("");
        await dialog.getByRole("button", { name: "Alle Chats" }).click();
        // One choice: the menu marks the chosen filter, and the button names it after the choice.
        expect(await page.getByRole("menuitemradio", { name: "Alle Chats" }).getAttribute("aria-checked")).toBe("true");
        await page.getByRole("menuitemradio", { name: "Archiviert" }).click();
        await dialog.getByRole("button", { name: "Archiviert" }).waitFor();
        await dialog.getByRole("button", { name: "Chat wiederherstellen" }).first().waitFor({ state: "attached" });
        await settled(page);
        await shoot(page, `${view.name}-all-chats-archived`);
        await dialog.getByRole("button", { name: "Chat wiederherstellen" }).first().click();
        await until(() => posted.some((entry) => entry.path.endsWith("/restore")));
        expect(posted.some((entry) => entry.path.endsWith("/restore"))).toBe(true);
        expect(errors).toEqual([]);
        expect(unanswered).toEqual([]);
      } finally {
        await context.close();
      }
    }, 60_000);

  for (const view of [wide, narrow])
    test(`${view.name}: Personalize opens Gustav's settings as a page whose tabs live in the address`, async () => {
      const { context, page, errors, unanswered } = await open(view, "/app/assistant");
      try {
        await page.locator('[data-k2-part="Nav"]').getByText("Personalisieren", { exact: true }).click();
        const pane = page.locator('[data-k2-part="Pane"][aria-label="Personalisieren"]');
        await pane.locator('[data-k2-part="Tabs"]').waitFor();
        await until(() => page.url().includes("?prefs=personalization"));
        expect(new URL(page.url()).search).toBe("?prefs=personalization");
        await settled(page);
        await shoot(page, `${view.name}-prefs`);
        await pane.getByRole("link", { name: "Chat" }).click();
        await until(() => page.url().includes("?prefs=chat"));
        expect(new URL(page.url()).search).toBe("?prefs=chat");
        await pane.getByText("Nächste Nachricht vorschlagen").waitFor();
        // Every tab draws its parts on the page, none of them only a dialog could hold.
        for (const tab of ["Skills", "System-Prompt", "Freigaben", "Personalisierung"]) {
          await pane.getByRole("link", { name: tab }).click();
          await settled(page);
          await shoot(page, `${view.name}-prefs-${tab.toLowerCase()}`);
          expect(await pane.textContent()).not.toContain("[object Object]");
        }
        await pane.getByRole("link", { name: "Chat" }).click();
        await until(() => page.url().includes("?prefs=chat"));
        await pane.getByRole("link", { name: "Personalisierung" }).click();
        await until(() => page.url().includes("?prefs=personalization"));
        // Back returns to the tab before.
        await page.goBack();
        await until(() => page.url().includes("?prefs=chat"));
        expect(new URL(page.url()).search).toBe("?prefs=chat");
        expect(errors).toEqual([]);
        expect(unanswered).toEqual([]);
      } finally {
        await context.close();
      }
    }, 60_000);

  test("a Project's settings open as a page from its head, save, and return to the Project", async () => {
    const { context, page, errors, unanswered, posted } = await open(wide, "/app/assistant?project=Prj03", { open: false });
    try {
      await page.getByRole("button", { name: "Projekt-Einstellungen" }).click();
      const pane = page.locator('[data-k2-part="Pane"][aria-label="Projekt-Einstellungen"]');
      const name = pane.getByRole("textbox", { name: "Name" });
      await name.waitFor();
      expect(new URL(page.url()).search).toBe("?project=Prj03&settings=1");
      expect(await name.inputValue()).toBe("Buchhaltung 2026");
      await settled(page);
      await shoot(page, "1440-project-settings");
      expect(await layoutProblems(page)).toEqual([]);
      await name.fill("Buchhaltung 2027");
      await pane.getByRole("button", { name: "Speichern" }).click();
      await until(() => posted.some((entry) => entry.path === "/api/ai/projects/Prj03"));
      expect(posted.find((entry) => entry.path === "/api/ai/projects/Prj03")?.body).toMatchObject({ name: "Buchhaltung 2027" });
      await until(() => !page.url().includes("settings=1"));
      expect(new URL(page.url()).search).toBe("?project=Prj03");
      expect(errors).toEqual([]);
      expect(unanswered).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("from one Project's settings page another Project opens as itself, and its settings read its own access", async () => {
    const { context, page, errors, unanswered, calls } = await open(wide, "/app/assistant?project=Prj03&settings=1", { open: false });
    try {
      const settings = page.locator('[data-k2-part="Pane"][aria-label="Projekt-Einstellungen"]');
      await settings.getByRole("textbox", { name: "Name" }).waitFor();
      // The server's seed served this page: no read of its access.
      expect(calls.filter((call) => call.startsWith("GET /api/ai/projects/Prj03/access"))).toEqual([]);
      await page.locator('[data-k2-part="Nav"]').getByRole("link", { name: "Werkstatt Angebote" }).click();
      await until(() => new URL(page.url()).search === "?project=Prj01");
      await page.getByRole("button", { name: "Projekt-Einstellungen" }).waitFor();
      expect(await settings.count()).toBe(0);
      await page.getByRole("button", { name: "Projekt-Einstellungen" }).click();
      expect(await settings.getByRole("textbox", { name: "Name" }).inputValue()).toBe("Werkstatt Angebote");
      await until(() => calls.some((call) => call.startsWith("GET /api/ai/projects/Prj01/access")));
      expect(errors).toEqual([]);
      expect(unanswered).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("chats at places that could not be listed keep their folder with a failure line, and Try again lists them", async () => {
    const { context, page, errors, unanswered, calls, recoverPlaces } = await open(wide, "/app/assistant", { placesFailed: true });
    try {
      const sidebar = page.locator('[data-k2-workspace] [data-k2-part="Nav"]');
      await sidebar.getByRole("button", { name: /An Orten/ }).click();
      const failed = sidebar.getByRole("button", { name: "Chats an Orten konnten nicht geladen werden." });
      await failed.waitFor();
      recoverPlaces();
      const reads = calls.filter((call) => call.startsWith("GET /api/assistant/workspace/sidebar")).length;
      await failed.click();
      await until(() => calls.filter((call) => call.startsWith("GET /api/assistant/workspace/sidebar")).length > reads);
      await sidebar.getByText(FIXTURE_PLACE_CHATS[0]!.title).waitFor();
      expect(await failed.count()).toBe(0);
      expect(errors).toEqual([]);
      expect(unanswered).toEqual([]);
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
