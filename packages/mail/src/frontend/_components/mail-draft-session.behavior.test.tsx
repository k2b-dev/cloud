import { afterEach, beforeEach, describe, expect, jest, setSystemTime, spyOn, test } from "bun:test";
import { setImmediate } from "node:timers";
import * as sharedText from "@k2b/cloud/browser/shared-text";
import { crypto as cryptoUtils, encoding } from "@k2b/stdlib";
import { createRenderEffect, createRoot, createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import * as Y from "yjs";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";
import type { DraftEditableContent, DraftLease, MailDraft, MailDraftSeed } from "../../contracts";
import { createDraftDocument } from "../../lib/draft-document";
import { mailDraftJournalKey } from "./mail-draft-journal";
import { openMailUserDraftStorage } from "./mail-user-draft-storage";

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
    if (new URL(url).pathname.endsWith("/document/socket"))
      queueMicrotask(() => {
        if (this.readyState === FakeWebSocket.CONNECTING) this.open();
      });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
    if (!new URL(this.url).pathname.endsWith("/document/socket")) return;
    const packet: { type: string; payload: { payload?: string } } = JSON.parse(data);
    const position = { docId: DRAFT_ID, generation: "1", cursor: "s6t.fixture.1" };
    if (packet.type === "replayRequest")
      queueMicrotask(() => this.message({ type: "replayReady", payload: { ...position, peerId: "peer1" } }));
    if (packet.type === "syncPublish" && packet.payload.payload)
      queueMicrotask(() =>
        this.message({
          type: "syncPush",
          payload: {
            docId: position.docId,
            generation: position.generation,
            updates: [{ generation: position.generation, cursor: position.cursor, payload: packet.payload.payload }],
          },
        }),
      );
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

  const sharedFixture = async (fromSeed = false, initializing = false) => {
    const editable = content("Saved shared text", "first@example.test");
    const currentDraft: MailDraft = { ...draft(3, editable), editMode: "shared", generation: "1" };
    const document = createDraftDocument(editable);
    const bytes = Y.encodeStateAsUpdate(document);
    document.destroy();
    const snapshot = { state: encoding.toBase64(bytes), cursor: "s6t.fixture.1", content: editable };
    const authorization = {
      generation: "1",
      revision: 3,
      lifecycle: "draft",
      historyComplete: true,
      fresh: snapshot,
      durable: snapshot,
      frozen: null,
    };
    respondWith((_method, url) => {
      if (url.endsWith("/materialize")) return Response.json(currentDraft);
      if (url.endsWith("/document") && !initializing) return Response.json(authorization);
      return Response.json({ message: "Session expired" }, { status: 401 });
    });
    const { createMailDraftSession } = await import("./mail-draft-session");
    const [current, setCurrent] = createSignal(editable);
    const session = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createMailDraftSession({
        mailboxId: MAILBOX_ID,
        currentActor: { kind: "user", id: "Usr001" },
        initialDraft: fromSeed ? undefined : currentDraft,
        initialSeed: fromSeed ? { ...seed, content: editable } : undefined,
        hasVerifiedIdentity: () => true,
        content: current,
        applyDraftContent: setCurrent,
        isDisposed: () => false,
        onRecovered: () => undefined,
        onMaterialized: () => undefined,
        locale: () => "en",
      });
    });
    return { session, current, setCurrent };
  };

  test.each(["initialize", "save", "materialize-initialize", "materialize-save"])(
    "shared %s 401 keeps the sign-in action through client errors and later state updates",
    async (phase) => {
      localStorage.setItem(`cloud:mail:shared:Usr001:${DRAFT_ID}:1:remember`, "no");
      const initializing = phase.endsWith("initialize");
      const f = await sharedFixture(phase.startsWith("materialize"), initializing);
      if (phase.startsWith("materialize")) {
        f.setCurrent({ ...f.current(), body: "Materializing input" });
        expect(await f.session.persist()).toBeNull();
        expect(f.session.materializedLeasePending()).toBe(false);
      } else {
        await f.session.ensureDraft();
        if (!initializing) {
          f.setCurrent({ ...f.current(), body: "Pending shared input" });
          await Bun.sleep(0); // Deliver the publication echo before requesting its snapshot.
          expect(await f.session.persist()).toBeNull();
        }
      }
      expect(f.session.authenticationRequired()).toBe(true);
      expect(f.session.status()).toBe("readonly");
      expect(f.session.statusMessage()).toBe("Your sign-in expired. Sign in again to continue with this draft.");
      if (initializing) {
        if (!phase.startsWith("materialize")) {
          await f.session.prepareSignIn(); // Unchanged SSR content already exists on the server.
          f.setCurrent({ ...f.current(), body: "Input without a shared client" });
        }
        await expect(f.session.prepareSignIn()).rejects.toThrow();
      }
      const before = requests.length;
      await f.session.resumeCurrentLease();
      expect(await f.session.persist()).toBeNull();
      expect(requests).toHaveLength(before);
    },
  );

  test.each(["tab-only", "remembered", "storage-failed"])(
    "shared sign-in preparation uses reload-safe document storage: %s",
    async (mode) => {
      const generations = spyOn(sharedText, "listSharedTextOfflineGenerations").mockResolvedValue([]);
      localStorage.setItem(`cloud:mail:shared:Usr001:${DRAFT_ID}:1:remember`, mode === "tab-only" ? "no" : "yes");
      let stored: Uint8Array | null = null;
      const write = Promise.withResolvers<void>();
      const offline = spyOn(sharedText, "openAuthorizedSharedTextOffline").mockImplementation(async (_identity, authorize, signal) => {
        const authorization = await authorize(signal ?? new AbortController().signal);
        return {
          authorization,
          state: stored,
          baseCursor: "s6t.fixture.1",
          session: {
            signal: new AbortController().signal,
            load: async () => stored,
            loadPending: async () => (stored ? { state: stored, baseCursor: "s6t.fixture.1" } : null),
            save: async (bytes) => {
              await write.promise;
              if (mode === "storage-failed") throw new Error("Device storage full");
              stored = bytes.slice();
              return stored;
            },
            acknowledgeSnapshot: async () => false,
            forget: async () => {},
            close: () => {},
          },
        };
      });
      try {
        const f = await sharedFixture();
        await f.session.ensureDraft();
        f.setCurrent({ ...f.current(), body: "Only on this device" });
        await Bun.sleep(0);
        expect(await f.session.persist()).toBeNull();
        expect(f.session.authenticationRequired()).toBe(true);
        if (mode === "tab-only") {
          await expect(f.session.prepareSignIn()).rejects.toThrow();
          expect(offline).not.toHaveBeenCalled();
        } else {
          let finished = false;
          const preparing = f.session.prepareSignIn().finally(() => {
            finished = true;
          });
          const outcome = preparing.then(
            () => "ready",
            () => "blocked",
          );
          await Bun.sleep(0);
          expect(finished).toBe(false); // A queued write is not yet a reload guarantee.
          write.resolve();
          expect(await outcome).toBe(mode === "remembered" ? "ready" : "blocked");
          if (mode === "remembered") {
            dispose();
            await Bun.sleep(0);
            const reloaded = await sharedFixture();
            await reloaded.session.ensureDraft();
            expect(reloaded.current().body).toBe("Only on this device");
          }
        }
        expect(openMailUserDraftStorage(localStorage, "Usr001").getItem(mailDraftJournalKey(MAILBOX_ID, DRAFT_ID))).toBeNull();
      } finally {
        write.resolve();
        dispose();
        await Bun.sleep(0);
        offline.mockRestore();
        generations.mockRestore();
      }
    },
  );

  test.each(["saved", "pending-save"])("invalidated shared storage blocks sign-in reload: %s", async (mode) => {
    const generations = spyOn(sharedText, "listSharedTextOfflineGenerations").mockResolvedValue([]);
    localStorage.setItem(`cloud:mail:shared:Usr001:${DRAFT_ID}:1:remember`, "yes");
    const controller = new AbortController();
    const write = Promise.withResolvers<void>();
    const writeStarted = Promise.withResolvers<void>();
    let delayWrite = false;
    const storage: { state: Uint8Array | null } = { state: null };
    const offline = spyOn(sharedText, "openAuthorizedSharedTextOffline").mockImplementation(async (_identity, authorize) => ({
      authorization: await authorize(controller.signal),
      state: storage.state,
      baseCursor: "s6t.fixture.1",
      session: {
        signal: controller.signal,
        load: async () => storage.state,
        loadPending: async () => (storage.state ? { state: storage.state, baseCursor: "s6t.fixture.1" } : null),
        save: async (bytes) => {
          const saved = bytes.slice();
          if (delayWrite) {
            writeStarted.resolve();
            await write.promise;
          }
          if (!controller.signal.aborted) storage.state = saved;
          return saved;
        },
        acknowledgeSnapshot: async () => false,
        forget: async () => {},
        close: () => controller.abort(),
      },
    }));
    try {
      const f = await sharedFixture();
      await f.session.ensureDraft();
      const client = f.session.shared()!;
      f.setCurrent({ ...f.current(), body: "Only on this device" });
      client.edit(f.current());
      expect(await client.flushLocal()).toBe(true);
      expect(storage.state).toEqual(Y.encodeStateAsUpdate(client.doc));
      expect(client.state().locallySaved).toBe(true);
      if (mode === "pending-save") {
        delayWrite = true;
        f.setCurrent({ ...f.current(), body: "More unsent input" });
        client.edit(f.current());
        await writeStarted.promise;
      }
      const unsent = f.current();
      // Invalidation deletes the saved bytes while this tab retains its unsent document.
      storage.state = null;
      controller.abort(new Error("Offline store invalidated"));
      expect(client.state()).toMatchObject({ terminal: true, dirty: true, locallySaved: false, error: true });
      // A write may already have completed before invalidation; deliver its result afterwards.
      write.resolve();
      expect(await client.flushLocal()).toBe(false);
      expect(storage.state).toBeNull();
      expect(client.state()).toMatchObject({ locallySaved: false, error: true });
      respondWith(() => Response.json({ message: "Session expired" }, { status: 401 }));
      await expect(client.retry()).rejects.toThrow("Session expired");
      expect(f.session.authenticationRequired()).toBe(true);
      expect(f.session.statusMessage()).toBe("Your sign-in expired. Sign in again to continue with this draft.");
      await expect(f.session.prepareSignIn()).rejects.toThrow("Draft could not be saved");
      expect(await client.flushLocal()).toBe(false);
      expect(client.content()).toEqual(unsent);
      expect(f.current()).toEqual(unsent);
      const leaving = new window.Event("beforeunload", { cancelable: true });
      window.dispatchEvent(leaving);
      expect(leaving.defaultPrevented).toBe(true);
    } finally {
      write.resolve();
      dispose();
      await Bun.sleep(0);
      offline.mockRestore();
      generations.mockRestore();
    }
  });

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
    const editingGaps: boolean[] = [];
    const session = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      const session = createMailDraftSession({
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
      createRenderEffect(() => editingGaps.push(Boolean(session.draft()) && !session.lease() && !session.materializedLeasePending()));
      return session;
    });

    // Before the next autosave, the user changes the recipient and the text, then selects Send.
    setCurrent(content("Final text", "second@example.test"));
    const saved = await session.persist();

    expect(editingGaps).not.toContain(true);
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

  test("expired authentication preserves the journal and stops automatic lease retries", async () => {
    let expired = false;
    respondWith((method, url) => {
      if (expired) return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
      if (url.endsWith("/lease") && method === "POST") return Response.json({ ...lease, token: "lease-token" });
      return Response.json({}, { status: 404 });
    });
    const { createMailDraftSession } = await import("./mail-draft-session");
    const [current, setCurrent] = createSignal(content("Saved", "first@example.test"));
    const session = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createMailDraftSession({
        mailboxId: MAILBOX_ID,
        currentActor: { kind: "user", id: "Usr001" },
        initialDraft: draft(3, current()),
        hasVerifiedIdentity: () => true,
        content: current,
        applyDraftContent: setCurrent,
        isDisposed: () => false,
        onRecovered: () => undefined,
        onMaterialized: () => undefined,
        locale: () => "en",
      });
    });
    await session.ensureDraft();
    setCurrent(content("Unsaved text", "first@example.test"));
    expired = true;
    await session.resumeCurrentLease();
    expect(session.statusMessage()).toBe("Your sign-in expired. Sign in again to continue with this draft.");
    expect(session.status()).toBe("readonly");
    expect(
      JSON.parse(openMailUserDraftStorage(localStorage, "Usr001").getItem(mailDraftJournalKey(MAILBOX_ID, DRAFT_ID))!).content.body,
    ).toBe("Unsaved text");
    const before = requests.length;
    await session.resumeCurrentLease();
    expect(requests).toHaveLength(before);
  });

  test("sign-in recovery stores edits before a seed has a server draft", async () => {
    respondWith(() => Response.json({ code: "UNAUTHORIZED" }, { status: 401 }));
    const { createMailDraftSession } = await import("./mail-draft-session");
    const { readMailDraftSeed } = await import("./mail-draft-seed-store");
    const [current, setCurrent] = createSignal(content("Unsaved seed text", "first@example.test"));
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
    await session.persist();
    expect(session.authenticationRequired()).toBe(true);
    expect(session.draft()).toBeNull();
    await session.prepareSignIn();
    expect(readMailDraftSeed(openMailUserDraftStorage(localStorage, "Usr001"), MAILBOX_ID, seed.id)?.content).toEqual(seed.content);
    expect(JSON.parse(openMailUserDraftStorage(localStorage, "Usr001").getItem(mailDraftJournalKey(MAILBOX_ID, seed.id))!).content).toEqual(
      current(),
    );
    expect(localStorage.getItem(mailDraftJournalKey(MAILBOX_ID, seed.id))).toBeNull();
    expect(readMailDraftSeed(localStorage, MAILBOX_ID, seed.id)).toBeNull();
    // happy-dom's Storage proxy ignores assigned methods, so a spy would never run; only a defined property replaces one.
    const write = localStorage.setItem;
    const replaceWrite = (value: Storage["setItem"]) =>
      Object.defineProperty(localStorage, "setItem", { configurable: true, writable: true, value });
    replaceWrite(() => {
      throw new Error("Storage full");
    });
    try {
      await expect(session.prepareSignIn()).rejects.toThrow("Storage full");
    } finally {
      replaceWrite(write);
    }
    localStorage.setItem("cloud:user-epoch:Usr001", "ended");
    await expect(session.prepareSignIn()).rejects.toThrow("This browser session ended");
  });

  test("a late successful save cannot hide expired sign-in or discard newer journal text", async () => {
    const pending = Promise.withResolvers<Response>();
    respondWith((method, url) => {
      if (url.endsWith("/lease"))
        return method === "POST"
          ? Response.json({ ...lease, token: "lease-token" })
          : Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
      return pending.promise;
    });
    const { createMailDraftSession } = await import("./mail-draft-session");
    const [current, setCurrent] = createSignal(content("Saved", "first@example.test"));
    const session = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createMailDraftSession({
        mailboxId: MAILBOX_ID,
        currentActor: { kind: "user", id: "Usr001" },
        initialDraft: draft(3, current()),
        hasVerifiedIdentity: () => true,
        content: current,
        applyDraftContent: setCurrent,
        isDisposed: () => false,
        onRecovered: () => undefined,
        onMaterialized: () => undefined,
        locale: () => "en",
      });
    });
    await session.ensureDraft();
    setCurrent(content("Saving", "first@example.test"));
    const saving = session.persist();
    for (let i = 0; i < 100 && !requests.some((r) => r.method === "PUT" && !r.url.endsWith("/lease")); i++) await Bun.sleep(1);
    setCurrent(content("Newer text", "first@example.test"));
    await session.resumeCurrentLease();
    let ready = false;
    const prepare = session.prepareSignIn().then(() => {
      ready = true;
    });
    await Bun.sleep(1);
    expect(ready).toBe(false);
    pending.resolve(Response.json(draft(4, content("Saving", "first@example.test"))));
    await saving;
    await prepare;
    expect(ready).toBe(true);
    expect(session.status()).toBe("readonly");
    expect(session.statusMessage()).toBe("Your sign-in expired. Sign in again to continue with this draft.");
    expect(session.authenticationRequired()).toBe(true);
    expect(JSON.parse(openMailUserDraftStorage(localStorage, "Usr001").getItem(mailDraftJournalKey(MAILBOX_ID, DRAFT_ID))!)).toMatchObject({
      revision: 4,
      content: current(),
    });
  });

  test("a lease failure followed by lifecycle 401 keeps the sign-in action", async () => {
    respondWith((_method, url) =>
      Response.json({ code: url.endsWith("/lease") ? "FORBIDDEN" : "UNAUTHORIZED" }, { status: url.endsWith("/lease") ? 403 : 401 }),
    );
    const { createMailDraftSession } = await import("./mail-draft-session");
    const session = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createMailDraftSession({
        mailboxId: MAILBOX_ID,
        currentActor: { kind: "user", id: "Usr001" },
        initialDraft: draft(3, content("Saved", "first@example.test")),
        hasVerifiedIdentity: () => true,
        content: () => content("Saved", "first@example.test"),
        applyDraftContent: () => undefined,
        isDisposed: () => false,
        onRecovered: () => undefined,
        onMaterialized: () => undefined,
        locale: () => "en",
      });
    });
    await session.ensureDraft();
    expect(session.authenticationRequired()).toBe(true);
    expect(session.status()).toBe("readonly");
    expect(session.statusMessage()).toBe("Your sign-in expired. Sign in again to continue with this draft.");
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
    let restorePendingSave = () => {};
    beforeEach(() => {
      const random = spyOn(Math, "random").mockReturnValue(0.5);
      restoreRandom = () => random.mockRestore();
      jest.useFakeTimers();
      setSystemTime(Date.parse(now));
    });
    afterEach(() => {
      restorePendingSave();
      restoreRandom();
      jest.useRealTimers();
    });

    const mountSession = async (
      initial: MailDraft = { ...draft(3, content("Local text", "ada@example.test")), conversationId: "Conv01" },
    ) => {
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

    test("disposing while an acquire is pending releases the granted token exactly once", async () => {
      let grant: (() => void) | undefined;
      acquireAnswer = () =>
        new Promise<Response>((resolve) => {
          grant = () => resolve(Response.json({ ...lease, token: "disposed-token" }));
        });
      const state = await mountSession();
      expect(grant).toBeDefined();
      expect(state.session.lease()).toBeNull();

      dispose();
      grant?.();
      await flush();

      expect(requests.filter((r) => r.method === "DELETE" && r.url.endsWith(`/drafts/${DRAFT_ID}/lease`)).map((r) => r.body)).toEqual([
        { token: "disposed-token" },
      ]);
    });

    test("own lease expired while the tab was hidden silently acquires again", async () => {
      const state = await mountSession();
      state.trace.length = 0;
      heartbeatAnswers.push(Response.json({ code: "DRAFT_LEASE_NOT_OWNED" }, { status: 409 }));
      await advance(10_000);
      healthy(state);
      editableThroughout(state.trace);
      expect(requests.filter((r) => r.method === "POST" && r.url.endsWith("/lease"))).toHaveLength(2);
    });

    test("BFCache restore resumes after a pending silent re-acquire is cancelled", async () => {
      const state = await mountSession();
      let grant: (() => void) | undefined;
      acquireAnswer = () =>
        new Promise<Response>((resolve) => {
          grant = () => resolve(Response.json({ ...lease, token: "cancelled-token" }));
        });
      heartbeatAnswers.push(Response.json({ code: "DRAFT_LEASE_NOT_OWNED" }, { status: 409 }));
      await advance(10_000);
      expect(grant).toBeDefined();
      for (const type of ["pagehide", "pageshow"]) {
        const event = new Event(type);
        Object.defineProperty(event, "persisted", { value: true });
        window.dispatchEvent(event);
      }
      await flush();
      expect(requests.filter((r) => r.method === "POST" && r.url.endsWith("/lease"))).toHaveLength(2);
      acquireAnswer = () => Response.json({ ...lease, token: "resumed-token" });
      heartbeatAnswers.push(Response.json({ code: "DRAFT_LEASE_NOT_OWNED" }, { status: 409 }));
      grant?.();
      await flush();

      healthy(state);
      expect(state.session.lease()?.token).toBe("resumed-token");
      expect(requests.filter((r) => r.method === "POST" && r.url.endsWith("/lease"))).toHaveLength(3);
      expect(requests.filter((r) => r.method === "DELETE").map((r) => r.body)).toEqual([{ token: "cancelled-token" }]);
      const heartbeats = requests.filter((r) => r.method === "PUT" && r.url.endsWith("/lease")).length;
      await advance(10_000);
      expect(requests.filter((r) => r.method === "PUT" && r.url.endsWith("/lease"))).toHaveLength(heartbeats + 1);
      healthy(state);
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
      const saveStarted = Promise.withResolvers<void>();
      const pendingSave = Promise.withResolvers<Response>();
      saveAnswer = () => {
        saveStarted.resolve();
        return pendingSave.promise;
      };
      const hashing = Promise.withResolvers<void>();
      const releaseHash = Promise.withResolvers<void>();
      const originalHash = cryptoUtils.common.hash;
      const hash = spyOn(cryptoUtils.common, "hash").mockImplementation(async (...args) => {
        hashing.resolve();
        await releaseHash.promise;
        return originalHash(...args);
      });
      const cleanup = () => {
        releaseHash.resolve();
        pendingSave.resolve(Response.json({ ...stored, ...state.current(), revision: 5 }));
        hash.mockRestore();
        restorePendingSave = () => {};
      };
      // afterEach also releases the gates if Bun times out the test body.
      restorePendingSave = cleanup;
      const writesBefore = requests.filter((request) => request.method === "PUT" && !request.url.endsWith("/lease")).length;
      try {
        state.setCurrent({ ...state.current(), body: "Still typing" });
        const saving = state.session.persist();
        await hashing.promise;
        await flush();
        expect(state.session.status()).toBe("saving");
        expect(requests.filter((request) => request.method === "PUT" && !request.url.endsWith("/lease"))).toHaveLength(writesBefore);
        releaseHash.resolve();
        // A native digest can outlast a fake-timer/microtask flush. The PUT
        // must reach its fixture before testing an echo during that request.
        await saveStarted.promise;
        expect(requests.findLast((request) => request.method === "PUT" && !request.url.endsWith("/lease"))?.body).toMatchObject({
          expectedRevision: 4,
          draft: { body: "Still typing" },
        });
        expect(state.session.status()).toBe("saving");
        socket.message({ t: "event", id: "1", cursor: "s6t.mail.7", data: { conversationId: null } });
        await flush();
        expect(state.session.status()).toBe("saving");
        pendingSave.resolve(Response.json({ ...stored, ...state.current(), revision: 5 }));
        expect(await saving).toMatchObject({ body: "Still typing", revision: 5 });
        expect(state.current().body).toBe("Still typing");
        healthy(state);
        editableThroughout(state.trace);
      } finally {
        cleanup();
      }
    });

    test.each(["timeout", "network"])("a lost PUT answer (%s) is confirmed before newer typing is saved", async (failure) => {
      if (failure === "network") jest.useRealTimers();
      const state = await mountSession();
      const writes: Array<{ expectedRevision: number; draft: DraftEditableContent }> = [];
      let loseAnswer = true;
      saveAnswer = (input) => {
        writes.push(input);
        const same = input.draft.body === stored.body && input.draft.subject === stored.subject;
        if (!same && input.expectedRevision !== stored.revision)
          return Response.json({ code: "CONFLICT", message: "Draft changed" }, { status: 409 });
        if (!same) stored = { ...stored, ...input.draft, revision: stored.revision + 1 };
        if (loseAnswer) {
          loseAnswer = false;
          if (failure === "network") throw new TypeError("Failed to fetch");
          return Response.json({ code: "INTERNAL", message: "Gateway timeout after commit" }, { status: 504 });
        }
        return Response.json(stored);
      };
      state.setCurrent({ ...state.current(), body: "Committed before timeout" });
      expect(await state.session.persist()).toBeNull();
      expect(stored.revision).toBe(4);
      state.setCurrent({ ...state.current(), body: "Latest text", subject: "Latest subject", to: [{ address: "latest@example.test" }] });
      const saved = await state.session.persist();
      expect(writes.map(({ expectedRevision, draft }) => [expectedRevision, draft.body])).toEqual([
        [3, "Committed before timeout"],
        [3, "Committed before timeout"],
        [4, "Latest text"],
      ]);
      expect(saved).toMatchObject({
        revision: 5,
        body: "Latest text",
        subject: "Latest subject",
        to: [{ address: "latest@example.test" }],
      });
      expect(state.current().body).toBe("Latest text");
      expect(state.session.revisionConflict()).toBe(false);
      healthy(state);
    });

    test("unavailable local storage does not block initialization or server persistence", async () => {
      const read = localStorage.getItem;
      Object.defineProperty(localStorage, "getItem", {
        configurable: true,
        writable: true,
        value: () => {
          throw new Error("Device storage unavailable");
        },
      });
      try {
        const state = await mountSession();
        expect(state.session.status()).toBe("saved");
        state.setCurrent({ ...state.current(), body: "Server-saved without local storage" });
        expect((await state.session.persist())?.body).toBe("Server-saved without local storage");
        expect(state.session.localCopyFailed()).toBe(true);
      } finally {
        Object.defineProperty(localStorage, "getItem", { configurable: true, writable: true, value: read });
      }
    });

    test("full local storage never blocks server autosave", async () => {
      const state = await mountSession();
      const write = localStorage.setItem;
      Object.defineProperty(localStorage, "setItem", {
        configurable: true,
        writable: true,
        value: () => {
          throw new DOMException("Full", "QuotaExceededError");
        },
      });
      try {
        state.setCurrent({ ...state.current(), body: "Large pasted message" });
        await advance(700);
        expect(["saving", "saved"]).toContain(state.session.status());
        expect((await state.session.persist())?.revision).toBe(4);
        expect(stored.body).toBe("Large pasted message");
        expect(state.session.localCopyFailed()).toBe(true);
        state.setCurrent({ ...state.current(), body: "Still typing" });
        expect((await state.session.persist())?.revision).toBe(5);
        expect(state.session.revisionConflict()).toBe(false);
      } finally {
        Object.defineProperty(localStorage, "setItem", { configurable: true, writable: true, value: write });
      }
    });

    test("cleanup failure cannot leave a committed save at an old client revision", async () => {
      const state = await mountSession();
      const remove = localStorage.removeItem;
      Object.defineProperty(localStorage, "removeItem", {
        configurable: true,
        writable: true,
        value: () => {
          throw new Error("Device cleanup unavailable");
        },
      });
      try {
        state.setCurrent({ ...state.current(), body: "First saved version" });
        expect((await state.session.persist())?.revision).toBe(4);
        state.setCurrent({ ...state.current(), body: "Next saved version" });
        expect((await state.session.persist())?.revision).toBe(5);
        expect(state.session.revisionConflict()).toBe(false);
      } finally {
        Object.defineProperty(localStorage, "removeItem", { configurable: true, writable: true, value: remove });
      }
    });

    test("reverting to confirmed text during an uncertain save survives reload", async () => {
      const state = await mountSession();
      const confirmed = state.current();
      state.setCurrent({ ...confirmed, body: "Uncertain text" });
      saveAnswer = (input) => {
        stored = { ...stored, ...input.draft, revision: 4 };
        return Response.json({ message: "Timeout" }, { status: 504 });
      };
      await state.session.persist();
      state.setCurrent(confirmed);
      await flush();
      const journal = openMailUserDraftStorage(localStorage, "Usr001").getItem(mailDraftJournalKey(MAILBOX_ID, DRAFT_ID));
      expect(JSON.parse(journal!).content.body).toBe(confirmed.body);
      dispose();
      saveAnswer = undefined;
      const reopened = await mountSession();
      expect(reopened.current().body).toBe(confirmed.body);
      expect(reopened.session.revisionConflict()).toBe(false);
      expect((await reopened.session.persist())?.body).toBe(confirmed.body);
    });

    test("overlapping save requests coalesce current input behind one in-flight PUT", async () => {
      const state = await mountSession();
      const gate = Promise.withResolvers<void>();
      let active = 0,
        maximum = 0;
      const bodies: string[] = [];
      saveAnswer = async (input) => {
        active++;
        maximum = Math.max(maximum, active);
        bodies.push(input.draft.body);
        if (bodies.length === 1) await gate.promise;
        expect(input.expectedRevision).toBe(stored.revision);
        stored = { ...stored, ...input.draft, revision: stored.revision + 1 };
        active--;
        return Response.json(stored);
      };
      state.setCurrent({ ...state.current(), body: "First" });
      const saves = [state.session.persist()];
      await flush();
      for (let index = 0; index < 30; index++) {
        state.setCurrent({ ...state.current(), body: `Typing ${index}`, subject: `Subject ${index}` });
        saves.push(state.session.persist());
      }
      gate.resolve();
      await Promise.all(saves);
      expect(maximum).toBe(1);
      expect(bodies).toEqual(["First", "Typing 29"]);
      expect(stored).toMatchObject({ body: "Typing 29", subject: "Subject 29" });
      healthy(state);
    });

    test("an unconfirmed attachment revision is refreshed without replacing typed text", async () => {
      const state = await mountSession();
      stored = { ...stored, revision: 4 };
      saveAnswer = (input) => {
        if (input.expectedRevision !== stored.revision)
          return Response.json({ code: "CONFLICT", message: "Draft changed" }, { status: 409 });
        stored = { ...stored, ...input.draft, revision: 5 };
        return Response.json(stored);
      };
      state.setCurrent({ ...state.current(), body: "Typed during attachment finalization" });
      const result = await state.session.persist();
      expect(result).toMatchObject({ body: "Typed during attachment finalization", revision: 5 });
      expect(state.current().body).toBe("Typed during attachment finalization");
      expect(state.session.revisionConflict()).toBe(false);
      healthy(state);
    });

    test("reload confirms a lost save answer from its journal before saving later input", async () => {
      const initial = draft(3, content("Committed answer lost", "ada@example.test"));
      const pending = content("Typed after lost answer", "ada@example.test");
      const storage = openMailUserDraftStorage(localStorage, "Usr001");
      storage.setItem(
        mailDraftJournalKey(MAILBOX_ID, DRAFT_ID),
        JSON.stringify({
          revision: 2,
          content: pending,
          confirmedContent: content("Earlier base", "ada@example.test"),
          pendingSave: { revision: 2, content: content(initial.body, "ada@example.test") },
        }),
      );
      stored = initial;
      const state = await mountSession(initial);
      expect(state.current().body).toBe(pending.body);
      expect(state.session.revisionConflict()).toBe(false);
      expect((await state.session.persist())?.body).toBe(pending.body);
    });

    test("a non-revision conflict does not block choosing another sender", async () => {
      const state = await mountSession();
      state.setCurrent({ ...state.current(), body: "Keep this text" });
      saveAnswer = () => Response.json({ code: "CONFLICT", message: "Sender identity is no longer available" }, { status: 409 });
      expect(await state.session.persist()).toBeNull();
      expect(state.session.revisionConflict()).toBe(false);
      saveAnswer = undefined;
      state.setCurrent({ ...state.current(), senderIdentityId: "Idn002" });
      expect((await state.session.persist())?.body).toBe("Keep this text");
    });

    test("reload resolves a still-unconfirmed save before newer journal input", async () => {
      const storage = openMailUserDraftStorage(localStorage, "Usr001");
      storage.setItem(
        mailDraftJournalKey(MAILBOX_ID, DRAFT_ID),
        JSON.stringify({
          revision: 3,
          content: content("Typing after uncertain request", "ada@example.test"),
          confirmedContent: content(stored.body, "ada@example.test"),
          pendingSave: { revision: 3, content: content("Unconfirmed request", "ada@example.test") },
        }),
      );
      const state = await mountSession();
      expect(state.session.revisionConflict()).toBe(false);
      expect((await state.session.persist())?.body).toBe("Typing after uncertain request");
      expect(requests.filter((r) => r.method === "PUT" && !r.url.endsWith("/lease")).map((r) => r.body)).toMatchObject([
        { expectedRevision: 3, draft: { body: "Unconfirmed request" } },
        { expectedRevision: 4, draft: { body: "Typing after uncertain request" } },
      ]);
    });

    test("restoring a server recovery clears the conflict fence and resumes autosave", async () => {
      const state = await mountSession();
      stored = { ...stored, body: "Peer text", revision: 4 };
      state.setCurrent({ ...state.current(), body: "Local text for recovery" });
      saveAnswer = () => Response.json({ code: "CONFLICT", message: "Draft changed" }, { status: 409 });
      expect(await state.session.persist()).toBeNull();
      expect(state.session.revisionConflict()).toBe(true);
      expect(state.session.draft()?.revision).toBe(4);
      state.setCurrent({ ...state.current(), body: "New input typed after the conflict" });
      state.session.keepCurrentRecoveryCopy();
      stored = { ...stored, body: "Restored server copy", revision: 5 };
      state.session.setDraft(stored);
      state.setCurrent(content(stored.body, "ada@example.test"));
      state.session.acceptRestoredContent();
      state.session.forgetJournal(DRAFT_ID);
      expect(state.session.localRecoveryCopies().map((copy) => copy.content.body)).toContain("New input typed after the conflict");
      saveAnswer = undefined;
      state.setCurrent({ ...state.current(), body: "Typing after recovery" });
      expect((await state.session.persist())?.body).toBe("Typing after recovery");
      expect(state.session.revisionConflict()).toBe(false);
    });

    test("explicit local recovery can save in the same conversation while preserving replaced versions", async () => {
      const state = await mountSession();
      state.setCurrent({ ...state.current(), body: "Later local input" });
      stored = { ...stored, body: "Peer server version", revision: 4 };
      state.session.acceptMutationDraft(stored);
      const storage = openMailUserDraftStorage(localStorage, "Usr001");
      storage.setItem(
        `${mailDraftJournalKey(MAILBOX_ID, DRAFT_ID)}:editor:recovery-fixture`,
        JSON.stringify({ revision: 2, content: content("Selected older local input", "ada@example.test") }),
      );
      // A browser storage event refreshes the recovery chooser snapshot.
      window.dispatchEvent(new Event("storage"));
      const copy = state.session.localRecoveryCopies().find((copy) => copy.content.body === "Selected older local input");
      expect(copy).toBeDefined();
      expect(state.session.restoreLocalRecoveryCopy(copy!.id)).toBe(true);
      expect(state.session.revisionConflict()).toBe(false);
      expect((await state.session.persist())?.body).toBe("Selected older local input");
      expect(stored.conversationId).toBe("Conv01");
      expect(state.session.localRecoveryCopies().map((copy) => copy.content.body)).toEqual(
        expect.arrayContaining(["Later local input", "Peer server version"]),
      );
    });

    test("recovery backups deduplicate and terminal cleanup preserves other tabs' unsent input", async () => {
      const state = await mountSession();
      state.setCurrent({ ...state.current(), body: "Local input to preserve" });
      state.session.keepCurrentRecoveryCopy();
      const storage = openMailUserDraftStorage(localStorage, "Usr001");
      const key = mailDraftJournalKey(MAILBOX_ID, DRAFT_ID);
      const copies = () => storage.keys().filter((entry) => entry.startsWith(`${key}:editor:recovery:`));
      expect(copies()).toHaveLength(2);
      state.session.keepCurrentRecoveryCopy();
      expect(copies()).toHaveLength(2);
      const other = `${mailDraftJournalKey(MAILBOX_ID, "Drf002")}:editor:other`;
      storage.setItem(other, JSON.stringify({ revision: 1, content: state.current() }));
      const peer = `${key}:editor:peer`;
      storage.setItem(peer, JSON.stringify({ revision: 3, content: content("Unsent peer input", "ada@example.test") }));
      state.session.forgetJournal(DRAFT_ID, { closed: true });
      expect(storage.keys().filter((entry) => entry === key || entry.startsWith(`${key}:editor:`))).toEqual([peer]);
      expect(storage.getItem(other)).not.toBeNull();
    });

    test("reload of a peer-closed draft retains this tab's late unsent typing", async () => {
      const storage = openMailUserDraftStorage(localStorage, "Usr001");
      const key = `${mailDraftJournalKey(MAILBOX_ID, DRAFT_ID)}:editor:offline`;
      storage.setItem(key, JSON.stringify({ revision: 3, content: content("Late offline typing", "ada@example.test") }));
      window.sessionStorage.setItem(`cloud:user:Usr001:mail:journal:${MAILBOX_ID}:${DRAFT_ID}`, key);
      stored = { ...stored, state: "sent", revision: 4, body: "Peer sent version" };
      const state = await mountSession(stored);
      await state.session.ensureDraft();
      expect(state.current().body).toBe("Late offline typing");
      expect(state.session.lifecycleTransition()?.hasUnsavedChanges).toBe(true);
      expect(state.session.status()).toBe("readonly");
      expect(await state.session.persist()).toBeNull();
      expect(requests.filter((request) => request.method === "PUT")).toEqual([]);
    });

    test("an attachment retry cannot adopt a peer's revision for this editor's older text", async () => {
      const state = await mountSession();
      state.setCurrent({ ...state.current(), body: "This tab's unsaved input" });
      state.session.acceptMutationDraft({ ...stored, body: "Peer's saved text", revision: 5 });
      expect(state.current().body).toBe("This tab's unsaved input");
      expect(state.session.revisionConflict()).toBe(true);
      expect(state.session.status()).toBe("error");
      expect(await state.session.persist()).toBeNull();
      expect(requests.filter((r) => r.method === "PUT" && !r.url.endsWith("/lease"))).toHaveLength(0);
    });

    test("a clean editor adopts a peer version returned by a metadata mutation", async () => {
      const state = await mountSession();
      stored = { ...stored, body: "Peer saved text", revision: 4 };
      state.session.acceptMutationDraft(stored);
      expect(state.current().body).toBe("Peer saved text");
      expect(state.session.revisionConflict()).toBe(false);
      state.setCurrent({ ...state.current(), body: "New input on the peer base" });
      expect((await state.session.persist())?.revision).toBe(5);
    });

    test("a canceled intentional navigation does not disable the next unsaved-input guard", async () => {
      const state = await mountSession();
      state.setCurrent({ ...state.current(), body: "Unsaved navigation input" });
      state.session.allowNavigation();
      const own = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(own);
      expect(own.defaultPrevented).toBe(false);
      const next = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(next);
      expect(next.defaultPrevented).toBe(true);
    });

    test("an attachment-only returned revision keeps newer typing saveable", async () => {
      const state = await mountSession();
      state.setCurrent({ ...state.current(), body: "Typed during attachment retry" });
      state.session.acceptMutationDraft({ ...stored, revision: 4 });
      expect(state.session.revisionConflict()).toBe(false);
      expect((await state.session.persist())?.body).toBe("Typed during attachment retry");
      expect(requests.find((r) => r.method === "PUT" && !r.url.endsWith("/lease"))?.body).toMatchObject({ expectedRevision: 4 });
    });

    test("a resumed lease restores the revision-conflict action after BFCache or disconnection", async () => {
      const state = await mountSession();
      state.setCurrent({ ...state.current(), body: "Local unsaved input" });
      state.session.acceptMutationDraft({ ...stored, body: "Peer text", revision: 4 });
      for (const status of ["preparing", "readonly"] as const) {
        state.session.setStatus(status);
        state.session.setStatusMessage("Connection lost");
        await state.session.resumeCurrentLease();
        expect(state.session.status()).toBe("error");
        expect(state.session.statusMessage()).toContain("changed elsewhere");
        expect(state.session.revisionConflict()).toBe(true);
      }
    });

    test("reload moves its own predecessor backup instead of offering acknowledged text as recovery", async () => {
      const storage = openMailUserDraftStorage(localStorage, "Usr001");
      const oldKey = `${mailDraftJournalKey(MAILBOX_ID, DRAFT_ID)}:editor:predecessor`;
      storage.setItem(oldKey, JSON.stringify({ revision: 3, content: content(stored.body, "ada@example.test") }));
      window.sessionStorage.setItem(`cloud:user:Usr001:mail:journal:${MAILBOX_ID}:${DRAFT_ID}`, oldKey);
      const state = await mountSession();
      expect(storage.getItem(oldKey)).toBeNull();
      state.setCurrent({ ...state.current(), body: "Typed after reload" });
      await state.session.persist();
      expect(state.session.localRecoveryCopies()).toEqual([]);
    });

    test("a read-only second tab does not adopt another editor's live handoff journal", async () => {
      const storage = openMailUserDraftStorage(localStorage, "Usr001");
      storage.setItem(
        mailDraftJournalKey(MAILBOX_ID, DRAFT_ID),
        JSON.stringify({ revision: 3, content: content("Other tab's pending text", "ada@example.test") }),
      );
      heldLease = { ...lease, holder: { ...lease.holder, id: "Usr002" } };
      acquireAnswer = () => Response.json({ code: "DRAFT_LEASE_HELD" }, { status: 409 });
      const state = await mountSession();
      expect(state.current().body).toBe(stored.body);
      expect(state.session.lease()).toBeNull();
      expect(JSON.parse(storage.getItem(mailDraftJournalKey(MAILBOX_ID, DRAFT_ID))!).content.body).toBe("Other tab's pending text");
    });

    test("a granted lease cannot bypass journal recovery while its native hash is pending", async () => {
      const journal = openMailUserDraftStorage(localStorage, "Usr001");
      const pending = content("Unsaved input awaiting recovery", "local@example.test");
      const key = mailDraftJournalKey(MAILBOX_ID, DRAFT_ID);
      journal.setItem(key, JSON.stringify({ revision: 1, content: pending }));
      const hashing = Promise.withResolvers<void>();
      const proceed = Promise.withResolvers<void>();
      const originalHash = cryptoUtils.common.hash;
      const hash = spyOn(cryptoUtils.common, "hash").mockImplementation(async (...args) => {
        hashing.resolve();
        await proceed.promise;
        return originalHash(...args);
      });
      try {
        const state = await mountSession();
        await hashing.promise;
        expect(state.session.lease()).not.toBeNull();
        expect(state.session.status()).toBe("preparing");
        let ready = false;
        const initialized = state.session.ensureDraft().then(() => {
          ready = true;
        });
        const saving = state.session.persist();
        await flush();
        expect(ready).toBe(false);
        expect(JSON.parse(journal.getItem(key)!).content).toEqual(pending);
        expect(requests.filter((r) => r.method === "PUT" && !r.url.endsWith("/lease"))).toHaveLength(0);
        proceed.resolve();
        await initialized;
        expect(state.current()).toEqual(pending);
        expect(state.session.revisionConflict()).toBe(true);
        expect(await saving).toBeNull();
        expect(requests.filter((r) => r.method === "PUT" && !r.url.endsWith("/lease"))).toHaveLength(0);
      } finally {
        proceed.resolve();
        hash.mockRestore();
      }
    });

    test("persist rechecks a conflict discovered while reacquiring its own lease", async () => {
      const state = await mountSession();
      await state.session.ensureDraft();
      state.session.setLease(null);
      const pending = content("Offline input from an older revision", "local@example.test");
      openMailUserDraftStorage(localStorage, "Usr001").setItem(
        mailDraftJournalKey(MAILBOX_ID, DRAFT_ID),
        JSON.stringify({ revision: 1, content: pending }),
      );
      expect(await state.session.persist()).toBeNull();
      expect(state.current()).toEqual(pending);
      expect(state.session.revisionConflict()).toBe(true);
      expect(requests.filter((r) => r.method === "PUT" && !r.url.endsWith("/lease"))).toHaveLength(0);
      expect(stored.body).toBe("Local text");
    });

    test.each(["sign-in expired", "peer sent"] as const)("journal recovery preserves %s during its pending hash", async (change) => {
      openMailUserDraftStorage(localStorage, "Usr001").setItem(
        mailDraftJournalKey(MAILBOX_ID, DRAFT_ID),
        JSON.stringify({ revision: 1, content: content("Offline input", "local@example.test") }),
      );
      const hashing = Promise.withResolvers<void>();
      const proceed = Promise.withResolvers<void>();
      const originalHash = cryptoUtils.common.hash;
      const hash = spyOn(cryptoUtils.common, "hash").mockImplementation(async (...args) => {
        hashing.resolve();
        await proceed.promise;
        return originalHash(...args);
      });
      try {
        const state = await mountSession();
        await hashing.promise;
        const initialized = state.session.ensureDraft();
        respondWith(() =>
          change === "sign-in expired"
            ? Response.json({ message: "Session expired" }, { status: 401 })
            : Response.json({ ...stored, state: "sent", revision: 4 }),
        );
        const socket = FakeWebSocket.instances.at(-1)!;
        socket.open();
        socket.message({ t: "ready", id: "1", cursor: "s6t.mail.4" });
        socket.message({ t: "event", id: "1", cursor: "s6t.mail.5", data: { conversationId: "Conv01" } });
        await flush();
        expect(state.session.status()).toBe("readonly");
        const message = state.session.statusMessage();
        proceed.resolve();
        await initialized;
        expect(state.session.status()).toBe("readonly");
        expect(state.session.statusMessage()).toBe(message);
        expect(state.session.lease()).toBeNull();
        expect(state.session.authenticationRequired()).toBe(change === "sign-in expired");
        expect(Boolean(state.session.lifecycleTransition())).toBe(change === "peer sent");
        expect(state.current().body).toBe("Offline input");
        if (change === "peer sent") expect(state.session.lifecycleTransition()?.hasUnsavedChanges).toBe(true);
        await advance(1_000);
        expect(requests.filter((r) => r.method === "PUT" && !r.url.endsWith("/lease"))).toHaveLength(0);
      } finally {
        proceed.resolve();
        hash.mockRestore();
      }
    });

    test("an older journal keeps newer input visible and blocks overwriting the server across reloads", async () => {
      const journal = openMailUserDraftStorage(localStorage, "Usr001");
      const pending = content("Text typed after the lost answer", "local@example.test");
      journal.setItem(mailDraftJournalKey(MAILBOX_ID, DRAFT_ID), JSON.stringify({ revision: 1, content: pending }));
      for (let reload = 0; reload < 2; reload++) {
        const state = await mountSession();
        await state.session.ensureDraft();
        expect(state.current()).toEqual(pending);
        expect(state.session.revisionConflict()).toBe(true);
        expect(state.session.status()).toBe("error");
        expect(await state.session.persist()).toBeNull();
        expect(requests.filter((r) => r.method === "PUT" && !r.url.endsWith("/lease"))).toHaveLength(0);
        expect(JSON.parse(journal.getItem(mailDraftJournalKey(MAILBOX_ID, DRAFT_ID))!).revision).toBe(1);
        dispose();
      }
    });

    test("silent re-acquire preserves the old expectedRevision and local text for recovery-copy handling", async () => {
      const state = await mountSession();
      state.trace.length = 0;
      stored = { ...stored, body: "Foreign revision", revision: 8, recoveryCopyCount: 1 };
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

    test("Take over during the same-tab grace waits for the cancelled acquire and then holds the lease", async () => {
      acquireAnswer = (body) =>
        (body as { takeover?: boolean }).takeover
          ? Response.json({ ...lease, token: "takeover-token" })
          : Response.json({ code: "DRAFT_LEASE_HELD" }, { status: 409 });
      const state = await mountSession();
      expect(state.session.status()).toBe("preparing");
      state.session.stopHeartbeat();
      const acquired = await state.session.acquireLease(state.session.draft()!, true);
      await flush();
      expect(acquired?.token).toBe("takeover-token");
      healthy(state);
      expect(requests.filter((r) => r.method === "POST" && r.url.endsWith("/lease")).map((r) => r.body)).toMatchObject([
        { takeover: false },
        { takeover: true },
      ]);
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
      const firstAttempt = Promise.withResolvers<void>();
      saveAnswer = () => {
        attempts++;
        firstAttempt.resolve();
        return Response.json({ code: "DRAFT_LEASE_BUSY", message: "Raw server detail" }, { status: 409 });
      };
      state.setCurrent({ ...state.current(), body: "Unsaved text" });
      const saving = state.session.persist();
      // Native hashing must finish before advancing the retry clock.
      await firstAttempt.promise;
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
      const firstAttempt = Promise.withResolvers<void>();
      saveAnswer = (input) => {
        firstAttempt.resolve();
        return ++attempts === 1
          ? Response.json({ code: "DRAFT_LEASE_BUSY" }, { status: 409 })
          : Response.json({ ...stored, ...input.draft, revision: 4 });
      };
      state.setCurrent({ ...state.current(), body: "Retry this write" });
      const saving = state.session.persist();
      await firstAttempt.promise;
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
