import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";

const { FormulaExpressionEditor } = await import("./FormulaExpressionEditor");

test("formula examples have one bounded two-line label and standalone guidance", () => {
  const html = renderToString(() =>
    createComponent(FormulaExpressionEditor, {
      value: () => "",
      onInput: () => {},
      fields: [],
      currentTableId: "TABLE1",
    }),
  );
  expect(html).toContain("grids-formula-example");
  expect(html).toContain("flex min-w-0 flex-col gap-1");
  expect(html).toContain("block truncate font-mono");
  expect(html).toContain("Formula basics");
  expect(html).toContain("k2b-notice-card");
});

test("computed column host can provide guidance once outside the editor", () => {
  const html = renderToString(() =>
    createComponent(FormulaExpressionEditor, {
      value: () => "",
      onInput: () => {},
      fields: [],
      currentTableId: "TABLE1",
      showGuidance: false,
    }),
  );
  expect(html).not.toContain("Formula basics");
  expect(html).toContain("grids-formula-example");
});
