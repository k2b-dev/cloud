import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import { chatMessages } from "../messages";
import { ChatSnapshotSchema, MessageViewSchema, SendMessageSchema } from "../service/contracts";
import type { ChatWorkspaceProps } from "./ChatWorkspace.island";

const noThreads = { general: { unread: 0, lastMessage: null }, items: [] };

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
  threads: 0,
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
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose = null;
  onerror = null;
  conversationSubscription: string | undefined;
  constructor() {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    const frame: unknown = JSON.parse(data);
    if (
      frame &&
      typeof frame === "object" &&
      "channel" in frame &&
      frame.channel === "conversation" &&
      "id" in frame &&
      typeof frame.id === "string"
    )
      this.conversationSubscription = frame.id;
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }
  message(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
  close() {
    this.readyState = 3;
  }
}
const settle = () => Bun.sleep(60);
const message = (seq: number, body = `Message ${seq}`) =>
  MessageViewSchema.parse({
    thread: null,
    replyTo: null,
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
  const readPosts: number[] = [];
  const leavePosts: unknown[] = [];
  const snapshots = new Map<string, ReturnType<typeof ChatSnapshotSchema.parse>>();
  const pendingSnapshots = new Map<string, Promise<Response>>();
  let membersRequests = 0;
  let memberName: string | null = null;
  let answer: (response: Response) => void;
  beforeEach(() => {
    setSystemTime(new Date(now));
    dom = createDomTestHarness();
    delegateEvents(["click", "input", "keydown"], dom.document);
    posted.length = 0;
    readPosts.length = 0;
    leavePosts.length = 0;
    snapshots.clear();
    pendingSnapshots.clear();
    membersRequests = 0;
    memberName = null;
    FakeWebSocket.instances = [];
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
          const pending = pendingSnapshots.get(snapshot[1]!);
          if (pending) return pending;
          const body = snapshots.get(snapshot[1]!);
          return body ? Response.json(ChatSnapshotSchema.parse(body)) : Response.json({}, { status: 404 });
        }
        if (url.pathname === "/api/chat/conversations/Chat01/members") {
          membersRequests++;
          return Response.json({
            items: memberName
              ? [
                  {
                    accessId: "33333333-3333-4333-8333-333333333333",
                    principal: { type: "user", userId: "22222222-2222-4222-8222-222222222222" },
                    displayName: memberName,
                    guest: false,
                    deactivated: false,
                    groupSize: null,
                    permission: "write",
                    addedAt: now,
                  },
                ]
              : [],
            managers: 1,
            self: { accessId: "11111111-1111-4111-8111-111111111111", permission: "admin", active: true },
            nextCursor: null,
          });
        }
        if (url.pathname === "/api/chat/conversations/Chat01/leave" && init?.method === "POST") {
          leavePosts.push(JSON.parse(String(init.body)));
          return Response.json({ success: true, keptThroughGroup: false });
        }
        if (url.pathname === "/api/chat/conversations") return Response.json({ items: [], nextCursor: null });
        if (url.pathname === "/api/chat/conversations/Chat01/read" && init?.method === "POST") {
          const { seq } = JSON.parse(String(init.body));
          readPosts.push(seq);
          return Response.json({ lastReadSeq: seq, unreadFromSeq: null, joinedSeq: 0 });
        }
        if (url.pathname === "/api/chat/conversations/Chat01") return Response.json({ ...conversation, permission: "admin" });
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
    setSystemTime();
  });
  const mount = async (
    open: boolean,
    sidebar = [conversation],
    panel: "info" | null = null,
    locale = "en",
    permission: typeof conversation.permission = "write",
    initial: { url?: string; page?: NonNullable<ChatWorkspaceProps["open"]>["page"]; focus?: string | null; embedded?: boolean } = {},
  ) => {
    const { ChatWorkspace, LocaleProvider } = modules!;
    dom.window.history.replaceState(null, "", initial.url ?? (open ? `/app/chat/c/Chat01${panel ? "?panel=info" : ""}` : "/app/chat"));
    const props: ChatWorkspaceProps = {
      view: "all",
      threadsPage: false,
      embedded: initial.embedded,
      cursor: "c.0",
      sidebar: { items: sidebar, nextCursor: null },
      open: open
        ? {
            threads: noThreads,
            conversation: { ...conversation, permission },
            page: initial.page ?? { items: [], seqHead: 0, rev: 0, from: 1, to: 0 },
            focus: initial.focus ?? null,
          }
        : null,
      chatId: open ? conversation.id : null,
      guest: false,
      panel,
      viewerId,
      dateConfig: { timeZone: "UTC" },
      now,
    };
    dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(ChatWorkspace, props);
          },
        }),
      dom.root,
    );
    await settle();
  };
  const button = (label: string, root: ParentNode = dom.root) => {
    const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label,
    );
    if (!found) throw new Error(`Missing button ${label}`);
    return found;
  };
  const mountVisibleUnread = async (phoneWidth: boolean) => {
    const changes = new dom.window.EventTarget();
    const phone = {
      matches: phoneWidth,
      addEventListener: changes.addEventListener.bind(changes),
      removeEventListener: changes.removeEventListener.bind(changes),
    };
    Object.defineProperty(dom.window, "matchMedia", {
      value: (query: string) =>
        query === "(max-width: 47.999rem)" ? phone : { matches: false, addEventListener() {}, removeEventListener() {} },
    });
    Object.defineProperty(dom.document, "visibilityState", { configurable: true, value: "visible" });
    Object.defineProperty(dom.document, "hasFocus", { configurable: true, value: () => true });
    const unread = MessageViewSchema.parse({
      ...message(1),
      author: { type: "user", id: "22222222-2222-4222-8222-222222222222", name: "Alex" },
    });
    await mount(true, [conversation], "info", "en", "write", {
      page: { items: [unread], seqHead: 1, rev: 1, from: 1, to: 1 },
    });
    const feed = dom.root.querySelector<HTMLElement>(".k2b-virtual-feed__viewport")!;
    Object.defineProperty(feed, "clientHeight", { configurable: true, value: 600 });
    feed.dispatchEvent(new Event("scroll"));
    await settle();
    return () => {
      phone.matches = false;
      changes.dispatchEvent(new dom.window.Event("change"));
    };
  };
  for (const uncover of ["close", "resize"] as const) {
    test(`phone info pauses visible unread reporting until ${uncover}`, async () => {
      const resizeToDesktop = await mountVisibleUnread(true);
      expect(readPosts).toEqual([]);
      if (uncover === "close") {
        dom.root.querySelector<HTMLAnchorElement>('.chat-conversation__header a[aria-controls="k2b-workspace-detail-chat-info"]')!.click();
      } else resizeToDesktop();
      await settle();
      expect(readPosts).toEqual([1]);
      expect(consoleErrors).toEqual([]);
    });
  }
  test("desktop info keeps reporting visible unread messages", async () => {
    await mountVisibleUnread(false);
    expect(dom.root.querySelector("#k2b-workspace-detail-chat-info")?.hasAttribute("hidden")).toBe(false);
    expect(readPosts).toEqual([1]);
    expect(consoleErrors).toEqual([]);
  });
  test("invalid message bodies keep their text in the composer without entering the send queue", async () => {
    await mount(true);
    const field = dom.root.querySelector<HTMLTextAreaElement>('textarea:not([aria-hidden="true"])')!;
    const hint = () => dom.root.querySelector(".k2b-chat-composer__hint-text")?.textContent ?? "";
    for (const body of ["a".repeat(20_001), "😀".repeat(20_001), "hello\u0000world"]) {
      field.value = body;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      button("Send message").click();
      await settle();
      expect(field.value === body).toBe(true);
      expect(posted).toEqual([]);
      expect(dom.root.querySelector(".k2b-message-row")).toBeNull();
      expect(hint()).toBe(body.includes("\u0000") ? "Remove the unsupported character." : "Shorten to at most 20,000 characters.");
    }
    const valid = "😀".repeat(20_000);
    field.value = valid;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(hint()).toBe("");
    button("Send message").click();
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toBe(valid);
    expect(field.value).toBe("");
    answer(Response.json(message(1, valid), { status: 201 }));
    await settle();
    expect(consoleErrors).toEqual([]);
  });
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
          thread: null,
          replyTo: null,
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

  test("an exact unsent draft survives workspace removal and remount", async () => {
    await mount(true);
    const field = dom.root.querySelector<HTMLTextAreaElement>('textarea:not([aria-hidden="true"])')!;
    field.value = "  Keep this draft\nincluding whitespace  ";
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
    dispose();
    await mount(true);
    expect(dom.root.querySelector<HTMLTextAreaElement>('textarea:not([aria-hidden="true"])')!.value).toBe(
      "  Keep this draft\nincluding whitespace  ",
    );
    expect(posted).toHaveLength(0);
  });

  test("reopening the panel restores its own last conversation through the authorized snapshot loader", async () => {
    snapshots.set(
      conversation.id,
      ChatSnapshotSchema.parse({
        cursor: "c.0",
        conversation,
        page: { items: [], seqHead: 0, rev: 0, from: 1, to: 0 },
        threads: { general: { unread: 0, lastMessage: null }, items: [] },
        focus: null,
      }),
    );
    await mount(true, [conversation], null, "en", "write", {
      embedded: true,
      url: "/app/chat/panel/c/Chat01",
    });
    const field = dom.root.querySelector<HTMLTextAreaElement>('textarea:not([aria-hidden="true"])')!;
    field.value = "Return to this conversation";
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
    dispose();
    await mount(false, [conversation], null, "en", "write", { embedded: true, url: "/app/chat/panel" });
    expect(dom.window.location.pathname).toBe("/app/chat/panel/c/Chat01");
    expect(dom.root.querySelector<HTMLTextAreaElement>('textarea:not([aria-hidden="true"])')!.value).toBe("Return to this conversation");
    expect(posted).toHaveLength(0);
  });

  test("a failed initial storage read does not cache an empty draft; retry restores it", async () => {
    const storage = dom.window.sessionStorage;
    storage.setItem(`cloud.chat.draft:${viewerId}:Chat01`, "Saved before reopening");
    Object.defineProperty(dom.window, "sessionStorage", {
      configurable: true,
      get: () => {
        throw new Error("Storage unavailable");
      },
    });
    try {
      await mount(true);
      expect(dom.root.textContent).toContain(chatMessages.resolve(["en"]).t.draftNotSaved);
      Object.defineProperty(dom.window, "sessionStorage", { configurable: true, value: storage });
      button(chatMessages.resolve(["en"]).t.retry).click();
      await settle();
      expect(dom.root.querySelector<HTMLTextAreaElement>('textarea:not([aria-hidden="true"])')!.value).toBe("Saved before reopening");
      expect(posted).toHaveLength(0);
    } finally {
      Object.defineProperty(dom.window, "sessionStorage", { configurable: true, value: storage });
    }
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
      threads: noThreads,
      cursor: "c.109",
      conversation: other,
      page: { items: [{ ...message(109), conversationId: other.id }], seqHead: 109, rev: 109, from: 109, to: 109 },
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
    expect(dom.root.querySelector('.k2b-message-row[data-status="sent"] .k2b-message-row__text')?.textContent?.trim()).toBe("hi");
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat02"]')!.click();
    await settle();
    expect(dom.window.location.pathname).toBe("/app/chat/c/Chat02");
    // Another chat's loaded sequence must not prune this chat's uncovered send.
    snapshots.set(conversation.id, {
      threads: noThreads,
      cursor: "c.0",
      conversation,
      page: { items: [], seqHead: 0, rev: 0, from: 1, to: 0 },
      focus: null,
    });
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat01"]')!.click();
    await settle();
    expect(dom.root.querySelector('.k2b-message-row[data-status="sent"] .k2b-message-row__text')?.textContent?.trim()).toBe("hi");
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat02"]')!.click();
    await settle();
    snapshots.set(conversation.id, {
      threads: noThreads,
      cursor: "c.109",
      conversation: { ...conversation, rev: 109 },
      page: { items: Array.from({ length: 50 }, (_, index) => message(index + 60)), seqHead: 109, rev: 109, from: 60, to: 109 },
      focus: null,
    });
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat01"]')!.click();
    await settle();
    expect(dom.window.location.pathname).toBe("/app/chat/c/Chat01");
    const rows = [...dom.root.querySelectorAll(".k2b-message-row")];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.querySelector(".k2b-message-row__text")?.textContent?.trim() === "hi")).toBe(false);
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
  test("leaving warns while a message is unsent and stops warning after delivery", async () => {
    await mount(true);
    const field = dom.root.querySelector<HTMLTextAreaElement>('textarea:not([aria-hidden="true"])')!;
    field.value = "Please wait";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    button("Send message").click();
    await settle();
    expect(posted).toHaveLength(1);
    const pendingLeave = new dom.window.Event("beforeunload", { cancelable: true });
    dom.window.dispatchEvent(pendingLeave);
    expect(pendingLeave.defaultPrevented).toBe(true);
    answer(Response.json(message(1, "Please wait"), { status: 201 }));
    await settle();
    const sentLeave = new dom.window.Event("beforeunload", { cancelable: true });
    dom.window.dispatchEvent(sentLeave);
    expect(sentLeave.defaultPrevented).toBe(false);
  });
  test("SSR info state survives mounting and popstate clears and restores it without reloading the chat", async () => {
    await mount(true, [conversation], "info");
    expect(dom.root.querySelector("#k2b-workspace-detail-chat-info")?.hasAttribute("hidden")).toBe(false);
    expect(
      dom.root.querySelector('.chat-conversation__header a[aria-controls="k2b-workspace-detail-chat-info"]')?.getAttribute("aria-expanded"),
    ).toBe("true");
    dom.window.history.pushState(null, "", "/app/chat/c/Chat01");
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await settle();
    expect(dom.root.querySelector("#k2b-workspace-detail-chat-info")?.hasAttribute("hidden")).toBe(true);
    dom.window.history.pushState(null, "", "/app/chat/c/Chat01?panel=info");
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await settle();
    expect(dom.root.querySelector("#k2b-workspace-detail-chat-info")?.hasAttribute("hidden")).toBe(false);
    expect(
      dom.root.querySelector('.chat-conversation__header a[aria-controls="k2b-workspace-detail-chat-info"]')?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(consoleErrors).toEqual([]);
  });
  for (const initialPanel of [null, "info"] as const) {
    test(`info link keeps ${initialPanel ?? "the closed panel"} unchanged while another chat opens`, async () => {
      const other = { ...conversation, id: "Chat02", title: "Other chat" };
      const pending = Promise.withResolvers<Response>();
      pendingSnapshots.set(other.id, pending.promise);
      await mount(true, [conversation, other], initialPanel);
      const url = dom.window.location.href;
      const historyLength = dom.window.history.length;
      dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat02"]')!.click();
      await settle();
      expect(dom.root.querySelector(".k2b-app-workspace__main")?.getAttribute("aria-busy")).toBe("true");
      expect(dom.root.querySelector(".chat-conversation__header")?.textContent).toContain(conversation.title);
      dom.root.querySelector<HTMLAnchorElement>('.chat-conversation__header a[aria-controls="k2b-workspace-detail-chat-info"]')!.click();
      await settle();
      try {
        expect(dom.window.location.href).toBe(url);
        expect(dom.window.history.length).toBe(historyLength);
        expect(dom.root.querySelector("#k2b-workspace-detail-chat-info")?.hasAttribute("hidden")).toBe(initialPanel === null);
      } finally {
        pending.resolve(
          Response.json({
            threads: noThreads,
            cursor: "c.0",
            conversation: other,
            page: { items: [], seqHead: 0, rev: 0, from: 1, to: 0 },
            focus: null,
          }),
        );
        await settle();
      }
      expect(dom.window.location.pathname + dom.window.location.search).toBe("/app/chat/c/Chat02");
      expect(dom.root.querySelector("#k2b-workspace-detail-chat-info")?.hasAttribute("hidden")).toBe(true);
      expect(dom.window.history.length).toBe(historyLength + 1);
      expect(consoleErrors).toEqual([]);
    });
  }
  test("returning to info supersedes a pending open of another chat", async () => {
    const other = { ...conversation, id: "Chat02", title: "Other chat" };
    const pending = Promise.withResolvers<Response>();
    pendingSnapshots.set(other.id, pending.promise);
    snapshots.set(conversation.id, {
      threads: noThreads,
      cursor: "c.0",
      conversation,
      page: { items: [], seqHead: 0, rev: 0, from: 1, to: 0 },
      focus: null,
    });
    await mount(true, [conversation, other], "info");
    // A panel-only return must differ from the route still showing while the next chat loads.
    dom.root.querySelector<HTMLAnchorElement>('.chat-conversation__header a[aria-controls="k2b-workspace-detail-chat-info"]')!.click();
    await settle();
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat02"]')!.click();
    await settle();
    expect(dom.root.querySelector(".k2b-app-workspace__main")?.getAttribute("aria-busy")).toBe("true");
    dom.window.history.pushState(null, "", "/app/chat/c/Chat01?panel=info");
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await settle();
    pending.resolve(
      Response.json({
        threads: noThreads,
        cursor: "c.0",
        conversation: other,
        page: { items: [], seqHead: 0, rev: 0, from: 1, to: 0 },
        focus: null,
      }),
    );
    await settle();
    expect(dom.root.querySelector(".chat-conversation__header")?.textContent).toContain("Secret board");
    expect(dom.window.location.pathname).toBe("/app/chat/c/Chat01");
    expect(dom.root.querySelector("#k2b-workspace-detail-chat-info")?.hasAttribute("hidden")).toBe(false);
    expect(consoleErrors).toEqual([]);
  });
  test("a superseded open does not clear busy while the next open is pending", async () => {
    const second = { ...conversation, id: "Chat02", title: "Second chat" };
    const third = { ...conversation, id: "Chat03", title: "Third chat" };
    const pendingSecond = Promise.withResolvers<Response>();
    const pendingThird = Promise.withResolvers<Response>();
    pendingSnapshots.set(second.id, pendingSecond.promise);
    pendingSnapshots.set(third.id, pendingThird.promise);
    await mount(true, [conversation, second, third]);
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat02"]')!.click();
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat03"]')!.click();
    pendingSecond.resolve(
      Response.json({
        threads: noThreads,
        cursor: "c.0",
        conversation: second,
        page: { items: [], seqHead: 0, rev: 0, from: 1, to: 0 },
        focus: null,
      }),
    );
    await settle();
    expect(dom.root.querySelector(".k2b-app-workspace__main")?.getAttribute("aria-busy")).toBe("true");
    pendingThird.resolve(
      Response.json({
        threads: noThreads,
        cursor: "c.0",
        conversation: third,
        page: { items: [], seqHead: 0, rev: 0, from: 1, to: 0 },
        focus: null,
      }),
    );
    await settle();
    expect(dom.root.querySelector(".k2b-app-workspace__main")?.getAttribute("aria-busy")).toBe("false");
    expect(dom.window.location.pathname).toBe("/app/chat/c/Chat03");
    expect(consoleErrors).toEqual([]);
  });
  test("a newer open that finishes first ends busy and leaves info usable while the superseded one is pending", async () => {
    const second = { ...conversation, id: "Chat02", title: "Second chat" };
    const third = { ...conversation, id: "Chat03", title: "Third chat" };
    const pendingSecond = Promise.withResolvers<Response>();
    const pendingThird = Promise.withResolvers<Response>();
    pendingSnapshots.set(second.id, pendingSecond.promise);
    pendingSnapshots.set(third.id, pendingThird.promise);
    await mount(true, [conversation, second, third]);
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat02"]')!.click();
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat03"]')!.click();
    pendingThird.resolve(
      Response.json({
        threads: noThreads,
        cursor: "c.0",
        conversation: third,
        page: { items: [], seqHead: 0, rev: 0, from: 1, to: 0 },
        focus: null,
      }),
    );
    await settle();
    try {
      expect(dom.window.location.pathname).toBe("/app/chat/c/Chat03");
      expect(dom.root.querySelector(".k2b-app-workspace__main")?.getAttribute("aria-busy")).toBe("false");
      dom.root.querySelector<HTMLAnchorElement>('.chat-conversation__header a[aria-controls="k2b-workspace-detail-chat-info"]')!.click();
      await settle();
      expect(dom.window.location.pathname + dom.window.location.search).toBe("/app/chat/c/Chat03?panel=info");
      expect(dom.root.querySelector("#k2b-workspace-detail-chat-info")?.hasAttribute("hidden")).toBe(false);
    } finally {
      pendingSecond.resolve(
        Response.json({
          threads: noThreads,
          cursor: "c.0",
          conversation: second,
          page: { items: [], seqHead: 0, rev: 0, from: 1, to: 0 },
          focus: null,
        }),
      );
      await settle();
    }
    expect(dom.window.location.pathname + dom.window.location.search).toBe("/app/chat/c/Chat03?panel=info");
    expect(dom.root.querySelector(".k2b-app-workspace__main")?.getAttribute("aria-busy")).toBe("false");
    expect(consoleErrors).toEqual([]);
  });
  for (const historical of [false, true]) {
    test(`info reflects live membership changes by every author${historical ? " outside the displayed history" : ""}`, async () => {
      const otherId = "22222222-2222-4222-8222-222222222222";
      const membership = (seq: number, authorId: string) =>
        MessageViewSchema.parse({
          ...message(seq),
          kind: "system",
          author: { type: "user", id: authorId, name: "Member" },
          body: null,
          system: { code: "member_left", params: {} },
          systemText: "Member left the chat.",
        });
      memberName = "Initial member";
      const seqHead = historical ? 10 : 1;
      await mount(true, [conversation], "info", "en", "admin", {
        page: { items: [membership(1, otherId)], seqHead, rev: seqHead, from: 1, to: 1 },
      });
      // The initial history belongs to the snapshot and does not trigger another member read.
      expect(membersRequests).toBe(1);
      expect(dom.root.querySelector(".chat-member-row__name")?.textContent).toBe("Initial member");
      const socket = FakeWebSocket.instances[0]!;
      socket.open();
      expect(socket.conversationSubscription).toBeDefined();
      memberName = "Changed by someone else";
      socket.message({
        t: "event",
        id: socket.conversationSubscription,
        cursor: "c.2",
        data: { type: "message", message: membership(seqHead + 1, otherId) },
      });
      await settle();
      expect(dom.root.querySelectorAll(".k2b-message-system-row")).toHaveLength(historical ? 1 : 2);
      expect(membersRequests).toBe(2);
      expect(dom.root.querySelector(".chat-member-row__name")?.textContent).toBe("Changed by someone else");
      memberName = "Changed by the viewer elsewhere";
      socket.message({
        t: "event",
        id: socket.conversationSubscription,
        cursor: "c.3",
        data: { type: "message", message: membership(seqHead + 2, viewerId) },
      });
      await settle();
      expect(dom.root.querySelectorAll(".k2b-message-system-row")).toHaveLength(historical ? 1 : 3);
      expect(membersRequests).toBe(3);
      expect(dom.root.querySelector(".chat-member-row__name")?.textContent).toBe("Changed by the viewer elsewhere");
      expect(consoleErrors).toEqual([]);
    });
  }
  test("the way up from info returns to the list in one action", async () => {
    snapshots.set(conversation.id, {
      threads: noThreads,
      cursor: "c.0",
      conversation,
      page: { items: [], seqHead: 0, rev: 0, from: 1, to: 0 },
      focus: null,
    });
    await mount(false);
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat01"]')!.click();
    await settle();
    expect(dom.window.history.state).toEqual({ chatFromList: true });
    dom.root.querySelector<HTMLAnchorElement>('.chat-conversation__header a[aria-controls="k2b-workspace-detail-chat-info"]')!.click();
    await settle();
    expect(dom.window.location.search).toBe("?panel=info");
    const up = new dom.window.CustomEvent("cloud:page-up", { detail: { href: "/app/chat" }, cancelable: true });
    dom.window.dispatchEvent(up);
    await settle();
    expect(up.defaultPrevented).toBe(true);
    expect(dom.window.location.pathname).toBe("/app/chat");
    expect(dom.root.querySelector(".chat-conversation__header")).toBeNull();
    expect(consoleErrors).toEqual([]);
  });
  test("leaving info opened from the chat keeps one Back action to the list", async () => {
    const t = chatMessages.resolve(["en"]).t;
    snapshots.set(conversation.id, {
      threads: noThreads,
      cursor: "c.0",
      conversation,
      page: { items: [], seqHead: 0, rev: 0, from: 1, to: 0 },
      focus: null,
    });
    await mount(false);
    const listLength = dom.window.history.length;
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat01"]')!.click();
    await settle();
    expect(dom.window.history.length).toBe(listLength + 1);
    dom.root.querySelector<HTMLAnchorElement>('.chat-conversation__header a[aria-controls="k2b-workspace-detail-chat-info"]')!.click();
    await settle();
    expect(dom.window.location.search).toBe("?panel=info");
    expect(dom.window.history.length).toBe(listLength + 2);
    button(t.leaveChat).click();
    await settle();
    const dialog = dom.document.querySelector('[role="dialog"], dialog')!;
    expect(dialog).not.toBeNull();
    expect(button(t.leaveChat, dialog).disabled).toBe(false);
    button(t.leaveChat, dialog).click();
    await settle();
    expect(leavePosts).toEqual([{}]);
    expect(dom.window.history.length).toBe(listLength + 2);
    expect(dom.window.location.pathname + dom.window.location.search).toBe("/app/chat/c/Chat01");
    dom.window.history.back();
    await settle();
    expect(dom.window.location.pathname + dom.window.location.search).toBe("/app/chat");
    expect(dom.root.querySelector(".chat-conversation__header")).toBeNull();
    expect(consoleErrors).toEqual([]);
  });
  test("leaving directly mounted info replaces its history entry", async () => {
    const t = chatMessages.resolve(["en"]).t;
    await mount(true, [conversation], "info");
    const infoLength = dom.window.history.length;
    expect(dom.window.history.state).toBeNull();
    expect(dom.window.location.search).toBe("?panel=info");
    button(t.leaveChat).click();
    await settle();
    const dialog = dom.document.querySelector('[role="dialog"], dialog')!;
    expect(dialog).not.toBeNull();
    expect(button(t.leaveChat, dialog).disabled).toBe(false);
    button(t.leaveChat, dialog).click();
    await settle();
    expect(leavePosts).toEqual([{}]);
    expect(dom.window.history.length).toBe(infoLength);
    expect(dom.window.location.pathname + dom.window.location.search).toBe("/app/chat/c/Chat01");
    expect(dom.root.querySelector("#k2b-workspace-detail-chat-info")?.hasAttribute("hidden")).toBe(true);
    expect(consoleErrors).toEqual([]);
  });
  for (const initialPanel of [null, "info"] as const) {
    test(`info preserves the linked message window when opened from ${initialPanel ?? "the chat"}`, async () => {
      const linked = message(1, "Linked message");
      const path = `/app/chat/c/Chat01/m/${linked.id}`;
      await mount(true, [conversation], initialPanel, "en", "write", {
        url: `${path}${initialPanel ? "?panel=info" : ""}`,
        page: { items: [linked], seqHead: 1, rev: 1, from: 1, to: 1 },
        focus: linked.id,
      });
      const infoLink = () =>
        dom.root.querySelector<HTMLAnchorElement>('.chat-conversation__header a[aria-controls="k2b-workspace-detail-chat-info"]')!;
      if (initialPanel === null) {
        expect(infoLink().getAttribute("href")).toBe(`${path}?panel=info`);
        infoLink().click();
        await settle();
      }
      expect(dom.window.location.pathname + dom.window.location.search).toBe(`${path}?panel=info`);
      expect(infoLink().getAttribute("href")).toBe(path);
      infoLink().click();
      await settle();
      expect(dom.window.location.pathname + dom.window.location.search).toBe(path);
      expect(dom.root.querySelector(".k2b-message-row")?.textContent).toContain("Linked message");
      expect(dom.root.querySelector("#k2b-workspace-detail-chat-info")?.hasAttribute("hidden")).toBe(true);
      expect(consoleErrors).toEqual([]);
    });
  }
  for (const locale of ["en", "de"]) {
    const t = chatMessages.resolve([locale]).t;
    for (const permission of ["admin", "write", "read"] as const) {
      test(`the open chat header offers Add people only to admin: ${permission} in ${locale}`, async () => {
        await mount(true, [conversation], null, locale, permission);
        const header = dom.root.querySelector(".chat-conversation__header");
        expect(header).not.toBeNull();
        expect(header?.querySelector(`button[aria-label="${t.addPeople}"]`) !== null).toBe(permission === "admin");
        // The companion info action proves the feature header mounted for every permission.
        expect(header?.querySelector(`a[aria-label="${t.chatInfo}"]`)).not.toBeNull();
        expect(consoleErrors).toEqual([]);
      });
    }
  }
  // happy-dom has no viewport layout; the 120-message deep link is verified in the browser suite.
});
