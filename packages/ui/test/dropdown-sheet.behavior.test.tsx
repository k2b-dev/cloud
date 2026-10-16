import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("a phone sheet reports its open state and notifies its owner when dismissed", async () => {
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

      dom.document.querySelector<HTMLButtonElement>(".k2b-bottom-sheet__handle")!.click();
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
