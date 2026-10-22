import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("an immediate sheet action runs during the tap; others wait until the sheet is gone", async () => {
    const dom = createDomTestHarness();
    dom.window.happyDOM.setWindowSize({ width: 390, height: 844 });
    const previousMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: dom.window.matchMedia.bind(dom.window) });
    const previousHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
    Object.defineProperty(globalThis, "history", { configurable: true, value: dom.window.history });
    const { Dropdown } = await import("../src/actions/Dropdown");
    const { dialogCore } = await import("../src/feedback/dialog-core");
    const ran: string[] = [];
    const dispose = render(
      () => (
        <Dropdown.Root
          phone="sheet"
          label="Note actions"
          items={[
            { label: "Copy", immediate: true, action: () => ran.push("copy") },
            { label: "Duplicate", action: () => ran.push("duplicate") },
          ]}
        >
          <Dropdown.Trigger>Note actions</Dropdown.Trigger>
        </Dropdown.Root>
      ),
      dom.root,
    );
    const choose = (label: string) =>
      [...dom.document.querySelectorAll<HTMLElement>("dialog [role='menuitem']")]
        .find((item) => item.textContent?.includes(label))!
        .click();
    const closed = async () => {
      for (let attempt = 0; attempt < 50 && dialogCore.isOpen(); attempt++) await Bun.sleep(10);
      await Bun.sleep(50);
    };
    try {
      const trigger = dom.root.querySelector<HTMLButtonElement>("button")!;
      trigger.click();
      choose("Copy");
      // Synchronously within the tap, so the browser still sees the gesture.
      expect(ran).toEqual(["copy"]);
      await closed();

      trigger.click();
      choose("Duplicate");
      // Not yet: it may navigate or open a dialog, so it waits until the sheet has left the history.
      expect(ran).toEqual(["copy"]);
      await closed();
      expect(ran).toEqual(["copy", "duplicate"]);
    } finally {
      if (dialogCore.isOpen()) {
        dialogCore.close();
        await Bun.sleep(20);
      }
      dispose();
      if (previousHistory) Object.defineProperty(globalThis, "history", previousHistory);
      else Reflect.deleteProperty(globalThis, "history");
      if (previousMatchMedia) Object.defineProperty(globalThis, "matchMedia", previousMatchMedia);
      else Reflect.deleteProperty(globalThis, "matchMedia");
      dom.cleanup();
    }
  });
