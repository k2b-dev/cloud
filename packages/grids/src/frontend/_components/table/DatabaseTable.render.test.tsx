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
    expect(nowrap).toEqual(fields.map((field) => ["number", "date", "formula"].includes(field.type)));
    expect(nowrap.filter(Boolean)).toHaveLength(3);
  });

  test("uses lookup display types and infers nowrap for computed numeric values", () => {
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
    expect(bodyCells(html).map((cell) => cell[0].includes('data-nowrap="true"'))).toEqual([true, true]);
  });

  test("keeps formula values with a field date format on one line", () => {
    const formula = field({
      id: "formula",
      name: "Due",
      type: "formula",
      config: { format: { kind: "date", format: "iso" } },
    });
    const html = renderToString(() =>
      createComponent(DatabaseTable, {
        result: { items: [{ ...records[0]!, data: { [formula.id]: "2026-11-14" } }], fields: [formula], nextCursor: null },
        baseId: "base",
      }),
    );
    expect(bodyCells(html)[0]![0]).toContain('data-nowrap="true"');
  });

  test("keeps formula values with a view-column decimal format on one line", () => {
    const formula = field({ id: "00000000-0000-4000-8000-000000000001", name: "Total", type: "formula" });
    const html = renderToString(() =>
      createComponent(DatabaseTable, {
        result: { items: [{ ...records[0]!, data: { [formula.id]: "12400.00" } }], fields: [formula], nextCursor: null },
        baseId: "base",
        viewColumns: [{ fieldId: formula.id, format: { kind: "decimal" } }],
      }),
    );
    expect(bodyCells(html)[0]![0]).toContain('data-nowrap="true"');
  });

  test.each(["count", "sum", "avg"])("keeps %s rollup string values on one line", (agg) => {
    const rollup = field({ id: "rollup", name: "Total", type: "rollup", config: { agg } });
    const html = renderToString(() =>
      createComponent(DatabaseTable, {
        result: { items: [{ ...records[0]!, data: { [rollup.id]: "12400" } }], fields: [rollup], nextCursor: null },
        baseId: "base",
      }),
    );
    expect(bodyCells(html)[0]![0]).toContain('data-nowrap="true"');
  });

  test.each(["text", "longtext"] as const)("allows long %s values to wrap", (type) => {
    const text = field({ id: "text", name: "Notes", type });
    const html = renderToString(() =>
      createComponent(DatabaseTable, {
        result: {
          items: [
            { ...records[0]!, data: { [text.id]: "A long description with enough detail to span several lines in a narrow column." } },
          ],
          fields: [text],
          nextCursor: null,
        },
        baseId: "base",
      }),
    );
    expect(bodyCells(html)[0]![0]).not.toContain("data-nowrap");
  });
});
