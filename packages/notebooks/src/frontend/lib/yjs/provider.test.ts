import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { encoding } from "@k2b/stdlib";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { notebooksWorkspace } from "../../../lib/workspace-events";
import { notebooksYjs } from "../../../lib/yjs";
import { reconnectDelayMs } from "../reconnect";
import { createYjsProvider } from "./provider";

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
    socket.message({
      type: notebooksYjs.wsType.awarenessPush,
      payload: { noteId: NOTE_ID, updates: [{ cursor: "s6t.awareness.99", payload: "AAA=" }] },
    });
    socket.message({ type: notebooksYjs.wsType.error, payload: { code: "STREAM_FAILED", message: "broker unavailable" } });
    socket.open();
    expect(replayRequests(socket)).toEqual([null, "s6t.note.12"]);

    socket.message({ type: notebooksYjs.wsType.error, payload: { code: "INTERNAL_ERROR", message: "temporary backend error" } });
    socket.open();
    expect(replayRequests(socket)).toEqual([null, "s6t.note.12", "s6t.note.12"]);

    socket.onclose?.({ code: 1011, reason: "INTERNAL_ERROR" });
    socket.open();
    expect(replayRequests(socket)).toEqual([null, "s6t.note.12", "s6t.note.12", "s6t.note.12"]);

    socket.message({ type: notebooksYjs.wsType.error, payload: { code: "RESYNC_REQUIRED", message: "stale cursor" } });
    socket.open();
    expect(replayRequests(socket)).toEqual([null, "s6t.note.12", "s6t.note.12", "s6t.note.12", null]);
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

test("reports incomplete recovered history only for the active document snapshot", () => {
  const doc = new Y.Doc();
  let warnings = 0;
  const provider = createYjsProvider({
    doc,
    awareness: new Awareness(doc),
    noteId: NOTE_ID,
    appUrl: "http://localhost",
    workspace: { notebookId: NOTEBOOK_ID, onEvent: () => undefined },
    onHistoryIncomplete: () => {
      warnings++;
    },
  });
  provider.connect();
  const socket = FakeWebSocket.instances[0]!;
  socket.open();
  for (const [type, noteId, historyIncomplete] of [
    [notebooksYjs.wsType.syncPush, "other", true],
    [notebooksYjs.wsType.awarenessPush, NOTE_ID, true],
    [notebooksYjs.wsType.syncPush, NOTE_ID, false],
    [notebooksYjs.wsType.syncPush, NOTE_ID, true],
  ])
    socket.message({ type, payload: { noteId, historyIncomplete, updates: [] } });
  expect(warnings).toBe(1);
  for (const [notebookId, id, historyIncomplete] of [
    ["other", NOTE_ID, true],
    [NOTEBOOK_ID, "other", true],
    [NOTEBOOK_ID, NOTE_ID, false],
    [NOTEBOOK_ID, NOTE_ID, true],
  ]) {
    socket.message({
      type: notebooksWorkspace.wsType.event,
      payload: { notebookId, event: { v: 1, type: "note.updated", notebookId, note: { id, historyIncomplete } } },
    });
  }
  expect(warnings).toBe(2);
  provider.dispose();
});

describe("Yjs provider storage exhaustion", () => {
  test("reports the error, retries a bounded number of times, then stops", () => {
    const doc = new Y.Doc();
    const errors: string[] = [];
    const fatal: string[] = [];
    let ready = 0;
    const timers: Array<() => void> = [];
    const originalSetTimeout = globalThis.setTimeout;
    Object.assign(globalThis, { setTimeout: (fn: () => void) => timers.push(fn) });
    try {
      const provider = createYjsProvider({
        doc,
        awareness: new Awareness(doc),
        noteId: NOTE_ID,
        appUrl: "http://localhost",
        onError: (error) => errors.push(error.code),
        onFatal: (error) => fatal.push(error.code),
        onReady: () => ready++,
      });
      provider.connect();
      const storageClose = (socket: FakeWebSocket) => {
        socket.open();
        socket.message({ type: notebooksYjs.wsType.error, payload: { code: "STORAGE_EXHAUSTED", message: "full", noteId: NOTE_ID } });
        socket.onclose?.({ code: 1012, reason: "STORAGE_EXHAUSTED" });
      };
      // One success in between resets the budget.
      storageClose(FakeWebSocket.instances[0]!);
      timers.shift()!();
      const recovered = FakeWebSocket.instances[1]!;
      recovered.open();
      recovered.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID } });
      expect(ready).toBe(1);
      recovered.onclose?.({ code: 1006, reason: "" });
      for (let attempt = 0; attempt < 5; attempt++) {
        timers.shift()!();
        storageClose(FakeWebSocket.instances.at(-1)!);
      }
      expect(errors.filter((code) => code === "STORAGE_EXHAUSTED")).toHaveLength(6);
      expect(fatal).toEqual(["STORAGE_EXHAUSTED"]);
      // Terminated: no further reconnect is scheduled.
      expect(timers).toHaveLength(0);
      provider.dispose();
    } finally {
      Object.assign(globalThis, { setTimeout: originalSetTimeout });
    }
  });

  test("unsent edits keep the retry budget until storage accepts a write", () => {
    const doc = new Y.Doc();
    const fatal: string[] = [];
    const timers: Array<() => void> = [];
    const originalSetTimeout = globalThis.setTimeout;
    Object.assign(globalThis, { setTimeout: (fn: () => void) => timers.push(fn) });
    try {
      const provider = createYjsProvider({
        doc,
        awareness: new Awareness(doc),
        noteId: NOTE_ID,
        appUrl: "http://localhost",
        onFatal: (error) => fatal.push(error.code),
      });
      provider.connect();
      const ready = (socket: FakeWebSocket) => {
        socket.open();
        socket.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID } });
      };
      const rejectWrite = (socket: FakeWebSocket) => {
        socket.message({ type: notebooksYjs.wsType.error, payload: { code: "STORAGE_EXHAUSTED", message: "full", noteId: NOTE_ID } });
        socket.onclose?.({ code: 1012, reason: "STORAGE_EXHAUSTED" });
      };
      ready(FakeWebSocket.instances[0]!);
      doc.getText("content").insert(0, "unsent");
      expect(provider.hasUnsentChanges()).toBe(true);
      rejectWrite(FakeWebSocket.instances[0]!);
      // Every reconnect reads fine and resends the edit, which storage rejects again.
      for (let attempt = 1; attempt < 5; attempt++) {
        timers.shift()!();
        const socket = FakeWebSocket.instances.at(-1)!;
        ready(socket);
        expect(syncPublishes(socket)).toHaveLength(1);
        rejectWrite(socket);
      }
      expect(fatal).toEqual(["STORAGE_EXHAUSTED"]);
      expect(timers).toHaveLength(0);
      expect(provider.hasUnsentChanges()).toBe(true);
      provider.dispose();
    } finally {
      Object.assign(globalThis, { setTimeout: originalSetTimeout });
    }
  });

  test("an echoed write resets the storage retry budget", () => {
    const doc = new Y.Doc();
    const fatal: string[] = [];
    const timers: Array<() => void> = [];
    const originalSetTimeout = globalThis.setTimeout;
    Object.assign(globalThis, { setTimeout: (fn: () => void) => timers.push(fn) });
    try {
      const provider = createYjsProvider({
        doc,
        awareness: new Awareness(doc),
        noteId: NOTE_ID,
        appUrl: "http://localhost",
        onFatal: (error) => fatal.push(error.code),
      });
      provider.connect();
      const socket = FakeWebSocket.instances[0]!;
      socket.open();
      socket.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID } });
      for (let attempt = 1; attempt < 5; attempt++) {
        socket.message({ type: notebooksYjs.wsType.error, payload: { code: "STORAGE_EXHAUSTED", message: "full", noteId: NOTE_ID } });
      }
      doc.getText("content").insert(0, "saved");
      const [payload] = syncPublishes(socket);
      socket.message({ type: notebooksYjs.wsType.syncPush, payload: { noteId: NOTE_ID, updates: [{ cursor: "1-1", payload }] } });
      expect(provider.hasUnsentChanges()).toBe(false);
      socket.message({ type: notebooksYjs.wsType.error, payload: { code: "STORAGE_EXHAUSTED", message: "full", noteId: NOTE_ID } });
      expect(fatal).toEqual([]);
      provider.dispose();
    } finally {
      Object.assign(globalThis, { setTimeout: originalSetTimeout });
    }
  });
});

const syncPublishes = (socket: FakeWebSocket) =>
  socket.sent
    .map((value) => JSON.parse(value) as { type: string; payload: { payload: string } })
    .filter((value) => value.type === notebooksYjs.wsType.syncPublish)
    .map((value) => value.payload.payload);
const readyReplay = (socket: FakeWebSocket) => socket.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID } });
const echo = (socket: FakeWebSocket, payload: string) =>
  socket.message({ type: notebooksYjs.wsType.syncPush, payload: { noteId: NOTE_ID, updates: [{ payload }] } });

const localEditor = (onUnsentChange?: () => void) => {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const provider = createYjsProvider({ doc, awareness, noteId: NOTE_ID, appUrl: "http://localhost", onUnsentChange });
  provider.connect();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  return {
    doc,
    provider,
    socket,
    [Symbol.dispose]: () => {
      provider.dispose();
      awareness.destroy();
      doc.destroy();
    },
  };
};

describe("Yjs provider unconfirmed edits", () => {
  test("notifies when a publish becomes pending and when its echo clears it", () => {
    let notifications = 0;
    using editor = localEditor(() => notifications++);
    readyReplay(editor.socket);
    notifications = 0;
    editor.doc.getText("content").insert(0, "keep this");
    expect(notifications).toBe(1);
    expect(editor.provider.hasUnsentChanges()).toBe(true);
    const payload = syncPublishes(editor.socket)[0]!;
    echo(editor.socket, payload);
    expect(notifications).toBe(2);
    expect(editor.provider.hasUnsentChanges()).toBe(false);
    echo(editor.socket, payload);
    expect(notifications).toBe(2);
  });

  test("a published edit is unsent until the server echoes its payload", () => {
    using editor = localEditor();
    readyReplay(editor.socket);
    expect(editor.provider.hasUnsentChanges()).toBe(false);
    editor.doc.getText("content").insert(0, "keep this");
    const [payload] = syncPublishes(editor.socket);
    expect(payload).toBeDefined();
    expect(editor.provider.hasUnsentChanges()).toBe(true);
    echo(editor.socket, payload!);
    expect(editor.provider.hasUnsentChanges()).toBe(false);
  });

  test("a plain disconnect merges only unechoed updates, including after another disconnect", () => {
    using editor = localEditor();
    readyReplay(editor.socket);
    for (const text of ["first", "second", "third"]) editor.doc.getText("content").insert(0, text);
    const payloads = syncPublishes(editor.socket);
    const merged = encoding.toBase64(Y.mergeUpdates(payloads.slice(1).map(encoding.fromBase64)));
    const timers: Array<() => void> = [];
    const originalSetTimeout = globalThis.setTimeout;
    Object.assign(globalThis, { setTimeout: (fn: () => void) => timers.push(fn) });
    try {
      editor.socket.close();
      editor.socket.onclose?.({ code: 1006, reason: "" });
      timers.shift()!();
      const next = FakeWebSocket.instances.at(-1)!;
      next.open();
      echo(next, payloads[0]!);
      expect(syncPublishes(next)).toEqual([]);
      readyReplay(next);
      expect(syncPublishes(next)).toEqual([merged]);
      next.close();
      next.onclose?.({ code: 1006, reason: "" });
      timers.shift()!();
      const again = FakeWebSocket.instances.at(-1)!;
      again.open();
      readyReplay(again);
      expect(syncPublishes(again)).toEqual([merged]);
      echo(again, merged);
      expect(editor.provider.hasUnsentChanges()).toBe(false);
    } finally {
      Object.assign(globalThis, { setTimeout: originalSetTimeout });
    }
  });

  test("reconnect chunks large unconfirmed updates within the sync limit and clears their echoes", () => {
    using editor = localEditor();
    readyReplay(editor.socket);
    const text = editor.doc.getText("content");
    // Each update fits the 8 MB base64 limit, but the pair does not.
    for (const char of ["a", "b"]) text.insert(text.length, char.repeat(3_100_000));
    const payloads = syncPublishes(editor.socket);
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) expect(payload.length).toBeLessThanOrEqual(notebooksYjs.maxSyncPayloadLength);
    expect(encoding.toBase64(Y.mergeUpdates(payloads.map(encoding.fromBase64))).length).toBeGreaterThan(notebooksYjs.maxSyncPayloadLength);

    editor.socket.open();
    const send = spyOn(editor.socket, "send").mockImplementationOnce((value) => {
      editor.socket.sent.push(value);
      editor.socket.close();
    });
    try {
      readyReplay(editor.socket);
      expect(syncPublishes(editor.socket).slice(2)).toEqual([payloads[0]!]);
      expect(editor.provider.hasUnsentChanges()).toBe(true);
    } finally {
      send.mockRestore();
    }
    editor.socket.readyState = FakeWebSocket.OPEN;
    readyReplay(editor.socket);
    const retries = syncPublishes(editor.socket).slice(3);
    expect(retries).toEqual(payloads);
    for (const payload of retries) expect(payload.length).toBeLessThanOrEqual(notebooksYjs.maxSyncPayloadLength);
    echo(editor.socket, retries[0]!);
    expect(editor.provider.hasUnsentChanges()).toBe(true);
    echo(editor.socket, retries[1]!);
    expect(editor.provider.hasUnsentChanges()).toBe(false);
  });

  test("edits before replay ready are pending and publish one covering full state", () => {
    using editor = localEditor();
    editor.doc.getText("content").insert(0, "first");
    editor.doc.getText("content").insert(5, " second");
    expect(editor.provider.hasUnsentChanges()).toBe(true);
    expect(syncPublishes(editor.socket)).toEqual([]);
    readyReplay(editor.socket);
    expect(syncPublishes(editor.socket)).toEqual([Buffer.from(Y.encodeStateAsUpdate(editor.doc)).toString("base64")]);
    expect(editor.provider.hasUnsentChanges()).toBe(true);
    echo(editor.socket, syncPublishes(editor.socket)[0]!);
    expect(editor.provider.hasUnsentChanges()).toBe(false);
  });

  test("a covering full state replaces older unconfirmed updates after an offline edit", () => {
    using editor = localEditor();
    readyReplay(editor.socket);
    editor.doc.getText("content").insert(0, "online");
    editor.socket.open();
    editor.doc.getText("content").insert(6, " offline");
    readyReplay(editor.socket);
    const publishes = syncPublishes(editor.socket);
    expect(publishes).toHaveLength(2);
    expect(publishes[1]).toBe(Buffer.from(Y.encodeStateAsUpdate(editor.doc)).toString("base64"));
    echo(editor.socket, publishes[1]!);
    expect(editor.provider.hasUnsentChanges()).toBe(false);
    editor.socket.open();
    readyReplay(editor.socket);
    expect(syncPublishes(editor.socket)).toEqual(publishes);
  });

  test("a failed resend keeps the merged payload pending and retries on the next replay", () => {
    using editor = localEditor();
    readyReplay(editor.socket);
    editor.doc.getText("content").insert(0, "first");
    editor.doc.getText("content").insert(5, " second");
    const payloads = syncPublishes(editor.socket);
    const merged = encoding.toBase64(Y.mergeUpdates(payloads.map(encoding.fromBase64)));
    editor.socket.open();
    editor.socket.close();
    readyReplay(editor.socket);
    expect(syncPublishes(editor.socket)).toEqual(payloads);
    expect(editor.provider.hasUnsentChanges()).toBe(true);
    editor.socket.readyState = FakeWebSocket.OPEN;
    readyReplay(editor.socket);
    expect(syncPublishes(editor.socket)).toEqual([...payloads, merged]);
    echo(editor.socket, merged);
    expect(editor.provider.hasUnsentChanges()).toBe(false);
    editor.socket.open();
    readyReplay(editor.socket);
    expect(syncPublishes(editor.socket)).toEqual([...payloads, merged]);
  });

  test("reconnect publishes over 200 unconfirmed edits as one covering update", () => {
    using editor = localEditor();
    const server = new Y.Doc();
    try {
      server.getText("content").insert(0, "server");
      const serverState = Y.encodeStateAsUpdate(server);
      echo(editor.socket, encoding.toBase64(serverState));
      readyReplay(editor.socket);
      const text = editor.doc.getText("content");
      for (let i = 0; i < 205; i++) text.insert(text.length, ` ${i}`);
      expect(syncPublishes(editor.socket)).toHaveLength(205);

      const timers: Array<() => void> = [];
      const originalSetTimeout = globalThis.setTimeout;
      Object.assign(globalThis, { setTimeout: (fn: () => void) => timers.push(fn) });
      try {
        editor.socket.close();
        editor.socket.onclose?.({ code: 1006, reason: "" });
        timers.shift()!();
        const next = FakeWebSocket.instances.at(-1)!;
        next.open();
        expect(syncPublishes(next)).toEqual([]);
        readyReplay(next);
        const publishes = syncPublishes(next);
        expect(publishes).toHaveLength(1);
        Y.applyUpdate(server, encoding.fromBase64(publishes[0]!));
        expect(server.getText("content").toString()).toBe(text.toString());
        expect(editor.provider.hasUnsentChanges()).toBe(true);
        echo(next, publishes[0]!);
        expect(editor.provider.hasUnsentChanges()).toBe(false);
      } finally {
        Object.assign(globalThis, { setTimeout: originalSetTimeout });
      }
    } finally {
      server.destroy();
    }
  });

  test("local edits made while terminated remain pending and resume publishes a covering state", () => {
    let notifications = 0;
    using editor = localEditor(() => notifications++);
    const server = new Y.Doc();
    const recovered = new Y.Doc();
    try {
      server.getText("content").insert(0, "server");
      const serverState = Y.encodeStateAsUpdate(server);
      echo(editor.socket, encoding.toBase64(serverState));
      readyReplay(editor.socket);
      expect(editor.provider.hasUnsentChanges()).toBe(false);
      notifications = 0;
      editor.socket.message({ type: notebooksYjs.wsType.error, payload: { code: "SESSION_EXPIRED", message: "expired" } });
      editor.doc.getText("content").insert(6, " local");
      expect(editor.provider.hasUnsentChanges()).toBe(true);
      expect(notifications).toBe(1);
      expect(syncPublishes(editor.socket)).toEqual([]);

      editor.provider.resume();
      const next = FakeWebSocket.instances.at(-1)!;
      next.open();
      expect(syncPublishes(next)).toEqual([]);
      readyReplay(next);
      const publishes = syncPublishes(next);
      expect(publishes).toHaveLength(1);
      Y.applyUpdate(recovered, serverState);
      Y.applyUpdate(recovered, encoding.fromBase64(publishes[0]!));
      expect(recovered.getText("content").toString()).toBe("server local");
      expect(editor.provider.hasUnsentChanges()).toBe(true);
      echo(next, publishes[0]!);
      expect(editor.provider.hasUnsentChanges()).toBe(false);
    } finally {
      server.destroy();
      recovered.destroy();
    }
  });

  test("terminal session errors retain pending edits and resume ignores all stale socket events", () => {
    using editor = localEditor();
    readyReplay(editor.socket);
    editor.doc.getText("content").insert(0, "unsaved");
    const payloads = syncPublishes(editor.socket);
    editor.socket.message({ type: notebooksYjs.wsType.error, payload: { code: "SESSION_EXPIRED", message: "expired" } });
    expect(editor.provider.hasUnsentChanges()).toBe(true);
    editor.provider.resume();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const next = FakeWebSocket.instances[1]!;
    next.open();
    expect(replayRequests(next)).toEqual([null]);
    readyReplay(next);
    expect(syncPublishes(next)).toEqual(payloads);
    const timers: Array<() => void> = [];
    const originalSetTimeout = globalThis.setTimeout;
    Object.assign(globalThis, { setTimeout: (fn: () => void) => timers.push(fn) });
    try {
      editor.socket.onclose?.({ code: 1006, reason: "" });
      editor.socket.onopen?.();
      editor.socket.onerror?.();
      editor.socket.message({ type: notebooksYjs.wsType.error, payload: { code: "SESSION_EXPIRED", message: "late" } });
      editor.doc.getText("content").insert(7, " more");
      expect(syncPublishes(next)).toHaveLength(2);
      expect(replayRequests(next)).toEqual([null]);
      expect(next.readyState).toBe(FakeWebSocket.OPEN);
      expect(timers).toHaveLength(0);
    } finally {
      Object.assign(globalThis, { setTimeout: originalSetTimeout });
    }
  });

  test("termination preserves a needed full resync until resume", () => {
    using editor = localEditor();
    editor.doc.getText("content").insert(0, "before replay");
    editor.socket.message({ type: notebooksYjs.wsType.error, payload: { code: "SESSION_EXPIRED", message: "expired" } });
    expect(editor.provider.hasUnsentChanges()).toBe(true);
    editor.provider.resume();
    const next = FakeWebSocket.instances.at(-1)!;
    next.open();
    readyReplay(next);
    expect(syncPublishes(next)).toEqual([Buffer.from(Y.encodeStateAsUpdate(editor.doc)).toString("base64")]);
  });

  test("resume does nothing while connected or after disposal", () => {
    using editor = localEditor();
    editor.provider.resume();
    expect(FakeWebSocket.instances).toHaveLength(1);
    editor.socket.message({ type: notebooksYjs.wsType.error, payload: { code: "SESSION_EXPIRED", message: "expired" } });
    editor.provider.dispose();
    editor.provider.resume();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
