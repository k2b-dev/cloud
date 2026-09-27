import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { delegateEvents, render } from "solid-js/web";
import { cssDeclarations, readShippedCssRules } from "../src/styles/css-contract-test-helpers";
import { createDomTestHarness } from "./dom";

// Once the pointer leaves the row on its way to the menu, the row no longer matches :hover, and
// Chromium does not carry :focus-within out of the top-layer menu into the row. The test loads the
// rules that still apply in that state: the fine-pointer hide rule and the open-menu reveal rule.
const FINE_POINTER = "@media (hover: hover) and (pointer: fine)";
const shippedRules = readShippedCssRules(resolve(import.meta.dir, "../src/styles"));
const hoverActionRules = shippedRules
  .filter(
    (rule) =>
      rule.context === FINE_POINTER &&
      rule.selector.startsWith('.k2b-ui .k2b-app-workspace__sidebar-item-actions[data-visibility="hover"]'),
  )
  .map((rule) => `${FINE_POINTER} { ${rule.selector} { ${rule.body} } }`)
  .join("\n");

// Happy DOM matches neither :hover nor :focus-within. Browsers apply both to the hovered or focused
// element and its ancestors; the nested-tree test marks that chain with attributes and loads every
// fine-pointer rule that decides whether hover accessories render, with the marks in their place.
const accessoryDisplayRules = shippedRules
  .filter(
    (rule) =>
      rule.context === FINE_POINTER && rule.selector.includes('[data-visibility="hover"]') && cssDeclarations(rule.body).has("display"),
  )
  .map((rule) => {
    const selector = rule.selector.replaceAll(":hover", "[data-hover]").replaceAll(":focus-within", "[data-focus-within]");
    return `${FINE_POINTER} { ${selector} { ${rule.body} } }`;
  })
  .join("\n");

// Happy DOM has no popover implementation. Browsers fire `toggle` from a later task, after
// microtasks such as the menu's focus move; the stub keeps that order.
const installPopover = (): void => {
  const open = new WeakSet<Element>();
  const prototype = HTMLElement.prototype;
  const matches = prototype.matches;
  const toggle = (element: HTMLElement, newState: "open" | "closed") =>
    setTimeout(() => {
      const event = new Event("toggle");
      Object.defineProperty(event, "newState", { value: newState });
      element.dispatchEvent(event);
    });
  prototype.matches = function (this: HTMLElement, selector: string): boolean {
    return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
  };
  prototype.showPopover = function (this: HTMLElement): void {
    open.add(this);
    toggle(this, "open");
  };
  prototype.hidePopover = function (this: HTMLElement): void {
    open.delete(this);
    toggle(this, "closed");
  };
};

const nextTask = () => new Promise((resolve) => setTimeout(resolve));

const renderNoteTree = async () => {
  const dom = createDomTestHarness();
  delegateEvents(["click", "keydown"], dom.document);
  installPopover();
  const style = dom.document.createElement("style");
  style.textContent = hoverActionRules;
  dom.document.head.append(style);
  dom.root.className = "k2b-ui";
  const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
  const { Dropdown } = await import("../src/actions/Dropdown");
  const selected: string[] = [];
  const dispose = render(
    () => (
      <AppWorkspace.NavTree ariaLabel="Notes">
        <AppWorkspace.NavTree.Item
          id="recipes"
          label="Recipes"
          href="/notes/recipes"
          actions={
            <AppWorkspace.SidebarItemActions visibility="hover">
              <Dropdown.Root
                items={[
                  { label: "New sub-note", action: () => selected.push("new") },
                  { label: "Duplicate", action: () => selected.push("duplicate") },
                ]}
              >
                <Dropdown.Trigger iconOnly label="Recipes actions">
                  <i class="ti ti-dots" />
                </Dropdown.Trigger>
              </Dropdown.Root>
            </AppWorkspace.SidebarItemActions>
          }
        />
        <AppWorkspace.NavTree.Item id="travel" label="Travel" href="/notes/travel" />
      </AppWorkspace.NavTree>
    ),
    dom.root,
  );
  const node = (id: string) => dom.root.querySelector<HTMLElement>(`[data-k2b-nav-tree-id="${id}"]`)!;
  const actions = node("recipes").querySelector<HTMLElement>(".k2b-app-workspace__sidebar-item-actions")!;
  const trigger = actions.querySelector<HTMLButtonElement>('[aria-label="Recipes actions"]')!;
  const menu = dom.document.getElementById(trigger.getAttribute("aria-controls")!)!;
  const item = (label: string) =>
    Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((candidate) => candidate.textContent === label)!;
  // Happy DOM keeps an element's :has() match when a descendant attribute such as aria-expanded
  // changes; a transient child clears that element's cache so every read starts from a fresh cascade.
  const actionsDisplay = () => {
    actions.appendChild(dom.document.createComment("")).remove();
    return getComputedStyle(actions).display;
  };
  return {
    dom,
    node,
    actions,
    trigger,
    menu,
    item,
    actionsDisplay,
    selected,
    cleanup: () => {
      dispose();
      dom.cleanup();
    },
  };
};

test("a hover-only row menu stays open while the pointer travels into it", async () => {
  const view = await renderNoteTree();
  try {
    expect(view.actionsDisplay()).toBe("none");

    view.trigger.click();
    expect(view.trigger.getAttribute("aria-expanded")).toBe("true");
    expect(view.actionsDisplay()).not.toBe("none");

    for (const [target, type] of [
      [view.node("recipes"), "pointerleave"],
      [view.node("travel"), "pointerenter"],
      [view.node("travel"), "pointerleave"],
      [view.menu, "pointerenter"],
    ] as const) {
      target.dispatchEvent(new Event(type));
    }
    await nextTask();
    expect(view.menu.matches(":popover-open")).toBe(true);
    expect(view.trigger.getAttribute("aria-expanded")).toBe("true");
    expect(view.actionsDisplay()).not.toBe("none");

    view.item("Duplicate").click();
    await nextTask();
    expect(view.selected).toEqual(["duplicate"]);
    expect(view.menu.matches(":popover-open")).toBe(false);
    expect(view.trigger.getAttribute("aria-expanded")).toBe("false");
    expect(view.actionsDisplay()).toBe("none");
  } finally {
    view.cleanup();
  }
});

test("keyboard opens the row menu into a rendered item and Escape returns focus to the trigger", async () => {
  const view = await renderNoteTree();
  try {
    const displayOnFocus: string[] = [];
    view.menu.addEventListener("focusin", () => displayOnFocus.push(view.actionsDisplay()));
    view.trigger.focus();
    view.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(view.trigger.getAttribute("aria-expanded")).toBe("true");
    await Promise.resolve();
    expect(view.dom.document.activeElement).toBe(view.item("New sub-note"));

    view.item("New sub-note").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(view.dom.document.activeElement).toBe(view.item("Duplicate"));
    // Focus inside a hidden subtree is dropped by the browser, so the menu's row actions must stay rendered.
    expect(displayOnFocus).toHaveLength(2);
    expect(displayOnFocus).not.toContain("none");

    view.item("Duplicate").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTask();
    expect(view.menu.matches(":popover-open")).toBe(false);
    expect(view.trigger.getAttribute("aria-expanded")).toBe("false");
    expect(view.dom.document.activeElement).toBe(view.trigger);
    expect(view.selected).toEqual([]);
  } finally {
    view.cleanup();
  }
});

const renderNestedTree = async () => {
  const dom = createDomTestHarness();
  delegateEvents(["click", "keydown"], dom.document);
  installPopover();
  const style = dom.document.createElement("style");
  style.textContent = accessoryDisplayRules;
  dom.document.head.append(style);
  dom.root.className = "k2b-ui";
  const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
  const { Dropdown } = await import("../src/actions/Dropdown");
  const rowActions = (label: string) => (
    <AppWorkspace.SidebarItemActions visibility="hover">
      <Dropdown.Root items={[{ label: "Rename", action: () => {} }]}>
        <Dropdown.Trigger iconOnly label={`${label} actions`}>
          <i class="ti ti-dots" />
        </Dropdown.Trigger>
      </Dropdown.Root>
    </AppWorkspace.SidebarItemActions>
  );
  const dispose = render(
    () => (
      <AppWorkspace.NavTree ariaLabel="Notes" defaultExpandedIds={["recipes"]}>
        <AppWorkspace.NavTree.Item id="recipes" label="Recipes" href="/notes/recipes" actions={rowActions("Recipes")}>
          <AppWorkspace.NavTree.Item id="soups" label="Soups" href="/notes/soups" actions={rowActions("Soups")} />
        </AppWorkspace.NavTree.Item>
      </AppWorkspace.NavTree>
    ),
    dom.root,
  );
  const node = (id: string) => dom.root.querySelector<HTMLElement>(`[data-k2b-nav-tree-id="${id}"]`)!;
  const row = (id: string) => node(id).querySelector<HTMLElement>(":scope > .k2b-app-workspace__nav-tree-row")!;
  const trigger = (id: string) => row(id).querySelector<HTMLButtonElement>(".k2b-dropdown__trigger")!;
  // Moves a state mark to the element and its ancestors, the chain a browser matches for the state.
  const marked = new Map<string, Element | null>();
  const mark = (attribute: "data-hover" | "data-focus-within", element: Element | null) => {
    for (let current = marked.get(attribute) ?? null; current; current = current.parentElement) current.removeAttribute(attribute);
    for (let current = element; current; current = current.parentElement) current.setAttribute(attribute, "");
    marked.set(attribute, element);
  };
  // The transient child clears Happy DOM's cached :has() match, as in renderNoteTree.
  const shownRows = () =>
    ["recipes", "soups"].filter((id) => {
      const actions = row(id).querySelector<HTMLElement>(":scope > .k2b-app-workspace__sidebar-item-actions")!;
      actions.appendChild(dom.document.createComment("")).remove();
      return getComputedStyle(actions).display !== "none";
    });
  return {
    dom,
    node,
    row,
    trigger,
    mark,
    hover: (element: Element | null) => mark("data-hover", element),
    // Focuses the element, or follows focus a component moved itself.
    focus: (element?: HTMLElement) => {
      element?.focus();
      mark("data-focus-within", dom.document.activeElement);
    },
    shownRows,
    cleanup: () => {
      dispose();
      dom.cleanup();
    },
  };
};

test("a nested nav tree row reveals only its own hover actions", async () => {
  const view = await renderNestedTree();
  try {
    expect(view.shownRows()).toEqual([]);

    // Hovering a row also hovers its tree node and every ancestor node.
    view.hover(view.row("recipes"));
    expect(view.shownRows()).toEqual(["recipes"]);
    view.hover(view.row("soups"));
    expect(view.shownRows()).toEqual(["soups"]);
    view.hover(null);

    // Roving focus rests on a tree node, which also contains its children's rows.
    view.focus(view.node("recipes"));
    expect(view.shownRows()).toEqual(["recipes"]);
    view.focus(view.node("soups"));
    expect(view.shownRows()).toEqual(["soups"]);
    // Tab from a node into its own trigger: Chromium blurs the node, leaves :focus-within on it as
    // the common ancestor, and drops the focus unless the trigger still renders at that moment.
    view.node("soups").blur();
    view.mark("data-focus-within", view.node("soups"));
    expect(view.shownRows()).toEqual(["soups"]);
    view.focus(view.trigger("soups"));
    expect(view.shownRows()).toEqual(["soups"]);

    // A child's open menu keeps the child's actions rendered, never the parent's.
    view.hover(view.row("soups"));
    view.trigger("soups").click();
    await Promise.resolve();
    view.focus();
    expect(view.trigger("soups").getAttribute("aria-expanded")).toBe("true");
    expect(view.shownRows()).toEqual(["soups"]);
    view.hover(null);
    expect(view.shownRows()).toEqual(["soups"]);

    view.dom.document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTask();
    view.focus();
    expect(view.dom.document.activeElement).toBe(view.trigger("soups"));
    expect(view.trigger("soups").getAttribute("aria-expanded")).toBe("false");
    expect(view.shownRows()).toEqual(["soups"]);
  } finally {
    view.cleanup();
  }
});
