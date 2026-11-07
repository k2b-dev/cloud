import { expect, mock, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, until } from "./dom";

// The phone sheet's module loads with the first sheet. When it cannot load, as offline after a deploy, the same entries
// open as the normal menu beside the trigger instead of nothing.
mock.module("../src/actions/menu-sheet", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("a sheet whose module fails to load opens the same entries as a normal menu", async () => {
    const dom = createDomTestHarness();
    dom.window.happyDOM.setWindowSize({ width: 390, height: 844 });
    // happy-dom has no popover API; the menu's own state says whether it opened.
    const prototype = dom.window.HTMLElement.prototype as unknown as { showPopover?: () => void; hidePopover?: () => void };
    prototype.showPopover ??= () => undefined;
    prototype.hidePopover ??= () => undefined;
    const previousMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: dom.window.matchMedia.bind(dom.window) });
    const logged: unknown[] = [];
    const previousError = console.error;
    console.error = (...values: unknown[]) => logged.push(values[0]);
    const { Dropdown } = await import("../src/actions/Dropdown");
    const calls: boolean[] = [];
    const dispose = render(
      () => (
        <Dropdown.Root
          phone="sheet"
          label="Note actions"
          items={[
            { label: "Duplicate", action: () => {} },
            { label: "Archive", action: () => {} },
          ]}
          onOpenChange={(open) => calls.push(open)}
        >
          <Dropdown.Trigger>Note actions</Dropdown.Trigger>
        </Dropdown.Root>
      ),
      dom.root,
    );
    try {
      const trigger = dom.root.querySelector<HTMLButtonElement>("button")!;
      trigger.click();
      // The owner hears the sheet start and end; the menu then reports itself open.
      await until(() => calls.length >= 2 && trigger.getAttribute("aria-expanded") === "true");
      const menu = dom.document.querySelector<HTMLElement>("[role='menu']")!;
      expect(menu.getAttribute("aria-label")).toBe("Note actions");
      expect([...menu.querySelectorAll("[role='menuitem']")].map((item) => item.textContent)).toEqual(["Duplicate", "Archive"]);
      expect(dom.document.querySelector("dialog[open]")).toBeNull();
      // The failure stays visible to developers; the person gets the menu.
      expect(String(logged[0])).toContain("Failed to fetch");
      expect(calls.slice(0, 2)).toEqual([true, false]);
    } finally {
      dispose();
      console.error = previousError;
      if (previousMatchMedia) Object.defineProperty(globalThis, "matchMedia", previousMatchMedia);
      else Reflect.deleteProperty(globalThis, "matchMedia");
      dom.cleanup();
    }
  });
