import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import { UiNode } from "../src/runtime/protocol";

(isServer ? test.skip : test)("runtime snapshots preserve nested input identity, focus and selection", async () => {
  const dom = createDomTestHarness();
  const { RuntimeView } = await import("../src/frontend/RuntimeView");
  const initial = [
    { id: "title", kind: "input", label: "Title", value: "task" },
    { id: "footer-input", kind: "input", label: "Footer", value: "note" },
    { id: "row", kind: "row", children: ["title"] },
    { id: "section", kind: "section", children: ["row"] },
    { id: "root", kind: "workbench", children: ["section", "footer-input"], controls: ["section"], footer: { actions: ["footer-input"] } },
  ].map((n) => UiNode.parse(n));
  const [nodes, setNodes] = createSignal(initial);
  const dispose = render(
    () =>
      createComponent(RuntimeView, {
        get nodes() {
          return nodes();
        },
        busy: false,
        event(id, value) {
          setNodes((current) => structuredClone(current).map((n) => (n.id === id ? { ...n, value: value ?? "" } : n)));
        },
      }),
    dom.root,
  );
  try {
    for (const id of ["title", "footer-input"]) {
      const input = dom.root.querySelector<HTMLInputElement>(`[data-kit-id="${id}"] input`)!;
      input.focus();
      for (const character of "abcdef") {
        input.value += character;
        input.setSelectionRange(2, 3);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        await Promise.resolve();
        expect(dom.root.querySelector(`[data-kit-id="${id}"] input`)).toBe(input);
        expect(dom.document.activeElement).toBe(input);
        expect(input.selectionStart).toBe(2);
        expect(input.selectionEnd).toBe(3);
      }
    }
  } finally {
    dispose();
    dom.cleanup();
  }
});

(isServer ? test.skip : test)("list refreshes remove absent rows without exposing their action controls", async () => {
  const dom = createDomTestHarness();
  const { RuntimeView } = await import("../src/frontend/RuntimeView");
  const initial = [
    { id: "action", kind: "button", label: "Complete" },
    {
      id: "list",
      kind: "list",
      label: "Tasks",
      children: ["action"],
      items: [{ id: "one", title: "One task", action: "action" }],
      empty: { title: "All done" },
    },
  ].map((n) => UiNode.parse(n));
  const [nodes, setNodes] = createSignal(initial);
  const dispose = render(
    () =>
      createComponent(RuntimeView, {
        get nodes() {
          return nodes();
        },
        busy: false,
        event() {},
      }),
    dom.root,
  );
  try {
    expect(dom.root.textContent).toContain("One task");
    expect(dom.root.textContent).toContain("Complete");
    setNodes((current) => structuredClone(current).map((n) => (n.kind === "list" ? { ...n, items: [] } : n)));
    await Promise.resolve();
    expect(dom.root.textContent).toContain("All done");
    expect(dom.root.textContent).not.toContain("One task");
    expect(dom.root.textContent).not.toContain("Complete");
    setNodes(initial);
    await Promise.resolve();
    expect(dom.root.textContent).toContain("One task");
  } finally {
    dispose();
    dom.cleanup();
  }
});

(isServer ? test.skip : test)("keyed table snapshots preserve row DOM while updating cells", async () => {
  const dom = createDomTestHarness();
  const { RuntimeView } = await import("../src/frontend/RuntimeView");
  const initial = UiNode.parse({
    id: "table",
    kind: "table",
    rowKey: "id",
    columns: [{ key: "title", label: "Title" }],
    rows: [{ id: "a", title: "First" }],
  });
  const [nodes, setNodes] = createSignal([initial]);
  const dispose = render(
    () =>
      createComponent(RuntimeView, {
        get nodes() {
          return nodes();
        },
        busy: false,
        event() {},
      }),
    dom.root,
  );
  try {
    const row = dom.root.querySelector("tbody tr");
    setNodes([
      {
        ...structuredClone(initial),
        rows: [
          { id: "a", title: "Updated" },
          { id: "b", title: "Second" },
        ],
      },
    ]);
    await Promise.resolve();
    expect(dom.root.querySelector("tbody tr")).toBe(row);
    expect(row!.textContent).toContain("Updated");
    expect(dom.root.querySelectorAll("tbody tr")).toHaveLength(2);
  } finally {
    dispose();
    dom.cleanup();
  }
});
