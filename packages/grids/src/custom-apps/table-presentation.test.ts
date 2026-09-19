import { expect, test } from "bun:test";
import { customAppTablePresentationIssues } from "./table-presentation";

const columns = [
  { key: "q_col_0", label: "customer", fieldId: "FIELD1", sqlType: "text" },
  { key: "q_col_1", label: "deadline", fieldId: "FIELD2", sqlType: "date" },
  { key: "q_col_2", label: "created", fieldId: "FIELD3", sqlType: "datetime" },
];
test("GQL presentation validates output labels and rejects fields outside its result", () => {
  expect(
    customAppTablePresentationIssues(
      { relativeDateColumnIds: ["deadline"], mobile: { titleColumnId: "customer", detailColumnIds: ["deadline"] } },
      columns,
      "label",
    ),
  ).toEqual([]);
  expect(
    customAppTablePresentationIssues({ mobile: { titleColumnId: "FIELD1", detailColumnIds: ["secret"] } }, columns, "label"),
  ).toHaveLength(2);
});
test("Views identify columns by field and relative dates reject timestamps and text", () => {
  expect(customAppTablePresentationIssues({ relativeDateColumnIds: ["FIELD2"] }, columns, "field")).toEqual([]);
  expect(
    customAppTablePresentationIssues({ relativeDateColumnIds: ["FIELD1", "FIELD3", "missing"] }, columns, "field").map(
      (issue) => issue.code,
    ),
  ).toEqual(["records.relative_date_type", "records.relative_date_type", "records.presentation_column"]);
});
