import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import { ChatSnapshotSchema, MessageViewSchema, SendMessageSchema } from "../service/contracts";
import type { ChatWorkspaceProps } from "./ChatWorkspace.island";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: ChatWorkspace } = await import("./ChatWorkspace.island");
    return { LocaleProvider, ChatWorkspace };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();
const now = "2026-10-12T10:30:00.000Z";
const viewerId = "11111111-1111-4111-8111-111111111111";
const conversation: NonNullable<ChatWorkspaceProps["open"]>["conversation"] = {
  id: "Chat01",
  name: "Secret board",
  title: "Secret board",
  icon: null,
  purpose: null,
  memberCount: 2,
  unread: 0,
  read: { lastReadSeq: null, unreadFromSeq: null, joinedSeq: 0 },
  withGuests: false,
  peerDeactivated: false,
  permission: "write",
  rev: 0,
  createdAt: now,
  lastActivityAt: now,
  lastMessage: null,
};
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() {
    this.readyState = 3;
  }
}
const settle = () => Bun.sleep(60);
const message = (seq: number, body = `Message ${seq}`) =>
  MessageViewSchema.parse({
    id: String(seq).padStart(10, "0"),
    conversationId: conversation.id,
    seq,
    rev: seq,
    kind: "text",
    author: { type: "user", id: viewerId, name: "Robin" },
    body,
    system: null,
    systemText: null,
    createdAt: now,
  });

describe("ChatWorkspace interactions", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  let dom: DomTestHarness;
  let dispose = () => {};
  const originalFetch = globalThis.fetch;
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const originalCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  const originalConsoleError = console.error;
  const consoleErrors: unknown[][] = [];
  const posted: { clientId: string; body: string }[] = [];
  const snapshots = new Map<string, ReturnType<typeof ChatSnapshotSchema.parse>>();
  let answer: (response: Response) => void;
  beforeEach(() => {
    dom = createDomTestHarness();
    delegateEvents(["click", "input", "keydown"], dom.document);
    posted.length = 0;
    snapshots.clear();
    consoleErrors.length = 0;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args);
    };
    // Enhanced navigation restores scroll regions by selector.
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: dom.window.CSS });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: FakeWebSocket });
    Object.defineProperty(dom.window, "WebSocket", { configurable: true, value: FakeWebSocket });
    const fetchChat = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
        const snapshot = /^\/api\/chat\/conversations\/([^/]+)\/snapshot$/.exec(url.pathname);
        if (snapshot) {
          const body = snapshots.get(snapshot[1]!);
          return body ? Response.json(ChatSnapshotSchema.parse(body)) : Response.json({}, { status: 404 });
        }
        if (url.pathname === "/api/chat/conversations/Chat01/messages" && init?.method === "POST") {
          posted.push(SendMessageSchema.parse(JSON.parse(String(init.body))));
          return new Promise<Response>((resolve) => {
            answer = resolve;
          });
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url.pathname}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    globalThis.fetch = fetchChat;
    Object.defineProperty(dom.window, "fetch", { configurable: true, value: fetchChat });
  });
  afterEach(async () => {
    dispose();
    await Bun.sleep(20);
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    if (originalCss) Object.defineProperty(globalThis, "CSS", originalCss);
    else Reflect.deleteProperty(globalThis, "CSS");
    if (originalWebSocket) Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
    dom.cleanup();
  });
  const mount = async (open: boolean, sidebar = [conversation]) => {
    const { ChatWorkspace, LocaleProvider } = modules!;
    dom.window.history.replaceState(null, "", open ? "/app/chat/c/Chat01" : "/app/chat");
    const props: ChatWorkspaceProps = {
      cursor: "c.0",
      sidebar: { items: sidebar, nextCursor: null },
      open: open ? { conversation, page: { items: [], seqHead: 0, rev: 0 }, focus: null } : null,
      chatId: open ? conversation.id : null,
      viewerId,
      dateConfig: { timeZone: "UTC" },
      now,
    };
    dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "en",
          get children() {
            return createComponent(ChatWorkspace, props);
          },
        }),
      dom.root,
    );
    await settle();
  };
  const button = (label: string) => {
    const found = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label,
    );
    if (!found) throw new Error(`Missing button ${label}`);
    return found;
  };
  test("failed send retries the same client ID and body, then shows one sent row", async () => {
    await mount(true);
    const field = dom.root.querySelector<HTMLTextAreaElement>('textarea:not([aria-hidden="true"])')!;
    field.value = "Please confirm delivery";
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
    button("Send message").click();
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toBe("Please confirm delivery");
    expect(posted[0]?.clientId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(dom.root.querySelector('[data-status="pending"]')?.textContent).toContain("Sending");
    answer(Response.json({ message: "Unavailable" }, { status: 503 }));
    await settle();
    expect(dom.root.querySelector('[data-status="failed"]')?.textContent).toContain("Not sent");
    expect(button("Retry")).toBeDefined();
    button("Retry").click();
    await settle();
    expect(posted).toEqual([posted[0]!, { clientId: posted[0]!.clientId, body: "Please confirm delivery" }]);
    answer(
      Response.json(
        {
          id: "Chat010001",
          conversationId: "Chat01",
          seq: 1,
          rev: 1,
          kind: "text",
          author: { type: "user", id: viewerId, name: "Robin" },
          body: "Please confirm delivery",
          system: null,
          systemText: null,
          createdAt: now,
        },
        { status: 201 },
      ),
    );
    await settle();
    const rows = [...dom.root.querySelectorAll(".k2b-message-row")].filter((row) => row.textContent?.includes("Please confirm delivery"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute("data-status")).toBe("sent");
    expect([...(rows[0]?.querySelectorAll(".k2b-sr-only") ?? [])].map((label) => label.textContent)).toContain("Sent");
  });
  test("an enhanced open with a 404 updates the address without revealing the title in the work area", async () => {
    await mount(false);
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat01"]')!.click();
    await settle();
    expect(dom.window.location.pathname).toBe("/app/chat/c/Chat01");
    const area = dom.root.querySelector(".k2b-app-workspace__main")!;
    expect(area.textContent).toContain("No access");
    expect(area.textContent).toContain("This chat does not exist, or you are not a member of it.");
    expect(area.textContent).not.toContain("Secret board");
    // The open stayed in place: no document-navigation fallback.
    expect(consoleErrors).toEqual([]);
    expect(dom.window.history.state).toEqual({ chatFromList: true });
  });
  test("reopening the latest history does not append an older sent message", async () => {
    const other = { ...conversation, id: "Chat02", title: "Other chat" };
    snapshots.set(other.id, {
      cursor: "c.109",
      conversation: other,
      page: { items: [{ ...message(109), conversationId: other.id }], seqHead: 109, rev: 109 },
      focus: null,
    });
    await mount(true, [conversation, other]);
    const field = dom.root.querySelector<HTMLTextAreaElement>('textarea:not([aria-hidden="true"])')!;
    field.value = "hi";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    button("Send message").click();
    await settle();
    expect(posted).toHaveLength(1);
    answer(Response.json(message(1, "hi"), { status: 201 }));
    await settle();
    expect(dom.root.querySelector('.k2b-message-row[data-status="sent"]')?.textContent).toContain("hi");
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat02"]')!.click();
    await settle();
    expect(dom.window.location.pathname).toBe("/app/chat/c/Chat02");
    // Another chat's loaded sequence must not prune this chat's uncovered send.
    snapshots.set(conversation.id, { cursor: "c.0", conversation, page: { items: [], seqHead: 0, rev: 0 }, focus: null });
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat01"]')!.click();
    await settle();
    expect(dom.root.querySelector('.k2b-message-row[data-status="sent"]')?.textContent).toContain("hi");
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat02"]')!.click();
    await settle();
    snapshots.set(conversation.id, {
      cursor: "c.109",
      conversation: { ...conversation, rev: 109 },
      page: { items: Array.from({ length: 50 }, (_, index) => message(index + 60)), seqHead: 109, rev: 109 },
      focus: null,
    });
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat01"]')!.click();
    await settle();
    expect(dom.window.location.pathname).toBe("/app/chat/c/Chat01");
    const rows = [...dom.root.querySelectorAll(".k2b-message-row")];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.textContent?.includes("hi"))).toBe(false);
    expect(rows.at(-1)?.textContent).toContain("Message 109");
    expect(consoleErrors).toEqual([]);
  });
  test("a later message waits behind a failed one and follows after retry", async () => {
    await mount(true);
    const field = dom.root.querySelector<HTMLTextAreaElement>('textarea:not([aria-hidden="true"])')!;
    field.value = "first";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    button("Send message").click();
    await settle();
    expect(posted).toHaveLength(1);
    answer(Response.json({ message: "Unavailable" }, { status: 503 }));
    await settle();
    expect(dom.root.querySelector('[data-status="failed"]')?.textContent).toContain("Not sent");
    field.value = "second";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    button("Send message").click();
    await settle();
    expect(posted).toHaveLength(1);
    expect(dom.root.querySelector('[data-status="pending"]')?.textContent).toContain("second");
    button("Retry").click();
    await settle();
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual({ clientId: posted[0]!.clientId, body: "first" });
    answer(Response.json(message(1, "first"), { status: 201 }));
    await settle();
    expect(posted).toHaveLength(3);
    expect(posted[2]?.body).toBe("second");
    answer(Response.json(message(2, "second"), { status: 201 }));
    await settle();
    const rows = [...dom.root.querySelectorAll(".k2b-message-row")];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.getAttribute("data-status"))).toEqual(["sent", "sent"]);
    expect(rows[0]?.textContent).toContain("first");
    expect(rows[1]?.textContent).toContain("second");
  });
  test("discarding a message the server refuses lets the waiting ones go out", async () => {
    await mount(true);
    const field = dom.root.querySelector<HTMLTextAreaElement>('textarea:not([aria-hidden="true"])')!;
    const hint = () => dom.root.querySelector(".k2b-chat-composer__hint-text")?.textContent ?? "";
    const type = (text: string) => {
      field.value = text;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      button("Send message").click();
    };
    type("refused");
    await settle();
    answer(Response.json({ message: "Invalid input" }, { status: 400 }));
    await settle();
    expect(hint()).toBe("Later messages wait for the one that was not sent.");
    type("waiting");
    await settle();
    expect(posted.map((input) => input.body)).toEqual(["refused"]);
    button("Discard message").click();
    await settle();
    expect(posted.map((input) => input.body)).toEqual(["refused", "waiting"]);
    expect(hint()).toBe("");
    answer(Response.json(message(1, "waiting"), { status: 201 }));
    await settle();
    const rows = [...dom.root.querySelectorAll(".k2b-message-row")];
    expect(rows.map((row) => row.getAttribute("data-status"))).toEqual(["sent"]);
    expect(rows[0]?.textContent).toContain("waiting");
  });
  // happy-dom has no viewport layout; the 120-message deep link is verified in the browser suite.
});
