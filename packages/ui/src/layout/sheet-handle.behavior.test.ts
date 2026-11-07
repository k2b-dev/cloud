import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../test/dom";
import { attachSheetHandle } from "./sheet-handle";

type Events = { PointerEvent: typeof PointerEvent; MouseEvent: typeof MouseEvent };

test("a press switches the detent, the click after a drag does not, and a cancelled drag keeps the next tap", () => {
  const dom = createDomTestHarness();
  const events = dom.window as unknown as Events;
  const pointer = (type: string, clientY: number) =>
    new events.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, clientY });
  const tap = (handle: HTMLElement) => handle.dispatchEvent(new events.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  const sheet = document.createElement("div");
  const handle = document.createElement("button");
  sheet.append(handle);
  dom.root.append(sheet);
  const changes: string[] = [];
  const dispose = attachSheetHandle(handle, {
    sheet,
    detents: ["half", "full"],
    initial: "full",
    onChange: (detent) => changes.push(detent),
  });
  try {
    expect(handle.style.touchAction).toBe("none");
    // Enter and Space reach the button as a click without detail.
    handle.click();
    expect(sheet.dataset.sheetDetent).toBe("half");
    tap(handle);
    expect(sheet.dataset.sheetDetent).toBe("full");
    // A finished drag's own click leaves the detent where the drag put it.
    handle.dispatchEvent(pointer("pointerdown", 100));
    handle.dispatchEvent(pointer("pointermove", 130));
    handle.dispatchEvent(pointer("pointerup", 130));
    const afterDrag = sheet.dataset.sheetDetent;
    tap(handle);
    expect(sheet.dataset.sheetDetent).toBe(afterDrag);
    // A cancelled drag sends no click, so the next tap still switches.
    handle.dispatchEvent(pointer("pointerdown", 100));
    handle.dispatchEvent(pointer("pointermove", 140));
    handle.dispatchEvent(pointer("pointercancel", 140));
    expect(sheet.style.height).toBe("");
    const before = sheet.dataset.sheetDetent;
    tap(handle);
    expect(sheet.dataset.sheetDetent).not.toBe(before);
    expect(changes.length).toBeGreaterThanOrEqual(3);
  } finally {
    dispose();
    dom.cleanup();
  }
  expect(handle.style.touchAction).toBe("");
});
