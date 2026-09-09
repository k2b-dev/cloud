import { expect, test } from "bun:test";
import { FileOpenOptions, UiNode } from "../src/runtime/protocol";

test("select options require visible labels while preserving distinct values and presentation", () => {
  const option = {
    value: "\t",
    label: "Tabulator",
    icon: "ti ti-arrow-right",
    description: "Tab-separated columns",
  };
  const node = { id: "separator", kind: "select", options: [option] };
  expect(UiNode.parse(node).options).toEqual([option]);
  for (const options of [["\t"], [{ value: "\t" }], [{ value: "\t", label: "\t" }], [{ label: "Tabulator" }]]) {
    expect(UiNode.safeParse({ ...node, options }).success).toBe(false);
  }
});

test("file picker accepts optional type filters and rejects invalid options", () => {
  expect(FileOpenOptions.parse({ accept: ".csv,text/csv" }).accept).toBe(".csv,text/csv");
  expect(FileOpenOptions.parse({})).toEqual({});
  expect(FileOpenOptions.safeParse({ accept: [".csv"] }).success).toBe(false);
});

test("navigation only accepts explicit user-navigation protocols", () => {
  for (const href of ["/app/kit", "https://example.com", "mailto:hello@example.com", "#results"])
    expect(UiNode.safeParse({ id: "link", kind: "link", link: { href } }).success).toBe(true);
  for (const href of ["javascript:alert(1)", "java\nscript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://example.com"])
    expect(UiNode.safeParse({ id: "link", kind: "link", link: { href } }).success).toBe(false);
});
