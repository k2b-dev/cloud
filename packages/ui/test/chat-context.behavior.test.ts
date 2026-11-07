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
      // Pending reads as off but stays focusable, so its tooltip can still be read.
      expect(action.getAttribute("aria-disabled")).toBe("true");
      expect(action.getAttribute("aria-busy")).toBe("true");
      reject(new Error("provider unavailable"));
      await Bun.sleep(10);
      expect(errors).toBe(1);
      expect(action.hasAttribute("aria-disabled")).toBe(false);
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

if (!isServer)
  test("context popup reports each opening once, for hover preview and click alike", async () => {
    const dom = createDomTestHarness();
    const { ChatContextPopup } = await import("../src/chat/ChatContextPopup");
    let opened = 0;
    const dispose = render(
      () => createComponent(ChatContextPopup, { "aria-label": "Usage", content: "details", children: "ring", onOpen: () => opened++ }),
      dom.root,
    );
    try {
      const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-chat-context")!;
      const popup = dom.root.querySelector<HTMLElement>("[role=dialog]")!;
      popup.showPopover = () => {};
      popup.hidePopover = () => {};
      trigger.dispatchEvent(Object.assign(new MouseEvent("pointerenter"), { pointerType: "mouse" }));
      await Bun.sleep(280);
      expect(opened).toBe(1);
      // Pinning an already open preview is not a second opening.
      trigger.click();
      expect(opened).toBe(1);
      trigger.click();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      trigger.click();
      expect(opened).toBe(2);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

if (!isServer)
  test("a focused control that leaves the details without a focus event keeps the focus in them, as in WebKit", async () => {
    const dom = createDomTestHarness();
    const { ChatContextPopup } = await import("../src/chat/ChatContextPopup");
    const details = dom.document.createElement("div");
    const retry = dom.document.createElement("button");
    retry.textContent = "Try again";
    details.append(retry);
    const dispose = render(
      () => createComponent(ChatContextPopup, { "aria-label": "Usage", content: details, children: "ring" }),
      dom.root,
    );
    try {
      const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-chat-context")!;
      const popup = dom.root.querySelector<HTMLElement>("[role=dialog]")!;
      popup.showPopover = () => {};
      popup.hidePopover = () => {};
      trigger.click();
      retry.focus();
      expect(dom.document.activeElement).toBe(retry);
      // WebKit drops the focus to the page without blur or focusout when the focused element is removed; Happy DOM
      // does the same, so only the details' own watch can bring the focus back.
      let focusEvents = 0;
      popup.addEventListener("focusout", () => focusEvents++);
      const refresh = dom.document.createElement("button");
      refresh.textContent = "Refresh";
      retry.replaceWith(refresh);
      await Bun.sleep(10);
      expect(focusEvents).toBe(0);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(popup.contains(dom.document.activeElement)).toBe(true);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
