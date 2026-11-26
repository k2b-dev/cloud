import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { buttonNamed, installV2Globals } from "../../../../../test/v2-dom";

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("the board's shortcut help names each key and what it does, and only the moves a writer may make", async () => {
    const dom = createDomTestHarness();
    installV2Globals(dom);
    const { createKanbanShortcuts } = await import("./kanban-shortcuts");
    const facts = () =>
      [...dom.document.querySelectorAll('[role="dialog"] [data-k2-part="Facts"] dt')].map((term) => term.textContent?.trim());
    for (const canWrite of [true, false]) {
      const view = createRoot((dispose) => ({ open: createKanbanShortcuts({ canWrite }), dispose }));
      try {
        const closed = view.open();
        await Bun.sleep(10);
        expect(facts()).toEqual(canWrite ? ["← ↑ → ↓", "Enter", "M", "D", "Space, ← ↑ → ↓, Esc"] : ["← ↑ → ↓", "Enter"]);
        buttonNamed(dom, "Close")!.click();
        await closed;
      } finally {
        view.dispose();
      }
    }
    // A closing v2 dialog finishes its focus work a moment later, while the window still exists.
    await Bun.sleep(20);
    dom.cleanup();
  });
