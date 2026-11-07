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

  // `matches` declares type-predicate overloads; the stub only answers the runtime string form.
  Object.defineProperty(prototype, "matches", {
    configurable: true,
    writable: true,
    value(this: HTMLElement, selector: string): boolean {
      return selector === ":popover-open" ? openPopovers.has(this) : matches.call(this, selector);
    },
  });
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

  test("a lazy dropdown renders its entries when it first opens, then focuses the first one", async () => {
    const dom = createDomTestHarness();
    installPopoverStub();
    const { Dropdown } = await import("../src/actions/Dropdown");
    const dispose = render(
      () =>
        createComponent(Dropdown.Root, {
          lazy: true,
          items: [
            { label: "Rename", action: () => {} },
            { label: "Delete", action: () => {} },
          ],
          get children() {
            return createComponent(Dropdown.Trigger, { label: "Row actions", children: "More" });
          },
        }),
      dom.root,
    );
    const menu = () => dom.root.querySelector<HTMLElement>(".k2b-dropdown__menu");
    expect(menu()?.querySelectorAll("[role='menuitem']")).toHaveLength(0);
    // The trigger still names its menu, so assistive technology finds what it opens.
    expect(dom.root.querySelector(".k2b-dropdown__trigger")?.getAttribute("aria-controls")).toBe(menu()?.id);

    dom.root.querySelector<HTMLButtonElement>(".k2b-dropdown__trigger")?.click();
    await flush();
    const items = [...(menu()?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
    expect(items.map((item) => item.textContent)).toEqual(["Rename", "Delete"]);
    expect(document.activeElement).toBe(items[0] ?? null);

    // Closed again, the entries stay, so a second opening is as quick as any menu's.
    items[0]?.click();
    await flush();
    expect(menu()?.querySelectorAll("[role='menuitem']")).toHaveLength(2);
    dispose();
    dom.cleanup();
  });

  test("runs a link row's action on a plain click and leaves modified clicks to the link", async () => {
    const dom = createDomTestHarness();
    installPopoverStub();
    const { Dropdown } = await import("../src/actions/Dropdown");
    const opened: string[] = [];
    const dispose = render(
      () =>
        createComponent(Dropdown.Root, {
          items: [
            { label: "Weekly review", href: "/events/review", action: () => opened.push("review") },
            { label: "Docs", href: "/docs" },
          ],
          get children() {
            return createComponent(Dropdown.Trigger, { label: "More", children: "+2" });
          },
        }),
      dom.root,
    );
    const click = (link: HTMLAnchorElement, modifiers: { ctrlKey?: boolean } = {}) => {
      const event = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers }) as unknown as MouseEvent;
      link.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const menu = () => dom.root.querySelector<HTMLElement>(".k2b-dropdown__menu");
    const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-dropdown__trigger")!;

    trigger.click();
    await flush();
    const review = dom.root.querySelector<HTMLAnchorElement>('a[href="/events/review"]')!;
    expect(click(review)).toBe(true);
    expect(opened).toEqual(["review"]);
    expect(menu()?.matches(":popover-open")).toBe(false);

    trigger.click();
    await flush();
    expect(click(review, { ctrlKey: true })).toBe(false);
    expect(click(dom.root.querySelector<HTMLAnchorElement>('a[href="/docs"]')!)).toBe(false);
    expect(opened).toEqual(["review"]);

    dispose();
    dom.cleanup();
  });

  test("choice links keep selection semantics, native modified clicks and row focus", async () => {
    const dom = createDomTestHarness();
    const { DropdownItems } = await import("../src/actions/Dropdown");
    const { focusRowSegment } = await import("../src/actions/menu-rows");
    const closed: (boolean | undefined)[] = [];
    const selected: string[] = [];
    const dispose = render(
      () =>
        createComponent(DropdownItems, {
          close: (restoreFocus) => closed.push(restoreFocus),
          items: [
            {
              sectionLabel: "Open as",
              layout: "row",
              items: [
                { label: "Edit", choice: "radio", checked: true, href: "/edit", action: () => selected.push("edit") },
                { label: "Read", choice: "radio", checked: false, href: "/read", action: () => selected.push("read") },
                { label: "Book", choice: "radio", checked: false, action: () => selected.push("book") },
              ],
            },
            {
              label: "Pinned",
              choice: "checkbox",
              checked: true,
              href: "/pinned",
              closeOnSelect: false,
              action: () => selected.push("pinned"),
            },
            { label: "Unavailable", choice: "radio", checked: false, href: "/disabled", disabled: true, action: () => {} },
          ],
        }),
      dom.root,
    );
    try {
      const edit = dom.root.querySelector<HTMLAnchorElement>('a[href="/edit"]')!;
      const read = dom.root.querySelector<HTMLAnchorElement>('a[href="/read"]')!;
      const pinned = dom.root.querySelector<HTMLAnchorElement>('a[href="/pinned"]')!;
      expect(edit.getAttribute("role")).toBe("menuitemradio");
      expect(edit.getAttribute("aria-checked")).toBe("true");
      expect(read.getAttribute("aria-checked")).toBe("false");
      expect(pinned.getAttribute("role")).toBe("menuitemcheckbox");
      expect(pinned.getAttribute("aria-checked")).toBe("true");
      expect(dom.root.querySelector('a[href="/disabled"]')).toBeNull();
      expect(dom.root.querySelector("button[disabled]")?.getAttribute("aria-disabled")).toBe("true");
      const click = (link: HTMLAnchorElement, modifiers: MouseEventInit = {}, type = "click") => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...modifiers });
        link.dispatchEvent(event);
        return event.defaultPrevented;
      };
      expect(click(read)).toBe(true);
      expect(selected).toEqual(["read"]);
      expect(closed).toEqual([undefined]);
      expect(click(pinned)).toBe(true);
      expect(selected).toEqual(["read", "pinned"]);
      expect(closed).toEqual([undefined]);
      for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
        expect(click(read, modifiers)).toBe(false);
      }
      expect(selected).toEqual(["read", "pinned"]);
      expect(closed).toEqual([undefined, false, false, false, false]);
      expect(click(read, { button: 1 }, "auxclick")).toBe(false);
      expect(selected).toEqual(["read", "pinned"]);
      // Space chooses a link-backed choice, as it does the button form, instead of scrolling the page.
      const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
      read.dispatchEvent(space);
      expect(space.defaultPrevented).toBe(true);
      expect(selected).toEqual(["read", "pinned", "read"]);
      const segments = Array.from(dom.root.querySelectorAll<HTMLElement>(".k2b-dropdown__row > [role='menuitemradio']"));
      edit.focus();
      expect(focusRowSegment(segments, "ArrowRight")).toBe(true);
      expect(dom.document.activeElement).toBe(read);
      focusRowSegment(segments, "ArrowRight");
      expect(dom.document.activeElement).toBe(segments[2] ?? null);
      focusRowSegment(segments, "ArrowRight");
      expect(dom.document.activeElement).toBe(edit);
      focusRowSegment(segments, "ArrowLeft");
      expect(dom.document.activeElement).toBe(segments[2] ?? null);
    } finally {
      dispose();
      dom.cleanup();
    }
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

  test("keeps an action open when requested and updates its row in place", async () => {
    const dom = createDomTestHarness();
    installPopoverStub();
    const { Dropdown } = await import("../src/actions/Dropdown");
    const [light, setLight] = createSignal(false);
    const item = {
      get label() {
        return light() ? "Light" : "Automatic";
      },
      get icon() {
        return light() ? "ti ti-sun-high" : "ti ti-device-laptop";
      },
      get ariaLabel() {
        return light() ? "Appearance: Light. Switches to Dark." : "Appearance: Automatic. Switches to Light.";
      },
      closeOnSelect: false,
      action: () => setLight(true),
    };
    const dispose = render(
      () =>
        createComponent(Dropdown.Root, {
          items: [item, { label: "Done", action: () => {} }],
          get children() {
            return createComponent(Dropdown.Trigger, { label: "Preferences", children: "Open" });
          },
        }),
      dom.root,
    );
    try {
      const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-dropdown__trigger")!;
      trigger.click();
      await flush();
      const button = dom.root.querySelector<HTMLButtonElement>("[role='menuitem']")!;
      expect(button.textContent).toBe("Automatic");
      expect(button.querySelector("i")?.className).toBe("ti ti-device-laptop");
      expect(button.getAttribute("aria-label")).toBe("Appearance: Automatic. Switches to Light.");
      button.focus();
      button.click();
      await flush();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(dom.root.querySelector("[role='menuitem']")).toBe(button);
      expect(button.textContent).toBe("Light");
      expect(button.querySelector("i")?.className).toBe("ti ti-sun-high");
      expect(button.getAttribute("aria-label")).toBe("Appearance: Light. Switches to Dark.");
      expect(document.activeElement).toBe(button);
      dom.root.querySelectorAll<HTMLButtonElement>("[role='menuitem']")[1]!.click();
      await flush();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    } finally {
      dispose();
      dom.cleanup();
    }
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

  test("moves the focus into a controlled menu that a key on its trigger opened, and keeps it on a programmatic open", async () => {
    const dom = createDomTestHarness();
    installPopoverStub();
    const { Dropdown } = await import("../src/actions/Dropdown");
    const [open, setOpen] = createSignal(false);

    const dispose = render(
      () =>
        createComponent(Dropdown.Root, {
          get open() {
            return open();
          },
          onOpenChange: setOpen,
          items: [
            { label: "Rename", action: () => {} },
            { label: "Archive", action: () => {} },
          ],
          get children() {
            return createComponent(Dropdown.Trigger, { label: "Project actions", children: "Open" });
          },
        }),
      dom.root,
    );

    const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-dropdown__trigger")!;
    const items = () => Array.from(dom.root.querySelectorAll<HTMLButtonElement>("[role='menuitem']"));
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
    await flush();
    expect(open()).toBe(true);
    expect(dom.document.activeElement).toBe(items()[0] ?? null);

    setOpen(false);
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowUp" }));
    await flush();
    expect(dom.document.activeElement).toBe(items()[1] ?? null);

    // The owner opening it keeps the focus where it is.
    setOpen(false);
    trigger.focus();
    setOpen(true);
    await flush();
    expect(dom.document.activeElement).toBe(trigger);

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

  test("lays a FilterChip row section out as segments that keep one choice and follow the arrow keys", async () => {
    const dom = createDomTestHarness();
    installPopoverStub();
    const { FilterChip } = await import("../src/actions/FilterChip");
    const changes: string[][] = [];

    const dispose = render(() => {
      const [value, setValue] = createSignal<readonly string[]>(["scope:all", "sort:asc"]);
      return createComponent(FilterChip, {
        label: "View",
        icon: "ti ti-filter",
        get value() {
          return value();
        },
        defaultValue: ["scope:all", "sort:asc"],
        onValueChange: (nextValue) => {
          changes.push(nextValue);
          setValue(nextValue);
        },
        options: [
          {
            label: "Scope",
            options: [
              { value: "scope:all", label: "All" },
              { value: "scope:mine", label: "Mine" },
            ],
          },
          {
            label: "Sort",
            layout: "row",
            options: [
              { value: "sort:asc", label: "Ascending" },
              { value: "sort:desc", label: "Descending" },
            ],
          },
        ],
      });
    }, dom.root);

    dom.root.querySelector<HTMLElement>(".k2b-filter-chip")?.click();
    await flush();

    const segments = Array.from(dom.root.querySelectorAll<HTMLButtonElement>(".k2b-dropdown__row > [role='menuitemradio']"));
    expect(segments.map((segment) => segment.textContent)).toEqual(["Ascending", "Descending"]);
    expect(dom.root.querySelector(".k2b-dropdown__row")?.closest("[role='group']")?.getAttribute("aria-label")).toBe("Sort");

    // The selected segment stays selected; another one replaces it.
    segments[0]?.click();
    expect(changes).toEqual([]);
    segments[1]?.click();
    expect(changes).toEqual([["scope:all", "sort:desc"]]);
    expect(segments[1]?.getAttribute("aria-checked")).toBe("true");

    const menu = dom.root.querySelector<HTMLElement>(".k2b-dropdown__menu");
    const menuKeyDown = (menu as unknown as { $$keydown?: (event: KeyboardEvent) => void })?.$$keydown;
    segments[1]?.focus();
    menuKeyDown?.(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    expect(dom.document.activeElement).toBe(segments[0] ?? null);
    menuKeyDown?.(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    expect(dom.document.activeElement).toBe(segments[1] ?? null);
    // Up leaves the row for the item above it, as in any menu.
    menuKeyDown?.(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
    expect(dom.document.activeElement).toBe(segments[0] ?? null);
    menuKeyDown?.(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
    expect(dom.document.activeElement?.textContent).toBe("Mine");

    dispose();
    dom.cleanup();
  });

  test("offers Only per row and All or None per section, keeps notes, and shows the chosen colors", async () => {
    const dom = createDomTestHarness();
    installPopoverStub();
    const { FilterChip } = await import("../src/actions/FilterChip");
    const changes: string[][] = [];

    const dispose = render(() => {
      const [value, setValue] = createSignal<readonly string[]>(["a:1", "b:1", "sort:asc"]);
      return createComponent(FilterChip, {
        label: "Calendars",
        icon: "ti ti-calendar",
        only: true,
        swatches: true,
        get value() {
          return value();
        },
        onValueChange: (nextValue) => {
          changes.push(nextValue);
          setValue(nextValue);
        },
        options: [
          {
            label: "App A",
            multiple: true,
            toggleAll: true,
            options: [
              { value: "a:1", label: "Team", color: "#8b5cf6" },
              { value: "a:2", label: "Board", color: "#3b82f6", trailing: createComponent(() => "busy only", {}) },
            ],
          },
          { label: "App B", multiple: true, toggleAll: true, options: [{ value: "b:1", label: "Holidays", color: "#dc2626" }] },
          { label: "Sort", options: [{ value: "sort:asc", label: "Ascending" }] },
        ],
      });
    }, dom.root);

    // The trigger shows the colors of the chosen options in the place of its icon.
    const dots = Array.from(dom.root.querySelectorAll<HTMLElement>(".k2b-filter-chip__swatches > .k2b-filter-chip__dot"));
    expect(dots.map((dot) => dot.style.getPropertyValue("--k2b-filter-color"))).toEqual(["#8b5cf6", "#dc2626"]);
    expect(dom.root.querySelector(".k2b-filter-chip > i.ti-calendar")).toBeNull();

    dom.root.querySelector<HTMLElement>(".k2b-filter-chip")?.click();
    await flush();
    expect(dom.document.body.textContent).toContain("busy only");

    // Only keeps that option among the multiple sections and the single-select choice.
    const only = dom.document.querySelector<HTMLButtonElement>('.k2b-dropdown__secondary[aria-label="Only Holidays"]');
    expect(only?.getAttribute("role")).toBe("menuitem");
    only?.click();
    expect(changes.at(-1)).toEqual(["sort:asc", "b:1"]);

    // All chooses the whole section; once all are chosen it offers None.
    const all = dom.document.querySelector<HTMLButtonElement>('.k2b-dropdown__label-action[aria-label="Choose all of App A"]');
    expect(all?.textContent).toBe("All");
    all?.click();
    expect(changes.at(-1)).toEqual(["sort:asc", "b:1", "a:1", "a:2"]);
    await flush();
    const none = dom.document.querySelector<HTMLButtonElement>('.k2b-dropdown__label-action[aria-label="Choose none of App A"]');
    expect(none?.textContent).toBe("None");
    none?.click();
    expect(changes.at(-1)).toEqual(["sort:asc", "b:1"]);

    // Up and Down move from row to row; Right reaches the row's Only, Down from there goes on to the next row.
    const menu = dom.document.querySelector<HTMLElement>(".k2b-dropdown__menu");
    const menuKeyDown = (menu as unknown as { $$keydown?: (event: KeyboardEvent) => void })?.$$keydown;
    const rows = Array.from(dom.document.querySelectorAll<HTMLButtonElement>(".k2b-dropdown__pair > [role='menuitemcheckbox']"));
    rows[0]?.focus();
    menuKeyDown?.(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    expect(dom.document.activeElement?.getAttribute("aria-label")).toBe("Only Team");
    menuKeyDown?.(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    expect(dom.document.activeElement).toBe(rows[1] ?? null);

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

  test.each(["disabled", "loading"] as const)("a %s SelectChip stays closed when its owner opens it", async (state) => {
    const dom = createDomTestHarness();
    installPopoverStub();
    const { SelectChip } = await import("../src/inputs/SelectChip");
    const changes: string[] = [];

    const dispose = render(
      () =>
        createComponent(SelectChip, {
          "aria-label": "Model",
          value: "a",
          open: true,
          onOpenChange: () => {},
          [state]: true,
          onValueChange: (value: string) => changes.push(value),
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
        }),
      dom.root,
    );
    await flush();

    const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-dropdown__trigger");
    expect(trigger?.disabled).toBe(true);
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(dom.root.querySelector<HTMLElement>(".k2b-dropdown__menu")?.matches(":popover-open")).toBe(false);
    expect(changes).toEqual([]);

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
