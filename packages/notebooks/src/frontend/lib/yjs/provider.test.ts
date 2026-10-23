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
    socket.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID, restoreRevision: "0" } });
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

    socket.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID, restoreRevision: "0" } });
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
      recovered.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID, restoreRevision: "0" } });
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

  test("unsent edits keep the retry budget and backoff until storage accepts a write", () => {
    const doc = new Y.Doc();
    const fatal: string[] = [];
    const timers: Array<() => void> = [];
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const random = spyOn(Math, "random").mockReturnValue(0);
    Object.assign(globalThis, {
      setTimeout: (fn: () => void, delay: number) => {
        delays.push(delay);
        return timers.push(fn);
      },
    });
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
        socket.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID, restoreRevision: "0" } });
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
      // The retries spread over the backoff instead of stopping after a few seconds.
      expect(delays).toEqual([2_000, 4_000, 8_000, 16_000]);
      expect(provider.hasUnsentChanges()).toBe(true);
      provider.dispose();
    } finally {
      random.mockRestore();
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
      socket.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID, restoreRevision: "0" } });
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
const readyReplay = (socket: FakeWebSocket) =>
  socket.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID, restoreRevision: "0" } });
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
  test("notifies after the native transaction when a publish is pending and when its echo clears it", async () => {
    let notifications = 0;
    using editor = localEditor(() => notifications++);
    readyReplay(editor.socket);
    await Promise.resolve();
    notifications = 0;
    editor.doc.getText("content").insert(0, "keep this");
    expect(notifications).toBe(0);
    await Promise.resolve();
    expect(notifications).toBe(1);
    expect(editor.provider.hasUnsentChanges()).toBe(true);
    const payload = syncPublishes(editor.socket)[0]!;
    echo(editor.socket, payload);
    await Promise.resolve();
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

  test("local edits made while terminated remain pending and resume publishes a covering state", async () => {
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
      await Promise.resolve();
      notifications = 0;
      editor.socket.message({ type: notebooksYjs.wsType.error, payload: { code: "SESSION_EXPIRED", message: "expired" } });
      editor.doc.getText("content").insert(6, " local");
      expect(editor.provider.hasUnsentChanges()).toBe(true);
      expect(notifications).toBe(0);
      await Promise.resolve();
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

  test("a replay ready queued behind a terminal error does not restart the editor", () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    let ready = 0;
    const provider = createYjsProvider({ doc, awareness, noteId: NOTE_ID, appUrl: "http://localhost", onReady: () => ready++ });
    try {
      provider.connect();
      const socket = FakeWebSocket.instances.at(-1)!;
      socket.open();
      readyReplay(socket);
      doc.getText("content").insert(0, "unsaved");
      socket.message({ type: notebooksYjs.wsType.error, payload: { code: "SESSION_EXPIRED", message: "expired" } });
      readyReplay(socket);
      expect(ready).toBe(1);
      expect(syncPublishes(socket)).toHaveLength(1);
      expect(provider.hasUnsentChanges()).toBe(true);
    } finally {
      provider.dispose();
      awareness.destroy();
      doc.destroy();
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

describe("manual reconnect", () => {
  test("retries immediately, cancels backoff, resets failures and avoids duplicate sockets", () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const timers: Array<{ fn: () => void; delay: number }> = [];
    const originalTimeout = globalThis.setTimeout;
    Object.assign(globalThis, {
      setTimeout: (fn: () => void, delay: number) => {
        timers.push({ fn, delay });
        return timers.length;
      },
    });
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    const random = spyOn(Math, "random").mockReturnValue(0);
    const provider = createYjsProvider({ doc, awareness, noteId: NOTE_ID, appUrl: "http://localhost" });
    try {
      provider.connect();
      const first = FakeWebSocket.instances[0]!;
      first.readyState = 0;
      provider.reconnectNow();
      first.open();
      provider.reconnectNow();
      expect(FakeWebSocket.instances).toHaveLength(1);
      first.close();
      first.onclose?.({ code: 1006, reason: "" });
      const timer = timers.length;
      expect(timers.at(-1)?.delay).toBe(reconnectDelayMs(0, 0));
      provider.reconnectNow();
      expect(clear).toHaveBeenCalledWith(timer);
      expect(FakeWebSocket.instances).toHaveLength(2);
      const second = FakeWebSocket.instances[1]!;
      second.close();
      second.onclose?.({ code: 1006, reason: "" });
      expect(timers.at(-1)?.delay).toBe(reconnectDelayMs(0, 0));
      provider.dispose();
      provider.reconnectNow();
      expect(FakeWebSocket.instances).toHaveLength(2);
    } finally {
      provider.dispose();
      awareness.destroy();
      doc.destroy();
      Object.assign(globalThis, { setTimeout: originalTimeout });
      clear.mockRestore();
      random.mockRestore();
    }
  });

  test("terminal sessions stay stopped", () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const provider = createYjsProvider({ doc, awareness, noteId: NOTE_ID, appUrl: "http://localhost" });
    try {
      provider.connect();
      const socket = FakeWebSocket.instances[0]!;
      socket.open();
      socket.message({ type: notebooksYjs.wsType.error, payload: { code: "ACCESS_REVOKED" } });
      provider.reconnectNow();
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      provider.dispose();
      awareness.destroy();
      doc.destroy();
    }
  });
});

describe("server table action receipts", () => {
  test("replay-ready and echoed local edits gate structure; the live receipt creates one undo step without republishing", async () => {
    const doc = new Y.Doc(),
      server = new Y.Doc();
    doc.clientID = 101;
    server.clientID = 202;
    doc.getText("codemirror").insert(0, "base");
    Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
    const awareness = new Awareness(doc),
      undoManager = new Y.UndoManager(doc.getText("codemirror"));
    const provider = createYjsProvider({
      doc,
      awareness,
      undoManager,
      initialRestoreRevision: "7",
      noteId: NOTE_ID,
      appUrl: "http://localhost",
    });
    try {
      provider.connect();
      const socket = FakeWebSocket.instances[0]!;
      socket.open();
      expect(provider.canStructure()).toBe(false);
      socket.message({
        type: notebooksYjs.wsType.replayReady,
        payload: { noteId: NOTE_ID, cursor: "s6t.fixture.1", restoreRevision: "7" },
      });
      expect(provider.restoreRevision()).toBe("7");
      expect(provider.canStructure()).toBe(true);
      const action = provider.beginAction("action");
      expect(provider.canStructure()).toBe(false);
      const before = Y.encodeStateVector(server);
      server.getText("codemirror").insert(4, " table");
      const update = encoding.toBase64(Y.encodeStateAsUpdate(server, before));
      const sent = socket.sent.length;
      socket.message({
        type: notebooksYjs.wsType.syncPush,
        payload: { noteId: NOTE_ID, updates: [{ cursor: "s6t.fixture.2", payload: update, actionId: "action" }] },
      });
      await action.applied;
      expect(socket.sent).toHaveLength(sent);
      expect(provider.canStructure()).toBe(true);
      expect(undoManager.undoStack).toHaveLength(0);
      provider.setInverseHandler(async (request) => {
        expect(request.action).toBe("undo");
        expect(request.receiptCursor).toBe("s6t.fixture.2");
        const vector = Y.encodeStateVector(server);
        server.getText("codemirror").delete(4, 6);
        socket.message({
          type: notebooksYjs.wsType.syncPush,
          payload: {
            noteId: NOTE_ID,
            updates: [
              { cursor: "s6t.fixture.3", actionId: request.actionId, payload: encoding.toBase64(Y.encodeStateAsUpdate(server, vector)) },
            ],
          },
        });
      });
      await provider.undo();
      expect(doc.getText("codemirror").toString()).toBe("base");
      expect(socket.sent).toHaveLength(sent); // Structural inverse never publishes raw sync bytes.
      expect(provider.canStructure()).toBe(true);
      doc.getText("codemirror").insert(4, " input");
      const typed = JSON.parse(socket.sent.at(-1)!);
      expect(provider.canStructure()).toBe(false);
      socket.message({
        type: notebooksYjs.wsType.syncPush,
        payload: { noteId: NOTE_ID, updates: [{ cursor: "s6t.fixture.4", payload: typed.payload.payload }] },
      });
      expect(provider.canStructure()).toBe(true);
      await provider.undo();
      expect(doc.getText("codemirror").toString()).toBe("base");
      expect(provider.canStructure()).toBe(false);
      const undo = JSON.parse(socket.sent.at(-1)!);
      socket.message({
        type: notebooksYjs.wsType.syncPush,
        payload: { noteId: NOTE_ID, updates: [{ cursor: "s6t.fixture.5", payload: undo.payload.payload }] },
      });
      expect(provider.canStructure()).toBe(true);
    } finally {
      provider.dispose();
      undoManager.destroy();
      awareness.destroy();
      doc.destroy();
      server.destroy();
    }
  });

  test("a pending action survives a dropped connection and is tracked during ordered replay", async () => {
    const doc = new Y.Doc(),
      server = new Y.Doc();
    doc.clientID = 101;
    server.clientID = 202;
    const awareness = new Awareness(doc),
      undoManager = new Y.UndoManager(doc.getText("codemirror"));
    const provider = createYjsProvider({ doc, awareness, undoManager, noteId: NOTE_ID, appUrl: "http://localhost" });
    try {
      provider.connect();
      const socket = FakeWebSocket.instances[0]!;
      socket.open();
      socket.message({
        type: notebooksYjs.wsType.replayReady,
        payload: { noteId: NOTE_ID, cursor: "s6t.fixture.0", restoreRevision: "0" },
      });
      const action = provider.beginAction("pending");
      socket.close();
      socket.onclose?.({ code: 1006, reason: "" });
      provider.reconnectNow();
      const next = FakeWebSocket.instances.at(-1)!;
      next.open();
      expect(replayRequests(next)).toEqual(["s6t.fixture.0"]);
      server.getText("codemirror").insert(0, "table");
      next.message({
        type: notebooksYjs.wsType.syncPush,
        payload: {
          noteId: NOTE_ID,
          updates: [{ cursor: "s6t.fixture.1", payload: encoding.toBase64(Y.encodeStateAsUpdate(server)), actionId: "pending" }],
        },
      });
      await action.applied;
      next.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID, cursor: "s6t.fixture.1", restoreRevision: "0" } });
      provider.setInverseHandler(async (request) => {
        expect(request.receiptCursor).toBe("s6t.fixture.1");
        const vector = Y.encodeStateVector(server);
        server.getText("codemirror").delete(0, 5);
        next.message({
          type: notebooksYjs.wsType.syncPush,
          payload: {
            noteId: NOTE_ID,
            updates: [
              { cursor: "s6t.fixture.2", actionId: request.actionId, payload: encoding.toBase64(Y.encodeStateAsUpdate(server, vector)) },
            ],
          },
        });
      });
      await provider.undo();
      expect(doc.getText("codemirror").toString()).toBe("");
    } finally {
      provider.dispose();
      undoManager.destroy();
      awareness.destroy();
      doc.destroy();
      server.destroy();
    }
  });

  test("malformed document updates stop visibly without advancing coverage or losing unsent text", () => {
    const doc = new Y.Doc();
    doc.clientID = 101;
    const awareness = new Awareness(doc);
    const fatal: string[] = [];
    const provider = createYjsProvider({
      doc,
      awareness,
      noteId: NOTE_ID,
      appUrl: "http://localhost",
      onFatal: (error) => fatal.push(error.code),
    });
    try {
      provider.connect();
      const socket = FakeWebSocket.instances[0]!;
      socket.open();
      socket.message({
        type: notebooksYjs.wsType.replayReady,
        payload: { noteId: NOTE_ID, cursor: "s6t.fixture.1", restoreRevision: "0" },
      });
      doc.getText("codemirror").insert(0, "keep me");
      socket.message({
        type: notebooksYjs.wsType.syncPush,
        payload: { noteId: NOTE_ID, updates: [{ cursor: "s6t.fixture.2", payload: "////" }] },
      });
      expect(fatal).toEqual(["INVALID_PAYLOAD"]);
      expect(provider.hasUnsentChanges()).toBe(true);
      expect(doc.getText("codemirror").toString()).toBe("keep me");
      provider.resume();
      const next = FakeWebSocket.instances.at(-1)!;
      next.open();
      expect(replayRequests(next)).toEqual(["s6t.fixture.1"]);
    } finally {
      provider.dispose();
      awareness.destroy();
      doc.destroy();
    }
  });
});

test("a stale versioned server update cannot alter a restored note; a newer lineage requires reopening", () => {
  const original = new Y.Doc({ gc: false }),
    old = new Y.Doc({ gc: false }),
    local = new Y.Doc();
  original.clientID = 101;
  old.clientID = 202;
  local.clientID = 303;
  original.getText("codemirror").insert(0, "KEEP");
  const base = Y.encodeStateAsUpdate(original);
  Y.applyUpdate(old, base);
  Y.applyUpdate(local, base);
  old.getText("codemirror").delete(0, 4);
  const vector = Y.encodeStateVector(old);
  old.getText("codemirror").insert(0, "repair");
  const awareness = new Awareness(local);
  const failures: string[] = [];
  const provider = createYjsProvider({
    doc: local,
    awareness,
    initialRestoreRevision: "1",
    noteId: NOTE_ID,
    appUrl: "http://localhost",
    onFatal: (error) => failures.push(error.code),
  });
  try {
    provider.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.message({
      type: notebooksYjs.wsType.syncPush,
      payload: {
        noteId: NOTE_ID,
        snapshot: true,
        restoreRevision: "1",
        updates: [{ cursor: "s6t.fixture.1", payload: encoding.toBase64(base) }],
      },
    });
    socket.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID, cursor: "s6t.fixture.1", restoreRevision: "1" } });
    const payload = encoding.toBase64(Y.encodeStateAsUpdate(old, vector));
    socket.message({
      type: notebooksYjs.wsType.syncPush,
      payload: { noteId: NOTE_ID, updates: [{ cursor: "s6t.fixture.2", payload, restoreRevision: "0" }] },
    });
    expect(local.getText("codemirror").toString()).toBe("KEEP");
    expect(failures).toEqual([]);
    socket.message({
      type: notebooksYjs.wsType.syncPush,
      payload: { noteId: NOTE_ID, updates: [{ cursor: "s6t.fixture.3", payload, restoreRevision: "2" }] },
    });
    expect(local.getText("codemirror").toString()).toBe("KEEP");
    expect(failures).toEqual(["RESYNC_REQUIRED"]);
    provider.resume();
    expect(FakeWebSocket.instances).toHaveLength(1);
  } finally {
    provider.dispose();
    awareness.destroy();
    original.destroy();
    old.destroy();
    local.destroy();
  }
});

test("cursor reconnect never relabels historical deletes after a restore or republishes offline text", () => {
  const doc = new Y.Doc(),
    restored = new Y.Doc();
  doc.clientID = 101;
  restored.clientID = 202;
  doc.getText("codemirror").insert(0, "TOKEN");
  Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));
  doc.getText("codemirror").delete(0, 5);
  const awareness = new Awareness(doc);
  const failures: string[] = [];
  let ready = 0;
  const provider = createYjsProvider({
    doc,
    awareness,
    noteId: NOTE_ID,
    appUrl: "http://localhost",
    initialRestoreRevision: "0",
    onFatal: (error) => failures.push(error.code),
    onReady: () => ready++,
  });
  try {
    provider.connect();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID, cursor: "s6t.fixture.1", restoreRevision: "0" } });
    first.close();
    provider.reconnectNow();
    const next = FakeWebSocket.instances[1]!;
    next.open();
    expect(JSON.parse(next.sent[0]!).payload).toMatchObject({ fromCursor: "s6t.fixture.1", restoreRevision: "0" });
    doc.getText("codemirror").insert(0, "OFFLINE");
    next.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID, cursor: "s6t.fixture.1", restoreRevision: "1" } });
    expect(failures).toEqual(["RESYNC_REQUIRED"]);
    expect(provider.restoreRevision()).toBe("0");
    expect(ready).toBe(1);
    expect(syncPublishes(next)).toEqual([]);
    expect(doc.getText("codemirror").toString()).toBe("OFFLINE");
    expect(restored.getText("codemirror").toString()).toBe("TOKEN");
    expect(provider.hasUnsentChanges()).toBe(true);
    provider.resume();
    expect(FakeWebSocket.instances).toHaveLength(2);
  } finally {
    provider.dispose();
    awareness.destroy();
    doc.destroy();
    restored.destroy();
  }
});

test("initial snapshot and cursor keep their revision during versioned catchup and every publication", () => {
  const doc = new Y.Doc(),
    server = new Y.Doc();
  server.clientID = 101;
  doc.clientID = 202;
  server.getText("codemirror").insert(0, "BASE");
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
  const before = Y.encodeStateVector(server);
  server.getText("codemirror").insert(4, " PEER");
  const awareness = new Awareness(doc);
  const provider = createYjsProvider({
    doc,
    awareness,
    noteId: NOTE_ID,
    appUrl: "http://localhost",
    initialCursor: "s6t.fixture.1",
    initialRestoreRevision: "3",
  });
  try {
    provider.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.message({
      type: notebooksYjs.wsType.syncPush,
      payload: {
        noteId: NOTE_ID,
        updates: [{ cursor: "s6t.fixture.2", payload: encoding.toBase64(Y.encodeStateAsUpdate(server, before)), restoreRevision: "3" }],
      },
    });
    socket.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID, cursor: "s6t.fixture.2", restoreRevision: "3" } });
    expect(doc.getText("codemirror").toString()).toBe("BASE PEER");
    doc.getText("codemirror").insert(0, "LOCAL ");
    socket.close();
    provider.reconnectNow();
    const next = FakeWebSocket.instances[1]!;
    next.open();
    next.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID, cursor: "s6t.fixture.2", restoreRevision: "3" } });
    for (const connection of [socket, next]) {
      const publications = connection.sent
        .map((value) => JSON.parse(value))
        .filter((value) => value.type === notebooksYjs.wsType.syncPublish);
      expect(publications).toHaveLength(1);
      expect(publications[0].payload.restoreRevision).toBe("3");
    }
    next.message({
      type: notebooksYjs.wsType.error,
      payload: { code: "RESYNC_REQUIRED", reopen: true, message: "Reopen the restored note", noteId: NOTE_ID },
    });
    provider.resume();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(provider.hasUnsentChanges()).toBe(true);
  } finally {
    provider.dispose();
    awareness.destroy();
    doc.destroy();
    server.destroy();
  }
});

test("a populated document or initial cursor cannot initialize without its revision", () => {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const opts = { doc, awareness, noteId: NOTE_ID, appUrl: "http://localhost" };
  try {
    expect(() => createYjsProvider({ ...opts, initialCursor: "s6t.fixture.1" })).toThrow("initialRestoreRevision");
    doc.clientID = 101;
    doc.getText("codemirror").insert(0, "TOKEN");
    doc.getText("codemirror").delete(0, 5);
    expect(() => createYjsProvider(opts)).toThrow("initialRestoreRevision");
  } finally {
    awareness.destroy();
    doc.destroy();
  }
});

test("stale ingress recovery preserves original payloads, cursors and readable input across replay/full-state resend", () => {
  const doc = new Y.Doc(),
    server = new Y.Doc();
  doc.clientID = 101;
  doc.getText("codemirror").insert(0, "original target");
  Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
  const awareness = new Awareness(doc);
  const fatal: string[] = [];
  const provider = createYjsProvider({
    doc,
    awareness,
    noteId: NOTE_ID,
    appUrl: "http://localhost",
    initialCursor: "s6t.fixture.1",
    initialRestoreRevision: "0",
    onFatal: (error) => fatal.push(error.code),
  });
  try {
    provider.connect();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID, cursor: "s6t.fixture.1", restoreRevision: "0" } });
    doc.getText("codemirror").insert(0, "UNCONFIRMED ");
    const originalPayload = syncPublishes(socket)[0]!;
    socket.open(); // Temporarily disconnected from replay coverage.
    doc.getText("codemirror").insert(12, "OFFLINE ");
    const readable = doc.getText("codemirror").toString();
    const before = Y.encodeStateVector(server);
    server.getText("codemirror").delete(0, server.getText("codemirror").length);
    socket.message({
      type: notebooksYjs.wsType.syncPush,
      payload: {
        noteId: NOTE_ID,
        updates: [{ cursor: "s6t.fixture.2", payload: encoding.toBase64(Y.encodeStateAsUpdate(server, before)) }],
      },
    });
    socket.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID, cursor: "s6t.fixture.2", restoreRevision: "0" } });
    const publishes = socket.sent.map((wire) => JSON.parse(wire)).filter((wire) => wire.type === notebooksYjs.wsType.syncPublish);
    expect(publishes).toHaveLength(2);
    expect(publishes.every((wire) => wire.payload.baseCursor === "s6t.fixture.1")).toBe(true);
    expect(provider.recoveryInput().pending).toContainEqual({ payload: originalPayload, baseCursor: "s6t.fixture.1" });
    expect(provider.recoveryInput().text).toBe(readable);
    socket.message({ type: notebooksYjs.wsType.error, payload: { code: "RESYNC_REQUIRED", reopen: true, message: "Copy unsent input" } });
    expect(fatal).toEqual(["RESYNC_REQUIRED"]);
    expect(provider.hasUnsentChanges()).toBe(true);
    expect(provider.recoveryInput().text).toBe(readable);
    expect(provider.recoveryInput().pending).toContainEqual({ payload: originalPayload, baseCursor: "s6t.fixture.1" });
    provider.resume();
    expect(FakeWebSocket.instances).toHaveLength(1);
  } finally {
    provider.dispose();
    awareness.destroy();
    doc.destroy();
    server.destroy();
  }
});

test("delayed echoes stop at the existing payload budget with every pending byte recoverable", async () => {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const fatal: unknown[] = [];
  let editing = false;
  const provider = createYjsProvider({
    doc,
    awareness,
    noteId: NOTE_ID,
    appUrl: "http://localhost",
    initialRestoreRevision: "0",
    onFatal: (error) => {
      expect(editing).toBe(false);
      fatal.push(error);
    },
  });
  try {
    provider.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.message({ type: notebooksYjs.wsType.replayReady, payload: { noteId: NOTE_ID, restoreRevision: "0" } });
    const text = doc.getText("codemirror");
    const edits: string[] = [];
    doc.on("update", (update: Uint8Array) => edits.push(encoding.toBase64(update)));
    // Small document, growing unacknowledged log: bounded by the real transport
    // envelope, rather than a test-only cap or a maximum action count.
    for (let count = 0; count < 40 && !fatal.length; count++) {
      editing = true;
      text.insert(0, "x".repeat(500_000));
      editing = false;
      await Promise.resolve();
      if (!fatal.length) {
        editing = true;
        text.delete(0, text.length);
        editing = false;
        await Promise.resolve();
      }
    }
    expect(fatal).toHaveLength(1);
    expect(provider.recoveryInput().pending.map((entry) => entry.payload)).toEqual(edits);
    expect(provider.recoveryInput().text).toBe(text.toString());
    expect(provider.hasUnsentChanges()).toBe(true);
    expect(provider.canStructure()).toBe(false);
    expect(provider.recoveryInput().pending.reduce((length, entry) => length + entry.payload.length, 0)).toBeGreaterThan(
      2 * notebooksYjs.maxSyncPayloadLength,
    );
    const count = provider.recoveryInput().pending.length;
    text.insert(0, "more");
    expect(provider.recoveryInput().pending).toHaveLength(count);
    expect(provider.recoveryInput().text).toBe(text.toString());
  } finally {
    provider.dispose();
    awareness.destroy();
    doc.destroy();
  }
});
