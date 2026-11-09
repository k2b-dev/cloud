import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AiConversation, AiStoredMessage } from "@k2b/cloud/ai";
import type { Browser, Page, Route } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import type { AssistantPlaceView } from "./assistant-place";

// Gustav at a place in the side panel: the place bar, following the page (O1), the empty chat with starters, "Start
// over", "No access anymore", and the Gustav list's "At places" filter. The workspace runs against routes that answer
// like Cloud's place loader (GET /api/ai/places/:type/:id) and the Assistant's server. Only fictional people and places.
// Set GUSTAV_PLACE_SCREENSHOTS=<dir> to keep light screenshots for the mockup comparison.

const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");
const entry = resolve(import.meta.dir, "AssistantPlace.browser-entry.tsx");
const fakeLive = resolve(import.meta.dir, "AssistantPlace.browser-live.ts");
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
const fakeLiveSource = `
export const liveConnection = () => ({ subscribe: () => ({ close() {} }) });
`;
const shots = process.env.GUSTAV_PLACE_SCREENSHOTS?.trim();
const plum = "#8e1b6f";
const plumColors =
  "--app-ink-light:#8e1b6f;--app-ink-dark:#bf7dad;--app-selected-light:#f7eff5;--app-selected-dark:#231627;" +
  "--app-selected-nav-light:#f4e8f1;--app-selected-nav-dark:#261629";

const now = Date.parse("2026-11-09T09:30:00.000Z");
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
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

const pageId = "88888888-8888-4888-8888-888888888888";
const app = { id: "kontakt", name: "Kundenkontakt", icon: "ti ti-messages" };
const placeRef = (id: string) => ({ type: "kontakt.conversation", id });
const people: Record<string, string> = { u_marta: "Marta Beispiel", u_jonas: "Jonas Probe", u_erika: "Erika Muster" };

/** A listed chat's place as the sidebar snapshot carries it: with the app that names it. */
const placeOf = (id: string) => {
  const place = { ref: placeRef(id), title: people[id]!, app };
  return place;
};
const conversation = (id: string, title: string, minutesAgo: number, place?: string): AiConversation => ({
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
  lastUsedAt: at(minutesAgo),
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 1, updatedAt: null },
  createdByUserId: "user123",
  createdAt: at(600),
  updatedAt: at(minutesAgo),
  ...(place ? { place: placeOf(place) } : {}),
});
const chats = [
  conversation("Steu42", "Steuer-Checkliste 2026", 60),
  conversation("Komm42", "Angebot Biedermeier-Kommode", 90),
  conversation("Etik42", "Lagerplatz-Etiketten", 200),
];
const placeChats = [
  conversation("Pmarta", "Antwort an Marta Beispiel", 10, "u_marta"),
  conversation("Pjonas", "Abholung Jonas Probe", 1500, "u_jonas"),
];
const stored = (conversationId: string, seq: number, role: "user" | "assistant", text: string): AiStoredMessage => ({
  id: `${conversationId}M${seq}`,
  shortId: `${conversationId}M${seq}`,
  conversationId,
  seq,
  kind: "message",
  message: { role, content: [{ type: "text", text }] },
  loopId: `${conversationId}T1`,
  modelId: "standard",
  providerModel: "standard",
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta: null,
  createdAt: at(10 - seq),
});
const messagesOf: Record<string, AiStoredMessage[]> = {
  Pmarta: [
    stored("Pmarta", 1, "user", "Kürzer, biete Post an und häng die Abrechnung an."),
    stored("Pmarta", 2, "assistant", "Erledigt. Die Antwort hat jetzt 2 Sätze und bietet den Postversand an."),
  ],
  Pjonas: [
    stored("Pjonas", 1, "user", "Kann Jonas am Freitag abholen?"),
    stored("Pjonas", 2, "assistant", "Ja, Freitag ab 14 Uhr passt laut Kalender."),
  ],
  Steu42: [
    stored("Steu42", 1, "user", "Was muss ich für die Steuer 2026 alles sammeln?"),
    stored("Steu42", 2, "assistant", "Hier ist eine Checkliste für 2026 …"),
  ],
};
const allChats = [...chats, ...placeChats];
const detailOf = (id: string) => {
  const chat = allChats.find((item) => item.id === id)!;
  return { conversation: chat, messages: messagesOf[id] ?? [], hasMoreMessages: false, activeTurn: null, timeline: [] };
};

const available = (id: string, conversationId: string | null): AssistantPlaceView => ({
  state: "available",
  ref: placeRef(id),
  title: people[id]!,
  app,
  typeTitle: "Unterhaltung",
  tools: [
    { id: "reply.set", title: "Antwort setzen", icon: "ti ti-pencil", policy: { silent: "you" } },
    { id: "reply.attach", title: "Beleg anhängen", icon: "ti ti-paperclip", policy: { silent: "you" } },
    { id: "topic.set", title: "Anliegen setzen", icon: "ti ti-tag", policy: { silent: "shared" } },
    { id: "note.add", title: "Interne Notiz anlegen", icon: "ti ti-note", policy: { silent: "shared" } },
  ],
  skills: [{ id: "kundenkontakt", title: "Kundenkontakt" }],
  starters: [
    { label: "Antwort kürzer machen", prompt: "Mach die Antwort kürzer." },
    { label: `Mails von ${people[id]} suchen`, prompt: `Such Mails von ${people[id]}.` },
    { label: "Offene Belege zusammenfassen", prompt: "Fass die offenen Belege zusammen." },
  ],
  conversationId,
});

type Scenario = {
  /** The page's place; none: a page without a place. */
  place?: string;
  /** What the place loader answers for each place id; missing ids answer 503. */
  answers: Record<string, AssistantPlaceView | "fail">;
  /** The place's answer at first paint; omitted: the panel loads it after start. */
  initial?: boolean;
  conversationId?: string | null;
  /** The full Gustav app instead of the panel. */
  full?: boolean;
  placesFilter?: boolean;
  creationErrors?: number[];
};

const models = [
  { id: "standard", label: "Ausgewogen", description: "", icon: { kind: "mark", text: "M", color: "0" }, classes: ["balanced"] },
];

type View = { name: string; width: number; height: number; touch: boolean; column?: string };
const desktop: View = { name: "1440", width: 1440, height: 900, touch: false };
const panel: View = { name: "1440", width: 1440, height: 900, touch: false, column: "26rem" };
const phone: View = { name: "390", width: 390, height: 844, touch: true };

const propsOf = (scenario: Scenario, url: URL) => {
  const answer = scenario.place && scenario.initial ? scenario.answers[scenario.place] : undefined;
  const conversationId = scenario.conversationId ?? null;
  const detail = conversationId ? detailOf(conversationId) : null;
  return {
    embedded: !scenario.full,
    initialPanelContext: scenario.place ? { v: 1, seq: 1, pageId, app: "kontakt", scope: placeRef(scenario.place) } : null,
    initialPlace: answer && answer !== "fail" ? answer : null,
    initialPlaceChats: { total: placeChats.length, items: placeChats },
    initialPlacesFilter: Boolean(scenario.placesFilter),
    initialCounts: { unread: 0, needsAttention: 0, places: { total: placeChats.length, unread: 0, needsAttention: 0 } },
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
      options: models,
    },
    models,
    timeZone: "Europe/Berlin",
    renderedAt: new Date(now).toISOString(),
    initialLiveCursor: "s6t.cloud-live-core.0",
    initialConversations: chats,
    initialDoneCount: 0,
    initialQuestions: { items: [], count: 0 },
    initialConversationId: conversationId,
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
    code: { has: false, open: false },
    // The place owns no Code: the "Code of …" block stays hidden, as for any place without Code.
    initialCodeBlock: scenario.place ? { ref: placeRef(scenario.place), page: { items: [], nextCursor: null } } : null,
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
        name: "assistant-place",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the place harness.");
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
  const fonts = ["plex.css", "tabler.css"]
    .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, "url($1/ui/"))
    .join("\n");
  css = [fonts, "@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
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

const open = async (view: View, scenario: Scenario, options: { theme?: "light" | "dark" } = {}) => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    locale: "de",
  });
  await context.addInitScript(pinPageClock, now);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = pageErrors(page);
  const placeCalls: string[] = [];
  const created: unknown[] = [];
  const archived: string[] = [];
  const drafts: { id: string; expectedRevision: number }[] = [];
  const createdChats = new Map<string, AiConversation>();
  const turns: string[] = [];
  /** Answers held back until the test releases them, by place id. */
  const held = new Map<string, () => void>();
  const hold = new Set<string>();
  const heldChats = new Map<string, () => void>();
  const holdChats = new Set<string>();
  await page.route(`${assets.url.href}**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/harness.js" || url.pathname === "/harness.css" || url.pathname.startsWith("/ui/")) return route.continue();
    if (url.pathname === "/app/assistant" || url.pathname === "/app/assistant/panel") {
      const harness = { locale: "de", props: propsOf(scenario, url) };
      const outer = view.column ? "display:flex;justify-content:flex-end;height:100vh" : "display:flex;height:100vh";
      const inner = view.column
        ? `<div id="root" style="width:${view.column};display:flex;height:100vh;border-left:1px solid #e4e4e7"></div>`
        : `<div id="root" style="display:flex;width:100%;height:100vh"></div>`;
      const panelContext = harness.props.initialPanelContext
        ? `<script type="application/json" id="cloud-panel-context">${JSON.stringify(harness.props.initialPanelContext)}</script>`
        : `<script type="application/json" id="cloud-panel-context">null</script>`;
      return route.fulfill({
        contentType: "text/html",
        body:
          `<!doctype html><html lang="de" class="${options.theme ?? "light"}"><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"></head>` +
          `<body class="k2b-ui" style="margin:0">${panelContext}<div class="app-accent-scope" style="${outer};--app-accent:${plum};${plumColors}">${inner}</div>` +
          `<script>window.harness = ${JSON.stringify(harness).replace(/</g, "\\u003c")};</script><script type="module" src="/harness.js"></script></body></html>`,
      });
    }
    const place = /^\/api\/ai\/places\/kontakt\.conversation\/(\w+)$/.exec(url.pathname);
    if (place) {
      const id = place[1]!;
      placeCalls.push(id);
      if (hold.has(id)) await new Promise<void>((release) => held.set(id, release));
      const answer = scenario.answers[id];
      if (!answer || answer === "fail") return route.fulfill({ status: 503, json: { message: "unavailable" } });
      // The server's own shape: no block and missing consent carry no place.
      if (answer.state === "none") return route.fulfill({ json: { state: "none" } });
      if (answer.state === "consent") return route.fulfill({ json: { state: "consent_required" } });
      return route.fulfill({ json: answer });
    }
    const chat = /^\/api\/ai\/conversations\/(\w+)(\/.*)?$/.exec(url.pathname);
    if (chat) {
      const [, id, suffix = ""] = chat;
      if (suffix === "/stream") return; // stays open like a quiet stream
      if (suffix === "/archive" && method === "POST") {
        archived.push(id!);
        return route.fulfill({ status: 204 });
      }
      if (suffix === "" && method === "GET" && holdChats.has(id!)) await new Promise<void>((release) => heldChats.set(id!, release));
      if (suffix === "" && method === "GET" && allChats.some((item) => item.id === id)) return route.fulfill({ json: detailOf(id!) });
      const fresh = createdChats.get(id!);
      if (suffix === "" && method === "GET" && fresh)
        return route.fulfill({ json: { conversation: fresh, messages: [], hasMoreMessages: false, activeTurn: null, timeline: [] } });
      if (suffix === "/viewed") return route.fulfill({ json: {} });
      if (suffix === "/draft" && method === "PUT") {
        const body = route.request().postDataJSON();
        drafts.push({ id: id!, expectedRevision: body.expectedRevision });
        // The created place chat holds its first message at revision 1, as the server stores it.
        if (body.expectedRevision !== 1) return route.fulfill({ status: 409, json: { message: "Draft conflict" } });
        return route.fulfill({ json: { content: body.content, revision: 2, updatedAt: at(0) } });
      }
      if (suffix === "/turns" && method === "POST") {
        turns.push(id!);
        return route.fulfill({ status: 503, json: { message: "unavailable" } });
      }
      if (suffix === "/dictations") return route.fulfill({ json: { items: [], nextCursor: null } });
      return route.fulfill({ json: [] });
    }
    if (url.pathname === "/api/ai/conversations" && method === "POST") {
      const body = route.request().postDataJSON();
      created.push(body);
      const failure = scenario.creationErrors?.shift();
      if (failure) return route.fulfill({ status: failure, json: { message: "Creation refused" } });
      const fresh = { ...conversation(`Pnew0${createdChats.size + 1}`, people[body.place?.id] ?? "Neu", 0, body.place?.id) };
      createdChats.set(fresh.id, fresh);
      return route.fulfill({ status: 201, json: fresh });
    }
    if (url.pathname === "/api/assistant/workspace/sidebar")
      return route.fulfill({
        json: {
          conversations: chats,
          counts: { unread: 0, needsAttention: 0, places: { total: placeChats.length, unread: 0, needsAttention: 0 } },
          placeChats: { total: placeChats.length, items: placeChats },
          projects: [],
          doneCount: 0,
          questions: { items: [], count: 0 },
        },
      });
    if (url.pathname === "/api/capabilities/v1/queries/core/code.list")
      return route.fulfill({ json: { data: { items: [], nextCursor: null } } });
    if (url.pathname === "/api/approvals") return route.fulfill({ json: { items: [], nextCursor: null, count: 0, elsewhere: 0 } });
    const empty: Record<string, unknown> = {
      "/api/ai/resources/recent": { resources: [] },
      "/api/ai/quotas": { enabled: false, balances: [] },
      "/api/ai/skills": { skills: [] },
      "/api/ai/tasks": [],
      "/api/apps/badges": { total: 0, apps: {} },
      "/api/capabilities/v1/catalog": { protocolVersion: 2, apps: [], page: { hasMore: false } },
    };
    if (url.pathname in empty) return route.fulfill({ json: empty[url.pathname] });
    return route.fulfill({ status: 503, json: { message: "unavailable" } });
  });
  const path = scenario.full
    ? `/app/assistant${scenario.placesFilter ? "?places=1" : ""}`
    : `/app/assistant/panel${scenario.conversationId ? `?conversation=${scenario.conversationId}` : ""}`;
  await page.goto(`${assets.url.origin}${path}`, { timeout: 30_000 });
  /** The host page moved: the panel receives the next context, as the shell's receiver delivers it. */
  const navigateHost = (seq: number, id: string | null) =>
    page.evaluate(
      ([next]) => {
        document.getElementById("cloud-panel-context")!.textContent = JSON.stringify(next);
        window.dispatchEvent(new Event("cloud.panel.context.changed"));
      },
      [id ? { v: 1, seq, pageId, app: "kontakt", scope: placeRef(id) } : { v: 1, seq, pageId, app: "kontakt" }] as const,
    );
  const setAnswer = async (id: string, answer: AssistantPlaceView) => {
    scenario.answers[id] = answer;
  };
  const withdrawContext = () =>
    page.evaluate(() => {
      document.getElementById("cloud-panel-context")!.textContent = "null";
      window.dispatchEvent(new Event("cloud.panel.context.changed"));
    });
  return {
    page,
    scenario,
    errors,
    placeCalls,
    created,
    archived,
    drafts,
    turns,
    setAnswer,
    hold,
    held,
    holdChats,
    heldChats,
    navigateHost,
    withdrawContext,
    close: () => context.close(),
  };
};

const poll = async (read: () => unknown, expected: unknown, timeout = 5_000) => {
  const end = performance.now() + timeout;
  while (performance.now() < end && read() !== expected) await new Promise((resolve) => setTimeout(resolve, 50));
  expect(read()).toBe(expected);
};
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(shots, `${name}.png`) });
};
const bar = (page: Page) => page.getByRole("group", { name: "Ort dieses Chats" });
/** The bar's first row keeps one height in every state, so the chat below never moves when the state changes. */
const rowHeight = (page: Page) =>
  bar(page)
    .locator(".assistant-place-bar__row")
    .first()
    .evaluate((row) => row.getBoundingClientRect().height);

describe("Gustav at a place", () => {
  test("a cancelled chat open does not leave place following on for a later normal chat", async () => {
    const h = await open(panel, {
      place: "u_marta",
      initial: true,
      answers: { u_marta: available("u_marta", null), u_jonas: available("u_jonas", "Pjonas"), u_erika: available("u_erika", null) },
    });
    try {
      await h.page.getByRole("heading", { name: "Frag Gustav zu Marta Beispiel" }).waitFor();
      h.holdChats.add("Pjonas");
      await h.navigateHost(2, "u_jonas");
      await poll(() => h.heldChats.has("Pjonas"), true);
      await h.navigateHost(3, null);
      h.holdChats.delete("Pjonas");
      h.heldChats.get("Pjonas")!();
      await settled(h.page);
      expect(new URL(h.page.url()).searchParams.get("conversation")).not.toBe("Pjonas");
      // The panel receives a normal chat selected through the shell's search navigation bridge.
      await h.page.evaluate(async () => {
        const detail = {
          target: { href: "/app/assistant/panel?conversation=Steu42", ref: { type: "assistant.chat", id: "Steu42" } },
          handled: undefined as Promise<boolean> | undefined,
        };
        window.dispatchEvent(new CustomEvent("cloud.search.navigate", { detail }));
        await detail.handled;
      });
      await h.page.getByText("Hier ist eine Checkliste für 2026").waitFor();
      expect(await bar(h.page).count()).toBe(0);
      await h.navigateHost(4, "u_erika");
      await bar(h.page).getByRole("button", { name: "Zu Erika Muster wechseln" }).waitFor();
      expect(new URL(h.page.url()).searchParams.get("conversation")).toBe("Steu42");
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  }, 60_000);

  test("a same-place context refresh keeps the pending chat switch", async () => {
    const h = await open(panel, {
      place: "u_marta",
      initial: true,
      conversationId: "Pmarta",
      answers: { u_marta: available("u_marta", "Pmarta"), u_jonas: available("u_jonas", "Pjonas") },
    });
    try {
      await h.page.getByText("Erledigt. Die Antwort hat jetzt 2 Sätze").waitFor();
      h.holdChats.add("Pjonas");
      await h.navigateHost(2, "u_jonas");
      await poll(() => h.heldChats.has("Pjonas"), true);
      await h.navigateHost(3, "u_jonas");
      h.holdChats.delete("Pjonas");
      h.heldChats.get("Pjonas")!();
      await h.page.getByText("Ja, Freitag ab 14 Uhr passt laut Kalender.").waitFor();
      await settled(h.page);
      expect(new URL(h.page.url()).searchParams.get("conversation")).toBe("Pjonas");
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  }, 60_000);

  for (const plain of [false, true]) {
    test(`an unknown ${plain ? "plain" : "place"} creation cannot retarget the next place's first message`, async () => {
      const h = await open(panel, {
        ...(plain ? {} : { place: "u_marta", initial: true }),
        creationErrors: [503],
        answers: { u_marta: available("u_marta", null), u_jonas: available("u_jonas", null) },
      });
      try {
        const composer = h.page.getByRole("textbox").last();
        await composer.click();
        await h.page.keyboard.type("First attempt");
        await h.page.keyboard.press("Enter");
        await poll(() => h.created.length, 1);
        await h.navigateHost(2, "u_jonas");
        await bar(h.page).getByRole("button", { name: "Zu Jonas Probe wechseln" }).click();
        await h.page.getByRole("heading", { name: "Frag Gustav zu Jonas Probe" }).waitFor();
        await composer.click();
        await h.page.keyboard.press("ControlOrMeta+A");
        await h.page.keyboard.type("Second place message");
        await h.page.keyboard.press("Enter");
        await poll(() => h.created.length, 2);
        expect(h.created[1]).toMatchObject({
          place: placeRef("u_jonas"),
          draft: { content: [{ type: "text", text: "Second place message" }] },
        });
        await poll(() => h.turns.length, 1);
        expect(h.turns).toEqual(["Pnew01"]);
        expect(h.errors).toEqual([]);
      } finally {
        await h.close();
      }
    }, 60_000);
  }

  test("a plain first-save creation does not enable the place composer after switching", async () => {
    const h = await open(panel, { answers: { u_marta: available("u_marta", null) } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await h.page.route("**/api/ai/conversations", async (route) => {
      if (route.request().method() === "POST") await gate;
      await route.fallback();
    });
    try {
      const composer = h.page.getByRole("textbox").last();
      const creating = h.page.waitForRequest(
        (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/ai/conversations",
      );
      await composer.fill("Plain draft awaiting its first save");
      await creating;
      expect(await composer.isEnabled()).toBe(true);
      await h.navigateHost(2, "u_marta");
      await bar(h.page).getByRole("button", { name: "Zu Marta Beispiel wechseln" }).click();
      await h.page.getByRole("heading", { name: "Frag Gustav zu Marta Beispiel" }).waitFor();
      // The pending create belongs to the plain draft; a place send must not join or silently fail on that create.
      expect(await composer.isDisabled()).toBe(true);
      expect(h.turns).toEqual([]);
      release();
      await poll(() => h.created.length, 1);
      await h.page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("textarea:not([aria-hidden='true'])")?.disabled);
      expect(h.errors).toEqual([]);
    } finally {
      release();
      await h.close();
    }
  }, 60_000);

  test("background creation recovery keeps its original request and the visible chat", async () => {
    const h = await open(panel, {
      place: "u_marta",
      initial: true,
      creationErrors: [503],
      answers: { u_marta: available("u_marta", null), u_jonas: available("u_jonas", null) },
    });
    try {
      const composer = h.page.getByRole("textbox").last();
      await composer.click();
      await h.page.keyboard.type("Original message for Marta");
      await h.page.keyboard.press("Enter");
      await poll(() => h.created.length, 1);
      await h.navigateHost(2, "u_jonas");
      await bar(h.page).getByRole("button", { name: "Zu Jonas Probe wechseln" }).click();
      await h.page.getByRole("heading", { name: "Frag Gustav zu Jonas Probe" }).waitFor();
      await composer.click();
      await h.page.keyboard.press("ControlOrMeta+A");
      await h.page.keyboard.type("Message for Jonas");
      await h.page.keyboard.press("Enter");
      await poll(() => h.turns.length, 1);
      h.scenario.creationErrors = [403, 409];
      for (const expected of [3, 4]) {
        await h.page.getByRole("button", { name: "Erstellen erneut versuchen", exact: true }).click();
        await poll(() => h.created.length, expected);
        await h.page.getByText("Original message for Marta", { exact: true }).waitFor();
        expect(h.created[expected - 1]).toEqual(h.created[0]);
        expect(new URL(h.page.url()).searchParams.get("conversation")).toBe("Pnew01");
      }
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  }, 60_000);

  test("a concurrent first-message conflict opens the existing place chat and retains the local text", async () => {
    const h = await open(panel, {
      place: "u_marta",
      initial: true,
      creationErrors: [409],
      answers: { u_marta: available("u_marta", null) },
    });
    try {
      await h.page.getByRole("heading", { name: "Frag Gustav zu Marta Beispiel" }).waitFor();
      await h.setAnswer("u_marta", available("u_marta", "Pmarta"));
      const composer = h.page.getByRole("textbox").last();
      await composer.click();
      await h.page.keyboard.type("Keep my text from the other tab");
      await h.page.keyboard.press("Enter");
      await h.page.getByText("Erledigt. Die Antwort hat jetzt 2 Sätze").waitFor();
      await settled(h.page);
      expect(new URL(h.page.url()).searchParams.get("conversation")).toBe("Pmarta");
      expect(await composer.inputValue().catch(() => composer.textContent())).toContain("Keep my text from the other tab");
      expect(h.created).toHaveLength(1);
      expect(h.turns).toEqual([]);
      await poll(() => h.drafts.length, 1);
      expect(h.drafts[0]).toEqual({ id: "Pmarta", expectedRevision: 1 });
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  }, 60_000);

  test("withdrawing consent removes stale starters and offers the shell's context question", async () => {
    const h = await open(panel, { place: "u_marta", initial: true, answers: { u_marta: available("u_marta", null) } });
    try {
      await h.page.getByRole("heading", { name: "Frag Gustav zu Marta Beispiel" }).waitFor();
      const composer = h.page.getByRole("textbox").last();
      await composer.click();
      await h.page.keyboard.type("Keep this at Marta while sharing is paused");
      await h.withdrawContext();
      await settled(h.page);
      await bar(h.page).getByRole("button", { name: "Kontext teilen …" }).waitFor();
      expect(await h.page.getByRole("group", { name: "Vorschläge von Kundenkontakt" }).count()).toBe(0);
      // Observe beyond the 2s draft debounce: withdrawal must keep this unsaved place draft local.
      await h.page.waitForTimeout(2_300);
      expect(await composer.inputValue().catch(() => composer.textContent())).toContain("Keep this at Marta while sharing is paused");
      expect(h.created).toEqual([]);
      expect(h.placeCalls).toEqual([]);
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  }, 60_000);

  test("the empty chat at a place names it, offers the app's starters, and creates the chat with the first message", async () => {
    for (const [view, name] of [
      [panel, "01-panel-ort-leer-light-1440"],
      [phone, "01-panel-ort-leer-light-390"],
    ] as const) {
      const h = await open(view, { place: "u_marta", initial: true, answers: { u_marta: available("u_marta", null) } });
      try {
        await h.page.getByRole("heading", { name: "Frag Gustav zu Marta Beispiel" }).waitFor();
        const starters = h.page.getByRole("group", { name: "Vorschläge von Kundenkontakt" });
        expect(await starters.getByRole("button").allTextContents()).toEqual([
          "Antwort kürzer machen",
          "Mails von Marta Beispiel suchen",
          "Offene Belege zusammenfassen",
        ]);
        expect(await bar(h.page).getByText("Kundenkontakt", { exact: true }).count()).toBe(1);
        expect(await bar(h.page).getByText("Antwort setzen").count()).toBe(1);
        expect(await bar(h.page).getByText("Skill Kundenkontakt").count()).toBe(1);
        // A Gustav place replaces "Attach current view".
        expect(await h.page.getByRole("button", { name: "Aktuelle Ansicht anhängen" }).count()).toBe(0);
        // The first paint already knew the place; nothing loads it again.
        expect(h.placeCalls).toEqual([]);
        await shot(h.page, name);
        if (view === panel) {
          await starters.getByRole("button", { name: "Antwort kürzer machen" }).click();
          const composer = h.page.getByRole("textbox").last();
          expect(await composer.inputValue().catch(() => composer.textContent())).toContain("Mach die Antwort kürzer.");
          // Typing alone creates no chat at the place (O2).
          await h.page.waitForTimeout(2_300);
          expect(h.created).toEqual([]);
          await h.page.keyboard.press("Enter");
          await poll(() => h.created.length, 1);
          expect(h.created[0]).toMatchObject({ place: placeRef("u_marta"), draft: { content: [{ type: "text" }] } });
          expect(h.created[0]).not.toHaveProperty("title");
          // The message then goes out in the new chat, building on the draft its creation stored.
          await poll(() => h.turns.length, 1);
          expect(h.turns).toEqual(["Pnew01"]);
          expect(h.drafts).toEqual([{ id: "Pnew01", expectedRevision: 1 }]);
        }
        expect(h.errors).toEqual([]);
      } finally {
        await h.close();
      }
    }
  }, 120_000);

  test("a chat at the place shows its tools, says only you read it, and explains what Gustav can do here", async () => {
    const h = await open(panel, {
      place: "u_marta",
      initial: true,
      conversationId: "Pmarta",
      answers: { u_marta: available("u_marta", "Pmarta") },
    });
    try {
      await h.page.getByText("Erledigt. Die Antwort hat jetzt 2 Sätze").waitFor();
      expect(await bar(h.page).getByText("nur du", { exact: true }).count()).toBe(1);
      await shot(h.page, "02-panel-ort-chat-light-1440");
      await bar(h.page).getByRole("button", { name: "Was Gustav hier kann" }).click();
      const what = h.page.getByRole("dialog", { name: "Was Gustav hier zusätzlich kann" });
      await what.waitFor();
      expect(await what.getByText("nur bei dir · fragt beim ersten Mal").count()).toBe(2);
      expect(await what.getByText("andere sehen es · fragt beim ersten Mal").count()).toBe(2);
      await what.getByText("Alle anderen Werkzeuge, Skills und Erinnerungen, wie in jedem Gustav-Chat").waitFor();
      await shot(h.page, "03-was-gustav-hier-kann-light-1440");
      await h.page.keyboard.press("Escape");
      await what.waitFor({ state: "detached" });

      // "Start over" archives the chat at the place and returns to its empty chat.
      await h.page.getByRole("button", { name: "Neu beginnen" }).click();
      await h.page.getByRole("heading", { name: "Frag Gustav zu Marta Beispiel" }).waitFor();
      expect(h.archived).toEqual(["Pmarta"]);
      expect(new URL(h.page.url()).searchParams.has("conversation")).toBe(false);
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  }, 60_000);

  test("navigating follows the page to the next place, and a late answer for the earlier page changes nothing", async () => {
    const h = await open(panel, {
      place: "u_marta",
      initial: true,
      conversationId: "Pmarta",
      answers: {
        u_marta: available("u_marta", "Pmarta"),
        u_jonas: available("u_jonas", "Pjonas"),
        u_erika: available("u_erika", null),
      },
    });
    try {
      await h.page.getByText("Erledigt. Die Antwort hat jetzt 2 Sätze").waitFor();
      const before = await rowHeight(h.page);
      // Jonas answers late; Erika, the newer page, answers first.
      h.hold.add("u_jonas");
      await h.navigateHost(2, "u_jonas");
      await poll(() => h.held.has("u_jonas"), true);
      await h.navigateHost(3, "u_erika");
      await h.page.getByRole("heading", { name: "Frag Gustav zu Erika Muster" }).waitFor();
      h.hold.delete("u_jonas");
      h.held.get("u_jonas")!();
      await h.page.waitForTimeout(400);
      expect(await h.page.getByRole("heading", { name: "Frag Gustav zu Erika Muster" }).count()).toBe(1);
      expect(await h.page.getByText("Ja, Freitag ab 14 Uhr").count()).toBe(0);
      expect(await rowHeight(h.page)).toBe(before);

      // Back at Jonas, the panel opens his chat at that place.
      await h.navigateHost(4, "u_jonas");
      await settled(h.page);
      await h.page.getByText("Ja, Freitag ab 14 Uhr passt laut Kalender.").waitFor();
      expect(new URL(h.page.url()).searchParams.get("conversation")).toBe("Pjonas");
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  }, 60_000);

  test("the bar reads in dark mode too", async () => {
    const h = await open(
      panel,
      { place: "u_marta", initial: true, conversationId: "Pmarta", answers: { u_marta: available("u_marta", "Pmarta") } },
      { theme: "dark" },
    );
    try {
      await bar(h.page).getByText("Antwort setzen").waitFor();
      await shot(h.page, "02-panel-ort-chat-dark-1440");
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  }, 60_000);

  test("text typed at an empty place is kept: the panel stays and offers the switch", async () => {
    const h = await open(panel, {
      place: "u_marta",
      initial: true,
      answers: { u_marta: available("u_marta", null), u_jonas: available("u_jonas", "Pjonas") },
    });
    try {
      await h.page.getByRole("heading", { name: "Frag Gustav zu Marta Beispiel" }).waitFor();
      await h.page.getByRole("textbox").last().click();
      await h.page.keyboard.type("Bitte noch");
      await h.navigateHost(2, "u_jonas");
      await bar(h.page).getByRole("button", { name: "Zu Jonas Probe wechseln" }).waitFor();
      expect(await h.page.getByRole("heading", { name: "Frag Gustav zu Marta Beispiel" }).count()).toBe(1);
      expect(h.created).toEqual([]);
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  }, 60_000);

  test("another open chat stays, and the bar offers the switch in its fixed slot", async () => {
    const h = await open(panel, {
      place: "u_marta",
      initial: true,
      conversationId: "Steu42",
      answers: { u_marta: available("u_marta", "Pmarta") },
    });
    try {
      await h.page.getByText("Hier ist eine Checkliste für 2026").waitFor();
      const switchTo = bar(h.page).getByRole("button", { name: "Zu Marta Beispiel wechseln" });
      await switchTo.waitFor();
      await shot(h.page, "04-anderer-chat-wechseln-light-1440");
      await switchTo.click();
      await h.page.getByText("Erledigt. Die Antwort hat jetzt 2 Sätze").waitFor();
      expect(await bar(h.page).getByText("Antwort setzen").count()).toBe(1);
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  }, 60_000);

  test("without access to the place the chat stays readable and the bar says so (O5)", async () => {
    const h = await open(panel, {
      place: "u_marta",
      initial: true,
      conversationId: "Pmarta",
      answers: { u_marta: { state: "unavailable", ref: placeRef("u_marta"), title: "Marta Beispiel", conversationId: "Pmarta" } },
    });
    try {
      await h.page.getByText("Erledigt. Die Antwort hat jetzt 2 Sätze").waitFor();
      await bar(h.page).getByText("Kein Zugriff mehr auf Marta Beispiel.", { exact: false }).waitFor();
      expect(await bar(h.page).getByText("Antwort setzen").count()).toBe(0);
      expect(await bar(h.page).getByRole("button", { name: "Was Gustav hier kann" }).count()).toBe(0);
      await shot(h.page, "05-kein-zugriff-light-1440");
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  }, 60_000);

  test("the bar tells no block, missing consent, a place and lost access apart, also for an existing chat there", async () => {
    const states: { name: string; answer: AssistantPlaceView }[] = [
      { name: "none", answer: { state: "none", ref: placeRef("u_marta") } },
      { name: "consent", answer: { state: "consent", ref: placeRef("u_marta") } },
      { name: "available", answer: available("u_marta", "Pmarta") },
      {
        name: "unavailable",
        answer: { state: "unavailable", ref: placeRef("u_marta"), title: "Marta Beispiel", conversationId: "Pmarta" },
      },
    ];
    for (const { name, answer } of states) {
      // The existing chat at the place stays readable in every state.
      const h = await open(panel, { place: "u_marta", initial: true, conversationId: "Pmarta", answers: { u_marta: answer } });
      try {
        await h.page.getByText("Erledigt. Die Antwort hat jetzt 2 Sätze").waitFor();
        const gone = await bar(h.page).getByText("Kein Zugriff mehr", { exact: false }).count();
        const tools = await bar(h.page).getByText("Antwort setzen").count();
        const ask = await bar(h.page).getByRole("button", { name: "Kontext teilen …" }).count();
        const bars = await bar(h.page).count();
        expect({ name, bars, gone, tools, ask }).toEqual({
          name,
          bars: name === "none" ? 0 : 1,
          gone: name === "unavailable" ? 1 : 0,
          tools: name === "available" ? 1 : 0,
          ask: name === "consent" ? 1 : 0,
        });
        if (name === "consent") {
          await shot(h.page, "09-ort-ohne-einwilligung-light-1440");
          // Once the person allows it in the shell, the shell sends the context again and the place loads.
          await h.setAnswer("u_marta", available("u_marta", "Pmarta"));
          await h.navigateHost(2, "u_marta");
          await bar(h.page).getByText("Antwort setzen").waitFor();
          expect(await bar(h.page).getByText("Kein Zugriff mehr", { exact: false }).count()).toBe(0);
        }
        expect(h.errors).toEqual([]);
      } finally {
        await h.close();
      }
    }
    // Without a chat there: missing consent shows the same bar, no block shows the normal empty panel.
    const consent = await open(panel, { place: "u_marta", initial: true, answers: { u_marta: states[1]!.answer } });
    try {
      await bar(consent.page).getByRole("button", { name: "Kontext teilen …" }).waitFor();
      expect(await consent.page.getByRole("heading", { name: "Woran möchtest du arbeiten?" }).count()).toBe(1);
      expect(await consent.page.getByRole("button", { name: "Aktuelle Ansicht anhängen" }).count()).toBe(0);
    } finally {
      await consent.close();
    }
  }, 120_000);

  test("a place that fails to load keeps its slot, keeps Attach current view, and recovers on retry", async () => {
    const answers: Scenario["answers"] = { u_marta: "fail" };
    const h = await open(panel, { place: "u_marta", answers });
    try {
      await bar(h.page).getByText("Gustav konnte diesen Ort nicht laden.").waitFor();
      await h.page.getByRole("button", { name: "Aktuelle Ansicht anhängen" }).waitFor();
      const failedHeight = await rowHeight(h.page);
      await shot(h.page, "06-ort-laden-fehler-light-1440");
      answers.u_marta = available("u_marta", null);
      await bar(h.page).getByRole("button", { name: "Erneut versuchen" }).click();
      await h.page.getByRole("heading", { name: "Frag Gustav zu Marta Beispiel" }).waitFor();
      expect(await rowHeight(h.page)).toBe(failedHeight);
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  }, 60_000);

  test("a place whose app declares no Gustav block keeps the normal panel with Attach current view", async () => {
    const h = await open(panel, { place: "u_marta", answers: { u_marta: { state: "none", ref: placeRef("u_marta") } } });
    try {
      await h.page.getByRole("button", { name: "Aktuelle Ansicht anhängen" }).waitFor();
      expect(await bar(h.page).count()).toBe(0);
      expect(await h.page.getByRole("heading", { name: "Woran möchtest du arbeiten?" }).count()).toBe(1);
    } finally {
      await h.close();
    }
  }, 60_000);

  test("the Gustav list leaves chats at places out, and At places lists them with app and place", async () => {
    const h = await open(desktop, { full: true, answers: {} });
    try {
      const sidebar = h.page.locator('[data-sidebar-mode="expanded"]').first();
      await h.page.getByRole("button", { name: "An Orten 2" }).waitFor();
      expect(await h.page.getByText("Antwort an Marta Beispiel").filter({ visible: true }).count()).toBe(0);
      await shot(h.page, "07-liste-ohne-orte-light-1440");
      await h.page.getByRole("button", { name: "An Orten 2" }).click();
      await h.page.getByText("An Orten · nur deine Chats").waitFor();
      await h.page.getByText("Kundenkontakt · Marta Beispiel").waitFor();
      expect(await h.page.getByText("Steuer-Checkliste 2026").filter({ visible: true }).count()).toBe(0);
      expect(new URL(h.page.url()).searchParams.get("places")).toBe("1");
      await shot(h.page, "08-liste-an-orten-light-1440");
      // The same chip switches back to the person's own chats.
      await h.page.getByRole("button", { name: "An Orten 2" }).click();
      await h.page.getByText("Steuer-Checkliste 2026").filter({ visible: true }).waitFor();
      expect(new URL(h.page.url()).searchParams.has("places")).toBe(false);
      expect(await sidebar.count()).toBeGreaterThan(0);
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
    // A reload keeps the filter.
    const reloaded = await open(desktop, { full: true, placesFilter: true, answers: {} });
    try {
      await reloaded.page.getByText("Kundenkontakt · Jonas Probe").waitFor();
      expect(await reloaded.page.getByRole("button", { name: "An Orten 2" }).getAttribute("aria-pressed")).toBe("true");
    } finally {
      await reloaded.close();
    }
  }, 60_000);
});
