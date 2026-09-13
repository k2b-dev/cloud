import { expect, test } from "bun:test";
import { ctx, fields, orders } from "../query-dsl/resolver-fixtures";
import { bindWorkflowQueryData } from "./workflow-query-data";

test("semantic query binding has a fixed digest independent of field order and locale", () => {
  const context = ctx({ fieldsByTableId: { [orders.id]: fields.map((field) => ({ ...field, tableId: orders.id })) } });
  const source = "from table Orders\nselect Amount as total";
  const result = bindWorkflowQueryData(source, context, {}, "en");
  if (!result.ok) throw result.error;
  expect(result.data.binding.schemaHash).toBe("88a0668b13b6d2d09d6d67379afb02388b7612d193e40e87b812babf549ffeb8");
  const reordered = bindWorkflowQueryData(
    source,
    {
      ...context,
      fieldsByTableId: { [orders.id]: [...context.fieldsByTableId[orders.id]!].reverse() },
    },
    {},
    "de",
  );
  if (!reordered.ok) throw reordered.error;
  expect(reordered.data.binding).toEqual(result.data.binding);
});
