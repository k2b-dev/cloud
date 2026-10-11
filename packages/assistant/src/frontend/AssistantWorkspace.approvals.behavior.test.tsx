import { expect, test } from "bun:test";
import type { AiConversation } from "@k2b/cloud/ai";
import { delegateEvents, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return (await import("./AssistantWorkspace.island")).default;
  } finally {
    dom.cleanup();
  }
};
const AssistantWorkspace = await load();

const blank: AiConversation = {
  id: "blank1",
  shortId: "blank1",
  title: "New chat",
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: "2026-10-08T09:00:00.000Z",
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "user123",
  createdAt: "2026-10-08T09:00:00.000Z",
  updatedAt: "2026-10-08T09:00:00.000Z",
};

test("New chat and the chat row leave the approvals view opened over an empty chat and return to that chat", async () => {
  const dom = createDomTestHarness();
  dom.window.history.replaceState(null, "", "/app/assistant?conversation=blank1");
  const requests: { method: string; url: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ method: init?.method ?? "GET", url });
      if (url.startsWith("/api/approvals?")) return Response.json({ items: [], nextCursor: null, count: 0, elsewhere: 0 });
      // The open chat's stream stays connected, so the empty chat counts as loaded.
      if (url.endsWith("/stream")) return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
      return Response.json({ message: "unavailable" }, { status: 503 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const dispose = render(
    () => (
      <AssistantWorkspace
        userId="user123"
        cloudUrl="http://localhost"
        status={{ ok: true, enabled: true, defaultModelId: "", visionModelConfigured: false, error: null, models: [] }}
        models={[]}
        lastModelId=""
        timeZone="UTC"
        renderedAt="2026-10-08T10:00:00.000Z"
        initialLiveCursor="s6t.cloud-live-core.0"
        initialConversations={[blank]}
        initialDoneCount={0}
        initialConversationId="blank1"
        initialArtifactPath={null}
        initialDetail={{ conversation: blank, messages: [], hasMoreMessages: false, activeTurn: null, timeline: [] }}
        initialContext={null}
        projects={[]}
        initialProject={null}
        initialProjectChats={null}
        initialProjectContext={null}
        approvals={{ page: { items: [], nextCursor: null, count: 1, elsewhere: 0 }, open: false }}
      />
    ),
    dom.root,
  );
  delegateEvents(["click"]);
  const approvalsView = () => dom.root.querySelector('section.cloud-approvals, [aria-label="Approvals"].cloud-approvals');
  const composer = () => dom.root.querySelector('button[aria-label="Send message"]');
  try {
    expect(composer()).not.toBeNull();
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/assistant?approvals=1"]')!.click();
    await Bun.sleep(0);
    expect(dom.window.location.search).toBe("?approvals=1");
    expect(approvalsView()).not.toBeNull();
    expect(composer()).toBeNull();
    const newChat = dom.root.querySelector<HTMLButtonElement>('button[aria-label="New chat"]')!;
    newChat.click();
    await Bun.sleep(0);
    expect(approvalsView()).toBeNull();
    expect(composer()).not.toBeNull();
    expect(dom.window.location.search).toBe("?conversation=blank1");
    // The empty chat is reused; another empty one would only crowd the list.
    expect(requests.filter((request) => request.method === "POST" && request.url.endsWith("/conversations"))).toEqual([]);
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/assistant?approvals=1"]')!.click();
    await Bun.sleep(0);
    expect(approvalsView()).not.toBeNull();
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/assistant?conversation=blank1"]')!.click();
    for (let attempt = 0; attempt < 100 && dom.window.location.search !== "?conversation=blank1"; attempt += 1) await Bun.sleep(10);
    expect(approvalsView()).toBeNull();
    expect(composer()).not.toBeNull();
    expect(dom.window.location.search).toBe("?conversation=blank1");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
