import { afterEach, beforeEach, expect, jest, setSystemTime, spyOn, test } from "bun:test";
import { encoding } from "@k2b/stdlib";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import {
  createSharedTextProvider,
  SHARED_TEXT_ACK_TIMEOUT_MS,
  type SharedTextProviderError,
  type SharedTextProviderMessage,
  type SharedTextProviderOptions,
  type SharedTextProviderPendingState,
  type SharedTextProviderRequest,
  type SharedTextProviderSnapshot,
} from "./shared-text";

const DOC_ID = "00000000-0000-4000-8000-000000000001";
const GENERATION = "opaque:generation/a";
class Socket {
  static readonly OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  sent: SharedTextProviderRequest[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(message: SharedTextProviderMessage<string, { name: string }>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  ready(generation = GENERATION) {
    this.message({ type: "replayReady", payload: { docId: DOC_ID, generation, cursor: "s6t.test.1", peerId: "own-peer" } });
  }
  sync(payload: string, cursor = "s6t.test.2", snapshot = false) {
    this.message({ type: "syncPush", payload: { docId: DOC_ID, generation: GENERATION, snapshot, updates: [{ payload, cursor }] } });
  }
}
const originalWebSocket = globalThis.WebSocket;
const cleanups: (() => void)[] = [];
beforeEach(() => {
  Socket.instances = [];
  Object.assign(globalThis, { WebSocket: Socket });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  Object.assign(globalThis, { WebSocket: originalWebSocket });
});
const doc = (clientID: number) => {
  const value = new Y.Doc();
  value.clientID = clientID;
  cleanups.push(() => value.destroy());
  return value;
};
const fixture = (options: Partial<SharedTextProviderOptions<string, { name: string }>> = {}) => {
  const local = options.doc ?? doc(101);
  const awareness = new Awareness(local);
  cleanups.push(() => awareness.destroy());
  const provider = createSharedTextProvider({
    doc: local,
    docId: DOC_ID,
    initialGeneration: GENERATION,
    initialCursor: "s6t.test.1",
    awareness,
    maxSyncPayloadLength: 8_000_000,
    reconnectDelayMs: () => 2_000,
    terminalErrorCodes: ["ACCESS_REVOKED", "BACKPRESSURE"],
    transport: {
      url: "wss://example.invalid/api/drafts/ws",
      encode: (request) => request,
      // This fixture sends normalized messages. Production adapters validate unknown wire input.
      decode: (packet) => packet as SharedTextProviderMessage<string, { name: string }>,
      closeError: (code) => (code === 1008 ? { code: "ACCESS_REVOKED", message: "Access revoked" } : null),
    },
    ...options,
  });
  cleanups.push(() => provider.dispose());
  provider.connect();
  const socket = Socket.instances.at(-1)!;
  socket.open();
  return { provider, socket, local, awareness };
};
const publishes = (socket: Socket) => socket.sent.filter((request) => request.type === "syncPublish");

test.each(["handshake", "replay"])("a stalled %s reconnects without a close event and retains edits until their echo", (phase) => {
  jest.useFakeTimers();
  setSystemTime(new Date("2026-11-18T08:00:00Z"));
  try {
    const errors: SharedTextProviderError[] = [];
    const connections: boolean[] = [];
    const { provider, socket, local } = fixture({
      onError: (error) => errors.push(error),
      onConnectionChange: (connected) => connections.push(connected),
    });
    if (phase === "handshake") {
      // Retire the initial connection and leave its replacement in CONNECTING.
      socket.close();
      provider.reconnectNow();
      Socket.instances.at(-1)!.readyState = 0;
    }
    const stalled = Socket.instances.at(-1)!;
    local.getText("codemirror").insert(0, "Text typed while connecting");
    jest.advanceTimersByTime(SHARED_TEXT_ACK_TIMEOUT_MS - 1);
    expect(stalled.readyState).toBe(phase === "handshake" ? 0 : Socket.OPEN);
    jest.advanceTimersByTime(1);
    expect(stalled.readyState).toBe(3);
    expect(connections.at(-1)).toBe(false);
    expect(errors.at(-1)?.code).toBe("SYNC_TIMEOUT");
    jest.advanceTimersByTime(2_000);
    const replacement = Socket.instances.at(-1)!;
    expect(replacement).not.toBe(stalled);
    replacement.open();
    replacement.ready();
    expect(provider.hasUnsentChanges()).toBe(true);
    const pending = publishes(replacement)[0]!;
    expect(pending.payload.baseCursor).toBe("s6t.test.1");
    expect(provider.recoveryInput().text).toBe("Text typed while connecting");
    // Queued callbacks from the abandoned connection cannot disturb recovery.
    stalled.ready("obsolete-generation");
    stalled.onclose?.({ code: 1006, reason: "late close" });
    replacement.sync(pending.payload.payload);
    expect(provider.hasUnsentChanges()).toBe(false);
    jest.advanceTimersByTime(SHARED_TEXT_ACK_TIMEOUT_MS * 2);
    expect(Socket.instances.at(-1)).toBe(replacement);
    expect(replacement.readyState).toBe(Socket.OPEN);
  } finally {
    jest.useRealTimers();
  }
});

test("an unacknowledged update closes a silent socket and reconnects with its original input base", () => {
  jest.useFakeTimers();
  setSystemTime(new Date("2026-11-09T12:00:00Z"));
  try {
    const errors: SharedTextProviderError[] = [];
    const { provider, socket, local } = fixture({ onError: (error) => errors.push(error) });
    socket.ready();
    local.getText("codemirror").insert(0, "Unacknowledged text");
    const first = publishes(socket)[0]!;
    jest.advanceTimersByTime(SHARED_TEXT_ACK_TIMEOUT_MS / 2);
    local.getText("codemirror").insert(local.getText("codemirror").length, " with later typing");
    socket.sync(publishes(socket).at(-1)!.payload.payload);
    jest.advanceTimersByTime(SHARED_TEXT_ACK_TIMEOUT_MS / 2 - 1);
    expect(socket.readyState).toBe(1);
    jest.advanceTimersByTime(1);
    expect(socket.readyState).toBe(3);
    expect(errors.at(-1)?.code).toBe("SYNC_TIMEOUT");
    expect(provider.hasUnsentChanges()).toBe(true);
    jest.advanceTimersByTime(2_000);
    expect(Socket.instances).toHaveLength(2);
    const replacement = Socket.instances[1]!;
    replacement.open();
    replacement.ready();
    expect(publishes(replacement)[0]!.payload.baseCursor).toBe(first.payload.baseCursor);
    expect(provider.recoveryInput().text).toBe("Unacknowledged text with later typing");
    jest.advanceTimersByTime(SHARED_TEXT_ACK_TIMEOUT_MS);
    expect(replacement.readyState).toBe(3);
    expect(errors.filter((error) => error.code === "SYNC_TIMEOUT")).toHaveLength(2);
    expect(provider.hasUnsentChanges()).toBe(true);
    provider.dispose();
    jest.advanceTimersByTime(SHARED_TEXT_ACK_TIMEOUT_MS * 2);
    expect(Socket.instances).toHaveLength(2);
  } finally {
    jest.useRealTimers();
  }
});

test("opaque generations and UUID document IDs preserve replay-before-write ordering and original bases", () => {
  const { provider, socket, local } = fixture();
  expect(socket.url).toBe("wss://example.invalid/api/drafts/ws");
  expect(socket.sent).toEqual([{ type: "replayRequest", payload: { docId: DOC_ID, generation: GENERATION, fromCursor: "s6t.test.1" } }]);
  local.getText("codemirror").insert(0, "offline");
  expect(publishes(socket)).toHaveLength(0);
  socket.ready();
  expect(publishes(socket)[0]?.payload).toMatchObject({ docId: DOC_ID, generation: GENERATION, baseCursor: "s6t.test.1" });
  expect(socket.sent.at(-1)?.type).toBe("awarenessPublish");
  expect(provider.hasUnsentChanges()).toBe(true);
  const publication = publishes(socket)[0]!;
  socket.sync(publication.payload.payload);
  expect(provider.hasUnsentChanges()).toBe(false);
});

test("a different opaque generation fences both historical deletes and queued ready packets without losing recovery input", () => {
  const base = doc(202);
  base.getText("codemirror").insert(0, "KEEP");
  const local = doc(101);
  Y.applyUpdate(local, Y.encodeStateAsUpdate(base));
  const errors: SharedTextProviderError[] = [];
  const { provider, socket } = fixture({ doc: local, onFatal: (error) => errors.push(error) });
  socket.ready();
  local.getText("codemirror").insert(4, " local");
  const pending = provider.recoveryInput();
  base.getText("codemirror").delete(0, 4);
  socket.message({
    type: "syncPush",
    payload: { docId: DOC_ID, generation: "replacement", updates: [{ payload: encoding.toBase64(Y.encodeStateAsUpdate(base)) }] },
  });
  socket.ready();
  provider.resume();
  expect(local.getText("codemirror").toString()).toBe("KEEP local");
  expect(provider.recoveryInput()).toEqual(pending);
  expect(provider.generation()).toBe(GENERATION);
  expect(errors.map((error) => error.code)).toEqual(["RESYNC_REQUIRED"]);
  expect(Socket.instances).toHaveLength(1);
});

test("ready generation mismatch never publishes hydrated or offline input", () => {
  const errors: string[] = [];
  const { local, provider, socket } = fixture({ onFatal: (error) => errors.push(error.code) });
  local.getText("codemirror").insert(0, "save me");
  socket.ready("closed-generation");
  expect(errors).toEqual(["RESYNC_REQUIRED"]);
  expect(publishes(socket)).toHaveLength(0);
  expect(provider.pendingState().text).toBe("save me");
  provider.resume();
  expect(Socket.instances).toHaveLength(1);
});

test("old sockets cannot apply input or change presence after reconnect; cleanup removes listeners", () => {
  const participants: string[] = [];
  const { local, provider, socket } = fixture({ onPresenceChange: (people) => participants.push(...people.map((person) => person.name)) });
  socket.ready();
  socket.close();
  provider.reconnectNow();
  const next = Socket.instances.at(-1)!;
  next.open();
  next.ready();
  const remote = doc(202);
  remote.getText("codemirror").insert(0, "stale");
  socket.sync(encoding.toBase64(Y.encodeStateAsUpdate(remote)));
  socket.message({ type: "presence", payload: { docId: DOC_ID, participants: [{ name: "old" }] } });
  next.message({ type: "presence", payload: { docId: DOC_ID, generation: GENERATION, participants: [{ name: "current" }] } });
  expect(local.getText("codemirror").toString()).toBe("");
  expect(participants).toEqual(["current"]);
  const before = next.sent.length;
  provider.dispose();
  local.getText("codemirror").insert(0, "after disposal");
  next.sync(encoding.toBase64(Y.encodeStateAsUpdate(remote)));
  expect(next.sent).toHaveLength(before);
  expect(local.getText("codemirror").toString()).toBe("after disposal");
});

test("local durable notifications precede publication; echo and ready do not imply a durable snapshot", () => {
  const stored: SharedTextProviderPendingState[] = [];
  const snapshots: SharedTextProviderSnapshot[] = [];
  const { local, provider, socket } = fixture({
    onLocalUpdate: (pending) => {
      expect(publishes(Socket.instances.at(-1)!)).toHaveLength(0);
      stored.push(pending);
    },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  socket.ready();
  local.getText("codemirror").insert(0, "retained until snapshot");
  const publication = publishes(socket)[0]!;
  socket.sync(publication.payload.payload);
  expect(provider.hasUnsentChanges()).toBe(false);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ docId: DOC_ID, generation: GENERATION, text: "retained until snapshot", baseCursor: "s6t.test.1" });
  expect(snapshots).toEqual([]);
  // A later durable server snapshot contains only server state, never unconfirmed local input.
  const server = doc(202);
  server.getText("codemirror").insert(0, "server");
  socket.sync(encoding.toBase64(Y.encodeStateAsUpdate(server)), "s6t.test.3", true);
  expect(snapshots).toHaveLength(1);
  const covered = doc(303);
  Y.applyUpdate(covered, snapshots[0]!.state);
  expect(covered.getText("codemirror").toString()).toBe("server");
  expect(snapshots[0]).toMatchObject({ docId: DOC_ID, generation: GENERATION, cursor: "s6t.test.3" });
  expect(stored).toHaveLength(1);
});

test("hydration restores exact pending bytes and original base before replay and resends echoed-but-not-snapshotted input", () => {
  const writes: SharedTextProviderPendingState[] = [];
  const first = fixture({ onLocalUpdate: (state) => writes.push(state) });
  first.socket.ready();
  first.local.getText("codemirror").insert(0, "recover");
  const publication = publishes(first.socket)[0]!;
  const unechoed = first.provider.pendingState();
  first.socket.sync(publication.payload.payload);
  first.provider.dispose();
  // Offline storage may contain either a pending export or the local-input callback before echo.
  for (const saved of [unechoed, writes[0]!]) {
    const next = fixture({ doc: doc(saved === unechoed ? 303 : 404), initialPending: saved });
    expect(next.provider.hasUnsentChanges()).toBe(true);
    expect(next.local.getText("codemirror").toString()).toBe("recover");
    expect(next.provider.recoveryInput().pending).toEqual(saved.pending);
    expect(publishes(next.socket)).toHaveLength(0);
    next.socket.ready();
    expect(publishes(next.socket)[0]?.payload).toMatchObject({ generation: GENERATION, baseCursor: "s6t.test.1" });
    next.socket.sync(publishes(next.socket)[0]!.payload.payload);
    expect(next.provider.hasUnsentChanges()).toBe(false);
  }
});

test("hydration rejects another document, a closed generation, or malformed bytes before mutation", () => {
  const remote = doc(202);
  remote.getText("codemirror").insert(0, "must not apply");
  const state: SharedTextProviderPendingState = {
    docId: DOC_ID,
    generation: GENERATION,
    state: Y.encodeStateAsUpdate(remote),
    text: "must not apply",
    pending: [],
    baseCursor: "s6t.test.1",
  };
  for (const saved of [
    { ...state, docId: "another" },
    { ...state, generation: "retired" },
    { ...state, state: new Uint8Array([255]) },
    { ...state, pending: [{ payload: "/w==", baseCursor: null }] },
  ]) {
    const local = doc(101);
    expect(() => fixture({ doc: local, initialPending: saved })).toThrow();
    expect(local.getText("codemirror").toString()).toBe("");
    expect(local.store.clients.size).toBe(0);
  }
});

test("malformed snapshots stop visibly and cannot acknowledge durable coverage", () => {
  const snapshots: SharedTextProviderSnapshot[] = [];
  const failures: string[] = [];
  const { socket, provider } = fixture({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onFatal: (error) => failures.push(error.code),
  });
  socket.ready();
  socket.message({
    type: "syncPush",
    payload: {
      docId: DOC_ID,
      generation: GENERATION,
      snapshot: true,
      updates: [
        { payload: "AAA=", cursor: "s6t.test.2" },
        { payload: "/w==", cursor: "s6t.test.3" },
      ],
    },
  });
  expect(failures).toEqual(["INVALID_PAYLOAD"]);
  expect(snapshots).toEqual([]);
  provider.resume();
  const next = Socket.instances.at(-1)!;
  next.open();
  expect(next.sent[0]).toMatchObject({ type: "replayRequest", payload: { fromCursor: "s6t.test.2" } });
});

test("trusted awareness sends only local state and suppresses its rewritten server echo", () => {
  const { local, awareness, socket } = fixture();
  awareness.setLocalState({ user: { name: "local" }, cursor: null });
  socket.ready();
  const remote = doc(202);
  const remoteAwareness = new Awareness(remote);
  cleanups.push(() => remoteAwareness.destroy());
  remoteAwareness.setLocalState({ user: { name: "trusted remote" } });
  const payload = encoding.toBase64(encodeAwarenessUpdate(remoteAwareness, [remote.clientID]));
  socket.message({
    type: "awarenessPush",
    payload: { docId: DOC_ID, generation: GENERATION, updates: [{ payload, originPeerId: "own-peer" }] },
  });
  expect(awareness.getStates().has(remote.clientID)).toBe(false);
  socket.message({
    type: "awarenessPush",
    payload: { docId: DOC_ID, generation: GENERATION, updates: [{ payload, originPeerId: "remote-peer" }] },
  });
  expect(awareness.getStates().get(remote.clientID)?.user.name).toBe("trusted remote");
  const publications = socket.sent.filter((request) => request.type === "awarenessPublish");
  expect(publications).toHaveLength(1);
  expect(awareness.getStates().has(local.clientID)).toBe(true);
});

test("a burst of cursor moves sends the first and then only the latest state per interval", () => {
  const timers: { run: () => void; delay: number }[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  Object.assign(globalThis, {
    setTimeout: (run: () => void, delay: number) =>
      delay === SHARED_TEXT_ACK_TIMEOUT_MS ? originalSetTimeout(run, delay) : timers.push({ run, delay }),
  });
  cleanups.push(() => Object.assign(globalThis, { setTimeout: originalSetTimeout }));
  const { awareness, socket } = fixture();
  socket.ready();
  const frames = () => socket.sent.filter((request) => request.type === "awarenessPublish");
  const before = frames().length;
  // A selection drag reports every pointer move; each frame would cost the server an access check and a publish.
  for (let head = 0; head < 60; head++) awareness.setLocalStateField("cursor", { anchor: 0, head });
  expect(frames()).toHaveLength(before + 1);
  expect(timers.map((timer) => timer.delay)).toEqual([100]);
  timers.shift()!.run();
  expect(frames()).toHaveLength(before + 2);
  const latest = new Awareness(doc(303));
  cleanups.push(() => latest.destroy());
  applyAwarenessUpdate(latest, encoding.fromBase64(frames().at(-1)!.payload.payload), "remote");
  expect([...latest.getStates().values()].at(-1)?.cursor).toEqual({ anchor: 0, head: 59 });
  // The trailing frame opens one more interval; without new moves it sends nothing.
  timers.shift()!.run();
  expect(frames()).toHaveLength(before + 2);
  expect(timers).toHaveLength(0);
});

test("a busy server or proxy reconnects with backoff and keeps unsent input instead of stopping", () => {
  const timers: { run: () => void; delay: number }[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  Object.assign(globalThis, { setTimeout: (run: () => void, delay: number) => timers.push({ run, delay }) });
  cleanups.push(() => Object.assign(globalThis, { setTimeout: originalSetTimeout }));
  const fatal: string[] = [];
  // Even an adapter that maps 1013 or BACKPRESSURE to a terminal error cannot end the session for an overload.
  const { provider, socket, local } = fixture({
    onFatal: (error) => fatal.push(error.code),
    terminalErrorCodes: ["ACCESS_REVOKED", "BACKPRESSURE"],
    transport: {
      url: "wss://example.invalid/api/drafts/ws",
      encode: (request) => request,
      decode: (packet) => packet as SharedTextProviderMessage<string, { name: string }>,
      closeError: () => ({ code: "ACCESS_REVOKED", message: "Access revoked" }),
    },
  });
  socket.ready();
  local.getText("codemirror").insert(0, "busy");
  const [unsent] = publishes(socket);
  socket.message({ type: "error", payload: { code: "BACKPRESSURE", message: "Too many messages" } });
  expect(socket.readyState).toBe(3);
  socket.onclose?.({ code: 1013, reason: "BACKPRESSURE" });
  expect(fatal).toEqual([]);
  expect(provider.hasUnsentChanges()).toBe(true);
  timers.find((timer) => timer.delay === 2_000)!.run();
  const next = Socket.instances.at(-1)!;
  expect(next).not.toBe(socket);
  next.open();
  next.ready();
  expect(publishes(next).map((request) => request.payload.payload)).toEqual([unsent!.payload.payload]);
});

test("the socket guard's sign-in expiry ends every adapter's session as SESSION_EXPIRED; other policy closes keep the adapter's mapping", () => {
  const fatal: string[] = [];
  // The fixture adapter maps every 1008 close to lost access, as an adapter that ignores the reason would.
  const expired = fixture({ onFatal: (error) => fatal.push(error.code) });
  expired.socket.ready();
  expired.local.getText("codemirror").insert(0, "typed before expiry");
  expired.socket.onclose?.({ code: 1008, reason: "SESSION_EXPIRED" });
  expired.provider.reconnectNow();
  expect(Socket.instances).toHaveLength(1);
  expect(expired.provider.pendingState().text).toBe("typed before expiry");
  expect(expired.provider.hasUnsentChanges()).toBe(true);

  const denied = fixture({ onFatal: (error) => fatal.push(error.code) });
  denied.socket.onclose?.({ code: 1008, reason: "app_access_denied" });
  expect(fatal).toEqual(["SESSION_EXPIRED", "ACCESS_REVOKED"]);
});

/** A page on the socket's origin whose sign-in check answers as `answer` decides; every check is recorded. */
const sessionCheckPage = (origin: string, answer: (signal: AbortSignal) => Promise<Response>) => {
  const checks: { url: string; signal: AbortSignal }[] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin } });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      checks.push({ url: String(input), signal: init!.signal! });
      return answer(init!.signal!);
    },
    { preconnect: originalFetch.preconnect },
  );
  cleanups.push(() => {
    globalThis.fetch = originalFetch;
    if (original) Object.defineProperty(globalThis, "location", original);
    else delete (globalThis as { location?: unknown }).location;
  });
  return checks;
};
const settle = async () => {
  for (let round = 0; round < 10; round++) await Promise.resolve();
};

test("a reconnect refused after the sign-in expired ends the session as SESSION_EXPIRED and keeps the text", async () => {
  jest.useFakeTimers();
  cleanups.push(() => jest.useRealTimers());
  const checks = sessionCheckPage("https://example.invalid", async () => new Response(null, { status: 401 }));
  const errors: string[] = [];
  const fatal: string[] = [];
  const { provider, socket, local } = fixture({ onError: (error) => errors.push(error.code), onFatal: (error) => fatal.push(error.code) });
  socket.ready();
  // The network drops an open socket: a plain drop, no check yet.
  socket.onclose?.({ code: 1006, reason: "" });
  local.getText("codemirror").insert(0, "typed while disconnected");
  expect(checks).toHaveLength(0);
  jest.advanceTimersByTime(2_000);
  // The sign-in expired meanwhile: the upgrade answers 401, which the browser sees only as a close without opening.
  Socket.instances.at(-1)!.onclose?.({ code: 1006, reason: "" });
  expect(checks.map((check) => check.url)).toEqual(["https://example.invalid/api/me/browser"]);
  await settle();
  expect(errors).toEqual(["SESSION_EXPIRED"]);
  expect(fatal).toEqual(["SESSION_EXPIRED"]);
  // No further attempts: the session waits for sign-in with the text kept.
  jest.advanceTimersByTime(60_000);
  expect(Socket.instances).toHaveLength(2);
  expect(provider.pendingState().text).toBe("typed while disconnected");
  expect(provider.hasUnsentChanges()).toBe(true);
});

test("a reconnect refused without an expired sign-in keeps reconnecting; an opened socket cancels the check", async () => {
  jest.useFakeTimers();
  cleanups.push(() => jest.useRealTimers());
  const pending: { resolve: (response: Response) => void }[] = [];
  const checks = sessionCheckPage("https://example.invalid", (signal) => {
    if (pending.length === 0) return Promise.reject(new TypeError("Failed to fetch")); // The network is still down.
    return new Promise<Response>((resolve, reject) => {
      pending.at(-1)!.resolve = resolve;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const fatal: string[] = [];
  const { provider, socket, local } = fixture({ onFatal: (error) => fatal.push(error.code) });
  socket.ready();
  local.getText("codemirror").insert(0, "typed before the drop");
  socket.onclose?.({ code: 1006, reason: "" });
  jest.advanceTimersByTime(2_000);
  Socket.instances.at(-1)!.onclose?.({ code: 1006, reason: "" });
  await settle();
  expect(checks).toHaveLength(1);
  // The next check is still on its way when the network returns and the socket opens.
  pending.push({ resolve: () => {} });
  jest.advanceTimersByTime(2_000);
  Socket.instances.at(-1)!.onclose?.({ code: 1006, reason: "" });
  expect(checks).toHaveLength(2);
  jest.advanceTimersByTime(2_000);
  const reconnected = Socket.instances.at(-1)!;
  reconnected.open();
  expect(checks[1]!.signal.aborted).toBe(true);
  pending.at(-1)!.resolve(new Response(null, { status: 401 }));
  await settle();
  reconnected.ready();
  expect(fatal).toEqual([]);
  expect(publishes(reconnected).length).toBeGreaterThan(0);
  expect(provider.pendingState().text).toBe("typed before the drop");
});

test("a socket on another origin than the page is never checked with the page's sign-in", () => {
  jest.useFakeTimers();
  cleanups.push(() => jest.useRealTimers());
  const checks = sessionCheckPage("https://page.invalid", async () => new Response(null, { status: 401 }));
  const { socket } = fixture();
  socket.onclose?.({ code: 1006, reason: "" });
  jest.advanceTimersByTime(2_000);
  Socket.instances.at(-1)!.onclose?.({ code: 1006, reason: "" });
  expect(Socket.instances).toHaveLength(2);
  expect(checks).toHaveLength(0);
});

test("an application-specific closed-generation error keeps input recoverable and cannot be resumed", () => {
  const { provider, local, socket } = fixture();
  socket.ready();
  local.getText("codemirror").insert(0, "unsent input");
  socket.message({ type: "error", payload: { code: "GENERATION_CLOSED", message: "Draft sent", docId: DOC_ID, reopen: true } });
  provider.resume();
  provider.reconnectNow();
  expect(Socket.instances).toHaveLength(1);
  expect(provider.pendingState().text).toBe("unsent input");
  expect(provider.hasUnsentChanges()).toBe(true);
});

test("awareness from another generation cannot enter the current editor", () => {
  const failures: string[] = [];
  const { awareness, socket } = fixture({ onFatal: (error) => failures.push(error.code) });
  socket.ready();
  const remote = doc(202);
  const remoteAwareness = new Awareness(remote);
  cleanups.push(() => remoteAwareness.destroy());
  remoteAwareness.setLocalState({ user: { name: "retired" } });
  socket.message({
    type: "awarenessPush",
    payload: {
      docId: DOC_ID,
      updates: [
        {
          payload: encoding.toBase64(encodeAwarenessUpdate(remoteAwareness, [remote.clientID])),
          generation: "retired",
        },
      ],
    },
  });
  expect(awareness.getStates().has(remote.clientID)).toBe(false);
  expect(failures).toEqual(["RESYNC_REQUIRED"]);
});

test("new transports fail closed when an update loses its generation metadata", () => {
  const failures: string[] = [];
  const { local, provider, socket } = fixture({ onFatal: (error) => failures.push(error.code) });
  socket.ready();
  const remote = doc(202);
  remote.getText("codemirror").insert(0, "unversioned");
  socket.message({
    type: "syncPush",
    payload: { docId: DOC_ID, updates: [{ payload: encoding.toBase64(Y.encodeStateAsUpdate(remote)) }] },
  });
  expect(failures).toEqual(["RESYNC_REQUIRED"]);
  expect(local.getText("codemirror").toString()).toBe("");
  provider.resume();
  expect(Socket.instances).toHaveLength(1);
});

test("an initially empty editor binds its first versioned replay so a later ready cannot relabel it", () => {
  const errors: string[] = [];
  const { local, socket, provider } = fixture({
    initialGeneration: undefined,
    initialCursor: null,
    onFatal: (error) => errors.push(error.code),
  });
  const remote = doc(202);
  remote.getText("codemirror").insert(0, "generation A");
  socket.sync(encoding.toBase64(Y.encodeStateAsUpdate(remote)));
  expect(provider.generation()).toBe(GENERATION);
  socket.ready("generation B");
  expect(errors).toEqual(["RESYNC_REQUIRED"]);
  expect(local.getText("codemirror").toString()).toBe("generation A");
  expect(publishes(socket)).toHaveLength(0);
});

for (const readyGeneration of [GENERATION, "replacement"]) {
  test(`update-only generation binds bootstrap and fences ready ${readyGeneration}`, () => {
    const failures: string[] = [];
    const { provider, socket, local } = fixture({
      initialGeneration: undefined,
      initialCursor: null,
      onFatal: (error) => failures.push(error.code),
    });
    const remote = doc(313);
    remote.getText("codemirror").insert(0, "Versioned body");
    socket.message({
      type: "syncPush",
      payload: {
        docId: DOC_ID,
        updates: [
          {
            payload: encoding.toBase64(Y.encodeStateAsUpdate(remote)),
            generation: GENERATION,
            cursor: "s6t.test.1",
          },
        ],
      },
    });
    expect(provider.generation()).toBe(GENERATION);
    expect(local.getText("codemirror").toString()).toBe("Versioned body");
    socket.ready(readyGeneration);
    expect(failures).toEqual(readyGeneration === GENERATION ? [] : ["RESYNC_REQUIRED"]);
  });
}

test("a frozen document retains journal input and resends it after thaw; close is terminal", () => {
  jest.useFakeTimers();
  setSystemTime(new Date("2026-11-12T12:00:00Z"));
  try {
    const fatal: string[] = [];
    const { provider, socket, local } = fixture({ onFatal: (error) => fatal.push(error.code) });
    socket.ready();
    local.getText("codemirror").insert(0, "own unsent text");
    const publication = publishes(socket)[0]!;
    const journal = provider.pendingState();
    socket.message({ type: "error", payload: { code: "DOCUMENT_FROZEN", message: "Frozen" } });
    socket.onclose?.({ code: 1013, reason: "DOCUMENT_FROZEN" });
    expect(provider.hasUnsentChanges()).toBe(true);
    expect(provider.pendingState()).toEqual(journal);
    expect(fatal).toEqual([]);
    jest.advanceTimersByTime(2_000);
    const next = Socket.instances.at(-1)!;
    next.open();
    next.ready();
    expect(publishes(next)).toEqual([publication]);
    next.sync(publication.payload.payload);
    expect(provider.hasUnsentChanges()).toBe(false);
    next.message({ type: "error", payload: { code: "DOCUMENT_CLOSED", message: "Closed" } });
    expect(fatal).toEqual(["DOCUMENT_CLOSED"]);
    jest.advanceTimersByTime(10_000);
    expect(Socket.instances).toHaveLength(2);
  } finally {
    jest.useRealTimers();
    setSystemTime();
  }
});

test("BUSY retries pending input on the same socket after backoff and retains the journal", () => {
  jest.useFakeTimers();
  setSystemTime(new Date("2026-11-12T12:00:00Z"));
  const random = spyOn(Math, "random").mockReturnValue(0.5);
  try {
    const { provider, socket, local } = fixture();
    socket.ready();
    local.getText("codemirror").insert(0, "own pending text");
    const first = publishes(socket)[0]!;
    const journal = provider.pendingState();
    socket.message({ type: "error", payload: { code: "BUSY", message: "Retry" } });
    socket.message({ type: "error", payload: { code: "BUSY", message: "Retry" } });
    expect(provider.pendingState()).toEqual(journal);
    expect(socket.readyState).toBe(Socket.OPEN);
    jest.advanceTimersByTime(1_999);
    expect(publishes(socket)).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(publishes(socket)).toEqual([first, { ...first, payload: { ...first.payload, retry: true } }]);
    expect(Socket.instances).toHaveLength(1);
    socket.sync(first.payload.payload);
    expect(provider.hasUnsentChanges()).toBe(false);
    provider.dispose();
    jest.advanceTimersByTime(10_000);
    expect(Socket.instances).toHaveLength(1);
  } finally {
    random.mockRestore();
    jest.useRealTimers();
    setSystemTime();
  }
});

test("typing during BUSY remains recoverable and is included in the same-socket retry", () => {
  jest.useFakeTimers();
  setSystemTime(new Date("2026-11-12T12:00:00Z"));
  const random = spyOn(Math, "random").mockReturnValue(0.5);
  try {
    const { provider, socket, local } = fixture();
    socket.ready();
    local.getText("codemirror").insert(0, "first");
    socket.message({ type: "error", payload: { code: "BUSY", message: "Retry" } });
    local.getText("codemirror").insert(5, " and second");
    expect(publishes(socket)).toHaveLength(1);
    expect(provider.hasUnsentChanges()).toBe(true);
    jest.advanceTimersByTime(2_000);
    const retried = publishes(socket).at(-1)!;
    const received = doc(202);
    Y.applyUpdate(received, encoding.fromBase64(retried.payload.payload));
    expect(received.getText("codemirror").toString()).toBe("first and second");
    socket.sync(retried.payload.payload);
    expect(provider.hasUnsentChanges()).toBe(false);
    expect(Socket.instances).toHaveLength(1);
  } finally {
    random.mockRestore();
    jest.useRealTimers();
    setSystemTime();
  }
});

test("BUSY retries the full state after dependent edits were already published", () => {
  jest.useFakeTimers();
  setSystemTime(new Date("2026-11-12T12:00:00Z"));
  const random = spyOn(Math, "random").mockReturnValue(0.5);
  try {
    const { provider, socket, local } = fixture();
    socket.ready();
    local.getText("codemirror").insert(0, "first");
    local.getText("codemirror").insert(5, " and second");
    expect(publishes(socket)).toHaveLength(2);
    const journal = provider.pendingState();
    socket.message({ type: "error", payload: { code: "BUSY", message: "Retry" } });
    socket.message({ type: "error", payload: { code: "BUSY", message: "Retry" } });
    expect(provider.pendingState()).toEqual(journal);
    jest.advanceTimersByTime(2_000);
    const retry = publishes(socket).at(-1)!;
    expect(retry.payload.retry).toBe(true);
    expect(retry.payload.baseCursor).toBe("s6t.test.1");
    const received = doc(202);
    Y.applyUpdate(received, encoding.fromBase64(retry.payload.payload));
    expect(received.getText("codemirror").toString()).toBe("first and second");
    expect(received.store.pendingStructs).toBeNull();
    socket.sync(retry.payload.payload);
    expect(provider.hasUnsentChanges()).toBe(false);
    local.getText("codemirror").insert(16, " third");
    expect(publishes(socket).at(-1)!.payload.retry).toBeUndefined();
    expect(Socket.instances).toHaveLength(1);
  } finally {
    random.mockRestore();
    jest.useRealTimers();
    setSystemTime();
  }
});

test("a hub gap retries and acknowledges pending input covered by the reconnect snapshot without SYNC_TIMEOUT", () => {
  jest.useFakeTimers();
  setSystemTime(new Date("2026-11-13T04:00:00Z"));
  try {
    const errors: SharedTextProviderError[] = [];
    const { provider, socket, local } = fixture({ onError: (error) => errors.push(error) });
    socket.ready();
    local.getText("codemirror").insert(0, "accepted but not echoed");
    expect(publishes(socket)).toHaveLength(1);
    const server = doc(202);
    Y.applyUpdate(server, Y.encodeStateAsUpdate(local));
    server.getText("codemirror").insert(server.getText("codemirror").length, " + remote");
    const covered = encoding.toBase64(Y.encodeStateAsUpdate(server));
    socket.message({ type: "error", payload: { code: "STREAM_FAILED", message: "Retry stream" } });
    socket.close();
    socket.onclose?.({ code: 1012, reason: "STREAM_FAILED" });
    jest.advanceTimersByTime(2_000);
    const reconnect = Socket.instances.at(-1)!;
    expect(reconnect).not.toBe(socket);
    reconnect.open();
    reconnect.sync(covered, "s6t.test.3", true);
    expect(publishes(reconnect)).toHaveLength(0);
    reconnect.message({
      type: "replayReady",
      payload: { docId: DOC_ID, generation: GENERATION, cursor: "s6t.test.3", peerId: "own-peer" },
    });
    expect(publishes(reconnect)).toHaveLength(1);
    reconnect.sync(publishes(reconnect)[0]!.payload.payload, "s6t.test.4");
    expect(provider.hasUnsentChanges()).toBe(false);
    jest.advanceTimersByTime(SHARED_TEXT_ACK_TIMEOUT_MS * 2);
    expect(errors.some((error) => error.code === "SYNC_TIMEOUT")).toBe(false);
    expect(reconnect.readyState).toBe(Socket.OPEN);
    expect(local.getText("codemirror").toString()).toBe("accepted but not echoed + remote");
  } finally {
    jest.useRealTimers();
    setSystemTime();
  }
});
