import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { AiTurnBlock } from "../protocol";

const domTest = isServer ? test.skip : test;

const tool = (id: string, name = "read_file"): AiTurnBlock => ({
  id,
  kind: "tool",
  callId: id,
  name,
  args: { path: `/${id}` },
  result: { data: "hidden payload" },
  status: "completed",
});

const mount = async (blocks: () => AiTurnBlock[], phase: () => "running" | "completed" = () => "running") => {
  const dom = createDomTestHarness();
  const { AiTurnView } = await import("./turn-view");
  const { layoutAiTurn } = await import("./turn-layout");
  const { createAiToolDisclosureState } = await import("./tool-disclosure");
  const disclosureState = createAiToolDisclosureState();
  const dispose = render(
    () =>
      createComponent(AiTurnView, {
        segment: () => ({
          id: "ai-turn:turn:0",
          turnId: "turn",
          phase: phase(),
          layout: layoutAiTurn(blocks(), { phase: phase() }),
          earlier: false,
          duration: () => null,
        }),
        disclosureState,
      }),
    dom.root,
  );
  const toggle = (details: HTMLDetailsElement) => {
    details.open = !details.open;
    details.dispatchEvent(new Event("toggle"));
  };
  return {
    dom,
    toggle,
    work: () => dom.root.querySelector<HTMLDetailsElement>("details.ai-turn-work")!,
    steps: () => Array.from(dom.root.querySelectorAll<HTMLDetailsElement>(".ai-turn-steps > details")),
    cleanup: () => {
      dispose();
      dom.cleanup();
    },
  };
};

domTest("streaming appends steps one level below the work line without remounting them or revealing payloads", async () => {
  const [blocks, setBlocks] = createSignal([tool("one"), tool("two")]);
  const view = await mount(blocks);
  try {
    const work = view.work();
    expect(view.dom.root.textContent).not.toContain("hidden payload");
    view.toggle(work);
    const [first] = view.steps();
    expect(first?.textContent).toContain("Read file");
    // Steps sit directly in the work line's body; nothing summarizes them a second time.
    expect(work.querySelector(".ti-stack-2")).toBeNull();
    const summary = first!.querySelector("summary")!;
    summary.focus();
    setBlocks((previous) => [...previous, tool("three")]);
    setBlocks((previous) => [...previous, tool("four")]);
    expect(view.work()).toBe(work);
    expect(work.open).toBe(true);
    expect(view.steps()[0]).toBe(first!);
    expect(view.steps()).toHaveLength(4);
    expect(document.activeElement).toBe(summary);
    expect(view.dom.root.textContent).not.toContain("hidden payload");
    // A step's details open in place, without a second indent.
    view.toggle(first!);
    expect(first!.getAttribute("data-body-inset")).toBe("false");
    expect(view.dom.root.textContent).toContain("hidden payload");
    const { createAiToolDisclosureState } = await import("./tool-disclosure");
    const restored = createAiToolDisclosureState();
    expect(restored.get("work:ai-turn:turn:0")).toBe(true);
    expect(restored.get("one")).toBe(true);
    restored.set("one", false);
    expect(createAiToolDisclosureState().get("one")).toBeUndefined();
  } finally {
    view.cleanup();
  }
});

domTest("the work line opens with its steps every time, also after it was closed and nothing changed since", async () => {
  const [blocks, setBlocks] = createSignal([tool("one"), tool("two")]);
  const [phase, setPhase] = createSignal<"running" | "completed">("running");
  const view = await mount(blocks, phase);
  try {
    const work = view.work();
    view.toggle(work);
    expect(view.steps()).toHaveLength(2);
    view.toggle(work);
    setBlocks((previous) => [...previous, tool("three")]);
    setPhase("completed");
    expect(work.open).toBe(false);
    // The turn is history now and nothing updates it; opening it still shows its steps.
    view.toggle(work);
    expect(work.open).toBe(true);
    expect(view.steps()).toHaveLength(3);
  } finally {
    view.cleanup();
  }
});

domTest("housekeeping folds at step level and opens in place; steps a reader watches never fold away", async () => {
  const loading = [tool("skill", "load_skill"), tool("tools", "load_tools"), tool("help", "search_help")];
  const [blocks, setBlocks] = createSignal(loading);
  const view = await mount(blocks);
  try {
    view.toggle(view.work());
    // Only housekeeping so far: the steps show directly instead of a group that would summarize all of them.
    expect(view.steps().map((step) => step.querySelector("summary")?.textContent)).toEqual([
      expect.stringContaining("Load skill"),
      expect.stringContaining("Load tools"),
      expect.stringContaining("Search help"),
    ]);
    const shown = view.steps();
    setBlocks([...loading, tool("run", "code_run"), tool("check", "code_check")]);
    expect(view.steps().slice(0, 3)).toEqual(shown);

    // Opened again, the housekeeping folds into one row at step level that opens in place.
    view.toggle(view.work());
    view.toggle(view.work());
    const [group, ...rest] = view.steps();
    expect(group!.querySelector("summary")?.textContent).toContain("Loaded tools and guidance");
    expect(group!.querySelector("summary")?.textContent).toContain("3 steps");
    expect(rest.map((step) => step.querySelector("summary")?.textContent)).toEqual([
      expect.stringContaining("Ran code"),
      expect.stringContaining("App check"),
    ]);
    expect(group!.getAttribute("data-body-inset")).toBe("false");
    view.toggle(group!);
    expect(group!.querySelectorAll(".ai-turn-steps > details")).toHaveLength(3);
  } finally {
    view.cleanup();
  }
});

domTest("rows a reader sees in the open work list stay when later reasoning or arguments would fold them", async () => {
  const work = [tool("x", "code_run"), tool("y", "code_run"), tool("a", "load_skill"), tool("b", "load_tools")];
  const [blocks, setBlocks] = createSignal<AiTurnBlock[]>(work);
  const view = await mount(blocks);
  const labels = () => view.steps().map((step) => step.querySelector("summary")?.textContent ?? "");
  try {
    view.toggle(view.work());
    expect(labels()).toEqual([
      expect.stringContaining("Ran code"),
      expect.stringContaining("Ran code"),
      expect.stringContaining("Loaded tools and guidance"),
    ]);
    const group = view.steps()[2]!;

    // Reasoning streams in after the group, then the next housekeeping step: the reasoning row stays.
    setBlocks([...work, { id: "t", kind: "thinking", text: "Which reference?" }]);
    const thought = view.steps()[3]!;
    expect(thought.textContent).toContain("Which reference?");
    setBlocks([...work, { id: "t", kind: "thinking", text: "Which reference?" }, tool("c", "load_skill")]);
    expect(view.steps()[2]).toBe(group);
    expect(view.steps()[3]).toBe(thought);
    expect(group.querySelector("summary")?.textContent).toContain("2 steps");

    // A file read starts without its arguments, so it shows as a step; its skill path arrives later and it stays.
    const read = { id: "r", kind: "tool" as const, callId: "r", name: "read_file", status: "running" as const };
    const before = [...blocks()];
    setBlocks([...before, read]);
    const row = view.steps().at(-1)!;
    expect(row.textContent).toContain("Read file");
    setBlocks([...before, { ...read, args: { path: "/skills/report/SKILL.md" } }]);
    expect(view.steps().at(-1)).toBe(row);
    expect(group.querySelector("summary")?.textContent).toContain("2 steps");
  } finally {
    view.cleanup();
  }
});
