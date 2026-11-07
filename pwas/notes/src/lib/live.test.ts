import { afterEach, beforeEach, expect, jest, setSystemTime, test } from "bun:test";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { connectLive, type LiveSession } from "./live";

// Keep these wire values independent of the client implementation, per notes/protocol.ts.
const message = { sync: 0, awareness: 1, update: 4, ack: 5, reject: 6, identity: 7 } as const;
const globals = ["WebSocket", "window", "navigator"] as const;
const descriptors = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const documents: Y.Doc[] = [];
const awarenessInstances: awarenessProtocol.Awareness[] = [];
const sessions: LiveSession[] = [];
let browser: EventTarget;
let network: { onLine: boolean };

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  readonly sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(bytes: Uint8Array) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(new Uint8Array(bytes));
  }

  receive(bytes: Uint8Array) {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }

  close(code = 1000, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  setSystemTime(new Date("2026-10-30T12:00:00Z"));
  FakeWebSocket.instances = [];
  browser = new EventTarget();
  Object.defineProperty(browser, "location", { value: new URL("https://notes.example.test/p/edit") });
  network = { onLine: true };
  for (const [key, value] of Object.entries({ WebSocket: FakeWebSocket, window: browser, navigator: network }))
    Object.defineProperty(globalThis, key, { configurable: true, value });
});

afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  for (const awareness of awarenessInstances.splice(0)) awareness.destroy();
  for (const doc of documents.splice(0)) doc.destroy();
  jest.clearAllTimers();
  jest.useRealTimers();
  setSystemTime();
  for (const key of globals) {
    const descriptor = descriptors.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  FakeWebSocket.instances = [];
});

function document() {
  const doc = new Y.Doc();
  doc.clientID = documents.length + 1;
  documents.push(doc);
  return doc;
}

function presence(doc: Y.Doc) {
  const awareness = new awarenessProtocol.Awareness(doc);
  awarenessInstances.push(awareness);
  return awareness;
}

function client(onGone?: Parameters<typeof connectLive>[0]["onGone"]) {
  const doc = document();
  const awareness = presence(doc);
  awareness.setLocalState({ user: { name: "Self", color: "#123456" } });
  const session = connectLive({ linkId: "edit", doc, awareness, canEdit: true, onGone });
  sessions.push(session);
  return { doc, awareness, session, text: doc.getText("text") };
}

function socket() {
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error("expected a socket");
  return ws;
}

function frame(type: number, write: (encoder: encoding.Encoder) => void) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

function syncStep1(ws: FakeWebSocket, server: Y.Doc) {
  ws.receive(frame(message.sync, (encoder) => syncProtocol.writeSyncStep1(encoder, server)));
}

function syncStep2(ws: FakeWebSocket, server: Y.Doc) {
  ws.receive(frame(message.sync, (encoder) => syncProtocol.writeSyncStep2(encoder, server)));
}

function ack(ws: FakeWebSocket, id: string) {
  ws.receive(frame(message.ack, (encoder) => encoding.writeVarString(encoder, id)));
}

function frameType(bytes: Uint8Array) {
  return decoding.readVarUint(decoding.createDecoder(bytes));
}

function updates(ws: FakeWebSocket) {
  return ws.sent
    .filter((bytes) => frameType(bytes) === message.update)
    .map((bytes) => {
      const decoder = decoding.createDecoder(bytes);
      decoding.readVarUint(decoder);
      const id = decoding.readVarString(decoder);
      const update = decoding.readVarUint8Array(decoder);
      expect(decoder.pos).toBe(bytes.length);
      return { id, update };
    });
}

function onlyUpdate(ws: FakeWebSocket) {
  const sent = updates(ws);
  expect(sent).toHaveLength(1);
  const update = sent[0];
  if (!update) throw new Error("expected an update frame");
  return update;
}

function receiveAwareness(ws: FakeWebSocket, awareness: awarenessProtocol.Awareness) {
  ws.receive(
    frame(message.awareness, (encoder) => {
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]));
    }),
  );
}

test("reconnect bundles 100 offline edits into one complete update, below the 20-frames/s limit", () => {
  network.onLine = false;
  const { session, text } = client();
  const server = document();
  expect(session.status()).toBe("offline");
  const edits = Array.from({ length: 100 }, (_, index) => `${index}\n`);
  for (const edit of edits) text.insert(text.length, edit);
  expect(FakeWebSocket.instances).toHaveLength(0);

  network.onLine = true;
  browser.dispatchEvent(new Event("online"));
  const ws = socket();
  ws.open();
  expect(ws.sent.map(frameType)).toEqual([message.sync, message.awareness]);
  const first = ws.sent[0];
  if (!first) throw new Error("expected sync step 1");
  const decoder = decoding.createDecoder(first);
  expect(decoding.readVarUint(decoder)).toBe(message.sync);
  expect(decoding.readVarUint(decoder)).toBe(syncProtocol.messageYjsSyncStep1);

  syncStep1(ws, server);
  expect(ws.sent.map(frameType)).toEqual([message.sync, message.awareness, message.update]);
  const sent = onlyUpdate(ws);
  Y.applyUpdate(server, sent.update);
  expect(server.getText("text").toString()).toBe(edits.join(""));
  ack(ws, sent.id);
  syncStep2(ws, server);
  expect(session.status()).toBe("live");
  expect(session.pending()).toBe(0);
});

test("edits after answering sync step 1 each send an update before server step 2 arrives", () => {
  const { doc, text, session } = client();
  const server = document();
  server.getText("text").insert(0, "remote");
  const delayedStep2 = frame(message.sync, (encoder) => syncProtocol.writeSyncStep2(encoder, server));
  const ws = socket();
  ws.open();
  syncStep1(ws, server);
  expect(updates(ws)).toHaveLength(0);
  text.insert(0, "first");
  expect(updates(ws)).toHaveLength(1);
  text.insert(text.length, " second");
  const sent = updates(ws);
  expect(sent).toHaveLength(2);
  expect(new Set(sent.map(({ id }) => id)).size).toBe(2);
  expect(session.pending()).toBe(2);
  for (const { id, update } of sent) {
    Y.applyUpdate(server, update);
    ack(ws, id);
  }
  ws.receive(delayedStep2);
  expect(text.toString()).toContain("first second");
  expect(text.toString()).toContain("remote");
  expect(text.toString()).toBe(server.getText("text").toString());
  expect(Y.encodeStateVector(doc)).toEqual(Y.encodeStateVector(server));
  expect(updates(ws)).toHaveLength(2);
  expect(session.status()).toBe("live");
});

test("an unacknowledged change becomes connecting after 2 seconds and live again on ack", () => {
  const { text, session } = client();
  const server = document();
  const ws = socket();
  ws.open();
  syncStep1(ws, server);
  syncStep2(ws, server);
  expect(session.status()).toBe("live");
  text.insert(0, "unconfirmed");
  expect(session.pending()).toBe(1);
  jest.advanceTimersByTime(1_999);
  expect(session.status()).toBe("live");
  jest.advanceTimersByTime(2);
  expect(session.status()).toBe("connecting");
  ack(ws, onlyUpdate(ws).id);
  expect(session.pending()).toBe(0);
  expect(session.status()).toBe("live");
});

test.each([
  ["text_limit", "full"],
  ["state_limit", "full"],
  ["forbidden", "unsaved"],
] as const)("reject %s sets status %s", (code, expected) => {
  const { text, session } = client();
  const server = document();
  const ws = socket();
  ws.open();
  syncStep1(ws, server);
  syncStep2(ws, server);
  text.insert(0, "rejected");
  const { id } = onlyUpdate(ws);
  ws.receive(
    frame(message.reject, (encoder) => {
      encoding.writeVarString(encoder, id);
      encoding.writeVarString(encoder, code);
    }),
  );
  expect(session.status()).toBe(expected);
  expect(session.pending()).toBe(1);
});

test("awareness ignores our identity echo and names the last departed person in change.removed", () => {
  const { doc, awareness, session } = client();
  const echo = presence(document());
  echo.setLocalState({ user: { name: "Self", color: "#123456" }, writerId: doc.clientID });
  const other = presence(document());
  const otherState = { user: { name: "Other", color: "#abcdef" }, writerId: 42 };
  other.setLocalState(otherState);
  const ws = socket();
  ws.open();
  ws.receive(frame(message.identity, (encoder) => encoding.writeVarUint(encoder, echo.clientID)));
  receiveAwareness(ws, echo);
  expect(session.people()).toEqual([]);
  expect(awareness.getStates().has(echo.clientID)).toBe(false);
  receiveAwareness(ws, other);
  expect(session.people()).toEqual([{ awarenessId: other.clientID, writerId: 42, name: "Other", color: "#abcdef" }]);
  expect(awareness.getStates().get(other.clientID)).toEqual(otherState);

  const changes: { added: number[]; updated: number[]; removed: number[] }[] = [];
  awareness.on("change", (change: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === "remote") changes.push(change);
  });
  other.setLocalState(null);
  receiveAwareness(ws, other);
  expect(session.people()).toEqual([]);
  expect(awareness.getStates().has(other.clientID)).toBe(false);
  expect(awareness.getStates().has(doc.clientID)).toBe(true);
  expect(changes).toEqual([{ added: [], updated: [], removed: [other.clientID] }]);
});

test.each(["deleted", "expired", "blocked", "read_only"])("close reason %s prevents retries, including online events", (reason) => {
  const gone: string[] = [];
  const { session } = client((value) => gone.push(value));
  const ws = socket();
  ws.open();
  ws.close(1008, reason);
  expect(gone).toEqual(reason === "read_only" ? [] : [reason]);
  if (reason !== "read_only") expect(session.status()).toBe("gone");
  jest.advanceTimersByTime(60_000);
  expect(FakeWebSocket.instances).toHaveLength(1);
  browser.dispatchEvent(new Event("online"));
  jest.advanceTimersByTime(60_000);
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(gone).toEqual(reason === "read_only" ? [] : [reason]);
});
