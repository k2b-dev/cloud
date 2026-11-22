import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AiConversation, AiStoredMessage } from "@k2b/cloud/ai";
import type { Browser } from "playwright";
import { chatDoneMessage } from "../../../../scripts/fixtures/chat-done";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { layoutProblems } from "../../../ui/test/head-overlap";
import { emptySidebarSnapshot, sidebarSnapshot } from "./AssistantChatSidebar.fixture";

// Gustav flat (concept ui-flach-gustav v3) in the full workspace: the reading column with its cards, the docked column
// "In this chat" with its grip, and the phone. Every scene runs the layout self-check with few and with many messages,
// so a scrollbar appears. GUSTAV_FLAT_SHOTS=<dir> keeps light screenshots at 390, 768, 1440, and 1920 px. Fictional data.
const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");
const shots = process.env.GUSTAV_FLAT_SHOTS?.trim();
const now = "2026-11-13T10:00:00.000Z";
const conversation = (id: string, title: string): AiConversation => ({
  id,
  shortId: id,
  title,
  titleSource: "user",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: now,
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "user123",
  createdAt: now,
  updatedAt: now,
});
const chats = [
  conversation("Few001", "Messestand Köln"),
  conversation("Many01", "Angebot Eichenplatten"),
  conversation("Ctx001", "Umsatzbericht Q1–Q3"),
];
/** One round: the person's question and Gustav's answer; the last answer of a chat was cut off by the model service. */
const round = (index: number, failed: boolean): AiStoredMessage[] => {
  const loopId = `Turn${String(index).padStart(2, "0")}`;
  const question = "Was hat Jana zum Angebot für den Messestand gefragt? Und was kostet uns die Beleuchtung?";
  const answer = failed
    ? "Jana Berger fragt zwei Dinge:"
    : "Jana Berger fragt, ob der Aufbau am Sonntag möglich ist und ob die Beleuchtung im Preis enthalten ist. Der Aufbau ist ab Samstag möglich; die Beleuchtung kostet 480,00 € netto.";
  return [
    chatDoneMessage(index * 2 + 1, question, {
      loopId,
      stopReason: null,
      loopDoneReason: null,
      message: { role: "user", content: [{ type: "text", text: question }] },
    }),
    chatDoneMessage(index * 2 + 2, answer, {
      loopId,
      ...(failed ? { loopDoneReason: "error", meta: { turnError: { code: "model_unavailable" } } } : {}),
    }),
  ];
};
/** Two rounds, or eight so the timeline scrolls; the last answer failed. */
const messagesOf = (id: string): AiStoredMessage[] => {
  const rounds = id === "Many01" ? 8 : 2;
  return Array.from({ length: rounds }, (_, index) => round(index, index === rounds - 1)).flat();
};

let browser: Browser;
/** Chromium with classic scrollbars that take room in the layout, as on Windows and Linux desktops (Cloud flach QA). */
let classic: Browser;
let staticAsset: (request: Request) => Response | undefined;
/** The entry's own URL: lazy chunks import shared code from it, so the page loads it under that one URL. */
let entryUrl = "/harness.js";
const entry = resolve(import.meta.dir, "gustav-flat.browser-entry.tsx");
const fakeLive = resolve(import.meta.dir, "gustav-flat.browser-live.ts");
const entrySource = `import { LocaleProvider } from "@k2b/ui";
import { mount } from ${JSON.stringify(resolve(import.meta.dir, "../../../ssr/src/mount.ts"))};
import { toJSON } from ${JSON.stringify(Bun.resolveSync("seroval", cloud))};
import AssistantWorkspace from ${JSON.stringify(resolve(import.meta.dir, "AssistantWorkspace.island.tsx"))};
function Workspace(props) { return <LocaleProvider locale="de"><AssistantWorkspace {...props} /></LocaleProvider>; }
document.getElementById("root").dataset.props = JSON.stringify(toJSON(window.harness));
mount(Workspace, "#root");`;
const fakeLiveSource = `export const liveConnection = () => ({ subscribe: () => ({ close() {} }) });`;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: entrySource, [fakeLive]: fakeLiveSource },
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "gustav-flat-test",
        setup(builder) {
          builder.onResolve({ filter: /^@k2b\/cloud\/browser\/live$/ }, () => ({ path: fakeLive }));
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(path === entry ? entrySource : await Bun.file(path).text(), {
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the Gustav flat workspace.");
  const entryOutput = build.outputs.find((output) => output.kind === "entry-point")!;
  // Each output by its path in the build, as chunks import each other relatively; the entry loads under its own path.
  const url = (path: string) => `/${path.replace(/^\.\//, "")}`;
  const scripts = new Map(build.outputs.map((output) => [url(output.path), output]));
  entryUrl = url(entryOutput.path);
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", cloud))).default;
  const styles: string[] = [];
  for (const path of [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")]) {
    const built = await Bun.build({ entrypoints: [path], plugins: [tailwind], minify: true });
    if (!built.success) throw new AggregateError(built.logs, "Could not compile workspace styles.");
    styles.push(await built.outputs[0]!.text());
  }
  const fonts = ["plex.css", "tabler.css"]
    .map((file) =>
      readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((?!["']?(?:data:|https?:))(["']?)(?:\.\/)?/g, "url($1/ui/"),
    )
    .join("\n");
  const css = [fonts, "@layer properties, theme, base, components, utilities;", ...styles].join("\n");
  const cache = { "cache-control": "public, max-age=3600" };
  staticAsset = (request) => {
    const path = new URL(request.url).pathname;
    const script = scripts.get(path);
    if (script) return new Response(script, { headers: { "content-type": "text/javascript", ...cache } });
    if (path === "/harness.css") return new Response(css, { headers: { "content-type": "text/css", ...cache } });
    if (path.startsWith("/ui/")) return new Response(Bun.file(resolve(ui, "dist", path.slice(4))), { headers: cache });
  };
  browser = await launchBrowser();
  classic = await launchBrowser({ ignoreDefaultArgs: ["--hide-scrollbars"] });
}, 180_000);
afterAll(async () => {
  await browser?.close();
  await classic?.close();
});

/** A chat in the workspace. `desktop`: a window of this width with a mouse and, in the classic browser, scrollbars that take room. */
const open = async (id: string, width: number, theme: "light" | "dark" = "light", desktop?: Browser) => {
  const touch = !desktop && width < 768;
  const context = await (desktop ?? browser).newContext({
    viewport: { width, height: width < 768 ? 780 : 900 },
    reducedMotion: "reduce",
    locale: "de",
    isMobile: touch,
    hasTouch: touch,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = pageErrors(page);
  const unknown: string[] = [];
  await page.addInitScript((at) => {
    const RealDate = Date;
    globalThis.Date = new Proxy(RealDate, {
      construct(target, args) {
        return Reflect.construct(target, args.length ? args : [at]);
      },
      get(target, key) {
        return key === "now" ? () => at : Reflect.get(target, key);
      },
    });
  }, Date.parse(now));
  const detail = (chatId: string) => ({
    conversation: chats.find((chat) => chat.id === chatId)!,
    hasMoreMessages: false,
    activeTurn: null,
    messages: messagesOf(chatId).map((message) => ({ ...message, conversationId: chatId })),
    timeline: [],
  });
  const snapshot = (chatId: string) =>
    chatId === "Few001" ? emptySidebarSnapshot({ chatId }) : sidebarSnapshot({ chatId, now, viewerUserId: "user123" });
  const assets = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const asset = staticAsset(request);
      if (asset) return asset;
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/app/assistant") {
        const chatId = url.searchParams.get("conversation") ?? "Few001";
        const props = {
          userId: "user123",
          cloudUrl: url.origin,
          status: {
            ok: true,
            enabled: true,
            status: "ok",
            selection: null,
            effectiveDefault: { class: "balanced" },
            classes: [{ class: "balanced", variantId: "standard" }],
            visionModelConfigured: false,
            error: null,
            options: [
              {
                id: "standard",
                label: "Standard",
                variantLabel: "Ausgewogen",
                description: "",
                icon: { kind: "mark", text: "AI", color: "0" },
                classes: ["balanced"],
              },
            ],
          },
          models: [
            { id: "standard", label: "Standard", description: "", icon: { kind: "mark", text: "AI", color: "0" }, classes: ["balanced"] },
          ],
          selection: null,
          timeZone: "Europe/Berlin",
          renderedAt: now,
          initialLiveCursor: "s6t.cloud-live-core.0",
          initialConversations: chats,
          initialDoneCount: 0,
          initialQuestions: { items: [], count: 0 },
          initialConversationId: chatId,
          initialArtifactPath: null,
          initialWorkspaceHref: path + url.search,
          initialDetail: detail(chatId),
          initialContext: null,
          projects: [],
          initialProject: null,
          initialProjectChats: null,
          initialProjectContext: null,
          approvals: { page: { items: [], nextCursor: null, count: 0, elsewhere: 0 }, open: false },
        };
        return new Response(
          `<!doctype html><html lang="de" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body class="k2b-ui" style="margin:0"><div id="root" style="display:flex;width:100%;height:100dvh"></div><script>window.harness=${JSON.stringify(props).replace(/</g, "\\u003c")}</script><script type="module" src="${entryUrl}"></script></body></html>`,
          { headers: { "content-type": "text/html", "cache-control": "no-store" } },
        );
      }
      if (path === "/api/assistant/workspace/sidebar")
        return Response.json({ conversations: chats, projects: [], doneCount: 0, questions: { items: [], count: 0 } });
      const chat = /^\/api\/ai\/conversations\/(\w+)$/.exec(path);
      if (chat) return Response.json(detail(chat[1]!));
      if (path.endsWith("/stream")) return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
      if (path.endsWith("/viewed")) return new Response(null, { status: 204 });
      if (path.endsWith("/queue")) return Response.json([]);
      if (path.endsWith("/dictations")) return Response.json({ items: [], nextCursor: null });
      if (path === "/api/approvals") return Response.json({ items: [], nextCursor: null, count: 0, elsewhere: 0 });
      if (path === "/api/capabilities/v1/queries/core/code.attention.list") return Response.json({ data: { items: [], nextCursor: null } });
      if (path === "/api/capabilities/v1/catalog") return Response.json({ protocolVersion: 2, apps: [], page: { hasMore: false } });
      if (path.endsWith("/tabs")) return Response.json({ state: { tabs: [], layout: null, front: null }, revision: 0 });
      const sidebar = /^\/api\/assistant\/workspace\/conversations\/(\w+)\/context$/.exec(path);
      if (sidebar) return Response.json(snapshot(sidebar[1]!));
      if (path === "/api/assistant/workspace/web-reader") return Response.json({ available: false });
      const empty: Record<string, unknown> = {
        "/api/ai/resources/recent": { resources: [] },
        "/api/ai/quotas": { enabled: false, balances: [] },
        "/api/ai/skills": { skills: [] },
        "/api/ai/tasks": [],
      };
      if (path in empty) return Response.json(empty[path]);
      unknown.push(`${request.method} ${path}`);
      return Response.json({ message: "unavailable" }, { status: 503 });
    },
  });
  try {
    await page.goto(`${assets.url.origin}/app/assistant?conversation=${id}`);
    await page.locator("textarea").first().waitFor();
    await settled(page);
  } catch (error) {
    console.error("Gustav flat workspace errors:", errors);
    await context.close();
    assets.stop(true);
    throw error;
  }
  return {
    page,
    errors,
    unknown,
    close: async () => {
      await context.close();
      assets.stop(true);
    },
  };
};

const SCENES = [
  ["Few001", "few messages"],
  ["Many01", "many messages"],
  ["Ctx001", "the column In this chat"],
] as const;

for (const width of [1440, 390])
  describe(`${width} px`, () => {
    for (const [id, name] of SCENES)
      test(`${name}: nothing overlaps, spills, is cut, or draws a double line`, async () => {
        const view = await open(id, width);
        try {
          // Screen-reader-only words are cut on purpose; the pill to the newest message floats over the timeline.
          const report = await view.page.evaluate(layoutProblems, {
            root: "#root",
            ignore: ".k2b-chat-timeline__latest, .k2b-sr-only, .sr-only",
            // K5: the actions under a message are pulled out by 8 px, so the sign, not its 32 px box, stands on the text edge.
            slack: 8,
          });
          expect(report.problems).toEqual([]);
          expect(view.unknown).toEqual([]);
          expect(view.errors).toEqual([]);
        } finally {
          await view.close();
        }
      }, 30_000);
  });

// Cloud flach QA (obligatory): the same scenes with classic scrollbars that take room, in desktop windows 390, 768, 1100,
// and 1440 px wide (a desktop window, not a phone: a touch tab gets overlay scrollbars that take no room). At 1100 the
// chat has no room for the docked column, so "In this chat" opens as its drawer over the chat.
for (const width of [390, 768, 1100, 1440])
  test(`${width} px with classic scrollbars: every scene is clean and the chat never scrolls sideways`, async () => {
    const found: Record<string, string[]> = {};
    for (const [id] of SCENES) {
      const view = await open(id, width, "light", classic);
      try {
        // A classic run is only worth its name when a scrollbar really takes room.
        const gutter = await view.page.evaluate(() => {
          const probe = document.createElement("div");
          probe.style.cssText = "position:absolute;width:100px;height:100px;overflow:scroll";
          document.body.append(probe);
          const room = probe.offsetWidth - probe.clientWidth;
          probe.remove();
          return room;
        });
        expect(gutter).toBeGreaterThan(0);
        if (width === 1100 && id === "Ctx001") {
          await view.page.getByRole("button", { name: "In diesem Chat" }).click();
          await view.page.locator('.assistant-context-boxcol[data-drawer="open"] .assistant-context-box__row').first().waitFor();
          await settled(view.page);
        }
        const sideways = await view.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        // The drawer floats over the chat, its head over the chat's head: it is checked as its own root, and the chat
        // below it without it (layoutProblems does not see what a floating layer covers).
        const drawer = '.assistant-context-boxcol[data-drawer="open"]';
        const check = (root: string, ignore: string) =>
          view.page.evaluate(layoutProblems, { root, ignore: `${ignore}.k2b-chat-timeline__latest, .k2b-sr-only, .sr-only`, slack: 8 });
        const problems = [
          ...(await check("#root", `${drawer}, `)).problems,
          ...((await view.page.locator(drawer).count()) > 0 ? (await check(drawer, "")).problems : []),
        ];
        const all = [...(sideways > 0 ? [`the page scrolls ${sideways} px sideways`] : []), ...problems];
        if (all.length > 0) found[id] = all;
        expect(view.unknown).toEqual([]);
        expect(view.errors).toEqual([]);
      } finally {
        await view.close();
      }
    }
    expect(found).toEqual({});
  }, 90_000);

test.skipIf(!shots)(
  "screenshots for the design review",
  async () => {
    mkdirSync(shots!, { recursive: true });
    for (const width of [390, 768, 1440, 1920])
      for (const [id] of SCENES) {
        const view = await open(id, width);
        try {
          await view.page.screenshot({ path: resolve(shots!, `${id}-${width}.png`) });
        } finally {
          await view.close();
        }
      }
    // Dark stays readable: the cards' tints and edges, the column, and the composer.
    for (const width of [390, 1440])
      for (const [id] of SCENES) {
        const view = await open(id, width, "dark");
        try {
          await view.page.screenshot({ path: resolve(shots!, `${id}-${width}-dark.png`) });
        } finally {
          await view.close();
        }
      }
  },
  300_000,
);
