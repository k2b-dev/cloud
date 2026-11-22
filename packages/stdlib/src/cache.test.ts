import { describe, it, expect, mock } from "bun:test";
import { createCache } from "./cache";

// ==========================
// createCache
// ==========================

describe("createCache", () => {
  // ── get / set basics ──────────────────────────────────────────────────────

  describe("get / set", () => {
    it("stores and retrieves a value", async () => {
      const c = createCache<string>();
      await c.set("key", "hello");
      expect(await c.get("key")).toBe("hello");
    });

    it("returns null for missing keys", async () => {
      const c = createCache<string>();
      expect(await c.get("nope")).toBeNull();
    });

    it("stores numbers, objects, and arrays", async () => {
      const c = createCache<unknown>();
      await c.set("num", 42);
      await c.set("obj", { a: 1 });
      await c.set("arr", [1, 2, 3]);

      expect(await c.get("num")).toBe(42);
      expect(await c.get("obj")).toEqual({ a: 1 });
      expect(await c.get("arr")).toEqual([1, 2, 3]);
    });

    it("overwrites existing values", async () => {
      const c = createCache<string>();
      await c.set("key", "first");
      await c.set("key", "second");
      expect(await c.get("key")).toBe("second");
    });

    it("set returns the stored value", async () => {
      const c = createCache<number>();
      const result = await c.set("key", 42);
      expect(result).toBe(42);
    });
  });

  // ── updater function ──────────────────────────────────────────────────────

  describe("updater function", () => {
    it("receives current value", async () => {
      const c = createCache<number>();
      await c.set("count", 10);
      const result = await c.set("count", (prev) => (prev ?? 0) + 1);
      expect(result).toBe(11);
    });

    it("receives null when key is missing", async () => {
      const c = createCache<number>();
      const result = await c.set("count", (prev) => (prev ?? 0) + 1);
      expect(result).toBe(1);
    });

    it("supports async updater", async () => {
      const c = createCache<string>();
      await c.set("key", "hello");
      const result = await c.set("key", async (prev) => `${prev} world`);
      expect(result).toBe("hello world");
    });
  });

  // ── TTL expiration ────────────────────────────────────────────────────────

  describe("TTL expiration", () => {
    it("expires entries after TTL", async () => {
      const c = createCache<string>({ ttl: 50 });
      await c.set("key", "value");
      expect(await c.get("key")).toBe("value");

      await new Promise((r) => setTimeout(r, 80));
      expect(await c.get("key")).toBeNull();
    });

    it("resets TTL on overwrite", async () => {
      const c = createCache<string>({ ttl: 60 });
      await c.set("key", "first");

      await new Promise((r) => setTimeout(r, 40));
      await c.set("key", "second"); // Reset TTL

      await new Promise((r) => setTimeout(r, 40));
      // Would have expired (40+40 = 80 > 60) without reset
      expect(await c.get("key")).toBe("second");
    });

    it("has returns false for expired entries", async () => {
      const c = createCache<string>({ ttl: 30 });
      await c.set("key", "value");
      expect(c.has("key")).toBe(true);

      await new Promise((r) => setTimeout(r, 50));
      expect(c.has("key")).toBe(false);
    });
  });

  // ── onMiss ────────────────────────────────────────────────────────────────

  describe("onMiss", () => {
    it("calls onMiss for missing keys", async () => {
      const onMiss = mock(async (key: string) => `loaded:${key}`);
      const c = createCache<string>({ onMiss });

      const result = await c.get("user:1");
      expect(result).toBe("loaded:user:1");
      expect(onMiss).toHaveBeenCalledWith("user:1");
    });

    it("caches the onMiss result", async () => {
      let calls = 0;
      const c = createCache<string>({
        onMiss: async () => { calls++; return "loaded"; },
      });

      await c.get("key"); // Triggers onMiss
      await c.get("key"); // Should use cache
      expect(calls).toBe(1);
    });

    it("does not cache null return from onMiss", async () => {
      let calls = 0;
      const c = createCache<string>({
        onMiss: async () => { calls++; return null; },
      });

      expect(await c.get("key")).toBeNull();
      expect(await c.get("key")).toBeNull();
      expect(calls).toBe(2); // Called each time since null is not cached
    });

    it("calls onMiss for expired entries", async () => {
      const onMiss = mock(async () => "refreshed");
      const c = createCache<string>({ ttl: 30, onMiss });

      await c.set("key", "original");
      await new Promise((r) => setTimeout(r, 50));

      const result = await c.get("key");
      expect(result).toBe("refreshed");
      expect(onMiss).toHaveBeenCalledTimes(1);
    });
  });

  // ── beforePurge ───────────────────────────────────────────────────────────

  describe("beforePurge", () => {
    it("fires when entry expires via TTL", async () => {
      const beforePurge = mock((_key: string, _value: string) => {});
      const c = createCache<string>({ ttl: 30, beforePurge });

      await c.set("key", "value");
      await new Promise((r) => setTimeout(r, 60));

      expect(beforePurge).toHaveBeenCalledWith("key", "value");
    });

    it("does not fire on manual delete", async () => {
      const beforePurge = mock((_key: string, _value: string) => {});
      const c = createCache<string>({ ttl: 5000, beforePurge });

      await c.set("key", "value");
      c.delete("key");
      await new Promise((r) => setTimeout(r, 20));

      expect(beforePurge).not.toHaveBeenCalled();
    });
  });

  // ── has ─────────────────────────────────────────────────────────────────────

  describe("has", () => {
    it("returns true for existing keys", async () => {
      const c = createCache<number>();
      await c.set("key", 42);
      expect(c.has("key")).toBe(true);
    });

    it("returns false for missing keys", () => {
      const c = createCache<number>();
      expect(c.has("nope")).toBe(false);
    });
  });

  // ── delete ──────────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("removes a key", async () => {
      const c = createCache<string>();
      await c.set("key", "value");
      c.delete("key");
      expect(await c.get("key")).toBeNull();
    });

    it("is a no-op for missing keys", () => {
      const c = createCache<string>();
      c.delete("nope"); // Should not throw
    });
  });

  // ── clear ───────────────────────────────────────────────────────────────────

  describe("clear", () => {
    it("removes all entries", async () => {
      const c = createCache<number>();
      await c.set("a", 1);
      await c.set("b", 2);
      await c.set("c", 3);
      c.clear();
      expect(c.size()).toBe(0);
      expect(await c.get("a")).toBeNull();
    });
  });

  // ── size ────────────────────────────────────────────────────────────────────

  describe("size", () => {
    it("returns 0 for empty cache", () => {
      const c = createCache<number>();
      expect(c.size()).toBe(0);
    });

    it("reflects number of entries", async () => {
      const c = createCache<number>();
      await c.set("a", 1);
      await c.set("b", 2);
      expect(c.size()).toBe(2);
    });

    it("decreases on delete", async () => {
      const c = createCache<number>();
      await c.set("a", 1);
      await c.set("b", 2);
      c.delete("a");
      expect(c.size()).toBe(1);
    });

    it("does not count expired entries", async () => {
      const c = createCache<number>({ ttl: 30 });
      await c.set("key", 42);
      expect(c.size()).toBe(1);

      await new Promise((r) => setTimeout(r, 50));
      expect(c.size()).toBe(0);
    });
  });
});
