import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;
domTest("explains unsupported selection calculations and allows removing an existing formula", async () => {
  const dom = createDomTestHarness();
  const { ObjectListConfigEditor } = await import("./ObjectListConfigEditor");
  const choice = { id: "Choice", name: "Choice", type: "select", config: { options: [{ id: "a", label: "A" }] } };
  const [config, setConfig] = createSignal<Record<string, unknown>>({ fields: [choice] });
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const dispose = render(
    () => createComponent(ObjectListConfigEditor, { config, onChange: setConfig, renderConstraints: () => null }),
    host,
  );
  try {
    const calculationToggle = () => Array.from(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).at(-1)!;
    expect(calculationToggle().disabled).toBe(true);
    expect(host.textContent).toContain("Selection columns use option IDs and cannot be calculated");
    setConfig({ fields: [{ ...choice, formula: { expression: "'a'" } }] });
    expect(calculationToggle().disabled).toBe(false);
    expect(calculationToggle().checked).toBe(true);
    calculationToggle().click();
    expect(calculationToggle().checked).toBe(false);
    expect(calculationToggle().disabled).toBe(true);
  } finally {
    dispose();
    dom.cleanup();
  }
});
domTest("column editing preserves stable identities, unfinished drafts and input focus", async () => {
  const dom = createDomTestHarness();
  const { ObjectListConfigEditor } = await import("./ObjectListConfigEditor");
  const { TextInput } = await import("@k2b/ui");
  const [config, setConfig] = createSignal<Record<string, unknown>>({
    fields: [{ id: "Amount", name: "Amount", type: "number", config: {}, required: false }],
  });
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const dispose = render(
    () =>
      createComponent(ObjectListConfigEditor, {
        config,
        onChange: setConfig,
        renderConstraints: (column, onChange) =>
          createComponent(TextInput, {
            label: "Unit",
            value: () => String(column().config.unit ?? ""),
            onValueChange: (unit) => onChange({ ...column().config, unit }),
          }),
      }),
    host,
  );
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.trim() === label)!;
  try {
    expect(host.querySelector("section")?.getAttribute("data-open")).toBe("false");
    const name = host.querySelector<HTMLInputElement>("input")!;
    name.focus();
    name.value = "";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dom.document.activeElement).toBe(name);
    expect(config().fields).toEqual([{ id: "Amount", name: "", type: "number", config: {}, required: false }]);
    button("Rules and calculation").click();
    expect(host.querySelector("section")?.getAttribute("data-open")).toBe("true");
    const unit = Array.from(host.querySelectorAll<HTMLInputElement>("input")).find(
      (input) => input.id === Array.from(host.querySelectorAll("label")).find((label) => label.textContent === "Unit")?.htmlFor,
    )!;
    unit.focus();
    unit.value = "EUR";
    unit.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dom.document.activeElement).toBe(unit);
    expect(config().fields).toEqual([{ id: "Amount", name: "", type: "number", config: { unit: "EUR" }, required: false }]);
    button("Add column").click();
    await Promise.resolve();
    expect(dom.document.activeElement).toBe(host.querySelectorAll("[data-list-column]").item(1)?.querySelector("input"));
    expect(config().fields).toEqual([
      { id: "Amount", name: "", type: "number", config: { unit: "EUR" }, required: false },
      { id: expect.stringMatching(/^[A-Za-z0-9]{6}$/), name: "", type: "text", config: {}, required: false },
    ]);
  } finally {
    dispose();
    dom.cleanup();
  }
});

domTest("column actions retain identities and focus the moved or remaining column", async () => {
  const dom = createDomTestHarness();
  const { ObjectListConfigEditor } = await import("./ObjectListConfigEditor");
  const amount = { id: "Amount", name: "Amount", type: "number", config: {}, required: false };
  const label = { id: "Label1", name: "Label", type: "text", config: {}, required: false };
  const [config, setConfig] = createSignal<Record<string, unknown>>({ fields: [amount, label] });
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const dispose = render(
    () =>
      createComponent(ObjectListConfigEditor, {
        config,
        onChange: setConfig,
        renderConstraints: () => null,
      }),
    host,
  );
  const button = (index: number, text: string) =>
    Array.from(host.querySelectorAll("[data-list-column]").item(index)!.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === text,
    )!;
  try {
    button(0, "Rules and calculation").click();
    expect(button(0, "Move column up").disabled).toBe(true);
    button(0, "Move column down").click();
    await Promise.resolve();
    expect(config().fields).toEqual([label, amount]);
    expect(dom.document.activeElement).toBe(host.querySelectorAll("[data-list-column]").item(1)?.querySelector("input"));
    expect(host.querySelectorAll("[data-list-column]").item(1)?.querySelector("section")?.getAttribute("data-open")).toBe("true");
    expect(host.querySelectorAll("[data-list-column]").item(0)?.querySelector("section")?.getAttribute("data-open")).toBe("false");
    expect(button(1, "Move column down").disabled).toBe(true);
    button(1, "Remove column").click();
    await Promise.resolve();
    expect(config().fields).toEqual([label]);
    expect(dom.document.activeElement).toBe(host.querySelector("[data-list-column] input"));
    expect(host.querySelector("[data-list-column] section")?.getAttribute("data-open")).toBe("false");
    button(0, "Rules and calculation").click();
    button(0, "Remove column").click();
    await Promise.resolve();
    expect(config().fields).toEqual([]);
    expect(dom.document.activeElement).toBe(host.querySelector("fieldset"));
  } finally {
    dispose();
    dom.cleanup();
  }
});

domTest("row formula errors update in place and calculation help stays in the expanded section", async () => {
  const dom = createDomTestHarness();
  const { ObjectListConfigEditor } = await import("./ObjectListConfigEditor");
  const amount = { id: "Amount", name: "Price", type: "number", config: {}, required: false };
  const total = { id: "Total1", name: "Total", type: "number", config: {}, required: false, formula: { expression: "Missing * 2" } };
  const [config, setConfig] = createSignal<Record<string, unknown>>({ fields: [amount, total] });
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const dispose = render(
    () => createComponent(ObjectListConfigEditor, { config, onChange: setConfig, renderConstraints: () => null }),
    host,
  );
  try {
    const column = host.querySelectorAll("[data-list-column]").item(1)!;
    expect(Boolean(column.querySelector('a[href="/app/grids/help/grids-formulas"]')?.closest("[hidden]"))).toBe(true);
    Array.from(column.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Rules and calculation")!
      .click();
    expect(column.textContent).toContain("Unknown list column Missing");
    expect(column.textContent).toContain("Total1");
    expect(Boolean(column.querySelector('a[href="/app/grids/help/grids-formulas"]')?.closest("[hidden]"))).toBe(false);
    expect(column.querySelector('a[href="/app/grids/help/grids-formulas"]')?.getAttribute("target")).toBe("_blank");
    const label = Array.from(column.querySelectorAll("label")).find((label) => label.textContent === "Row formula")!;
    const input = column.querySelector<HTMLInputElement>(`[id="${label.htmlFor}"]`)!;
    input.focus();
    input.value = "Price * 2";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dom.document.activeElement).toBe(input);
    expect(column.textContent).not.toContain("Unknown list column");
    setConfig({
      fields: [
        { ...amount, name: "Unit price" },
        { ...total, formula: { expression: "Price * 2" } },
      ],
    });
    expect(column.textContent).toContain("Unknown list column Price");
    setConfig({
      fields: [
        { ...amount, name: "Unit price" },
        { ...total, formula: { expression: "Amount * 2" } },
      ],
    });
    expect(column.textContent).not.toContain("Unknown list column");
    setConfig({ fields: [amount, { ...total, formula: { expression: "Total * 2" } }] });
    expect(column.textContent).toContain("Circular list formula dependency");
  } finally {
    dispose();
    dom.cleanup();
  }
});
