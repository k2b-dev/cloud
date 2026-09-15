import { describe, expect, test } from "bun:test";
import { createDomTestHarness } from "../../../ui/test/dom";
import { attachSpotlightPosition, readSpotlightPosition } from "./spotlight-position";

const settle = () => Bun.sleep(20);

describe("desktop Spotlight placement", () => {
  test("only accepts finite saved coordinates and clamps their normalized range", () => {
    for (const value of [null, "broken", "null", "[]", '{"x":"0","y":0}', '{"x":1e999,"y":0}']) {
      expect(readSpotlightPosition(value)).toBeNull();
    }
    expect(readSpotlightPosition('{"x":-1,"y":2}')).toEqual({ x: 0, y: 1 });
  });

  test("drag, reopen, resize, snap and touch exclusion preserve a usable position", async () => {
    const dom = createDomTestHarness();
    Object.defineProperty(dom.window.navigator, "maxTouchPoints", { configurable: true, value: 0 });
    dom.window.innerWidth = 1600;
    dom.window.innerHeight = 1000;
    const media = dom.window.matchMedia("(min-width: 64rem)");
    Object.defineProperty(media, "matches", { configurable: true, value: true });
    dom.window.matchMedia = () => media;
    const dialog = document.createElement("dialog");
    dialog.className = "cloud-search-dialog";
    const container = document.createElement("div");
    const host = document.createElement("div");
    const grip = document.createElement("div");
    grip.setAttribute("data-search-grip", "top");
    host.append(grip);
    container.append(host);
    dialog.append(container);
    dom.root.append(dialog);
    grip.setPointerCapture = () => {};
    grip.hasPointerCapture = () => false;
    const state: { modal: boolean; position: { x: number; y: number } | null } = { modal: true, position: null };
    let height = 170;
    let notifySize = () => {};
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notifySize = () => callback([], this);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    dialog.getBoundingClientRect = () => ({
      x: state.position?.x ?? (dom.window.innerWidth - 896) / 2,
      y: state.position?.y ?? Math.max(12, (dom.window.innerHeight - 544) / 2),
      width: 896,
      height,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      toJSON() {},
    });
    const context = {
      dialog,
      setModal: (value: boolean) => {
        state.modal = value;
      },
      setPosition: (value: typeof state.position) => {
        state.position = value;
      },
      setDismissHandler: () => {},
      requestDismiss: async () => {},
    };
    const pointer = (type: string, x: number, y: number, pointerType = "mouse") => {
      const event = Object.assign(new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true }), {
        pointerId: 1,
        pointerType,
      });
      (type === "pointerdown" ? grip : window).dispatchEvent(event);
    };
    let cleanup = attachSpotlightPosition(host, context);
    try {
      await settle();
      expect(state.modal).toBe(true);
      pointer("pointerdown", 400, 230);
      pointer("pointermove", 550, 280);
      const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      window.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(true);
      expect(state.modal).toBe(true);
      expect(state.position).toBeNull();
      pointer("pointerdown", 400, 230);
      pointer("pointermove", 550, 280);
      pointer("pointerup", 550, 280);
      expect(state.modal).toBe(false);
      expect(state.position).toEqual({ x: 502, y: 278 });
      cleanup();
      cleanup = attachSpotlightPosition(host, context);
      await settle();
      expect(state.position).toEqual({ x: 502, y: 278 });
      dom.window.innerWidth = 1200;
      dom.window.innerHeight = 800;
      window.dispatchEvent(new Event("resize"));
      expect(state.position!.x).toBeLessThanOrEqual(292);
      expect(state.position!.y).toBeLessThanOrEqual(618);
      const before = state.position!;
      const anchor = { x: (dom.window.innerWidth - 896) / 2, y: (dom.window.innerHeight - 544) / 2 };
      pointer("pointerdown", before.x, before.y);
      pointer("pointermove", anchor.x + 5, anchor.y + 5);
      pointer("pointerup", anchor.x + 5, anchor.y + 5);
      expect(state.modal).toBe(true);
      expect(state.position).toBeNull();
      cleanup();
      cleanup = attachSpotlightPosition(host, context);
      await settle();
      expect(state.modal).toBe(true);
      // Compact panels can reach the bottom. Growth moves up without losing that preference.
      pointer("pointerdown", anchor.x, anchor.y);
      pointer("pointermove", anchor.x, 900);
      expect(state.position).toEqual({ x: anchor.x, y: 618 });
      expect(host.dataset.dragging).toBe("true");
      const home = host.querySelector<HTMLElement>(".cloud-global-search__home")!;
      expect(home.getAttribute("aria-hidden")).toBe("true");
      expect(home.style.top).toBe(`${anchor.y - 618}px`);
      pointer("pointerup", anchor.x, 900);
      expect(host.dataset.dragging).toBeUndefined();
      height = 544;
      notifySize();
      expect(state.position).toEqual({ x: anchor.x, y: 244 });
      cleanup();
      cleanup = attachSpotlightPosition(host, context);
      await settle();
      expect(state.position).toEqual({ x: anchor.x, y: 244 });
      height = 170;
      notifySize();
      expect(state.position).toEqual({ x: anchor.x, y: 618 });
      grip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      expect(state.modal).toBe(true);
      pointer("pointerdown", 300, 130, "touch");
      pointer("pointermove", 500, 130, "touch");
      expect(state.modal).toBe(true);
      Object.defineProperty(dom.window.navigator, "maxTouchPoints", { configurable: true, value: 5 });
      window.dispatchEvent(new Event("resize"));
      expect(host.dataset.movable).toBe("false");
      pointer("pointerdown", 300, 130);
      pointer("pointermove", 500, 130);
      expect(state.modal).toBe(true);
    } finally {
      cleanup();
      globalThis.ResizeObserver = originalResizeObserver;
      dom.cleanup();
    }
  });
});
