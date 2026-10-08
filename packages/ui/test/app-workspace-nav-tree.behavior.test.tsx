import { describe, expect, test } from "bun:test";
import { createSignal, For } from "solid-js";
import { isServer, render } from "solid-js/web";
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
});
