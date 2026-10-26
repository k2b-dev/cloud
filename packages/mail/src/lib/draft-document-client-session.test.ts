import { expect, spyOn, test } from "bun:test";
import * as sharedText from "@k2b/cloud/browser/shared-text";
import { encoding } from "@k2b/stdlib";
import * as Y from "yjs";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { DraftEditableContent, MailDraft } from "../contracts";
import { createDraftDocument, readDraftDocument } from "./draft-document";
import { type MailDraftDocumentClient, openMailDraftDocumentClient } from "./draft-document-client";

const base: DraftEditableContent = {
  senderIdentityId: "Send01",
  signatureTemplateId: null,
  to: [{ name: null, address: "ada@example.test" }],
  cc: [],
  bcc: [],
  subject: "Offer",
  body: "Hello",
  format: "markdown",
  priority: "normal",
  requestReadReceipt: false,
  requestDeliveryReceipt: false,
};
const draft = (generation: string): MailDraft => ({
  ...base,
  signatureTemplateId: null,
  id: "Draft1",
  mailboxId: "Box001",
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  attachments: [],
  createdBy: { kind: "user", userId: "Usr001" },
  lastEditedBy: { kind: "user", userId: "Usr001" },
  lastEditedByDisplayName: "Ada",
  revision: 1,
  generation,
  editMode: "shared",
  recoveryCopyCount: 0,
  state: "draft",
  deliveryClass: "normal",
  createdAt: "2026-10-04T10:00:00.000Z",
  updatedAt: "2026-10-04T10:00:00.000Z",
});

// Real client/provider/Yjs with an in-memory transport. No browser process, database, or server is started.
const fixture = (generation = "1", closed = false, unavailableStorage = false) => {
  const dom = createDomTestHarness();
  const originals = new Map(
    ["fetch", "WebSocket", "localStorage", "indexedDB"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const document = createDraftDocument(base);
  const initial = Y.encodeStateAsUpdate(document);
  const requests: { url: string; body: unknown; cache: RequestCache | undefined }[] = [];
  let expired = false;
  let authenticationRequests = 0;
  const admitted: string[] = [];
  let currentUser = "Usr001";
  let switchAfterAuthorization = false;
  let restFailsOnce = false;
  let pendingGenerations: string[] = [];
  const generations = spyOn(sharedText, "listSharedTextOfflineGenerations").mockImplementation(async () => pendingGenerations);
  // Only the metadata enumeration is stubbed; native storage belongs to the browser suite.
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {} });
  let saveFails = false,
    revision = 1,
    durable = initial;
  const cursor = "s6t.fixture.1";
  const snapshot = (state: Uint8Array) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    try {
      return { state: encoding.toBase64(state), content: readDraftDocument(doc), cursor };
    } finally {
      doc.destroy();
    }
  };
  const session = () => ({
    generation,
    revision,
    lifecycle: closed ? "sent" : "draft",
    historyComplete: true,
    fresh: snapshot(Y.encodeStateAsUpdate(document)),
    durable: snapshot(durable),
    frozen: closed ? { generation, revision, cursor, state: encoding.toBase64(durable) } : null,
  });
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    sent: string[] = [];
    constructor(readonly url: string) {
      sockets.push(this);
      queueMicrotask(() => {
        if (this.readyState === 0) {
          if (expired || new URL(url).searchParams.get("expectedUserId") !== currentUser) {
            this.readyState = 3;
            // Browsers hide an HTTP 401/403 upgrade response behind an abnormal close.
            this.onclose?.({ code: 1006, reason: "" });
            return;
          }
          this.readyState = 1;
          this.onopen?.();
        }
      });
    }
    receive(type: string, payload: unknown) {
      this.onmessage?.({ data: JSON.stringify({ type, payload }) });
    }
    send(raw: string) {
      this.sent.push(raw);
      const packet: { type: string; payload: { payload?: string } } = JSON.parse(raw);
      if (packet.type === "replayRequest")
        queueMicrotask(() => this.receive("replayReady", { docId: "Draft1", generation, cursor, peerId: "peer1" }));
      if (packet.type === "syncPublish" && packet.payload.payload) {
        const payload = packet.payload.payload;
        Y.applyUpdate(document, encoding.fromBase64(payload));
        queueMicrotask(() => this.receive("syncPush", { docId: "Draft1", generation, updates: [{ generation, payload, cursor }] }));
      }
    }
    close() {
      this.readyState = 3;
    }
  }
  const fetcher = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, cache: init?.cache });
      if (expired) return Response.json({ message: "Session expired" }, { status: 401 });
      const parsed = new URL(url, "http://localhost");
      if (parsed.searchParams.get("expectedUserId") !== currentUser)
        return Response.json({ code: "DRAFT_ACCOUNT_MISMATCH", message: "Account changed" }, { status: 403 });
      admitted.push(parsed.pathname);
      if (parsed.pathname.endsWith("/snapshot")) {
        if (saveFails) return Response.json({ message: "durable storage failed" }, { status: 503 });
        durable = Y.encodeStateAsUpdate(document);
        revision++;
        return Response.json({ generation, status: "saved", revision, durable: snapshot(durable) });
      }
      if (parsed.pathname.endsWith("/rest")) {
        if (restFailsOnce) {
          restFailsOnce = false;
          return Response.json({ message: "Recovery answer lost" }, { status: 503 });
        }
        return Response.json({ status: "unchanged", durableSourceState: encoding.toBase64(durable) });
      }
      const response = Response.json(session());
      if (switchAfterAuthorization) {
        currentUser = "Usr002";
        switchAfterAuthorization = false;
      }
      return response;
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetcher });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeSocket });
  Object.defineProperty(
    globalThis,
    "localStorage",
    unavailableStorage
      ? {
          configurable: true,
          get: () => {
            throw new Error("device storage blocked");
          },
        }
      : { configurable: true, value: dom.window.localStorage },
  );
  let client: MailDraftDocumentClient | undefined;
  const controller = new AbortController();
  let lastRevision: number | undefined;
  return {
    requests,
    admitted,
    sockets,
    expireSession: () => {
      expired = true;
    },
    authenticationRequests: () => authenticationRequests,
    switchAccount: () => {
      currentUser = "Usr002";
    },
    switchAfterNextAuthorization: () => {
      switchAfterAuthorization = true;
    },
    closeDraft: () => {
      closed = true;
    },
    replaceGeneration: (next: string) => {
      generation = next;
    },
    loseRecoveryAnswer: () => {
      restFailsOnce = true;
    },
    pendingGenerations: (values: string[]) => {
      pendingGenerations = values;
    },
    disconnect: () => {
      for (const socket of sockets) {
        socket.readyState = 3;
        socket.onclose?.({ code: 1012, reason: "offline" });
      }
    },
    failSave: () => {
      saveFails = true;
    },
    allowSave: () => {
      saveFails = false;
    },
    lastRevision: () => lastRevision,
    open: async (ssrGeneration = generation, rememberDevice = false) => {
      client = await openMailDraftDocumentClient({
        mailboxId: "Box001",
        draft: draft(ssrGeneration),
        userId: "Usr001",
        signal: controller.signal,
        rememberDevice,
        locale: () => "en",
        onContent: () => {},
        onState: () => {},
        onFrozen: () => {},
        onAuthenticationRequired: () => {
          authenticationRequests++;
        },
        onDurable: (_content, revision) => {
          lastRevision = revision;
        },
      });
      await Bun.sleep(0);
      return client;
    },
    cleanup: async () => {
      controller.abort();
      client?.dispose();
      generations.mockRestore();
      for (const socket of sockets) socket.close();
      await Bun.sleep(0);
      document.destroy();
      dom.cleanup();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

test("shared initialization reports an expired session before opening a provider", async () => {
  const f = fixture();
  try {
    f.expireSession();
    await expect(f.open()).rejects.toThrow("Session expired");
    expect(f.authenticationRequests()).toBe(1);
    expect(f.sockets).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test("shared snapshot, table action, refresh and recovery report 401 to the owning session", async () => {
  const f = fixture();
  try {
    const client = await f.open();
    client.edit({ ...client.content(), body: "Pending input" });
    await Bun.sleep(0);
    f.expireSession();
    await expect(client.save()).rejects.toThrow("Session expired");
    expect((await client.postAction({ generation: "1", actionId: "action" }, new AbortController().signal)).status).toBe(401);
    await expect(client.refresh()).rejects.toThrow("Session expired");
    await expect(client.recover()).rejects.toThrow("Session expired");
    expect(f.authenticationRequests()).toBe(4);
    expect(client.content().body).toBe("Pending input");
    expect(client.state().dirty).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("an expired socket session also requests sign-in while retaining unsaved input", async () => {
  const f = fixture();
  try {
    const client = await f.open();
    client.edit({ ...client.content(), body: "Pending input" });
    f.sockets[0]!.receive("error", { docId: "Draft1", code: "SESSION_EXPIRED", message: "Session expired" });
    expect(f.authenticationRequests()).toBe(1);
    expect(client.state()).toMatchObject({ terminal: true, dirty: true });
    expect(client.content().body).toBe("Pending input");
  } finally {
    await f.cleanup();
  }
});

test("retry after a rejected socket handshake requests sign-in through HTTP and retains unsaved input", async () => {
  const f = fixture();
  try {
    const client = await f.open();
    f.disconnect();
    client.edit({ ...client.content(), body: "Pending disconnected input" });
    f.expireSession();
    // Exercise the same failed upgrade as an automatic reconnect; no protocol packet can arrive.
    client.provider.reconnectNow();
    await Bun.sleep(0);
    expect(f.sockets).toHaveLength(2);
    expect(f.sockets[1]!.readyState).toBe(3);
    expect(f.sockets[1]!.sent).toEqual([]);
    expect(client.state()).toMatchObject({ connected: false, ready: false, dirty: true });
    expect(f.authenticationRequests()).toBe(0);
    await expect(client.retry()).rejects.toThrow("Session expired");
    expect(f.authenticationRequests()).toBe(1);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]!.body).toBeNull();
    expect(new URL(f.requests[1]!.url, "http://localhost").pathname).toEndWith("/document");
    expect(f.sockets).toHaveLength(2);
    expect(client.content().body).toBe("Pending disconnected input");
    expect(await client.flushLocal()).toBe(false);
    await expect(client.retry()).rejects.toThrow("Session expired");
    expect(f.authenticationRequests()).toBe(2);
    expect(f.sockets).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
});

test.each(["closed", "replaced"])("disconnected retry recovers a %s draft without reconnecting the old generation", async (change) => {
  const f = fixture();
  try {
    const client = await f.open();
    f.disconnect();
    client.edit({ ...client.content(), body: "Pending disconnected input" });
    if (change === "closed") f.closeDraft();
    else f.replaceGeneration("2");
    expect(await client.retry()).toMatchObject({ status: "unchanged" });
    expect(f.sockets).toHaveLength(1);
    const recovery = f.requests.find((request) => new URL(request.url, "http://localhost").pathname.endsWith("/rest"));
    expect(recovery?.body).toMatchObject({ generation: "1" });
    expect(client.generation).toBe("1");
    expect(client.content().body).toBe("Pending disconnected input");
    expect(client.state()).toMatchObject({ connected: false, ready: false, dirty: true });
    expect(f.authenticationRequests()).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("real session: transport echo stays dirty; durable save fences generation and advances Mail revision", async () => {
  const f = fixture();
  try {
    const client = await f.open();
    client.edit({ ...client.content(), subject: "Local subject", body: "Hello device" });
    await Bun.sleep(0);
    expect(client.provider.hasUnsentChanges()).toBe(false);
    expect(client.state().dirty).toBe(true);
    expect(f.lastRevision()).toBeUndefined();
    f.failSave();
    await expect(client.save()).rejects.toThrow("durable storage failed");
    expect(client.state().dirty).toBe(true);
    expect(client.content().body).toBe("Hello device");
    f.allowSave();
    await client.save();
    expect(f.lastRevision()).toBe(2);
    expect(client.state().dirty).toBe(false);
    expect(f.requests.find((request) => new URL(request.url, "http://localhost").pathname.endsWith("/snapshot"))?.body).toEqual({
      generation: "1",
    });
    expect(f.requests.some((request) => request.url.includes("lease"))).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("old SSR generation without offline bytes opens the freshly authorized generation once, then unchanged creates no Rest draft", async () => {
  const f = fixture("2", true);
  try {
    const client = await f.open("1");
    await client.recover(); // Recovery now includes an asynchronous content fingerprint.
    expect(client.generation).toBe("2");
    expect(f.requests.filter((request) => new URL(request.url, "http://localhost").pathname.endsWith("/document"))).toHaveLength(3); // two opens, one recovery authorization
    expect(client.state().restUnchanged).toBe(true);
    expect(client.state().recoveryDraft).toBeNull();
    expect(client.state().dirty).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("explicit device opt-out works even when localStorage is blocked", async () => {
  const f = fixture("1", false, true);
  try {
    const client = await f.open();
    expect(client.state().remembering).toBe(false);
    client.edit({ ...client.content(), body: "Memory only" });
    expect(await client.flushLocal()).toBe(false);
    expect(client.content().body).toBe("Memory only");
    await Bun.sleep(0);
    await client.save();
    expect(await client.flushLocal()).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("a structural action still guards navigation after its connection drops", async () => {
  const f = fixture();
  try {
    const client = await f.open();
    const pending = client.provider.beginAction("structural-action-1");
    expect(client.state().structuring).toBe(true);
    f.disconnect();
    expect(client.state().connected).toBe(false);
    expect(client.state().structuring).toBe(true);
    const event = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    pending.cancel(new Error("explicitly stopped waiting"));
    await Bun.sleep(0);
    expect(client.state().structuring).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("SSR account A cannot open the same authorized draft under current account B", async () => {
  const f = fixture();
  try {
    f.switchAccount();
    await expect(f.open()).rejects.toThrow("Account changed");
    expect(f.admitted).toEqual([]);
    expect(f.sockets).toHaveLength(0);
    expect(new URL(f.requests[0]!.url, "http://localhost").searchParams.get("expectedUserId")).toBe("Usr001");
  } finally {
    await f.cleanup();
  }
});

test("SSR A / authorized B fails before the offline boundary can load A's bytes", async () => {
  const f = fixture();
  let loaded = false;
  const offline = spyOn(sharedText, "openAuthorizedSharedTextOffline").mockImplementation(async (identity, authorize, signal) => {
    expect(identity.userId).toBe("Usr001");
    await authorize(signal ?? new AbortController().signal);
    loaded = true;
    throw new Error("A's private bytes would have loaded");
  });
  try {
    f.switchAccount();
    await expect(f.open("1", true)).rejects.toThrow("Account changed");
    expect(offline).toHaveBeenCalledTimes(1);
    expect(loaded).toBe(false);
    expect(f.sockets).toHaveLength(0);
  } finally {
    offline.mockRestore();
    await f.cleanup();
  }
});

test("an external body compile failure changes no header or body and leaves visible recovery feedback", async () => {
  const f = fixture();
  try {
    const client = await f.open();
    const original = Y.encodeStateAsUpdate(client.doc);
    const clock = spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(1000);
    try {
      expect(() => client.edit({ ...client.content(), subject: "Changed header", body: "Entirely different body" })).toThrow(
        "applied safely",
      );
    } finally {
      clock.mockRestore();
    }
    expect(Y.encodeStateAsUpdate(client.doc)).toEqual(original);
    expect(client.state()).toMatchObject({ error: true });
    expect(client.state().message).toContain("Keep your proposed text");
    expect(await client.flushLocal()).toBe(false);
    await expect(client.save()).rejects.toThrow("applied safely");
    const event = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    client.edit(client.content()); // The person explicitly reverted the proposal.
    expect(await client.flushLocal()).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("a delayed provider reconnect retains SSR A and cannot publish local bytes under B", async () => {
  const f = fixture();
  try {
    const client = await f.open();
    f.disconnect();
    client.edit({ ...client.content(), body: "A's pending private bytes" });
    f.switchAccount();
    client.provider.reconnectNow();
    await Bun.sleep(0);
    expect(f.sockets).toHaveLength(2);
    expect(f.sockets.every((socket) => new URL(socket.url).searchParams.get("expectedUserId") === "Usr001")).toBe(true);
    expect(f.sockets[1]!.sent).toEqual([]);
    expect(client.state()).toMatchObject({ connected: false, ready: false, dirty: true });
    expect(client.content().body).toBe("A's pending private bytes");
  } finally {
    await f.cleanup();
  }
});

test("snapshot and table POSTs bind their own request after a successful GET", async () => {
  const f = fixture();
  try {
    const client = await f.open();
    client.edit({ ...client.content(), body: "Unsent A text" });
    await Bun.sleep(0);
    f.switchAccount();
    await expect(client.save()).rejects.toThrow("Account changed");
    expect((await client.postAction({ generation: "1", actionId: "A-action" }, new AbortController().signal)).status).toBe(403);
    await expect(client.refresh()).rejects.toThrow("Account changed");
    expect(f.admitted).toHaveLength(1); // the original GET only
    expect(client.state().dirty).toBe(true);
    expect(f.requests.every((request) => new URL(request.url, "http://localhost").searchParams.get("expectedUserId") === "Usr001")).toBe(
      true,
    );
    expect(f.requests.every((request) => request.cache === "no-store")).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("switching after recovery authorization cannot admit A's Rest body under B", async () => {
  const f = fixture();
  try {
    const client = await f.open();
    f.closeDraft();
    f.switchAfterNextAuthorization();
    await expect(client.recover()).rejects.toThrow("Account changed");
    const rest = f.requests.find((request) => new URL(request.url, "http://localhost").pathname.endsWith("/rest"));
    expect(rest?.body).toMatchObject({ generation: "1" });
    expect(f.admitted.some((path) => path.endsWith("/rest"))).toBe(false);
    expect(client.state().restUnchanged).toBe(false);
    expect(client.state().recoveryDraft).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test("retry after a lost recovery answer reuses the immutable content request ID", async () => {
  const f = fixture();
  try {
    const client = await f.open();
    f.closeDraft();
    f.loseRecoveryAnswer();
    await expect(client.recover()).rejects.toThrow("Recovery answer lost");
    await client.recover();
    const attempts = f.requests.filter((request) => new URL(request.url, "http://localhost").pathname.endsWith("/rest"));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.body).toEqual(attempts[1]!.body);
  } finally {
    await f.cleanup();
  }
});

test("IndexedDB pending keys recover an old generation even when another tab removed its localStorage marker", async () => {
  const f = fixture("2", true);
  const source = createDraftDocument({ ...base, body: "Older offline input" });
  const bytes = Y.encodeStateAsUpdate(source);
  const controller = new AbortController();
  let openedGeneration: string | undefined;
  const offline = spyOn(sharedText, "openAuthorizedSharedTextOffline").mockImplementation(async (identity, authorize) => {
    openedGeneration = identity.generation;
    const authorization = await authorize(controller.signal);
    return {
      authorization,
      state: bytes,
      baseCursor: "s6t.fixture.1",
      session: {
        signal: controller.signal,
        load: async () => bytes,
        loadPending: async () => ({ state: bytes, baseCursor: "s6t.fixture.1" }),
        save: async () => bytes,
        acknowledgeSnapshot: async () => false,
        forget: async () => {},
        close: () => {
          controller.abort();
        },
      },
    };
  });
  try {
    // Persisted key survives the schedule: queued B save -> A marker cleanup -> B save commit.
    // Generation 2 arrives with SSR; the localStorage marker is deliberately absent.
    f.pendingGenerations(["10", "2", "1"]);
    const client = await f.open("2", true);
    await client.recover();
    expect(openedGeneration).toBe("1");
    expect(client.generation).toBe("1");
    expect(client.content().body).toBe("Older offline input");
    expect(client.state().terminal).toBe(true);
    expect(f.sockets).toHaveLength(0);
  } finally {
    offline.mockRestore();
    await f.cleanup();
    source.destroy();
  }
});

test("explicit memory-only mode cannot skip an IndexedDB-discovered pending generation", async () => {
  const f = fixture("2");
  try {
    f.pendingGenerations(["1"]);
    await expect(f.open("2", false)).rejects.toThrow("could not save your changes");
    expect(f.requests).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("explicit memory-only mode also works when the browser exposes no IndexedDB API", async () => {
  const f = fixture();
  try {
    Reflect.deleteProperty(globalThis, "indexedDB");
    const client = await f.open("1", false);
    expect(client.state().remembering).toBe(false);
  } finally {
    await f.cleanup();
  }
});
