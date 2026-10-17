import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

// A file of its own: Solid binds its delegated click handler to the document of the first test in a process.
if (isServer) test.skip("requires browser conditions", () => {});
else
  test("phone sheet links follow after closing and choice links run their own action", async () => {
    const dom = createDomTestHarness();
    dom.window.happyDOM.setWindowSize({ width: 390, height: 844 });
    const previous = ["matchMedia", "history"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: dom.window.matchMedia.bind(dom.window) });
    Object.defineProperty(globalThis, "history", { configurable: true, value: dom.window.history });
    const { Dropdown } = await import("../src/actions/Dropdown");
    const { dialogCore } = await import("../src/feedback/dialog-core");
    const chosen: boolean[] = [];
    const followed: { href: string; sheetOpen: boolean }[] = [];
    // A page's link handling, such as progressive navigation, sees the click; record it instead of navigating.
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!link || link.closest("dialog")) return;
      event.preventDefault();
      followed.push({ href: link.getAttribute("href")!, sheetOpen: dialogCore.isOpen() });
    };
    dom.document.addEventListener("click", onClick, true);
    const dispose = render(
      () => (
        <Dropdown.Root
          phone="sheet"
          label="Note actions"
          items={[
            { label: "Version history", href: "/versions" },
            {
              sectionLabel: "Open as",
              layout: "row",
              items: [{ label: "Read", choice: "radio", checked: true, href: "/read", action: () => chosen.push(dialogCore.isOpen()) }],
            },
          ]}
        >
          <Dropdown.Trigger>Note actions</Dropdown.Trigger>
        </Dropdown.Root>
      ),
      dom.root,
    );
    try {
      dom.root.querySelector<HTMLButtonElement>("button")!.click();
      expect(dialogCore.isOpen()).toBe(true);
      dom.document.querySelector<HTMLAnchorElement>('dialog a[href="/versions"]')!.click();
      for (let attempt = 0; attempt < 50 && followed.length === 0; attempt++) await Bun.sleep(10);
      expect(followed).toEqual([{ href: "/versions", sheetOpen: false }]);
      await Bun.sleep(100);
      dom.root.querySelector<HTMLButtonElement>("button")!.click();
      const choice = dom.document.querySelector<HTMLAnchorElement>('dialog .k2b-dropdown__row a[href="/read"]')!;
      expect(choice.getAttribute("role")).toBe("menuitemradio");
      expect(choice.getAttribute("aria-checked")).toBe("true");
      const tap = new MouseEvent("click", { bubbles: true, cancelable: true });
      choice.dispatchEvent(tap);
      expect(tap.defaultPrevented).toBe(true);
      for (let attempt = 0; attempt < 50 && chosen.length === 0; attempt++) await Bun.sleep(10);
      expect(chosen).toEqual([false]);
      expect(followed).toEqual([{ href: "/versions", sheetOpen: false }]);
      await Bun.sleep(100);
    } finally {
      dom.document.removeEventListener("click", onClick, true);
      if (dialogCore.isOpen()) {
        dialogCore.close();
        await Bun.sleep(50);
      }
      dispose();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.cleanup();
    }
  });
