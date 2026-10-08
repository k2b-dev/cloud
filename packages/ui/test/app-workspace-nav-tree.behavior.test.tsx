import { describe, expect, test } from "bun:test";
import { createSignal, For } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import type { AppWorkspaceNavTreeMove } from "../src/layout/AppWorkspace";
import { createDomTestHarness } from "./dom";

describe("@k2b/ui AppWorkspace.NavTree behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("keeps state, depth, and keyboard focus controlled", async () => {
    const dom = createDomTestHarness();
    const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
    const [selectedId, setSelectedId] = createSignal("notes");
    const [expandedIds, setExpandedIds] = createSignal<readonly string[]>(["notes", "tags"]);
    let actionCount = 0;
    let dragOverCount = 0;
    const recipeAction = dom.document.createElement("button");
    recipeAction.type = "button";
    recipeAction.setAttribute("aria-label", "Recipe actions");
    recipeAction.textContent = "Actions";
    recipeAction.addEventListener("click", () => actionCount++);
    const dispose = render(
      () => (
        <>
          <AppWorkspace.NavTree
            ariaLabel="Notebook navigation"
            selectedId={selectedId()}
            expandedIds={expandedIds()}
            onSelectedIdChange={setSelectedId}
            onExpandedIdsChange={setExpandedIds}
          >
            <AppWorkspace.NavTree.Item
              id="notes"
              label="All notes"
              icon="ti ti-folder"
              expandedIcon="ti ti-folder-open"
              onDragOver={() => dragOverCount++}
            >
              <AppWorkspace.NavTree.Item
                id="recipes"
                label="Recipes"
                icon="ti ti-folder"
                actions={<AppWorkspace.SidebarItemActions visibility="hover">{recipeAction}</AppWorkspace.SidebarItemActions>}
              />
            </AppWorkspace.NavTree.Item>
            <AppWorkspace.NavTree.Item id="tags" label="Tags" icon="ti ti-tags">
              <AppWorkspace.NavTree.Item id="recipe-tag" label="#recipe" icon="ti ti-tag" meta={3} />
            </AppWorkspace.NavTree.Item>
          </AppWorkspace.NavTree>
          <AppWorkspace.NavTree ariaLabel="Uncontrolled groups" defaultExpandedIds={["group"]}>
            <AppWorkspace.NavTree.Item id="group" label="Group" icon="ti ti-folders">
              <AppWorkspace.NavTree.Item id="group-child" label="Child" />
            </AppWorkspace.NavTree.Item>
          </AppWorkspace.NavTree>
          <AppWorkspace.NavTree ariaLabel="Dynamic groups" expandedIds={["dynamic"]}>
            <AppWorkspace.NavTree.Item id="dynamic" label="Dynamic">
              <For each={[{ id: "dynamic-child", label: "Dynamic child" }]}>
                {(item) => <AppWorkspace.NavTree.Item id={item.id} label={item.label} />}
              </For>
            </AppWorkspace.NavTree.Item>
          </AppWorkspace.NavTree>
        </>
      ),
      dom.root,
    );

    const notes = () => dom.root.querySelector<HTMLElement>('[data-k2b-nav-tree-id="notes"]');
    const recipes = () => dom.root.querySelector<HTMLElement>('[data-k2b-nav-tree-id="recipes"]');
    const tags = () => dom.root.querySelector<HTMLElement>('[data-k2b-nav-tree-id="tags"]');
    expect(dom.root.querySelector('[role="tree"]')?.getAttribute("aria-label")).toBe("Notebook navigation");
    expect(notes()?.getAttribute("aria-expanded")).toBe("true");
    expect(notes()?.querySelector(".ti-folder-open")).not.toBeNull();
    expect(notes()?.querySelector(".k2b-app-workspace__nav-tree-toggle")).toBeNull();
    notes()?.dispatchEvent(new dom.window.Event("dragover", { bubbles: true }) as unknown as Event);
    expect(dragOverCount).toBe(1);
    expect(recipes()?.getAttribute("aria-level")).toBe("2");
    expect(
      recipes()?.querySelector<HTMLElement>(".k2b-app-workspace__nav-tree-row")?.style.getPropertyValue("--k2b-sidebar-item-depth"),
    ).toBe("1");

    notes()
      ?.querySelector<HTMLElement>("[data-k2b-nav-tree-toggle]")
      ?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
    expect(expandedIds()).toEqual(["tags"]);
    expect(notes()?.getAttribute("aria-expanded")).toBe("false");
    expect(notes()?.querySelector(".ti-folder")).not.toBeNull();
    expect(notes()?.querySelector(".ti-folder-open")).toBeNull();
    expect(recipes()).toBeNull();

    notes()?.focus();
    notes()?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event);
    expect(expandedIds()).toEqual(["tags", "notes"]);
    expect(recipes()).not.toBeNull();

    const recipeActions = recipes()?.querySelector<HTMLButtonElement>('[aria-label="Recipe actions"]');
    const recipeRow = recipes()?.firstElementChild as HTMLElement | null | undefined;
    expect(recipes()?.querySelector(".k2b-app-workspace__nav-tree-row-shell")).toBeNull();
    expect(recipeRow?.classList.contains("k2b-app-workspace__sidebar-item")).toBe(true);
    expect(recipeRow?.classList.contains("k2b-app-workspace__nav-tree-row")).toBe(true);
    expect(recipeRow?.querySelector(":scope > .k2b-app-workspace__sidebar-item-actions")).not.toBeNull();
    recipeActions?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    expect(selectedId()).toBe("notes");
    recipeActions?.click();
    expect(actionCount).toBe(1);
    expect(selectedId()).toBe("notes");

    recipes()?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    expect(selectedId()).toBe("recipes");
    expect(recipeRow?.classList.contains("is-active")).toBe(true);
    expect(recipeRow?.contains(recipeActions ?? null)).toBe(true);
    setSelectedId("notes");

    notes()?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event);
    await Promise.resolve();
    expect(dom.document.activeElement).toBe(recipes());

    recipes()?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true }) as unknown as Event);
    expect(dom.document.activeElement?.getAttribute("data-k2b-nav-tree-id")).toBe("recipe-tag");

    (tags()?.firstElementChild as HTMLElement | null)?.click();
    expect(selectedId()).toBe("tags");
    expect(tags()?.getAttribute("aria-selected")).toBe("true");

    const group = dom.root.querySelector<HTMLElement>('[data-k2b-nav-tree-id="group"]');
    expect(group?.getAttribute("aria-expanded")).toBe("true");
    expect(group?.querySelector(".k2b-app-workspace__nav-tree-toggle")).not.toBeNull();
    (group?.firstElementChild as HTMLElement | null)?.click();
    expect(group?.getAttribute("aria-expanded")).toBe("false");
    expect(dom.root.querySelector('[data-k2b-nav-tree-id="group-child"]')).toBeNull();
    expect(dom.root.querySelector('[data-k2b-nav-tree-id="dynamic-child"]')).not.toBeNull();

    dispose();
    dom.cleanup();
  });

  test("names a meaningful icon and keeps every other icon decorative", async () => {
    const dom = createDomTestHarness();
    const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
    const dispose = render(
      () => (
        <AppWorkspace.NavTree ariaLabel="Notes" defaultExpandedIds={["home"]}>
          <AppWorkspace.NavTree.Item id="home" label="Overview" icon="ti ti-home" iconLabel="Homepage">
            <AppWorkspace.NavTree.Item id="child" label="Rules" icon="ti ti-file-text" />
          </AppWorkspace.NavTree.Item>
        </AppWorkspace.NavTree>
      ),
      dom.root,
    );
    try {
      const icon = (id: string) => dom.root.querySelector(`[data-k2b-nav-tree-id="${id}"] .k2b-app-workspace__sidebar-item-icon`);
      expect(icon("home")?.getAttribute("role")).toBe("img");
      expect(icon("home")?.getAttribute("aria-label")).toBe("Homepage");
      expect(icon("home")?.hasAttribute("aria-hidden")).toBe(false);
      expect(icon("child")?.getAttribute("aria-hidden")).toBe("true");
      expect(icon("child")?.hasAttribute("role")).toBe(false);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
  test("reorders movable items among their siblings by keyboard and keeps focus on the moved item", async () => {
    const dom = createDomTestHarness();
    const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
    // Solid delegates keydown to the document the module first rendered into; this test has a new one.
    delegateEvents(["keydown"], dom.document);
    type Row = { id: string; pinned?: boolean; children?: Row[] };
    const [rows, setRows] = createSignal<Row[]>([
      { id: "home", pinned: true },
      { id: "a" },
      { id: "b", children: [{ id: "b1" }, { id: "b2" }] },
      { id: "c" },
    ]);
    const moves: AppWorkspaceNavTreeMove[] = [];
    // Like an application that saves the move and renders fresh rows from the server.
    const apply = (move: AppWorkspaceNavTreeMove) => {
      moves.push(move);
      const place = (level: Row[]): Row[] => {
        const moved = level.find((row) => row.id === move.id);
        if (!moved) return level.map((row) => ({ ...row, children: row.children && place(row.children) }));
        const rest = level.filter((row) => row !== moved).map((row) => ({ ...row }));
        const at = move.beforeId ? rest.findIndex((row) => row.id === move.beforeId) : rest.length;
        rest.splice(at, 0, { ...moved });
        return rest;
      };
      setRows(place(rows()));
    };
    const Items = (props: { rows: Row[] }) => (
      <For each={props.rows}>
        {(row) => (
          <AppWorkspace.NavTree.Item id={row.id} label={row.id} movable={!row.pinned}>
            {row.children && <Items rows={row.children} />}
          </AppWorkspace.NavTree.Item>
        )}
      </For>
    );
    const dispose = render(
      () => (
        <AppWorkspace.NavTree ariaLabel="Notes" defaultExpandedIds={["b"]} onMove={apply}>
          <Items rows={rows()} />
        </AppWorkspace.NavTree>
      ),
      dom.root,
    );
    const item = (id: string) => dom.root.querySelector<HTMLElement>(`[data-k2b-nav-tree-id="${id}"]`)!;
    const order = (parent: Element) =>
      Array.from(parent.querySelectorAll(":scope > [role='treeitem']")).map((node) => node.getAttribute("data-k2b-nav-tree-id"));
    const press = (id: string, key: string, init: { altKey?: boolean } = { altKey: true }) => {
      item(id).focus();
      const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }) as unknown as Event;
      item(id).dispatchEvent(event);
      return event.defaultPrevented;
    };
    const tree = () => dom.root.querySelector('[role="tree"]')!;
    try {
      expect(item("a").getAttribute("draggable")).toBe("true");
      expect(item("home").hasAttribute("draggable")).toBe(false);
      expect(item("c").getAttribute("aria-posinset")).toBe("4");
      expect(item("c").getAttribute("aria-setsize")).toBe("4");
      expect(item("b2").getAttribute("aria-posinset")).toBe("2");

      expect(press("c", "ArrowUp")).toBe(true);
      expect(moves.at(-1)).toEqual({ id: "c", parentId: null, beforeId: "b", afterId: "a" });
      expect(order(tree())).toEqual(["home", "a", "c", "b"]);
      await Promise.resolve();
      await Promise.resolve();
      expect(dom.document.activeElement).toBe(item("c"));
      expect(item("c").getAttribute("tabindex")).toBe("0");

      // The last item has no place further down.
      press("b", "ArrowDown");
      expect(moves.length).toBe(1);
      expect(press("b1", "ArrowDown")).toBe(true);
      expect(moves.at(-1)).toEqual({ id: "b1", parentId: "b", beforeId: null, afterId: "b2" });

      // A pinned item keeps its place and nothing moves past it.
      const count = moves.length;
      expect(press("a", "ArrowUp")).toBe(true);
      expect(press("home", "ArrowDown")).toBe(false);
      expect(moves.length).toBe(count);
      // Plain arrows still move focus only.
      press("a", "ArrowDown", {});
      expect(moves.length).toBe(count);
      expect(dom.document.activeElement).toBe(item("c"));
    } finally {
      dispose();
      dom.cleanup();
    }
  });
  test("keeps focus on the moved item when the application reorders the same item objects", async () => {
    const dom = createDomTestHarness();
    const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
    delegateEvents(["keydown"], dom.document);
    // Solid moves the existing rows instead of mounting new ones, which drops the focus of a moved row.
    const [a, b, c] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const [rows, setRows] = createSignal([a, b, c]);
    const dispose = render(
      () => (
        <AppWorkspace.NavTree
          ariaLabel="Notes"
          onMove={(move) => {
            const rest = rows().filter((row) => row.id !== move.id);
            const at = move.beforeId ? rest.findIndex((row) => row.id === move.beforeId) : rest.length;
            rest.splice(at, 0, rows().find((row) => row.id === move.id)!);
            setRows(rest);
          }}
        >
          <For each={rows()}>{(row) => <AppWorkspace.NavTree.Item id={row.id} label={row.id} movable />}</For>
        </AppWorkspace.NavTree>
      ),
      dom.root,
    );
    try {
      const item = (id: string) => dom.root.querySelector<HTMLElement>(`[data-k2b-nav-tree-id="${id}"]`)!;
      const press = async (id: string, key: string) => {
        dom.document.activeElement?.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true }) as unknown as Event,
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(dom.document.activeElement).toBe(item(id));
      };
      item("a").focus();
      await press("a", "ArrowDown");
      await press("a", "ArrowDown");
      expect(rows()).toEqual([b, c, a]);
      await press("a", "ArrowUp");
      await press("a", "ArrowUp");
      expect(rows()).toEqual([a, b, c]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
  test("the moved item does not take back focus the person moved elsewhere while the move was saving", async () => {
    const dom = createDomTestHarness();
    const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
    delegateEvents(["keydown"], dom.document);
    const [rows, setRows] = createSignal([{ id: "a" }, { id: "b" }]);
    const pending: AppWorkspaceNavTreeMove[] = [];
    const dispose = render(
      () => (
        <AppWorkspace.NavTree ariaLabel="Notes" onMove={(move) => pending.push(move)}>
          <For each={rows()}>
            {(row) => (
              <AppWorkspace.NavTree.Item
                id={row.id}
                label={row.id}
                movable
                actions={
                  <button type="button" data-action={row.id}>
                    Star
                  </button>
                }
              />
            )}
          </For>
        </AppWorkspace.NavTree>
      ),
      dom.root,
    );
    try {
      const item = (id: string) => dom.root.querySelector<HTMLElement>(`[data-k2b-nav-tree-id="${id}"]`)!;
      item("b").focus();
      item("b").dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true, cancelable: true }) as unknown as Event,
      );
      expect(pending).toEqual([{ id: "b", parentId: null, beforeId: "a", afterId: null }]);
      const star = dom.root.querySelector<HTMLButtonElement>('[data-action="a"]')!;
      star.focus();
      setRows([{ id: "b" }, { id: "a" }]);
      await Promise.resolve();
      await Promise.resolve();
      // The rows were replaced, the chosen button with them; the moved item still does not claim focus.
      expect(dom.document.activeElement).not.toBe(item("b"));
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
