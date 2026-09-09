import { describe, expect, test } from "bun:test";
import { createDialogCore } from "../src/feedback/dialog-core";
import { createDomTestHarness } from "./dom";

const settle = () => Bun.sleep(10);

describe("guarded dialog dismissal", () => {
  test("Escape and backdrop preserve state until the registered handler closes", async () => {
    const dom = createDomTestHarness();
    const core = createDialogCore();
    let allowed = false;
    let calls = 0;
    const result = core.open<string>((close, context) => {
      context.setDismissHandler(() => {
        calls++;
        if (allowed) close("discarded");
      });
      return document.createElement("input");
    });
    const dialog = dom.document.querySelector("dialog")!;
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await settle();
    expect(core.isOpen()).toBe(true);
    expect(calls).toBe(1);
    allowed = true;
    dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await result).toBe("discarded");
    expect(calls).toBe(2);
    dom.cleanup();
  });

  test("nested confirmation cancellation restores the parent's guard", async () => {
    const dom = createDomTestHarness();
    const core = createDialogCore();
    let confirm: (result?: boolean) => void = () => {};
    let calls = 0;
    const result = core.open((close, context) => {
      context.setDismissHandler(async () => {
        calls++;
        const accepted = await core.open<boolean>((closeConfirmation) => {
          confirm = closeConfirmation;
          return document.createElement("button");
        });
        if (accepted) close();
      });
      return document.createElement("input");
    });
    const dialog = dom.document.querySelector("dialog")!;
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    confirm(false);
    await settle();
    expect(core.isOpen()).toBe(true);
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(calls).toBe(2);
    confirm(true);
    await result;
    expect(core.isOpen()).toBe(false);
    dom.cleanup();
  });

  test("coalesces pending dismissal and leaves completion callbacks unguarded", async () => {
    const dom = createDomTestHarness();
    const core = createDialogCore();
    let finish: () => void = () => {};
    let release: () => void = () => {};
    let calls = 0;
    const result = core.open((close, context) => {
      finish = close;
      context.setDismissHandler(async () => {
        calls++;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      return document.createElement("input");
    });
    const dialog = dom.document.querySelector("dialog")!;
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(calls).toBe(1);
    finish();
    await result;
    release();
    await settle();
    expect(core.isOpen()).toBe(false);
    dom.cleanup();
  });
});
