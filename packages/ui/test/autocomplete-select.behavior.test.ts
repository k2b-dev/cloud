import { describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { AutocompleteSelectSearchResult } from "../src/inputs/AutocompleteSelect";
import { createDomTestHarness, type DomTestHarness } from "./dom";

const installPopoverApi = (dom: DomTestHarness) => {
  const prototype = dom.window.HTMLElement.prototype as unknown as HTMLElement;
  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const open = new WeakSet<Element>();
  const patch = (key: PropertyKey, value: unknown) => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(prototype, key));
    Object.defineProperty(prototype, key, { configurable: true, writable: true, value });
  };
  const matches = prototype.matches;
  patch("matches", function (this: Element, selector: string) {
    return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
  });
  patch("showPopover", function (this: HTMLElement) {
    open.add(this);
  });
  patch("hidePopover", function (this: HTMLElement) {
    open.delete(this);
  });
  patch("scrollIntoView", () => {});
  return () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(prototype, key, descriptor);
      else Reflect.deleteProperty(prototype, key);
    }
  };
};

const setSolidInputValue = (input: HTMLInputElement, value: string) => {
  input.value = value;
  const handler = (input as HTMLInputElement & { $$input?: (event: { currentTarget: HTMLInputElement }) => void }).$$input;
  if (!handler) throw new Error("Solid input handler is not installed");
  handler({ currentTarget: input });
};

describe("AutocompleteSelect browser behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("selects the current display on keyboard focus and restores its snapshot with Escape", async () => {
    const dom = createDomTestHarness();
    const restorePopover = installPopoverApi(dom);
    const [value, setValue] = createSignal<string | null>("551");
    const { AutocompleteSelect } = await import("../src/inputs/AutocompleteSelect");
    const dispose = render(
      () =>
        createComponent(AutocompleteSelect, {
          label: "Category",
          value,
          onValueChange: setValue,
          selectedOption: { value: "551", label: "Paintings" },
          formatValue: (option) => `${option.value} — ${option.label}`,
          debounceMs: 0,
          search: async () => ({ options: [] }),
        }),
      dom.root,
    );

    const input = dom.root.querySelector<HTMLInputElement>('[role="combobox"]')!;
    input.focus();
    await Promise.resolve();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "551 — Paintings".length]);

    setValue("553");
    await Promise.resolve();
    expect(input.value).toBe("553 — 553");

    setSolidInputValue(input, "552");
    expect(value()).toBeNull();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(value()).toBe("553");
    expect(input.value).toBe("553 — 553");

    dispose();
    restorePopover();
    dom.cleanup();
  });

  test("shows inline completion and commits only the authoritative match on Tab", async () => {
    const dom = createDomTestHarness();
    const restorePopover = installPopoverApi(dom);
    const [value, setValue] = createSignal<string | null>(null);
    const commits: Array<string | null> = [];
    const { AutocompleteSelect } = await import("../src/inputs/AutocompleteSelect");
    const dispose = render(
      () =>
        createComponent(AutocompleteSelect, {
          label: "Category",
          value,
          onValueChange: setValue,
          onValueCommit: (next) => commits.push(next),
          debounceMs: 0,
          search: async (query) => {
            const option = { value: "551", label: "Gemälde", description: "Kunst > Malerei" };
            return query === "gem" ? { options: [option], match: option } : { options: [] };
          },
        }),
      dom.root,
    );

    const input = dom.root.querySelector<HTMLInputElement>('[role="combobox"]')!;
    input.focus();
    setSolidInputValue(input, "gem");
    await Bun.sleep(0);
    expect(input.value).toBe("Gemälde");
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, "Gemälde".length]);
    expect(dom.root.querySelector('[role="option"]')?.getAttribute("aria-selected")).toBe("true");

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    input.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(value()).toBe("551");
    expect(commits).toEqual(["551"]);
    expect(input.getAttribute("aria-expanded")).toBe("false");

    dispose();
    restorePopover();
    dom.cleanup();
  });

  test("reports no authoritative match on Tab without accepting suggestions", async () => {
    const dom = createDomTestHarness();
    const restorePopover = installPopoverApi(dom);
    const [value, setValue] = createSignal<string | null>("551");
    const commits: Array<string | null> = [];
    const { AutocompleteSelect } = await import("../src/inputs/AutocompleteSelect");
    const dispose = render(
      () =>
        createComponent(AutocompleteSelect, {
          label: "Category",
          value,
          onValueChange: setValue,
          onValueCommit: (next) => commits.push(next),
          selectedOption: { value: "551", label: "Paintings" },
          debounceMs: 0,
          search: async () => ({
            options: [{ value: "5520", label: "Prints", description: "A suggestion, not a match" }],
          }),
        }),
      dom.root,
    );

    const input = dom.root.querySelector<HTMLInputElement>('[role="combobox"]')!;
    input.focus();
    setSolidInputValue(input, "552");
    await Bun.sleep(0);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));

    expect(value()).toBeNull();
    expect(commits).toEqual([]);
    expect(dom.root.textContent).toContain("No matching option found");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.validationMessage).toBe("No matching option found");

    dispose();
    restorePopover();
    dom.cleanup();
  });

  test("accepts a suggestion only after explicit keyboard navigation", async () => {
    const dom = createDomTestHarness();
    const restorePopover = installPopoverApi(dom);
    const [value, setValue] = createSignal<string | null>(null);
    const { AutocompleteSelect } = await import("../src/inputs/AutocompleteSelect");
    const dispose = render(
      () =>
        createComponent(AutocompleteSelect, {
          label: "Category",
          value,
          onValueChange: setValue,
          debounceMs: 0,
          search: async () => ({
            options: [
              { value: "557", label: "Prints" },
              { value: "553", label: "Drawings" },
            ],
          }),
        }),
      dom.root,
    );

    const input = dom.root.querySelector<HTMLInputElement>('[role="combobox"]')!;
    input.focus();
    setSolidInputValue(input, "art");
    await Bun.sleep(0);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(dom.root.querySelector('[role="option"]')?.getAttribute("aria-selected")).toBe("true");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(value()).toBe("557");

    dispose();
    restorePopover();
    dom.cleanup();
  });

  test("clears an optional clearable selection when empty text is committed", async () => {
    const dom = createDomTestHarness();
    const restorePopover = installPopoverApi(dom);
    const [value, setValue] = createSignal<string | null>("551");
    const { AutocompleteSelect } = await import("../src/inputs/AutocompleteSelect");
    const dispose = render(
      () =>
        createComponent(AutocompleteSelect, {
          label: "Category",
          value,
          onValueChange: setValue,
          selectedOption: { value: "551", label: "Paintings" },
          clearable: true,
          debounceMs: 0,
          search: async () => ({ options: [] }),
        }),
      dom.root,
    );

    const input = dom.root.querySelector<HTMLInputElement>('[role="combobox"]')!;
    input.focus();
    setSolidInputValue(input, "");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(value()).toBeNull();
    expect(input.validationMessage).toBe("");
    expect(dom.root.textContent).not.toContain("No matching option found");

    dispose();
    restorePopover();
    dom.cleanup();
  });

  test("lets Tab move on while a pending search later commits its match", async () => {
    const dom = createDomTestHarness();
    const restorePopover = installPopoverApi(dom);
    const [value, setValue] = createSignal<string | null>(null);
    let resolveSearch: ((result: AutocompleteSelectSearchResult) => void) | undefined;
    const { AutocompleteSelect } = await import("../src/inputs/AutocompleteSelect");
    const dispose = render(
      () =>
        createComponent(AutocompleteSelect, {
          label: "Category",
          value,
          onValueChange: setValue,
          debounceMs: 100,
          search: (_query, signal) =>
            new Promise<AutocompleteSelectSearchResult>((resolve) => {
              resolveSearch = resolve;
              signal.addEventListener("abort", () => resolve({ options: [] }), { once: true });
            }),
        }),
      dom.root,
    );

    const input = dom.root.querySelector<HTMLInputElement>('[role="combobox"]')!;
    input.focus();
    setSolidInputValue(input, "551");
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    input.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(dom.root.textContent).toContain("Checking options");

    const option = { value: "551", label: "Paintings" };
    resolveSearch?.({ options: [option], match: option });
    await Bun.sleep(0);
    expect(value()).toBe("551");

    dispose();
    restorePopover();
    dom.cleanup();
  });

  test("keeps technical search errors distinct from empty matches", async () => {
    const dom = createDomTestHarness();
    const restorePopover = installPopoverApi(dom);
    const [value, setValue] = createSignal<string | null>(null);
    const { AutocompleteSelect } = await import("../src/inputs/AutocompleteSelect");
    const dispose = render(
      () =>
        createComponent(AutocompleteSelect, {
          label: "Category",
          value,
          onValueChange: setValue,
          debounceMs: 0,
          search: async () => {
            throw new Error("Catalogue unavailable");
          },
        }),
      dom.root,
    );

    const input = dom.root.querySelector<HTMLInputElement>('[role="combobox"]')!;
    input.focus();
    setSolidInputValue(input, "551");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    await Bun.sleep(0);

    expect(dom.root.textContent).toContain("Catalogue unavailable");
    expect(dom.root.textContent).not.toContain("No matching option found");
    expect(value()).toBeNull();

    dispose();
    restorePopover();
    dom.cleanup();
  });

  test("passes the active group to searches and refreshes results when it changes", async () => {
    const dom = createDomTestHarness();
    const restorePopover = installPopoverApi(dom);
    const calls: Array<{ query: string; group: string | null }> = [];
    const { AutocompleteSelect } = await import("../src/inputs/AutocompleteSelect");
    const dispose = render(
      () =>
        createComponent(AutocompleteSelect, {
          label: "Category",
          value: null,
          debounceMs: 0,
          groups: [
            { value: "recommended", label: "Recommended" },
            { value: "food", label: "Food" },
          ],
          search: async (query, _signal, group) => {
            calls.push({ query, group });
            return { options: [{ value: group ?? "all", label: group ?? "All" }] };
          },
        }),
      dom.root,
    );

    const input = dom.root.querySelector<HTMLInputElement>('[role="combobox"]')!;
    input.focus();
    input.click();
    await Bun.sleep(0);
    expect(calls).toEqual([{ query: "", group: null }]);
    expect(dom.root.querySelector('[role="option"]')?.textContent).toContain("All");

    const food = Array.from(dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((radio) => radio.textContent === "Food")!;
    food.focus();
    expect(dom.document.activeElement).toBe(food);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    food.click();
    await Bun.sleep(0);
    expect(calls.at(-1)).toEqual({ query: "", group: "food" });
    expect(dom.root.querySelector('[role="option"]')?.textContent).toContain("food");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    food.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(dom.document.activeElement).toBe(input);

    dispose();
    restorePopover();
    dom.cleanup();
  });

  test("contains wheel scrolling inside long and short choice popovers", async () => {
    const dom = createDomTestHarness();
    const restorePopover = installPopoverApi(dom);
    const { AutocompleteSelect } = await import("../src/inputs/AutocompleteSelect");
    const dispose = render(
      () =>
        createComponent(AutocompleteSelect, {
          label: "Category",
          value: null,
          debounceMs: 0,
          groups: [
            { value: "recommended", label: "Recommended" },
            { value: "fine-art", label: "Fine art" },
          ],
          search: async () => ({ options: [{ value: "551", label: "Paintings" }] }),
        }),
      dom.root,
    );

    const input = dom.root.querySelector<HTMLInputElement>('[role="combobox"]')!;
    input.focus();
    input.click();
    await Bun.sleep(0);
    const popover = dom.root.querySelector<HTMLElement>(".k2b-choice-popover")!;
    const options = dom.root.querySelector<HTMLElement>(".k2b-choice-options")!;
    Object.defineProperties(options, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    const longListWheel = new Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperties(longListWheel, { deltaMode: { value: 0 }, deltaY: { value: 32 }, ctrlKey: { value: false } });
    popover.dispatchEvent(longListWheel);
    expect(longListWheel.defaultPrevented).toBe(true);
    expect(options.scrollTop).toBe(32);

    Object.defineProperty(options, "scrollHeight", { configurable: true, value: 80 });
    options.scrollTop = 0;
    const shortListWheel = new Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperties(shortListWheel, { deltaMode: { value: 0 }, deltaY: { value: 32 }, ctrlKey: { value: false } });
    popover.dispatchEvent(shortListWheel);
    expect(shortListWheel.defaultPrevented).toBe(true);
    expect(options.scrollTop).toBe(0);

    const groups = dom.root.querySelector<HTMLElement>(".k2b-choice-groups")!;
    Object.defineProperties(groups, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 300 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });
    const horizontalWheel = new Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperties(horizontalWheel, {
      deltaMode: { value: 0 },
      deltaX: { value: 24 },
      deltaY: { value: 0 },
      shiftKey: { value: false },
      ctrlKey: { value: false },
    });
    groups.dispatchEvent(horizontalWheel);
    expect(horizontalWheel.defaultPrevented).toBe(true);
    expect(groups.scrollLeft).toBe(24);

    dispose();
    restorePopover();
    dom.cleanup();
  });
});
