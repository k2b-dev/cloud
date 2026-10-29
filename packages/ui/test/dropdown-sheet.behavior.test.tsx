import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires browser conditions", () => {});
else
  for (const dismiss of ["handle", "header"] as const)
    test(`a phone sheet reports its open state and notifies its owner when dismissed through its ${dismiss}`, async () => {
      const dom = createDomTestHarness();
      dom.window.happyDOM.setWindowSize({ width: 390, height: 844 });
      const previousMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
      Object.defineProperty(globalThis, "matchMedia", {
        configurable: true,
        value: dom.window.matchMedia.bind(dom.window),
      });
      const { Dropdown } = await import("../src/actions/Dropdown");
      const { dialogCore } = await import("../src/feedback/dialog-core");
      const calls: Array<boolean | "close"> = [];
      const dispose = render(
        () => (
          <Dropdown.Root
            phone="sheet"
            label="Note actions"
            sheetTop={
              dismiss === "header"
                ? (close) => (
                    <button type="button" data-sheet-done on:click={close}>
                      Done
                    </button>
                  )
                : undefined
            }
            items={[{ label: "Duplicate", action: () => {} }]}
            onOpenChange={(open) => calls.push(open)}
            onClose={() => calls.push("close")}
          >
            <Dropdown.Trigger>Note actions</Dropdown.Trigger>
          </Dropdown.Root>
        ),
        dom.root,
      );
      try {
        const trigger = dom.root.querySelector<HTMLButtonElement>("button")!;
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
        trigger.click();
        expect(dom.document.querySelector("dialog[open] .k2b-bottom-sheet__handle")).not.toBeNull();
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        expect(calls).toEqual([true]);

        dom.document.querySelector<HTMLButtonElement>(dismiss === "header" ? "[data-sheet-done]" : ".k2b-bottom-sheet__handle")!.click();
        for (let attempt = 0; attempt < 50 && calls.length < 3; attempt++) await Bun.sleep(10);
        expect(dialogCore.isOpen()).toBe(false);
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
        expect(calls).toEqual([true, false, "close"]);
      } finally {
        if (dialogCore.isOpen()) {
          dialogCore.close();
          await Bun.sleep(20);
        }
        dispose();
        if (previousMatchMedia) Object.defineProperty(globalThis, "matchMedia", previousMatchMedia);
        else Reflect.deleteProperty(globalThis, "matchMedia");
        dom.cleanup();
      }
    });
