import { expect, spyOn, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;
domTest("defaults seed each new entry without refilling existing or cleared values", async () => {
  const dom = createDomTestHarness();
  const { TextInput } = await import("@k2b/ui");
  const { ObjectListInput } = await import("./ObjectListInput");
  const [value, setValue] = createSignal<unknown>([{ Count1: null }]);
  const dispose = render(() => createComponent(ObjectListInput, {
    name: "Items1", label: "Items",
    config: { fields: [{ id: "Count1", name: "Count", type: "number", defaultValue: "1" }] },
    get value() { return value(); }, onChange: setValue,
    renderCell: (column, name, cell, onChange) => createComponent(TextInput, {
      name, label: column.name, value: () => String(cell() ?? ""), onValueChange: onChange,
    }),
  }), dom.root);
  try {
    const add = () => Array.from(dom.root.querySelectorAll("button")).find((button) => button.textContent?.includes("Add entry"))!.click();
    expect(value()).toEqual([{ Count1: null }]);
    add();
    expect(value()).toEqual([{ Count1: null }, { Count1: "1" }]);
    const input = dom.root.querySelector<HTMLInputElement>('[name="Items1-1-Count1"]')!;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    add();
    expect(value()).toEqual([{ Count1: null }, { Count1: "" }, { Count1: "1" }]);
  } finally { dispose(); dom.cleanup(); }
});
domTest("quiet empty state and explicit widths preserve mixed input/output order", async () => {
  const dom = createDomTestHarness();
  const { TextInput } = await import("@k2b/ui");
  const { ObjectListInput } = await import("./ObjectListInput");
  const [value, setValue] = createSignal<unknown>([]);
  const dispose = render(() => createComponent(ObjectListInput, {
    name: "Items1", label: "Measurements",
    config: { fields: [
      { id: "Count1", name: "Count", type: "number", width: "compact" },
      { id: "Double", name: "Double", type: "number", width: "compact", formula: { expression: "Count1 * 2" } },
      { id: "Notes1", name: "Notes", type: "text", width: "fullWidth" },
      { id: "Label1", name: "Label", type: "text", width: "compact", formula: { expression: "CONCAT('Count: ', Count1)" } },
      { id: "Hidden", name: "Helper", type: "number", detailsOnly: true, formula: { expression: "Count1 * 3" } },
    ] },
    get value() { return value(); }, onChange: setValue,
    renderCell: (column, name, cell, onChange) => createComponent(TextInput, { name, label: column.name, value: () => String(cell() ?? ""), onValueChange: onChange }),
  }), dom.root);
  try {
    expect(dom.root.textContent).toContain("No entries yet");
    expect(dom.root.querySelector("button[aria-pressed]")).toBeNull();
    expect(dom.root.querySelector("output")).toBeNull();
    dom.root.querySelector<HTMLButtonElement>("button")!.click();
    await Promise.resolve();
    expect(dom.document.activeElement).toBe(dom.root.querySelector("[data-list-row]"));
    const controls = Array.from(dom.root.querySelectorAll("input, output"));
    expect(controls.map((element) => element.getAttribute("name") ?? element.getAttribute("aria-label"))).toEqual([
      "Items1-0-Count1", "Double", "Items1-0-Notes1", "Label",
    ]);
    const count = dom.root.querySelector<HTMLInputElement>("input")!;
    const layout = dom.root.querySelector("[data-list-row] > .flex-wrap")!;
    expect(Array.from(layout.children).map((child) => child.classList.contains("basis-full"))).toEqual([false, false, true, false]);
    count.value = "3";
    count.dispatchEvent(new Event("input", { bubbles: true }));
    expect(Array.from(dom.root.querySelectorAll("output")).map((output) => output.textContent)).toEqual(["6", "Count: 3"]);
    expect(value()).toEqual([{ Count1: "3" }]);
  } finally { dispose(); dom.cleanup(); }
});
domTest("discloses helper calculations without replacing inputs or changing entered values", async () => {
  const dom = createDomTestHarness();
  const { TextInput } = await import("@k2b/ui");
  const { ObjectListInput } = await import("./ObjectListInput");
  const [value, setValue] = createSignal<unknown>([{ Amount: "12.50" }]);
  const dispose = render(
    () =>
      createComponent(ObjectListInput, {
        name: "Items1",
        label: "Items",
        config: {
          fields: [
            { id: "Amount", name: "Amount", type: "number" },
            { id: "Total1", name: "Total", type: "number", formula: { expression: "Amount * 2" } },
            { id: "Helper", name: "Tax helper", type: "number", detailsOnly: true, formula: { expression: "Amount * 0.2" } },
          ],
        },
        get value() {
          return value();
        },
        onChange: setValue,
        renderCell: (column, name, cell, onChange) =>
          createComponent(TextInput, {
            name,
            label: column.name,
            value: () => String(cell() ?? ""),
            onValueChange: onChange,
          }),
      }),
    dom.root,
  );
  try {
    const input = dom.root.querySelector<HTMLInputElement>('input[name="Items1-0-Amount"]')!;
    const toggle = dom.root.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(dom.root.textContent).not.toContain("Tax helper");
    expect(dom.root.querySelector("output")?.textContent).toBe("25");
    input.focus();
    input.value = "15.25";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dom.document.activeElement).toBe(input);
    toggle.focus();
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(dom.root.textContent).toContain("Tax helper");
    expect(Array.from(dom.root.querySelectorAll("output"), (output) => output.textContent)).toEqual(["30.5", "3.05"]);
    expect(dom.document.activeElement).toBe(toggle);
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(dom.root.textContent).not.toContain("Tax helper");
    expect(dom.document.activeElement).toBe(toggle);
    expect(dom.root.querySelector('input[name="Items1-0-Amount"]')).toBe(input);
    expect(input.value).toBe("15.25");
    expect(value()).toEqual([{ Amount: "15.25" }]);
    input.focus();
    input.value = "16";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dom.document.activeElement).toBe(input);
    expect(value()).toEqual([{ Amount: "16" }]);
    expect(dom.root.querySelector("output")?.textContent).toBe("32");
  } finally {
    dispose();
    dom.cleanup();
  }
});
domTest("pages large drafts without losing hidden edits and recalculates only the edited row", async () => {
  const dom = createDomTestHarness();
  const { TextInput } = await import("@k2b/ui");
  const { ObjectListInput } = await import("./ObjectListInput");
  const { objectListScalarHandlers } = await import("../../../field-types/object-list");
  const validation = spyOn(objectListScalarHandlers.number, "validate");
  const initial = Array.from({ length: 60 }, (_, index) => ({ Amount: String(index + 1) }));
  const [value, setValue] = createSignal<unknown>(initial);
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const dispose = render(
    () =>
      createComponent(ObjectListInput, {
        name: "Items1",
        label: "Items",
        config: {
          fields: [
            { id: "Amount", name: "Amount", type: "number" },
            { id: "Total1", name: "Total", type: "number", formula: { expression: "Amount * 2" } },
          ],
        },
        get value() {
          return value();
        },
        onChange: setValue,
        renderCell: (column, name, cell, onChange) =>
          createComponent(TextInput, {
            name,
            label: column.name,
            value: () => String(cell() ?? ""),
            onValueChange: onChange,
          }),
      }),
    host,
  );
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.trim() === label)!;
  try {
    expect(host.querySelectorAll("[data-list-row]").length).toBe(25);
    const first = host.querySelector<HTMLInputElement>('input[name="Items1-0-Amount"]')!;
    first.focus();
    validation.mockClear();
    first.value = "99.95";
    first.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dom.document.activeElement).toBe(first);
    expect(validation).toHaveBeenCalledTimes(2);
    expect(value()).toEqual([{ Amount: "99.95" }, ...initial.slice(1)]);
    button("Next entries").click();
    await Promise.resolve();
    expect(host.querySelector('input[name="Items1-25-Amount"]')).not.toBeNull();
    expect(host.querySelector('input[name="Items1-0-Amount"]')).toBeNull();
    host.querySelector<HTMLButtonElement>('button[aria-label="Move entry up"]')!.click();
    await Promise.resolve();
    expect(host.textContent).toContain("Entries 1–25 of 60");
    expect(dom.document.activeElement).toBe(host.querySelectorAll("[data-list-row]").item(24));
    const moved = [{ Amount: "99.95" }, ...initial.slice(1, 24), initial[25], initial[24], ...initial.slice(26)];
    expect(value()).toEqual(moved);
    button("Add entry").click();
    await Promise.resolve();
    expect(host.querySelectorAll("[data-list-row]").length).toBe(11);
    expect(host.querySelector('input[name="Items1-60-Amount"]')).not.toBeNull();
    expect(value()).toEqual([...moved, {}]);
    expect(dom.document.activeElement).toBe(host.querySelectorAll("[data-list-row]").item(10));
  } finally {
    dispose();
    validation.mockRestore();
    dom.cleanup();
  }
});
domTest("keeps typing focus and moves focus with row actions", async () => {
  const dom = createDomTestHarness();
  const { TextInput } = await import("@k2b/ui");
  const { ObjectListInput } = await import("./ObjectListInput");
  let dispose: (() => void) | undefined;
  try {
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const [value, setValue] = createSignal<unknown>([{ Amount: "1" }, { Amount: "2" }]);
    dispose = render(
      () =>
        createComponent(ObjectListInput, {
          name: "Items1",
          label: "Items",
          config: { fields: [{ id: "Amount", name: "Amount", type: "number" }] },
          get value() {
            return value();
          },
          onChange: setValue,
          renderCell: (column, name, cell, onChange) =>
            createComponent(TextInput, {
              name,
              label: column.name,
              value: () => String(cell() ?? ""),
              onValueChange: onChange,
            }),
        }),
      host,
    );
    const input = host.querySelector<HTMLInputElement>('input[name="Items1-0-Amount"]')!;
    input.focus();
    input.value = "9007199254740993.25";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dom.document.activeElement).toBe(input);
    expect(value()).toEqual([{ Amount: "9007199254740993.25" }, { Amount: "2" }]);
    host.querySelector<HTMLButtonElement>('button[aria-label="Move entry down"]')!.click();
    await Promise.resolve();
    expect(value()).toEqual([{ Amount: "2" }, { Amount: "9007199254740993.25" }]);
    expect(dom.document.activeElement).toBe(host.querySelectorAll("[data-list-row]").item(1));
    host.querySelector<HTMLButtonElement>('button[aria-label="Remove entry"]')!.click();
    await Promise.resolve();
    expect(value()).toEqual([{ Amount: "9007199254740993.25" }]);
    expect(dom.document.activeElement).toBe(host.querySelector("[data-list-row]"));
  } finally {
    dispose?.();
    dom.cleanup();
  }
});
