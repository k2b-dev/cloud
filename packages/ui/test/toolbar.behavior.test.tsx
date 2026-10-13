import { expect, spyOn, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) {
  test.skip("toolbar focus needs browser export conditions", () => {});
} else {
  test("roving focus respects child keys and excludes nested menus inside a surrounding dialog", async () => {
    const dom = createDomTestHarness();
    const { Toolbar } = await import("../src/actions/Toolbar");
    const previousInput = Object.getOwnPropertyDescriptor(globalThis, "HTMLInputElement");
    Object.defineProperty(globalThis, "HTMLInputElement", { configurable: true, value: dom.window.HTMLInputElement });
    dom.root.setAttribute("role", "dialog");
    const dispose = render(
      () => (
        <Toolbar label="Actions">
          <button type="button" id="first">
            First
          </button>
          <button type="button" id="disabled" disabled>
            Disabled
          </button>
          <div hidden>
            <button type="button" id="hidden">
              Hidden
            </button>
          </div>
          <button type="button" id="unavailable" aria-disabled="true">
            Unavailable
          </button>
          <button type="button" id="last">
            Last
          </button>
          <div role="menu">
            <button type="button" role="menuitem" id="menu" tabIndex={-1}>
              Menu item
            </button>
          </div>
        </Toolbar>
      ),
      dom.root,
    );
    const mocks = Array.from(dom.root.querySelectorAll("button")).map((button) =>
      spyOn(button, "getClientRects").mockImplementation(() => {
        const rects = dom.root.getClientRects();
        // happy-dom has no layout; visibility is the only geometry the focus model reads.
        Object.defineProperty(rects, "length", { value: button.closest("[hidden]") ? 0 : 1 });
        return rects;
      }),
    );
    const toolbar = dom.root.querySelector<HTMLElement>('[role="toolbar"]')!;
    const first = dom.root.querySelector<HTMLButtonElement>("#first")!;
    const unavailable = dom.root.querySelector<HTMLButtonElement>("#unavailable")!;
    const last = dom.root.querySelector<HTMLButtonElement>("#last")!;
    last.addEventListener("keydown", (event) => {
      if (event.key === "Home") event.preventDefault();
    });
    const key = (value: string, modifiers: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) => {
      const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...modifiers });
      dom.document.activeElement?.dispatchEvent(event);
      return event;
    };
    try {
      toolbar.style.display = "flex";
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(toolbar.querySelectorAll('[tabindex="0"]').length).toBe(1);
      expect(first.tabIndex).toBe(0);
      first.focus();
      expect(key("ArrowRight").defaultPrevented).toBe(true);
      expect(dom.document.activeElement?.id).toBe(unavailable.id);
      key("ArrowRight");
      expect(dom.document.activeElement?.id).toBe(last.id);
      key("ArrowRight");
      expect(dom.document.activeElement?.id).toBe(first.id);
      key("ArrowLeft");
      expect(dom.document.activeElement?.id).toBe(last.id);
      key("Home");
      expect(dom.document.activeElement?.id).toBe(last.id);
      key("ArrowLeft");
      key("Home");
      expect(dom.document.activeElement?.id).toBe(first.id);
      for (const modifier of [{ ctrlKey: true }, { shiftKey: true }, { altKey: true }, { metaKey: true }]) {
        expect(key("ArrowRight", modifier).defaultPrevented).toBe(false);
        expect(dom.document.activeElement?.id).toBe(first.id);
      }
      key("End");
      expect(dom.document.activeElement?.id).toBe(last.id);
      last.disabled = true;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(first.tabIndex).toBe(0);
      expect(last.tabIndex).toBe(-1);
      const menu = dom.root.querySelector<HTMLButtonElement>("#menu")!;
      menu.focus();
      expect(key("ArrowRight").defaultPrevented).toBe(false);
      expect(dom.document.activeElement?.id).toBe(menu.id);
      expect(menu.tabIndex).toBe(-1);
      expect(toolbar.querySelectorAll('[tabindex="0"]').length).toBe(1);
    } finally {
      for (const mock of mocks) mock.mockRestore();
      dispose();
      dom.cleanup();
      if (previousInput) Object.defineProperty(globalThis, "HTMLInputElement", previousInput);
      else Reflect.deleteProperty(globalThis, "HTMLInputElement");
    }
  });
}
