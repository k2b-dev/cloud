import { describe, it, expect, mock, beforeEach } from "bun:test";

// Track document listeners so we can invoke them manually
const docListeners = new Map<string, Set<Function>>();
const cleanupFns: Function[] = [];

// Ensure document exists with working event listener tracking. Some Bun
// runtimes expose a partial `document` global (typeof !== "undefined") that
// lacks `addEventListener` — detect that and install the mock anyway.
const docHasListeners =
  typeof document !== "undefined" &&
  typeof (document as any).addEventListener === "function";

if (!docHasListeners) {
  (globalThis as any).document = {
    addEventListener: (event: string, handler: Function) => {
      if (!docListeners.has(event)) docListeners.set(event, new Set());
      docListeners.get(event)!.add(handler);
    },
    removeEventListener: (event: string, handler: Function) => {
      docListeners.get(event)?.delete(handler);
    },
  };
} else {
  // Wrap existing document methods to capture handlers
  const origAdd = document.addEventListener.bind(document);
  const origRemove = document.removeEventListener.bind(document);
  document.addEventListener = ((event: string, handler: any, ...rest: any[]) => {
    if (!docListeners.has(event)) docListeners.set(event, new Set());
    docListeners.get(event)!.add(handler);
    origAdd(event, handler, ...rest);
  }) as any;
  document.removeEventListener = ((event: string, handler: any, ...rest: any[]) => {
    docListeners.get(event)?.delete(handler);
    origRemove(event, handler, ...rest);
  }) as any;
}

// Mock solid-js to make onMount execute immediately and capture onCleanup
mock.module("solid-js", () => {
  const real = require("solid-js");
  return {
    ...real,
    onMount: (cb: Function) => {
      cb();
    },
    onCleanup: (cb: Function) => {
      cleanupFns.push(cb);
      real.onCleanup(cb);
    },
  };
});

// Import AFTER mock.module so the patched onMount is used
const { clickOutside } = await import("./click-outside");
const { createRoot } = await import("solid-js");

/** Dispatch a fake event to all registered document listeners */
const dispatchTo = (eventName: string, data: any) => {
  const handlers = docListeners.get(eventName);
  if (handlers) {
    for (const handler of handlers) {
      handler(data);
    }
  }
};

/** Create a fake Node-like target */
const fakeNodeTarget = () => {
  // We need event.target instanceof Node to pass. Since Node may not exist
  // in the test env, create a minimal mock.
  if (typeof Node === "undefined") {
    (globalThis as any).Node = class Node {};
  }
  return Object.create(Node.prototype);
};

beforeEach(() => {
  docListeners.clear();
  cleanupFns.length = 0;
});

describe("clickOutside.create", () => {
  it("calls callback when clicking outside the element", () => {
    const callback = mock(() => {});

    let ref!: (el: HTMLElement) => void;
    const dispose = createRoot((d) => {
      ref = clickOutside.create(callback);
      return d;
    });

    // The mocked onMount should have fired, registering a mousedown listener
    expect(docListeners.has("mousedown")).toBe(true);

    // Attach a fake element that says "click is NOT inside me"
    const el = { contains: mock(() => false) } as unknown as HTMLElement;
    ref(el);

    // Simulate mousedown outside the element
    dispatchTo("mousedown", { target: fakeNodeTarget() });

    expect(callback).toHaveBeenCalledTimes(1);

    dispose();
  });

  it("does NOT call callback when clicking inside the element", () => {
    const callback = mock(() => {});

    let ref!: (el: HTMLElement) => void;
    const dispose = createRoot((d) => {
      ref = clickOutside.create(callback);
      return d;
    });

    // Attach a fake element that says "click IS inside me"
    const el = { contains: mock(() => true) } as unknown as HTMLElement;
    ref(el);

    dispatchTo("mousedown", { target: fakeNodeTarget() });

    expect(callback).not.toHaveBeenCalled();

    dispose();
  });

  it("does not call callback when no element has been attached via ref", () => {
    const callback = mock(() => {});

    const dispose = createRoot((d) => {
      clickOutside.create(callback);
      return d;
    });

    // Fire mousedown without ever calling ref (element is null)
    dispatchTo("mousedown", { target: fakeNodeTarget() });

    expect(callback).not.toHaveBeenCalled();

    dispose();
  });

  it("does not call callback when event target is not a Node", () => {
    const callback = mock(() => {});

    let ref!: (el: HTMLElement) => void;
    const dispose = createRoot((d) => {
      ref = clickOutside.create(callback);
      return d;
    });

    const el = { contains: mock(() => false) } as unknown as HTMLElement;
    ref(el);

    // Target that is NOT a Node instance
    dispatchTo("mousedown", { target: {} });

    expect(callback).not.toHaveBeenCalled();

    dispose();
  });

  it("removes the document listener on cleanup", () => {
    const callback = mock(() => {});

    const dispose = createRoot((d) => {
      clickOutside.create(callback);
      return d;
    });

    expect(docListeners.get("mousedown")?.size).toBeGreaterThan(0);

    // Run cleanup functions (simulating component unmount)
    for (const fn of cleanupFns) fn();

    // The mousedown listener set should now be empty
    expect(docListeners.get("mousedown")?.size ?? 0).toBe(0);

    dispose();
  });

  it("calls callback multiple times for multiple outside clicks", () => {
    const callback = mock(() => {});

    let ref!: (el: HTMLElement) => void;
    const dispose = createRoot((d) => {
      ref = clickOutside.create(callback);
      return d;
    });

    const el = { contains: mock(() => false) } as unknown as HTMLElement;
    ref(el);

    dispatchTo("mousedown", { target: fakeNodeTarget() });
    dispatchTo("mousedown", { target: fakeNodeTarget() });
    dispatchTo("mousedown", { target: fakeNodeTarget() });

    expect(callback).toHaveBeenCalledTimes(3);

    dispose();
  });
});
