import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

// The shared test DOM stands in for a browser in every app's behavior tests. A shared primitive may read a browser
// global while it renders (a v2 menu asks `matchMedia` whether the window is the phone), so the harness provides
// the globals a browser always has, without each test setting them.
if (isServer) test.skip("requires browser conditions", () => {});
else
  describe("the shared test DOM", () => {
    let dom: DomTestHarness;
    let dispose: (() => void) | undefined;

    beforeEach(() => {
      dom = createDomTestHarness();
    });
    afterEach(() => {
      dispose?.();
      dispose = undefined;
      dom.cleanup();
    });

    test("provides matchMedia, which follows the window's width", () => {
      expect(typeof matchMedia).toBe("function");
      dom.window.happyDOM.setWindowSize({ width: 1440, height: 900 });
      expect(matchMedia("not all and (min-width: 768px)").matches).toBe(false);
      dom.window.happyDOM.setWindowSize({ width: 390, height: 844 });
      expect(matchMedia("not all and (min-width: 768px)").matches).toBe(true);
    });

    test("renders a v2 menu, which asks for the phone on its first render", async () => {
      const { Menu } = await import("../src/v2");
      dispose = render(() => <Menu label="Weitere Aktionen" items={[{ label: "Umbenennen", onClick: () => {} }]} />, dom.root);
      expect(dom.root.querySelector('button[aria-label="Weitere Aktionen"]')).not.toBeNull();
    });
  });
