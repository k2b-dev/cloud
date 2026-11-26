import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appAccentStyle, appV2InkStyle } from "@k2b/cloud/ssr/app-appearance";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page, Route } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";
import {
  type AssistantV2FixtureState,
  FIXTURE_MESSAGES,
  FIXTURE_NOW,
  FIXTURE_OPEN_ID,
  FIXTURE_PLACE_CHATS,
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
  memories: [],
  runCount: 0,
  runs: [],
});

type Scene = { state?: AssistantV2FixtureState; open?: boolean };
const propsOf = (scene: Scene, url: URL) => {
  const state = scene.state ?? "usual";
  const conversations = fixtureConversations(state);
  const openId = scene.open === false ? null : (url.searchParams.get("conversation") ?? (state === "usual" ? FIXTURE_OPEN_ID : null));
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
    initialDoneCount: conversations.filter((conversation) => conversation.isDone).length,
    initialPlaceChats: state === "empty" ? { total: 0, items: [] } : { total: FIXTURE_PLACE_CHATS.length, items: FIXTURE_PLACE_CHATS },
    initialQuestions: { items: [], count: 0 },
    initialConversationId: open?.id ?? null,
    initialArtifactPath: null,
    initialWorkspaceHref: `${url.pathname}${url.search}`,
    initialDetail: open
      ? {
          conversation: open,
          messages: FIXTURE_MESSAGES.map((entry) => ({ ...entry, conversationId: open.id })),
          hasMoreMessages: false,
          activeTurn: null,
          timeline: [],
        }
      : null,
    initialContext: open ? contextOf(open.id) : null,
    projects: fixtureProjects(state),
    initialProject: null,
    initialProjectChats: null,
    initialProjectContext: null,
    approvals: { page: { items: [], nextCursor: null, count: 0, elsewhere: 0 }, open: false },
    code: { has: true, open: false },
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
  await context.addInitScript(pinPageClock, Date.parse(FIXTURE_NOW));
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = pageErrors(page);
  const unanswered: string[] = [];
  const calls: string[] = [];
  await page.route(`${ORIGIN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/app/assistant") {
      const harness = { locale: "de", props: propsOf(scene, url) };
      const colors = [appAccentStyle(plum), appV2InkStyle(plum)].filter(Boolean).join(";");
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body:
          `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"></head>` +
          `<body class="k2b-ui" style="margin:0;${colors}"><div id="root"></div>` +
          `<script>window.harness = ${JSON.stringify(harness).replace(/</g, "\\u003c")};</script>` +
          `<script type="module" src="/harness.js"></script></body></html>`,
      });
    }
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
    if (url.pathname === "/harness.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    if (url.pathname.startsWith("/ui/")) return route.fulfill({ path: resolve(ui, "dist", url.pathname.slice(4)) });
    calls.push(`${method} ${url.pathname}${url.search}`);
    const conversations = fixtureConversations(scene.state ?? "usual");
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
      if (suffix === "/queue") return route.fulfill({ json: [] });
    }
    const chatContext = /^\/api\/assistant\/workspace\/conversations\/(\w+)\/context$/.exec(url.pathname);
    if (chatContext) return route.fulfill({ json: contextOf(chatContext[1]!) });
    if (/^\/api\/assistant\/workspace\/projects\/\w+\/context$/.test(url.pathname))
      return route.fulfill({
        json: { projectId: url.pathname.split("/")[5], knowledge: [], files: [], references: [], skills: { items: [] } },
      });
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
  return { context, page, errors, unanswered, calls };
};

/** The rules of v2 on the resting page: no outline problem and no layout finding outside the chat's own drawing. */
const layoutProblems = async (page: Page): Promise<string[]> => {
  await page.mouse.move(0, 0);
  const outline = await describeV2Page(page, "[data-k2-workspace]");
  const layout = await measureV2Layout(page, { root: "[data-k2-workspace]", skip: "[data-k2-canvas]" });
  return [...(outline.includes("Problems (") ? [outline] : []), ...layout.problems];
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
});
