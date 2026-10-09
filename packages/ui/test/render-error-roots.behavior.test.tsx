import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDialogCore } from "../src/feedback/dialog-core";
import { createDomTestHarness, type DomTestHarness } from "./dom";

// Dialogs and floating windows render in Solid roots of their own, mostly opened from a click handler where no
// owner and no island boundary is around. Content that throws on an update must stay inside that root: without a
// boundary Solid throws to the code that wrote the signal and leaves every computation queued after the failing one
// stale, so other parts of the page stop updating until a reload.
describe("render errors in dialogs and floating windows", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  let dom: DomTestHarness;
  let reported: ReturnType<typeof spyOn<typeof globalThis, "reportError">>;
  beforeEach(() => {
    dom = createDomTestHarness();
    reported = spyOn(globalThis, "reportError").mockImplementation(() => {});
  });
  afterEach(() => {
    reported.mockRestore();
    dom.cleanup();
  });

  /** A row that renders the value until a refresh commits one it cannot render. */
  const fixture = () => {
    const [value, setValue] = createSignal(1);
    const label = () => {
      if (value() === 2) throw new Error("row cannot render");
      return `value ${value()}`;
    };
    // Another root that subscribes after the content: it must keep updating.
    const other = dom.document.createElement("output");
    dom.root.append(other);
    return { value, setValue, label, other, mountOther: () => render(() => <>{value()}</>, other) };
  };

  test("a dialog shows a notice in place of its content and every other root keeps updating", async () => {
    const { setValue, label, other, mountOther } = fixture();
    const core = createDialogCore();
    const result = core.open(() => <p data-content>{label()}</p>);
    const disposeOther = mountOther();
    const dialog = dom.document.querySelector("dialog")!;
    expect(dialog.querySelector("[data-content]")?.textContent).toBe("value 1");

    expect(() => setValue(2)).not.toThrow();
    const notice = dialog.querySelector('[role="alert"]')!;
    expect(notice.textContent).toContain("This content could not be displayed.");
    expect(dialog.querySelector("[data-content]")).toBeNull();
    expect(other.textContent).toBe("2");
    expect(reported).toHaveBeenCalledTimes(1);
    expect(String(reported.mock.calls[0]![0])).toContain("row cannot render");

    setValue(3);
    expect(other.textContent).toBe("3");

    const close = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Close")!;
    close.click();
    expect(await result).toBeUndefined();
    expect(core.isOpen()).toBe(false);
    disposeOther();
  });

  test("the dialog notice gets a plain frame and speaks the document language", () => {
    dom.document.documentElement.lang = "de";
    const core = createDialogCore();
    // A bare surface draws no frame; the content that would have drawn one failed while the dialog opened.
    void core.open(
      () => {
        throw new Error("view cannot render");
      },
      { panelClassName: "k2b-dialog k2b-dialog--large is-bare", contentClassName: "k2b-dialog__viewport is-bare" },
    );
    const dialog = dom.document.querySelector("dialog")!;
    expect(dialog.className).toBe("k2b-dialog k2b-dialog--small");
    expect(dialog.firstElementChild?.className).toBe("k2b-dialog__viewport");
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Dieser Inhalt konnte nicht angezeigt werden.");
    expect([...dialog.querySelectorAll("button")].map((button) => button.textContent)).toContain("Schließen");
    core.close();
  });

  test("a floating window keeps its frame and shows the notice in its body", async () => {
    // Imported once the harness provides `window`: the module registers its delegated events on load.
    const { openFloatingWindow } = await import("../src/layout/FloatingWindow");
    const { setValue, label, other, mountOther } = fixture();
    const close = openFloatingWindow(() => <p data-content>{label()}</p>, { title: "Notes" });
    const disposeOther = mountOther();
    const frame = dom.document.querySelector<HTMLElement>(".k2b-floating-window")!;
    expect(frame.querySelector("[data-content]")?.textContent).toBe("value 1");

    expect(() => setValue(2)).not.toThrow();
    expect(frame.querySelector(".k2b-floating-window__body [role='alert']")?.textContent).toContain("This content could not be displayed.");
    expect(frame.querySelector(".k2b-floating-window__title")?.textContent).toContain("Notes");
    expect(other.textContent).toBe("2");
    expect(reported).toHaveBeenCalledTimes(1);

    setValue(3);
    expect(other.textContent).toBe("3");
    close();
    expect(dom.document.querySelector(".k2b-floating-window")).toBeNull();
    disposeOther();
  });
});
