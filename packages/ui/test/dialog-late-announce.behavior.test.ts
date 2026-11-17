import { describe, expect, test } from "bun:test";
import { createDialogCore } from "../src/feedback/dialog-core";
import { createDomTestHarness } from "./dom";

// The level change's motion loads in its own module with the first open; this file's first dialog closes before it
// has arrived, and the announcement it still owed must not reach the next dialog.
describe("a level's announcement that waits for the level-change module", () => {
  test("is dropped when its dialog closed before the module arrived", async () => {
    const dom = createDomTestHarness();
    const core = createDialogCore();
    const view = (text: string) => () => {
      const element = document.createElement("p");
      element.textContent = text;
      return element;
    };
    void core.open(view("Editor"));
    void core.open(view("Discard changes?"), { role: "alertdialog", ariaLabel: "Discard changes?" });
    core.close();
    void core.open(view("Report"), { ariaLabel: "Report" });
    await Bun.sleep(100);
    const live = dom.document.querySelector("dialog [data-k2b-dialog-live]");
    expect(live?.textContent ?? "").toBe("");
    core.close();
    dom.cleanup();
  });
});
