import { describe, expect, test } from "bun:test";
import { createDialogCore } from "../src/feedback/dialog-core";
import { createDomTestHarness } from "./dom";

describe("BottomSheet", () => {
  test("handle dismissal respects guards, ignores duplicate drag click, and restores modal state", async () => {
    const dom = createDomTestHarness();
    const { default: BottomSheet, bottomSheetOptions } = await import("../src/layout/BottomSheet");
    const core = createDialogCore();
    let allowed = false;
    let calls = 0;
    const result = core.open((close, context) => {
      context.setDismissHandler(() => {
        calls++;
        if (allowed) close();
      });
      return (
        <BottomSheet onDismiss={context.requestDismiss}>
          <BottomSheet.Header title="Navigation" />
          <BottomSheet.Body>Items</BottomSheet.Body>
        </BottomSheet>
      );
    }, bottomSheetOptions);
    const handle = dom.document.querySelector<HTMLButtonElement>(".k2b-bottom-sheet__handle")!;
    handle.setPointerCapture = () => {};
    const pointer = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { isPrimary: true, button: 0, pointerId: 1, clientY: y });
      handle.dispatchEvent(event);
    };
    pointer("pointerdown", 10);
    pointer("pointerup", 85);
    handle.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await Bun.sleep(0);
    expect(calls).toBe(1);
    expect(core.isOpen()).toBe(true);
    expect(dom.document.body.style.overflow).toBe("hidden");
    pointer("pointerdown", 10);
    pointer("pointercancel", 90);
    handle.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(calls).toBe(1);
    allowed = true;
    handle.click();
    await result;
    expect(calls).toBe(2);
    expect(core.isOpen()).toBe(false);
    expect(dom.document.body.style.overflow).not.toBe("hidden");
    dom.cleanup();
  });

  test("initial focus skips the handle and lands on the first input when there is one", async () => {
    const dom = createDomTestHarness();
    const { default: BottomSheet, bottomSheetOptions } = await import("../src/layout/BottomSheet");
    const core = createDialogCore();
    let closeSheet = () => {};
    const buttonsOnly = core.open((close, context) => {
      closeSheet = close;
      return (
        <BottomSheet onDismiss={context.requestDismiss}>
          <BottomSheet.Header title="Approve sign-in" />
          <BottomSheet.Footer>
            <button type="button">Deny</button>
            <button type="button">Approve</button>
          </BottomSheet.Footer>
        </BottomSheet>
      );
    }, bottomSheetOptions);
    await Bun.sleep(20);
    expect(dom.document.activeElement?.classList.contains("k2b-bottom-sheet__handle")).toBe(false);
    closeSheet();
    await buttonsOnly;
    const withInput = core.open((close, context) => {
      closeSheet = close;
      return (
        <BottomSheet onDismiss={context.requestDismiss}>
          <BottomSheet.Body>
            <input type="search" aria-label="Find an app" />
          </BottomSheet.Body>
        </BottomSheet>
      );
    }, bottomSheetOptions);
    await Bun.sleep(20);
    expect(dom.document.activeElement?.getAttribute("aria-label")).toBe("Find an app");
    closeSheet();
    await withInput;
    dom.cleanup();
  });

  test("cancelBehavior ignore protects the handle while completion still works", async () => {
    const dom = createDomTestHarness();
    const core = createDialogCore();
    let dismiss = async () => {};
    let complete = () => {};
    const result = core.open(
      (close, context) => {
        dismiss = context.requestDismiss;
        complete = close;
        return document.createElement("button");
      },
      { cancelBehavior: "ignore" },
    );
    await dismiss();
    expect(core.isOpen()).toBe(true);
    complete();
    await result;
    dom.cleanup();
  });
});
