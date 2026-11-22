import { describe, it, expect, mock } from "bun:test";
import { detailPanel } from "./detail-panel";

// Mock window.location
const locationMock = {
  href: "http://localhost/page",
  search: "",
};
Object.defineProperty(globalThis, "window", {
  value: {
    location: locationMock,
    addEventListener: mock(() => {}),
    removeEventListener: mock(() => {}),
    dispatchEvent: mock(() => true),
    CustomEvent: globalThis.CustomEvent ??
      class CustomEvent extends Event {
        detail: any;
        constructor(type: string, opts?: any) {
          super(type);
          this.detail = opts?.detail;
        }
      },
  },
  writable: true,
  configurable: true,
});

// Ensure CustomEvent is available globally
if (typeof globalThis.CustomEvent === "undefined") {
  (globalThis as any).CustomEvent = (window as any).CustomEvent;
}

// Mock history (both push and replace)
Object.defineProperty(globalThis, "history", {
  value: { replaceState: mock(() => {}), pushState: mock(() => {}) },
  writable: true,
  configurable: true,
});

// ==========================
// URL Helpers
// ==========================

describe("detailPanel.setUrlParam", () => {
  it("calls history.pushState by default (creates Back/Forward entry)", () => {
    (history.pushState as any).mockClear();
    detailPanel.setUrlParam("item", "123");
    expect(history.pushState).toHaveBeenCalled();
  });

  it("calls history.replaceState in 'replace' mode", () => {
    (history.replaceState as any).mockClear();
    detailPanel.setUrlParam("item", "123", "replace");
    expect(history.replaceState).toHaveBeenCalled();
  });

  it("sets param in URL", () => {
    detailPanel.setUrlParam("item", "abc");
    const call = (history.pushState as any).mock.calls.at(-1);
    // The third argument is the new URL string
    expect(call[2]).toContain("item=abc");
  });

  it("deletes param when value is null", () => {
    detailPanel.setUrlParam("item", null);
    const call = (history.pushState as any).mock.calls.at(-1);
    expect(call[2]).not.toContain("item=");
  });
});

describe("detailPanel.getUrlParam", () => {
  it("returns null when param not present", () => {
    locationMock.search = "";
    const result = detailPanel.getUrlParam("nonexistent");
    expect(result).toBeNull();
  });

  it("returns value when param is present", () => {
    locationMock.search = "?foo=bar&baz=42";
    const result = detailPanel.getUrlParam("foo");
    expect(result).toBe("bar");
  });
});

// ==========================
// shouldHandleClick
// ==========================

describe("detailPanel.shouldHandleClick", () => {
  it("returns true for plain left click", () => {
    const event = {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    } as MouseEvent;
    expect(detailPanel.shouldHandleClick(event)).toBe(true);
  });

  it("returns false when defaultPrevented", () => {
    const event = {
      defaultPrevented: true,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    } as MouseEvent;
    expect(detailPanel.shouldHandleClick(event)).toBe(false);
  });

  it("returns false for non-primary button", () => {
    const event = {
      defaultPrevented: false,
      button: 2,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    } as MouseEvent;
    expect(detailPanel.shouldHandleClick(event)).toBe(false);
  });

  it("returns false when modifier keys are pressed", () => {
    for (const modKey of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) {
      const event = {
        defaultPrevented: false,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        [modKey]: true,
      } as unknown as MouseEvent;
      expect(detailPanel.shouldHandleClick(event)).toBe(false);
    }
  });

  it("returns false when anchor has external target", () => {
    const event = {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    } as MouseEvent;
    const anchor = { target: "_blank" } as HTMLAnchorElement;
    expect(detailPanel.shouldHandleClick(event, anchor)).toBe(false);
  });

  it("returns true when anchor target is _self", () => {
    const event = {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    } as MouseEvent;
    const anchor = { target: "_self" } as HTMLAnchorElement;
    expect(detailPanel.shouldHandleClick(event, anchor)).toBe(true);
  });
});
