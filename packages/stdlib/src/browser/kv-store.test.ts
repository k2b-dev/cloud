import { describe, it, expect, mock, beforeEach } from "bun:test";

// ─── OPFS in-memory mock ────────────────────────────────────────────────────────

const storage = new Map<string, Uint8Array>();

const mockOPFS = {
  read: async (path: string): Promise<Uint8Array | undefined> => {
    return storage.get(path);
  },
  write: async (path: string, data: Uint8Array): Promise<void> => {
    storage.set(path, new Uint8Array(data));
  },
  delete: async (path: string): Promise<void> => {
    for (const k of [...storage.keys()]) {
      if (k === path || k.startsWith(path + "/")) storage.delete(k);
    }
  },
  ls: async (): Promise<string[]> => [],
  getDirHandle: async () => ({}) as FileSystemDirectoryHandle,
};

// ─── Mock modules before import ─────────────────────────────────────────────────

const actualFiles = await import("./files");

mock.module("./files", () => ({
  ...actualFiles,
  OPFS: mockOPFS,
  files: { ...actualFiles.files, OPFS: mockOPFS },
}));

// Mock navigator.locks
(globalThis as any).navigator = {
  ...((globalThis as any).navigator ?? {}),
  locks: {
    request: async (_name: string, fn: () => Promise<any>) => fn(),
  },
};

// Mock BroadcastChannel
const bcInstances: Array<{ onmessage: ((e: any) => void) | null; postMessage: ReturnType<typeof mock> }> = [];

(globalThis as any).BroadcastChannel = class MockBroadcastChannel {
  onmessage: ((e: any) => void) | null = null;
  postMessage = mock((data: any) => {
    // Deliver to other channels (simulate cross-tab)
    for (const other of bcInstances) {
      if (other !== this && other.onmessage) {
        other.onmessage({ data } as any);
      }
    }
  });
  close() {
    const idx = bcInstances.indexOf(this as any);
    if (idx >= 0) bcInstances.splice(idx, 1);
  }
  constructor() {
    bcInstances.push(this as any);
  }
};

// ─── Import module under test (after mocks) ─────────────────────────────────────

const { kvStore } = await import("./kv-store");

// ─── Helpers ────────────────────────────────────────────────────────────────────

const resetStore = async () => {
  storage.clear();
  bcInstances.length = 0;
  await kvStore.clear();
};

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe("kvStore", () => {
  beforeEach(resetStore);

  // ── set / get ───────────────────────────────────────────────────────────────

  describe("set / get", () => {
    it("stores and retrieves a JSON value", async () => {
      await kvStore.set("key", { hello: "world" });
      const val = await kvStore.get<{ hello: string }>("key");
      expect(val).toEqual({ hello: "world" });
    });

    it("stores strings, numbers, arrays, and booleans", async () => {
      await kvStore.set("str", "hello");
      await kvStore.set("num", 42);
      await kvStore.set("arr", [1, 2, 3]);
      await kvStore.set("bool", true);

      expect(await kvStore.get<string>("str")).toBe("hello");
      expect(await kvStore.get<number>("num")).toBe(42);
      expect(await kvStore.get<number[]>("arr")).toEqual([1, 2, 3]);
      expect(await kvStore.get<boolean>("bool")).toBe(true);
    });

    it("stores null correctly", async () => {
      await kvStore.set("n", null);
      expect(await kvStore.get("n")).toBeNull();
    });

    it("overwrites existing values", async () => {
      await kvStore.set("key", "first");
      await kvStore.set("key", "second");
      expect(await kvStore.get<string>("key")).toBe("second");
    });

    it("returns undefined for missing keys", async () => {
      expect(await kvStore.get("nope")).toBeUndefined();
    });

    it("returns undefined when key was stored with setBytes", async () => {
      await kvStore.setBytes("bin", new Uint8Array([1, 2, 3]));
      expect(await kvStore.get("bin")).toBeUndefined();
    });
  });

  // ── setBytes / getBytes ─────────────────────────────────────────────────────

  describe("setBytes / getBytes", () => {
    it("stores and retrieves binary data", async () => {
      const data = new Uint8Array([0, 1, 2, 255, 128, 64]);
      await kvStore.setBytes("bin", data);
      const result = await kvStore.getBytes("bin");
      expect(result).toEqual(data);
    });

    it("handles empty byte arrays", async () => {
      await kvStore.setBytes("empty", new Uint8Array(0));
      const result = await kvStore.getBytes("empty");
      expect(result).toEqual(new Uint8Array(0));
    });

    it("returns undefined for missing keys", async () => {
      expect(await kvStore.getBytes("nope")).toBeUndefined();
    });

    it("returns undefined when key was stored with set", async () => {
      await kvStore.set("json", { a: 1 });
      expect(await kvStore.getBytes("json")).toBeUndefined();
    });

    it("overwrites previous value of any type", async () => {
      await kvStore.set("key", "json-value");
      await kvStore.setBytes("key", new Uint8Array([42]));
      expect(await kvStore.get("key")).toBeUndefined();
      expect(await kvStore.getBytes("key")).toEqual(new Uint8Array([42]));
    });

    it("stores large binary data as blob file", async () => {
      const large = new Uint8Array(8192); // > 4KB threshold
      for (let i = 0; i < large.length; i++) large[i] = i % 256;
      await kvStore.setBytes("large", large);
      const result = await kvStore.getBytes("large");
      expect(result).toEqual(large);
    });
  });

  // ── has ─────────────────────────────────────────────────────────────────────

  describe("has", () => {
    it("returns true for existing keys", async () => {
      await kvStore.set("x", 1);
      expect(await kvStore.has("x")).toBe(true);
    });

    it("returns false for missing keys", async () => {
      expect(await kvStore.has("nope")).toBe(false);
    });

    it("returns false after deletion", async () => {
      await kvStore.set("x", 1);
      await kvStore.delete("x");
      expect(await kvStore.has("x")).toBe(false);
    });

    it("works for both JSON and binary entries", async () => {
      await kvStore.set("json", "value");
      await kvStore.setBytes("bin", new Uint8Array([1]));
      expect(await kvStore.has("json")).toBe(true);
      expect(await kvStore.has("bin")).toBe(true);
    });
  });

  // ── keys ────────────────────────────────────────────────────────────────────

  describe("keys", () => {
    it("returns all keys sorted", async () => {
      await kvStore.set("b", 2);
      await kvStore.set("a", 1);
      await kvStore.set("c", 3);
      expect(await kvStore.keys()).toEqual(["a", "b", "c"]);
    });

    it("filters by prefix", async () => {
      await kvStore.set("user:1", "alice");
      await kvStore.set("user:2", "bob");
      await kvStore.set("config:theme", "dark");
      expect(await kvStore.keys("user:")).toEqual(["user:1", "user:2"]);
      expect(await kvStore.keys("config:")).toEqual(["config:theme"]);
    });

    it("returns empty array when no keys match", async () => {
      await kvStore.set("a", 1);
      expect(await kvStore.keys("nope:")).toEqual([]);
    });

    it("returns empty array for empty store", async () => {
      expect(await kvStore.keys()).toEqual([]);
    });
  });

  // ── meta ────────────────────────────────────────────────────────────────────

  describe("meta", () => {
    it("returns metadata for JSON entries", async () => {
      await kvStore.set("key", { x: 1 });
      const m = await kvStore.meta("key");
      expect(m).toBeDefined();
      expect(m!.key).toBe("key");
      expect(m!.type).toBe("json");
      expect(m!.size).toBeGreaterThan(0);
      expect(m!.timestamp).toBeGreaterThan(0);
    });

    it("returns metadata for binary entries", async () => {
      await kvStore.setBytes("bin", new Uint8Array(100));
      const m = await kvStore.meta("bin");
      expect(m).toBeDefined();
      expect(m!.type).toBe("bin");
      expect(m!.size).toBe(100);
    });

    it("returns undefined for missing keys", async () => {
      expect(await kvStore.meta("nope")).toBeUndefined();
    });
  });

  // ── size ────────────────────────────────────────────────────────────────────

  describe("size", () => {
    it("returns 0 for empty store", async () => {
      expect(await kvStore.size()).toBe(0);
    });

    it("reflects number of entries", async () => {
      await kvStore.set("a", 1);
      await kvStore.set("b", 2);
      await kvStore.setBytes("c", new Uint8Array([3]));
      expect(await kvStore.size()).toBe(3);
    });

    it("decreases on delete", async () => {
      await kvStore.set("a", 1);
      await kvStore.set("b", 2);
      await kvStore.delete("a");
      expect(await kvStore.size()).toBe(1);
    });
  });

  // ── delete ──────────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("removes a key", async () => {
      await kvStore.set("key", "value");
      await kvStore.delete("key");
      expect(await kvStore.get("key")).toBeUndefined();
      expect(await kvStore.has("key")).toBe(false);
    });

    it("is a no-op for missing keys", async () => {
      await kvStore.delete("nope"); // Should not throw
      expect(await kvStore.size()).toBe(0);
    });

    it("removes binary entries", async () => {
      await kvStore.setBytes("bin", new Uint8Array([1, 2, 3]));
      await kvStore.delete("bin");
      expect(await kvStore.getBytes("bin")).toBeUndefined();
    });
  });

  // ── clear ───────────────────────────────────────────────────────────────────

  describe("clear", () => {
    it("removes all entries", async () => {
      await kvStore.set("a", 1);
      await kvStore.set("b", 2);
      await kvStore.setBytes("c", new Uint8Array([3]));
      await kvStore.clear();
      expect(await kvStore.size()).toBe(0);
      expect(await kvStore.keys()).toEqual([]);
    });

    it("store is usable after clear", async () => {
      await kvStore.set("a", 1);
      await kvStore.clear();
      await kvStore.set("b", 2);
      expect(await kvStore.get<number>("b")).toBe(2);
      expect(await kvStore.size()).toBe(1);
    });
  });

  // ── watch ───────────────────────────────────────────────────────────────────

  describe("watch", () => {
    it("fires on set", async () => {
      const events: any[] = [];
      const unwatch = kvStore.watch((e) => events.push(e));
      await kvStore.set("key", "val");
      unwatch();
      expect(events).toEqual([{ type: "set", key: "key" }]);
    });

    it("fires on setBytes", async () => {
      const events: any[] = [];
      const unwatch = kvStore.watch((e) => events.push(e));
      await kvStore.setBytes("bin", new Uint8Array([1]));
      unwatch();
      expect(events).toEqual([{ type: "set", key: "bin" }]);
    });

    it("fires on delete", async () => {
      await kvStore.set("key", "val");
      const events: any[] = [];
      const unwatch = kvStore.watch((e) => events.push(e));
      await kvStore.delete("key");
      unwatch();
      expect(events).toEqual([{ type: "delete", key: "key" }]);
    });

    it("fires on clear", async () => {
      const events: any[] = [];
      const unwatch = kvStore.watch((e) => events.push(e));
      await kvStore.clear();
      unwatch();
      expect(events).toEqual([{ type: "clear", key: "" }]);
    });

    it("filters by prefix", async () => {
      const events: any[] = [];
      const unwatch = kvStore.watch((e) => events.push(e), "user:");
      await kvStore.set("user:1", "alice");
      await kvStore.set("config:theme", "dark");
      await kvStore.set("user:2", "bob");
      unwatch();
      expect(events).toEqual([
        { type: "set", key: "user:1" },
        { type: "set", key: "user:2" },
      ]);
    });

    it("stops receiving events after unwatch", async () => {
      const events: any[] = [];
      const unwatch = kvStore.watch((e) => events.push(e));
      await kvStore.set("a", 1);
      unwatch();
      await kvStore.set("b", 2);
      expect(events).toHaveLength(1);
    });

    it("ignores errors in watcher callbacks", async () => {
      const unwatch = kvStore.watch(() => { throw new Error("boom"); });
      await kvStore.set("key", "val"); // Should not throw
      unwatch();
    });
  });

  // ── inline vs blob threshold ────────────────────────────────────────────────

  describe("inline threshold", () => {
    it("stores small JSON inline (no blob file)", async () => {
      await kvStore.set("small", { x: 1 });
      // Check that no blob file was created — only index file should exist
      const blobFiles = [...storage.keys()].filter((k) => k.startsWith(".kvstore/blobs/"));
      expect(blobFiles).toHaveLength(0);
    });

    it("stores large JSON as blob file", async () => {
      const large = { data: "x".repeat(8192) };
      await kvStore.set("large", large);
      const blobFiles = [...storage.keys()].filter((k) => k.startsWith(".kvstore/blobs/"));
      expect(blobFiles).toHaveLength(1);
    });

    it("stores small binary inline (no blob file)", async () => {
      await kvStore.setBytes("small-bin", new Uint8Array(100));
      const blobFiles = [...storage.keys()].filter((k) => k.startsWith(".kvstore/blobs/"));
      expect(blobFiles).toHaveLength(0);
    });

    it("stores large binary as blob file", async () => {
      await kvStore.setBytes("large-bin", new Uint8Array(8192));
      const blobFiles = [...storage.keys()].filter((k) => k.startsWith(".kvstore/blobs/"));
      expect(blobFiles).toHaveLength(1);
    });

    it("cleans up old blob when overwriting with inline value", async () => {
      await kvStore.set("key", { data: "x".repeat(8192) }); // blob
      let blobs = [...storage.keys()].filter((k) => k.startsWith(".kvstore/blobs/"));
      expect(blobs).toHaveLength(1);

      await kvStore.set("key", "small"); // inline — should remove old blob
      blobs = [...storage.keys()].filter((k) => k.startsWith(".kvstore/blobs/"));
      expect(blobs).toHaveLength(0);
    });
  });

  // ── namespace export ────────────────────────────────────────────────────────

  describe("namespace", () => {
    it("exports all functions", () => {
      expect(typeof kvStore.set).toBe("function");
      expect(typeof kvStore.get).toBe("function");
      expect(typeof kvStore.setBytes).toBe("function");
      expect(typeof kvStore.getBytes).toBe("function");
      expect(typeof kvStore.has).toBe("function");
      expect(typeof kvStore.keys).toBe("function");
      expect(typeof kvStore.meta).toBe("function");
      expect(typeof kvStore.size).toBe("function");
      expect(typeof kvStore.delete).toBe("function");
      expect(typeof kvStore.clear).toBe("function");
      expect(typeof kvStore.watch).toBe("function");
      expect(typeof kvStore.destroy).toBe("function");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Regression: audit-pass fixes
  // ─────────────────────────────────────────────────────────────────────────────

  describe("regression — undefined / non-serializable values", () => {
    it("rejects top-level undefined with a clear TypeError", async () => {
      await expect(kvStore.set("k", undefined)).rejects.toThrow(/JSON-serializable/);
      // The key must NOT have been created.
      expect(await kvStore.has("k")).toBe(false);
    });

    it("rejects functions", async () => {
      await expect(kvStore.set("k", () => 1)).rejects.toThrow(TypeError);
    });

    it("rejects symbols", async () => {
      await expect(kvStore.set("k", Symbol("x") as unknown as object)).rejects.toThrow(TypeError);
    });
  });

  describe("regression — concurrent same-tab writes", () => {
    it("does not lose writes when two set() calls overlap", async () => {
      // Parallel writes to different keys: both must persist regardless of
      // which one acquires the lock first.
      await Promise.all([kvStore.set("a", 1), kvStore.set("b", 2)]);
      expect(await kvStore.get<number>("a")).toBe(1);
      expect(await kvStore.get<number>("b")).toBe(2);
    });

    it("last-write-wins for parallel writes to the same key", async () => {
      await Promise.all([kvStore.set("k", 1), kvStore.set("k", 2)]);
      const v = await kvStore.get<number>("k");
      expect([1, 2]).toContain(v as number);
    });
  });

  describe("regression — del on missing key", () => {
    it("does not emit delete events for keys that never existed", async () => {
      const events: string[] = [];
      const unwatch = kvStore.watch((e) => events.push(`${e.type}:${e.key}`));
      await kvStore.delete("nope");
      unwatch();
      expect(events).toEqual([]);
    });
  });

  describe("regression — clear fires for prefix watchers", () => {
    it("notifies prefix-filtered watchers on clear()", async () => {
      const events: string[] = [];
      const unwatch = kvStore.watch((e) => events.push(e.type), "user:");
      await kvStore.set("user:1", { name: "A" });
      await kvStore.clear();
      unwatch();
      expect(events).toContain("clear");
    });
  });

  describe("regression — corrupt index surfaces error", () => {
    it("throws on corrupt index instead of silently resetting", async () => {
      await kvStore.set("u", 1);
      // Corrupt the on-disk index.
      storage.set(".kvstore/_index.json", new TextEncoder().encode("not-json {"));
      kvStore.destroy(); // Drop in-memory cache so next get() re-reads.
      await expect(kvStore.get("u")).rejects.toThrow(/corrupt/);
    });
  });
});
