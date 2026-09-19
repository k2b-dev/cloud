import { expect, spyOn, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;
const defaultConfig = {
  fields: [
    { id: "Amount", name: "Amount", type: "number" },
    { id: "Total1", name: "Total", type: "number", formula: { expression: "Amount * 2" } },
  ],
};
const setup = async (initial: unknown, config: unknown = defaultConfig, width?: number) => {
  const dom = createDomTestHarness();
  delegateEvents(["keydown"]);
  const observations = new Set<{ observer: ResizeObserver; callback: ResizeObserverCallback; targets: Set<Element> }>();
  const resize = (width: number) => {
    for (const { observer, callback, targets } of observations) {
      const entries: ResizeObserverEntry[] = Array.from(targets, (target) => {
        const rect = target.getBoundingClientRect();
        Object.defineProperty(rect, "width", { value: width });
        const box = [{ inlineSize: width, blockSize: rect.height }];
        return { target, contentRect: rect, borderBoxSize: box, contentBoxSize: box, devicePixelContentBoxSize: box };
      });
      callback(entries, observer);
    }
  };
  if (width !== undefined) {
    globalThis.ResizeObserver = class implements ResizeObserver {
      private readonly entry;
      constructor(callback: ResizeObserverCallback) {
        this.entry = { observer: this, callback, targets: new Set<Element>() };
        observations.add(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.add(target);
      }
      unobserve(target: Element) {
        this.entry.targets.delete(target);
      }
      disconnect() {
        observations.delete(this.entry);
      }
    };
  }
  const { TextInput, dialogCore } = await import("@k2b/ui");
  const { ObjectListInput } = await import("./ObjectListInput");
  const [value, setValue] = createSignal<unknown>(initial);
  const [error, setError] = createSignal<string>();
  const dispose = render(
    () =>
      createComponent(ObjectListInput, {
        name: "Items1",
        label: "Items",
        config,
        get value() {
          return value();
        },
        get error() {
          return error();
        },
        onChange: setValue,
        renderCell: (column, name, cell, onChange, error) =>
          createComponent(TextInput, {
            name,
            label: column.name,
            value: () => String(cell() ?? ""),
            onValueChange: onChange,
            error,
          }),
      }),
    dom.root,
  );
  const button = (label: string, scope: ParentNode = dom.root) => {
    const result = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.getAttribute("aria-label") === label || button.textContent?.trim() === label,
    );
    expect(result).toBeDefined();
    return result!;
  };
  const click = async (label: string, scope?: ParentNode) => {
    button(label, scope).click();
    await Promise.resolve();
  };
  const input = (name: string, scope: ParentNode = dom.root) => {
    const result = scope.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    expect(result).not.toBeNull();
    return result!;
  };
  const change = (control: HTMLInputElement, value: string) => {
    control.value = value;
    control.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const key = async (control: HTMLElement, key: string, shiftKey = false) => {
    control.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
    await Promise.resolve();
  };
  if (width !== undefined) resize(width);
  return {
    dom,
    value,
    setValue,
    setError,
    button,
    click,
    input,
    change,
    key,
    resize,
    cleanup: () => {
      dialogCore.close();
      dispose();
      dom.cleanup();
    },
  };
};

domTest("activates only the chosen row, updates the parent immediately, and supports Escape and Enter", async () => {
  const f = await setup([{ Amount: "1" }, { Amount: "2" }]);
  try {
    expect(f.dom.root.querySelector("input")).toBeNull();
    await f.click("Amount · Entry 1");
    const input = f.input("Items1-0-Amount");
    expect(f.dom.root.querySelector('input[name="Items1-1-Amount"]')).toBeNull();
    expect(f.dom.document.activeElement).toBe(input);
    f.change(input, "9007199254740993.25");
    expect(f.value()).toEqual([{ Amount: "9007199254740993.25" }, { Amount: "2" }]);
    expect(f.dom.document.activeElement).toBe(input);
    expect(f.dom.root.textContent).toContain("18014398509481986.5");
    await f.key(input, "Escape");
    expect(f.value()).toEqual([{ Amount: "1" }, { Amount: "2" }]);
    expect(f.dom.root.querySelector("input")).toBeNull();
    await f.click("Amount · Entry 2");
    const second = f.input("Items1-1-Amount");
    f.change(second, "3");
    await f.key(second, "Enter");
    expect(f.value()).toEqual([{ Amount: "1" }, { Amount: "3" }]);
    expect(f.dom.root.querySelector("input")).toBeNull();
  } finally {
    f.cleanup();
  }
});

domTest("defaults seed each added entry without refilling existing or cleared values", async () => {
  const f = await setup([{ Count1: null }], { fields: [{ id: "Count1", name: "Count", type: "number", defaultValue: "1" }] });
  try {
    expect(f.value()).toEqual([{ Count1: null }]);
    await f.click("Add entry");
    expect(f.value()).toEqual([{ Count1: null }, { Count1: "1" }]);
    const input = f.input("Items1-1-Count1");
    f.change(input, "");
    await f.key(input, "Enter");
    await f.click("Add entry");
    expect(f.value()).toEqual([{ Count1: null }, { Count1: "" }, { Count1: "1" }]);
  } finally {
    f.cleanup();
  }
});

domTest("preserves parent data while paging and recalculates only the changed row", async () => {
  const initial = Array.from({ length: 60 }, (_, index) => ({ Amount: String(index + 1) }));
  const f = await setup(initial);
  const { objectListScalarHandlers } = await import("../../../field-types/object-list");
  const validation = spyOn(objectListScalarHandlers.number, "validate");
  try {
    expect(f.dom.root.querySelectorAll("tbody tr").length).toBe(25);
    await f.click("Amount · Entry 1");
    validation.mockClear();
    const first = f.input("Items1-0-Amount");
    f.change(first, "99.95");
    expect(validation.mock.calls.length).toBeGreaterThan(0);
    expect(validation.mock.calls.some(([value]) => value === "2" || value === "3" || value === "25")).toBe(false);
    expect(f.value()).toEqual([{ Amount: "99.95" }, ...initial.slice(1)]);
    await f.click("Next entries");
    expect(f.dom.root.textContent).toContain("Entries 26–50 of 60");
    expect(f.dom.root.querySelector('[data-entry-index="0"]')).toBeNull();
    await f.click("Amount · Entry 26");
    f.change(f.input("Items1-25-Amount"), "88");
    await f.click("Previous entries");
    await f.click("Amount · Entry 1");
    expect(f.input("Items1-0-Amount").value).toBe("99.95");
    expect(f.value()).toEqual([{ Amount: "99.95" }, ...initial.slice(1, 25), { Amount: "88" }, ...initial.slice(26)]);
  } finally {
    validation.mockRestore();
    f.cleanup();
  }
});

domTest("Tab crosses rows without losing edits and Shift+Tab returns to the preceding row", async () => {
  const f = await setup([{ Amount: "1" }, { Amount: "2" }]);
  try {
    await f.click("Amount · Entry 1");
    const first = f.input("Items1-0-Amount");
    f.change(first, "3");
    await f.key(first, "Tab");
    const second = f.input("Items1-1-Amount");
    expect(f.dom.document.activeElement).toBe(second);
    expect(f.dom.root.querySelector('input[name="Items1-0-Amount"]')).toBeNull();
    await f.key(second, "Tab", true);
    expect(f.dom.document.activeElement).toBe(f.input("Items1-0-Amount"));
    expect(f.value()).toEqual([{ Amount: "3" }, { Amount: "2" }]);
  } finally {
    f.cleanup();
  }
});

domTest("one-field lists remain inline on narrow screens while wide lists use a summary", async () => {
  const narrow = await setup([{ Name01: "One item" }], { fields: [{ id: "Name01", name: "Name", type: "text" }] }, 390);
  try {
    expect(narrow.dom.root.querySelector('[data-layout="table"]')).not.toBeNull();
    await narrow.click("Name · Entry 1");
    expect(narrow.input("Items1-0-Name01").value).toBe("One item");
  } finally {
    narrow.cleanup();
  }
  const wide = await setup(
    [{ Name01: "One item", Notes1: "Context", Detail: "More context" }],
    {
      fields: [
        { id: "Name01", name: "Name", type: "text" },
        { id: "Notes1", name: "Notes", type: "text" },
        { id: "Detail", name: "Detail", type: "text" },
      ],
    },
    390,
  );
  try {
    expect(wide.dom.root.querySelector('[data-layout="summary"]')).not.toBeNull();
    expect(wide.dom.root.textContent).toContain("One item");
    expect(wide.dom.root.querySelector("input")).toBeNull();
    wide.resize(1400);
    await Promise.resolve();
    expect(wide.dom.root.querySelector('[data-layout="table"]')).not.toBeNull();
    expect(wide.value()).toEqual([{ Name01: "One item", Notes1: "Context", Detail: "More context" }]);
  } finally {
    wide.cleanup();
  }
});

domTest("six-column lists remain editable inline at 840px and preserve edits when space becomes narrow", async () => {
  const fields = [
    { id: "Title1", name: "Title", type: "text" },
    { id: "Count1", name: "Count", type: "number" },
    { id: "Unit01", name: "Unit", type: "select", config: { options: [{ id: "hour", label: "Hours" }] } },
    { id: "Price1", name: "Price", type: "number" },
    { id: "Rate01", name: "Rate", type: "number" },
    { id: "Total1", name: "Total", type: "number", formula: { expression: "Count1 * Price1" } },
  ];
  const f = await setup([{ Title1: "Service", Count1: "2", Unit01: ["hour"], Price1: "120", Rate01: "19" }], { fields }, 840);
  try {
    expect(f.dom.root.querySelector('[data-layout="table"]')).not.toBeNull();
    await f.click("Count · Entry 1");
    f.change(f.input("Items1-0-Count1"), "3");
    await f.key(f.input("Items1-0-Count1"), "Enter");
    f.resize(390);
    await Promise.resolve();
    expect(f.dom.root.querySelector('[data-layout="summary"]')).not.toBeNull();
    expect(f.value()).toEqual([{ Title1: "Service", Count1: "3", Unit01: ["hour"], Price1: "120", Rate01: "19" }]);
    f.resize(840);
    await Promise.resolve();
    expect(f.dom.root.querySelector('[data-layout="table"]')).not.toBeNull();
  } finally {
    f.cleanup();
  }
});

domTest("entry dialogs edit a local draft and apply or cancel within the parent form", async () => {
  const f = await setup([{ Amount: "12.50", Notes1: "Original" }], {
    fields: [...defaultConfig.fields, { id: "Notes1", name: "Notes", type: "text", detailsOnly: true }],
  });
  try {
    await f.click("Edit entry");
    let dialog = f.dom.document.querySelector("dialog")!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("Entry 1");
    f.change(f.input("Items1-entry-Notes1", dialog), "Cancelled edit");
    expect(f.value()).toEqual([{ Amount: "12.50", Notes1: "Original" }]);
    await f.click("Cancel", dialog);
    await Bun.sleep(5);
    expect(f.dom.document.querySelector("dialog")).toBeNull();
    expect(f.value()).toEqual([{ Amount: "12.50", Notes1: "Original" }]);
    await f.click("Edit entry");
    dialog = f.dom.document.querySelector("dialog")!;
    expect(f.input("Items1-entry-Notes1", dialog).value).toBe("Original");
    f.change(f.input("Items1-entry-Notes1", dialog), "Applied edit");
    f.change(f.input("Items1-entry-Amount", dialog), "15.25");
    expect(dialog.querySelector('output[aria-label="Total"]')?.textContent).toBe("30.5");
    await f.click("Apply", dialog);
    await Bun.sleep(5);
    expect(f.dom.document.querySelector("dialog")).toBeNull();
    expect(f.value()).toEqual([{ Amount: "15.25", Notes1: "Applied edit" }]);
  } finally {
    f.cleanup();
  }
});

domTest("Apply & add another saves only accepted dialog drafts and seeds fresh defaults", async () => {
  const f = await setup(
    [],
    {
      maxItems: 2,
      fields: [
        { id: "Count1", name: "Count", type: "number", defaultValue: "1" },
        { id: "Notes1", name: "Notes", type: "text", defaultValue: "New entry" },
      ],
    },
    200,
  );
  try {
    await f.click("Add entry");
    let dialog = f.dom.document.querySelector("dialog")!;
    expect(dialog).not.toBeNull();
    expect(f.value()).toEqual([]);
    expect(f.input("Items1-entry-Count1", dialog).value).toBe("1");
    f.change(f.input("Items1-entry-Count1", dialog), "4");
    await f.click("Apply & add another", dialog);
    await Bun.sleep(5);
    expect(f.value()).toEqual([{ Count1: "4", Notes1: "New entry" }]);
    dialog = f.dom.document.querySelector("dialog")!;
    expect(dialog).not.toBeNull();
    expect(f.input("Items1-entry-Count1", dialog).value).toBe("1");
    expect(dialog.textContent).not.toContain("Apply & add another");
    await f.click("Cancel", dialog);
    await Bun.sleep(5);
    expect(f.value()).toEqual([{ Count1: "4", Notes1: "New entry" }]);
    expect(f.dom.document.querySelector("dialog")).toBeNull();
  } finally {
    f.cleanup();
  }
});

domTest("server validation reveals an invalid additional field on a hidden page", async () => {
  const rows = Array.from({ length: 26 }, (_, index) => ({ Name01: String(index), Notes1: index === 25 ? "too long" : "ok" }));
  const f = await setup(rows, {
    fields: [
      { id: "Name01", name: "Name", type: "text" },
      { id: "Notes1", name: "Notes", type: "text", config: { maxLength: 3 }, detailsOnly: true },
    ],
  });
  try {
    expect(f.dom.root.querySelector("input")).toBeNull();
    f.setError("Invalid list");
    await Promise.resolve();
    const dialog = f.dom.document.querySelector("dialog")!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("Entry 26");
    const input = f.input("Items1-entry-Notes1", dialog);
    expect(input.value).toBe("too long");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(f.dom.document.activeElement).toBe(input);
    await f.click("Apply", dialog);
    expect(f.dom.document.querySelector("dialog")).not.toBeNull();
    expect(f.value()).toEqual(rows);
    f.change(input, "ok");
    await f.click("Apply", dialog);
    await Bun.sleep(5);
    expect(f.value()).toEqual([...rows.slice(0, 25), { Name01: "25", Notes1: "ok" }]);
  } finally {
    f.cleanup();
  }
});

domTest("resizing preserves the active input until editing finishes", async () => {
  const f = await setup(
    [{ Name01: "One", Notes1: "Details" }],
    {
      fields: [
        { id: "Name01", name: "Name", type: "text" },
        { id: "Notes1", name: "Notes", type: "text" },
      ],
    },
    900,
  );
  try {
    await f.click("Name · Entry 1");
    const input = f.input("Items1-0-Name01");
    f.change(input, "Changed");
    f.resize(200);
    expect(f.dom.root.querySelector('[data-layout="table"]')).not.toBeNull();
    expect(f.dom.document.activeElement).toBe(input);
    await f.key(input, "Enter");
    expect(f.dom.root.querySelector('[data-layout="summary"]')).not.toBeNull();
    expect(f.value()).toEqual([{ Name01: "Changed", Notes1: "Details" }]);
  } finally {
    f.cleanup();
  }
});

domTest("a parent replacement cannot be overwritten by Escape or a stale dialog apply", async () => {
  const f = await setup([{ Amount: "1" }]);
  try {
    await f.click("Amount · Entry 1");
    const input = f.input("Items1-0-Amount");
    f.change(input, "2");
    f.setValue([{ Amount: "3" }]);
    f.change(input, "4");
    await f.key(input, "Escape");
    expect(f.value()).toEqual([{ Amount: "3" }]);
    await f.click("Edit entry");
    const dialog = f.dom.document.querySelector("dialog")!;
    f.change(f.input("Items1-entry-Amount", dialog), "4");
    f.setValue([{ Amount: "5" }]);
    await f.click("Apply", dialog);
    await Bun.sleep(5);
    expect(f.value()).toEqual([{ Amount: "5" }]);
  } finally {
    f.cleanup();
  }
});

domTest("row dialog move and remove actions update the enclosing list without persisting cancelled drafts", async () => {
  const f = await setup([{ Amount: "1" }, { Amount: "2" }]);
  try {
    await f.click("Edit entry");
    f.change(f.input("Items1-entry-Amount", f.dom.document.querySelector("dialog")!), "3");
    await f.click("Move entry down", f.dom.document.querySelector("dialog")!);
    await Bun.sleep(5);
    expect(f.value()).toEqual([{ Amount: "2" }, { Amount: "3" }]);
    const movedDialog = f.dom.document.querySelector("dialog")!;
    expect(f.input("Items1-entry-Amount", movedDialog).value).toBe("3");
    await f.click("Cancel", movedDialog);
    await Bun.sleep(5);
    await f.click("Edit entry");
    await f.click("Remove entry", f.dom.document.querySelector("dialog")!);
    await Bun.sleep(5);
    expect(f.value()).toEqual([{ Amount: "3" }]);
    await f.click("Edit entry");
    const dialog = f.dom.document.querySelector("dialog")!;
    f.change(f.input("Items1-entry-Amount", dialog), "Cancelled");
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await Bun.sleep(5);
    expect(f.dom.document.querySelector("dialog")).toBeNull();
    expect(f.value()).toEqual([{ Amount: "3" }]);
    await f.click("Add entry");
    await f.key(f.input("Items1-1-Amount"), "Escape");
    expect(f.value()).toEqual([{ Amount: "3" }]);
  } finally {
    f.cleanup();
  }
});

domTest("finishing a formula-first row restores an editable cell and cancelling a new row restores Add", async () => {
  const f = await setup([{ Amount: "1" }], { fields: [defaultConfig.fields[1], defaultConfig.fields[0]] });
  try {
    await f.click("Amount · Entry 1");
    await f.key(f.input("Items1-0-Amount"), "Enter");
    expect(f.dom.document.activeElement).toBe(f.button("Amount · Entry 1"));
    await f.click("Add entry");
    expect(f.dom.document.activeElement).toBe(f.input("Items1-1-Amount"));
    await f.key(f.input("Items1-1-Amount"), "Escape");
    expect(f.value()).toEqual([{ Amount: "1" }]);
    expect(f.dom.document.activeElement).toBe(f.button("Add entry"));
  } finally {
    f.cleanup();
  }
});

domTest("percent inputs use the same Enter and Escape row shortcuts", async () => {
  const f = await setup([{ Rate01: 25 }], { fields: [{ id: "Rate01", name: "Rate", type: "percent" }] });
  try {
    await f.click("Rate · Entry 1");
    await f.key(f.input("Items1-0-Rate01"), "Enter");
    expect(f.dom.root.querySelector("input")).toBeNull();
    await f.click("Rate · Entry 1");
    const input = f.input("Items1-0-Rate01");
    f.change(input, "30");
    await f.key(input, "Escape");
    expect(f.value()).toEqual([{ Rate01: 25 }]);
    expect(f.dom.root.querySelector("input")).toBeNull();
  } finally {
    f.cleanup();
  }
});

domTest("an unchanged server error does not steal focus while editing a different row", async () => {
  const f = await setup([{ Amount: "invalid" }, { Amount: "2" }]);
  try {
    f.setError("Invalid list");
    await Promise.resolve();
    expect(f.dom.document.activeElement).toBe(f.input("Items1-0-Amount"));
    await f.click("Amount · Entry 2");
    const input = f.input("Items1-1-Amount");
    f.change(input, "3");
    await Promise.resolve();
    expect(f.dom.document.activeElement).toBe(input);
    expect(f.dom.root.querySelector('input[name="Items1-0-Amount"]')).toBeNull();
    expect(f.value()).toEqual([{ Amount: "invalid" }, { Amount: "3" }]);
  } finally {
    f.cleanup();
  }
});

domTest("nested control dialogs and listboxes retain ownership of Tab", async () => {
  const f = await setup([{ Amount: "1" }, { Amount: "2" }]);
  try {
    await f.click("Amount · Entry 1");
    const cell = f.dom.root.querySelector('[data-entry-index="0"][data-column-id="Amount"]')!;
    for (const kind of ["dialog", "listbox", "popover"]) {
      const popup = f.dom.document.createElement("div");
      if (kind === "popover") popup.setAttribute("popover", "");
      else popup.setAttribute("role", kind);
      const control = f.dom.document.createElement("input");
      popup.append(control);
      cell.append(popup);
      control.focus();
      const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      control.dispatchEvent(event);
      await Promise.resolve();
      expect(event.defaultPrevented).toBe(false);
      expect(f.dom.document.activeElement).toBe(control);
      expect(f.dom.root.querySelector('input[name="Items1-1-Amount"]')).toBeNull();
      popup.remove();
    }
  } finally {
    f.cleanup();
  }
});

domTest("entry dialogs preserve the surrounding unsaved parent dialog", async () => {
  const dom = createDomTestHarness();
  delegateEvents(["keydown"]);
  const { Button, TextInput, prompts, dialogCore } = await import("@k2b/ui");
  const { ObjectListInput } = await import("./ObjectListInput");
  const [subject, setSubject] = createSignal("Draft subject");
  const [entries, setEntries] = createSignal<unknown>([{ Amount: "1" }]);
  const parent = prompts.dialog<string>(
    (close) => (
      <div>
        <TextInput name="parent-subject" label="Subject" value={subject} onValueChange={setSubject} />
        <ObjectListInput
          name="Items1"
          label="Items"
          config={defaultConfig}
          value={entries()}
          onChange={setEntries}
          renderCell={(column, name, value, onChange, error) => (
            <TextInput name={name} label={column.name} value={() => String(value() ?? "")} onValueChange={onChange} error={error} />
          )}
        />
        <Button onClick={() => close("done")}>Finish parent</Button>
      </div>
    ),
    { title: "Unsaved parent form" },
  );
  const button = (label: string, scope: ParentNode = dom.document) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.getAttribute("aria-label") === label || button.textContent?.trim() === label,
    )!;
  try {
    const subjectInput = dom.document.querySelector<HTMLInputElement>('input[name="parent-subject"]')!;
    subjectInput.value = "Unsaved change";
    subjectInput.dispatchEvent(new Event("input", { bubbles: true }));
    button("Edit entry").click();
    await Promise.resolve();
    const child = dom.document.querySelector(".grids-object-entry-dialog")!;
    expect(child).not.toBeNull();
    const amount = child.querySelector<HTMLInputElement>('input[name="Items1-entry-Amount"]')!;
    amount.value = "2";
    amount.dispatchEvent(new Event("input", { bubbles: true }));
    button("Apply", child).click();
    await Bun.sleep(5);
    expect(dom.document.querySelector(".grids-object-entry-dialog")).toBeNull();
    expect(dialogCore.isOpen()).toBe(true);
    expect(dom.document.querySelector('input[name="parent-subject"]')).toBe(subjectInput);
    expect(subjectInput.value).toBe("Unsaved change");
    expect(subject()).toBe("Unsaved change");
    expect(entries()).toEqual([{ Amount: "2" }]);
    button("Finish parent").click();
    expect(await parent).toBe("done");
    expect(dialogCore.isOpen()).toBe(false);
  } finally {
    dialogCore.close();
    dom.cleanup();
  }
});
