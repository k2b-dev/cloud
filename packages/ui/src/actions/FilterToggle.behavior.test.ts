import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../test/dom";

if (isServer) {
  test.skip("requires browser conditions and Solid DOM preload", () => {});
} else {
  test("FilterToggle calls onClick and reflects its controlled pressed state", async () => {
    const dom = createDomTestHarness();
    const { FilterToggle } = await import("./FilterChip");
    const [active, setActive] = createSignal(false);
    let clicks = 0;
    const dispose = render(
      () =>
        createComponent(FilterToggle, {
          label: "Only mine",
          icon: "ti ti-user",
          get active() {
            return active();
          },
          onClick: () => {
            clicks++;
            setActive(!active());
          },
        }),
      dom.root,
    );
    try {
      const button = dom.root.querySelector("button")!;
      expect(button.type).toBe("button");
      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(button.hasAttribute("data-active")).toBe(false);
      button.click();
      expect(clicks).toBe(1);
      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(button.getAttribute("data-active")).toBe("true");
      button.click();
      expect(clicks).toBe(2);
      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(button.hasAttribute("data-active")).toBe(false);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
