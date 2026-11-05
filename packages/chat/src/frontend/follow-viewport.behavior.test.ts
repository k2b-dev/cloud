import { expect, spyOn, test } from "bun:test";
import { createDomTestHarness } from "../../../ui/test/dom";
import { followVisualViewport } from "./follow-viewport";

test("reads one viewport snapshot before changing keyboard attributes or CSS", () => {
  const dom = createDomTestHarness();
  const events: string[] = [];
  let height = 844;
  let top = 0;
  const viewport = new dom.window.EventTarget();
  Object.defineProperties(viewport, {
    height: { get: () => (events.push("height"), height) },
    offsetTop: { get: () => (events.push("top"), top) },
  });
  Object.defineProperty(dom.window, "visualViewport", { configurable: true, value: viewport });
  const attribute = spyOn(dom.root, "toggleAttribute");
  attribute.mockImplementation((name, force) => {
    events.push("attribute");
    if (force) dom.root.setAttribute(name, "");
    else dom.root.removeAttribute(name);
    return Boolean(force);
  });
  let cleanup: (() => void) | undefined;
  try {
    cleanup = followVisualViewport(dom.root);
    expect(events).toEqual(["height", "top", "attribute"]);
    expect(dom.root.hasAttribute("data-keyboard")).toBe(false);
    events.length = 0;
    height = 500;
    top = 20;
    viewport.dispatchEvent(new dom.window.Event("resize"));
    expect(events).toEqual(["height", "top", "attribute"]);
    expect(dom.root.hasAttribute("data-keyboard")).toBe(true);
    expect(dom.root.style.getPropertyValue("--chat-viewport-top")).toBe("20px");
    expect(dom.root.style.getPropertyValue("--chat-viewport-height")).toBe("500px");
  } finally {
    cleanup?.();
    attribute.mockRestore();
    dom.cleanup();
  }
});
