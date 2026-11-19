import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AiConversation } from "@k2b/cloud/ai";
import { CodeVersionCardSnapshotSchema } from "@k2b/cloud/contracts/code-version-cards";
import { codePageFixture } from "@k2b/cloud/ssr/code-page/code-page.fixture";
import type { Browser, Page, Route } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import type { CodeVersionPreview } from "./code-activation";

// Gustav in the Assistant workspace: the renamed footer, "My apps & automations" with the person's own Code, and the
// "Code of …" block in the panel. The workspace runs against routes that answer like the Assistant's server and
// Core's public Code queries. Set GUSTAV_SCREENSHOTS=<dir> to keep light and dark screenshots for the mockup review.

const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");
const entry = resolve(import.meta.dir, "AssistantGustav.browser-entry.tsx");
const fakeLive = resolve(import.meta.dir, "AssistantGustav.browser-live.ts");
const entrySource = `
import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { default as RevisionDecision, AssistantCodeReviewStartLine as RevisionStart } from ${JSON.stringify(resolve(import.meta.dir, "AssistantCodeDecisionLine.tsx"))};
import AssistantCodeVersionCard from ${JSON.stringify(resolve(import.meta.dir, "AssistantCodeVersionCard.tsx"))};
import AssistantWorkspace from ${JSON.stringify(resolve(import.meta.dir, "AssistantWorkspace.island.tsx"))};
import { AssistantCodeDecisionEntry } from ${JSON.stringify(resolve(import.meta.dir, "code-decision-deferred.tsx"))};
import { AssistantLiveProvider, createAssistantLiveHub } from ${JSON.stringify(resolve(import.meta.dir, "assistant-live.tsx"))};

// The person's AI live channel, as the workspace provides it; a test hands it the updates Core would send.
const live = createAssistantLiveHub();
window.harnessLive = live;

render(
  () => (
    <LocaleProvider locale={window.harness.locale}>
      {window.harness.revising ? (
        // Requested changes that Gustav revises by himself: the decision line and, below it, the start of his turn.
        <div style="width:100%;padding:1rem;display:grid;align-content:start;gap:0.5rem">
          <RevisionDecision decision={window.harness.revising} at={window.harness.revisingAt} timeZone="Europe/Berlin" automatic />
          <RevisionStart number={window.harness.revising.number} />
        </div>
      ) : window.harness.card ? (
        <div style="width:100%;padding:1rem">
          <AssistantLiveProvider value={live}>
            <AssistantCodeVersionCard
              {...window.harness.card}
              timeZone="Europe/Berlin"
              onAsk={(text) => (window.harnessAsked = [...(window.harnessAsked ?? []), text])}
            />
            {window.harness.decision ? (
              <div style="height:140vh" data-history>
                <div style="position:absolute;bottom:2rem;left:1rem;right:1rem">
                  {/* The line as the chat draws it: from its stored message, through the entry that decides whether it acts. */}
                  <AssistantCodeDecisionEntry
                    entry={{ id: "m-decision", createdAt: window.harness.decisionAt, meta: { codeDecision: window.harness.decision } }}
                    messages={() => []}
                    timeZone="Europe/Berlin"
                  />
                </div>
              </div>
            ) : null}
          </AssistantLiveProvider>
        </div>
      ) : (
        <AssistantWorkspace {...window.harness.props} />
      )}
    </LocaleProvider>
  ),
  document.getElementById("root"),
);
`;
const fakeLiveSource = `
export const liveConnection = () => ({ subscribe: () => ({ close() {} }) });
`;
const shots = process.env.GUSTAV_SCREENSHOTS?.trim();
/**
 * Gustav's app color (src/config.ts) with the AA inks and fills Cloud derives from it (appColorStyle in
 * @k2b/cloud's app-color contract, whose test checks every app accent).
 */
const plum = "#8e1b6f";
const plumColors =
  "--app-ink-light:#8e1b6f;--app-ink-dark:#bf7dad;--app-selected-light:#f7eff5;--app-selected-dark:#231627;" +
  "--app-selected-nav-light:#f4e8f1;--app-selected-nav-dark:#261629";

// One fixed clock for fixtures and page; only fictional people and places.
const now = Date.parse("2026-10-31T10:00:00.000Z");
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

const conversation = (id: string, title: string, minutesAgo: number): AiConversation => ({
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
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "user123",
  createdAt: at(600),
  updatedAt: at(minutesAgo),
});
const chats = [
  conversation("Anfr42", "Anfragen in info@ sortieren", 20),
  conversation("Jana42", "Angebot an Jana Probe", 90),
  conversation("Woch42", "Wochenbericht kürzen", 200),
  conversation("Lief42", "Lieferzeiten Bezugsstoffe", 1600),
];

const code = (id: string, title: string, state: string) => ({
  id,
  owner: { kind: "person", userId: "user123" },
  title,
  serviceAccountId: null,
  state,
  activeVersionId: null,
  createdBy: "user123",
  createdAt: at(30_000),
  permission: "editor",
});
const MINE = [
  code("c_woche1", "Wochenbericht Vertrieb", "active"),
  code("c_rueck1", "Rückfragen sammeln", "active"),
  code("c_stoff1", "Stoffpreise prüfen", "active"),
  code("c_angeb1", "Angebote nachfassen", "paused"),
];
/** A card whose title and schedule are longer than one line of a card. */
const LONG = { id: "c_rueck1", title: "Wochenabschluss Wareneingang (freitags 14 Uhr) mit Rückfragen an die Lieferanten" };
const mineOf = (scenario: Scenario) =>
  scenario.longNames ? MINE.map((item) => (item.id === LONG.id ? { ...item, title: LONG.title } : item)) : MINE;
// A place owns at most one Code.
const MAILBOX = [code("c_info01", "Anfragen sortieren", "paused")];
/** The summary carries Core's list under the names the block reads. */
const summaryOf = <T extends { items: unknown[]; removedTargets: unknown[] }>({ items, ...item }: T) => ({ ...item, automations: items });
const automation = (entrypoint: string, cron: string | null, patch: Record<string, unknown> = {}) => ({
  entrypoint,
  kind: cron ? "schedule" : "manual",
  cron,
  nextRunAt: null,
  lastRun: { state: "succeeded", createdAt: at(25), endedAt: at(24) },
  missingTargets: [],
  ...patch,
});
const logistik = { type: "spaces.space", id: "sp_2lg8", title: "Logistik", typeTitle: "Space" };
/** The running version's automations, as Core lists them; each owner's answer also names targets refused in the last run. */
const automationsOf = (codeId: string, accessMissing = false, longNames = false) => {
  if (longNames && codeId === LONG.id) return { items: [automation("lagerbestand", "*/15 7-19 * * *")], removedTargets: [] };
  if (codeId === "c_woche1")
    return { items: [automation("wochenbericht", "0 7 * * 1", { nextRunAt: "2026-11-02T06:00:00.000Z" })], removedTargets: [] };
  if (codeId !== "c_info01") return { items: [], removedTargets: [] };
  return {
    items: [
      automation("anfragenSortieren", null, { title: "Anfragen sortieren" }),
      automation("lieferungenEintragen", null, {
        title: "Lieferungen eintragen",
        ...(accessMissing ? { missingTargets: [logistik] } : {}),
      }),
    ],
    removedTargets: accessMissing ? [logistik] : [],
  };
};
const runOf = (codeId: string) => {
  const failed = codeId === "c_stoff1";
  const minutesAgo = { c_woche1: 7_000, c_rueck1: 60, c_stoff1: 210, c_angeb1: 2_900, c_info01: 25 }[codeId] ?? 60;
  return {
    id: "77777777-7777-4777-8777-777777777777",
    state: failed ? "failed" : "succeeded",
    createdAt: at(minutesAgo),
    startedAt: at(minutesAgo),
    endedAt: at(minutesAgo - 1),
  };
};
/** The person's day in Berlin (31.10.2026) as Core's read model words it for one Code of "My apps". */
const activityOf = (codeId: string) => {
  const marks =
    codeId === "c_stoff1"
      ? [
          { at: runOf(codeId).createdAt, state: "failed", count: 1, runId: runOf(codeId).id },
          { at: "2026-10-31T14:00:00.000Z", state: "planned", count: 1 },
        ]
      : codeId === "c_rueck1"
        ? [{ at: runOf(codeId).createdAt, state: "succeeded", count: 1, runId: runOf(codeId).id }]
        : [];
  return {
    week: "2026-10-26T00:00:00.000Z",
    counters: { items: [], more: 0, moreText: null },
    recent: codeId === "c_woche1" ? [{ text: "1 Notiz angelegt", at: runOf(codeId).createdAt, runId: runOf(codeId).id }] : [],
    timeline: { from: "2026-10-30T23:00:00.000Z", to: "2026-10-31T23:00:00.000Z", marks, total: marks.length },
  };
};

type Scenario = {
  codeOpen?: boolean;
  listFails?: boolean;
  panel?: boolean;
  panelFails?: boolean;
  /** The panel's place can own Code but has none. */
  panelEmpty?: boolean;
  panelAccessMissing?: boolean;
  /** What Core answers for a version card, which then renders alone in the panel's width. */
  cardPreview?: CodeVersionPreview;
  /** An event line about the card's version far below it, at the end of the chat. */
  decision?: boolean;
  /** The review as the person sees it, and the version in words; without them Core answers the card's ordinary defaults. */
  cardReview?: Record<string, unknown>;
  cardWords?: Record<string, unknown>;
  /** Core's answer to switching the card's version on, held back until `answered` settles. */
  activation?: { answered: Promise<void>; status: { state: string; failure: { reason: string } | null } };
  /** One personal Code with the shared Code page. */
  detail?: boolean;
  /** Which shared fixture that page shows; the overview without one. */
  detailState?: "personal" | "personal-chat-missing";
  /** Waiting for you, with one chat question and Code of a place that needs the person. */
  waiting?: boolean;
  /** One card of My apps has a title and a schedule longer than one line. */
  longNames?: boolean;
  /** Requested changes that Gustav revises by himself: the decision line and the start line below it. */
  revising?: boolean;
};
const approval = {
  id: "33333333-3333-4333-8333-333333333333",
  app: { id: "mail", name: "Mail", icon: "ti ti-mail" },
  action: "draft.send",
  assurance: "confirm" as const,
  sentence: "Mail: Angebot an Jana Probe senden",
  review: null,
  requester: { kind: "chat" as const, appId: "assistant", title: "Angebot an Jana Probe", href: "/app/assistant?conversation=Jana42" },
  remember: { chat: false, always: false, website: false },
  createdAt: at(80),
  expiresAt: at(-1440),
};
/** What waits for the person, as the row above the field and its count read it: the approval and one version. */
const waitingQuestions = {
  count: 2,
  items: [
    {
      id: "req-jana",
      kind: "approval" as const,
      conversationId: "Jana42",
      conversationTitle: "Angebot an Jana Probe",
      anchor: "tool-call-jana",
      short: "Mail: Angebot an Jana Probe senden",
      app: { name: "Mail", icon: "ti ti-mail" },
      createdAt: at(80),
    },
    {
      id: "code:v_info02",
      kind: "code_activate" as const,
      conversationId: "Lief42",
      conversationTitle: "Lieferungen eintragen",
      anchor: "code-version-v_info02",
      short: "Version 2 einschalten",
      app: { name: "Code", icon: "ti ti-player-play" },
      createdAt: at(20),
    },
  ],
};

const propsOf = (scenario: Scenario, url: URL) => ({
  embedded: Boolean(scenario.panel),
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
  initialConversations: chats,
  initialDoneCount: 4,
  initialQuestions: scenario.waiting ? waitingQuestions : { items: [], count: 0 },
  initialConversationId: null,
  initialArtifactPath: null,
  initialWorkspaceHref: `${url.pathname}${url.search}`,
  initialDetail: null,
  initialContext: null,
  initialContextClosed: true,
  projects: [],
  initialProject: null,
  initialProjectChats: null,
  initialProjectContext: null,
  approvals: scenario.waiting
    ? { page: { items: [approval], nextCursor: null, count: 1, elsewhere: 0 }, open: true }
    : { page: { items: [], nextCursor: null, count: 2, elsewhere: 0 }, open: false },
  ...(scenario.waiting ? { initialAutomations: [] } : {}),
  code: {
    has: true,
    open: Boolean(scenario.codeOpen || scenario.detail),
    ...(scenario.codeOpen
      ? {
          page: scenario.listFails
            ? null
            : {
                items: mineOf(scenario)
                  .map((item) => ({ ...item, lastRun: runOf(item.id), ...automationsOf(item.id, false, scenario.longNames) }))
                  .map(summaryOf),
                nextCursor: null,
              },
          today: { runs: 9, failed: 1 },
        }
      : {}),
    ...(scenario.detail ? { detail: personalCodePage(scenario.detailState) } : {}),
  },
  initialCodeBlock: scenario.panel
    ? {
        ref: mailbox,
        page: scenario.panelFails
          ? null
          : {
              items: scenario.panelEmpty
                ? []
                : MAILBOX.map((item) => ({
                    ...item,
                    state: scenario.panelAccessMissing ? "active" : item.state,
                    lastRun: runOf(item.id),
                    ...automationsOf(item.id, scenario.panelAccessMissing),
                  })).map(summaryOf),
              nextCursor: null,
            },
        ...(scenario.panelEmpty
          ? { place: { name: "info@moebel-beispiel.de", type: "Postfach", href: "/app/mail/m/info", canOwnCode: true } }
          : {}),
      }
    : null,
});
const mailbox = { type: "mail.mailbox", id: "m_info" };
const mailCatalog = {
  protocolVersion: 2,
  apps: [
    {
      appId: "mail",
      appName: "Mail",
      appIcon: "ti ti-mail",
      appDescription: "Mail.",
      manifest: {
        protocolVersion: 2,
        appId: "mail",
        manifestHash: "a".repeat(64),
        types: [{ localId: "mailbox", title: "Postfach", description: "Ein Postfach.", icon: "ti ti-mail", reader: "mailbox.read" }],
        queries: [
          {
            localId: "mailbox.read",
            title: "Postfach lesen",
            description: "Ein Postfach lesen.",
            inputSchema: {},
            dataSchema: {},
            schemaHash: "b".repeat(64),
            openWorld: false,
          },
        ],
        actions: [],
        commands: [],
        code: { owners: ["mailbox"] },
      },
    },
  ],
  page: { hasMore: false },
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
        name: "assistant-gustav",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the Gustav workspace harness.");
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
  // The test answers the capability catalog itself: the panel reads the place's name through it.
  browser = await launchBrowser({ serveShellCatalog: true });
}, 180_000);
afterAll(async () => {
  await browser?.close();
  assets?.stop(true);
});

type View = { name: string; width: number; height: number; touch: boolean; column?: string };
const desktop: View = { name: "1440", width: 1440, height: 900, touch: false };
const tablet: View = { name: "1024", width: 1024, height: 768, touch: true };
const phone: View = { name: "390", width: 390, height: 844, touch: true };
const panel: View = { name: "panel", width: 1440, height: 900, touch: false, column: "24rem" };

const open = async (view: View, scenario: Scenario, options: { theme?: "light" | "dark"; path?: string } = {}) => {
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
  const codeCalls: string[] = [];
  const activationCalls: string[] = [];
  const state = { listFails: Boolean(scenario.listFails) };
  await page.route(`${assets.url.href}**`, async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/code/")) activationCalls.push(url.pathname);
    if (url.pathname === "/harness.js" || url.pathname === "/harness.css" || url.pathname.startsWith("/ui/")) return route.continue();
    if (url.pathname === "/app/assistant" || url.pathname === "/app/assistant/panel" || url.pathname.startsWith("/app/assistant/code/")) {
      const harness = {
        locale: "de",
        props: propsOf(scenario, url),
        ...(scenario.cardPreview ? { card: { codeId: "c_info01", versionId: cardVersionId, number: 5 } } : {}),
        ...(scenario.decision
          ? {
              decision: {
                codeId: "c_info01",
                versionId: cardVersionId,
                number: 5,
                outcome: "approved",
                person: { id: "u-jana", name: "Jana Probe" },
                anchor: `code-version-${cardVersionId}`,
              },
              // The line's own time comes from the fixture clock, like the page's pinned Date.
              decisionAt: at(1),
            }
          : {}),
        ...(scenario.revising
          ? {
              revising: {
                codeId: "c_info01",
                versionId: cardVersionId,
                number: 1,
                outcome: "changes_requested",
                person: { id: "u-jana", name: "Jana Probe" },
                anchor: `code-version-${cardVersionId}`,
              },
              revisingAt: at(1),
            }
          : {}),
      };
      const outer = view.column ? "display:flex;justify-content:flex-end;height:100vh" : "display:flex;height:100vh";
      const inner = view.column
        ? `<div id="root" style="width:${view.column};display:flex;height:100vh"></div>`
        : `<div id="root" style="display:flex;width:100%;height:100vh"></div>`;
      const panelContext = scenario.panel
        ? `<script type="application/json" id="cloud-panel-context">${JSON.stringify({ v: 1, seq: 1, pageId: "88888888-8888-4888-8888-888888888888", app: "mail", scope: mailbox })}</script>`
        : "";
      // Gustav's plum, scoped like the Cloud shell's app canvas.
      const appColors = `--app-accent:${plum};${plumColors}`;
      return route.fulfill({
        contentType: "text/html",
        body:
          `<!doctype html><html lang="de" class="${options.theme ?? "light"}"><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"></head>` +
          `<body class="k2b-ui" style="margin:0">${panelContext}<div class="app-accent-scope" style="${outer};${appColors}">${inner}</div>` +
          `<script>window.harness = ${JSON.stringify(harness).replace(/</g, "\\u003c")};</script><script type="module" src="/harness.js"></script></body></html>`,
      });
    }
    if (url.pathname === "/api/code/activation/preview" && scenario.cardPreview)
      return route.fulfill({ json: { data: scenario.cardPreview } });
    if (url.pathname === "/api/code/review" && scenario.cardPreview)
      return route.fulfill({ json: { data: { ...cardReview, ...scenario.cardReview } } });
    if (url.pathname === "/api/code/activate" && scenario.activation) {
      await scenario.activation.answered;
      return route.fulfill({ json: { data: scenario.activation.status } });
    }
    const capability = /^\/api\/capabilities\/v1\/queries\/(\w+)\/([\w.]+)$/.exec(url.pathname);
    if (capability) {
      const [, appId, capabilityId] = capability;
      const input = route.request().postDataJSON().input as { owner?: { kind: string }; codeId?: string };
      codeCalls.push(`${appId}.${capabilityId}`);
      if (scenario.cardPreview && capabilityId === "code.version.cards") {
        const p = scenario.cardPreview;
        const r = { ...cardReview, ...scenario.cardReview };
        return route.fulfill({
          json: {
            data: {
              items: [
                {
                  codeId: p.codeId,
                  versionId: p.versionId,
                  state: "available",
                  snapshot: CodeVersionCardSnapshotSchema.parse({
                    preview: {
                      codeId: p.codeId,
                      versionId: p.versionId,
                      number: p.number,
                      title: p.title,
                      ownerKind: p.ownerKind,
                      page: p.page ?? null,
                      running: p.running,
                      latest: p.latest,
                      activated: p.activated,
                      allowed: p.allowed,
                      readiness: p.readiness,
                    },
                    review: {
                      status: r.status,
                      origin: r.origin,
                      decidedBy: r.decidedBy,
                      message: r.message,
                      commentCount: r.commentCount,
                      revision:
                        "revision" in r && typeof r.revision === "object" && r.revision !== null
                          ? { submittedNumber: null, ...r.revision }
                          : null,
                    },
                    facts: [],
                    code: { state: "active", activeVersionId: "v4", pausedAt: null, pausedBy: null },
                    pages: { versionId: p.versionId, homeUrl: null, pages: [] },
                    latest: p.latest > p.number ? { id: "77777777-7777-4777-8777-777777777777", number: p.latest } : null,
                    permission: "editor",
                    canManage: true,
                    canActivate: true,
                  }),
                },
              ],
            },
          },
        });
      }
      if (scenario.cardPreview && capabilityId === "code.read")
        return route.fulfill({ json: { data: { code: { state: "active", activeVersionId: "v4" } } } });
      if (scenario.cardPreview && capabilityId === "code.version.read")
        return route.fulfill({ json: { data: { pages: { versionId: cardVersionId, homeUrl: null, pages: [] } } } });
      if (appId === "mail")
        return route.fulfill({
          json: { data: { view: { title: "info@moebel-beispiel.de" } }, links: [{ rel: "open", href: "/app/mail/m/info" }] },
        });
      if (capabilityId === "code.list") {
        if (state.listFails)
          return route.fulfill({ status: 503, json: { error: { code: "APP_UNAVAILABLE", message: "Core is unavailable" } } });
        return route.fulfill({
          json: { data: { items: input.owner?.kind === "resource" ? MAILBOX : mineOf(scenario), nextCursor: null } },
        });
      }
      if (capabilityId === "code.run.list") return route.fulfill({ json: { data: { items: [runOf(input.codeId!)], nextCursor: null } } });
      if (capabilityId === "code.automation.list")
        return route.fulfill({ json: { data: { codeId: input.codeId, ...automationsOf(input.codeId!, false, scenario.longNames) } } });
      if (capabilityId === "code.run.count") return route.fulfill({ json: { data: { runs: 9, failed: 1 } } });
      if (capabilityId === "code.activity.words") return route.fulfill({ json: { data: activityOf(input.codeId!) } });
      if (capabilityId === "code.run.words")
        return route.fulfill({
          json: {
            data: {
              runId: runOf(input.codeId!).id,
              title: "Lauf",
              state: "failed",
              status: "Fehlgeschlagen",
              at: runOf(input.codeId!).createdAt,
              reason: "Preisliste von stoffe-nord.example nicht erreichbar",
              untilThen: { items: [], more: 0, moreText: null },
              complete: true,
            },
          },
        });
      if (capabilityId === "code.version.words") return route.fulfill({ json: { data: { ...cardWords, ...scenario.cardWords } } });
    }
    if (url.pathname === "/api/capabilities/v1/catalog") return route.fulfill({ json: mailCatalog });
    if (url.pathname === "/api/assistant/workspace/sidebar")
      return route.fulfill({
        json: {
          conversations: chats,
          projects: [],
          doneCount: 4,
          questions: scenario.waiting ? waitingQuestions : { items: [], count: 0 },
        },
      });
    if (url.pathname === "/api/approvals") return route.fulfill({ json: { items: [], nextCursor: null, count: 0, elsewhere: 0 } });
    const empty: Record<string, unknown> = {
      "/api/ai/resources/recent": { resources: [] },
      "/api/ai/quotas": { enabled: false, balances: [] },
      "/api/ai/skills": { skills: [] },
      "/api/ai/tasks": [],
      "/api/apps/badges": { total: 2, apps: { assistant: 2 } },
    };
    if (url.pathname in empty) return route.fulfill({ json: empty[url.pathname] });
    return route.fulfill({ status: 503, json: { message: "unavailable" } });
  });
  // The first load parses the whole workspace bundle; like the other workspace harnesses, it gets 30 s on a busy machine.
  await page.goto(`${assets.url.origin}${options.path ?? "/app/assistant?code=1"}`, { timeout: 30_000 });
  return { page, errors, codeCalls, activationCalls, state, close: () => context.close() };
};

/** Personal Code on the shared Code page, from the shared fixture with fictional data. */
const personalCodePage = (state: "overview" | "personal" | "personal-chat-missing" = "overview") => ({
  ...codePageFixture(state, "de"),
  owner: { kind: "person" as const, ref: null, title: "Wochenbericht Vertrieb", typeTitle: null },
  href: "/app/assistant/code/c_woche1",
});

const cardVersionId = "66666666-6666-4666-8666-666666666666";
/** The review and the version in words that Core answers for the card, fictional. */
const cardReview = {
  status: "not_required",
  origin: { kind: "ai_chat", conversationId: "chat-1", automaticAfterReview: false },
  decidedBy: null,
  decidedAt: null,
  message: null,
  comments: [],
  commentCount: 0,
  activeVersion: { id: "v4", number: 4 },
};
const JANA = { id: "u-jana", name: "Jana Probe", avatarHash: null };
const cardWords = {
  versionId: cardVersionId,
  number: 5,
  submittedAt: "2026-11-12T08:00:00.000Z",
  locale: "de",
  description: { state: "visible", text: "Legt Lieferscheine ab.", modelLabel: "✦" },
  assurance: "Cloud begrenzt die Zugriffe auf die Apps und Ziele dieser Version.",
  mayDo: { items: [], more: 0, moreText: null },
  timing: { items: [], more: 0, moreText: null },
  changes: {
    state: "changed",
    text: "Zugriffe oder Auslöser geändert",
    rows: {
      items: [
        { kind: "add", text: "Läuft zusätzlich Mo–Fr um 08:00" },
        { kind: "add", text: "Darf neu Dateien ablegen im Ordner Lieferscheine 2026" },
        { kind: "remove", text: "Darf nicht mehr Unterhaltungen markieren im Postfach info@moebel-beispiel.de" },
        { kind: "same", text: "5 weitere bleiben gleich" },
      ],
      more: 0,
      moreText: null,
    },
    assurance: "Cloud prüft Zugriffe und Auslöser, nicht das Verhalten.",
  },
  examples: { state: "passed", passed: 3, total: 3, summary: "3 von 3 Beispielen erfolgreich", explanation: "", items: [] },
  notices: { items: [], more: 0, moreText: null },
};
const cardPreview = (patch: Partial<CodeVersionPreview> = {}): CodeVersionPreview => ({
  codeId: "c_info01",
  title: "Code von info@",
  ownerKind: "resource",
  versionId: cardVersionId,
  number: 5,
  running: 4,
  latest: 5,
  activated: null,
  allowed: { allowed: true },
  readiness: { state: "ready" },
  place: { title: "info@moebel-beispiel.de", typeTitle: "Postfach", href: "/app/mail/m/info" },
  page: "/app/mail/m/info/code",
  operationLabels: {
    "mail.conversation.tag": { title: "Unterhaltung markieren", app: "Mail" },
    "spaces.task.create": { title: "Aufgabe anlegen", app: "Spaces" },
  },
  targets: [
    {
      target: {
        key: "mail.mailbox\u0000m_info",
        ref: { type: "mail.mailbox", id: "m_info" },
        title: null,
        typeTitle: "Postfach",
        icon: "ti ti-mail",
        own: true,
        href: null,
      },
      operations: ["mail.conversation.tag"],
      isNew: false,
    },
    {
      target: {
        key: "spaces.space\u0000sp_2lg8",
        ref: { type: "spaces.space", id: "sp_2lg8" },
        title: null,
        typeTitle: "Space",
        icon: "ti ti-layout-kanban",
        own: false,
        href: null,
      },
      operations: ["spaces.task.create"],
      isNew: true,
    },
  ],
  ...patch,
});

const shot = async (page: Page, name: string) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(shots, `${name}.png`) });
};

describe("Gustav", () => {
  test("My apps & automations lists the person's own Code with status, beside the renamed footer", async () => {
    for (const [view, theme] of [
      [desktop, "light"],
      [tablet, "light"],
      [phone, "light"],
      [desktop, "dark"],
    ] as const) {
      const h = await open(view, { codeOpen: true }, { theme });
      try {
        const list = h.page.locator("section.assistant-apps");
        await list.getByText("Wochenbericht Vertrieb").waitFor();
        expect(await list.getByRole("heading", { level: 1 }).textContent()).toBe("Meine Apps & Automationen");
        expect(await list.getByText("Dein Code läuft als du, mit deinen Rechten und nicht mehr.").count()).toBe(1);
        // The day line reads every Code's day; its sentence counts the runs.
        await list.getByText("1 Lauf erfolgreich, 1 fehlgeschlagen, 1 geplanter Start").waitFor();
        expect(await list.getByRole("img", { name: /^Läufe heute: / }).count()).toBe(1);
        // A card names the schedule as a sentence and the next run beside the status.
        await list.getByText("Montags um 07:00").waitFor();
        await list.getByText("Zuletzt: 1 Notiz angelegt").waitFor();
        // The failed run and the pause are the visible statuses; the rest are "Eingeschaltet".
        const cards = await list
          .locator("a.k2b-link-card")
          .evaluateAll((items) => items.map((item) => (item.textContent ?? "").replace(/\s+/g, " ").trim()));
        expect(cards).toHaveLength(4);
        expect(cards[0]).toContain("Eingeschaltet");
        expect(cards[2]).toContain("Zuletzt: Preisliste von stoffe-nord.example nicht erreichbar");
        expect(cards[2]).toContain("Letzter Lauf fehlgeschlagen");
        expect(cards[3]).toContain("Pausiert");
        if (view === desktop) {
          const footer = await h.page
            .locator('footer[data-sidebar-mode="expanded"] .k2b-app-workspace__sidebar-item-label-text')
            .allTextContents();
          expect(footer).toEqual(["Wartet auf dich", "Meine Apps & Automationen", "Projekte", "Personalisieren"]);
        }
        await shot(h.page, `a-meine-apps-${view.name}-${theme}`);
        expect(h.errors).toEqual([]);
      } finally {
        await h.close();
      }
    }
  }, 120_000);

  test("a long title and schedule wrap in their card instead of ending in an ellipsis, so the end time stays visible", async () => {
    for (const view of [desktop, phone]) {
      const h = await open(view, { codeOpen: true, longNames: true });
      try {
        const list = h.page.locator("section.assistant-apps");
        const card = list.locator("a.k2b-link-card").filter({ hasText: LONG.title });
        await card.getByText("Alle 15 Minuten von 7:00 bis 19:59 Uhr").waitFor();
        await settled(h.page);
        for (const selector of [".k2b-link-card__title", ".k2b-link-card__description"]) {
          const box = await card.locator(selector).evaluate((element) => {
            const style = getComputedStyle(element);
            const own = element.getBoundingClientRect();
            const outer = element.closest("a")!.getBoundingClientRect();
            return {
              ellipsis: style.textOverflow === "ellipsis",
              cut: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1,
              inside: own.left >= outer.left && own.right <= outer.right + 0.5,
              lines: Math.round(own.height / Number.parseFloat(style.lineHeight)),
            };
          });
          expect(box.ellipsis).toBe(false);
          expect(box.cut).toBe(false);
          expect(box.inside).toBe(true);
          // At this length the title needs more than one line in every width: it wraps instead of being cut.
          if (selector === ".k2b-link-card__title") expect(box.lines).toBeGreaterThan(1);
        }
        expect(await card.locator(".k2b-link-card__title").textContent()).toBe(LONG.title);
        expect(h.errors).toEqual([]);
        await shot(h.page, `a-meine-apps-lang-${view.name}-light`);
      } finally {
        await h.close();
      }
    }
  }, 120_000);

  test("a failed list keeps its place, says the Code keeps running, and recovers on retry", async () => {
    const h = await open(desktop, { codeOpen: true, listFails: true });
    try {
      const list = h.page.locator("section.assistant-apps");
      await list.getByText("Deine Automationen konnten nicht geladen werden.").waitFor();
      await shot(h.page, "a-meine-apps-fehler-1440-light");
      h.state.listFails = false;
      await list.getByRole("button", { name: "Erneut versuchen" }).click();
      await list.getByText("Wochenbericht Vertrieb").waitFor();
    } finally {
      await h.close();
    }
  }, 60_000);

  test("the panel shows Code of the place with its automations and statuses, folds for a chat, and retries an error", async () => {
    const h = await open(panel, { panel: true }, { path: "/app/assistant/panel" });
    try {
      const block = h.page.locator("section.assistant-code-block");
      await block.getByText("Anfragen sortieren").waitFor();
      // The place's own name comes from its reader.
      await block.getByText("von info@moebel-beispiel.de").waitFor();
      // One row per automation; pausing is the whole Code's state, so both say it.
      expect(await block.locator("li").count()).toBe(2);
      await block.getByText("Lieferungen eintragen").waitFor();
      expect(await block.getByText("Pausiert").count()).toBe(2);
      expect(await block.getByRole("button", { name: "Mit Gustav bearbeiten" }).count()).toBe(1);
      expect(await block.getByRole("link", { name: "info@moebel-beispiel.de öffnen" }).getAttribute("href")).toBe("/app/mail/m/info");
      // The server already listed this place's Code; the page does not ask Core again.
      expect(h.codeCalls.filter((call) => call === "core.code.list")).toEqual([]);
      await shot(h.page, "b-panel-code-von-light");
      await block.getByRole("button", { name: "Code ausblenden" }).click();
      await block.getByText("2 Automationen · Pausiert").waitFor();
      expect(await block.locator("li").count()).toBe(0);
      await shot(h.page, "b-panel-code-von-zu-light");
    } finally {
      await h.close();
    }
    const failed = await open(panel, { panel: true, panelFails: true }, { path: "/app/assistant/panel" });
    try {
      const block = failed.page.locator("section.assistant-code-block");
      await block.getByText("Die Automationen laufen weiter. Der Chat hier geht trotzdem.").waitFor();
      await shot(failed.page, "b-panel-code-von-fehler-light");
      await block.getByRole("button", { name: "Erneut" }).click();
      await block.getByText("Anfragen sortieren").waitFor();
    } finally {
      await failed.close();
    }
  }, 90_000);

  test("a refused target shows at the automation that called it, while the other stays on", async () => {
    const h = await open(panel, { panel: true, panelAccessMissing: true }, { path: "/app/assistant/panel" });
    try {
      const block = h.page.locator("section.assistant-code-block");
      await block.getByText("Zugriff fehlt").waitFor();
      const rows = block.locator("li");
      expect(await rows.count()).toBe(2);
      expect(await rows.nth(0).textContent()).toContain("An");
      expect(await rows.nth(1).textContent()).toContain("Kein Zugriff auf Space Logistik im letzten Lauf");
      await shot(h.page, "b-panel-code-von-zugriff-fehlt-light");
      await block.getByRole("button", { name: "Code ausblenden" }).click();
      await block.getByText("2 Automationen · Zugriff fehlt").waitFor();
    } finally {
      await h.close();
    }
  }, 60_000);

  test("the version card is the one approval frame in every state and fits desktop, panel and phone without code", async () => {
    const changes = { status: "changes_requested", decidedBy: JANA, decidedAt: at(10), message: "Bitte nur PDF-Anhänge ablegen." };
    const states: { name: string; scenario: Scenario; word: string | null; sentence: string; main: string | null }[] = [
      {
        name: "bereit",
        scenario: { cardPreview: cardPreview() },
        word: "Bereit, noch aus",
        sentence: "Version 5 ist bereit zum Einschalten.",
        main: "Einschalten",
      },
      {
        name: "ohne-beispiele",
        scenario: {
          cardPreview: cardPreview(),
          cardWords: { examples: { state: "none", passed: 0, total: 0, summary: "", explanation: "", items: [] } },
        },
        word: "Bereit, noch aus",
        sentence: "Version 5 ist bereit zum Einschalten.",
        main: "Einschalten",
      },
      {
        name: "wartet-auf-admin",
        scenario: { cardPreview: cardPreview({ readiness: { state: "approval_pending" } }), cardReview: { status: "pending" } },
        word: "Wartet auf Admin",
        sentence: "Version 5 wartet auf einen Admin. Du bekommst Bescheid.",
        main: null,
      },
      {
        name: "aenderungen",
        scenario: {
          cardPreview: cardPreview({ readiness: { state: "refused", code: "code_approval_revoked", message: "x" } }),
          cardReview: changes,
        },
        word: "Änderungen angefordert",
        sentence: "Jana Probe wünscht Änderungen an Version 5.",
        main: "Gustav überarbeiten lassen",
      },
      {
        name: "ueberarbeitung-wartet",
        scenario: {
          cardPreview: cardPreview({ readiness: { state: "refused", code: "code_approval_revoked", message: "x" } }),
          cardReview: { ...changes, revision: { state: "queued", reason: null } },
        },
        word: "Änderungen angefordert",
        sentence: "Gustav überarbeitet Version 5, einmal von selbst.",
        main: null,
      },
      {
        name: "ueberarbeitet-gerade",
        scenario: {
          cardPreview: cardPreview({ readiness: { state: "refused", code: "code_approval_revoked", message: "x" } }),
          cardReview: { ...changes, revision: { state: "running", reason: null } },
        },
        word: "Änderungen angefordert",
        sentence: "Gustav überarbeitet Version 5, einmal von selbst.",
        main: null,
      },
      {
        name: "abgelehnt",
        scenario: {
          cardPreview: cardPreview({ readiness: { state: "refused", code: "code_approval_revoked", message: "x" } }),
          cardReview: { ...changes, status: "rejected", message: "Keine gemeinsamen Ordner." },
        },
        word: "Abgelehnt",
        sentence: "Jana Probe hat Version 5 abgelehnt.",
        main: null,
      },
    ];
    for (const state of states)
      for (const view of [desktop, panel, phone]) {
        const h = await open(view, state.scenario, { path: "/app/assistant/panel" });
        try {
          const card = h.page.locator(".assistant-code-version");
          await card.locator("[role=status]").waitFor();
          expect(await card.locator("[role=status]").innerText()).toBe(state.sentence);
          expect(await card.getAttribute("data-k2b-primary")).toBe("ai");
          const word = card.locator(".k2b-chat-decision__status");
          expect(await word.count()).toBe(0);
          if (state.main) expect(await card.getByRole("button", { name: state.main, exact: true }).count()).toBe(1);
          if (state.name === "aenderungen" && view === desktop) {
            await card.getByRole("button", { name: "Gustav überarbeiten lassen", exact: true }).click();
            expect(await h.page.evaluate(() => (window as unknown as { harnessAsked?: string[] }).harnessAsked)).toEqual([
              "Überarbeite Version 5 so, wie Jana Probe es möchte.",
            ]);
          }
          expect(await card.getByRole("link", { name: "Unterschied", exact: true }).count()).toBe(0);
          const shown = await card.innerText();
          for (const pattern of [/code\.tsx?/, /[\w./-]+\.[a-z]{1,8}:\d+/, /\bcode_[a-z_]+/, /sp_2lg8/, /\b[0-9a-f]{8,}\b/])
            expect(shown).not.toMatch(pattern);
          // The card has no frame and no shadow; details stay on the Code page.
          await settled(h.page);
          const look = await card.evaluate((element) => {
            const style = getComputedStyle(element);
            return { shadow: style.boxShadow, radius: style.borderTopLeftRadius };
          });
          expect(look.shadow).toBe("none");
          expect(look.radius).toBe("12px");
          expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
          expect(h.errors).toEqual([]);
          await shot(h.page, `f-karte-${state.name}-${view.name}-light`);
        } finally {
          await h.close();
        }
      }
  }, 240_000);

  test("requested changes that Gustav revises by himself say so once, in the start line below the decision", async () => {
    for (const view of [desktop, phone]) {
      const h = await open(view, { revising: true }, { path: "/app/assistant/panel" });
      try {
        const lines = h.page.locator(".assistant-code-decision");
        await lines.nth(1).waitFor();
        await settled(h.page);
        const texts = (await lines.allInnerTexts()).map((line) => line.replace(/\s+/g, " ").trim());
        expect(texts).toHaveLength(2);
        expect(texts[0]).toContain("Jana Probe");
        expect(texts[1]).toBe("Gustav überarbeitet Version 1 jetzt, einmal von selbst.");
        // N3: the decision line carries no second mark that says the same.
        expect(texts.join(" ").match(/von selbst/g)).toHaveLength(1);
        expect(await lines.first().getByRole("button").count()).toBe(0);
        expect(h.errors).toEqual([]);
        await shot(h.page, `f-ueberarbeitet-selbst-${view.name}-light`);
      } finally {
        await h.close();
      }
    }
  }, 120_000);

  test("the event line at the end jumps up to the card and puts the focus on switching on", async () => {
    for (const view of [desktop, phone]) {
      const h = await open(
        view,
        { cardPreview: cardPreview(), cardReview: { status: "approved", decidedBy: JANA, decidedAt: at(5) }, decision: true },
        { path: "/app/assistant/panel" },
      );
      try {
        const line = h.page.locator(".assistant-code-decision");
        await line.waitFor();
        await line.scrollIntoViewIfNeeded();
        expect(await line.innerText()).toContain("Jana Probe hat Version 5 freigegeben");
        await shot(h.page, `f-ereigniszeile-vorher-${view.name}-light`);
        await line.getByRole("button", { name: "Zur Karte" }).click();
        const main = h.page.locator(".assistant-code-version").getByRole("button", { name: "Einschalten", exact: true });
        await h.page.waitForFunction(() => document.activeElement?.textContent?.includes("Einschalten"));
        expect(await main.evaluate((element) => element === document.activeElement)).toBe(true);
        const box = await h.page.locator(".assistant-code-version").boundingBox();
        expect(box && box.y >= 0 && box.y < view.height).toBe(true);
        expect(h.errors).toEqual([]);
        await shot(h.page, `f-ereigniszeile-nachher-${view.name}-light`);
      } finally {
        await h.close();
      }
    }
  }, 120_000);

  test("an approved version that a newer one replaced keeps its event line as history, without an action", async () => {
    for (const view of [desktop, phone]) {
      const h = await open(
        view,
        {
          cardPreview: cardPreview({ latest: 6 }),
          cardReview: { status: "approved", decidedBy: JANA, decidedAt: at(5) },
          decision: true,
        },
        { path: "/app/assistant/panel" },
      );
      try {
        const line = h.page.locator(".assistant-code-decision");
        await line.locator(".assistant-code-decision__text").waitFor();
        await h.page.locator(".assistant-code-version").getByText("Version 5 wurde durch Version 6 ersetzt.").waitFor();
        await settled(h.page);
        expect(await line.innerText()).toContain("Jana Probe hat Version 5 freigegeben");
        expect(await line.getByRole("button").count()).toBe(0);
        expect(h.errors).toEqual([]);
        await line.scrollIntoViewIfNeeded();
        await shot(h.page, `f-ereigniszeile-ersetzt-${view.name}-light`);
      } finally {
        await h.close();
      }
    }
  }, 120_000);

  test("the changes card has one height whether Gustav's revision waits, runs or stopped", async () => {
    const changes = { status: "changes_requested", decidedBy: JANA, decidedAt: at(10), message: "Bitte nur PDF-Anhänge ablegen." };
    for (const view of [desktop, phone]) {
      const heights: number[] = [];
      for (const revision of [
        { state: "queued", reason: null },
        { state: "running", reason: null },
        { state: "stopped", reason: "stopped" },
      ]) {
        const h = await open(
          view,
          {
            cardPreview: cardPreview({ readiness: { state: "refused", code: "code_approval_revoked", message: "x" } }),
            cardReview: { ...changes, revision },
          },
          { path: "/app/assistant/panel" },
        );
        try {
          const card = h.page.locator(".assistant-code-version");
          await card.locator("[role=status]").waitFor();
          heights.push(Math.round((await card.boundingBox())!.height));
        } finally {
          await h.close();
        }
      }
      const first = heights[0] ?? 0;
      expect({ view: view.name, heights }).toEqual({ view: view.name, heights: [first, first, first] });
    }
  }, 120_000);

  test("switching on keeps the card's top edge; the switch shimmers while Cloud works and the card says the result in place", async () => {
    for (const view of [desktop, phone]) {
      let answer = () => {};
      const answered = new Promise<void>((resolve) => {
        answer = resolve;
      });
      const reason = "Die Richtlinie erlaubt das nicht mehr.";
      const h = await open(
        view,
        { cardPreview: cardPreview(), activation: { answered, status: { state: "failed", failure: { reason } } } },
        { path: "/app/assistant/panel" },
      );
      try {
        const card = h.page.locator(".assistant-code-version");
        const switchOn = card.getByRole("button", { name: "Einschalten", exact: true });
        await switchOn.waitFor();
        const top = async () => Math.round((await card.boundingBox())!.y);
        const before = await top();
        await switchOn.focus();
        await h.page.keyboard.press("Enter");
        await card.getByText("Version 5 wird eingeschaltet …").waitFor();
        expect(await card.locator("[data-code-version-primary]").getAttribute("aria-busy")).toBe("true");
        expect(await top()).toBe(before);
        await shot(h.page, `f-karte-schaltet-ein-${view.name}-light`);
        answer();
        await card.getByRole("alert").filter({ hasText: "Einschalten hat nicht geklappt." }).waitFor();
        expect(await top()).toBe(before);
        expect(await card.getByRole("button", { name: "Erneut versuchen" }).count()).toBe(1);
        expect(h.errors).toEqual([]);
        await shot(h.page, `f-karte-fehlgeschlagen-${view.name}-light`);
      } finally {
        await h.close();
      }
    }
  }, 120_000);

  test("a decision that arrives live changes the waiting card in place: same top edge, its answers change, nothing polls", async () => {
    const decided = {
      type: "ai.invalidated",
      changeId: "77777777-7777-4777-8777-777777777777",
      conversationId: null,
      projectId: null,
      domains: ["code-versions"],
      at: at(0),
    };
    for (const view of [desktop, phone]) {
      const scenario: Scenario = {
        cardPreview: cardPreview({ readiness: { state: "approval_pending" } }),
        cardReview: { status: "pending" },
      };
      const h = await open(view, scenario, { path: "/app/assistant/panel" });
      try {
        const card = h.page.locator(".assistant-code-version");
        await card.getByText("Version 5 wartet auf einen Admin. Du bekommst Bescheid.").waitFor();
        expect(await card.innerText()).not.toContain("Jana");
        const before = (await card.boundingBox())!;
        scenario.cardPreview = cardPreview();
        scenario.cardReview = { status: "approved", decidedBy: JANA, decidedAt: at(1) };
        await h.page.evaluate(
          (event) => (window as unknown as { harnessLive: { apply(events: unknown[]): Promise<void> } }).harnessLive.apply([event]),
          decided,
        );
        await card.getByRole("button", { name: "Einschalten", exact: true }).waitFor();
        expect(await card.innerText()).toContain("Jana Probe hat Version 5 freigegeben.");
        const after = (await card.boundingBox())!;
        expect(Math.round(after.y)).toBe(Math.round(before.y));
        expect(h.codeCalls.filter((call) => call === "core.code.version.cards")).toHaveLength(2);
        expect(h.errors).toEqual([]);
        await shot(h.page, `f-karte-freigegeben-${view.name}-light`);
      } finally {
        await h.close();
      }
    }
  }, 120_000);

  test("a personal Code opens on the shared Code page, runs as its person, and keeps My apps & automations marked", async () => {
    for (const view of [desktop, phone]) {
      const h = await open(view, { detail: true }, { path: "/app/assistant/code/c_woche1" });
      try {
        const page = h.page.locator(".cloud-code");
        await page.getByRole("heading", { level: 1, name: "Wochenbericht Vertrieb" }).waitFor();
        // The shared Code page owns its words. On a phone the sidebar is out of sight, so a link leads back to the list.
        const back = h.page.locator("a.assistant-code-detail__back");
        expect(await back.isVisible()).toBe(view === phone);
        expect(await back.getAttribute("href")).toBe("/app/assistant?code=1");
        if (view === phone) expect((await back.textContent())?.trim()).toBe("Meine Apps & Automationen");
        if (view === desktop)
          expect(
            await h.page.locator('footer[data-sidebar-mode="expanded"] a[href="/app/assistant?code=1"]').getAttribute("aria-current"),
          ).toBe("page");
        await shot(h.page, `c-code-detail-${view.name}-light`);
        expect(h.errors).toEqual([]);
        if (view === desktop) {
          // The marked sidebar entry leads back to the list.
          await h.page.locator('footer[data-sidebar-mode="expanded"] a[href="/app/assistant?code=1"]').click();
          await h.page.waitForURL((url) => url.pathname === "/app/assistant" && url.searchParams.get("code") === "1");
        }
      } finally {
        await h.close();
      }
    }
  }, 120_000);

  // Automations v5, 4.4: personal Code names the chat it writes to; a missing chat says so above the page with a way out.
  test("personal Code names its chat, and a missing chat offers its owner to choose or restore one", async () => {
    for (const view of [desktop, phone]) {
      for (const detailState of ["personal", "personal-chat-missing"] as const) {
        for (const theme of view === desktop ? (["light", "dark"] as const) : (["light"] as const)) {
          const h = await open(view, { detail: true, detailState }, { path: "/app/assistant/code/c_woche1", theme });
          try {
            const page = h.page.locator(".cloud-code");
            await page.getByRole("heading", { level: 1, name: "Wochenbericht Vertrieb" }).waitFor();
            const may = page.locator(".cloud-code__may");
            if (detailState === "personal") {
              await may.getByText("In den Chat „Wochenbericht“ schreiben, Gustav antwortet").waitFor();
              expect(await may.getByRole("button", { name: "Anderen Chat wählen" }).count()).toBe(1);
            } else {
              await page.getByText("Der Chat „Wochenbericht“ ist archiviert.").waitFor();
              expect(await page.getByRole("button", { name: "Chat wählen …" }).count()).toBeGreaterThan(0);
              expect(await page.getByRole("button", { name: "Chat wiederherstellen" }).count()).toBe(1);
            }
            expect(await h.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
            await shot(h.page, `g3-${detailState}-${view.name}-${theme}`);
            expect(h.errors).toEqual([]);
          } finally {
            await h.close();
          }
        }
      }
    }
  }, 180_000);

  test("Waiting for you lists what the row and the count hold: approvals and versions, nothing else", async () => {
    for (const view of [desktop, phone]) {
      const h = await open(view, { waiting: true }, { path: "/app/assistant?approvals=1" });
      try {
        const versions = h.page.locator('section[aria-labelledby="assistant-waiting-versions"]');
        await versions.getByText("Version 2 einschalten").waitFor();
        expect(await h.page.getByRole("heading", { name: "Freigaben 1" }).count()).toBe(1);
        expect(await h.page.getByRole("heading", { name: "Versionen 1" }).count()).toBe(1);
        expect(await versions.getByText("in Lieferungen eintragen").count()).toBe(1);
        expect(await versions.getByRole("button", { name: "Ansehen: Version 2 einschalten" }).count()).toBe(1);
        // The page shows as many entries as the sidebar counts, and Code of places is no entry of its own.
        const entries = (await h.page.locator(".cloud-approval").count()) + (await versions.locator("li").count());
        if (view === desktop)
          expect(
            await h.page.locator('a[href="/app/assistant?approvals=1"] .k2b-app-workspace__sidebar-status-count').first().textContent(),
          ).toBe(String(entries));
        expect(entries).toBe(waitingQuestions.count);
        expect(await h.page.getByText("du verwaltest").count()).toBe(0);
        await shot(h.page, `d-wartet-auf-dich-${view.name}-light`);
        expect(h.errors).toEqual([]);
      } finally {
        await h.close();
      }
    }
  }, 120_000);

  test("a place that can own Code but has none says so in the panel and offers to start with Gustav", async () => {
    const h = await open(panel, { panel: true, panelEmpty: true }, { path: "/app/assistant/panel" });
    try {
      const block = h.page.locator("section.assistant-code-block");
      await block.getByText("info@moebel-beispiel.de hat noch keinen Code.").waitFor();
      expect(await block.getByRole("button", { name: "Mit Gustav anlegen" }).count()).toBe(1);
      await shot(h.page, "b-panel-code-von-leer-light");
    } finally {
      await h.close();
    }
  }, 60_000);
});
