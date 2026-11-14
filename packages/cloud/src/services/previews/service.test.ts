import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createPreviewsService, type PreviewDependencies } from "./service";
import { type PreviewRow, type PreviewStore, previewHash } from "./store";
import { type PreviewSource, PreviewSourceChanged } from "./types";

const now = new Date("2026-11-11T12:00:00Z");
const source: PreviewSource = { key: "base:object", revision: "r1", name: "file.png", size: 100, locator: "opaque" };
afterEach(() => setSystemTime());
function fixture(persistent = true) {
  setSystemTime(now);
  const rows = new Map<string, PreviewRow>();
  const objects = new Map<string, Blob>();
  const queued: { source: PreviewSource; priority: string }[] = [];
  const locks = new Set<string>();
  const id = (s: PreviewSource) => `${previewHash(s.key)}:${s.revision}`;
  let shown = 0;
  const store: PreviewStore = {
    find: async (s) => rows.get(id(s)) ?? null,
    async put(s, state, variants = {}, error_code) {
      rows.set(id(s), {
        key_hash: previewHash(s.key),
        revision: s.revision,
        state,
        variants,
        bytes: Object.values(variants).reduce((n, v) => n + v.bytes, 0),
        created_at: now,
        shown_at: now,
        error_code: error_code ?? null,
      });
    },
    async shown(s) {
      const row = rows.get(id(s));
      if (row) row.shown_at = new Date();
      shown++;
    },
    async retry(s) {
      if (rows.get(id(s))?.state === "failed") rows.delete(id(s));
    },
    rows: async (hash) => [...rows.values()].filter((row) => row.key_hash === hash),
    async remove(row) {
      rows.delete(`${row.key_hash}:${row.revision}`);
    },
    eviction: async () => [...rows.values()].filter((row) => row.bytes > 0),
    async expireTerminal() {
      const old = [...rows.entries()].filter(([, row]) => row.state !== "ready" && Date.now() - row.created_at.getTime() > 30 * 86_400_000);
      for (const [key] of old) rows.delete(key);
      return old.length;
    },
    async withKey(key, run) {
      if (locks.has(key)) return null;
      locks.add(key);
      try {
        return { value: await run(store) };
      } finally {
        locks.delete(key);
      }
    },
  };
  const deps: PreviewDependencies = {
    store,
    persistent: async () => persistent,
    object: (key) => ({
      async write(blob) {
        objects.set(key, blob);
      },
      async delete() {
        objects.delete(key);
      },
      exists: async () => objects.has(key),
      stream: () => objects.get(key)!.stream(),
    }),
    async submit(source, priority) {
      if (!queued.some((job) => job.source.key === source.key && job.source.revision === source.revision && job.priority === priority))
        queued.push({ source, priority });
    },
    generate: async () => ({ small: new Blob(["small"], { type: "image/jpeg" }), large: new Blob(["large"], { type: "image/jpeg" }) }),
  };
  const service = createPreviewsService(deps);
  service.reader(async () => new Response("source"));
  return { service, deps, store, rows, objects, queued, shown: () => shown };
}

test("read pending → both variants ready, daily shown guard, and no requeue after ready", async () => {
  const f = fixture();
  expect(await f.service.read(source, "small")).toEqual({ state: "pending", retryAfter: 2 });
  expect(f.queued[0]?.priority).toBe("high");
  await f.service.work(source, new AbortController().signal);
  expect((await f.service.read(source, "large")).state).toBe("ready");
  expect(f.objects.size).toBe(2);
  await f.service.enqueue(source);
  expect(f.queued.length).toBe(1);
  expect(f.shown()).toBe(0);
  setSystemTime(new Date(now.getTime() + 86_400_001));
  await f.service.read(source, "small");
  await f.service.read(source, "small");
  expect(f.shown()).toBe(1);
});
test("failed revisions are remembered until retry; changed sources leave no failed row", async () => {
  const f = fixture();
  let calls = 0;
  f.deps.generate = async () => {
    calls++;
    throw new Error("broken");
  };
  await f.service.work(source, new AbortController().signal);
  expect(await f.service.read(source, "small")).toEqual({ state: "failed" });
  await f.service.enqueue(source);
  expect(f.queued.length).toBe(0);
  await f.service.work(source, new AbortController().signal);
  expect(calls).toBe(1);
  await f.service.retry(source);
  expect(await f.store.find(source)).toBeNull();
  expect(f.queued[0]?.priority).toBe("high");
  f.deps.generate = async () => {
    throw new PreviewSourceChanged();
  };
  await f.service.work(source, new AbortController().signal);
  expect(await f.store.find(source)).toBeNull();
});
test("limits and variant rules avoid reading source bytes", async () => {
  const f = fixture();
  f.deps.generate = async () => {
    throw new Error("must not generate");
  };
  expect(await f.service.read({ ...source, size: 32 * 1024 ** 2 + 1 }, "small")).toEqual({ state: "too_large" });
  expect(await f.service.read({ ...source, name: "x.txt" }, "large")).toEqual({ state: "unsupported" });
  expect(await f.service.read(source, "pdf")).toEqual({ state: "unsupported" });
  expect(await f.service.read({ ...source, name: "x.exe" }, "small")).toEqual({ state: "unsupported" });
  expect(f.queued).toEqual([]);
  await expect(f.service.read({ ...source, key: "ä".repeat(257) }, "small")).rejects.toThrow();
});
test("pass-through generates inline, enqueues nothing, remembers failures and shares two slots", async () => {
  const f = fixture(false);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  let entered!: () => void;
  const both = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.deps.generate = async () => {
    if (++started === 2) entered();
    await waiting;
    return { small: new Blob(["inline"]) };
  };
  const first = f.service.read(source, "small");
  const second = f.service.read({ ...source, key: "second" }, "small");
  await both;
  expect(await f.service.read({ ...source, key: "third" }, "small")).toEqual({ state: "pending", retryAfter: 2 });
  release();
  expect((await first).state).toBe("ready");
  expect((await second).state).toBe("ready");
  await f.service.enqueue(source);
  expect(f.queued).toEqual([]);
  expect(f.objects.size).toBe(0);
  expect(f.rows.size).toBe(0);
  f.deps.generate = async () => {
    throw new Error("invalid");
  };
  expect(await f.service.read(source, "small")).toEqual({ state: "failed" });
});
test("discard removes every revision and budget maintenance removes tracked objects", async () => {
  const f = fixture();
  for (const revision of ["r1", "r2"]) await f.service.work({ ...source, revision }, new AbortController().signal);
  expect(f.objects.size).toBe(4);
  await f.service.discard(source.key);
  expect(f.rows.size).toBe(0);
  expect(f.objects.size).toBe(0);
  await f.service.work(source, new AbortController().signal);
  expect(await f.service.maintain(0, new AbortController().signal)).toBe(1);
  expect(f.objects.size).toBe(0);
});

test("remembered failures expire after their retention, so byte-free rows cannot grow forever", async () => {
  const f = fixture();
  f.deps.generate = async () => {
    throw new Error("invalid");
  };
  await f.service.work(source, new AbortController().signal);
  expect(await f.service.read(source, "small")).toEqual({ state: "failed" });
  expect(await f.service.maintain(1_000_000, new AbortController().signal)).toBe(0);
  setSystemTime(new Date(now.getTime() + 31 * 86_400_000));
  expect(await f.service.maintain(1_000_000, new AbortController().signal)).toBe(1);
  expect(f.rows.size).toBe(0);
});

test("a stalled object write ends at the job deadline and leaves no row", async () => {
  const f = fixture();
  const write = f.deps.object;
  f.deps.object = (key) => ({ ...write(key), write: () => new Promise(() => {}) });
  const job = new AbortController();
  const done = f.service.work(source, job.signal);
  await Bun.sleep(10);
  job.abort();
  await done;
  expect(f.rows.size).toBe(0);
});

test("a failed metadata transaction does not leave generated objects behind", async () => {
  const f = fixture();
  const withKey = f.store.withKey;
  f.store.withKey = async (key, run) => {
    await withKey(key, run);
    f.rows.clear(); // The database rolls back the metadata when its transaction fails.
    throw new Error("commit failed");
  };
  await expect(f.service.work(source, new AbortController().signal)).rejects.toThrow("commit failed");
  expect(f.objects.size).toBe(0);
  expect(f.rows.size).toBe(0);
});
