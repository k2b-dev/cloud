import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { onPanelBeforeLeave } from "./panel";
import { hasPanelLeaveGuard, panelCanLeave } from "./panel-leave";

if (isServer) test.skip("requires browser conditions and solid-dom-preload", () => {});
else {
  test("the current provider state is checked synchronously; disposal restores unguarded behavior", () => {
    const dom = createDomTestHarness();
    let safe = true;
    const dispose = onPanelBeforeLeave(() => safe);
    try {
      expect(hasPanelLeaveGuard()).toBe(true);
      expect(panelCanLeave(window)).toBe(true);
      safe = false;
      expect(panelCanLeave(window)).toBe(false);
      safe = true;
      expect(panelCanLeave(window)).toBe(true);
      dispose();
      expect(hasPanelLeaveGuard()).toBe(false);
      expect(panelCanLeave(window)).toBe(true);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
  test("a failing guard fails closed and another guard cannot override a veto", () => {
    const dom = createDomTestHarness();
    const fail = onPanelBeforeLeave(() => {
      throw new Error("Storage unavailable");
    });
    const safe = onPanelBeforeLeave(() => true);
    try {
      expect(panelCanLeave(window)).toBe(false);
      fail();
      expect(panelCanLeave(window)).toBe(true);
    } finally {
      fail();
      safe();
      dom.cleanup();
    }
  });
}
