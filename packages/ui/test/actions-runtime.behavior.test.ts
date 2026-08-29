import { describe, expect, spyOn, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

const flush = async (): Promise<void> => {
  await Promise.resolve();
};

const installPopoverStub = (): void => {
  const openPopovers = new WeakSet<HTMLElement>();
  const prototype = HTMLElement.prototype as typeof HTMLElement.prototype & {
    showPopover?: () => void;
    hidePopover?: () => void;
  };
  const matches = prototype.matches;
  const dispatchToggle = (element: HTMLElement, oldState: "closed" | "open", newState: "closed" | "open") => {
    const event = new Event("toggle");
    Object.defineProperties(event, {
      oldState: { value: oldState },
      newState: { value: newState },
    });
    element.dispatchEvent(event);
  };

  prototype.matches = function (selector: string): boolean {
    return selector === ":popover-open" ? openPopovers.has(this) : matches.call(this, selector);
  };
  prototype.showPopover = function (): void {
    if (openPopovers.has(this)) return;
    openPopovers.add(this);
    dispatchToggle(this, "closed", "open");
  };
  prototype.hidePopover = function (): void {
    if (!openPopovers.delete(this)) return;
    dispatchToggle(this, "open", "closed");
  };
};

describe("@k2b/ui action runtime behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("keeps handlerless enhanced button links on native document navigation", async () => {
    const dom = createDomTestHarness();
    const { ButtonLink } = await import("../src/actions/Button");
    const pushState = spyOn(window.history, "pushState");
    const dispose = render(
      () =>
        createComponent(ButtonLink, {
          href: "/handlerless",
          navigation: "enhanced",
          children: "Handlerless",
        }),
      dom.root,
    );

    dom.root.querySelector<HTMLAnchorElement>('a[href="/handlerless"]')?.click();
    expect(pushState).not.toHaveBeenCalled();

    dispose();
    pushState.mockRestore();
    dom.cleanup();
  });

  test("scopes dropdown viewport listeners, closes actions, and reacts to disabled", async () => {
    const dom = createDomTestHarness();
    installPopoverStub();
    const { Dropdown } = await import("../src/actions/Dropdown");
    const addListener = spyOn(window, "addEventListener");
    const removeListener = spyOn(window, "removeEventListener");
    let setDisabled: (disabled: boolean) => void = () => {};
    let openDuringAction: boolean | undefined;

    const dispose = render(() => {
      const [disabled, updateDisabled] = createSignal(false);
      setDisabled = updateDisabled;
      return createComponent(Dropdown.Root, {
        get disabled() {
          return disabled();
        },
        items: [
          {
            label: "Rename",
            action: () => {
              openDuringAction = dom.root.querySelector<HTMLElement>(".k2b-dropdown__menu")?.matches(":popover-open");
            },
          },
        ],
        get children() {
          return createComponent(Dropdown.Trigger, { label: "Project actions", children: "Open" });
        },
      });
    }, dom.root);

    const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-dropdown__trigger");
    expect(trigger?.disabled).toBe(false);
    expect(trigger?.hasAttribute("tabindex")).toBe(false);
    expect(addListener.mock.calls.some(([type]) => type === "scroll" || type === "resize")).toBe(false);

    trigger?.click();
    await flush();
    expect(addListener.mock.calls.filter(([type]) => type === "scroll")).toHaveLength(1);
    expect(addListener.mock.calls.filter(([type]) => type === "resize")).toHaveLength(1);

    dom.root.querySelectorAll<HTMLButtonElement>("[role='menuitem']")[0]?.click();
    await flush();
    expect(openDuringAction).toBe(false);
    expect(removeListener.mock.calls.filter(([type]) => type === "scroll")).toHaveLength(1);
    expect(removeListener.mock.calls.filter(([type]) => type === "resize")).toHaveLength(1);

    setDisabled(true);
    expect(trigger?.disabled).toBe(true);
    expect(trigger?.tabIndex).toBe(-1);

    setDisabled(false);
    expect(trigger?.disabled).toBe(false);
    expect(trigger?.hasAttribute("tabindex")).toBe(false);

    dispose();
    addListener.mockRestore();
    removeListener.mockRestore();
    dom.cleanup();
  });

  test("keeps split button primary and menu actions independent", async () => {
    const dom = createDomTestHarness();
    installPopoverStub();
    const { SplitButton } = await import("../src/actions/SplitButton");
    let primaryCalls = 0;
    let draftCalls = 0;

    const dispose = render(
      () =>
        createComponent(SplitButton, {
          items: [{ label: "Save as draft", action: () => draftCalls++ }],
          menuLabel: "More send options",
          onClick: () => primaryCalls++,
          children: "Send",
        }),
      dom.root,
    );

    dom.root.querySelector<HTMLButtonElement>(".k2b-split-button__primary")?.click();
    expect(primaryCalls).toBe(1);
    expect(draftCalls).toBe(0);

    const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-split-button__menu-trigger");
    trigger?.click();
    await flush();
    expect(primaryCalls).toBe(1);
    expect(dom.root.querySelector<HTMLElement>(".k2b-dropdown__menu")?.matches(":popover-open")).toBe(true);

    dom.root.querySelector<HTMLButtonElement>("[role='menuitem']")?.click();
    await flush();
    expect(primaryCalls).toBe(1);
    expect(draftCalls).toBe(1);

    dispose();
    dom.cleanup();
  });

  test("switches a DropdownItem reactively between a disabled button and link", async () => {
    const dom = createDomTestHarness();
    const { DropdownItem } = await import("../src/actions/Dropdown");
    let setDisabled: (disabled: boolean) => void = () => {};
    let setHref: (href: string | undefined) => void = () => {};

    const dispose = render(() => {
      const [disabled, updateDisabled] = createSignal(false);
      const [href, updateHref] = createSignal<string | undefined>("/docs");
      setDisabled = updateDisabled;
      setHref = updateHref;
      return createComponent(DropdownItem, {
        get disabled() {
          return disabled();
        },
        get href() {
          return href();
        },
        children: "Documentation",
      });
    }, dom.root);

    expect(dom.root.querySelector("a")?.getAttribute("href")).toBe("/docs");
    setDisabled(true);
    expect(dom.root.querySelector("a")).toBeNull();
    expect(dom.root.querySelector("button")?.disabled).toBe(true);

    setDisabled(false);
    expect(dom.root.querySelector("a")?.getAttribute("href")).toBe("/docs");
    setHref(undefined);
    expect(dom.root.querySelector("a")).toBeNull();
    expect(dom.root.querySelector("button")?.disabled).toBe(false);

    dispose();
    dom.cleanup();
  });

  test("keeps DetailPanel destination and overflow actions independent", async () => {
    const dom = createDomTestHarness();
    installPopoverStub();
    const { default: DetailPanel } = await import("../src/layout/DetailPanel");
    let destinationCalls = 0;
    let menuCalls = 0;

    const dispose = render(
      () =>
        createComponent(DetailPanel.Action, {
          href: "/contacts/Contact01",
          target: "_blank",
          rel: "noopener noreferrer",
          title: "Ada Lovelace",
          menuLabel: "More actions for Ada Lovelace",
          menuItems: [{ label: "Related Mail", action: () => menuCalls++ }],
          onClick: (event) => {
            event.preventDefault();
            destinationCalls++;
          },
        }),
      dom.root,
    );

    const destination = dom.root.querySelector<HTMLAnchorElement>(".k2b-detail-panel__action");
    const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-detail-panel__action-menu-trigger");
    expect(destination?.contains(trigger ?? null)).toBe(false);
    expect(destination?.target).toBe("_blank");
    expect(destination?.rel).toBe("noopener noreferrer");

    trigger?.click();
    await flush();
    dom.root.querySelector<HTMLButtonElement>("[role='menuitem']")?.click();
    await flush();
    expect(menuCalls).toBe(1);
    expect(destinationCalls).toBe(0);

    destination?.click();
    expect(destinationCalls).toBe(1);

    dispose();
    dom.cleanup();
  });

  test("keeps explicit checkbox choices open when requested", async () => {
    const dom = createDomTestHarness();
    installPopoverStub();
    const { Dropdown } = await import("../src/actions/Dropdown");
    const [checked, setChecked] = createSignal(false);

    const dispose = render(
      () =>
        createComponent(Dropdown.Root, {
          items: [
            {
              label: "Pinned",
              choice: "checkbox",
              get checked() {
                return checked();
              },
              closeOnSelect: false,
              action: () => setChecked((value) => !value),
            },
          ],
          get children() {
            return createComponent(Dropdown.Trigger, { label: "Edit project", children: "Edit" });
          },
        }),
      dom.root,
    );

    const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-dropdown__trigger");
    trigger?.click();
    await flush();

    const choice = dom.root.querySelector<HTMLButtonElement>("[role='menuitemcheckbox']");
    choice?.click();
    await flush();
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(choice?.getAttribute("aria-checked")).toBe("true");

    dispose();
    dom.cleanup();
  });

  test("restores trigger focus when Escape closes a dropdown", async () => {
    const dom = createDomTestHarness();
    installPopoverStub();
    const { Dropdown } = await import("../src/actions/Dropdown");

    const dispose = render(
      () =>
        createComponent(Dropdown.Root, {
          items: [{ label: "Rename", action: () => {} }],
          get children() {
            return createComponent(Dropdown.Trigger, { label: "Project actions", children: "Open" });
          },
        }),
      dom.root,
    );

    const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-dropdown__trigger");
    trigger?.click();
    await flush();
    const menu = dom.root.querySelector<HTMLElement>(".k2b-dropdown__menu");
    const keyDown = (menu as unknown as { $$keydown?: (event: KeyboardEvent) => void })?.$$keydown;
    keyDown?.(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await flush();

    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(dom.document.activeElement).toBe(trigger ?? null);

    dispose();
    dom.cleanup();
  });

  test("keeps FilterChip option identity and exposes live checkbox and radio state", async () => {
    const dom = createDomTestHarness();
    installPopoverStub();
    const { FilterChip } = await import("../src/actions/FilterChip");
    const changes: string[][] = [];
    let acceptChanges = false;

    const dispose = render(() => {
      const [value, setValue] = createSignal<readonly string[]>([]);
      return createComponent(FilterChip, {
        label: "State",
        icon: "ti ti-filter",
        get value() {
          return value();
        },
        onValueChange: (nextValue) => {
          changes.push(nextValue);
          if (acceptChanges) setValue(nextValue);
        },
        options: [
          {
            label: "State",
            options: [
              { value: "open", label: "Open" },
              { value: "closed", label: "Closed" },
            ],
          },
          {
            label: "Flags",
            multiple: true,
            options: [{ value: "urgent", label: "Urgent" }],
          },
        ],
      });
    }, dom.root);

    dom.root.querySelector<HTMLElement>(".k2b-filter-chip")?.click();
    await flush();

    const radio = dom.root.querySelector<HTMLButtonElement>("[role='menuitemradio']");
    const checkbox = dom.root.querySelector<HTMLButtonElement>("[role='menuitemcheckbox']");
    expect(radio?.getAttribute("aria-checked")).toBe("false");
    expect(checkbox?.getAttribute("aria-checked")).toBe("false");
    expect(checkbox?.querySelector("input")).toBeNull();

    checkbox?.focus();
    const originalCheckbox = checkbox;
    checkbox?.click();
    expect(changes).toEqual([["urgent"]]);
    expect(dom.document.activeElement).toBe(originalCheckbox);
    expect(dom.root.querySelector("[role='menuitemcheckbox']")).toBe(originalCheckbox);
    expect(originalCheckbox?.getAttribute("aria-checked")).toBe("false");

    acceptChanges = true;
    originalCheckbox?.click();
    expect(changes).toEqual([["urgent"], ["urgent"]]);
    expect(originalCheckbox?.getAttribute("aria-checked")).toBe("true");

    const menu = dom.root.querySelector<HTMLElement>(".k2b-dropdown__menu");
    const menuKeyDown = (menu as unknown as { $$keydown?: (event: KeyboardEvent) => void })?.$$keydown;
    expect(menuKeyDown).toBeFunction();
    menuKeyDown?.(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
    expect(dom.document.activeElement).toBe(dom.root.querySelectorAll("[role='menuitemradio']")[1] ?? null);

    originalCheckbox?.focus();
    originalCheckbox?.click();
    expect(changes).toEqual([["urgent"], ["urgent"], []]);
    expect(dom.document.activeElement).toBe(originalCheckbox);
    expect(originalCheckbox?.getAttribute("aria-checked")).toBe("false");

    dispose();
    dom.cleanup();
  });

  test("exposes SelectChip selection as a radio menu without rebuilding its rows", async () => {
    const dom = createDomTestHarness();
    installPopoverStub();
    const { SelectChip } = await import("../src/inputs/SelectChip");
    let openDuringChange: boolean | undefined;

    const dispose = render(() => {
      const [value, updateValue] = createSignal("comfortable");
      return createComponent(SelectChip, {
        "aria-label": "Density",
        value,
        icon: "ti ti-adjustments",
        iconOnly: true,
        onValueChange: (nextValue: string) => {
          openDuringChange = dom.root.querySelector<HTMLElement>(".k2b-dropdown__menu")?.matches(":popover-open");
          updateValue(nextValue);
        },
        options: [
          { value: "compact", label: "Compact" },
          { value: "comfortable", label: "Comfortable" },
          { value: "disabled", label: "Disabled", disabled: true },
        ],
      });
    }, dom.root);

    const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-dropdown__trigger");
    trigger?.click();
    await flush();
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    const options = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']"));
    expect(options.map((option) => option.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(options[2]?.disabled).toBe(true);

    const compact = options[0];
    compact?.click();
    expect(dom.root.querySelectorAll("[role='menuitemradio']")[0]).toBe(compact);
    expect(compact?.getAttribute("aria-checked")).toBe("true");
    expect(openDuringChange).toBe(false);
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    dispose();
    dom.cleanup();
  });

  test("attaches ContextMenu globals only while open and ignores menu scroll", async () => {
    const dom = createDomTestHarness();
    const extraGlobals = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of [
      ["DOMRect", dom.window.DOMRect],
      ["HTMLHeadElement", dom.window.HTMLHeadElement],
    ] as const) {
      extraGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value,
      });
    }
    const { ContextMenu } = await import("../src/actions/ContextMenu");
    const windowAdd = spyOn(window, "addEventListener");
    const windowRemove = spyOn(window, "removeEventListener");
    const documentAdd = spyOn(document, "addEventListener");
    const documentRemove = spyOn(document, "removeEventListener");

    const dispose = render(
      () =>
        createComponent(ContextMenu, {
          label: "File actions",
          items: [{ label: "Rename", action: () => {} }],
          children: "README.md",
        }),
      dom.root,
    );

    const host = dom.root.querySelector<HTMLElement>("[role='group']");
    expect(host?.getAttribute("aria-label")).toBe("File actions");
    expect(host?.getAttribute("aria-haspopup")).toBe("menu");
    expect(host?.getAttribute("aria-expanded")).toBe("false");
    expect(windowAdd.mock.calls.some(([type]) => type === "scroll" || type === "resize")).toBe(false);
    expect(documentAdd.mock.calls.some(([type]) => type === "pointerdown")).toBe(false);

    const contextMenuEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 24,
      clientY: 32,
    });
    const contextMenuHandler = (host as unknown as { $$contextmenu?: (event: MouseEvent) => void })?.$$contextmenu;
    expect(contextMenuHandler).toBeFunction();
    contextMenuHandler?.(contextMenuEvent);
    await flush();

    const menuId = host?.getAttribute("aria-controls");
    const menu = menuId ? dom.document.getElementById(menuId) : null;
    expect(menu?.getAttribute("role")).toBe("menu");
    expect(host?.getAttribute("aria-expanded")).toBe("true");
    expect(windowAdd.mock.calls.filter(([type]) => type === "scroll")).toHaveLength(1);
    expect(windowAdd.mock.calls.filter(([type]) => type === "resize")).toHaveLength(1);
    expect(documentAdd.mock.calls.filter(([type]) => type === "pointerdown")).toHaveLength(1);

    menu?.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(host?.getAttribute("aria-expanded")).toBe("true");
    expect(dom.document.getElementById(menuId ?? "")).toBe(menu);

    window.dispatchEvent(new Event("scroll"));
    expect(host?.getAttribute("aria-expanded")).toBe("false");
    expect(windowRemove.mock.calls.filter(([type]) => type === "scroll")).toHaveLength(1);
    expect(windowRemove.mock.calls.filter(([type]) => type === "resize")).toHaveLength(1);
    expect(documentRemove.mock.calls.filter(([type]) => type === "pointerdown")).toHaveLength(1);

    dispose();
    windowAdd.mockRestore();
    windowRemove.mockRestore();
    documentAdd.mockRestore();
    documentRemove.mockRestore();
    for (const [name, descriptor] of extraGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.cleanup();
  });
});
