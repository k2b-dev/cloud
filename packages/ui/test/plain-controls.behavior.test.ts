import { describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

/** happy-dom has no popover API; the controls only need open state and focus. */
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

const priorities = [
  { id: "high", label: "High", color: "#f97316" },
  { id: "medium", label: "Medium", color: "#eab308" },
];

describe("@k2b/ui plain controls", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("a plain Select shows its value as text and clears through the last list entry", async () => {
    const dom = createDomTestHarness();
    const restore = installPopoverApi(dom);
    const { Select } = await import("../src/inputs/Select");
    const [value, setValue] = createSignal<string | null>("medium");
    const commits: Array<string | null> = [];
    const dispose = render(
      () =>
        createComponent(Select, {
          "aria-label": "Priority",
          appearance: "plain",
          placeholder: "No priority",
          clearable: true,
          value,
          options: priorities,
          onValueCommit: (next) => {
            commits.push(next);
            setValue(next);
          },
        }),
      dom.root,
    );

    const control = dom.root.querySelector<HTMLElement>(".k2b-choice-control")!;
    const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-choice-trigger")!;
    expect(control.dataset.appearance).toBe("plain");
    expect(trigger.textContent).toBe("Medium");
    // No clear button beside the value: clearing is part of the list.
    expect(dom.root.querySelector(".k2b-choice-control__clear")).toBeNull();

    trigger.click();
    const options = () => Array.from(dom.root.querySelectorAll<HTMLButtonElement>("[role='option']"));
    expect(options().map((option) => [option.textContent, option.getAttribute("aria-selected")])).toEqual([
      ["High", "false"],
      ["Medium", "true"],
      ["No priority", "false"],
    ]);
    expect(options()[2]?.dataset.clear).toBe("true");
    options()[2]!.click();
    expect(commits).toEqual([null]);

    // The empty value keeps the dot column with a ring and names itself with the placeholder.
    expect(trigger.querySelector<HTMLElement>(".k2b-choice-dot")?.dataset.empty).toBe("true");
    expect(trigger.querySelector<HTMLElement>(".k2b-choice-trigger__value")?.dataset.placeholder).toBe("true");
    expect(trigger.textContent).toBe("No priority");

    // The keyboard reaches the clear entry too, and it is the selected one while empty.
    trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event);
    expect(options().at(-1)?.getAttribute("aria-selected")).toBe("true");
    expect(options().at(-1)?.dataset.focused).toBe("true");

    dispose();
    restore();
    dom.cleanup();
  });

  test("a field Select keeps its clear button and its list without a clear entry", async () => {
    const dom = createDomTestHarness();
    const restore = installPopoverApi(dom);
    const { Select } = await import("../src/inputs/Select");
    const dispose = render(
      () => createComponent(Select, { "aria-label": "Priority", clearable: true, value: "medium", options: priorities }),
      dom.root,
    );
    expect(dom.root.querySelector<HTMLElement>(".k2b-choice-control")?.dataset.appearance).toBe("field");
    expect(dom.root.querySelector(".k2b-choice-control__clear")).not.toBeNull();
    dom.root.querySelector<HTMLButtonElement>(".k2b-choice-trigger")!.click();
    expect(dom.root.querySelectorAll("[role='option']").length).toBe(2);
    expect(dom.root.querySelector(".k2b-choice-dot[data-empty]")).toBeNull();
    dispose();
    restore();
    dom.cleanup();
  });

  test("a plain Select without colours shows its placeholder icon, also in an action-only select", async () => {
    const dom = createDomTestHarness();
    const restore = installPopoverApi(dom);
    const { Select } = await import("../src/inputs/Select");
    const picked: Array<string | null> = [];
    const dispose = render(
      () =>
        createComponent(Select, {
          "aria-label": "Add blocking task",
          appearance: "plain",
          placeholder: "Task",
          placeholderIcon: "ti ti-plus",
          value: null,
          options: [{ id: "a", label: "Order the stage" }],
          onValueChange: (next) => picked.push(next),
        }),
      dom.root,
    );
    const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-choice-trigger")!;
    expect(trigger.querySelector(".k2b-choice-trigger__placeholder-icon")?.className).toContain("ti-plus");
    expect(trigger.querySelector(".k2b-choice-dot")).toBeNull();
    trigger.click();
    dom.root.querySelector<HTMLButtonElement>("[role='option']")!.click();
    expect(picked).toEqual(["a"]);
    // The caller keeps the value empty, so the trigger stays the add action.
    expect(trigger.textContent).toBe("Task");
    dispose();
    restore();
    dom.cleanup();
  });

  test("a plain MultiSelectInput lists every value without remove buttons or a summary", async () => {
    const dom = createDomTestHarness();
    const restore = installPopoverApi(dom);
    const { MultiSelectInput } = await import("../src/inputs/MultiSelectInput");
    const [value, setValue] = createSignal<string[]>([]);
    const dispose = render(
      () =>
        createComponent(MultiSelectInput, {
          "aria-label": "Tags",
          appearance: "plain",
          placeholder: "Tag",
          placeholderIcon: "ti ti-plus",
          clearable: true,
          value,
          options: [
            { id: "a", label: "Hardware", color: "#2563eb" },
            { id: "b", label: "Office", color: "#16a34a" },
            { id: "c", label: "Network", color: "#9333ea" },
          ],
          onValueChange: setValue,
        }),
      dom.root,
    );
    const trigger = dom.root.querySelector<HTMLElement>(".k2b-multi-select-trigger")!;
    // The icon sits beside the placeholder text, as in Select, so the text keeps its ellipsis.
    expect(trigger.querySelector(":scope > .k2b-choice-trigger__placeholder-icon")).not.toBeNull();
    expect(trigger.querySelector(".k2b-choice-trigger__value .k2b-choice-trigger__placeholder-icon")).toBeNull();
    expect(trigger.textContent).toBe("Tag");

    setValue(["a", "b", "c"]);
    const pills = Array.from(trigger.querySelectorAll<HTMLElement>(".k2b-choice-pill"));
    expect(pills.map((pill) => [pill.textContent, pill.dataset.hidden])).toEqual([
      ["Hardware", undefined],
      ["Office", undefined],
      ["Network", undefined],
    ]);
    expect(trigger.querySelector(".k2b-choice-pill button")).toBeNull();
    expect(trigger.querySelector(".k2b-multi-select-trigger__more")).toBeNull();
    expect(dom.root.querySelector(".k2b-choice-control__clear")).toBeNull();
    dispose();
    restore();
    dom.cleanup();
  });

  test("a plain DateTimePicker renders custom value content and clears from its panel", async () => {
    const dom = createDomTestHarness();
    const restore = installPopoverApi(dom);
    const { DateTimePicker } = await import("../src/inputs/DatePicker");
    const [value, setValue] = createSignal<string | null>("2026-10-06T17:00");
    const commits: Array<string | null> = [];
    const dispose = render(
      () =>
        createComponent(DateTimePicker, {
          "aria-label": "Due",
          appearance: "plain",
          placeholder: "No due date",
          clearable: true,
          value,
          renderValue: (current) => `due ${current}`,
          onValueCommit: (next) => {
            commits.push(next);
            setValue(next);
          },
        }),
      dom.root,
    );
    const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-date-trigger")!;
    expect(trigger.querySelector(".k2b-date-trigger__value")?.textContent).toBe("due 2026-10-06T17:00");
    expect(dom.root.querySelector(".k2b-date-trigger__clear")).toBeNull();
    // The name replaces a button's content, so the shown date reaches assistive technology as the description.
    const description = () =>
      (trigger.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => dom.document.getElementById(id)?.textContent)
        .join(" ");
    expect(trigger.getAttribute("aria-label")).toBe("Due");
    expect(description()).toBe("due 2026-10-06T17:00");

    trigger.click();
    const clear = dom.root.querySelector<HTMLButtonElement>(".k2b-date-popover__clear")!;
    expect(clear.textContent).toBe("Clear date");
    clear.click();
    expect(commits).toEqual([null]);
    expect(trigger.querySelector(".k2b-date-trigger__value")?.textContent).toBe("No due date");
    expect(description()).toBe("No due date");
    expect(dom.root.querySelector(".k2b-date-popover__clear")).toBeNull();
    // Applying a time is localized with the rest of the panel.
    expect(dom.root.querySelector(".k2b-date-apply")?.textContent).toBe("Apply");
    dispose();
    restore();
    dom.cleanup();
  });

  test("a plain NumberInput edits in place: Enter commits, Escape restores, focus stays, no steppers or clear button", async () => {
    const dom = createDomTestHarness();
    const { NumberInput } = await import("../src/inputs/NumberInput");
    const [value, setValue] = createSignal<number | null>(45);
    const commits: Array<number | null> = [];
    const keys: string[] = [];
    const dispose = render(
      () =>
        createComponent(NumberInput, {
          "aria-label": "Estimate",
          appearance: "plain",
          placeholder: "No estimate",
          suffix: "min",
          clearable: true,
          min: 1,
          value,
          // Solid's bound form of an event handler reaches the input too.
          onKeyDown: [(tag: string, event: KeyboardEvent) => keys.push(`${tag} ${event.key}`), "estimate"],
          onValueCommit: (next) => {
            commits.push(next);
            setValue(next);
          },
        }),
      dom.root,
    );
    const shell = dom.root.querySelector<HTMLElement>(".k2b-number-input")!;
    const input = shell.querySelector<HTMLInputElement>('[role="spinbutton"]')!;
    const sizer = () => shell.querySelector<HTMLElement>(".k2b-number-input__sizer")!;
    const key = (name: string) => {
      const event = new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }) as unknown as Event;
      input.dispatchEvent(event);
      return event;
    };
    expect(shell.dataset.appearance).toBe("plain");
    expect(shell.querySelector(".k2b-number-input__step")).toBeNull();
    expect(shell.querySelector(".k2b-input-shell__clear")).toBeNull();
    expect(sizer().dataset.value).toBe("45");
    expect(sizer().dataset.editing).toBeUndefined();
    expect(shell.querySelector(".k2b-input-shell__affix")?.textContent).toBe("min");
    // The unit is part of the value people hear.
    expect(input.getAttribute("aria-valuetext")).toBe("45 min");

    // A click beside the text edits the value.
    shell.click();
    expect(dom.document.activeElement).toBe(input);
    expect(sizer().dataset.editing).toBe("true");

    input.value = "90";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(sizer().dataset.value).toBe("90");
    expect(input.getAttribute("aria-valuetext")).toBe("90 min");
    expect(key("Enter").defaultPrevented).toBe(true);
    expect(commits).toEqual([90]);
    expect(keys).toEqual(["estimate Enter"]);
    // Focus stays in the field, and leaving it does not commit the same text again.
    expect(dom.document.activeElement).toBe(input);
    input.blur();
    expect(commits).toEqual([90]);

    input.focus();
    input.value = "5";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const escape = key("Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(input.value).toBe("90");
    expect(dom.document.activeElement).toBe(input);
    expect(commits).toEqual([90]);

    // Escape without an edit reaches an enclosing panel.
    expect(key("Escape").defaultPrevented).toBe(false);

    // Clearing the text clears the value, and the empty field shows only its placeholder.
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.blur();
    expect(commits.at(-1)).toBeNull();
    expect(shell.querySelector(".k2b-input-shell__affix")).toBeNull();
    expect(sizer().dataset.value).toBe("No estimate");
    expect(sizer().dataset.placeholder).toBe("true");
    expect(input.hasAttribute("aria-valuetext")).toBe(false);
    dispose();
    dom.cleanup();
  });

  test("a plain NumberInput shows its formatted value at rest and the raw number while editing", async () => {
    const dom = createDomTestHarness();
    const { NumberInput } = await import("../src/inputs/NumberInput");
    const [value, setValue] = createSignal<number | null>(90);
    const dispose = render(
      () =>
        createComponent(NumberInput, {
          "aria-label": "Estimate",
          appearance: "plain",
          suffix: "min",
          formatValue: (minutes: number) => (minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`),
          value,
          onValueCommit: setValue,
        }),
      dom.root,
    );
    const shell = dom.root.querySelector<HTMLElement>(".k2b-number-input")!;
    const input = shell.querySelector<HTMLInputElement>('[role="spinbutton"]')!;
    const sizer = () => shell.querySelector<HTMLElement>(".k2b-number-input__sizer")!;
    const suffix = () => shell.querySelector(".k2b-input-shell__affix")?.textContent ?? null;

    // At rest the formatted text carries the unit, so the suffix waits for editing.
    expect(sizer().dataset.value).toBe("1 h 30 min");
    expect(suffix()).toBeNull();
    expect(input.getAttribute("aria-valuetext")).toBe("1 h 30 min");

    input.focus();
    expect(sizer().dataset.value).toBe("90");
    expect(suffix()).toBe("min");
    input.value = "480";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.blur();
    expect(value()).toBe(480);
    expect(sizer().dataset.value).toBe("8 h");
    expect(input.getAttribute("aria-valuetext")).toBe("8 h");
    dispose();
    dom.cleanup();
  });
});
