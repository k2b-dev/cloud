import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AiConversation } from "@k2b/cloud/ai";
import type { Browser } from "playwright";
import { chatDoneFact, chatDoneMessage } from "../../../../scripts/fixtures/chat-done";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { emptySidebarSnapshot } from "./AssistantChatSidebar.fixture";

// Full Assistant workspace: the activity arrives through its live invalidation, and its link uses real navigation.
const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");
const now = "2026-11-19T10:20:00.000Z";
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
const chats = [conversation("Source", "Reise nach Lyon"), conversation("Target", "Hotels in Lyon")];
let browser: Browser;
let assets: ReturnType<typeof Bun.serve>;
const entry = resolve(import.meta.dir, "chat-done.browser-entry.tsx");
const fakeLive = resolve(import.meta.dir, "chat-done.browser-live.ts");
const entrySource = `import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import AssistantWorkspace from ${JSON.stringify(resolve(import.meta.dir, "AssistantWorkspace.island.tsx"))};
render(() => <LocaleProvider locale="de"><AssistantWorkspace {...window.harness} /></LocaleProvider>, document.getElementById("root"));`;
const fakeLiveSource = `export const liveConnection = () => ({ subscribe: (_channel, _scope, handlers) => {
window.doneLive = handlers; return { close() {} }; } });`;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: entrySource, [fakeLive]: fakeLiveSource },
    target: "browser",
    format: "iife",
    minify: true,
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "chat-done-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle delegated-completion workspace.");
  const script = await build.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", cloud))).default;
  const styles: string[] = [];
  for (const path of [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")]) {
    const built = await Bun.build({ entrypoints: [path], plugins: [tailwind] });
    if (!built.success) throw new AggregateError(built.logs, "Could not compile workspace styles.");
    styles.push(await built.outputs[0]!.text());
  }
  const fonts = ["plex.css", "tabler.css"]
    .map((file) =>
      readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((?!["']?(?:data:|https?:))(["']?)(?:\.\/)?/g, "url($1/ui/"),
    )
    .join("\n");
  const css = [fonts, "@layer properties, theme, base, components, utilities;", ...styles].join("\n");
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

declare global {
  interface Window {
    doneLive?: { apply: (events: { data: unknown }[]) => Promise<void> };
  }
}

const open = async (width: number, theme: string) => {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce", locale: "de" });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = pageErrors(page);
  const unknown: string[] = [];
  let completed = false;
  let draft: unknown[] = [];
  let revision = 0;
  const detail = (id: string) => ({
    conversation: {
      ...chats.find((chat) => chat.id === id)!,
      draft: { content: id === "Source" ? draft : [], revision, updatedAt: now },
    },
    hasMoreMessages: false,
    activeTurn: null,
    messages:
      id === "Target"
        ? [
            chatDoneMessage(1, "Vergleiche drei Hotels.", {
              conversationId: id,
              loopId: "Turn02",
              message: { role: "user", content: [{ type: "text", text: "Vergleiche drei Hotels." }] },
              meta: { origin: { kind: "chat", id: "Source", name: "Reise nach Lyon", href: "/app/assistant?conversation=Source" } },
            }),
            chatDoneMessage(2, "Drei Hotels nahe der Messe: Saxe Lafayette, Novotel Eurexpo und Okko Hotels.", {
              conversationId: id,
              loopId: "Turn02",
            }),
          ]
        : [
            chatDoneMessage(1, "Mit dem Rhônexpress bis Part-Dieu, dann mit der Metro B zur Messe."),
            ...(completed ? [chatDoneFact()] : []),
          ],
    timeline:
      id === "Target"
        ? [
            {
              id: "Fact01",
              seq: 1,
              loopId: "Turn02",
              userPreview: "Vergleiche drei Hotels.",
              assistantPreview: "Drei Hotels nahe der Messe",
              isSteer: false,
              inputFileCount: 0,
              outputFileCount: 0,
              toolCount: 0,
              createdAt: now,
            },
          ]
        : [],
  });
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
  await page.route(`${assets.url.href}**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (
      path === "/harness.js" ||
      path === "/harness.css" ||
      path.startsWith("/ui/") ||
      path === "/api/assistant/artifacts/runtime/chart-parts"
    )
      return route.continue();
    if (path === "/app/assistant") {
      const id = url.searchParams.get("conversation") ?? "Source";
      const props = {
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
        models: [
          { id: "standard", label: "Standard", description: "", icon: { kind: "mark", text: "AI", color: "0" }, classes: ["balanced"] },
        ],
        selection: null,
        timeZone: "UTC",
        renderedAt: now,
        initialLiveCursor: "s6t.cloud-live-core.0",
        initialConversations: chats,
        initialDoneCount: 0,
        initialQuestions: { items: [], count: 0 },
        initialConversationId: id,
        initialArtifactPath: null,
        initialWorkspaceHref: path + url.search,
        initialDetail: detail(id),
        initialContext: null,
        projects: [],
        initialProject: null,
        initialProjectChats: null,
        initialProjectContext: null,
        approvals: { page: { items: [], nextCursor: null, count: 0, elsewhere: 0 }, open: false },
      };
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="de" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body class="k2b-ui" style="margin:0"><div id="root" style="display:flex;width:100%;height:100dvh"></div><script>window.harness=${JSON.stringify(props).replace(/</g, "\\u003c")}</script><script type="module" src="/harness.js"></script></body></html>`,
      });
    }
    if (path === "/api/assistant/workspace/sidebar")
      return route.fulfill({ json: { conversations: chats, projects: [], doneCount: 0, questions: { items: [], count: 0 } } });
    const chat = /^\/api\/ai\/conversations\/(Source|Target)$/.exec(path);
    if (chat) return route.fulfill({ json: detail(chat[1]!) });
    if (path.endsWith("/draft") && route.request().method() === "PUT") {
      draft = route.request().postDataJSON().content;
      return route.fulfill({ json: { content: draft, revision: ++revision, updatedAt: now } });
    }
    if (path.endsWith("/stream")) return;
    if (path.endsWith("/viewed")) return route.fulfill({ status: 204 });
    if (path.endsWith("/queue")) return route.fulfill({ json: [] });
    if (path.endsWith("/dictations")) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/api/approvals") return route.fulfill({ json: { items: [], nextCursor: null, count: 0, elsewhere: 0 } });
    if (path === "/api/capabilities/v1/queries/core/code.attention.list")
      return route.fulfill({ json: { data: { items: [], nextCursor: null } } });
    if (path === "/api/capabilities/v1/catalog")
      return route.fulfill({ json: { protocolVersion: 2, apps: [], page: { hasMore: false } } });
    if (path.endsWith("/tabs")) return route.fulfill({ json: { state: { tabs: [], layout: null, front: null }, revision: 0 } });
    const sidebar = /^\/api\/assistant\/workspace\/conversations\/(\w+)\/context$/.exec(path);
    if (sidebar) return route.fulfill({ json: emptySidebarSnapshot({ chatId: sidebar[1]! }) });
    if (path === "/api/assistant/workspace/web-reader") return route.fulfill({ json: { available: false } });
    const empty: Record<string, unknown> = {
      "/api/ai/resources/recent": { resources: [] },
      "/api/ai/quotas": { enabled: false, balances: [] },
      "/api/ai/skills": { skills: [] },
      "/api/ai/tasks": [],
    };
    if (path in empty) return route.fulfill({ json: empty[path] });
    unknown.push(`${route.request().method()} ${path}`);
    return route.fulfill({ status: 503, json: { message: "unavailable" } });
  });
  try {
    await page.goto(`${assets.url.origin}/app/assistant?conversation=Source`);
    await page.locator("textarea").first().waitFor();
    await settled(page);
  } catch (error) {
    console.error("Completion workspace errors:", errors);
    await context.close();
    throw error;
  }
  return {
    context,
    page,
    errors,
    unknown,
    complete: async () => {
      completed = true;
      await page.evaluate(async () => {
        await window.doneLive!.apply([
          {
            data: {
              type: "ai.invalidated",
              changeId: "99000000-0000-4000-8000-000000000009",
              conversationId: "Source",
              projectId: null,
              domains: ["conversation-detail"],
              at: "2026-11-19T10:20:00.000Z",
            },
          },
        ]);
      });
      const result = page.getByRole("link", { name: "Ergebnis ansehen" });
      await result.waitFor();
      await settled(page);
      return result;
    },
  };
};

for (const width of [390, 1440])
  for (const theme of ["light", "dark"])
    describe(`${width} ${theme}`, () => {
      let view: Awaited<ReturnType<typeof open>>;
      beforeEach(async () => {
        view = await open(width, theme);
      });
      afterEach(async () => {
        await view?.context.close();
      });

      test("a completion preserves composer and answer geometry, draft and focus", async () => {
        const { page, errors, unknown } = view;
        const field = page.locator("textarea").first();
        await field.fill("Mein Entwurf");
        await settled(page);
        const before = { field: await field.boundingBox(), answer: await page.locator("article").first().boundingBox() };
        await view.complete();
        expect(await field.boundingBox()).toEqual(before.field);
        expect(await page.locator("article").first().boundingBox()).toEqual(before.answer);
        expect(await field.inputValue()).toBe("Mein Entwurf");
        expect(await field.evaluate((node) => document.activeElement === node)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (process.env.CHAT_DONE_SHOTS) await page.screenshot({ path: `${process.env.CHAT_DONE_SHOTS}/done-${theme}-${width}.png` });
        expect(unknown).toEqual([]);
        expect(errors).toEqual([]);
      });

      test("the keyboard result jump focuses the target and keeps its provenance through reload and Back", async () => {
        const { page, errors, unknown } = view;
        const result = await view.complete();
        await result.focus();
        await result.press("Enter");
        await page.waitForURL("**conversation=Target&message=2");
        const anchor = page.locator('[data-chat-anchor="1"]');
        await page.waitForFunction(() => document.activeElement?.getAttribute("data-chat-anchor") === "1");
        expect(await anchor.textContent()).toContain("Vergleiche drei Hotels");
        expect(await page.locator('article[data-role="assistant"]').first().textContent()).toContain("Drei Hotels nahe der Messe");
        expect(await page.locator("[data-source]").first().textContent()).toContain("Aus dem Chat „Reise nach Lyon“");
        await page.reload();
        await page.waitForFunction(() => document.activeElement?.getAttribute("data-chat-anchor") === "1");
        await page.goBack();
        await page.getByRole("link", { name: "Ergebnis ansehen" }).waitFor();
        expect(unknown).toEqual([]);
        expect(errors).toEqual([]);
      });
    });
