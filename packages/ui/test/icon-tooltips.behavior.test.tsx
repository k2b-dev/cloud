import { describe, expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

/** happy-dom has no Popover API; model the open state on the element. */
const installPopover = (dom: DomTestHarness) => {
  const prototype = dom.window.HTMLElement.prototype as unknown as HTMLElement;
  const matches = prototype.matches;
  prototype.showPopover = function (this: HTMLElement) {
    this.dataset.testPopoverOpen = "true";
  };
  prototype.hidePopover = function (this: HTMLElement) {
    delete this.dataset.testPopoverOpen;
  };
  // `matches` declares type-predicate overloads; the stub only answers the runtime string form.
  Object.defineProperty(prototype, "matches", {
    configurable: true,
    writable: true,
    value(this: HTMLElement, selector: string): boolean {
      return selector === ":popover-open" ? this.dataset.testPopoverOpen === "true" : matches.call(this, selector);
    },
  });
};

const pointer = (dom: DomTestHarness, target: Element, type: string, pointerType: "mouse" | "touch") =>
  target.dispatchEvent(new dom.window.PointerEvent(type, { pointerType }) as unknown as Event);

const isOpen = (surface: Element | null | undefined) => surface?.matches(":popover-open") ?? false;

describe("icon-only controls", () => {
  if (isServer) {
    test.skip("requires browser conditions", () => {});
    return;
  }

  /** Components are imported after the document exists: some modules delegate events on load. */
  const setup = () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    installPopover(dom);
    return dom;
  };
  const mount = (dom: DomTestHarness, view: () => unknown) => {
    const dispose = render(view as () => Element, dom.root);
    return {
      dom,
      done: () => {
        dispose();
        dom.cleanup();
      },
    };
  };

  test("IconButton shows its label as a tooltip on hover and keyboard focus, not on touch", async () => {
    const harness = setup();
    const { IconButton } = await import("../src/actions/Button");
    const { dom, done } = mount(harness, () => (
      <IconButton label="Zoom in" tooltipDelay={0}>
        <i class="ti ti-plus" aria-hidden="true" />
      </IconButton>
    ));
    const button = dom.root.querySelector<HTMLButtonElement>("button")!;
    const surface = dom.root.querySelector<HTMLElement>('[role="tooltip"]');

    expect(surface?.textContent).toBe("Zoom in");
    expect(button.getAttribute("aria-label")).toBe("Zoom in");
    // The hydrated tooltip replaces the native title, and a hint that repeats
    // the accessible name does not become a second description.
    expect(button.hasAttribute("title")).toBe(false);
    expect(button.hasAttribute("aria-describedby")).toBe(false);

    pointer(dom, button, "pointerenter", "mouse");
    expect(isOpen(surface)).toBe(true);
    pointer(dom, button, "pointerleave", "mouse");
    expect(isOpen(surface)).toBe(false);

    // A tap gives no hover hint.
    pointer(dom, button, "pointerenter", "touch");
    expect(isOpen(surface)).toBe(false);
    pointer(dom, button, "pointerdown", "touch");
    pointer(dom, button, "pointerleave", "touch");
    // Focus without a ring, as after a tap or when a closing menu returns it silently, opens nothing.
    button.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }) as unknown as Event);
    expect(isOpen(surface)).toBe(false);

    // Visible keyboard focus opens it.
    button.focus();
    expect(button.matches(":focus-visible")).toBe(true);
    expect(isOpen(surface)).toBe(true);
    done();
  });

  test("an explicit tooltip that adds information describes the control", async () => {
    const harness = setup();
    const { IconButton } = await import("../src/actions/Button");
    const { dom, done } = mount(harness, () => (
      <IconButton label="Remove the key of Mara Beispiel" tooltip="Remove key">
        <i class="ti ti-trash" aria-hidden="true" />
      </IconButton>
    ));
    const button = dom.root.querySelector<HTMLButtonElement>("button")!;
    const surface = dom.root.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(surface.textContent).toBe("Remove key");
    expect(button.getAttribute("aria-describedby")).toBe(surface.id);
    done();
  });

  test("tooltip={false} opts out, and an enclosing Tooltip.Anchor owns the only hint", async () => {
    const harness = setup();
    const { IconButton } = await import("../src/actions/Button");
    const { Tooltip } = await import("../src/feedback/Tooltip");
    const { dom, done } = mount(harness, () => (
      <>
        <IconButton label="Quiet" tooltip={false}>
          <i class="ti ti-x" aria-hidden="true" />
        </IconButton>
        <Tooltip.Anchor content="Anchored hint">
          <IconButton label="Anchored">
            <i class="ti ti-x" aria-hidden="true" />
          </IconButton>
        </Tooltip.Anchor>
      </>
    ));
    const tooltips = Array.from(dom.root.querySelectorAll('[role="tooltip"]')).map((surface) => surface.textContent);
    expect(tooltips).toEqual(["Anchored hint"]);
    for (const button of Array.from(dom.root.querySelectorAll("button"))) expect(button.hasAttribute("title")).toBe(false);
    done();
  });

  test("icon-only dropdown triggers and filter chips show their label", async () => {
    const harness = setup();
    const { Dropdown } = await import("../src/actions/Dropdown");
    const { FilterChip } = await import("../src/actions/FilterChip");
    const { dom, done } = mount(harness, () => (
      <>
        <Dropdown.Root label="View" items={[{ label: "List", action: () => {} }]}>
          <Dropdown.Trigger iconOnly label="Choose list view">
            <i class="ti ti-layout-list" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
        <Dropdown.Root label="Text" items={[{ label: "List", action: () => {} }]}>
          <Dropdown.Trigger label="Sort">Sort</Dropdown.Trigger>
        </Dropdown.Root>
        <FilterChip label="Search in: subject" icon="ti ti-filter" iconOnly options={[]} value={[]} onValueChange={() => {}} />
      </>
    ));
    const tooltips = Array.from(dom.root.querySelectorAll('[role="tooltip"]')).map((surface) => surface.textContent);
    expect(tooltips).toEqual(["Choose list view", "Search in: subject"]);
    done();
  });

  test("zoom-pan controls name their key in the tooltip", async () => {
    const harness = setup();
    const { ZoomPanViewport } = await import("../src/content/ZoomPanViewport");
    const { dom, done } = mount(harness, () => (
      <ZoomPanViewport label="Diagram" fullscreen={{ title: "Diagram", content: () => <span /> }}>
        <span>Node</span>
      </ZoomPanViewport>
    ));
    const controls = Array.from(dom.root.querySelectorAll<HTMLButtonElement>(".k2b-zoom-pan__controls button"));
    expect(controls.map((button) => button.getAttribute("aria-label"))).toEqual(["Zoom in", "Zoom out", "Reset zoom", "Open fullscreen"]);
    expect(controls.map((button) => dom.document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent)).toEqual([
      "Zoom in (+)",
      "Zoom out (-)",
      "Reset zoom (0)",
      "Open fullscreen (F)",
    ]);
    for (const button of controls) expect(button.hasAttribute("title")).toBe(false);
    done();
  });
});
