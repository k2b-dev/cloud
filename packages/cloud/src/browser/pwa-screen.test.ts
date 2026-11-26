import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../../ui/test/dom";
import { setPwaScreen } from "./pwa-screen";

test("beside an older Core the page shows in the v1 frame: there it marks the MobileShell as MobileShell.setScreen does", async () => {
  const dom = createDomTestHarness();
  try {
    const { MobileShell } = await import("@k2b/ui");
    dom.root.innerHTML =
      '<div class="k2b-mobile-shell"><main class="k2b-mobile-shell__main"><div class="k2-ui" data-ui="v2"><button>Open chat</button></div></main></div>';
    const shell = dom.root.querySelector(".k2b-mobile-shell")!;
    setPwaScreen(dom.root.querySelector("button")!, true);
    const mark = [...shell.attributes].map((attribute) => attribute.name).filter((name) => name !== "class");
    setPwaScreen(dom.root.querySelector("button")!, false);
    // the same mark as the v1 frame's own call
    MobileShell.setScreen(dom.root.querySelector("button")!, true);
    expect([...shell.attributes].map((attribute) => attribute.name).filter((name) => name !== "class")).toEqual(mark);
    expect(mark).toHaveLength(1);
  } finally {
    dom.cleanup();
  }
});

test("opens and leaves a screen of its own in place on a v2 app page, and leaves other pages alone", () => {
  const dom = createDomTestHarness();
  try {
    dom.root.innerHTML =
      '<div class="k2-ui pwa-v2" data-tabs=""><main><button>Open chat</button></main><nav class="k2-tabbar"></nav></div><div class="other"><i></i></div>';
    const frame = dom.root.querySelector(".pwa-v2")!;
    const bar = frame.querySelector(".k2-tabbar")!;
    setPwaScreen(dom.root.querySelector("button")!, true);
    expect([frame.hasAttribute("data-screen"), bar.hasAttribute("hidden")]).toEqual([true, true]);
    setPwaScreen(dom.root.querySelector("button")!, false);
    expect([frame.hasAttribute("data-screen"), bar.hasAttribute("hidden")]).toEqual([false, false]);
    setPwaScreen(dom.root.querySelector(".other i")!, true);
    expect(dom.root.querySelector("[data-screen], [data-k2b-screen]")).toBeNull();
  } finally {
    dom.cleanup();
  }
});
