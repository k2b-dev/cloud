import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../../ui/test/dom";
import { setPwaScreen } from "./pwa-screen";

test("opens and leaves a screen of its own in place on a v2 app page, and leaves other pages alone", () => {
  const dom = createDomTestHarness();
  try {
    dom.root.innerHTML =
      '<div class="k2-ui pwa-v2" data-tabs=""><main><button>Open chat</button></main></div><div class="other"><i></i></div>';
    const frame = dom.root.querySelector(".pwa-v2")!;
    setPwaScreen(dom.root.querySelector("button")!, true);
    expect(frame.hasAttribute("data-screen")).toBe(true);
    setPwaScreen(dom.root.querySelector("button")!, false);
    expect(frame.hasAttribute("data-screen")).toBe(false);
    setPwaScreen(dom.root.querySelector(".other i")!, true);
    expect(dom.root.querySelector("[data-screen]")).toBeNull();
  } finally {
    dom.cleanup();
  }
});
