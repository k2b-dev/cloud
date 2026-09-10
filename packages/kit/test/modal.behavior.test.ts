import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

(isServer ? test.skip : test)("Kit schema modals validate, return typed values and cancel on stop", async () => {
  const dom = createDomTestHarness();
  const { openKitModal } = await import("../src/frontend/modal-host");
  const controller = new AbortController();
  const submit = () =>
    dom.document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  try {
    const pending = openKitModal(
      {
        kind: "dialog",
        title: "New task",
        fields: {
          title: { type: "text", label: "Task", required: true },
          count: { type: "number", label: "Count", min: 1, max: 3, default: 9 },
        },
      },
      controller.signal,
      "en",
    );
    submit();
    expect(dom.document.querySelector("dialog")).not.toBeNull();
    expect(dom.document.body.textContent).toContain("allowed range");
    const inputs = dom.document.querySelectorAll<HTMLInputElement>("input");
    inputs[0]!.value = "Todo";
    inputs[0]!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    inputs[1]!.value = "2";
    inputs[1]!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    submit();
    expect(await pending).toEqual({ title: "Todo", count: 2 });
    const confirm = openKitModal({ kind: "confirm", title: "Confirm", message: "Sure?" }, controller.signal, "en");
    expect(dom.document.body.textContent).toContain("Confirm");
    controller.abort();
    expect(await confirm).toBe(false);
    expect(dom.document.querySelector("dialog")).toBeNull();
    expect(await openKitModal({ kind: "text", title: "Text", label: "Text" }, controller.signal, "en")).toBeNull();
  } finally {
    controller.abort();
    dom.cleanup();
  }
});
