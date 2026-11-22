import { describe, it, expect, mock, afterEach } from "bun:test";

// Mock window and navigator BEFORE importing hotkeys so isBrowser is true
if (typeof window === "undefined") {
  Object.defineProperty(globalThis, "window", {
    value: {
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
    },
    writable: true,
    configurable: true,
  });
}
if (typeof navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (Macintosh)" },
    writable: true,
    configurable: true,
  });
}

// Mock solid-js so onMount fires immediately (needed for reactive owner path)
mock.module("solid-js", () => {
  const real = require("solid-js");
  return {
    ...real,
    onMount: (cb: Function) => {
      cb();
    },
  };
});

// Dynamic import AFTER mock setup so isBrowser captures the mocked window
const { hotkeys } = await import("./hotkeys");

// Since hotkeys uses a global singleton registry, each test must
// dispose its registrations to avoid leaking state.

describe("hotkeys.create", () => {
  it("registers hotkeys and exposes them via entries", async () => {
    const handler = mock(() => {});
    const { entries, dispose } = hotkeys.create({
      "mod+k": { label: "Search", run: handler },
    });

    // registerAll is async; wait a tick
    await Promise.resolve();

    const registered = entries();
    expect(registered.length).toBe(1);
    expect(registered[0]!.label).toBe("Search");
    expect(registered[0]!.keys).toContain("k");

    dispose();
  });

  it("registers multiple hotkeys", async () => {
    const { entries, dispose } = hotkeys.create({
      "mod+s": { label: "Save", run: () => {} },
      "mod+shift+s": { label: "Save As", run: () => {} },
    });

    await Promise.resolve();

    expect(entries().length).toBe(2);
    const labels = entries().map((e) => e.label);
    expect(labels).toContain("Save");
    expect(labels).toContain("Save As");

    dispose();
  });

  it("dispose cleans up registered entries", async () => {
    const { entries, dispose } = hotkeys.create({
      "mod+p": { label: "Print", run: () => {} },
    });

    await Promise.resolve();

    expect(entries().length).toBe(1);
    dispose();
    expect(entries().length).toBe(0);
  });

  it("returns empty entries when no config provided", async () => {
    const { entries, dispose } = hotkeys.create();
    await Promise.resolve();
    expect(entries()).toEqual([]);
    dispose();
  });

  it("pretty-prints key combinations", async () => {
    const { entries, dispose } = hotkeys.create({
      "mod+shift+k": { label: "Test", run: () => {} },
    });

    await Promise.resolve();

    const entry = entries()[0]!;
    expect(entry.keysPretty.length).toBeGreaterThan(0);
    for (const part of entry.keysPretty) {
      expect(typeof part.key).toBe("string");
      expect(part.key.length).toBeGreaterThan(0);
      expect(typeof part.ariaLabel).toBe("string");
    }

    dispose();
  });

  it("normalizes key combos (lowercases, sorts modifiers)", async () => {
    const { entries, dispose } = hotkeys.create({
      "Shift+Alt+K": { label: "Sorted", run: () => {} },
    });

    await Promise.resolve();

    const entry = entries()[0]!;
    // Modifiers should be sorted: alt before shift, then primary key
    expect(entry.keys).toBe("alt+shift+k");

    dispose();
  });

  it("dispose is idempotent", async () => {
    const { dispose } = hotkeys.create({
      "mod+j": { label: "Jump", run: () => {} },
    });

    await Promise.resolve();

    // Calling dispose multiple times should not throw
    dispose();
    dispose();
    dispose();
  });

  it("warns on duplicate combos and ignores the second registration", async () => {
    const warn = mock(() => {});
    const origWarn = console.warn;
    console.warn = warn;

    const { dispose: d1 } = hotkeys.create({
      "mod+q": { label: "First", run: () => {} },
    });
    await Promise.resolve();

    const { dispose: d2 } = hotkeys.create({
      "mod+q": { label: "Duplicate", run: () => {} },
    });
    await Promise.resolve();

    expect(warn).toHaveBeenCalled();
    const warnMsg = (warn.mock.calls as unknown as unknown[][]).find((call) =>
      String(call[0]).includes("duplicate"),
    );
    expect(warnMsg).toBeDefined();

    d2();
    d1();
    console.warn = origWarn;
  });

  it("includes desc when provided", async () => {
    const { entries, dispose } = hotkeys.create({
      "mod+d": { label: "Delete", desc: "Delete selected item", run: () => {} },
    });

    await Promise.resolve();

    expect(entries()[0]!.desc).toBe("Delete selected item");

    dispose();
  });
});

describe("hotkeys.entries", () => {
  it("is a callable signal returning an array", () => {
    expect(typeof hotkeys.entries).toBe("function");
    const entries = hotkeys.entries();
    expect(Array.isArray(entries)).toBe(true);
  });
});
