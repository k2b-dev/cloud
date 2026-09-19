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
const render = (value: unknown, error?: string, settings: unknown = config, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(ObjectListInput, {
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
        });
      },
    }),
  );

describe("ObjectListInput read-first presentation", () => {
  test("shows compact semantic rows and exact previews without mounting inactive input controls", () => {
    const html = render([{ Amount: "9007199254740993.25" }, { Amount: "0.10" }]);
    expect(html).toContain("<table");
    expect(html).toContain('data-layout="table"');
    expect(html).toContain("9007199254740993.25");
    expect(html).toContain("18014398509481986.5");
    expect(html).toContain('aria-label="Amount · Entry 1"');
    expect(html).toContain('aria-label="Amount · Entry 2"');
    expect(html).not.toContain('aria-label="Total · Entry 1"');
    expect(html).not.toContain("<input");
    expect(html).toContain("Edit entry");
    // The keyboard hint must reserve its space before a row becomes active.
    expect(html).toContain("Tab:");
  });
  test("identifies calculation errors without showing stale stored output", () => {
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
    const html = render([{ Amount: "wrong" }], undefined, config, "de-CH");
    expect(html).toContain("Bitte eine gültige, endliche Zahl eingeben.");
    expect(html).not.toContain("must be a finite number");
  });
  test("distinguishes an empty list from an invalid stored value", () => {
    expect(render([])).toContain("No entries yet");
    expect(render(null)).toContain("Add entry");
    const invalid = render([{ Amount: "1" }, null]);
    expect(invalid).toContain("Nothing has been changed");
    expect(invalid).not.toContain("Add entry");
    expect(invalid).not.toContain("No entries yet");
  });
  test("keeps secondary fields out of the main table while providing a row editor", () => {
    const html = render([{ Amount: "12", Notes1: "Internal context" }], undefined, {
      fields: [...config.fields, { id: "Notes1", name: "Additional note", type: "text", detailsOnly: true }],
    });
    expect(html).not.toContain("Additional note");
    expect(html).not.toContain("Internal context");
    expect(html).toContain("Edit entry");
    expect(html).not.toContain("border-layout");
  });
  test("keeps row-specific server errors visible", () => {
    expect(render([{ Amount: "bad" }], "Row 1, Amount: must be a number")).toContain("Row 1, Amount: must be a number");
  });
  test("shows scalar validation and retains valid previews from other rows", () => {
    const html = render([{ Amount: "12.50" }, { Amount: "bad", Total1: "999.00" }]);
    expect(html).toContain("must be a finite number");
    expect(html).toContain(">25</output>");
    expect(html).not.toContain("999.00");
    expect(html).not.toContain("Complete the row values");
  });
  test("bounds initial displayed rows while retaining the full row count", () => {
    const html = render(Array.from({ length: 60 }, (_, index) => ({ Amount: String(index + 1) })));
    expect(html).toContain("Entries 1–25 of 60");
    expect(html).toContain('data-entry-index="24"');
    expect(html).not.toContain('data-entry-index="25"');
    expect(html).not.toContain("<input");
  });
  test("formats calculated scalar values through the normal cell formatter", () => {
    const html = render([{}], undefined, {
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
    });
    expect(html).toContain(">25%</output>");
    expect(html).toContain(">00:01:30</output>");
    expect(html).toContain(">Yes</output>");
    expect(html).toContain(">EUR 12.50</output>");
  });
});
