import { expect, spyOn, test } from "bun:test";
import { type MutationOptions, mutation } from "@k2b/stdlib/solid";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

for (const outcome of ["dropped", "aborted", "superseded"] as const) {
  domTest(`a ${outcome} hold creation keeps its reason and dialog open`, async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => Response.json({ items: [], pagination: { total_pages: 1 } }), {
      preconnect: originalFetch.preconnect,
    });
    const originalCreate = mutation.create;
    let controllers = 0;
    const create = spyOn(mutation, "create").mockImplementation(<T, V, C = unknown>(options: MutationOptions<T, V, C>) => {
      const controller = originalCreate(options);
      // The section creates its write controller before the dialog's outer controller.
      if (++controllers === 1) controller.mutate = async () => outcome;
      return controller;
    });
    const { render } = await import("solid-js/web");
    const { dialogCore } = await import("@k2b/ui");
    const { PreservationHoldsSection } = await import("./PreservationHoldsSection");
    const dispose = render(() => <PreservationHoldsSection baseId="BASE01" onSavingChange={() => {}} />, dom.root);
    try {
      await Bun.sleep(30);
      Array.from(dom.root.querySelectorAll("button"))
        .find((button) => button.querySelector(".ti-lock-plus"))!
        .click();
      await Bun.sleep(30);
      const reason = dom.document.querySelector<HTMLTextAreaElement>("textarea")!;
      reason.value = "Keep records for review";
      reason.dispatchEvent(new Event("input", { bubbles: true }));
      const submit = dom.document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      submit.click();
      await Bun.sleep(30);
      expect(reason.isConnected).toBe(true);
      expect(reason.value).toBe("Keep records for review");
      expect(submit.disabled).toBe(false);
    } finally {
      dialogCore.close();
      dispose();
      create.mockRestore();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
}
