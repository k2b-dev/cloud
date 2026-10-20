import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("Kanban shortcut help renders shared named-key caps", async () => {
    const dom = createDomTestHarness();
    const { createKanbanShortcuts } = await import("./kanban-shortcuts");
    const { dialogCore } = await import("@k2b/ui");
    const view = createRoot((dispose) => ({ open: createKanbanShortcuts({ canWrite: true }), dispose }));
    try {
      void view.open();
      const caps = [...dom.document.querySelectorAll(".k2b-kbd__key")].map((cap) => cap.textContent);
      expect(caps).toEqual(["←", "↑", "→", "↓", "↵", "M", "D", "Space", "←", "↑", "→", "↓", "Esc"]);
      expect(dom.document.querySelectorAll('.k2b-kbd__keys[aria-hidden="true"]')).toHaveLength(caps.length);
    } finally {
      dialogCore.close();
      view.dispose();
      dom.cleanup();
    }
  });
