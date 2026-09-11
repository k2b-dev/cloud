import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("context hover followed by click pins the popup; action failure releases pending state", async () => {
    const dom = createDomTestHarness();
    const { ChatContextUsage } = await import("../src/chat/ChatPrimitives");
    let calls = 0;
    let errors = 0;
    let reject: (error: Error) => void = () => {};
    const dispose = render(
      () =>
        createComponent(ChatContextUsage, {
          usage: { input: 10 },
          contextWindow: 100,
          action: {
            id: "compact",
            label: "Compact",
            onSelect: () => {
              calls++;
              return new Promise<void>((_, fail) => {
                reject = fail;
              });
            },
          },
          onActionError: () => {
            errors++;
          },
        }),
      dom.root,
    );
    try {
      const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-chat-context")!;
      const popup = dom.root.querySelector<HTMLElement>("[role=dialog]")!;
      // Happy DOM has no native top-layer implementation; real geometry is browser-tested.
      popup.showPopover = () => {};
      popup.hidePopover = () => {};
      trigger.dispatchEvent(Object.assign(new MouseEvent("pointerenter"), { pointerType: "mouse" }));
      await Bun.sleep(280);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      trigger.click();
      trigger.dispatchEvent(new MouseEvent("pointerleave"));
      await Bun.sleep(220);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      const action = popup.querySelector<HTMLButtonElement>("button")!;
      action.click();
      action.click();
      expect(calls).toBe(1);
      expect(action.disabled).toBe(true);
      reject(new Error("provider unavailable"));
      await Bun.sleep(10);
      expect(errors).toBe(1);
      expect(action.disabled).toBe(false);
      action.focus();
      action.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(dom.document.activeElement).toBe(trigger);
      trigger.click();
      dom.document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
