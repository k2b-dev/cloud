import { afterEach, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { PanelState } from "../browser/panel-context-bridge";

if (isServer) test.skip("requires browser conditions and solid-dom-preload", () => {});
else {
  const bootstrap = createDomTestHarness();
  const { default: PanelMenu } = await import("./PanelMenu.island");
  bootstrap.cleanup();
  let cleanup = () => {};
  afterEach(() => cleanup());
  test("the checkbox requests consent through events and follows current controller state", async () => {
    const dom = createDomTestHarness();
    const initial: PanelState = { provider: "fixture", appName: "Inventory", consent: true, allowed: true, saving: false };
    const dispose = render(() => createComponent(PanelMenu, { initial }), dom.root);
    const request = mock((_event: CustomEvent) => {});
    window.addEventListener("cloud.panel.consent", request);
    cleanup = () => {
      window.removeEventListener("cloud.panel.consent", request);
      dispose();
      dom.cleanup();
    };
    dom.root.querySelector<HTMLButtonElement>('[aria-label="Panel menu"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const choice = document.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
    expect(choice.getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain("Panel from Inventory");
    choice.click();
    expect(request.mock.calls[0]?.[0].detail).toEqual({ provider: "fixture", allowed: false });
    // The row follows the saved answer, not the value it had when the menu first rendered.
    window.dispatchEvent(new CustomEvent("cloud.panel.state", { detail: { ...initial, allowed: false } }));
    expect(document.querySelector('[role="menuitemcheckbox"]')!.getAttribute("aria-checked")).toBe("false");
    window.dispatchEvent(new CustomEvent("cloud.panel.state", { detail: { ...initial, provider: "core", consent: false } }));
    const menu = document.querySelector<HTMLElement>("[data-cloud-panel-menu]")!;
    expect(menu.style.visibility).toBe("hidden");
    expect(menu.hasAttribute("inert")).toBe(true);
    expect(menu.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
  });
}
