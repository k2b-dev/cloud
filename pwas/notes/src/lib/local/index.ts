/**
 * openNotesStore({ backend?, channelFactory?, locks?, now?, onError? }) opens the browser store.
 * records/subscribe expose the live index; open returns a shared local Y.Doc handle.
 * flush retries failed writes and flushes derived metadata; unsaved stays true on failure.
 * close flushes, compacts under Web Locks and disposes timers/docs/channel. Always await it.
 * Without IndexedDB the store remains usable in memory, reporting unavailable and unsaved.
 */
import * as Y from "yjs";
import { recordWriting } from "../activity";
import { deriveMeta } from "../derive";
import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_NOTE,
  NOTE_TEXT,
  type NoteRecord,
  type NoteShare,
  type StoreErrorCode,
  type StoreUsage,
} from "../model";
import { type Backend, MemoryBackend, type Snapshot, type StoredFile, type Write } from "./backend";
import { openIndexedDB } from "./indexeddb";

export type { Backend, StoredFile } from "./backend";
export { MemoryBackend } from "./backend";

export type OpenNote = { id: string; doc: Y.Doc; text: Y.Text; close(): Promise<void> };
export type RecordPatch = Partial<Pick<NoteRecord, "share" | "pendingDelete" | "openedAt">>;
export interface NotesStore {
  records(): NoteRecord[];
  subscribe(fn: () => void): () => void;
  create(text?: string, opts?: { id?: string; share?: NoteShare; createdAt?: number; updatedAt?: number }): Promise<string>;
  open(id: string): Promise<OpenNote>;
  encodeState(id: string): Promise<Uint8Array>;
  applyUpdate(id: string, update: Uint8Array, origin?: unknown): Promise<void>;
  update(id: string, patch: RecordPatch): Promise<void>;
  remove(id: string): Promise<void>;
  putFile(noteId: string, blob: Blob, name: string, opts?: { key?: string }): Promise<string>;
  getFile(noteId: string, key: string): Promise<Blob | null>;
  removeFile(noteId: string, key: string): Promise<void>;
  listFiles(noteId: string): Promise<StoredFile[]>;
  usage(): Promise<StoreUsage>;
  requestPersistence(): Promise<boolean>;
  clearAll(): Promise<void>;
  onError(fn: (code: StoreErrorCode, error: unknown) => void): () => void;
  unsaved(): boolean;
  flush(): Promise<void>;
  close(): Promise<void>;
}
type Message = { kind: "writes"; writes: Write[] };
export interface TabChannel {
  postMessage(message: Message): void;
  onmessage: ((event: MessageEvent<Message>) => void) | null;
  close(): void;
}
export interface CompactLocks {
  request(name: string, callback: () => Promise<void>): Promise<unknown>;
}
export type StoreOptions = {
  backend?: Backend;
  channelFactory?: (name: string) => TabChannel;
  locks?: CompactLocks | null;
  now?: () => number;
  onError?: (code: StoreErrorCode, error: unknown) => void;
};
export function randomId(): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let id = "";
  while (id.length < 22) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < 248 && id.length < 22) id += alphabet[byte % 62];
    }
  }
  return id;
}
export async function openNotesStore(opts: StoreOptions = {}): Promise<NotesStore> {
  const errors = new Set<(code: StoreErrorCode, error: unknown) => void>();
  if (opts.onError) errors.add(opts.onError);
  let lastError: { code: StoreErrorCode; error: unknown } | undefined;
  const notifyError = (error: unknown) => {
    const code = error instanceof DOMException && error.name === "QuotaExceededError" ? "quota" : "unavailable";
    lastError = { code, error };
    for (const fn of errors) fn(code, error);
  };
  let channel: TabChannel | undefined;
  try {
    channel = opts.channelFactory
      ? opts.channelFactory("k2b-notes")
      : typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel("k2b-notes")
        : undefined;
  } catch (error) {
    notifyError(error);
  }
  const incoming: Message[] = [];
  if (channel)
    channel.onmessage = (event) => {
      incoming.push(event.data);
    };
  let backend: Backend = new MemoryBackend();
  let memoryOnly = false;
  let snapshot: Snapshot;
  try {
    backend = opts.backend ?? (await openIndexedDB());
    snapshot = await backend.load();
  } catch (error) {
    backend.close();
    notifyError(error);
    memoryOnly = true;
    backend = new MemoryBackend();
    snapshot = await backend.load();
  }
  const now = opts.now ?? Date.now;
  const records = new Map(snapshot.records.map((record) => [record.id, record]));
  const files = new Map(snapshot.files.map((file) => [`${file.noteId}:${file.key}`, file]));
  const docs = new Map<string, Y.Doc>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const counts = new Map<string, number>();
  const compacting = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let pending: Write[] = [];
  let writing: Promise<void> = Promise.resolve();
  let closed = false;
  let inFlight = false;
  const locks = opts.locks === undefined ? globalThis.navigator?.locks : opts.locks;
  const emit = () => {
    for (const fn of listeners) fn();
  };
  const assertOpen = () => {
    if (closed) throw new Error("Store closed");
  };
  const requireRecord = (id: string) => {
    const record = records.get(id);
    if (!record) throw new Error(`Unknown note: ${id}`);
    return record;
  };
  const broadcast = (writes: Write[]) => {
    try {
      channel?.postMessage({ kind: "writes", writes });
    } catch (error) {
      notifyError(error);
    }
  };
  function persist(): Promise<void> {
    writing = writing.then(async () => {
      if (!pending.length) return;
      const batch = pending.splice(0);
      inFlight = true;
      try {
        await backend.write(batch);
        if (!memoryOnly) broadcast(batch);
        if (!pending.length && !memoryOnly) lastError = undefined;
      } catch (error) {
        pending.unshift(...batch);
        notifyError(error);
      }
      inFlight = false;
      emit();
    });
    return writing;
  }
  function queue(writes: Write[]): Promise<void> {
    const snapshot = structuredClone(writes);
    pending.push(...snapshot);
    emit();
    return persist();
  }
  function metadata(id: string): void {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    const record = records.get(id);
    const doc = docs.get(id);
    if (!record || !doc) return;
    record.meta = deriveMeta(doc.getText(NOTE_TEXT).toString());
    void queue([{ kind: "patch", id, patch: { meta: record.meta, updatedAt: record.updatedAt } }]);
  }
  function compact(id: string): Promise<void> {
    const existing = compacting.get(id);
    if (existing) return existing;
    if (!locks || pending.length || memoryOnly || (counts.get(id) ?? 0) <= 1) return Promise.resolve();
    const count = counts.get(id) ?? 0;
    const operation = (async () => {
      try {
        await locks.request(`k2b-notes:compact:${id}`, async () => {
          await backend.compact(id);
        });
        counts.set(id, Math.max(1, (counts.get(id) ?? 0) - count + 1));
      } catch (error) {
        notifyError(error);
      } finally {
        compacting.delete(id);
      }
    })();
    compacting.set(id, operation);
    return operation;
  }
  function attach(id: string, doc: Y.Doc): void {
    docs.set(id, doc);
    let previous = doc.getText(NOTE_TEXT).toString();
    doc.on("update", (update: Uint8Array, origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
      const text = doc.getText(NOTE_TEXT).toString();
      const changed = text !== previous;
      previous = text;
      if (origin === "remote-tab") return;
      const record = requireRecord(id);
      if (changed) {
        record.updatedAt = now();
        if (transaction.local && origin !== "import") recordWriting(record.updatedAt);
        const timer = timers.get(id);
        if (timer) clearTimeout(timer);
        timers.set(
          id,
          setTimeout(() => metadata(id), 300),
        );
      }
      counts.set(id, (counts.get(id) ?? 0) + 1);
      void queue([
        { kind: "update", noteId: id, update },
        ...(changed ? [{ kind: "patch" as const, id, patch: { updatedAt: record.updatedAt } }] : []),
      ]).then(async () => {
        if ((counts.get(id) ?? 0) >= 200) await compact(id);
      });
    });
  }
  const updatesByNote = new Map<string, Uint8Array[]>();
  for (const row of snapshot.updates) {
    const updates = updatesByNote.get(row.noteId) ?? [];
    updates.push(row.update);
    updatesByNote.set(row.noteId, updates);
  }
  for (const record of snapshot.records) {
    const doc = new Y.Doc();
    for (const update of updatesByNote.get(record.id) ?? []) {
      Y.applyUpdate(doc, update);
      counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
    }
    record.meta = deriveMeta(doc.getText(NOTE_TEXT).toString());
    attach(record.id, doc);
  }
  function discard(id: string): void {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    pending = pending.filter((write) => {
      if (write.kind === "record") return write.record.id !== id;
      if (write.kind === "update" || write.kind === "file" || write.kind === "removeFile")
        return (write.kind === "file" ? write.file.noteId : write.noteId) !== id;
      if (write.kind === "patch" || write.kind === "remove") return write.id !== id;
      return true;
    });
    docs.get(id)?.destroy();
    docs.delete(id);
    records.delete(id);
    counts.delete(id);
    for (const [key, file] of files) if (file.noteId === id) files.delete(key);
  }
  const receive = (data: Message) => {
    if (closed || data.kind !== "writes") return;
    const changed = new Set<string>();
    for (const write of data.writes) {
      if (write.kind === "clear") for (const id of records.keys()) discard(id);
      if (write.kind === "remove") discard(write.id);
      if (write.kind === "record" && !records.has(write.record.id)) {
        records.set(write.record.id, structuredClone(write.record));
        attach(write.record.id, new Y.Doc());
        changed.add(write.record.id);
      }
      if (write.kind === "patch") {
        const record = records.get(write.id);
        if (record) {
          const { meta: _meta, updatedAt, ...patch } = write.patch;
          Object.assign(record, patch);
          if (updatedAt !== undefined) record.updatedAt = Math.max(record.updatedAt, updatedAt);
        }
      }
      if (write.kind === "removeFile") files.delete(`${write.noteId}:${write.key}`);
      if (write.kind === "file") files.set(`${write.file.noteId}:${write.file.key}`, write.file);
      if (write.kind === "update") {
        const doc = docs.get(write.noteId);
        if (doc) {
          Y.applyUpdate(doc, write.update, "remote-tab");
          counts.set(write.noteId, (counts.get(write.noteId) ?? 0) + 1);
          changed.add(write.noteId);
        }
      }
    }
    for (const id of changed) {
      const record = records.get(id);
      const doc = docs.get(id);
      if (record && doc) record.meta = deriveMeta(doc.getText(NOTE_TEXT).toString());
    }
    emit();
  };
  if (channel) channel.onmessage = (event) => receive(event.data);
  for (const data of incoming) receive(data);
  incoming.length = 0;
  const store: NotesStore = {
    records: () => structuredClone([...records.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))),
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    async create(text = "", options = {}) {
      assertOpen();
      const id = options.id ?? randomId();
      if (!/^[A-Za-z0-9]{22}$/.test(id) || records.has(id)) throw new Error("Invalid or duplicate note ID");
      const timestamp = now();
      const doc = new Y.Doc();
      doc.getText(NOTE_TEXT).insert(0, text);
      const record: NoteRecord = {
        id,
        meta: deriveMeta(text),
        createdAt: options.createdAt ?? timestamp,
        updatedAt: options.updatedAt ?? timestamp,
        openedAt: timestamp,
        share: options.share ?? null,
        pendingDelete: false,
      };
      records.set(id, record);
      counts.set(id, 1);
      attach(id, doc);
      await queue([
        { kind: "record", record },
        { kind: "update", noteId: id, update: Y.encodeStateAsUpdate(doc) },
      ]);
      return id;
    },
    async open(id) {
      assertOpen();
      requireRecord(id);
      const doc = docs.get(id);
      if (!doc) throw new Error("Missing document");
      await store.update(id, { openedAt: now() });
      let released = false;
      return {
        id,
        doc,
        text: doc.getText(NOTE_TEXT),
        async close() {
          if (released) return;
          released = true;
          await store.flush();
          await compact(id);
        },
      };
    },
    async encodeState(id) {
      assertOpen();
      requireRecord(id);
      const doc = docs.get(id);
      if (!doc) throw new Error("Missing document");
      return Y.encodeStateAsUpdate(doc);
    },
    async applyUpdate(id, update, origin = "external") {
      assertOpen();
      requireRecord(id);
      const doc = docs.get(id);
      if (!doc) throw new Error("Missing document");
      Y.applyUpdate(doc, update, origin);
      await store.flush();
    },
    async update(id, patch) {
      assertOpen();
      Object.assign(requireRecord(id), patch);
      await queue([{ kind: "patch", id, patch }]);
    },
    async remove(id) {
      assertOpen();
      requireRecord(id);
      discard(id);
      await queue([{ kind: "remove", id }]);
    },
    async putFile(noteId, blob, name, options = {}) {
      assertOpen();
      requireRecord(noteId);
      const key = options.key ?? randomId();
      if (!/^[A-Za-z0-9]{22}$/.test(key)) throw new Error("Invalid file key");
      const existing = files.has(`${noteId}:${key}`);
      if (
        blob.size > MAX_FILE_BYTES ||
        (!existing && [...files.values()].filter((file) => file.noteId === noteId).length >= MAX_FILES_PER_NOTE)
      )
        throw new Error("File limit exceeded");
      const file = { noteId, key, blob, name };
      files.set(`${noteId}:${key}`, file);
      await queue([{ kind: "file", file }]);
      return key;
    },
    async removeFile(noteId, key) {
      assertOpen();
      requireRecord(noteId);
      files.delete(`${noteId}:${key}`);
      await queue([{ kind: "removeFile", noteId, key }]);
    },
    async getFile(noteId, key) {
      return files.get(`${noteId}:${key}`)?.blob ?? null;
    },
    async listFiles(noteId) {
      return [...files.values()].filter((file) => file.noteId === noteId).map((file) => ({ ...file }));
    },
    async usage(): Promise<StoreUsage> {
      const storage = globalThis.navigator?.storage;
      const estimate = await storage?.estimate().catch(() => undefined);
      return {
        notes: records.size,
        files: files.size,
        bytes: estimate?.usage ?? [...files.values()].reduce((size, file) => size + file.blob.size, 0),
        quota: estimate?.quota ?? null,
        persisted: (await storage?.persisted().catch(() => false)) ?? false,
      };
    },
    async requestPersistence() {
      return (await globalThis.navigator?.storage?.persist().catch(() => false)) ?? false;
    },
    async clearAll() {
      assertOpen();
      for (const id of records.keys()) discard(id);
      await queue([{ kind: "clear" }]);
    },
    onError(fn) {
      errors.add(fn);
      if (lastError) fn(lastError.code, lastError.error);
      return () => {
        errors.delete(fn);
      };
    },
    unsaved: () => memoryOnly || inFlight || pending.length > 0 || timers.size > 0,
    async flush() {
      for (const id of [...timers.keys()]) metadata(id);
      await persist();
    },
    async close() {
      if (closed) return;
      await store.flush();
      for (const id of records.keys()) await compact(id);
      await Promise.all(compacting.values());
      closed = true;
      channel?.close();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const doc of docs.values()) doc.destroy();
      backend.close();
      listeners.clear();
    },
  };
  return store;
}
