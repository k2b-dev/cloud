import { describe, expect, test } from "bun:test";
import { LocaleProvider, TextInput } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { ObjectListInput } from "./ObjectListInput";

const config = {
  fields: [
    { id: "Amount", name: "Amount", type: "number", required: true },
    { id: "Total1", name: "Total", type: "number", formula: { expression: "Amount * 2" } },
  ],
};
const render = (value: unknown, error?: string, settings: unknown = config) =>
  renderToString(() =>
    createComponent(ObjectListInput, {
      name: "Items1",
      label: "Invoice items",
      config: settings,
      value,
      error,
      onChange: () => undefined,
      renderCell: (column, name, value, onChange, error) =>
        createComponent(TextInput, {
          name,
          label: column.name,
          value: () => String(value() ?? ""),
          onValueChange: onChange,
          error,
        }),
    }),
  );

describe("ObjectListInput", () => {
  test("identifies calculation errors without asking users to complete already valid input", () => {
    const settings = {
      fields: config.fields.map((field) => (field.formula ? { ...field, formula: { expression: "Amount / 0" } } : field)),
    };
    const html = render([{ Amount: "12", Total1: "999" }], undefined, settings);
    expect(html).toContain("Total: Cannot divide by zero.");
    expect(html).toContain("ask a base administrator");
    expect(html).not.toContain("Complete the row values");
    expect(html).not.toContain("999");
  });
  test("inherits the UI locale for cell validation", () => {
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de-CH",
        get children() {
          return createComponent(ObjectListInput, {
            name: "Items1",
            label: "Positionen",
            config,
            value: [{ Amount: "wrong" }],
            onChange: () => undefined,
            renderCell: (column, name, value, onChange, error) =>
              createComponent(TextInput, {
                name,
                label: column.name,
                value: () => String(value() ?? ""),
                onValueChange: onChange,
                error,
              }),
          });
        },
      }),
    );
    expect(html).toContain("Bitte eine gültige, endliche Zahl eingeben.");
    expect(html).not.toContain("must be a finite number");
  });
  test("renders exact values with unique control names and non-editable calculations", () => {
    const html = render([{ Amount: "9007199254740993.25" }, { Amount: "0.10" }]);
    expect(html).toContain("9007199254740993.25");
    expect(html).toContain('name="Items1-0-Amount"');
    expect(html).toContain('name="Items1-1-Amount"');
    expect(html).not.toContain('name="Items1-0-Total1"');
    expect(html).not.toContain("Calculated values are a preview");
    expect(html).toContain("18014398509481986.5");
    expect(html).toContain("Move entry up");
    expect(html).toContain("Remove entry");
  });
  test("distinguishes an empty list from an invalid stored value", () => {
    expect(render([])).toContain("No entries yet");
    expect(render(null)).toContain("Add entry");
    const invalid = render([{ Amount: "1" }, null]);
    expect(invalid).toContain("Nothing has been changed");
    expect(invalid).not.toContain("Add entry");
    expect(invalid).not.toContain("No entries yet");
  });
  test("uses the shared quiet surface and a real pressed toggle", () => {
    const html = render([{ Amount: "12" }], undefined, {
      fields: [
        ...config.fields,
        { id: "More01", name: "Detail", type: "number", detailsOnly: true, formula: { expression: "Amount * 3" } },
      ],
    });
    expect(html).toContain('class="paper ');
    expect(html).not.toContain("border-layout");
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("ti-eye");
    expect(html).not.toContain("aria-expanded");
    expect(render([{}])).not.toContain("—");
  });
  test("keeps row-specific server errors visible", () => {
    expect(render([{ Amount: "bad" }], "Row 1, Amount: must be a number")).toContain("Row 1, Amount: must be a number");
  });
  test("shows scalar validation at the cell and never renders stale calculated values", () => {
    const html = render([{ Amount: "not a number", Total1: "999.00" }]);
    expect(html).toContain("must be a finite number");
    expect(html).not.toContain("999.00");
    expect(html).not.toContain("Complete the row values");
  });
  test("keeps valid row previews visible when another row is incomplete", () => {
    const html = render([{ Amount: "12.50" }, { Amount: "bad", Total1: "999" }]);
    expect(html).toContain(">25</output>");
    expect(html).not.toContain("999");
    expect(html).not.toContain("Complete the row values");
  });
  test("bounds initial controls while retaining the full row count", () => {
    const html = render(Array.from({ length: 60 }, (_, index) => ({ Amount: String(index + 1) })));
    expect(html).toContain("Entries 1–25 of 60");
    expect(html).toContain('name="Items1-24-Amount"');
    expect(html).not.toContain('name="Items1-25-Amount"');
    expect(html.match(/data-list-row/g)?.length).toBe(25);
  });
  test("formats calculated scalar values through the normal cell renderer", () => {
    const html = renderToString(() =>
      createComponent(ObjectListInput, {
        name: "Items1",
        label: "Items",
        value: [{}],
        onChange: () => undefined,
        renderCell: () => null,
        config: {
          fields: [
            { id: "Rate01", name: "Rate", type: "percent", config: { range: "fraction" }, formula: { expression: "0.25" } },
            { id: "Time01", name: "Time", type: "duration", formula: { expression: "90" } },
            { id: "Active", name: "Active", type: "boolean", formula: { expression: "true" } },
            {
              id: "Amount",
              name: "Amount",
              type: "number",
              config: { unit: "EUR", unitPosition: "prefix", decimalPlaces: 2 },
              formula: { expression: "12.5" },
            },
          ],
        },
      }),
    );
    expect(html).toContain(">25%</output>");
    expect(html).toContain(">00:01:30</output>");
    expect(html).toContain(">Yes</output>");
    expect(html).toContain(">EUR 12.50</output>");
  });
});
