import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createRoot } from "solid-js";
import { dnd } from "./dnd";

// ==========================
// SSR safety
// ==========================
//
// dnd.create() and its destroy() must not touch `window` in environments
// where it doesn't exist (SSR, server cleanup via solid-js cleanNode).
//
// Other test files stub `window` onto globalThis, and bun shares the
// process across files. To deterministically simulate SSR we delete
// `window` for the test scope and restore it afterwards.

type GlobalSlot = "window" | "document";

const stripGlobals = () => {
  const saved: Record<GlobalSlot, { had: boolean; value: unknown }> = {
    window: { had: false, value: undefined },
    document: { had: false, value: undefined },
  };
  for (const key of ["window", "document"] as const) {
    const g = globalThis as Record<string, unknown>;
    saved[key] = { had: key in g, value: g[key] };
    delete g[key];
  }
  return () => {
    for (const key of ["window", "document"] as const) {
      const g = globalThis as Record<string, unknown>;
      if (saved[key].had) g[key] = saved[key].value;
    }
  };
};

describe("dnd SSR safety", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = stripGlobals();
  });

  afterEach(() => {
    restore();
  });

  it("create() does not throw without window/document", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
    createRoot((dispose) => {
      expect(() => dnd.create()).not.toThrow();
      dispose();
    });
  });

  it("destroy() does not throw without window/document", () => {
    createRoot((dispose) => {
      const ctrl = dnd.create();
      expect(() => ctrl.destroy()).not.toThrow();
      dispose();
    });
  });
});

// ============================================================================
// Audit fixes — non-DOM checks (validation, idempotency, callback safety)
// ============================================================================

describe("dnd option validation", () => {
  it("throws TypeError on non-finite activationDistance", () => {
    expect(() => {
      createRoot(() => dnd.create({ activationDistance: NaN }));
    }).toThrow(/activationDistance/);
    expect(() => {
      createRoot(() => dnd.create({ activationDistance: Infinity }));
    }).toThrow(/activationDistance/);
  });

  it("throws TypeError on negative activationDistance", () => {
    expect(() => {
      createRoot(() => dnd.create({ activationDistance: -1 }));
    }).toThrow(/activationDistance/);
  });

  it("throws TypeError on non-finite touchActivationDelayMs", () => {
    expect(() => {
      createRoot(() => dnd.create({ touchActivationDelayMs: NaN }));
    }).toThrow(/touchActivationDelayMs/);
  });

  it("accepts 0 (zero) for activationDistance and touchActivationDelayMs", () => {
    expect(() => {
      createRoot(() =>
        dnd.create({ activationDistance: 0, touchActivationDelayMs: 0 }),
      );
    }).not.toThrow();
  });
});

describe("dnd idempotent destroy", () => {
  it("calling destroy() twice does not throw", () => {
    createRoot((dispose) => {
      const ctrl = dnd.create();
      ctrl.destroy();
      expect(() => ctrl.destroy()).not.toThrow();
      dispose();
    });
  });

  it("calling cancel() with no active drag is a safe no-op", () => {
    createRoot((dispose) => {
      const ctrl = dnd.create();
      expect(() => ctrl.cancel()).not.toThrow();
      expect(ctrl.isDragging()).toBe(false);
      dispose();
    });
  });
});

// ============================================================================
// Browser interaction regressions — dependency-free DOM harness
// ============================================================================

type Listener = (event: any) => void;

class FakeEventTarget {
  readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Record<string, unknown>) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

type FakeRect = { left: number; top: number; width: number; height: number };

class FakeElement extends FakeEventTarget {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  parentElement: FakeElement | null = null;
  textContent = "";
  private capturedPointerId: number | null = null;
  private currentTabIndex = -1;

  constructor(
    readonly tagName = "div",
    private rect: FakeRect = { left: 0, top: 0, width: 100, height: 40 },
  ) {
    super();
    this.style.userSelect = "";
    this.style.webkitUserSelect = "";
  }

  appendChild(child: FakeElement) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  get tabIndex() {
    return this.currentTabIndex;
  }

  set tabIndex(value: number) {
    this.currentTabIndex = value;
    this.attributes.set("tabindex", String(value));
  }

  cloneNode(deep = false) {
    const clone = new FakeElement(this.tagName, this.rect);
    for (const [name, value] of this.attributes) clone.setAttribute(name, value);
    Object.assign(clone.dataset, this.dataset);
    if (deep) for (const child of this.children) clone.appendChild(child.cloneNode(true));
    return clone;
  }

  closest(selector: string): FakeElement | null {
    let candidate: FakeElement | null = this;
    while (candidate) {
      if (selector.split(",").some((part) => candidate!.matches(part.trim()))) return candidate;
      candidate = candidate.parentElement;
    }
    return null;
  }

  contains(candidate: FakeElement): boolean {
    return candidate === this || this.children.some((child) => child.contains(candidate));
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  getBoundingClientRect() {
    return {
      ...this.rect,
      right: this.rect.left + this.rect.width,
      bottom: this.rect.top + this.rect.height,
    } as DOMRect;
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  matches(selector: string) {
    if (selector === this.tagName) return true;
    const attribute = selector.match(/^\[([^=\]]+)(?:=['\"]?([^'\"]+)['\"]?)?\]$/);
    if (!attribute) return false;
    const [, name, value] = attribute;
    if (!name || !this.attributes.has(name)) return false;
    return value === undefined || this.attributes.get(name) === value;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    const visit = (element: FakeElement) => {
      for (const child of element.children) {
        if (selector.split(",").some((part) => child.matches(part.trim()))) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  releasePointerCapture(pointerId: number) {
    if (this.capturedPointerId === pointerId) this.capturedPointerId = null;
  }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === "tabindex") this.currentTabIndex = -1;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name === "tabindex") this.currentTabIndex = Number(value);
  }

  setPointerCapture(pointerId: number) {
    this.capturedPointerId = pointerId;
  }
}

const installFakeDom = () => {
  const body = new FakeElement("body");
  const documentElement = new FakeElement("html");
  const fakeWindow = new FakeEventTarget();
  const globals = globalThis as Record<string, unknown>;
  const slots = ["window", "document", "Element", "HTMLElement", "Node", "getComputedStyle"] as const;
  const saved = Object.fromEntries(slots.map((key) => [key, { had: key in globals, value: globals[key] }])) as Record<
    (typeof slots)[number],
    { had: boolean; value: unknown }
  >;

  Object.assign(globalThis, {
    window: fakeWindow,
    document: {
      body,
      documentElement,
      createElement: (tagName: string) => new FakeElement(tagName),
    },
    Element: FakeElement,
    HTMLElement: FakeElement,
    Node: FakeElement,
    getComputedStyle: () => ({ borderRadius: "0px", overflow: "visible" }),
  });

  return {
    body,
    window: fakeWindow,
    restore: () => {
      for (const key of slots) {
        if (saved[key].had) globals[key] = saved[key].value;
        else delete globals[key];
      }
    },
  };
};

const keyboardEvent = (target: FakeElement, key: string) => ({
  key,
  target,
  preventDefault() {},
  stopPropagation() {},
});

const pointerEvent = (target: FakeElement, x: number, y: number, pointerType = "mouse") => ({
  button: 0,
  clientX: x,
  clientY: y,
  isPrimary: true,
  pointerId: 1,
  pointerType,
  target,
  preventDefault() {},
});

describe("dnd browser lifecycle", () => {
  it("removes the live region when its Solid owner is disposed", () => {
    const dom = installFakeDom();
    try {
      const dispose = createRoot((dispose) => {
        dnd.create();
        return dispose;
      });
      expect(dom.body.children).toHaveLength(1);
      dispose();
      expect(dom.body.children).toHaveLength(0);
    } finally {
      dom.restore();
    }
  });

  it("does not react to keyboard events after destroy", () => {
    const dom = installFakeDom();
    try {
      const source = new FakeElement();
      const root = createRoot((dispose) => {
        const controller = dnd.create();
        controller.draggable(source as unknown as HTMLElement, () => ({ id: "item", meta: null }));
        return { controller, dispose };
      });
      root.controller.destroy();
      source.dispatch("keydown", keyboardEvent(source, "Enter"));
      expect(root.controller.isDragging()).toBe(false);
      expect(source.listeners.get("keydown")?.size ?? 0).toBe(0);
      root.dispose();
    } finally {
      dom.restore();
    }
  });

  it("clears a pending pointer session when its owner is disposed", () => {
    const dom = installFakeDom();
    try {
      const source = new FakeElement();
      const dispose = createRoot((dispose) => {
        const controller = dnd.create();
        controller.draggable(source as unknown as HTMLElement, () => ({ id: "item", meta: null }));
        return dispose;
      });
      source.dispatch("pointerdown", pointerEvent(source, 5, 5));
      expect(dom.window.listeners.get("pointermove")?.size).toBe(1);
      expect((document.documentElement as HTMLElement).style.userSelect).toBe("none");
      dispose();
      expect(dom.window.listeners.get("pointermove")?.size ?? 0).toBe(0);
      expect((document.documentElement as HTMLElement).style.userSelect).toBe("");
    } finally {
      dom.restore();
    }
  });

  it("ignores keyboard drag triggers from interactive descendants", () => {
    const dom = installFakeDom();
    try {
      const source = new FakeElement();
      const button = source.appendChild(new FakeElement("button"));
      const root = createRoot((dispose) => {
        const controller = dnd.create();
        controller.draggable(source as unknown as HTMLElement, () => ({ id: "item", meta: null, focusable: false }));
        return { controller, dispose };
      });
      source.dispatch("keydown", keyboardEvent(button, "Enter"));
      expect(root.controller.isDragging()).toBe(false);
      root.dispose();
    } finally {
      dom.restore();
    }
  });

  it("restores tabindex and does not override touch-action by default", () => {
    const dom = installFakeDom();
    try {
      const source = new FakeElement();
      source.setAttribute("tabindex", "-1");
      source.style.touchAction = "pan-y";
      const dispose = createRoot((dispose) => {
        const controller = dnd.create();
        controller.draggable(source as unknown as HTMLElement, () => ({ id: "item", meta: null }));
        return dispose;
      });
      expect(source.getAttribute("tabindex")).toBe("0");
      expect(source.style.touchAction).toBe("pan-y");
      dispose();
      expect(source.getAttribute("tabindex")).toBe("-1");
      expect(source.style.touchAction).toBe("pan-y");
    } finally {
      dom.restore();
    }
  });

  it("applies an explicit touch-action only while mounted", () => {
    const dom = installFakeDom();
    try {
      const source = new FakeElement();
      source.style.touchAction = "pan-y";
      const dispose = createRoot((dispose) => {
        const controller = dnd.create();
        controller.draggable(source as unknown as HTMLElement, () => ({
          id: "item",
          meta: null,
          touchAction: "none",
        }));
        return dispose;
      });
      expect(source.style.touchAction).toBe("none");
      dispose();
      expect(source.style.touchAction).toBe("pan-y");
    } finally {
      dom.restore();
    }
  });
});

describe("dnd interaction state", () => {
  it("exposes themeable ghost and count badge styles with the existing defaults", () => {
    const dom = installFakeDom();
    let dispose: (() => void) | undefined;
    try {
      const source = new FakeElement();
      source.dataset.dndCount = "3";
      const controller = createRoot((cleanup) => {
        dispose = cleanup;
        const controller = dnd.create({ activationDistance: 0 });
        controller.draggable(source as unknown as HTMLElement, () => ({ id: "item", meta: null }));
        return controller;
      });
      source.dispatch("pointerdown", pointerEvent(source, 5, 5));
      dom.window.dispatch("pointermove", pointerEvent(source, 10, 10));

      const ghost = dom.body.querySelector('[aria-hidden="true"]');
      expect(ghost).not.toBeNull();
      expect(ghost?.style.boxShadow).toBe("var(--stdlib-dnd-ghost-shadow, 0 12px 28px rgba(0, 0, 0, 0.28))");
      const badge = ghost?.children[0];
      expect(badge?.textContent).toBe("3");
      expect(badge?.style.boxShadow).toBe("var(--stdlib-dnd-badge-shadow, 0 6px 16px rgba(37, 99, 235, 0.35))");
      expect(badge?.style.background).toBe("var(--stdlib-dnd-badge-bg, rgb(59 130 246))");

      controller.cancel();
      expect(dom.body.querySelector('[aria-hidden="true"]')).toBeNull();
    } finally {
      dispose?.();
      dom.restore();
    }
  });

  it("keeps state consistent when drag callbacks throw", () => {
    const dom = installFakeDom();
    const previousConsoleError = console.error;
    console.error = () => {};
    try {
      const source = new FakeElement();
      const target = new FakeElement();
      const root = createRoot((dispose) => {
        const controller = dnd.create({
          onDragStart: () => {
            throw new Error("drag start failed");
          },
          onDrop: () => {
            throw new Error("drop failed");
          },
        });
        controller.draggable(source as unknown as HTMLElement, () => ({ id: "item", meta: null }));
        controller.droppable(target as unknown as HTMLElement, () => ({ id: "target", meta: null }));
        return { controller, dispose };
      });
      expect(() => source.dispatch("keydown", keyboardEvent(source, "Enter"))).not.toThrow();
      expect(root.controller.isDragging()).toBe(true);
      expect(() => source.dispatch("keydown", keyboardEvent(source, "Enter"))).not.toThrow();
      expect(root.controller.isDragging()).toBe(false);
      root.dispose();
    } finally {
      console.error = previousConsoleError;
      dom.restore();
    }
  });

  it("passes every enabled droppable to a custom pointer collision detector", () => {
    const dom = installFakeDom();
    try {
      const source = new FakeElement("div", { left: 0, top: 0, width: 100, height: 40 });
      const farTarget = new FakeElement("div", { left: 500, top: 500, width: 100, height: 40 });
      let seenDroppables = -1;
      const root = createRoot((dispose) => {
        const controller = dnd.create({
          activationDistance: 0,
          collisionDetector: ({ droppables }) => {
            seenDroppables = droppables.length;
            return null;
          },
        });
        controller.draggable(source as unknown as HTMLElement, () => ({ id: "item", meta: null }));
        controller.droppable(farTarget as unknown as HTMLElement, () => ({ id: "target", meta: null }));
        return { controller, dispose };
      });
      source.dispatch("pointerdown", pointerEvent(source, 5, 5));
      dom.window.dispatch("pointermove", pointerEvent(source, 10, 10));
      expect(seenDroppables).toBe(1);
      root.controller.cancel();
      root.dispose();
    } finally {
      dom.restore();
    }
  });

  it("activates a moved touch pointer when its delay elapses without another move", async () => {
    const dom = installFakeDom();
    try {
      const source = new FakeElement();
      const root = createRoot((dispose) => {
        const controller = dnd.create({ activationDistance: 5, touchActivationDelayMs: 15 });
        controller.draggable(source as unknown as HTMLElement, () => ({ id: "item", meta: null }));
        return { controller, dispose };
      });
      source.dispatch("pointerdown", pointerEvent(source, 0, 0, "touch"));
      dom.window.dispatch("pointermove", pointerEvent(source, 10, 0, "touch"));
      expect(root.controller.isDragging()).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(root.controller.isDragging()).toBe(true);
      root.controller.cancel();
      root.dispose();
    } finally {
      dom.restore();
    }
  });

  it("still allows Escape when an active keyboard drag becomes disabled", () => {
    const dom = installFakeDom();
    try {
      const source = new FakeElement();
      const config = { id: "item", meta: null, disabled: false };
      const root = createRoot((dispose) => {
        const controller = dnd.create();
        controller.draggable(source as unknown as HTMLElement, () => config);
        return { controller, dispose };
      });
      source.dispatch("keydown", keyboardEvent(source, "Enter"));
      expect(root.controller.isDragging()).toBe(true);
      config.disabled = true;
      source.dispatch("keydown", keyboardEvent(source, "Escape"));
      expect(root.controller.isDragging()).toBe(false);
      root.dispose();
    } finally {
      dom.restore();
    }
  });

  it("contains errors thrown by announcement factories", () => {
    const dom = installFakeDom();
    const previousConsoleError = console.error;
    console.error = () => {};
    try {
      const source = new FakeElement();
      const root = createRoot((dispose) => {
        const controller = dnd.create({
          announcements: {
            dragStart: () => {
              throw new Error("announcement failed");
            },
          },
        });
        controller.draggable(source as unknown as HTMLElement, () => ({ id: "item", meta: null }));
        return { controller, dispose };
      });
      expect(() => source.dispatch("keydown", keyboardEvent(source, "Enter"))).not.toThrow();
      expect(root.controller.isDragging()).toBe(true);
      root.controller.cancel();
      root.dispose();
    } finally {
      console.error = previousConsoleError;
      dom.restore();
    }
  });
});
