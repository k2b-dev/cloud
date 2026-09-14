import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { AiTurnBlock } from "../protocol";

if (isServer) test.skip("requires browser conditions and DOM transform", () => {});
else
  test("streaming appends tools without remounting the expanded group or revealing payloads", async () => {
    const dom = createDomTestHarness();
    const { AiTurnBlockList } = await import("./blocks");
    const tool = (id: string): AiTurnBlock => ({
      id,
      kind: "tool",
      callId: id,
      name: "read_file",
      args: { path: `/${id}` },
      result: { data: "hidden payload" },
      status: "completed",
    });
    const [blocks, setBlocks] = createSignal([tool("one")]);
    const dispose = render(
      () =>
        createComponent(AiTurnBlockList, {
          get blocks() {
            return blocks();
          },
          active: true,
          turnId: "turn",
        }),
      dom.root,
    );
    try {
      const group = dom.root.querySelector("details")!;
      expect(group).not.toBeNull();
      expect(dom.root.textContent).not.toContain("hidden payload");
      group.open = true;
      group.dispatchEvent(new Event("toggle"));
      const summary = group.querySelector("summary")!;
      summary.focus();
      setBlocks((previous) => [...previous, tool("two")]);
      expect(dom.root.querySelector("details")).toBe(group);
      expect(document.activeElement).toBe(summary);
      const firstTool = group.querySelector("details")!;
      setBlocks((previous) => [...previous, tool("three")]);
      expect(dom.root.querySelector("details")).toBe(group);
      expect(group.open).toBe(true);
      expect(group.querySelector("details")).toBe(firstTool);
      expect(document.activeElement).toBe(summary);
      expect(dom.root.textContent).not.toContain("hidden payload");
      firstTool.open = true;
      firstTool.dispatchEvent(new Event("toggle"));
      expect(dom.root.textContent).toContain("hidden payload");
      const { createAiToolDisclosureState } = await import("./tool-disclosure");
      const restored = createAiToolDisclosureState();
      expect(restored.get("group:one")).toBe(true);
      expect(restored.get("one")).toBe(true);
      restored.set("one", false);
      expect(createAiToolDisclosureState().get("one")).toBeUndefined();
    } finally {
      dispose();
      dom.cleanup();
    }
  });
