import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { delegateEvents, render } from "solid-js/web";
import { readShippedCssRules } from "../src/styles/css-contract-test-helpers";
import { createDomTestHarness } from "./dom";

// Once the pointer leaves the row on its way to the menu, the row no longer matches :hover, and
// Chromium does not carry :focus-within out of the top-layer menu into the row. The test loads the
// rules that still apply in that state: the fine-pointer hide rule and the open-menu reveal rule.
const FINE_POINTER = "@media (hover: hover) and (pointer: fine)";
const hoverActionRules = readShippedCssRules(resolve(import.meta.dir, "../src/styles"))
  .filter(
    (rule) =>
      rule.context === FINE_POINTER &&
      rule.selector.startsWith('.k2b-ui .k2b-app-workspace__sidebar-item-actions[data-visibility="hover"]'),
  )
  .map((rule) => `${FINE_POINTER} { ${rule.selector} { ${rule.body} } }`)
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
