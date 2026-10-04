import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";
import type { DraftEditableContent, MailDraft, MailDraftSeed } from "../../contracts";

const MAILBOX_ID = "Box001";
const DRAFT_ID = "Drf001";
const now = "2026-10-04T10:00:00.000Z";

const content = (body: string, to: string): DraftEditableContent => ({
  senderIdentityId: "Idn001",
  to: [{ name: null, address: to }],
  cc: [],
  bcc: [],
  subject: "Offer",
  body,
  format: "markdown",
  priority: "normal",
  requestDeliveryReceipt: false,
  requestReadReceipt: false,
});

const seed: MailDraftSeed = {
  id: "10000000-0000-4000-8000-000000000001",
  mailboxId: MAILBOX_ID,
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  content: content("", "first@example.test"),
  attachments: [],
  initialSignatureSource: null,
  origin: {
    kind: "compose",
    input: {
      senderIdentityId: "Idn001",
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      body: "",
      intent: "new",
      conversationId: null,
      sourceMessageId: null,
      includeSourceAttachments: false,
    },
  },
  createdAt: now,
};

const draft = (revision: number, editable: DraftEditableContent): MailDraft => ({
  id: DRAFT_ID,
  mailboxId: MAILBOX_ID,
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  ...editable,
  attachments: [],
  createdBy: { kind: "user", userId: "Usr001" },
  lastEditedBy: { kind: "user", userId: "Usr001" },
  lastEditedByDisplayName: "Ada Example",
  recoveryCopyCount: 0,
  revision,
  state: "draft",
  deliveryClass: "normal",
  createdAt: now,
  updatedAt: now,
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: Array<{ t: string; id?: string; channel?: string; scope?: unknown; after?: string }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  message(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

const lease = { holder: { kind: "user", id: "Usr001", displayName: "Ada Example", avatarHash: null }, acquiredAt: now, expiresAt: now };

describe("Mail draft session", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let dom: DomTestHarness;
  let requests: Array<{ method: string; url: string; body: unknown }>;
  let dispose = () => {};

  beforeEach(() => {
    dom = createDomTestHarness();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
    requests = [];
    Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => "visible" });
    FakeWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    dispose();
    globalThis.fetch = originalFetch;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
    dom.cleanup();
  });

  const respondWith = (handler: (method: string, url: string, body: unknown) => Response) => {
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        const url = new URL(request.url).pathname;
        const text = await request.text();
        const body = text ? JSON.parse(text) : null;
        requests.push({ method: request.method, url, body });
        return handler(request.method, url, body);
      },
      { preconnect: originalFetch.preconnect },
    );
  };

  test("a send after a lost save response stores the current recipients and text before it uses the draft", async () => {
    // The first save reached the server, but its response was lost, so the browser still has no draft.
    const stored = draft(1, content("First meaningful edit", "first@example.test"));
    respondWith((method, url, body) => {
      if (url.endsWith("/draft-seeds/materialize")) return Response.json(stored);
      if (url.endsWith(`/drafts/${DRAFT_ID}/lease`) && method === "POST") return Response.json({ ...lease, token: crypto.randomUUID() });
      if (url.endsWith(`/drafts/${DRAFT_ID}`) && method === "PUT") {
        const next = body as { expectedRevision: number; draft: DraftEditableContent };
        return Response.json(draft(next.expectedRevision + 1, next.draft));
      }
      return Response.json({ code: "NOT_FOUND", message: `Unexpected ${method} ${url}` }, { status: 404 });
    });
    const { createMailDraftSession } = await import("./mail-draft-session");
    const [current, setCurrent] = createSignal(content("First meaningful edit", "first@example.test"));
    const session = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createMailDraftSession({
        mailboxId: MAILBOX_ID,
        initialSeed: seed,
        hasVerifiedIdentity: () => true,
        content: current,
        applyDraftContent: setCurrent,
        isDisposed: () => false,
        onRecovered: () => undefined,
        onMaterialized: () => undefined,
        locale: () => "en",
      });
    });

    // Before the next autosave, the user changes the recipient and the text, then selects Send.
    setCurrent(content("Final text", "second@example.test"));
    const saved = await session.persist();

    expect(saved?.revision).toBe(2);
    expect(saved?.body).toBe("Final text");
    expect(saved?.to).toEqual([{ name: null, address: "second@example.test" }]);
    expect(requests.find((request) => request.method === "PUT")?.body).toEqual({
      expectedRevision: 1,
      draft: content("Final text", "second@example.test"),
    });
  });

  test("a change of the draft's conversation or of its mailbox checks the draft and its lease, other conversations do not", async () => {
    const reply = { ...draft(3, content("Reply", "first@example.test")), conversationId: "Conv01", intent: "reply" as const };
    respondWith((method, url) => {
      if (url.endsWith(`/drafts/${DRAFT_ID}/lease`) && method === "POST") return Response.json({ ...lease, token: crypto.randomUUID() });
      if (url.endsWith(`/drafts/${DRAFT_ID}/lease`) && method === "PUT") return Response.json({ ...lease, token: crypto.randomUUID() });
      if (url.endsWith(`/drafts/${DRAFT_ID}`) && method === "GET") return Response.json(reply);
      return Response.json({ code: "NOT_FOUND", message: `Unexpected ${method} ${url}` }, { status: 404 });
    });
    const { createMailDraftSession } = await import("./mail-draft-session");
    const [current, setCurrent] = createSignal(content("Reply", "first@example.test"));
    createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createMailDraftSession({
        mailboxId: MAILBOX_ID,
        initialDraft: reply,
        hasVerifiedIdentity: () => true,
        content: current,
        applyDraftContent: setCurrent,
        isDisposed: () => false,
        onRecovered: () => undefined,
        onMaterialized: () => undefined,
        locale: () => "en",
      });
    });
    await Bun.sleep(20);
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    expect(socket.url).toBe("ws://localhost/api/mail/live");
    expect(socket.sent).toEqual([{ t: "sub", id: "1", channel: "mailbox", scope: { mailbox: MAILBOX_ID } }]);
    socket.message({ t: "ready", id: "1", cursor: "s6t.mail.4" });

    const checks = () => requests.filter((request) => request.method === "GET" && request.url.endsWith(`/drafts/${DRAFT_ID}`)).length;
    const heartbeats = () => requests.filter((request) => request.method === "PUT" && request.url.endsWith("/lease")).length;
    await Bun.sleep(20);
    expect({ checks: checks(), heartbeats: heartbeats() }).toEqual({ checks: 0, heartbeats: 0 });

    socket.message({ t: "event", id: "1", cursor: "s6t.mail.5", data: { conversationId: "Conv02" } });
    await Bun.sleep(20);
    expect({ checks: checks(), heartbeats: heartbeats() }).toEqual({ checks: 0, heartbeats: 0 });

    socket.message({ t: "event", id: "1", cursor: "s6t.mail.6", data: { conversationId: "Conv01" } });
    await Bun.sleep(20);
    expect({ checks: checks(), heartbeats: heartbeats() }).toEqual({ checks: 1, heartbeats: 1 });

    socket.message({ t: "event", id: "1", cursor: "s6t.mail.7", data: { conversationId: null } });
    await Bun.sleep(20);
    expect({ checks: checks(), heartbeats: heartbeats() }).toEqual({ checks: 2, heartbeats: 2 });
  });

  test("a composer that lost its connection becomes editable again once Mail answers, without a live update", async () => {
    let reachable = true;
    respondWith((method, url) => {
      if (url.endsWith(`/drafts/${DRAFT_ID}/lease`) && method === "POST") return Response.json({ ...lease, token: crypto.randomUUID() });
      if (url.endsWith(`/drafts/${DRAFT_ID}/lease`) && method === "PUT") {
        if (!reachable) throw new TypeError("Failed to fetch");
        return Response.json({ ...lease, token: crypto.randomUUID() });
      }
      return Response.json({ code: "NOT_FOUND", message: `Unexpected ${method} ${url}` }, { status: 404 });
    });
    // Lease timers run a thousand times faster: the 10-second heartbeat takes 10 milliseconds.
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((run: () => void, delay = 0) => originalSetTimeout(run, delay / 1_000)) as typeof setTimeout;
    try {
      const { createMailDraftSession } = await import("./mail-draft-session");
      const [current, setCurrent] = createSignal(content("Offer text", "first@example.test"));
      const session = createRoot((disposeRoot) => {
        dispose = disposeRoot;
        return createMailDraftSession({
          mailboxId: MAILBOX_ID,
          initialDraft: draft(3, content("Offer text", "first@example.test")),
          hasVerifiedIdentity: () => true,
          content: current,
          applyDraftContent: setCurrent,
          isDisposed: () => false,
          onRecovered: () => undefined,
          onMaterialized: () => undefined,
          locale: () => "en",
        });
      });
      const until = async (condition: () => boolean) => {
        for (let waited = 0; !condition() && waited < 2_000; waited += 5) await Bun.sleep(5);
        expect(condition()).toBe(true);
      };
      await until(() => session.status() === "saved");

      reachable = false;
      await until(() => session.status() === "readonly");
      expect(session.statusMessage()).toBe("Connection lost. Retry to resume editing.");

      reachable = true;
      await until(() => session.status() === "saved");
      expect(session.statusMessage()).toBe("");
      expect(session.lease()).not.toBeNull();
      // No live socket ever opened: the lease recovered on its own.
      expect(FakeWebSocket.instances.flatMap((socket) => socket.sent)).toEqual([]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
