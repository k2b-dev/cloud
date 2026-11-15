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
    steps: () => Array.from(dom.root.querySelectorAll<HTMLElement>(".ai-turn-steps > .k2b-chat-activity")),
    cleanup: () => {
      dispose();
      dom.cleanup();
    },
  };
};

domTest("streaming appends steps in words at the work line's indent without remounting them or revealing payloads", async () => {
  const [blocks, setBlocks] = createSignal([tool("one"), tool("two")]);
  const view = await mount(blocks);
  try {
    const work = view.work();
    expect(work.getAttribute("data-body-inset")).toBe("false");
    expect(view.dom.root.textContent).not.toContain("hidden payload");
    view.toggle(work);
    const [first] = view.steps();
    expect(first?.textContent).toContain("Read file");
    // Steps sit directly in the work line's body; nothing summarizes them a second time.
    expect(work.querySelector(".ti-stack-2")).toBeNull();
    // A step in words has no payload to open; the work line keeps the focus while steps stream in.
    expect(first!.querySelector("summary")).toBeNull();
    const summary = work.querySelector("summary")!;
    summary.focus();
    setBlocks((previous) => [...previous, tool("three")]);
    setBlocks((previous) => [...previous, tool("four")]);
    expect(view.work()).toBe(work);
    expect(work.open).toBe(true);
    expect(view.steps()[0]).toBe(first!);
    expect(view.steps()).toHaveLength(4);
    expect(document.activeElement).toBe(summary);
    expect(view.dom.root.textContent).not.toContain("hidden payload");
    const { createAiToolDisclosureState } = await import("./tool-disclosure");
    const restored = createAiToolDisclosureState();
    expect(restored.get("work:ai-turn:turn:0")).toBe(true);
    restored.set("work:ai-turn:turn:0", false);
    expect(createAiToolDisclosureState().get("work:ai-turn:turn:0")).toBeUndefined();
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
    expect(view.steps().map((step) => step.querySelector(".k2b-chat-activity__row")?.textContent)).toEqual([
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
    // Its steps start on the group's text edge, a real level below it.
    expect(group!.getAttribute("data-body-inset")).toBeNull();
    view.toggle(group as HTMLDetailsElement);
    expect(group!.querySelectorAll(".ai-turn-steps > .k2b-chat-activity")).toHaveLength(3);
  } finally {
    view.cleanup();
  }
});

domTest("rows a reader sees in the open work list stay when later reasoning or arguments would fold them", async () => {
  const work = [tool("x", "code_run"), tool("y", "code_run"), tool("a", "load_skill"), tool("b", "load_tools")];
  const [blocks, setBlocks] = createSignal<AiTurnBlock[]>(work);
  const view = await mount(blocks);
  const labels = () => view.steps().map((step) => step.querySelector(".k2b-chat-activity__row")?.textContent ?? "");
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
    // Thinking is a step in words; its reasoning stands in the card behind its ⓘ, and the row itself never opens.
    expect(thought.textContent).toContain("Thinking");
    expect(thought.querySelector("details")).toBeNull();
    expect(thought.querySelector(".k2b-hover-card")?.textContent).toContain("Which reference?");
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

const read = (id: string): Extract<AiTurnBlock, { kind: "tool" }> => ({
  id,
  kind: "tool",
  callId: id,
  name: "read_file",
  args: { path: "/products-100.csv" },
  status: "completed",
});

for (const kind of ["repeat", "housekeeping"] as const) {
  domTest(`${kind} children keep focus and their open group when live and history objects are replaced`, async () => {
    const entries =
      kind === "repeat"
        ? [0, 100, 200].map((offset, index) => ({ ...read(`read-${index}`), args: { path: "/products-100.csv", offset } }))
        : [tool("tools", "load_tools"), tool("skill", "load_skill")];
    const lastId = entries.at(-1)!.id;
    const [blocks, setBlocks] = createSignal<AiTurnBlock[]>([
      ...entries.map((entry) => (entry.kind === "tool" && entry.id === lastId ? { ...entry, status: "running" as const } : entry)),
      tool("run", "code_run"),
      tool("check", "code_check"),
    ]);
    const view = await mount(blocks);
    try {
      view.toggle(view.work());
      const group = view.steps()[0]!;
      view.toggle(group as HTMLDetailsElement);
      const children = group.querySelectorAll<HTMLElement>(".ai-turn-steps > .k2b-chat-activity");
      expect(children).toHaveLength(entries.length);
      const last = children[children.length - 1]!;
      // Steps in words take no focus; the group's own summary keeps it and the rows stay the same elements.
      const summary = group.querySelector("summary")!;
      summary.focus();
      expect(document.activeElement).toBe(summary);

      setBlocks((previous) =>
        previous.map((entry) => (entry.kind === "tool" && entry.id === lastId ? { ...entry, status: "completed" } : entry)),
      );
      expect(last.isConnected).toBe(true);
      expect(document.activeElement).toBe(summary);
      expect((group as HTMLDetailsElement).open).toBe(true);

      setBlocks((previous) => previous.map((entry) => ({ ...entry })));
      expect(last.isConnected).toBe(true);
      expect(document.activeElement).toBe(summary);
      expect((group as HTMLDetailsElement).open).toBe(true);
    } finally {
      view.cleanup();
    }
  });
}

domTest("repeated reads open in place with their title, target and call count", async () => {
  const view = await mount(
    () => [read("a"), read("b"), read("c"), tool("run", "code_run"), tool("check", "code_check")],
    () => "completed",
  );
  try {
    view.toggle(view.work());
    const steps = view.steps();
    expect(steps).toHaveLength(3);
    const repeat = steps[0]!;
    expect(repeat.querySelector("summary")?.textContent).toContain("Read file");
    expect(repeat.querySelector("summary")?.textContent).toContain("/products-100.csv");
    expect(repeat.querySelector("summary")?.textContent).toContain("3 times");
    expect(steps.slice(1).map((step) => step.querySelector("summary")?.textContent)).toEqual([
      expect.stringContaining("Ran code"),
      expect.stringContaining("App check"),
    ]);
    // Its parts start on the row's text edge, a real level below it.
    expect(repeat.getAttribute("data-body-inset")).toBeNull();
    view.toggle(repeat as HTMLDetailsElement);
    expect(repeat.querySelectorAll(".ai-turn-steps > .k2b-chat-activity")).toHaveLength(3);
  } finally {
    view.cleanup();
  }
});

domTest("a failed read stays outside repeated reads as its own row", async () => {
  const view = await mount(
    () => [read("a"), read("b"), { ...read("bad"), isError: true }, read("c"), read("d")],
    () => "completed",
  );
  try {
    view.toggle(view.work());
    const steps = view.steps();
    expect(steps).toHaveLength(3);
    expect(steps[1]!.textContent).toContain("This did not work.");
    expect(steps[0]!.querySelector("summary")?.textContent).toContain("2 times");
    expect(steps[2]!.querySelector("summary")?.textContent).toContain("2 times");
    for (const repeat of [steps[0]!, steps[2]!]) {
      view.toggle(repeat as HTMLDetailsElement);
      expect(repeat.querySelectorAll(".ai-turn-steps > .k2b-chat-activity")).toHaveLength(2);
      expect(repeat.textContent).not.toContain("did not work");
    }
  } finally {
    view.cleanup();
  }
});

domTest("a finished app Query says what it did: the app's past form, else its title marked done; a running one its title", async () => {
  const query = (id: string, status: "completed" | "running", doneTitle?: string): AiTurnBlock => ({
    id,
    kind: "tool",
    callId: id,
    name: `acme__query__${id}`,
    status,
    args: { query: "Messestand" },
    result: { data: "hidden payload" },
    presentation: {
      kind: "capability",
      appId: "acme",
      appName: "Acme",
      appIcon: "ti ti-box",
      title: `Search ${id}`,
      capabilityKind: "query",
      ...(doneTitle ? { doneTitle } : {}),
    },
  });
  const view = await mount(() => [query("mail", "completed", "Searched mail"), query("notes", "completed"), query("files", "running")]);
  try {
    view.toggle(view.work());
    const labels = view.steps().map((step) => step.querySelector(".k2b-chat-activity__label")?.textContent ?? step.textContent);
    expect(labels[0]).toContain("Searched mail");
    expect(labels[1]).toContain("Search notes · done");
    expect(labels[2]).toContain("Search files");
    expect(labels[2]).not.toContain("done");
    // What the step looked for stays below it.
    expect(view.steps()[0]?.textContent).toContain("Messestand");
  } finally {
    view.cleanup();
  }
});
