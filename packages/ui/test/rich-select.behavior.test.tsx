import { afterEach, describe, expect, test } from "bun:test";
import { createComponent, createSignal, mergeProps } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { RichSelectProps } from "../src/inputs/RichSelect";
import { createDomTestHarness, type DomTestHarness } from "./dom";

const installDesktopApis = (dom: DomTestHarness) => {
  const prototype = dom.window.HTMLElement.prototype;
  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const open = new WeakSet<object>();
  const patch = (key: PropertyKey, value: unknown) => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(prototype, key));
    Object.defineProperty(prototype, key, { configurable: true, writable: true, value });
  };
  const matches = prototype.matches;
  patch("matches", function (this: typeof prototype, selector: string) {
    return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
  });
  patch("showPopover", function (this: object) {
    open.add(this);
  });
  patch("hidePopover", function (this: object) {
    open.delete(this);
  });
  patch("scrollIntoView", () => {});
  const previousMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ ...dom.window.matchMedia(query), matches: false }),
  });
  return () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(prototype, key, descriptor);
      else Reflect.deleteProperty(prototype, key);
    }
    if (previousMedia) Object.defineProperty(globalThis, "matchMedia", previousMedia);
    else Reflect.deleteProperty(globalThis, "matchMedia");
  };
};

const items = [
  { value: "review", label: "Review", description: "Two tags are dropped", keywords: ["campaign"] },
  { value: "support", label: "Support", disabledReason: "No write access" },
  { value: "archive", label: "Archive", description: "Nothing is dropped" },
];
const searchableItems = [...items, ...Array.from({ length: 5 }, (_, index) => ({ value: `extra-${index}`, label: `Target ${index}` }))];
const key = (element: Element, value: string) =>
  element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  const handler = (input as HTMLInputElement & { $$input?: (event: { currentTarget: HTMLInputElement }) => void }).$$input;
  if (!handler) throw new Error("Solid input handler is not installed");
  handler({ currentTarget: input });
};

// This suite runs with browser conditions and the repository's Solid DOM preload.
describe("RichSelect desktop behavior", () => {
  if (isServer) {
    test.skip("requires the dedicated browser-conditions process", () => {});
    return;
  }
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });
  const mount = async (props: Partial<RichSelectProps> = {}) => {
    const dom = createDomTestHarness();
    const restore = installDesktopApis(dom);
    cleanup = () => {
      restore();
      dom.cleanup();
    };
    const { RichSelect } = await import("../src/inputs/RichSelect");
    const [value, setValue] = createSignal<string | null>(null);
    const commits: Array<string | null> = [];
    const dispose = render(
      () =>
        createComponent(
          RichSelect,
          mergeProps(
            {
              label: "Move card",
              value,
              onValueChange: setValue,
              onValueCommit: (next: string | null) => commits.push(next),
              items,
            },
            props,
          ),
        ),
      dom.root,
    );
    cleanup = () => {
      dispose();
      restore();
      dom.cleanup();
    };
    const trigger = dom.root.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    const rows = () => [...dom.root.querySelectorAll<HTMLElement>('[role="option"]')];
    const activeLabel = () =>
      dom.document.getElementById(trigger.getAttribute("aria-activedescendant") ?? "")?.querySelector(".k2b-rich-select__label")
        ?.textContent;
    const open = async () => {
      trigger.focus();
      trigger.click();
      await Promise.resolve();
    };
    return { dom, trigger, value, commits, rows, activeLabel, open };
  };

  test("arrows wrap through disabled rows; disabled Enter does nothing; Home/End and Escape preserve focus", async () => {
    const picker = await mount();
    await picker.open();
    expect(picker.trigger.getAttribute("aria-expanded")).toBe("true");
    expect(picker.activeLabel()).toBe("Review");
    expect(picker.dom.document.activeElement).toBe(picker.trigger);
    key(picker.trigger, "ArrowDown");
    expect(picker.activeLabel()).toBe("Support");
    key(picker.trigger, "Enter");
    expect(picker.value()).toBeNull();
    expect(picker.commits).toEqual([]);
    expect(picker.trigger.getAttribute("aria-expanded")).toBe("true");
    key(picker.trigger, "ArrowDown");
    expect(picker.activeLabel()).toBe("Archive");
    key(picker.trigger, "ArrowDown");
    expect(picker.activeLabel()).toBe("Review");
    key(picker.trigger, "ArrowUp");
    expect(picker.activeLabel()).toBe("Archive");
    key(picker.trigger, "ArrowUp");
    expect(picker.activeLabel()).toBe("Support");
    key(picker.trigger, "Home");
    expect(picker.activeLabel()).toBe("Review");
    key(picker.trigger, "End");
    expect(picker.activeLabel()).toBe("Archive");
    key(picker.trigger, "Escape");
    expect(picker.trigger.getAttribute("aria-expanded")).toBe("false");
    expect(picker.trigger.hasAttribute("aria-activedescendant")).toBe(false);
    expect(picker.dom.document.activeElement).toBe(picker.trigger);
    key(picker.trigger, "ArrowDown");
    await Promise.resolve();
    key(picker.trigger, "Enter");
    expect(picker.value()).toBe("review");
    expect(picker.commits).toEqual(["review"]);
    expect(picker.trigger.getAttribute("aria-expanded")).toBe("false");
  });

  test("typing transfers focus to search, filters labels/descriptions/keywords, and Escape restores the trigger", async () => {
    const picker = await mount({ items: searchableItems });
    await picker.open();
    const search = picker.dom.root.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(picker.dom.document.activeElement).toBe(search);
    picker.trigger.focus();
    key(picker.trigger, "c");
    expect(picker.dom.document.activeElement).toBe(search);
    expect(search.value).toBe("c");
    for (const query of ["CAMPAIGN", "two tags", "Review"]) {
      type(search, query);
      expect(picker.rows().map((row) => row.querySelector(".k2b-rich-select__label")?.textContent)).toEqual(["Review"]);
    }
    type(search, "no matching target");
    expect(picker.rows()).toHaveLength(0);
    expect(picker.dom.root.querySelector(".k2b-rich-select__no-results")?.textContent).toBe("No results found");
    type(search, "archive");
    const activeId = search.getAttribute("aria-activedescendant");
    expect(picker.dom.document.getElementById(activeId!)?.textContent).toContain("Archive");
    key(search, "Escape");
    expect(picker.trigger.getAttribute("aria-expanded")).toBe("false");
    expect(picker.dom.document.activeElement).toBe(picker.trigger);
  });

  test("clicking an unavailable row keeps the picker open; clicking an enabled row commits", async () => {
    const picker = await mount();
    await picker.open();
    picker.rows()[1]!.click();
    expect(picker.value()).toBeNull();
    expect(picker.trigger.getAttribute("aria-expanded")).toBe("true");
    picker.rows()[2]!.click();
    expect(picker.value()).toBe("archive");
    expect(picker.commits).toEqual(["archive"]);
    expect(picker.trigger.getAttribute("aria-expanded")).toBe("false");
  });

  test("footer action closes before running the consumer callback", async () => {
    const calls: string[] = [];
    const picker = await mount({
      footer: { label: "Manage targets", onActivate: () => calls.push(picker.trigger.getAttribute("aria-expanded")!) },
    });
    await picker.open();
    picker.dom.root.querySelector<HTMLButtonElement>(".k2b-rich-select__footer-action")!.click();
    expect(calls).toEqual(["false"]);
    expect(picker.dom.document.activeElement).toBe(picker.trigger);
  });

  test("create is prefilled from search, Escape returns to its button, and Enter creates a trimmed name", async () => {
    const calls: string[] = [];
    const picker = await mount({
      items: searchableItems,
      footer: {
        label: "New target",
        create: {
          placeholder: "Target name",
          onCreate: (name) => {
            expect(picker.trigger.getAttribute("aria-expanded")).toBe("false");
            calls.push(name);
          },
        },
      },
    });
    await picker.open();
    type(picker.dom.root.querySelector<HTMLInputElement>('input[type="search"]')!, "New campaign");
    picker.dom.root.querySelector<HTMLButtonElement>(".k2b-rich-select__footer-action")!.click();
    await Promise.resolve();
    let input = picker.dom.root.querySelector<HTMLInputElement>(".k2b-rich-select__create-input")!;
    expect(input.value).toBe("New campaign");
    expect(picker.dom.document.activeElement).toBe(input);
    key(input, "Escape");
    await Promise.resolve();
    expect(picker.trigger.getAttribute("aria-expanded")).toBe("true");
    const action = picker.dom.root.querySelector<HTMLButtonElement>(".k2b-rich-select__footer-action")!;
    expect(picker.dom.document.activeElement).toBe(action);
    action.click();
    await Promise.resolve();
    input = picker.dom.root.querySelector<HTMLInputElement>(".k2b-rich-select__create-input")!;
    type(input, "   ");
    expect(picker.dom.root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    type(input, "  New campaign  ");
    // happy-dom does not perform the browser's implicit form submission for Enter.
    key(input, "Enter");
    input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(calls).toEqual(["New campaign"]);
    expect(picker.value()).toBeNull();
  });

  test("error Retry calls onRetry and empty ready lists render consumer content", async () => {
    let retries = 0;
    const [status, setStatus] = createSignal<"ready" | "error">("error");
    const picker = await mount({
      items: [],
      get status() {
        return status();
      },
      empty: "No targets are set up for this space.",
      onRetry: () => {
        retries++;
        setStatus("ready");
      },
    });
    await picker.open();
    expect(picker.dom.root.querySelector('[role="alert"]')?.textContent).toContain("Could not be loaded.");
    picker.dom.root.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    expect(retries).toBe(1);
    expect(picker.dom.root.querySelector('[role="status"]')?.textContent).toBe("No targets are set up for this space.");
    expect(picker.trigger.getAttribute("aria-expanded")).toBe("true");
  });
});
