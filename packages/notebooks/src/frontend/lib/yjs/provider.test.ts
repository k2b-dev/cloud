import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { notebooksWorkspace } from "../../../lib/workspace-events";
import { notebooksYjs } from "../../../lib/yjs";
import { createYjsProvider, reconnectDelayMs } from "./provider";

const NOTE_ID = "Note01";
const NOTEBOOK_ID = "Book01";

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close() {
    this.readyState = 3;
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

const replayRequests = (socket: FakeWebSocket) =>
  socket.sent
    .map((value) => JSON.parse(value) as { type: string; payload: { fromCursor?: string | null } })
    .filter((value) => value.type === notebooksYjs.wsType.replayRequest)
    .map((value) => value.payload.fromCursor ?? null);

const workspaceSubscriptions = (socket: FakeWebSocket) =>
  socket.sent
    .map((value) => JSON.parse(value) as { type: string; payload: { notebookId: string; fromCursor?: string | null } })
    .filter((value) => value.type === notebooksWorkspace.wsType.subscribe);

let originalWebSocket: typeof WebSocket | undefined;

beforeEach(() => {
  originalWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  Object.assign(globalThis, { WebSocket: FakeWebSocket });
});

afterEach(() => {
  if (originalWebSocket) Object.assign(globalThis, { WebSocket: originalWebSocket });
  else Reflect.deleteProperty(globalThis, "WebSocket");
});

describe("Yjs provider workspace cursor coverage", () => {
  test("advances the workspace replay cursor only after async coverage", async () => {
    const doc = new Y.Doc();
    let release!: () => void;
    const coverage = new Promise<void>((resolve) => {
      release = resolve;
    });
    const confirmed: string[] = [];
    const provider = createYjsProvider({
      doc,
      awareness: new Awareness(doc),
      noteId: NOTE_ID,
      appUrl: "http://localhost",
      workspace: {
        notebookId: NOTEBOOK_ID,
        initialCursor: "1-0",
        onEvent: () => coverage,
        onCursorChange: (cursor) => confirmed.push(cursor),
      },
    });

    provider.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    expect(workspaceSubscriptions(socket).at(-1)?.payload.notebookId).toBe(NOTEBOOK_ID);
    socket.message({ type: notebooksWorkspace.wsType.ready, payload: { notebookId: NOTEBOOK_ID } });
    socket.message({
      type: notebooksWorkspace.wsType.event,
      payload: {
        notebookId: NOTEBOOK_ID,
        cursor: "2-0",
        event: { v: 1, type: "workspace.invalidated", notebookId: NOTEBOOK_ID, reason: "bulk", scopes: ["tree"] },
      },
    });

    socket.open();
    expect(workspaceSubscriptions(socket).at(-1)?.payload.fromCursor).toBe("1-0");
    release();
    await coverage;
    await Promise.resolve();
    expect(confirmed).toEqual(["2-0"]);
    socket.open();
    expect(workspaceSubscriptions(socket).at(-1)?.payload.fromCursor).toBe("2-0");
    provider.dispose();
  });

  test("processes workspace events in cursor order", async () => {
    const doc = new Y.Doc();
    let releaseFirst!: () => void;
    const firstCoverage = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const seen: string[] = [];
    const provider = createYjsProvider({
      doc,
      awareness: new Awareness(doc),
      noteId: NOTE_ID,
      appUrl: "http://localhost",
      workspace: {
        notebookId: NOTEBOOK_ID,
        onEvent: (_event, cursor) => {
          seen.push(cursor!);
          return cursor === "1-0" ? firstCoverage : Promise.resolve();
        },
      },
    });

    provider.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.message({ type: notebooksWorkspace.wsType.ready, payload: { notebookId: NOTEBOOK_ID } });
    const payload = (cursor: string) => ({
      type: notebooksWorkspace.wsType.event,
      payload: {
        notebookId: NOTEBOOK_ID,
        cursor,
        event: { v: 1, type: "workspace.invalidated", notebookId: NOTEBOOK_ID, reason: "bulk", scopes: ["tree"] },
      },
    });
    socket.message(payload("1-0"));
    socket.message(payload("2-0"));
    await Promise.resolve();
    expect(seen).toEqual(["1-0"]);
    releaseFirst();
    await firstCoverage;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(["1-0", "2-0"]);
    provider.dispose();
  });

  test("closes the socket so an uncovered event is replayed", async () => {
    const doc = new Y.Doc();
    const provider = createYjsProvider({
      doc,
      awareness: new Awareness(doc),
      noteId: NOTE_ID,
      appUrl: "http://localhost",
      workspace: {
        notebookId: NOTEBOOK_ID,
        initialCursor: "1-0",
        onEvent: () => Promise.reject(new Error("refresh failed")),
      },
    });

    provider.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.message({ type: notebooksWorkspace.wsType.ready, payload: { notebookId: NOTEBOOK_ID } });
    socket.message({
      type: notebooksWorkspace.wsType.event,
      payload: {
        notebookId: NOTEBOOK_ID,
        cursor: "2-0",
        event: { v: 1, type: "workspace.invalidated", notebookId: NOTEBOOK_ID, reason: "bulk", scopes: ["tree"] },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.readyState).toBe(3);
    socket.open();
    expect(workspaceSubscriptions(socket).at(-1)?.payload.fromCursor).toBe("1-0");
    provider.dispose();
  });

  test("remains reconnectable after a recoverable workspace stream error", () => {
    const doc = new Y.Doc();
    const fatalErrors: string[] = [];
    const provider = createYjsProvider({
      doc,
      awareness: new Awareness(doc),
      noteId: NOTE_ID,
      appUrl: "http://localhost",
      workspace: { notebookId: NOTEBOOK_ID, onEvent: () => undefined },
      onFatal: (error) => fatalErrors.push(error.code),
    });

    provider.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.message({ type: notebooksWorkspace.wsType.error, payload: { code: "INTERNAL_ERROR", message: "stream failed" } });

    expect(socket.readyState).toBe(3);
    expect(fatalErrors).toEqual([]);
    const subscriptionCount = workspaceSubscriptions(socket).length;
    socket.open();
    expect(workspaceSubscriptions(socket)).toHaveLength(subscriptionCount + 1);
    provider.dispose();
  });

  test("keeps the replay cursor across a transient stream failure and drops it only for a resync", () => {
    const doc = new Y.Doc();
    const fatalErrors: string[] = [];
    const provider = createYjsProvider({
      doc,
      awareness: new Awareness(doc),
      noteId: NOTE_ID,
      appUrl: "http://localhost",
      onFatal: (error) => fatalErrors.push(error.code),
    });

    provider.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID } });
    socket.message({
      type: notebooksYjs.wsType.syncPush,
      payload: { noteId: NOTE_ID, updates: [{ cursor: "s6t.note.12", payload: "AAA=", originPeerId: null }] },
    });
    socket.message({ type: notebooksYjs.wsType.error, payload: { code: "STREAM_FAILED", message: "broker unavailable" } });
    socket.open();
    expect(replayRequests(socket)).toEqual([null, "s6t.note.12"]);

    socket.message({ type: notebooksYjs.wsType.error, payload: { code: "RESYNC_REQUIRED", message: "stale cursor" } });
    socket.open();
    expect(replayRequests(socket)).toEqual([null, "s6t.note.12", null]);
    expect(fatalErrors).toEqual([]);
    provider.dispose();
  });

  test("reconnect delay doubles per failed attempt and stays bounded", () => {
    expect(reconnectDelayMs(0, 0)).toBe(2_000);
    expect(reconnectDelayMs(1, 0)).toBe(4_000);
    expect(reconnectDelayMs(3, 0)).toBe(16_000);
    expect(reconnectDelayMs(10, 0)).toBe(30_000);
    expect(reconnectDelayMs(0, 0.999)).toBeLessThan(3_500);
  });

  test("terminates after workspace access is revoked", () => {
    const doc = new Y.Doc();
    const fatalErrors: string[] = [];
    const provider = createYjsProvider({
      doc,
      awareness: new Awareness(doc),
      noteId: NOTE_ID,
      appUrl: "http://localhost",
      workspace: { notebookId: NOTEBOOK_ID, onEvent: () => undefined },
      onFatal: (error) => fatalErrors.push(error.code),
    });

    provider.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.message({ type: notebooksWorkspace.wsType.revoked, payload: {} });

    expect(socket.readyState).toBe(3);
    expect(fatalErrors).toEqual(["ACCESS_REVOKED"]);
    provider.dispose();
  });

  test("rejects UUID and malformed public resource ids", () => {
    const doc = new Y.Doc();
    expect(() =>
      createYjsProvider({
        doc,
        awareness: new Awareness(doc),
        noteId: "00000000-0000-4000-8000-000000000001",
        appUrl: "http://localhost",
      }),
    ).toThrow("noteId must be a 6-character short id");
    expect(() =>
      createYjsProvider({
        doc,
        awareness: new Awareness(doc),
        noteId: NOTE_ID,
        appUrl: "http://localhost",
        workspace: { notebookId: "too-long", onEvent: () => undefined },
      }),
    ).toThrow("workspace.notebookId must be a 6-character short id");
  });

  test("keeps the note short id stable across replay and publishes", () => {
    const doc = new Y.Doc();
    const provider = createYjsProvider({ doc, awareness: new Awareness(doc), noteId: NOTE_ID, appUrl: "http://localhost" });
    provider.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    const replay = socket.sent.map((value) => JSON.parse(value)).find((value) => value.type === notebooksYjs.wsType.replayRequest);
    expect(replay.payload.noteId).toBe(NOTE_ID);

    socket.message({
      type: notebooksYjs.wsType.replayReady,
      payload: { noteId: "00000000-0000-4000-8000-000000000001" },
    });
    doc.getText("content").insert(0, "x");
    expect(socket.sent.map((value) => JSON.parse(value)).some((value) => value.type === notebooksYjs.wsType.syncPublish)).toBe(false);

    const remote = new Y.Doc();
    remote.getText("content").insert(0, "remote");
    socket.message({
      type: notebooksYjs.wsType.syncPush,
      payload: {
        noteId: NOTE_ID,
        updates: [{ cursor: "s6t.test.1", payload: Buffer.from(Y.encodeStateAsUpdate(remote)).toString("base64") }],
      },
    });
    expect(socket.sent.map((value) => JSON.parse(value)).some((value) => value.type === notebooksYjs.wsType.syncPublish)).toBe(false);
    remote.destroy();

    socket.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID } });
    const publish = socket.sent.map((value) => JSON.parse(value)).find((value) => value.type === notebooksYjs.wsType.syncPublish);
    expect(publish.payload.noteId).toBe(NOTE_ID);
    provider.dispose();
  });
});
