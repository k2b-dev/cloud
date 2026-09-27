import { describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

type PopoverPatch = {
  restore: () => void;
  setOpen: (element: HTMLElement, value: boolean) => void;
};

const installPopoverApi = (dom: DomTestHarness): PopoverPatch => {
  const prototype = dom.window.HTMLElement.prototype as unknown as HTMLElement;
  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const open = new WeakSet<Element>();

  const patch = (key: PropertyKey, value: unknown) => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(prototype, key));
    Object.defineProperty(prototype, key, {
      configurable: true,
      writable: true,
      value,
    });
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

  return {
    setOpen: (element, value) => {
      if (value) open.add(element);
      else open.delete(element);
      element.dispatchEvent(new dom.window.Event("toggle") as unknown as Event);
    },
    restore: () => {
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(prototype, key, descriptor);
        else Reflect.deleteProperty(prototype, key);
      }
    },
  };
};

const setSolidInputValue = (input: HTMLInputElement, value: string) => {
  input.value = value;
  const handler = (input as HTMLInputElement & { $$input?: (event: { currentTarget: HTMLInputElement }) => void }).$$input;
  if (!handler) throw new Error("Solid input handler is not installed");
  handler({ currentTarget: input });
};

/**
 * Deterministic layout for MultiSelectInput overflow: the pill strip is as wide
 * as `available()`, a pill is 28px plus 8px per label character, the "+N"
 * summary is 32px, and pills sit 4px apart. The test ResizeObserver reports a
 * trigger resize on demand and tracks the elements it observes.
 */
const installPillLayout = (dom: DomTestHarness, available: () => number) => {
  const prototype = dom.window.HTMLElement.prototype as unknown as HTMLElement;
  const rect = Object.getOwnPropertyDescriptor(prototype, "getBoundingClientRect");
  const measuredOutsideMeasuring: string[] = [];
  Object.defineProperty(prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      const classes = this.classList;
      if (classes.contains("k2b-choice-pill") && this.parentElement?.dataset.measuring !== "true")
        measuredOutsideMeasuring.push(this.title);
      const width = classes.contains("k2b-multi-select-trigger__values")
        ? available()
        : classes.contains("k2b-choice-pill")
          ? 28 + 8 * this.title.length
          : classes.contains("k2b-multi-select-trigger__more")
            ? 32
            : 0;
      return new dom.window.DOMRect(0, 0, width, 22);
    },
  });
  const style = dom.document.createElement("style");
  style.textContent = ".k2b-multi-select-trigger__values { column-gap: 4px; }";
  dom.document.head.append(style);

  const observers: Array<{ callback: ResizeObserverCallback; observer: ResizeObserver }> = [];
  const observed = new Set<Element>();
  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      observers.push({ callback, observer: this as unknown as ResizeObserver });
    }
    observe(element: Element) {
      observed.add(element);
    }
    unobserve(element: Element) {
      observed.delete(element);
    }
    disconnect() {
      observed.clear();
    }
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: TestResizeObserver });

  return {
    measuredOutsideMeasuring,
    observed,
    resize: () => {
      for (const { callback, observer } of observers) callback([], observer);
    },
    restore: () => {
      if (rect) Object.defineProperty(prototype, "getBoundingClientRect", rect);
      else Reflect.deleteProperty(prototype, "getBoundingClientRect");
    },
  };
};

const pillSummary = (root: HTMLElement) => {
  const more = root.querySelector<HTMLElement>(".k2b-multi-select-trigger__more");
  return {
    visible: Array.from(root.querySelectorAll<HTMLElement>(".k2b-choice-pill:not([data-hidden])"), (pill) => pill.title),
    more: more && more.dataset.hidden !== "true" ? more.querySelector('[aria-hidden="true"]')?.textContent : undefined,
    announced: more && more.dataset.hidden !== "true" ? more.querySelector(".k2b-sr-only")?.textContent : undefined,
    hiddenLabels: more?.title || undefined,
  };
};

describe("@k2b/ui choice and date browser behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("registers choice listeners only while open and clears a failed active option", async () => {
    const dom = createDomTestHarness();
    const popover = installPopoverApi(dom);
    const { Combobox } = await import("../src/inputs/Combobox");
    const activeListeners = { pointerdown: 0, resize: 0, scroll: 0 };
    type ListenerTarget = {
      addEventListener: (...args: unknown[]) => unknown;
      removeEventListener: (...args: unknown[]) => unknown;
    };
    const documentTarget = dom.document as unknown as ListenerTarget;
    const windowTarget = dom.window as unknown as ListenerTarget;
    const documentAdd = documentTarget.addEventListener.bind(dom.document);
    const documentRemove = documentTarget.removeEventListener.bind(dom.document);
    const windowAdd = windowTarget.addEventListener.bind(dom.window);
    const windowRemove = windowTarget.removeEventListener.bind(dom.window);

    documentTarget.addEventListener = (...args) => {
      if (args[0] === "pointerdown") activeListeners.pointerdown += 1;
      return documentAdd(...args);
    };
    documentTarget.removeEventListener = (...args) => {
      if (args[0] === "pointerdown") activeListeners.pointerdown -= 1;
      return documentRemove(...args);
    };
    windowTarget.addEventListener = (...args) => {
      if (args[0] === "resize" || args[0] === "scroll") activeListeners[args[0]] += 1;
      return windowAdd(...args);
    };
    windowTarget.removeEventListener = (...args) => {
      if (args[0] === "resize" || args[0] === "scroll") activeListeners[args[0]] -= 1;
      return windowRemove(...args);
    };

    const dispose = render(
      () =>
        createComponent(Combobox, {
          label: "Add team",
          debounceMs: 0,
          fetchData: async (query) => {
            if (query === "broken") throw new Error("Could not load teams");
            return [{ id: "platform", label: "Platform" }];
          },
          onSelect: () => {},
        }),
      dom.root,
    );

    const input = dom.root.querySelector<HTMLInputElement>('[role="combobox"]');
    expect(input?.getAttribute("aria-labelledby")).toBe(`${input?.id}-label`);
    expect(activeListeners).toEqual({ pointerdown: 0, resize: 0, scroll: 0 });

    input?.focus();
    await Bun.sleep(0);
    expect(activeListeners).toEqual({ pointerdown: 1, resize: 1, scroll: 1 });

    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const activeId = input?.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    expect(dom.document.getElementById(activeId ?? "")?.textContent).toContain("Platform");

    if (input) {
      input.value = "broken";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await Bun.sleep(0);

    expect(input?.hasAttribute("aria-activedescendant")).toBe(false);
    expect(dom.root.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(dom.root.textContent).toContain("Could not load teams");

    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(activeListeners).toEqual({ pointerdown: 0, resize: 0, scroll: 0 });

    dispose();
    popover.restore();
    dom.cleanup();
  });

  test("loads the controlled query when the combobox opens", async () => {
    const dom = createDomTestHarness();
    const popover = installPopoverApi(dom);
    const { Combobox } = await import("../src/inputs/Combobox");
    const queries: string[] = [];
    const dispose = render(
      () =>
        createComponent(Combobox, {
          label: "Add team",
          query: "platform",
          debounceMs: 0,
          fetchData: async (query) => {
            queries.push(query);
            return [{ id: query, label: query }];
          },
          onSelect: () => {},
        }),
      dom.root,
    );

    dom.root.querySelector<HTMLInputElement>('[role="combobox"]')?.focus();
    await Bun.sleep(0);

    expect(queries).toEqual(["platform"]);
    expect(dom.root.querySelector('[role="option"]')?.textContent).toContain("platform");

    dispose();
    popover.restore();
    dom.cleanup();
  });

  test("hides a Combobox listbox before publishing a selection", async () => {
    const dom = createDomTestHarness();
    const popover = installPopoverApi(dom);
    const { Combobox } = await import("../src/inputs/Combobox");
    let openDuringSelect: boolean | undefined;
    const dispose = render(
      () =>
        createComponent(Combobox, {
          label: "Add team",
          debounceMs: 0,
          fetchData: async () => [
            { id: "platform", label: "Platform", icon: "ti-server" },
            { id: "design", label: "Design", icon: "ti ti-palette" },
          ],
          onSelect: () => {
            openDuringSelect = dom.root.querySelector<HTMLElement>(".k2b-choice-popover")?.matches(":popover-open");
          },
        }),
      dom.root,
    );

    dom.root.querySelector<HTMLInputElement>('[role="combobox"]')?.focus();
    await Bun.sleep(0);
    expect(Array.from(dom.root.querySelectorAll('[role="option"] i'), (icon) => icon.className)).toEqual(["ti ti-server", "ti ti-palette"]);
    dom.root.querySelector<HTMLButtonElement>('[role="option"]')?.click();

    expect(openDuringSelect).toBe(false);
    expect(dom.root.querySelector('[role="combobox"]')?.getAttribute("aria-expanded")).toBe("false");
    expect(dom.root.querySelector<HTMLInputElement>('[role="combobox"]')?.value).toBe("");

    dispose();
    popover.restore();
    dom.cleanup();
  });

  test("hides a Select listbox before publishing the selected value", async () => {
    const dom = createDomTestHarness();
    const popover = installPopoverApi(dom);
    const { Select } = await import("../src/inputs/Select");
    let openDuringChange: boolean | undefined;

    const dispose = render(
      () =>
        createComponent(Select, {
          label: "Match",
          value: "sender_address",
          options: [
            { id: "sender_address", label: "Sender address" },
            { id: "sender_domain", label: "Sender domain" },
          ],
          onValueChange: () => {
            openDuringChange = dom.root.querySelector<HTMLElement>(".k2b-choice-popover")?.matches(":popover-open");
          },
        }),
      dom.root,
    );

    dom.root.querySelector<HTMLButtonElement>(".k2b-choice-trigger")?.click();
    dom.root.querySelectorAll<HTMLButtonElement>("[role='option']")[1]?.click();

    expect(openDuringChange).toBe(false);
    expect(dom.root.querySelector(".k2b-choice-trigger")?.getAttribute("aria-expanded")).toBe("false");

    dispose();
    popover.restore();
    dom.cleanup();
  });

  test("combines overlapping Select groups with local search and keyboard navigation", async () => {
    const dom = createDomTestHarness();
    const popover = installPopoverApi(dom);
    const { Select } = await import("../src/inputs/Select");
    const dispose = render(
      () =>
        createComponent(Select, {
          label: "Icon",
          value: null,
          searchable: true,
          groups: [
            { value: "recommended", label: "Recommended" },
            { value: "food", label: "Food" },
            { value: "work", label: "Work" },
          ],
          defaultGroup: "recommended",
          filterOptions: (source, query) => source.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase())),
          options: [
            { value: "coffee", label: "Coffee", groups: ["recommended", "food"] },
            { value: "pizza", label: "Pizza", groups: ["food"] },
            { value: "briefcase", label: "Briefcase", groups: ["recommended", "work"] },
          ],
        }),
      dom.root,
    );

    dom.root.querySelector<HTMLButtonElement>(".k2b-choice-trigger")?.click();
    const optionLabels = () => Array.from(dom.root.querySelectorAll<HTMLElement>("[role='option'] strong"), (option) => option.textContent);
    expect(optionLabels()).toEqual(["Coffee", "Briefcase"]);

    const radios = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("[role='radio']"));
    radios.find((radio) => radio.textContent === "Food")?.click();
    expect(optionLabels()).toEqual(["Coffee", "Pizza"]);

    const search = dom.root.querySelector<HTMLInputElement>(".k2b-choice-search input")!;
    setSolidInputValue(search, "cof");
    expect(optionLabels()).toEqual(["Coffee"]);

    const food = radios.find((radio) => radio.textContent === "Food")!;
    food.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await Bun.sleep(0);
    expect(radios.find((radio) => radio.textContent === "Work")?.getAttribute("aria-checked")).toBe("true");
    expect(optionLabels()).toEqual([]);
    expect(dom.root.textContent).toContain("No results");

    dispose();
    popover.restore();
    dom.cleanup();
  });

  test("overlays the group scrollbar without changing the toolbar geometry", async () => {
    const dom = createDomTestHarness();
    const popover = installPopoverApi(dom);
    const { Select } = await import("../src/inputs/Select");
    const dispose = render(
      () =>
        createComponent(Select, {
          label: "Field",
          value: null,
          groups: Array.from({ length: 8 }, (_, index) => ({ value: `group-${index}`, label: `Group ${index}` })),
          options: [{ value: "one", label: "One" }],
        }),
      dom.root,
    );

    const groups = dom.root.querySelector<HTMLDivElement>(".k2b-choice-groups")!;
    Object.defineProperties(groups, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 500 },
      scrollLeft: { configurable: true, writable: true, value: 100 },
    });
    groups.dispatchEvent(new Event("scroll"));
    await Promise.resolve();

    const scrollbar = dom.root.querySelector<HTMLElement>(".k2b-choice-groups-scrollbar");
    expect(scrollbar?.getAttribute("aria-hidden")).toBe("true");
    expect(scrollbar?.querySelector("span")?.getAttribute("style")).toContain("--k2b-choice-scroll-left: 40px");
    expect(scrollbar?.querySelector("span")?.getAttribute("style")).toContain("--k2b-choice-scroll-width: 80px");

    dispose();
    popover.restore();
    dom.cleanup();
  });

  test("passes the active Select group to remote loaders", async () => {
    const dom = createDomTestHarness();
    const popover = installPopoverApi(dom);
    const { Select } = await import("../src/inputs/Select");
    const calls: Array<{ query: string; group: string | null }> = [];
    const dispose = render(
      () =>
        createComponent(Select, {
          label: "Principal",
          value: null,
          debounceMs: 0,
          groups: [
            { value: "user", label: "Users" },
            { value: "group", label: "Groups" },
          ],
          defaultGroup: "user",
          fetchData: async (query, _signal, group) => {
            calls.push({ query, group });
            return [{ id: `${group}:${query}`, label: `${group}:${query}` }];
          },
        }),
      dom.root,
    );

    dom.root.querySelector<HTMLButtonElement>(".k2b-choice-trigger")?.click();
    await Bun.sleep(0);
    expect(calls).toEqual([{ query: "", group: "user" }]);

    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("[role='radio']"))
      .find((radio) => radio.textContent === "Groups")
      ?.click();
    await Bun.sleep(0);
    expect(calls.at(-1)).toEqual({ query: "", group: "group" });

    const search = dom.root.querySelector<HTMLInputElement>(".k2b-choice-search input")!;
    setSolidInputValue(search, "ops");
    await Bun.sleep(0);
    expect(calls.at(-1)).toEqual({ query: "ops", group: "group" });

    dispose();
    popover.restore();
    dom.cleanup();
  });

  test("combines MultiSelectInput groups with remote search and keeps selected values", async () => {
    const dom = createDomTestHarness();
    const popover = installPopoverApi(dom);
    const { MultiSelectInput } = await import("../src/inputs/MultiSelectInput");
    const calls: Array<{ query: string; group: string | null }> = [];
    const dispose = render(
      () =>
        createComponent(MultiSelectInput, {
          label: "Principals",
          value: ["user:1"],
          selectedOptions: () => [{ id: "user:1", label: "Ada" }],
          debounceMs: 0,
          groups: [
            { value: "user", label: "Users" },
            { value: "group", label: "Groups" },
          ],
          fetchData: async (query, _signal, group) => {
            calls.push({ query, group });
            return [{ id: `${group}:${query}`, label: `${group}:${query}` }];
          },
        }),
      dom.root,
    );

    dom.root.querySelector<HTMLElement>(".k2b-multi-select-trigger")?.click();
    await Bun.sleep(0);
    expect(calls).toEqual([{ query: "", group: null }]);
    expect(dom.root.textContent).toContain("Ada");

    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("[role='radio']"))
      .find((radio) => radio.textContent === "Groups")
      ?.click();
    await Bun.sleep(0);
    expect(calls.at(-1)).toEqual({ query: "", group: "group" });

    const search = dom.root.querySelector<HTMLInputElement>(".k2b-choice-search input")!;
    setSolidInputValue(search, "ops");
    await Bun.sleep(0);
    expect(calls.at(-1)).toEqual({ query: "ops", group: "group" });
    expect(dom.root.textContent).toContain("Ada");

    dispose();
    popover.restore();
    dom.cleanup();
  });

  test("collapses MultiSelectInput pills that do not fit into a counted summary", async () => {
    const dom = createDomTestHarness();
    let available = 400;
    const layout = installPillLayout(dom, () => available);
    const { MultiSelectInput } = await import("../src/inputs/MultiSelectInput");
    const dispose = render(
      () =>
        createComponent(MultiSelectInput, {
          "aria-label": "Columns",
          value: ["alpha", "beta", "gamma", "delta", "epsilon"],
          options: ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"].map((label) => ({ id: label.toLowerCase(), label })),
        }),
      dom.root,
    );
    const values = dom.root.querySelector<HTMLElement>(".k2b-multi-select-trigger__values")!;

    // 68 + 60 + 68 + 68 + 84 plus four gaps is 364px: everything fits.
    expect(pillSummary(dom.root)).toEqual({
      visible: ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"],
      more: undefined,
      announced: undefined,
      hiddenLabels: undefined,
    });
    expect(values.dataset.overflowing).toBeUndefined();
    expect(values.style.width).toBe("");

    available = 240;
    layout.resize();
    expect(pillSummary(dom.root)).toEqual({
      visible: ["Alpha", "Beta", "Gamma"],
      more: "+2",
      announced: "2 more selected",
      hiddenLabels: "Delta, Epsilon",
    });
    expect(values.dataset.overflowing).toBe("true");
    // Hidden pills leave the flow, so the strip keeps the whole row as its
    // preferred width: a container sized by its content can grow back.
    expect(values.style.width).toBe("364px");

    available = 160;
    layout.resize();
    expect(pillSummary(dom.root)).toMatchObject({ visible: ["Alpha"], more: "+4", announced: "4 more selected" });

    // Narrower than the first pill and the summary: the first pill stays and truncates.
    available = 60;
    layout.resize();
    expect(pillSummary(dom.root)).toMatchObject({ visible: ["Alpha"], more: "+4" });
    expect(dom.root.querySelector<HTMLElement>(".k2b-choice-pill")?.title).toBe("Alpha");

    available = 400;
    layout.resize();
    expect(pillSummary(dom.root).visible).toHaveLength(5);
    expect(values.style.width).toBe("");
    expect(layout.measuredOutsideMeasuring).toEqual([]);
    expect(values.dataset.measuring).toBeUndefined();

    dispose();
    layout.restore();
    dom.cleanup();
  });

  test("keeps the MultiSelectInput summary current while the keyboard removes values", async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "de";
    delegateEvents(["keydown"], dom.document);
    const popover = installPopoverApi(dom);
    const layout = installPillLayout(dom, () => 120);
    const { MultiSelectInput } = await import("../src/inputs/MultiSelectInput");
    const [value, setValue] = createSignal(["alpha", "beta", "gamma"]);
    const dispose = render(
      () =>
        createComponent(MultiSelectInput, {
          "aria-label": "Spalten",
          value,
          onValueChange: setValue,
          options: ["Alpha", "Beta", "Gamma"].map((label) => ({ id: label.toLowerCase(), label })),
        }),
      dom.root,
    );
    const trigger = dom.root.querySelector<HTMLElement>(".k2b-multi-select-trigger")!;
    const press = (key: string) => trigger.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

    expect(pillSummary(dom.root)).toMatchObject({ visible: ["Alpha"], more: "+2", announced: "2 weitere Optionen ausgewählt" });

    press("ArrowDown");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    press("Backspace");
    expect(value()).toEqual(["alpha", "beta"]);
    expect(pillSummary(dom.root)).toEqual({
      visible: ["Alpha"],
      more: "+1",
      announced: "1 weitere Option ausgewählt",
      hiddenLabels: "Beta",
    });

    press("Backspace");
    expect(value()).toEqual(["alpha"]);
    expect(pillSummary(dom.root).visible).toEqual(["Alpha"]);
    expect(dom.root.querySelector(".k2b-multi-select-trigger__more")).toBeNull();

    // A removed summary stops being observed; toggling it does not pile up detached elements.
    const observedSummaries = () =>
      [...layout.observed]
        .filter((element) => element.classList.contains("k2b-multi-select-trigger__more"))
        .map((element) => (element.isConnected ? "connected" : "detached"));
    expect(observedSummaries()).toEqual([]);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      setValue(["alpha", "beta"]);
      expect(pillSummary(dom.root).more).toBe("+1");
      expect(observedSummaries()).toEqual(["connected"]);
      setValue(["alpha"]);
      expect(observedSummaries()).toEqual([]);
    }

    dispose();
    layout.restore();
    popover.restore();
    dom.cleanup();
  });

  test("toggles Select option layout without changing groups, search, or selection", async () => {
    const dom = createDomTestHarness();
    const popover = installPopoverApi(dom);
    const { Select } = await import("../src/inputs/Select");
    const dispose = render(
      () =>
        createComponent(Select, {
          label: "Icon",
          value: null,
          searchable: true,
          viewToggle: true,
          defaultView: "grid",
          gridSize: "lg",
          groups: [
            { value: "recommended", label: "Recommended" },
            { value: "food", label: "Food" },
          ],
          defaultGroup: "recommended",
          options: [
            { value: "coffee", label: "Coffee", groups: ["recommended", "food"] },
            { value: "pizza", label: "Pizza", groups: ["food"] },
          ],
        }),
      dom.root,
    );

    dom.root.querySelector<HTMLButtonElement>(".k2b-choice-trigger")?.click();
    const options = dom.root.querySelector<HTMLElement>(".k2b-choice-options")!;
    expect(options.dataset.view).toBe("grid");
    expect(options.dataset.gridSize).toBe("lg");

    dom.root.querySelector<HTMLButtonElement>('[aria-label="Show list view"]')?.click();
    expect(options.dataset.view).toBe("list");
    expect(options.dataset.gridSize).toBeUndefined();
    expect(dom.root.querySelector(".k2b-choice-view-toggle")?.getAttribute("aria-label")).toBe("Show grid view");

    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("[role='radio']"))
      .find((radio) => radio.textContent === "Food")
      ?.click();
    const search = dom.root.querySelector<HTMLInputElement>(".k2b-choice-search input")!;
    setSolidInputValue(search, "piz");
    expect(Array.from(dom.root.querySelectorAll<HTMLElement>("[role='option'] strong"), (option) => option.textContent)).toEqual(["Pizza"]);

    dom.root.querySelector<HTMLButtonElement>('[aria-label="Show grid view"]')?.click();
    expect(options.dataset.view).toBe("grid");
    expect(options.dataset.gridSize).toBe("lg");
    expect(dom.root.querySelector(".k2b-choice-view-toggle i")?.className).toBe("ti ti-list-details");

    dom.root
      .querySelector<HTMLButtonElement>('[aria-label="Show list view"]')
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dom.root.querySelector(".k2b-choice-trigger")?.getAttribute("aria-expanded")).toBe("false");

    dispose();
    popover.restore();
    dom.cleanup();
  });

  test("keeps IconInput fuzzy search inside the active default group", async () => {
    const dom = createDomTestHarness();
    const popover = installPopoverApi(dom);
    const { IconInput } = await import("../src/inputs/SpecialInputs");
    const dispose = render(
      () =>
        createComponent(IconInput, {
          label: "Icon",
          value: null,
        }),
      dom.root,
    );

    dom.root.querySelector<HTMLButtonElement>(".k2b-choice-trigger")?.click();
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("[role='radio']"))
      .find((radio) => radio.textContent === "Food")
      ?.click();

    const search = dom.root.querySelector<HTMLInputElement>(".k2b-choice-search input")!;
    setSolidInputValue(search, "piz");
    const optionLabels = Array.from(dom.root.querySelectorAll<HTMLElement>("[role='option'] strong"), (option) => option.textContent);
    expect(optionLabels).toEqual(["Pizza"]);

    dispose();
    popover.restore();
    dom.cleanup();
  });

  test("syncs a native popover close back to the choice trigger", async () => {
    const dom = createDomTestHarness();
    const popover = installPopoverApi(dom);
    const { Select } = await import("../src/inputs/Select");
    const dispose = render(
      () =>
        createComponent(Select, {
          label: "Match",
          value: "sender_address",
          options: [{ id: "sender_address", label: "Sender address" }],
        }),
      dom.root,
    );

    const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-choice-trigger")!;
    const surface = dom.root.querySelector<HTMLElement>(".k2b-choice-popover")!;
    trigger.click();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    popover.setOpen(surface, false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    dispose();
    popover.restore();
    dom.cleanup();
  });

  test("registers DatePicker viewport listeners only while open", async () => {
    const dom = createDomTestHarness();
    const popover = installPopoverApi(dom);
    const { DatePicker } = await import("../src/inputs/DatePicker");
    const activeListeners = { resize: 0, scroll: 0 };
    const target = dom.window as unknown as {
      addEventListener: (...args: unknown[]) => unknown;
      removeEventListener: (...args: unknown[]) => unknown;
    };
    const add = target.addEventListener.bind(dom.window);
    const remove = target.removeEventListener.bind(dom.window);
    target.addEventListener = (...args) => {
      if (args[0] === "resize" || args[0] === "scroll") activeListeners[args[0]] += 1;
      return add(...args);
    };
    target.removeEventListener = (...args) => {
      if (args[0] === "resize" || args[0] === "scroll") activeListeners[args[0]] -= 1;
      return remove(...args);
    };

    const dispose = render(() => createComponent(DatePicker, { label: "Release date", value: "2026-07-27" }), dom.root);
    const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-date-trigger")!;
    const surface = dom.root.querySelector<HTMLElement>(".k2b-date-popover")!;
    expect(activeListeners).toEqual({ resize: 0, scroll: 0 });

    trigger.click();
    expect(activeListeners).toEqual({ resize: 1, scroll: 1 });
    popover.setOpen(surface, false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(activeListeners).toEqual({ resize: 0, scroll: 0 });

    dispose();
    popover.restore();
    dom.cleanup();
  });

  test("guards invalid date-time input and closes before committing", async () => {
    const dom = createDomTestHarness();
    const popover = installPopoverApi(dom);
    const { DateTimePicker } = await import("../src/inputs/DatePicker");
    const commits: Array<string | null> = [];
    let openDuringCommit: boolean | undefined;
    const dispose = render(
      () =>
        createComponent(DateTimePicker, {
          label: "Starts at",
          value: "2026-07-27T09:00",
          onValueCommit: (value) => {
            openDuringCommit = dom.root.querySelector<HTMLElement>(".k2b-date-popover")?.matches(":popover-open");
            commits.push(value);
          },
        }),
      dom.root,
    );

    dom.root.querySelector<HTMLButtonElement>(".k2b-date-trigger")?.click();
    const time = dom.root.querySelector<HTMLInputElement>(".k2b-date-time input")!;
    const apply = dom.root.querySelector<HTMLButtonElement>(".k2b-date-apply")!;
    setSolidInputValue(time, "9999");
    await Bun.sleep(0);
    expect(time.value).toBe("99:99");
    expect(apply.disabled).toBe(true);
    apply.click();
    expect(commits).toEqual([]);

    setSolidInputValue(time, "0930");
    await Bun.sleep(0);
    expect(apply.disabled).toBe(false);
    apply.click();
    expect(commits).toEqual(["2026-07-27T09:30"]);
    expect(openDuringCommit).toBe(false);

    dispose();
    popover.restore();
    dom.cleanup();
  });

  test("keeps an invalid timed range from committing", async () => {
    const dom = createDomTestHarness();
    const popover = installPopoverApi(dom);
    const { DateRangePicker } = await import("../src/inputs/DatePicker");
    let commits = 0;
    const dispose = render(
      () =>
        createComponent(DateRangePicker, {
          label: "Window",
          value: { start: "2026-07-27T09:00", end: "2026-07-27T10:00" },
          withTime: true,
          onValueCommit: () => {
            commits += 1;
          },
        }),
      dom.root,
    );

    dom.root.querySelector<HTMLButtonElement>(".k2b-date-trigger")?.click();
    const start = dom.root.querySelector<HTMLInputElement>('.k2b-date-time input[aria-label="Start time"]')!;
    const apply = dom.root.querySelector<HTMLButtonElement>(".k2b-date-apply")!;
    setSolidInputValue(start, "2460");
    await Bun.sleep(0);
    expect(start.value).toBe("24:60");
    expect(apply.disabled).toBe(true);
    apply.click();
    expect(commits).toBe(0);

    dispose();
    popover.restore();
    dom.cleanup();
  });

  test("normalizes NumberInput once and keeps steppers inside bounds", async () => {
    const dom = createDomTestHarness();
    const { NumberInput } = await import("../src/inputs/NumberInput");
    const changes: Array<number | null> = [];
    const commits: Array<number | null> = [];
    const dispose = render(
      () =>
        createComponent(NumberInput, {
          label: "Capacity",
          value: 6,
          min: 0,
          max: 10,
          step: 6,
          onValueChange: (value) => changes.push(value),
          onValueCommit: (value) => commits.push(value),
        }),
      dom.root,
    );

    const input = dom.root.querySelector<HTMLInputElement>('[role="spinbutton"]')!;
    input.focus();
    input.value = "6";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.getAttribute("aria-valuenow")).toBe("6");
    input.blur();
    expect(changes).toEqual([6]);
    expect(commits).toEqual([6]);

    dom.root.querySelectorAll<HTMLButtonElement>(".k2b-number-input__step")[1]?.click();
    expect(changes.at(-1)).toBe(10);
    expect(commits.at(-1)).toBe(10);

    dispose();
    dom.cleanup();
  });

  test("keeps focus on the next day across a month boundary", async () => {
    const dom = createDomTestHarness();
    const popover = installPopoverApi(dom);
    const { DatePicker } = await import("../src/inputs/DatePicker");
    const dispose = render(
      () =>
        createComponent(DatePicker, {
          label: "Release date",
          value: "2026-07-31",
          dateConfig: { locale: "en", timeZone: "UTC" },
        }),
      dom.root,
    );

    dom.root.querySelector<HTMLButtonElement>(".k2b-date-trigger")?.click();
    await Bun.sleep(0);

    const july31 = dom.root.querySelector<HTMLButtonElement>('[data-date-day="2026-07-31"]');
    july31?.focus();
    july31?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await Bun.sleep(0);

    const august1 = dom.root.querySelector<HTMLButtonElement>('[data-date-day="2026-08-01"]');
    expect(dom.document.activeElement).toBe(august1);
    expect(august1?.getAttribute("aria-label")).toContain("Saturday");
    expect(august1?.getAttribute("aria-label")).toContain("August");
    expect(august1?.getAttribute("aria-label")).toContain("2026");

    dispose();
    popover.restore();
    dom.cleanup();
  }, 10_000);

  test("names the PIN group from its visible field label", async () => {
    const dom = createDomTestHarness();
    const { PinInput } = await import("../src/inputs/ChoiceInputs");
    const dispose = render(() => createComponent(PinInput, { label: "Security code", value: "", length: 4 }), dom.root);

    const group = dom.root.querySelector<HTMLElement>('[role="group"]');
    const labelId = group?.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(dom.document.getElementById(labelId ?? "")?.textContent).toContain("Security code");
    expect(group?.querySelectorAll("input")).toHaveLength(4);

    dispose();
    dom.cleanup();
  });

  test("masked PIN supports explicit Enter submission and respects disabled state", async () => {
    const dom = createDomTestHarness();
    // ChoiceInputs was imported in an earlier test with a different document.
    delegateEvents(["keydown"], dom.document);
    const { PinInput } = await import("../src/inputs/ChoiceInputs");
    let submissions = 0;
    const dispose = render(
      () => createComponent(PinInput, { label: "App PIN", password: true, value: "012345", onSubmit: () => submissions++ }),
      dom.root,
    );
    const input = dom.root.querySelector<HTMLInputElement>("input")!;
    expect(input.type).toBe("password");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(submissions).toBe(1);
    dispose();
    const disabled = render(
      () => createComponent(PinInput, { label: "App PIN", password: true, value: "012345", disabled: true, onSubmit: () => submissions++ }),
      dom.root,
    );
    dom.root.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(submissions).toBe(1);
    disabled();
    const readOnly = render(
      () => createComponent(PinInput, { label: "App PIN", value: "012345", readOnly: true, onSubmit: () => submissions++ }),
      dom.root,
    );
    const readonlyDigit = dom.root.querySelector<HTMLInputElement>("input")!;
    readonlyDigit.focus();
    expect(readonlyDigit.readOnly).toBe(true);
    expect(readonlyDigit.disabled).toBe(false);
    expect(dom.document.activeElement).toBe(readonlyDigit);
    readonlyDigit.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(submissions).toBe(1);
    readOnly();
    dom.cleanup();
  });

  test("reports live tag edits and commits the normalized value once", async () => {
    const dom = createDomTestHarness();
    const { TagsInput } = await import("../src/inputs/TagsInput");
    const changes: string[][] = [];
    const commits: string[][] = [];
    const dispose = render(
      () =>
        createComponent(TagsInput, {
          label: "Tags",
          value: ["solid"],
          onValueChange: (value) => changes.push(value),
          onValueCommit: (value) => commits.push(value),
        }),
      dom.root,
    );

    const input = dom.root.querySelector<HTMLInputElement>('.k2b-tags-input input[type="text"]')!;
    input.focus();
    setSolidInputValue(input, "solid, ssr, ssr");
    expect(changes).toEqual([["solid", "ssr"]]);
    expect(commits).toEqual([]);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(commits).toEqual([["solid", "ssr"]]);
    expect(dom.root.querySelector('[role="status"]')?.textContent).toContain("Tags added: ssr");

    dispose();
    dom.cleanup();
  });
});
