import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { attachOverlayScrollbar, installOverlayScrollbars } from "./overlay-scrollbar";

let window: HappyWindow;
const previousGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();
const globalKeys = [
  "window",
  "document",
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
  for (const key of globalKeys) previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const values: Record<(typeof globalKeys)[number], unknown> = {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    MutationObserver: window.MutationObserver,
    ResizeObserver: TestResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
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

const scrollerWithRows = () => {
  const scroller = document.createElement("div");
  scroller.setAttribute("data-scrollbar", "overlay");
  scroller.append(document.createElement("div"), document.createElement("div"));
  document.body.append(scroller);
  return scroller;
};
const thumbs = (scroller: HTMLElement) => scroller.querySelectorAll(":scope > .k2b-overlay-scrollbar").length;
const mutationsSettle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a scroller gets one thumb, in front of its content, and loses it on cleanup", async () => {
  const scroller = scrollerWithRows();
  const dispose = attachOverlayScrollbar(scroller);
  expect(attachOverlayScrollbar(scroller)).toBe(dispose);
  // A renderer that puts content in front keeps the thumb first.
  scroller.prepend(document.createElement("section"));
  await mutationsSettle();
  expect(scroller.firstElementChild?.className).toBe("k2b-overlay-scrollbar");
  expect(thumbs(scroller)).toBe(1);
  dispose();
  expect(thumbs(scroller)).toBe(0);
});

// Each island bundles its own copy of @k2b/ui, so a ScrollArea and the workspace controller attach through different
// module instances. Two thumbs fought for the front place and hung the page on the first hover (Mail reader, 22.11.).
test("a second copy of the module adds no second thumb to a scroller that already has one", async () => {
  // A query makes Bun load the module a second time, as a second island bundle does.
  const specifier = "./overlay-scrollbar.ts?second-copy";
  const copy: typeof import("./overlay-scrollbar") = await import(specifier);
  expect(copy.attachOverlayScrollbar).not.toBe(attachOverlayScrollbar);
  const scroller = scrollerWithRows();
  attachOverlayScrollbar(scroller);
  const stop = copy.installOverlayScrollbars(document);
  scroller.lastElementChild?.dispatchEvent(new window.Event("pointerover", { bubbles: true }) as unknown as Event);
  copy.attachOverlayScrollbar(scroller);
  await mutationsSettle();
  expect(thumbs(scroller)).toBe(1);
  stop();
});

test("the workspace delegation attaches on the first hover, scroll or focus inside a marked scroller", () => {
  const scroller = scrollerWithRows();
  const stop = installOverlayScrollbars(document);
  expect(thumbs(scroller)).toBe(0);
  scroller.lastElementChild?.dispatchEvent(new window.Event("pointerover", { bubbles: true }) as unknown as Event);
  expect(thumbs(scroller)).toBe(1);
  stop();
});
