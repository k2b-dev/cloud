import { afterEach, beforeEach, describe, expect, jest, setSystemTime, spyOn, test } from "bun:test";
import { setImmediate } from "node:timers";
import { createRenderEffect, createRoot, createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";
import type { DraftEditableContent, DraftLease, MailDraft, MailDraftSeed } from "../../contracts";

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
  signatureTemplateId: editable.signatureTemplateId ?? null,
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

const lease: DraftLease = {
  holder: { kind: "user", id: "Usr001", displayName: "Ada Example", avatarHash: null },
  acquiredAt: now,
  expiresAt: "2026-10-04T10:00:30.000Z",
};

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

  const respondWith = (handler: (method: string, url: string, body: unknown) => Response | Promise<Response>) => {
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
        currentActor: { kind: "user", id: "Usr001" },
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
        currentActor: { kind: "user", id: "Usr001" },
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
          currentActor: { kind: "user", id: "Usr001" },
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
  describe("own write treated as foreign", () => {
    const flush = async () => {
      for (let i = 0; i < 60; i++) await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const advance = async (ms: number) => {
      jest.advanceTimersByTime(ms);
      await flush();
    };
    let restoreRandom = () => {};
    beforeEach(() => {
      const random = spyOn(Math, "random").mockReturnValue(0.5);
      restoreRandom = () => random.mockRestore();
      jest.useFakeTimers();
      setSystemTime(Date.parse(now));
    });
    afterEach(() => {
      restoreRandom();
      jest.useRealTimers();
    });

    const mountSession = async (initial = { ...draft(3, content("Local text", "ada@example.test")), conversationId: "Conv01" }) => {
      const { createMailDraftSession } = await import("./mail-draft-session");
      const [current, setCurrent] = createSignal<DraftEditableContent>({
        ...content(initial.body, initial.to[0]!.address),
        signatureTemplateId: initial.signatureTemplateId,
      });
      const trace: Array<{ status: string; message: string; conflict: unknown }> = [];
      const session = createRoot((disposeRoot) => {
        dispose = disposeRoot;
        const session = createMailDraftSession({
          mailboxId: MAILBOX_ID,
          currentActor: { kind: "user", id: "Usr001" },
          initialDraft: initial,
          hasVerifiedIdentity: () => true,
          content: current,
          applyDraftContent: setCurrent,
          isDisposed: () => false,
          onRecovered: () => undefined,
          onMaterialized: () => undefined,
          locale: () => "en",
        });
        createRenderEffect(() =>
          trace.push({ status: session.status(), message: session.statusMessage(), conflict: session.leaseConflict() }),
        );
        return session;
      });
      await flush();
      return { session, current, setCurrent, trace };
    };
    let heartbeatAnswers: Response[];
    let acquireAnswer: ((body: unknown) => Response | Promise<Response>) | undefined;
    let saveAnswer: ((body: { expectedRevision: number; draft: DraftEditableContent }) => Response | Promise<Response>) | undefined;
    let stored: MailDraft;
    let heldLease: typeof lease | null;
    beforeEach(() => {
      heartbeatAnswers = [];
      acquireAnswer = undefined;
      saveAnswer = undefined;
      stored = { ...draft(3, content("Local text", "ada@example.test")), conversationId: "Conv01" };
      heldLease = lease;
      respondWith((method, url, body) => {
        if (url.endsWith("/lease")) {
          if (method === "POST") return acquireAnswer?.(body) ?? Response.json({ ...lease, token: "local-token" });
          if (method === "GET") return Response.json(heldLease);
          if (method === "PUT") return heartbeatAnswers.shift() ?? Response.json({ ...lease, token: "local-token" });
          return Response.json({ ok: true });
        }
        if (method === "GET") return Response.json(stored);
        if (method === "PUT") {
          const input = body as { expectedRevision: number; draft: DraftEditableContent };
          if (saveAnswer) return saveAnswer(input);
          stored = { ...stored, ...input.draft, revision: input.expectedRevision + 1 };
          return Response.json(stored);
        }
        throw new Error(`Unexpected ${method} ${url}`);
      });
    });
    const healthy = ({ session, trace }: Awaited<ReturnType<typeof mountSession>>) => {
      expect(session.status()).toBe("saved");
      expect(session.lease()).not.toBeNull();
      expect(session.leaseConflict()).toBeNull();
      expect(trace.every((entry) => entry.conflict === null)).toBe(true);
      expect(trace.map((entry) => entry.message).join("\n")).not.toMatch(/elsewhere|another tab|another session|an anderer Stelle/);
    };
    const editableThroughout = (trace: Array<{ status: string }>) => {
      expect(trace.map((entry) => entry.status)).not.toContain("preparing");
      expect(trace.map((entry) => entry.status)).not.toContain("readonly");
    };

    test("own lease expired while the tab was hidden silently acquires again", async () => {
      const state = await mountSession();
      state.trace.length = 0;
      heartbeatAnswers.push(Response.json({ code: "DRAFT_LEASE_NOT_OWNED" }, { status: 409 }));
      await advance(10_000);
      healthy(state);
      editableThroughout(state.trace);
      expect(requests.filter((r) => r.method === "POST" && r.url.endsWith("/lease"))).toHaveLength(2);
    });

    test("a live echo during a silent re-acquire waits for it instead of orphaning the granted lease", async () => {
      const state = await mountSession();
      state.trace.length = 0;
      // The fake server grants each acquire; a granted lease whose token never reached the tab still blocks the next.
      let serverToken: string | null = null;
      let grant: (() => void) | undefined;
      acquireAnswer = () => {
        if (serverToken) return Response.json({ code: "DRAFT_LEASE_HELD" }, { status: 409 });
        serverToken = "regained-token";
        return new Promise<Response>((resolve) => {
          grant = () => resolve(Response.json({ ...lease, token: "regained-token" }));
        });
      };
      heartbeatAnswers.push(Response.json({ code: "DRAFT_LEASE_NOT_OWNED" }, { status: 409 }));
      const socket = FakeWebSocket.instances.at(-1)!;
      socket.open();
      socket.message({ t: "ready", id: "1", cursor: "s6t.mail.4" });
      await advance(10_000);
      expect(grant).toBeDefined();
      socket.message({ t: "event", id: "1", cursor: "s6t.mail.5", data: { conversationId: "Conv01" } });
      await flush();
      grant?.();
      await flush();
      healthy(state);
      editableThroughout(state.trace);
      expect(state.session.lease()?.token).toBe("regained-token");
      expect(requests.filter((r) => r.method === "POST" && r.url.endsWith("/lease"))).toHaveLength(2);
    });

    test("a re-acquire whose granted answer was lost gets its own lease back on retry", async () => {
      const state = await mountSession();
      state.trace.length = 0;
      // The fake server keeps the editor id of the lease it granted, like the lease service.
      const grants: Array<{ editorId: unknown; token: string }> = [];
      acquireAnswer = (body) => {
        const editorId = (body as { editorId?: unknown } | null)?.editorId;
        const granted = grants[0];
        if (granted) {
          return granted.editorId === editorId
            ? Response.json({ ...lease, token: granted.token })
            : Response.json({ code: "DRAFT_LEASE_HELD" }, { status: 409 });
        }
        grants.push({ editorId, token: "granted-token" });
        throw new TypeError("Failed to fetch");
      };
      heartbeatAnswers.push(Response.json({ code: "DRAFT_LEASE_NOT_OWNED" }, { status: 409 }));
      await advance(10_000);
      await advance(2_000);
      healthy(state);
      expect(state.session.lease()?.token).toBe("granted-token");
      expect(typeof grants[0]?.editorId).toBe("string");
    });

    test.each([
      ["busy lease state", 409, "DRAFT_LEASE_BUSY"],
      ["temporary server failure", 503, "INTERNAL"],
    ])("heartbeat retries %s without a lease dialog", async (_name, status, code) => {
      const state = await mountSession();
      state.trace.length = 0;
      heartbeatAnswers.push(Response.json({ code }, { status }));
      await advance(10_000);
      await advance(2_000);
      healthy(state);
      editableThroughout(state.trace);
      expect(requests.filter((r) => r.method === "PUT" && r.url.endsWith("/lease"))).toHaveLength(2);
    });

    test("reload waits for the predecessor's keepalive release", async () => {
      let released = false;
      acquireAnswer = () =>
        released ? Response.json({ ...lease, token: "new-token" }) : Response.json({ code: "DRAFT_LEASE_HELD" }, { status: 409 });
      setTimeout(() => {
        released = true;
        heldLease = null;
      }, 300);
      const state = await mountSession();
      expect(state.session.status()).toBe("preparing");
      const socket = FakeWebSocket.instances.at(-1)!;
      socket.open();
      socket.message({ t: "ready", id: "1", cursor: "s6t.mail.4" });
      socket.message({ t: "event", id: "1", cursor: "s6t.mail.5", data: { conversationId: null } });
      await flush();
      await advance(250);
      await advance(500);
      healthy(state);
      expect(state.trace.map((entry) => entry.status)).not.toContain("readonly");
      expect(requests.filter((r) => r.method === "POST")).toHaveLength(3);
    });

    test("live echo of an own save stays quiet for mailbox and conversation events, including a pending save", async () => {
      const state = await mountSession();
      state.setCurrent({ ...state.current(), body: "Own saved text" });
      await state.session.persist();
      state.trace.length = 0;
      const socket = FakeWebSocket.instances.at(-1)!;
      socket.open();
      socket.message({ t: "ready", id: "1", cursor: "s6t.mail.4" });
      for (const [cursor, conversationId] of [
        ["s6t.mail.5", null],
        ["s6t.mail.6", "Conv01"],
      ] as const) {
        socket.message({ t: "event", id: "1", cursor, data: { conversationId } });
        await flush();
      }
      healthy(state);
      editableThroughout(state.trace);
      let completeSave: ((response: Response) => void) | undefined;
      saveAnswer = () =>
        new Promise<Response>((resolve) => {
          completeSave = resolve;
        });
      state.setCurrent({ ...state.current(), body: "Still typing" });
      const saving = state.session.persist();
      await flush();
      expect(state.session.status()).toBe("saving");
      socket.message({ t: "event", id: "1", cursor: "s6t.mail.7", data: { conversationId: null } });
      await flush();
      expect(state.session.status()).toBe("saving");
      completeSave?.(Response.json({ ...stored, ...state.current(), revision: 5 }));
      await saving;
      healthy(state);
      editableThroughout(state.trace);
    });

    test("silent re-acquire preserves the old expectedRevision and local text for recovery-copy handling", async () => {
      const state = await mountSession();
      state.trace.length = 0;
      stored = { ...stored, body: "Foreign revision", revision: 8 };
      heartbeatAnswers.push(Response.json({ code: "DRAFT_LEASE_NOT_OWNED" }, { status: 409 }));
      await advance(10_000);
      healthy(state);
      expect(state.session.draft()?.revision).toBe(3);
      saveAnswer = () =>
        Response.json({ code: "CONFLICT", message: "Draft changed; local text stored in a recovery copy" }, { status: 409 });
      state.setCurrent({ ...state.current(), body: "My next local edit" });
      expect(await state.session.persist()).toBeNull();
      expect(requests.find((r) => r.method === "PUT" && !r.url.endsWith("/lease"))?.body).toMatchObject({
        expectedRevision: 3,
        draft: { body: "My next local edit" },
      });
      expect(state.current().body).toBe("My next local edit");
      expect(state.session.draft()?.recoveryCopyCount).toBe(1);
      expect(state.session.leaseConflict()).toBeNull();
      expect(state.session.lease()).not.toBeNull();
      // The existing recovery-copy error remains editable; recovery must not hide that save result.
      expect(state.session.status()).toBe("error");
      editableThroughout(state.trace);
    });

    test("another person holding the lease opens the occupied dialog immediately", async () => {
      heldLease = { ...lease, holder: { ...lease.holder, id: "Usr002", displayName: "Grace Example" } };
      acquireAnswer = () => Response.json({ code: "DRAFT_LEASE_HELD" }, { status: 409 });
      const state = await mountSession();
      expect(state.session.leaseConflict()).toEqual({ lease: heldLease, reason: "occupied" });
      expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
      const { mailDraftCollaborationCopy } = await import("./MailDraftCollaborationDialog");
      expect(mailDraftCollaborationCopy(state.session.leaseConflict()!, lease.holder, "en")).toMatchObject({
        title: "Grace Example is editing this draft",
        takeoverLabel: "Take over",
      });
    });

    test("a real same-actor tab opens the occupied dialog after the bounded grace", async () => {
      acquireAnswer = () => Response.json({ code: "DRAFT_LEASE_HELD" }, { status: 409 });
      const state = await mountSession();
      expect(state.session.leaseConflict()).toBeNull();
      expect(state.session.status()).toBe("preparing");
      for (const ms of [250, 500, 1_000, 2_000, 4_000, 2_250]) await advance(ms);
      expect(state.session.leaseConflict()).toEqual({ lease, reason: "occupied" });
      const { mailDraftCollaborationCopy } = await import("./MailDraftCollaborationDialog");
      expect(mailDraftCollaborationCopy(state.session.leaseConflict()!, lease.holder, "en")).toMatchObject({
        title: "Draft open in another tab",
        takeoverLabel: "Edit in this tab",
      });
    });

    test("a heartbeat followed by Grace's live lease opens the lost dialog without grace", async () => {
      const state = await mountSession();
      heldLease = { ...lease, holder: { ...lease.holder, id: "Usr002", displayName: "Grace Example" } };
      acquireAnswer = () => Response.json({ code: "DRAFT_LEASE_HELD" }, { status: 409 });
      heartbeatAnswers.push(Response.json({ code: "DRAFT_LEASE_NOT_OWNED" }, { status: 409 }));
      await advance(10_000);
      expect(state.session.leaseConflict()).toEqual({ lease: heldLease, reason: "lost" });
      const { mailDraftCollaborationCopy } = await import("./MailDraftCollaborationDialog");
      expect(mailDraftCollaborationCopy(state.session.leaseConflict()!, lease.holder, "en").takeoverLabel).toBe("Take over");
    });

    test("a real same-actor takeover during heartbeat has no initial-acquire grace", async () => {
      const state = await mountSession();
      acquireAnswer = () => Response.json({ code: "DRAFT_LEASE_HELD" }, { status: 409 });
      heartbeatAnswers.push(Response.json({ code: "DRAFT_LEASE_NOT_OWNED" }, { status: 409 }));
      await advance(10_000);
      expect(state.session.leaseConflict()).toEqual({ lease, reason: "lost" });
      const { mailDraftCollaborationCopy } = await import("./MailDraftCollaborationDialog");
      expect(mailDraftCollaborationCopy(state.session.leaseConflict()!, lease.holder, "en").description).toBe(
        "Another tab or window took over editing this draft. You can keep reading here or move editing back to this tab.",
      );
    });

    test("an unreadable held lease is retried without inventing another editor", async () => {
      const state = await mountSession();
      state.trace.length = 0;
      heldLease = null;
      let acquisitions = 0;
      acquireAnswer = () =>
        ++acquisitions === 1
          ? Response.json({ code: "DRAFT_LEASE_HELD" }, { status: 409 })
          : Response.json({ ...lease, token: "new-token" });
      heartbeatAnswers.push(Response.json({ code: "DRAFT_LEASE_NOT_OWNED" }, { status: 409 }));
      await advance(10_000);
      await advance(250);
      healthy(state);
      editableThroughout(state.trace);
    });

    test("failed heartbeat answers show the localized editing error, never a lease dialog", async () => {
      const state = await mountSession();
      heartbeatAnswers.push(Response.json({ code: "FORBIDDEN", message: "Raw server detail" }, { status: 403 }));
      await advance(10_000);
      expect(state.session.status()).toBe("error");
      expect(state.session.statusMessage()).toBe("Draft editing could not be started");
      expect(state.session.leaseConflict()).toBeNull();
    });

    test("BUSY exhaustion shows the localized save error and a 503 PUT is never retried", async () => {
      const state = await mountSession();
      let attempts = 0;
      saveAnswer = () => {
        attempts++;
        return Response.json({ code: "DRAFT_LEASE_BUSY", message: "Raw server detail" }, { status: 409 });
      };
      state.setCurrent({ ...state.current(), body: "Unsaved text" });
      const saving = state.session.persist();
      await flush();
      state.session.stopScheduledSave();
      for (const ms of [500, 1_000]) await advance(ms);
      await saving;
      expect(attempts).toBe(3);
      expect(state.session.status()).toBe("error");
      expect(state.session.statusMessage()).toBe("Draft could not be saved");
      expect(state.session.leaseConflict()).toBeNull();
      state.session.stopScheduledSave();
      attempts = 0;
      saveAnswer = () => {
        attempts++;
        return Response.json({ code: "INTERNAL", message: "Response lost after commit" }, { status: 503 });
      };
      await state.session.persist();
      expect(attempts).toBe(1);
    });

    test("a draft PUT retries only BUSY, preserving content and expectedRevision", async () => {
      const state = await mountSession();
      let attempts = 0;
      saveAnswer = (input) =>
        ++attempts === 1
          ? Response.json({ code: "DRAFT_LEASE_BUSY" }, { status: 409 })
          : Response.json({ ...stored, ...input.draft, revision: 4 });
      state.setCurrent({ ...state.current(), body: "Retry this write" });
      const saving = state.session.persist();
      await flush();
      state.session.stopScheduledSave();
      await advance(2_000);
      await saving;
      healthy(state);
      expect(attempts).toBe(2);
      const writes = requests.filter((r) => r.method === "PUT" && !r.url.endsWith("/lease"));
      expect(writes[0]?.body).toEqual(writes[1]?.body);
    });
  });
});
