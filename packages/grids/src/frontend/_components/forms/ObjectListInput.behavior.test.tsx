import { expect, spyOn, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;
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
    button("Next rows").click();
    await Promise.resolve();
    expect(host.querySelector('input[name="Items1-25-Amount"]')).not.toBeNull();
    expect(host.querySelector('input[name="Items1-0-Amount"]')).toBeNull();
    host.querySelector<HTMLButtonElement>('button[aria-label="Move row up"]')!.click();
    await Promise.resolve();
    expect(host.textContent).toContain("Rows 1–25 of 60");
    expect(dom.document.activeElement).toBe(host.querySelectorAll("[data-list-row]").item(24));
    const moved = [{ Amount: "99.95" }, ...initial.slice(1, 24), initial[25], initial[24], ...initial.slice(26)];
    expect(value()).toEqual(moved);
    button("Add row").click();
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
    host.querySelector<HTMLButtonElement>('button[aria-label="Move row down"]')!.click();
    await Promise.resolve();
    expect(value()).toEqual([{ Amount: "2" }, { Amount: "9007199254740993.25" }]);
    expect(dom.document.activeElement).toBe(host.querySelectorAll("[data-list-row]").item(1));
    host.querySelector<HTMLButtonElement>('button[aria-label="Remove row"]')!.click();
    await Promise.resolve();
    expect(value()).toEqual([{ Amount: "9007199254740993.25" }]);
    expect(dom.document.activeElement).toBe(host.querySelector("[data-list-row]"));
  } finally {
    dispose?.();
    dom.cleanup();
  }
});
