import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

/** Opens a phone sheet, ends its owner one way or another, and checks that no sheet outlives it. */
const sheetEndsWith = async (end: (dispose: () => void, disable: () => void) => void) => {
  const dom = createDomTestHarness();
  dom.window.happyDOM.setWindowSize({ width: 390, height: 844 });
  const previousMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: dom.window.matchMedia.bind(dom.window),
  });
  // The sheet keeps a history entry; closing it walks back through the window's history.
  const previousHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
  Object.defineProperty(globalThis, "history", { configurable: true, value: dom.window.history });
  const { Dropdown } = await import("../src/actions/Dropdown");
  const { dialogCore } = await import("../src/feedback/dialog-core");
  const [disabled, setDisabled] = createSignal(false);
  const dispose = render(
    () => (
      <Dropdown.Root phone="sheet" label="Note actions" disabled={disabled()} items={[{ label: "Duplicate", action: () => {} }]}>
        <Dropdown.Trigger>Note actions</Dropdown.Trigger>
      </Dropdown.Root>
    ),
    dom.root,
  );
  let disposed = false;
  try {
    dom.root.querySelector<HTMLButtonElement>("button")!.click();
    expect(dialogCore.isOpen()).toBe(true);
    end(
      () => {
        disposed = true;
        dispose();
      },
      () => setDisabled(true),
    );
    for (let attempt = 0; attempt < 50 && dialogCore.isOpen(); attempt++) await Bun.sleep(10);
    // No sheet, scroll lock or stale action outlives the menu that opened it.
    expect(dialogCore.isOpen()).toBe(false);
    // Let the dialog layer walk back its history entry before the window goes.
    await Bun.sleep(100);
  } finally {
    if (dialogCore.isOpen()) {
      dialogCore.close();
      await Bun.sleep(20);
    }
    if (!disposed) dispose();
    if (previousHistory) Object.defineProperty(globalThis, "history", previousHistory);
    else Reflect.deleteProperty(globalThis, "history");
    if (previousMatchMedia) Object.defineProperty(globalThis, "matchMedia", previousMatchMedia);
    else Reflect.deleteProperty(globalThis, "matchMedia");
    dom.cleanup();
  }
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("a phone sheet closes when its dropdown goes away", () => sheetEndsWith((dispose) => dispose()));
  // Like the desktop popover: a disabled menu offers no actions.
  test("a phone sheet closes when its dropdown becomes disabled", () => sheetEndsWith((_dispose, disable) => disable()));
}
