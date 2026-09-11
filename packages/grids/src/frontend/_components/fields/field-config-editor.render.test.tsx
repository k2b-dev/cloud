import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { FieldConfigEditor } from "./field-config-editor";

const render = (type: string) =>
  renderToString(() =>
    createComponent(FieldConfigEditor, {
      type,
      config: () => ({}),
      onChange: () => undefined,
      currentTableId: "Table1",
      otherTables: [],
      fieldsByTable: {},
    }),
  );

test("percent and duration editors do not advertise unsupported numeric constraints", () => {
  const percent = render("percent");
  expect(percent).toContain("Input scale");
  expect(percent).toContain("Decimal places");
  expect(percent).not.toContain("Unit (optional)");
  expect(percent).not.toContain("Minimum (optional)");
  const duration = render("duration");
  expect(duration).not.toContain("Unit (optional)");
  expect(duration).not.toContain("Decimal places");
  const number = render("number");
  expect(number).toContain("Unit (optional)");
  expect(number).toContain("Minimum (optional)");
});
