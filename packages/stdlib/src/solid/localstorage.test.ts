import { describe, it, expect } from "bun:test";
import { testRoot } from "../_test-helpers";
import { localStore } from "./localstorage";

// Mock localStorage
const store: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    clear: () => {
      for (const k in store) delete store[k];
    },
  },
  writable: true,
  configurable: true,
});

// Mock BroadcastChannel (no-op)
globalThis.BroadcastChannel = class {
  onmessage = null;
  postMessage() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true;
  }
} as any;

// ==========================
// create
// ==========================

describe("localStore.create", () => {
  it("returns store with default value when storage is empty", () => {
    const { result, dispose } = testRoot(() =>
      localStore.create("test-create-default", { name: "default", count: 0 }),
    );
    const [s] = result;
    expect(s.name).toBe("default");
    expect(s.count).toBe(0);
    expect(s._key).toBe("test-create-default");
    dispose();
  });

  it("reads existing value from storage", () => {
    store["test-existing"] = JSON.stringify({
      name: "stored",
      count: 42,
      _key: "test-existing",
    });
    const { result, dispose } = testRoot(() =>
      localStore.create("test-existing", { name: "default", count: 0 }),
    );
    const [s] = result;
    expect(s.name).toBe("stored");
    expect(s.count).toBe(42);
    dispose();
    delete store["test-existing"];
  });

  it("setStore persists to localStorage", () => {
    const { result, dispose } = testRoot(() =>
      localStore.create("test-persist", { value: "initial" }),
    );
    const [, setStore] = result;
    setStore("value", "updated");
    const raw = JSON.parse(store["test-persist"]!);
    expect(raw.value).toBe("updated");
    dispose();
    delete store["test-persist"];
  });
});

// ==========================
// exists
// ==========================

describe("localStore.exists", () => {
  it("returns false for non-existent key", () => {
    expect(localStore.exists("nonexistent")).toBe(false);
  });

  it("returns true for existing key", () => {
    store["exists-test"] = "{}";
    expect(localStore.exists("exists-test")).toBe(true);
    delete store["exists-test"];
  });
});

// ==========================
// remove
// ==========================

describe("localStore.remove", () => {
  it("removes a key from storage", () => {
    store["to-remove"] = "{}";
    localStore.remove("to-remove");
    expect(localStorage.getItem("to-remove")).toBeNull();
  });
});

// ==========================
// read
// ==========================

describe("localStore.read", () => {
  it("returns null for non-existent key", () => {
    expect(localStore.read("no-key")).toBeNull();
  });

  it("returns parsed value for existing key", () => {
    store["read-test"] = JSON.stringify({ a: 1, b: "two" });
    const val = localStore.read<{ a: number; b: string }>("read-test");
    expect(val).not.toBeNull();
    expect(val!.a).toBe(1);
    expect(val!.b).toBe("two");
    delete store["read-test"];
  });

  it("returns null for invalid JSON", () => {
    store["bad-json"] = "{not valid json";
    const origWarn = console.warn;
    console.warn = () => {}; // suppress expected warning
    const val = localStore.read("bad-json");
    console.warn = origWarn;
    expect(val).toBeNull();
    delete store["bad-json"];
  });
});

// ==========================
// modify
// ==========================

describe("localStore.modify", () => {
  it("writes a value to storage", () => {
    localStore.modify("mod-test", { x: 10 });
    const raw = JSON.parse(store["mod-test"]!);
    expect(raw.x).toBe(10);
    expect(raw._key).toBe("mod-test");
    delete store["mod-test"];
  });

  it("accepts a function updater", () => {
    store["mod-fn"] = JSON.stringify({ count: 5, _key: "mod-fn" });
    localStore.modify<{ count: number }>("mod-fn", (prev) => ({
      count: (prev?.count ?? 0) + 1,
    }));
    const raw = JSON.parse(store["mod-fn"]);
    expect(raw.count).toBe(6);
    delete store["mod-fn"];
  });
});
