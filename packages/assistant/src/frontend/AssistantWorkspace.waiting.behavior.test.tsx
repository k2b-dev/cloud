import { afterEach, expect, mock, setSystemTime, test } from "bun:test";
import type { AiConversation, AiOpenQuestions, AiTurnSnapshot } from "@k2b/cloud/ai";
import type { LiveSubscriptionHandlers } from "@k2b/cloud/browser/live";
import { delegateEvents, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { WAITING_NOW, waitingFixture, waitingStripSummary } from "./waiting-questions.fixture";

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
  server: { conversations: AiConversation[]; questions: AiOpenQuestions },
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/assistant/workspace/sidebar") {
        sidebarLoads.push(url.pathname);
        return Response.json({ conversations: server.conversations, projects: [], doneCount: 0, questions: server.questions });
      }
      if (url.pathname === "/api/approvals") return Response.json({ items: [], nextCursor: null, count: 0, elsewhere: 0 });
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
          initialDetail={{ conversation: here, messages: [], hasMoreMessages: false, activeTurn, timeline: [] }}
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
  return { ...dom, dotted, changed, sidebarLoads, strip: () => dom.root.querySelector("nav.assistant-waiting") };
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
