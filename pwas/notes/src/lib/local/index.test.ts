import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { NOTE_TEXT } from "../model";
import type { Write } from "./backend";
import { type CompactLocks, MemoryBackend, openNotesStore, type TabChannel } from "./index";

const NOW = 1793318400000;
const locks: CompactLocks = {
  async request(_name, callback) {
    await callback();
  },
};
const options = () => ({ backend: new MemoryBackend(), now: () => NOW, locks });

describe("notes store", () => {
  test("creates IDs, persists real Yjs changes, reopens and sorts records", async () => {
    const opts = options();
    const store = await openNotesStore(opts);
    const id = await store.create("# Titel");
    expect(id).toMatch(/^[A-Za-z0-9]{22}$/);
    const note = await store.open(id);
    note.text.insert(note.text.length, "\n#tag\nInhalt");
    await store.flush();
    expect(store.unsaved()).toBe(false);
    expect(store.records()[0]?.meta.tags).toEqual(["tag"]);
    await note.close();
    await store.close();
    const restored = await openNotesStore(opts);
    expect((await restored.open(id)).text.toString()).toBe("# Titel\n#tag\nInhalt");
    await restored.close();
  });
  test("compaction at 200 updates and close preserves all text", async () => {
    const opts = options();
    const store = await openNotesStore(opts);
    const id = await store.create();
    const note = await store.open(id);
    for (let i = 0; i < 220; i++) note.text.insert(note.text.length, "x");
    await note.close();
    const state = await opts.backend.load();
    expect(state.updates).toHaveLength(1);
    const doc = new Y.Doc();
    for (const row of state.updates) Y.applyUpdate(doc, row.update);
    expect(doc.getText(NOTE_TEXT).toString()).toBe("x".repeat(220));
    doc.destroy();
    await store.close();
  });
  test("does not compact without Web Locks", async () => {
    const opts = options();
    const store = await openNotesStore({ ...opts, locks: null });
    const id = await store.create("a");
    const note = await store.open(id);
    note.text.insert(1, "b");
    await note.close();
    expect((await opts.backend.load()).updates.length).toBeGreaterThan(1);
    await store.close();
  });
  test("quota failure is visible, retained and retried on the next write", async () => {
    class FailingBackend extends MemoryBackend {
      fail = true;
      override async write(writes: readonly Write[]) {
        if (this.fail) throw new DOMException("full", "QuotaExceededError");
        await super.write(writes);
      }
    }
    const backend = new FailingBackend();
    const sent: unknown[] = [];
    const store = await openNotesStore({
      backend,
      now: () => NOW,
      locks,
      channelFactory: () => ({
        onmessage: null,
        postMessage(message) {
          sent.push(message);
        },
        close() {},
      }),
    });
    const errors: string[] = [];
    store.onError((code) => errors.push(code));
    const id = await store.create("retained");
    expect(store.unsaved()).toBe(true);
    expect(errors).toContain("quota");
    expect(sent).toHaveLength(0);
    backend.fail = false;
    await store.update(id, { openedAt: NOW + 1 });
    expect(sent.length).toBeGreaterThan(0);
    expect(store.unsaved()).toBe(false);
    await store.close();
    const restored = await openNotesStore({ backend, now: () => NOW, locks });
    expect((await restored.open(id)).text.toString()).toBe("retained");
    await restored.close();
  });
  test("unavailable IndexedDB falls back to memory and replays its error to subscribers", async () => {
    class Unavailable extends MemoryBackend {
      override async load(): Promise<never> {
        throw new Error("unavailable");
      }
    }
    const store = await openNotesStore({ backend: new Unavailable(), now: () => NOW });
    const errors: string[] = [];
    store.onError((code) => errors.push(code));
    const id = await store.create("memory");
    expect((await store.open(id)).text.toString()).toBe("memory");
    expect(errors).toContain("unavailable");
    expect(store.unsaved()).toBe(true);
    await store.close();
  });
  test("only real text changes update timestamps; file storage and clear", async () => {
    let now = NOW;
    const store = await openNotesStore({ ...options(), now: () => now });
    const id = await store.create("a");
    const note = await store.open(id);
    now++;
    note.doc.getMap("other").set("key", "value");
    await store.flush();
    expect(store.records()[0]?.updatedAt).toBe(NOW);
    note.text.insert(1, "b");
    await store.flush();
    expect(store.records()[0]?.updatedAt).toBe(now);
    const key = await store.putFile(id, new Blob(["png"], { type: "image/png" }), "x.png");
    expect(await (await store.getFile(id, key))?.text()).toBe("png");
    expect((await store.usage()).files).toBe(1);
    await store.clearAll();
    expect(store.records()).toEqual([]);
    expect(await store.getFile(id, key)).toBeNull();
    await store.close();
  });
  test("two tabs converge under concurrent edits, keep file and index changes, and reopen", async () => {
    const channels = new Set<TabChannel>();
    const messages: (() => void)[] = [];
    const factory = (): TabChannel => {
      const channel: TabChannel = {
        onmessage: null,
        postMessage(message) {
          for (const other of channels)
            if (other !== channel) messages.push(() => other.onmessage?.(new MessageEvent("message", { data: structuredClone(message) })));
        },
        close() {
          channels.delete(channel);
        },
      };
      channels.add(channel);
      return channel;
    };
    const deliver = () => {
      for (const message of messages.splice(0)) message();
    };
    const opts = { ...options(), channelFactory: factory };
    const first = await openNotesStore(opts);
    const second = await openNotesStore(opts);
    const id = await first.create("Start");
    deliver();
    const a = await first.open(id);
    const b = await second.open(id);
    deliver();
    a.text.insert(0, "A");
    b.text.insert(0, "B");
    await first.flush();
    await second.flush();
    deliver();
    expect(a.text.toString()).toBe(b.text.toString());
    expect(a.text.toString()).toContain("Start");
    expect(a.text.toString()).toContain("A");
    expect(a.text.toString()).toContain("B");
    await first.update(id, { pendingDelete: true });
    deliver();
    expect(second.records()[0]?.pendingDelete).toBe(true);
    const key = await first.putFile(id, new Blob(["file"]), "f");
    deliver();
    expect(await second.getFile(id, key)).not.toBeNull();
    const expected = a.text.toString();
    await first.close();
    await second.close();
    const restored = await openNotesStore({ ...opts, channelFactory: factory });
    expect((await restored.open(id)).text.toString()).toBe(expected);
    await restored.close();
  });
});

test("buffers broadcasts during initial backend loading", async () => {
  const backend = new MemoryBackend();
  const base = await openNotesStore({ backend, now: () => NOW, locks: null });
  const id = await base.create("Start");
  const before = await backend.load();
  await base.close();
  let finishLoad: ((snapshot: typeof before) => void) | undefined;
  const loading = new Promise<typeof before>((resolve) => {
    finishLoad = resolve;
  });
  const delayed = { load: () => loading, write: backend.write.bind(backend), compact: backend.compact.bind(backend), close() {} };
  let channel: TabChannel | undefined;
  const opened = openNotesStore({
    backend: delayed,
    now: () => NOW,
    locks: null,
    channelFactory() {
      const value: TabChannel = { onmessage: null, postMessage() {}, close() {} };
      channel = value;
      return value;
    },
  });
  const doc = new Y.Doc();
  for (const row of before.updates) Y.applyUpdate(doc, row.update);
  doc.getText(NOTE_TEXT).insert(0, "remote ");
  channel?.onmessage?.(
    new MessageEvent("message", { data: { kind: "writes", writes: [{ kind: "update", noteId: id, update: Y.encodeStateAsUpdate(doc) }] } }),
  );
  finishLoad?.(before);
  const store = await opened;
  expect((await store.open(id)).text.toString()).toBe("remote Start");
  await store.close();
  doc.destroy();
});

test("broadcasts only after commit, including when another tab opens during that commit", async () => {
  let release = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  class Delayed extends MemoryBackend {
    override async write(writes: readonly Write[]) {
      await barrier;
      await super.write(writes);
    }
  }
  const backend = new Delayed();
  const channels = new Set<TabChannel>();
  const factory = (): TabChannel => {
    const channel: TabChannel = {
      onmessage: null,
      postMessage(data) {
        for (const other of channels)
          if (other !== channel) other.onmessage?.(new MessageEvent("message", { data: structuredClone(data) }));
      },
      close() {
        channels.delete(channel);
      },
    };
    channels.add(channel);
    return channel;
  };
  const opts = { backend, channelFactory: factory, now: () => NOW, locks: null };
  const first = await openNotesStore(opts);
  const creating = first.create("committed later");
  const second = await openNotesStore(opts);
  expect(second.records()).toHaveLength(0);
  release();
  const id = await creating;
  expect(second.records()).toHaveLength(1);
  expect((await second.open(id)).text.toString()).toBe("committed later");
  await first.close();
  await second.close();
});
test("backend drops late updates and files after a note was removed", async () => {
  const opts = options();
  const store = await openNotesStore(opts);
  const id = await store.create("old");
  const update = await store.encodeState(id);
  await store.remove(id);
  await opts.backend.write([
    { kind: "update", noteId: id, update },
    { kind: "file", file: { noteId: id, key: "K".repeat(22), name: "old.png", blob: new Blob(["old"]) } },
  ]);
  await opts.backend.compact(id);
  expect((await opts.backend.load()).updates).toEqual([]);
  expect((await opts.backend.load()).files).toEqual([]);
  await store.create("new", { id });
  expect((await store.open(id)).text.toString()).toBe("new");
  await store.close();
});
