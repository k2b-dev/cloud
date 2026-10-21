import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

test.skipIf(isServer)("expectation mode switches clear the other persisted mode without losing draft values", async () => {
  const dom = createDomTestHarness();
  try {
    const { createSourceExpectationForm } = await import("./source-expectation-fields");
    createRoot((dispose) => {
      try {
        const form = createSourceExpectationForm({ expectEverySeconds: 300, expectDailyBy: null });
        expect(form.value()).toEqual({ expectEverySeconds: 300, expectDailyBy: null });
        form.setMode("daily");
        form.setTime("04:00");
        expect(form.value()).toEqual({ expectEverySeconds: null, expectDailyBy: "04:00" });
        expect(form.valid()).toBe(true);
        form.setTime("25:00");
        expect(form.valid()).toBe(false);
        form.setMode("none");
        expect(form.valid()).toBe(true);
        expect(form.value()).toEqual({ expectEverySeconds: null, expectDailyBy: null });
        form.setMode("every");
        expect(form.seconds()).toBe(300);
        for (const value of [null, 0, -1, 1.5, 2_147_483_648]) {
          form.setSeconds(value);
          expect(form.valid()).toBe(false);
        }
      } finally {
        dispose();
      }
    });
  } finally {
    dom.cleanup();
  }
});
