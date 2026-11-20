import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

// On a phone the date picker loads its calendar sheet on demand. The sheet keeps the context of the tap: the palette
// of the area the field is in, and the page it was tapped on.

/** Waits for a condition; the test's own timeout bounds it. */
const until = async (ready: () => boolean) => {
  while (!ready()) await Bun.sleep(10);
};

describe("@k2b/ui date sheet opened while its code loads", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  let dom: DomTestHarness;
  let ui: {
    DatePicker: typeof import("../src/inputs/DatePicker").DatePicker;
    dialogCore: typeof import("../src/feedback/dialog-core").dialogCore;
  };
  let dispose = () => {};
  beforeAll(async () => {
    // One window for the file: the shared dialog core listens to the window it was created in.
    dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: query.includes("max-width"), media: query }),
    });
    const { dialogCore } = await import("../src/feedback/dialog-core");
    const { DatePicker } = await import("../src/inputs/DatePicker");
    ui = { DatePicker, dialogCore };
  });
  afterEach(() => {
    ui.dialogCore.close();
    dispose();
    for (const element of [...dom.root.children]) element.remove();
  });

  const dialog = () => dom.document.querySelector<HTMLDialogElement>("dialog[open]");
  /** A date field in an AI-coloured area, and a plain control elsewhere on the page. */
  const page = () => {
    const area = dom.document.createElement("section");
    area.dataset.k2bPrimary = "ai";
    const elsewhere = dom.document.createElement("button");
    dom.root.append(area, elsewhere);
    const { DatePicker } = ui;
    dispose = render(() => <DatePicker label="Due" value={null} />, area);
    const toggle = area.querySelector<HTMLButtonElement>(".k2b-date-field__toggle");
    if (!toggle) throw new Error("The date field has no calendar button");
    return { toggle, elsewhere };
  };
  const navigate = () => document.body.dispatchEvent(new CustomEvent("ssr:island-dispose", { bubbles: true, detail: { id: "page" } }));

  test("the sheet opens with the palette of the tap, though focus moved before its code arrived", async () => {
    const { toggle, elsewhere } = page();
    toggle.click();
    elsewhere.focus();
    await until(() => dialog()?.querySelector(".k2b-date-sheet") != null);
    expect(dialog()?.dataset.k2bPrimary).toBe("ai");
  });

  test("a sheet tapped before a navigation does not open over the new page", async () => {
    const { toggle } = page();
    toggle.click();
    navigate();
    await import("../src/inputs/date-sheet");
    await Bun.sleep(50);
    expect(dialog()).toBeNull();
  });
});
