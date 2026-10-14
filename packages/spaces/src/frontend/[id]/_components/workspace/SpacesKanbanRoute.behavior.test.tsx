import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("Kanban shortcut help renders shared named-key caps", async () => {
    const dom = createDomTestHarness();
    const { default: SpacesKanbanRoute } = await import("./SpacesKanbanRoute.island");
    const { dialogCore } = await import("@k2b/ui");
    const dispose = render(
      () => (
        <SpacesKanbanRoute
          spaceId="Space1"
          baseUrl="/app/spaces/Space1/kanban"
          columns={[]}
          tags={[]}
          wormholes={[]}
          initialBuckets={[]}
          foldedColumns={[]}
          selectedItemId=""
          canWrite
          currentUserId="User1"
        />
      ),
      dom.root,
    );
    try {
      dom.root.querySelector<HTMLButtonElement>("[data-spaces-kanban-shortcuts]")!.click();
      const caps = [...dom.document.querySelectorAll(".k2b-kbd__key")].map((cap) => cap.textContent);
      expect(caps).toEqual(["←", "↑", "→", "↓", "↵", "M", "D", "Space", "←", "↑", "→", "↓", "Esc"]);
      expect(dom.document.querySelectorAll('.k2b-kbd__keys[aria-hidden="true"]')).toHaveLength(caps.length);
    } finally {
      dialogCore.close();
      dispose();
      dom.cleanup();
    }
  });
