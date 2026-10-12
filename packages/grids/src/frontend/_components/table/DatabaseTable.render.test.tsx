import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";
import { field, fields, records } from "./database-table.fixture-data";

const { default: DatabaseTable } = await import("./DatabaseTable");

const bodyCells = (html: string) => [
  ...html
    .split("<tbody>")[1]!
    .split("</tr>")[0]!
    .matchAll(/<td\b[^>]*>/g),
];

describe("DatabaseTable wrapping", () => {
  test("keeps dates and amounts intact while text can wrap", () => {
    const html = renderToString(() =>
      createComponent(DatabaseTable, { result: { items: [records[0]!], fields, nextCursor: null }, baseId: "base" }),
    );
    const nowrap = bodyCells(html).map((cell) => cell[0].includes('data-nowrap="true"'));
    expect(nowrap).toEqual(fields.map((field) => field.type === "number" || field.type === "date"));
    expect(nowrap.filter(Boolean)).toHaveLength(2);
  });

  test("uses lookup display types and allows computed values to wrap", () => {
    const lookup = field({
      id: "lookup",
      name: "Due",
      type: "lookup",
      config: {
        __lookupTarget: { fieldId: "target", name: "Due", type: "date", config: {} },
      },
    });
    const html = renderToString(() =>
      createComponent(DatabaseTable, {
        result: { items: [{ ...records[0]!, data: { lookup: "2026-11-14", computed: 12400 } }], fields: [lookup], nextCursor: null },
        baseId: "base",
        viewColumns: [{ fieldId: "lookup" }, { kind: "computed", id: "computed", label: "Total", expression: "1 + 1" }],
      }),
    );
    expect(bodyCells(html).map((cell) => cell[0].includes('data-nowrap="true"'))).toEqual([true, false]);
  });
});
