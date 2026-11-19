import { afterEach, expect, mock, setSystemTime, test } from "bun:test";
import type { AiConversation, AiOpenQuestion, AiOpenQuestions, AiTurnSnapshot } from "@k2b/cloud/ai";
import type { LiveSubscriptionHandlers } from "@k2b/cloud/browser/live";
import type { PendingApproval } from "@k2b/cloud/contracts/approvals";
import { delegateEvents, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

// The live socket is the test's, so a question that opens or is decided elsewhere arrives as it does from Core.
const subscriptions: LiveSubscriptionHandlers<unknown>[] = [];
mock.module("@k2b/cloud/browser/live", () => ({
  liveConnection: () => ({
    subscribe: (_channel: string, _scope: unknown, handlers: LiveSubscriptionHandlers<unknown>) => {
      subscriptions.push(handlers);
      return { close() {} };
    },
  }),
}));
const bootstrap = createDomTestHarness();
const { WAITING_NOW, waitingChatHistory, waitingFixture, waitingStripSummary } = await import("./waiting-questions.fixture");
const { LocaleProvider } = await import("@k2b/ui");
const { default: Workspace } = await import("./AssistantWorkspace.island");
bootstrap.cleanup();

const now = WAITING_NOW;
const chat = (id: string, title: string, runStatus: AiConversation["runStatus"]): AiConversation => ({
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
  runStatus,
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "user01",
  createdAt: now,
  updatedAt: now,
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  subscriptions.length = 0;
  setSystemTime();
});
const waitFor = async (condition: () => boolean, timeoutMs = 2_000) => {
  for (let i = 0; i < timeoutMs / 10; i++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error("Condition did not settle");
};

const mount = (
  server: {
    conversations: AiConversation[];
    questions: AiOpenQuestions;
    approvals?: PendingApproval[];
    nextQuestions?: AiOpenQuestions;
    pageFails?: boolean;
  },
  here: AiConversation,
  activeTurn: AiTurnSnapshot | null = null,
) => {
  setSystemTime(new Date(now));
  const dom = createDomTestHarness();
  cleanups.push(dom.cleanup);
  dom.window.history.replaceState(null, "", `/app/assistant?conversation=${here.id}`);
  const shell = dom.document.createElement("script");
  shell.id = "cloud-shell-data";
  shell.textContent = JSON.stringify({ apps: [], appId: "assistant" });
  dom.document.body.append(shell);
  const sidebarLoads: string[] = [];
  let approvalLoads = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/assistant/workspace/sidebar") {
        sidebarLoads.push(url.pathname);
        return Response.json({ conversations: server.conversations, projects: [], doneCount: 0, questions: server.questions });
      }
      if (url.pathname === "/api/approvals") {
        approvalLoads++;
        const items = server.approvals ?? [];
        return Response.json({ items, nextCursor: null, count: items.length, elsewhere: 0 });
      }
      if (/^\/api\/approvals\/[^/]+\/decision$/.test(url.pathname)) return Response.json({ status: "rejected" });
      // Core's open questions of one kind, the read the page's "Automations" section makes.
      if (url.pathname === "/api/capabilities/v1/queries/core/ai.open_questions") {
        const body = JSON.parse(String(init?.body)) as { input: { cursor?: unknown } };
        if (body.input.cursor) {
          expect(body.input.cursor).toEqual(server.questions.nextCursor!);
          return server.pageFails
            ? Response.json({ message: "unavailable" }, { status: 503 })
            : Response.json({ data: server.nextQuestions });
        }
        return Response.json({
          data: { count: 0, items: server.questions.items.filter((question) => question.kind === "code_attention") },
        });
      }
      if (url.pathname.endsWith("/stream")) return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
      return Response.json({ message: "unavailable" }, { status: 503 });
    },
    { preconnect: originalFetch.preconnect },
  );
  cleanups.push(() => {
    globalThis.fetch = originalFetch;
  });
  const dispose = render(
    () => (
      <LocaleProvider locale="de">
        <Workspace
          userId="user01"
          cloudUrl="http://localhost"
          status={{
            ok: true,
            enabled: true,
            status: "ok",
            selection: null,
            effectiveDefault: { class: "balanced" },
            classes: [],
            visionModelConfigured: false,
            error: null,
            options: [],
          }}
          models={[]}
          timeZone="Europe/Berlin"
          renderedAt={now}
          initialLiveCursor="s6t.cloud-live-core.0"
          initialConversations={server.conversations}
          initialQuestions={server.questions}
          initialDoneCount={0}
          initialConversationId={here.id}
          initialArtifactPath={null}
          initialDetail={{ conversation: here, messages: waitingChatHistory, hasMoreMessages: false, activeTurn, timeline: [] }}
          initialContext={null}
          projects={[]}
          initialProject={null}
          initialProjectChats={null}
          initialProjectContext={null}
          approvals={{ page: { items: [], nextCursor: null, count: 0, elsewhere: 0 }, open: false }}
        />
      </LocaleProvider>
    ),
    dom.root,
  );
  cleanups.push(dispose);
  delegateEvents(["click"]);
  /** The chat list's rows that carry the waiting dot, by the title of their link. */
  const dotted = () =>
    [...dom.root.querySelectorAll(".assistant-chat-sidebar-item")]
      .filter((row) => row.querySelector(".assistant-chat-waiting"))
      .map((row) => (row.matches("a") ? row : row.querySelector("a"))?.getAttribute("href"));
  /** Delivers one AI change for the owner's chat list, as Core's socket does. */
  const changed = async (conversationId: string) => {
    const live = subscriptions.at(-1)!;
    await live.apply([
      {
        data: live.parse({
          type: "ai.invalidated",
          changeId: crypto.randomUUID(),
          conversationId,
          projectId: null,
          domains: ["conversation-list"],
          at: now,
        }),
        cursor: `s6t.cloud-live-core.${sidebarLoads.length + 1}`,
      },
    ]);
  };
  return {
    ...dom,
    dotted,
    changed,
    sidebarLoads,
    approvalLoads: () => approvalLoads,
    strip: () => dom.root.querySelector("nav.assistant-waiting"),
  };
};

test("the dot and the waiting row follow a question that opens and is decided in another chat, one load per change", async () => {
  const here = chat("Wart42", "Wartung Oktober", "idle");
  const other = chat("Tops42", "Team Ops Wochenplanung", "idle");
  const server = { conversations: [here, other], questions: { items: [], count: 0 } as AiOpenQuestions };
  const h = mount(server, here);
  await waitFor(() => subscriptions.length > 0);
  expect(h.dotted()).toEqual([]);
  expect(h.strip()).toBeNull();

  // A question opens in the other chat.
  const routine = waitingFixture.questions.items.find((question) => question.conversationId === "Tops42")!;
  server.conversations = [here, { ...other, runStatus: "needs_attention" }];
  server.questions = { items: [routine], count: 1 };
  await h.changed("Tops42");
  await waitFor(() => h.dotted().length === 1);
  expect(h.dotted()).toEqual(["/app/assistant?conversation=Tops42"]);
  await waitFor(() => h.strip() !== null);
  expect(waitingStripSummary(h.strip()!.outerHTML)).toEqual({
    quiet: false,
    label: "Wartet auf dich",
    entries: [`${routine.short} in Team Ops Wochenplanung`],
  });
  expect(h.sidebarLoads).toHaveLength(1);

  // It is decided elsewhere, such as in the Approvals view.
  server.conversations = [here, other];
  server.questions = { items: [], count: 0 };
  await h.changed("Tops42");
  await waitFor(() => h.dotted().length === 0);
  await waitFor(() => h.strip() === null);
  expect(h.sidebarLoads).toHaveLength(2);
});

test("the first client frame of the waiting row equals the server's", async () => {
  for (const [name, fixture] of Object.entries(waitingFixture.cases)) {
    const h = mount(
      { conversations: waitingFixture.conversations, questions: fixture.questions },
      waitingFixture.conversations.find((conversation) => conversation.id === "Wart42")!,
      fixture.activeTurn,
    );
    const strip = h.strip();
    expect([name, strip ? waitingStripSummary(strip.outerHTML) : null]).toEqual([name, fixture.server]);
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  }
});

test("a run that starts in the open chat and in another marks both rows without a reload, and its unread answer stays marked", async () => {
  const here = chat("Wart42", "Wartung Oktober", "idle");
  const other = chat("Tops42", "Team Ops Wochenplanung", "idle");
  const server = { conversations: [here, other], questions: { items: [], count: 0 } as AiOpenQuestions };
  const h = mount(server, here);
  await waitFor(() => subscriptions.length > 0);
  /** Each chat row's mark and whether it offers Done, by the row's link. */
  const marks = () =>
    [...h.root.querySelectorAll("div.assistant-chat-sidebar-item")].map((row) => [
      row.querySelector("a")?.getAttribute("href")?.split("conversation=")[1],
      row.querySelector(".k2b-app-workspace__sidebar-item-meta > .assistant-chat-marker > i")?.getAttribute("class") ?? null,
      row.querySelector("button[aria-label='Chat als fertig markieren']") !== null,
    ]);
  expect(marks()).toEqual([
    ["Wart42", null, true],
    ["Tops42", null, true],
  ]);

  // Both start: the open chat, and one started elsewhere, such as from the phone.
  const spinner = "ti ti-loader-2 animate-spin motion-reduce:animate-none assistant-chat-progress";
  server.conversations = [
    { ...here, runStatus: "running" },
    { ...other, runStatus: "running" },
  ];
  await h.changed("Tops42");
  await waitFor(() => marks().every(([, mark]) => mark !== null));
  expect(marks()).toEqual([
    ["Wart42", spinner, false],
    ["Tops42", spinner, false],
  ]);

  // The other one finishes while the person stays here: its answer is unread.
  server.conversations = [
    { ...here, runStatus: "running" },
    { ...other, unreadCompletion: true },
  ];
  await h.changed("Tops42");
  await waitFor(() => marks()[1]?.[1] === "assistant-chat-unread");
  expect(marks()).toEqual([
    ["Wart42", spinner, false],
    ["Tops42", "assistant-chat-unread", true],
  ]);
  expect(h.root.querySelector("div.assistant-chat-sidebar-item--unread a")?.getAttribute("href")).toBe(
    "/app/assistant?conversation=Tops42",
  );
  expect(h.sidebarLoads).toHaveLength(2);
});

/** Code entries that wait without any approval: a version to switch on and an automation that needs a secret. */
const codeEntries = () => {
  const code = (kind: AiOpenQuestion["kind"], id: string, short: string, conversationId: string, title: string): AiOpenQuestion => ({
    kind,
    id,
    conversationId,
    conversationTitle: title,
    anchor: `code-version-${id}`,
    short,
    app: { name: "Automationen", icon: "ti ti-stack-2" },
    createdAt: now,
  });
  return {
    activate: code("code_activate", "code:v2", "Version 2 einschalten", "Wart42", "Wartung Oktober"),
    secret: code("code_attention", "code:a1", "Lieferavise sortieren braucht ein Secret", "Tops42", "Team Ops Wochenplanung"),
  };
};

test("the sidebar counts exactly what the waiting row lists, also entries that are not approvals, and follows it live", async () => {
  const here = chat("Wart42", "Wartung Oktober", "idle");
  const other = chat("Tops42", "Team Ops Wochenplanung", "idle");
  // The tour's case: Code entries wait, no approval does, so the approvals count would say 0.
  const { activate, secret } = codeEntries();
  const server = { conversations: [here, other], questions: { items: [activate, secret], count: 2 } as AiOpenQuestions };
  const h = mount(server, here);
  /** The sidebar's "Waiting for you" count, and the number of entries the row above the field lists. */
  const counts = () => {
    const row = h.root.querySelector('footer[data-sidebar-mode="expanded"] a[href="/app/assistant?approvals=1"]');
    const strip = h.strip();
    return {
      sidebar: row?.querySelector(".k2b-app-workspace__sidebar-status-count")?.textContent ?? null,
      row: strip ? (waitingStripSummary(strip.outerHTML)?.entries.length ?? 0) : 0,
    };
  };
  await waitFor(() => subscriptions.length > 0);
  expect(counts()).toEqual({ sidebar: "2", row: 2 });

  // One is done elsewhere: both drop together after one load.
  server.questions = { items: [activate], count: 1 };
  await h.changed("Tops42");
  await waitFor(() => counts().row === 1);
  expect(counts()).toEqual({ sidebar: "1", row: 1 });

  server.questions = { items: [], count: 0 };
  await h.changed("Wart42");
  await waitFor(() => h.strip() === null);
  expect(counts()).toEqual({ sidebar: "0", row: 0 });
  expect(h.sidebarLoads).toHaveLength(2);
});

test("the page Waiting for you lists the same entries as the row and the sidebar count", async () => {
  const here = chat("Wart42", "Wartung Oktober", "idle");
  const other = chat("Tops42", "Team Ops Wochenplanung", "idle");
  const { activate, secret } = codeEntries();
  const server = { conversations: [here, other], questions: { items: [activate, secret], count: 2 } as AiOpenQuestions };
  const h = mount(server, here);
  await waitFor(() => subscriptions.length > 0);
  const row = waitingStripSummary(h.strip()!.outerHTML)!
    .entries.map((entry) => entry.replace(/ in .*$/, ""))
    .sort();
  const sidebarRow = () =>
    h.root.querySelector<HTMLAnchorElement>('footer[data-sidebar-mode="expanded"] a[href="/app/assistant?approvals=1"]')!;
  const sidebar = () => sidebarRow().querySelector(".k2b-app-workspace__sidebar-status-count")?.textContent;
  expect(sidebar()).toBe("2");

  sidebarRow().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  const page = () =>
    [...h.root.querySelectorAll(".assistant-waiting-page .assistant-waiting-page__row-title")]
      .map((title) => title.textContent ?? "")
      .sort();
  await waitFor(() => page().length === 2);
  expect(page()).toEqual(row);
  expect(page()).toEqual(["Lieferavise sortieren braucht ein Secret", "Version 2 einschalten"]);
  expect(sidebar()).toBe(String(page().length));

  // While the page is open, an automation starts to wait and the secret is set elsewhere: page and count follow.
  const briefing = { ...secret, id: "code:a2", short: "Morgenbriefing braucht einen Chat" };
  server.questions = { items: [activate, briefing], count: 2 };
  await h.changed("Tops42");
  await waitFor(() => page().includes("Morgenbriefing braucht einen Chat"));
  expect(page()).toEqual(["Morgenbriefing braucht einen Chat", "Version 2 einschalten"]);
  expect(sidebar()).toBe("2");
  // Nothing on the page shows a loading state for it.
  expect(h.root.querySelector(".assistant-waiting-page [aria-busy='true']")).toBeNull();
});

/** A request Mail asks about, as the approvals list returns it, and the same request in the row's list. */
const mailApproval = (id: string, offer: string): { request: PendingApproval; question: AiOpenQuestion } => ({
  request: {
    id,
    app: { id: "mail", name: "Mail", icon: "ti ti-mail" },
    action: "draft.send",
    assurance: "confirm",
    sentence: `Mail: Angebot ${offer} senden`,
    review: null,
    requester: { kind: "chat", appId: "assistant", title: "Wartung Oktober", href: "/app/assistant?conversation=Wart42" },
    remember: { chat: false, always: false, website: false },
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + 23 * 3_600_000).toISOString(),
  },
  question: {
    id,
    kind: "approval",
    conversationId: "Wart42",
    conversationTitle: "Wartung Oktober",
    anchor: `tool-${id}`,
    short: `Mail: Angebot ${offer} senden`,
    app: { name: "Mail", icon: "ti ti-mail" },
    createdAt: now,
  },
});

test("an approval decided on the page keeps its receipt; a new one elsewhere appears", async () => {
  const here = chat("Wart42", "Wartung Oktober", "idle");
  const first = mailApproval("00000000-0000-4000-8000-0000000000a1", "1");
  const second = mailApproval("00000000-0000-4000-8000-0000000000a2", "2");
  const server = {
    conversations: [here],
    questions: { items: [first.question], count: 1 } as AiOpenQuestions,
    approvals: [first.request],
  };
  const h = mount(server, here);
  await waitFor(() => subscriptions.length > 0);
  h.root
    .querySelector<HTMLAnchorElement>('footer[data-sidebar-mode="expanded"] a[href="/app/assistant?approvals=1"]')!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  const cards = () => [...h.root.querySelectorAll<HTMLElement>(".assistant-waiting-page article.cloud-approval")];
  await waitFor(() => cards().length === 1);
  const loads = h.approvalLoads();

  // (a) The person declines here; the request leaves the row's list. Its card stays as the receipt and is not read again.
  await Bun.sleep(550);
  const card = cards()[0]!;
  [...card.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Nicht ausführen")!.click();
  await waitFor(() => card.dataset.decided === "rejected");
  server.questions = { items: [], count: 0 };
  server.approvals = [];
  await h.changed("Wart42");
  await waitFor(() => h.sidebarLoads.length === 1);
  await Bun.sleep(50);
  expect(cards()).toEqual([card]);
  expect(card.dataset.decided).toBe("rejected");
  expect(h.approvalLoads()).toBe(loads);

  // (b) A new request arrives from another chat: the page reads its approvals again and shows it.
  server.questions = { items: [second.question], count: 1 };
  server.approvals = [second.request];
  await h.changed("Wart42");
  await waitFor(() => cards().some((entry) => entry.textContent?.includes("Angebot 2")));
  expect(h.approvalLoads()).toBe(loads + 1);
  expect(h.root.querySelector(".assistant-waiting-page [aria-busy='true']")).toBeNull();
});

test("twenty approvals plus a newer Code version remain reachable with the sidebar count, including paging retry", async () => {
  const here = chat("Wart42", "Wartung Oktober", "idle");
  const approvals = Array.from({ length: 20 }, (_, index) =>
    mailApproval(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, String(index)),
  );
  const last = approvals.at(-1)!.question;
  const version = { ...codeEntries().activate, createdAt: "2026-11-20T12:00:00.000Z" };
  const server = {
    conversations: [here],
    questions: { items: approvals.map((item) => item.question), count: 21, nextCursor: { createdAt: last.createdAt, id: last.id } },
    approvals: approvals.map((item) => item.request),
    nextQuestions: { count: 21, items: [version] },
    pageFails: true,
  };
  const h = mount(server, here);
  await waitFor(() => subscriptions.length > 0);
  const sidebarRow = h.root.querySelector<HTMLAnchorElement>('footer[data-sidebar-mode="expanded"] a[href="/app/assistant?approvals=1"]')!;
  const counter = () => sidebarRow.querySelector(".k2b-app-workspace__sidebar-status-count")?.textContent;
  expect(counter()).toBe("21");
  expect(h.strip()!.querySelector(".assistant-waiting__more")?.getAttribute("aria-label")).toContain("21");
  sidebarRow.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  const cards = () => h.root.querySelectorAll(".assistant-waiting-page article.cloud-approval");
  const more = () =>
    [...h.root.querySelectorAll<HTMLButtonElement>(".assistant-waiting-page button")].find(
      (button) => button.textContent === "Mehr laden" || button.textContent === "Erneut versuchen",
    );
  await waitFor(() => cards().length === 20 && more() !== undefined);
  const first = cards()[0];
  expect(h.root.querySelector('[data-kind="code_activate"]')).toBeNull();
  more()!.click();
  await waitFor(() => h.root.querySelector(".assistant-waiting-page [role='alert']") !== null);
  expect(cards()[0]).toBe(first);
  server.pageFails = false;
  more()!.click();
  await waitFor(() => h.root.querySelector('[data-kind="code_activate"]') !== null);
  expect(cards()[0]).toBe(first);
  expect(cards().length + h.root.querySelectorAll('[data-kind="code_activate"]').length).toBe(Number(counter()));
  expect(h.root.querySelector('[data-kind="code_activate"]')!.textContent).toContain("Version 2 einschalten");
  expect(more()).toBeUndefined();
  expect(h.root.querySelector(".assistant-waiting-page [aria-busy='true']")).toBeNull();
});
