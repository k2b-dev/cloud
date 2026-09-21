import { expect, test } from "bun:test";
import { customAppDocumentPreviewSourceIsSafe } from "./document-preview-capability";

test("document preview source accepts only static GQL and trusted record IDs", () => {
  for (const value of ["{{ record.id }}", "{{record.shortId}}", "ABC123"]) {
    expect(customAppDocumentPreviewSourceIsSafe(`from table {ABC123}\nselect {FIELD1}\nwhere record.id = '${value}'\nlimit 1`)).toBe(true);
  }
});

test("document preview source rejects editable data, filters, tags and malformed GQL", () => {
  for (const value of [
    "{{ record.data.Name01 }}",
    "{{ business.name }}",
    "{{ record.id | append: record.data.Name01 }}",
    "{{- record.id -}}",
    "{% assign x = record.data.Name01 %}{{ x }}",
    "{{ record['id'] }}",
  ]) {
    expect(customAppDocumentPreviewSourceIsSafe(`from table {ABC123}\nselect {FIELD1}\nwhere record.id = '${value}'`)).toBe(false);
  }
  expect(customAppDocumentPreviewSourceIsSafe("not a query")).toBe(false);
});
