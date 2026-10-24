import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { installScrollFades } from "./scroll-fade";

type Frame = (time: number) => void;

let window: HappyWindow;
let frames: Map<number, Frame>;
let frameId = 0;
const previousGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();
const globalKeys = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  window = new HappyWindow();
  frames = new Map();
  for (const key of globalKeys) previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const values: Record<(typeof globalKeys)[number], unknown> = {
    window,
    document: window.document,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    MutationObserver: window.MutationObserver,
    ResizeObserver: TestResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: Frame) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  };
  for (const key of globalKeys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
});

afterEach(() => {
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<PropertyKey, unknown>)[key];
  }
  previousGlobals.clear();
  window.close();
});

const flushFrames = () => {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
};

test("many changes inside a scrollport are measured once per frame, not once per change", async () => {
  const port = document.createElement("div");
  port.setAttribute("data-scroll-fade-mode", "bottom");
  let measured = 0;
  // Reading the scroll height forces layout in a browser; the count stands for those reflows.
  Object.defineProperty(port, "scrollHeight", {
    configurable: true,
    get: () => {
      measured++;
      return 900;
    },
  });
  Object.defineProperty(port, "clientHeight", { configurable: true, get: () => 300 });
  const rows = Array.from({ length: 50 }, () => port.appendChild(document.createElement("div")));
  document.body.append(port);
  const stop = installScrollFades(document);
  expect(port.getAttribute("data-scroll-fade")).toBe("bottom");
  measured = 0;
  // Like marking fifty chats read: each row changes on its own, in separate tasks.
  for (const row of rows) {
    row.className = "read";
    await new Promise((resolve) => setTimeout(resolve, 0)); // real clock: a new task, not a delay
  }
  expect(measured).toBe(0);
  flushFrames();
  expect(measured).toBe(1);
  expect(port.getAttribute("data-scroll-fade")).toBe("bottom");
  stop?.();
});
