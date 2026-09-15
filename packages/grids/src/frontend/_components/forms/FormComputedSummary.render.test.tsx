import { expect, test } from "bun:test";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { FormComputedSummary } from "./FormComputedSummary";

const render = (value: string, locale = "en", expression = "Amount * 1.19") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(FormComputedSummary, {
          config: { fields: [{ kind: "user_input", fieldId: "Amount" }], computedFields: [{ fieldId: "Total1", label: "Total" }] },
          fields: [
            { id: "Amount", name: "Amount", type: "number", config: {}, required: true },
            {
              id: "Total1",
              name: "Total",
              type: "formula",
              config: { expression, format: { kind: "decimal", precision: 2 } },
              required: false,
            },
          ],
          values: { Amount: value },
        });
      },
    }),
  );

test("summary is read-only, formatted and localized", () => {
  const html = render("10");
  expect(html).toContain("11.90");
  expect(html).toContain('aria-live="polite"');
  expect(html).not.toContain("<input");
  expect(html).not.toContain("Complete or correct the values");
  const incomplete = render("", "de");
  expect(incomplete).not.toContain("Vervollständige");
  expect(incomplete).not.toContain("0.00");
});

test("schema drift hides the summary instead of requesting impossible user input", () => {
  const html = render("10", "en", "DeletedField * 1.19");
  expect(html).not.toContain("Total");
  expect(html).not.toContain("Complete or correct the values");
  expect(html).not.toContain('aria-live="polite"');
});

test("empty list dependencies hide the summary; non-financial text results use the same layout", () => {
  const renderList = (values: unknown[]) =>
    renderToString(() =>
      createComponent(FormComputedSummary, {
        config: { fields: [{ kind: "user_input", fieldId: "Items1" }], computedFields: [{ fieldId: "Total1", width: "compact" }] },
        fields: [
          {
            id: "Items1",
            name: "Items",
            type: "object_list",
            required: true,
            config: { fields: [{ id: "Count1", name: "Count", type: "number" }] },
          },
          { id: "Total1", name: "Count", type: "formula", required: false, config: { expression: "LIST_SUM(Items, 'Count1')" } },
        ],
        values: { Items1: values },
      }),
    );
  expect(renderList([])).not.toContain("<section");
  expect(renderList([{ Count1: "3" }])).toContain(">3</dd>");
  const text = render("10", "en", "CONCAT('Count: ', Amount)");
  expect(text).toContain("Count: 10");
  expect(text).not.toContain("font-bold");
  expect(text).not.toContain("<input");
});

test("calculation failures show localized recovery guidance, not incomplete input or raw codes", () => {
  for (const locale of ["en", "de"]) {
    const html = render("0", locale, "1 / Amount");
    expect(html).toContain(locale === "en" ? "The values could not be calculated" : "Die Werte konnten nicht berechnet werden");
    expect(html).not.toContain("Complete or correct the values");
    expect(html).not.toContain("Vervollständige");
    expect(html).not.toContain("DIV_ZERO");
    expect(html).not.toContain("0.00");
  }
});
