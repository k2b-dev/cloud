import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { AiTurnBlock } from "../protocol";

if (isServer) test.skip("requires browser conditions and DOM transform", () => {});
else
  test("streaming appends steps without remounting the expanded work line or group, or revealing payloads", async () => {
    const dom = createDomTestHarness();
    const { AiTurnView } = await import("./turn-view");
    const { layoutAiTurn } = await import("./turn-layout");
    const { createAiToolDisclosureState } = await import("./tool-disclosure");
    const tool = (id: string): AiTurnBlock => ({
      id,
      kind: "tool",
      callId: id,
      name: "read_file",
      args: { path: `/${id}` },
      result: { data: "hidden payload" },
      status: "completed",
    });
    const [blocks, setBlocks] = createSignal([tool("one"), tool("two")]);
    const disclosureState = createAiToolDisclosureState();
    const dispose = render(
      () =>
        createComponent(AiTurnView, {
          segment: () => ({
            id: "ai-turn:turn:0",
            turnId: "turn",
            phase: "running",
            layout: layoutAiTurn(blocks(), { phase: "running" }),
            earlier: false,
            duration: () => null,
          }),
          disclosureState,
        }),
      dom.root,
    );
    try {
      const work = dom.root.querySelector("details")!;
      expect(work).not.toBeNull();
      expect(dom.root.textContent).not.toContain("hidden payload");
      work.open = true;
      work.dispatchEvent(new Event("toggle"));
      const group = work.querySelector("details")!;
      group.open = true;
      group.dispatchEvent(new Event("toggle"));
      const summary = group.querySelector("summary")!;
      summary.focus();
      setBlocks((previous) => [...previous, tool("three")]);
      expect(dom.root.querySelector("details")).toBe(work);
      expect(work.querySelector("details")).toBe(group);
      expect(document.activeElement).toBe(summary);
      const firstTool = group.querySelector("details")!;
      setBlocks((previous) => [...previous, tool("four")]);
      expect(work.querySelector("details")).toBe(group);
      expect(group.open).toBe(true);
      expect(group.querySelector("details")).toBe(firstTool);
      expect(document.activeElement).toBe(summary);
      expect(dom.root.textContent).not.toContain("hidden payload");
      firstTool.open = true;
      firstTool.dispatchEvent(new Event("toggle"));
      expect(dom.root.textContent).toContain("hidden payload");
      const restored = createAiToolDisclosureState();
      expect(restored.get("work:ai-turn:turn:0")).toBe(true);
      expect(restored.get("group:one")).toBe(true);
      expect(restored.get("one")).toBe(true);
      restored.set("one", false);
      expect(createAiToolDisclosureState().get("one")).toBeUndefined();
    } finally {
      dispose();
      dom.cleanup();
    }
  });
