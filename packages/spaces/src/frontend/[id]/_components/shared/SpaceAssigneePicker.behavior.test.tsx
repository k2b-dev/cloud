import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import type { SpaceItemAssignee } from "@/contracts";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

if (isServer) test.skip("Space assignee picker uses browser conditions", () => {});
else {
  for (const [serviceAccountKind, icon] of [
    ["standalone", "ti-key"],
    ["agent", "ti-robot"],
  ] as const) {
    test(`selecting a ${serviceAccountKind} preserves its name and kind in the selected row`, async () => {
      const dom = createDomTestHarness();
      for (const method of ["showPopover", "hidePopover", "scrollIntoView"]) {
        Object.defineProperty(dom.window.HTMLElement.prototype, method, { configurable: true, value() {} });
      }
      const originalFetch = globalThis.fetch;
      const account = {
        id: "11111111-1111-4111-8111-111111111111",
        kind: "service_account" as const,
        serviceAccountKind,
        displayName: "Work helper",
        avatarHash: null,
      };
      globalThis.fetch = Object.assign(
        async () => Response.json([{ ...account, uid: account.displayName, description: "direct access" }]),
        {
          preconnect: originalFetch.preconnect,
        },
      );
      const [selected, setSelected] = createSignal<SpaceItemAssignee[]>([]);
      let dispose = () => {};
      try {
        const { default: SpaceAssigneePicker } = await import("./SpaceAssigneePicker");
        dispose = render(
          () =>
            createComponent(SpaceAssigneePicker, {
              spaceId: "Space1",
              value: selected,
              onChange: setSelected,
            }),
          dom.root,
        );
        delegateEvents(["click", "input", "keydown"]);
        const input = dom.root.querySelector<HTMLInputElement>("[role=combobox]")!;
        input.click();
        const deadline = performance.now() + 2_000;
        while (!dom.document.querySelector("[role=option]")) {
          if (performance.now() >= deadline) throw new Error(`Assignee options did not render: ${dom.document.body.innerHTML}`);
          await Bun.sleep(10);
        }
        const option = dom.document.querySelector<HTMLButtonElement>("[role=option]")!;
        expect(option.textContent).toContain(account.displayName);
        expect(option.querySelector(`.${icon}`)).not.toBeNull();
        option.click();
        expect(selected()).toEqual([account]);
        expect(dom.root.textContent).toContain(account.displayName);
        expect(dom.root.querySelector(`.k2b-avatar .${icon}`)).not.toBeNull();
        expect(dom.root.querySelector(".ti-api")).toBeNull();
      } finally {
        dispose();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      }
    });
  }
}
