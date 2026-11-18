import { describe, expect, test } from "bun:test";
import { createDialogCore } from "../src/feedback/dialog-core";
import { createDomTestHarness } from "./dom";

// The level change's motion loads in its own module with the first open. Nothing waits for it: this file's first
// dialog opens a second level in the same task, before that module can have arrived.
describe("a level that replaces another", () => {
  test("shows in the same task, also before the level-change module has loaded, and says its name once it has", async () => {
    const dom = createDomTestHarness();
    const core = createDialogCore();
    void core.open(() => {
      const editor = document.createElement("p");
      editor.textContent = "Editor";
      return editor;
    });
    void core.open(
      () => {
        const question = document.createElement("h2");
        question.textContent = "Discard changes?";
        return question;
      },
      { ariaLabel: "Discard changes?" },
    );
    const dialog = dom.document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("Discard changes?");
    expect(dialog.getAttribute("aria-label")).toBe("Discard changes?");
    await Bun.sleep(100);
    expect(dialog.querySelector("[data-k2b-dialog-live]")?.textContent).toBe("Discard changes?");
    core.close();
    dom.cleanup();
  });
});
